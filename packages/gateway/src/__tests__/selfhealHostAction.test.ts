import * as assert from 'node:assert/strict'
/**
 * Tier1 host-action transport tests (batch1a): opcode whitelist, outcome
 * classification (completed/failed/unknown), config fail-closed, and the
 * option-injection guard on the host env. No real SSH — the runner is injected.
 */
import { describe, it } from 'node:test'
import {
  CONDITION_OPCODE_MAP,
  TIER1_OPCODES,
  executeHostOpcode,
  hostActionConfigFromEnv,
} from '../selfheal/hostAction.js'

const CFG = { host: 'kl-mirror', keyPath: '/root/.secrets/x', timeoutMs: 5000 }
const clock = () => 1_000

describe('hostActionConfigFromEnv — fail-closed', () => {
  it('returns null when host or key is unset', () => {
    assert.equal(hostActionConfigFromEnv({}), null)
    assert.equal(hostActionConfigFromEnv({ OC_SELFHEAL_ACTION_HOST: 'kl-mirror' }), null)
    assert.equal(hostActionConfigFromEnv({ OC_SELFHEAL_ACTION_KEY: '/k' }), null)
  })
  it('returns config when both set', () => {
    const c = hostActionConfigFromEnv({ OC_SELFHEAL_ACTION_HOST: 'kl-mirror', OC_SELFHEAL_ACTION_KEY: '/k' })
    assert.deepEqual(c, { host: 'kl-mirror', keyPath: '/k' })
  })
  it('rejects an option-injection host shape', () => {
    assert.equal(
      hostActionConfigFromEnv({ OC_SELFHEAL_ACTION_HOST: '-oProxyCommand=evil', OC_SELFHEAL_ACTION_KEY: '/k' }),
      null,
    )
    assert.equal(
      hostActionConfigFromEnv({ OC_SELFHEAL_ACTION_HOST: 'a host', OC_SELFHEAL_ACTION_KEY: '/k' }),
      null,
    )
  })
})

describe('executeHostOpcode — outcome classification', () => {
  it('completed on remote exit 0', async () => {
    let sentArgs: string[] = []
    const r = await executeHostOpcode(
      'restart-v5-egress-v1',
      { ...CFG, runner: async (args) => { sentArgs = args; return { code: 0, stdout: '{"outcome":"completed","exit":0}', stderr: '', timedOut: false } } },
      clock,
    )
    assert.equal(r.outcome, 'completed')
    assert.equal(r.exit, 0)
    // opcode is a single trailing argv token (no shell), host is pinned.
    assert.equal(sentArgs[sentArgs.length - 1], 'restart-v5-egress-v1')
    assert.ok(sentArgs.includes('kl-mirror'))
    assert.ok(sentArgs.includes('BatchMode=yes'))
    assert.ok(sentArgs.includes('IdentitiesOnly=yes'))
  })
  it('failed on remote exit > 0 (action ran, did not succeed)', async () => {
    const r = await executeHostOpcode(
      'restart-v5-egress-v1',
      { ...CFG, runner: async () => ({ code: 3, stdout: '{"outcome":"failed","exit":3}', stderr: 'boom', timedOut: false }) },
      clock,
    )
    assert.equal(r.outcome, 'failed')
    assert.equal(r.exit, 3)
  })
  it('unknown on transport timeout (ambiguous — never auto-replayed)', async () => {
    const r = await executeHostOpcode(
      'clean-v5-disk-v1',
      { ...CFG, runner: async () => ({ code: -1, stdout: '', stderr: 'timeout', timedOut: true }) },
      clock,
    )
    assert.equal(r.outcome, 'unknown')
  })
  it('rejects (failed, no transmit) an opcode outside the local whitelist', async () => {
    let called = false
    const r = await executeHostOpcode(
      'rm-rf-slash',
      { ...CFG, runner: async () => { called = true; return { code: 0, stdout: '{}', stderr: '', timedOut: false } } },
      clock,
    )
    assert.equal(r.outcome, 'failed')
    assert.equal(r.exit, -1)
    assert.equal(called, false, 'a non-whitelisted opcode is never transmitted')
  })
})

describe('opcode maps stay coherent', () => {
  it('every mapped opcode is in the transmit whitelist', () => {
    for (const op of Object.values(CONDITION_OPCODE_MAP)) {
      assert.ok(TIER1_OPCODES.has(op), `${op} must be a known Tier1 opcode`)
    }
  })
  it('maps the four batch1a condition keys', () => {
    assert.equal(CONDITION_OPCODE_MAP['ops.monitor:svc_egress'], 'restart-v5-egress-v1')
    assert.equal(CONDITION_OPCODE_MAP['ops.monitor:http_egress'], 'restart-v5-egress-v1')
    assert.equal(CONDITION_OPCODE_MAP['ops.monitor:disk_root'], 'clean-v5-disk-v1')
    assert.equal(CONDITION_OPCODE_MAP['ops.monitor:disk_var'], 'clean-v5-disk-v1')
  })
})
