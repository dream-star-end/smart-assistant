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

describe('executeHostOpcode — strict outcome classification', () => {
  const recv = (op: string, outcome: string, exit: number) =>
    JSON.stringify({ opcode: op, outcome, exit })

  it('completed on exit 0 with a bound receipt', async () => {
    let sentArgs: string[] = []
    const r = await executeHostOpcode(
      'restart-v5-egress-v1',
      { ...CFG, runner: async (args) => { sentArgs = args; return { code: 0, stdout: recv('restart-v5-egress-v1', 'completed', 0), stderr: '', timedOut: false } } },
      clock,
    )
    assert.equal(r.outcome, 'completed')
    // opcode is a single trailing argv token (no shell), host is pinned.
    assert.equal(sentArgs[sentArgs.length - 1], 'restart-v5-egress-v1')
    assert.ok(sentArgs.includes('kl-mirror') && sentArgs.includes('BatchMode=yes') && sentArgs.includes('IdentitiesOnly=yes'))
  })
  it('action_failed on remote exit > 0 (action ran, did not succeed)', async () => {
    const r = await executeHostOpcode(
      'restart-v5-egress-v1',
      { ...CFG, runner: async () => ({ code: 3, stdout: recv('restart-v5-egress-v1', 'failed', 3), stderr: 'boom', timedOut: false }) },
      clock,
    )
    assert.equal(r.outcome, 'action_failed')
  })
  it('rejected on deploy stand-down (exit 66 — coordination gate)', async () => {
    const r = await executeHostOpcode(
      'restart-v5-egress-v1',
      { ...CFG, runner: async () => ({ code: 66, stdout: recv('restart-v5-egress-v1', 'rejected', 66), stderr: '', timedOut: false }) },
      clock,
    )
    assert.equal(r.outcome, 'rejected', 'standing down for an active deploy is a definite non-execution')
  })
  it('rejected on remote forced-command refusal (exit 64/65)', async () => {
    const r = await executeHostOpcode(
      'restart-v5-egress-v1',
      { ...CFG, runner: async () => ({ code: 65, stdout: recv('restart-v5-egress-v1', 'rejected', 65), stderr: '', timedOut: false }) },
      clock,
    )
    assert.equal(r.outcome, 'rejected')
  })
  it('unknown on timeout, ssh exit 255, malformed receipt, exit0-not-completed, and opcode mismatch', async () => {
    const cases: Array<{ code: number; stdout: string; timedOut?: boolean }> = [
      { code: -1, stdout: '', timedOut: true }, // timeout
      { code: 255, stdout: '' }, // ssh transport error
      { code: 0, stdout: 'not json' }, // malformed
      { code: 0, stdout: '' }, // exit0 empty
      { code: 0, stdout: recv('restart-v5-egress-v1', 'failed', 0) }, // exit0 but not completed
      { code: 0, stdout: recv('WRONG-OPCODE', 'completed', 0) }, // opcode mismatch
      { code: 0, stdout: JSON.stringify({ opcode: 'restart-v5-egress-v1', outcome: 'completed' }) }, // exit missing
      { code: 0, stdout: JSON.stringify({ opcode: 'restart-v5-egress-v1', outcome: 'completed', exit: '0' }) }, // exit string
      { code: 5, stdout: recv('restart-v5-egress-v1', 'completed', 5) }, // exit disagrees with outcome
      { code: 3, stdout: recv('restart-v5-egress-v1', 'failed', 9) }, // receipt exit ≠ process exit
    ]
    for (const c of cases) {
      const r = await executeHostOpcode(
        'restart-v5-egress-v1',
        { ...CFG, runner: async () => ({ code: c.code, stdout: c.stdout, stderr: '', timedOut: c.timedOut ?? false }) },
        clock,
      )
      assert.equal(r.outcome, 'unknown', `case ${JSON.stringify(c)} must be unknown`)
    }
  })
  it('rejected (no transmit) for an opcode outside the local whitelist', async () => {
    let called = false
    const r = await executeHostOpcode(
      'rm-rf-slash',
      { ...CFG, runner: async () => { called = true; return { code: 0, stdout: '{}', stderr: '', timedOut: false } } },
      clock,
    )
    assert.equal(r.outcome, 'rejected')
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
