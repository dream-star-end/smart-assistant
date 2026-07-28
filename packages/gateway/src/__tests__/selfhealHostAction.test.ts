import * as assert from 'node:assert/strict'
/**
 * Tier1 host-action transport tests (batch1a): opcode whitelist, outcome
 * classification (completed/failed/unknown), config fail-closed, and the
 * option-injection guard on the host env. No real SSH — the runner is injected.
 */
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  CONDITION_OPCODE_MAP,
  TIER1_OPCODES,
  executeHostOpcode,
  hostActionConfigFromEnv,
} from '../selfheal/hostAction.js'

const CFG = { host: 'kl-mirror', keyPath: '/root/.secrets/x', timeoutMs: 5000 }
const clock = () => 1_000
const WRAPPER = fileURLToPath(
  new URL('../../../../ops/oc-selfheal-host-action.sh', import.meta.url),
)

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
  it('the retired clean-v5-disk-v1 opcode fails closed without SSH', async () => {
    let called = false
    const r = await executeHostOpcode(
      'clean-v5-disk-v1',
      {
        ...CFG,
        runner: async () => {
          called = true
          return { code: 0, stdout: '{}', stderr: '', timedOut: false }
        },
      },
      clock,
    )
    assert.equal(r.outcome, 'rejected')
    assert.equal(called, false, 'a frozen legacy disk request must never reach SSH')
  })
})

describe('opcode maps stay coherent', () => {
  it('every mapped opcode is in the transmit whitelist', () => {
    for (const op of Object.values(CONDITION_OPCODE_MAP)) {
      assert.ok(TIER1_OPCODES.has(op), `${op} must be a known Tier1 opcode`)
    }
  })
  it('maps only the four exact service conditions; disk conditions have no Tier1 route', () => {
    assert.deepEqual(Object.keys(CONDITION_OPCODE_MAP).sort(), [
      'ops.monitor:http_egress',
      'ops.monitor:http_v5',
      'ops.monitor:svc_egress',
      'ops.monitor:svc_v5',
    ])
    assert.equal(CONDITION_OPCODE_MAP['ops.monitor:svc_egress'], 'restart-v5-egress-v1')
    assert.equal(CONDITION_OPCODE_MAP['ops.monitor:http_egress'], 'restart-v5-egress-v1')
    assert.equal(CONDITION_OPCODE_MAP['ops.monitor:svc_v5'], 'restart-v5-active-master-v1')
    assert.equal(CONDITION_OPCODE_MAP['ops.monitor:http_v5'], 'restart-v5-active-master-v1')
    assert.equal(CONDITION_OPCODE_MAP['ops.monitor:disk_root'], undefined)
    assert.equal(CONDITION_OPCODE_MAP['ops.monitor:disk_var'], undefined)
  })

  it('remote forced-command wrapper advertises no disk opcode or global cleanup command', () => {
    const wrapper = readFileSync(
      new URL('../../../../ops/oc-selfheal-host-action.sh', import.meta.url),
      'utf8',
    )
    assert.doesNotMatch(wrapper, /clean-v5-disk-v1/)
    assert.doesNotMatch(wrapper, /docker\s+system\s+prune/)
    assert.doesNotMatch(wrapper, /journalctl\s+--vacuum/)
    assert.match(
      wrapper,
      /"capabilities":\["restart-v5-egress-v1","restart-v5-active-master-v1"\]/,
    )
  })
})

interface WrapperRunOpts {
  state?: string
  curlMode?: 'ok' | 'all-fail' | 'public-fail'
  psqlRc?: number
  systemctlRc?: number
  healthTimeout?: number
}

function runWrapper(opcode: string, opts: WrapperRunOpts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'oc-selfheal-host-action-'))
  const bin = join(dir, 'bin')
  const envFile = join(dir, 'commercial-v5.env')
  const lease = join(dir, 'production-mutation.lock')
  const maintenance = join(dir, 'maintenance.json')
  const actionLog = join(dir, 'actions.log')
  const curlLog = join(dir, 'curl.log')
  try {
    mkdirSync(bin)
    writeFileSync(envFile, 'DATABASE_URL=postgres://fixture\n', { mode: 0o600 })
    const stub = (name: string, body: string) => {
      const path = join(bin, name)
      writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`)
      chmodSync(path, 0o755)
    }
    stub(
      'psql',
      `if flock -n "$LEASE_PATH" true 2>/dev/null; then exit 42; fi\n` +
        `rc="\${PSQL_RC:-0}"\n` +
        `if [ "$rc" -ne 0 ]; then exit "$rc"; fi\n` +
        `printf '%s' "\${PSQL_ROW-}"`,
    )
    stub(
      'systemctl',
      `if flock -n "$LEASE_PATH" true 2>/dev/null; then exit 42; fi\n` +
        `printf '%s\\n' "$*" >> "$ACTION_LOG"\n` +
        `rc="\${SYSTEMCTL_RC:-0}"\n` +
        `if [ "$rc" -ne 0 ]; then printf 'restart failed\\n' >&2; exit "$rc"; fi`,
    )
    stub(
      'curl',
      `printf '%s\\n' "$*" >> "$CURL_LOG"\n` +
        `if flock -n "$LEASE_PATH" true 2>/dev/null; then exit 42; fi\n` +
        `if [ "\${CURL_MODE:-ok}" = all-fail ]; then exit 7; fi\n` +
        `if [ "\${CURL_MODE:-ok}" = public-fail ]; then\n` +
        `  case " $* " in *" Host: claudeai.chat "*) exit 7 ;; esac\n` +
        `fi\n` +
        `printf '{"ok":true,"channel":"v5"}\\n'`,
    )

    const result = spawnSync('bash', [WRAPPER, opcode], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        OC_SELFHEAL_V5_ENV: envFile,
        OC_SELFHEAL_MUTATION_LEASE: lease,
        OC_SELFHEAL_MAINT_MARKER: maintenance,
        OC_SELFHEAL_MASTER_HEALTH_TIMEOUT: String(opts.healthTimeout ?? 2),
        PSQL_ROW: opts.state ?? 'stable|A|',
        PSQL_RC: String(opts.psqlRc ?? 0),
        SYSTEMCTL_RC: String(opts.systemctlRc ?? 0),
        CURL_MODE: opts.curlMode ?? 'ok',
        ACTION_LOG: actionLog,
        CURL_LOG: curlLog,
        LEASE_PATH: lease,
      },
    })
    const lines = result.stdout.trim().split('\n').filter(Boolean)
    return {
      status: result.status,
      stderr: result.stderr,
      receipt: JSON.parse(lines.at(-1) ?? '{}') as {
        opcode?: string
        outcome?: string
        exit?: number
        detail?: Record<string, unknown>
      },
      actions: existsSync(actionLog) ? readFileSync(actionLog, 'utf8') : '',
      curls: existsSync(curlLog) ? readFileSync(curlLog, 'utf8') : '',
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('remote forced-command wrapper — active master restart', () => {
  it('derives and proves the active A/B unit while holding the mutation lease', () => {
    for (const fixture of [
      { state: 'stable|A|', unit: 'openclaude-v5.service', port: '18790' },
      { state: 'stable|B|', unit: 'openclaude-v5-b.service', port: '18795' },
    ]) {
      const r = runWrapper('restart-v5-active-master-v1', { state: fixture.state })
      assert.equal(r.status, 0)
      assert.equal(r.receipt.outcome, 'completed')
      assert.equal(r.receipt.exit, 0)
      assert.equal(r.receipt.detail?.unit, fixture.unit)
      assert.match(r.actions, new RegExp(`restart ${fixture.unit.replaceAll('.', '\\.')}`))
      assert.match(r.curls, new RegExp(`127\\.0\\.0\\.1:${fixture.port}/healthz`))
      assert.match(r.curls, /-H Host: claudeai\.chat http:\/\/127\.0\.0\.1\/healthz/)
    }
  })

  it('rejects missing, multiple, invalid, non-stable, or candidate deploy state without restart', () => {
    for (const state of [
      '',
      'stable|A|\nstable|B|',
      'stable|C|',
      'canary|A|B',
      'stable|A|B',
    ]) {
      const r = runWrapper('restart-v5-active-master-v1', { state })
      assert.equal(r.status, 66, `state=${JSON.stringify(state)}`)
      assert.equal(r.receipt.outcome, 'rejected')
      assert.equal(r.receipt.exit, 66)
      assert.equal(r.actions, '')
    }
    const queryFailure = runWrapper('restart-v5-active-master-v1', { psqlRc: 2 })
    assert.equal(queryFailure.status, 66)
    assert.equal(queryFailure.receipt.outcome, 'rejected')
    assert.equal(queryFailure.actions, '')
  })

  it('returns a bound failed receipt when restart or health proof fails', () => {
    const restart = runWrapper('restart-v5-active-master-v1', { systemctlRc: 5 })
    assert.equal(restart.status, 5)
    assert.equal(restart.receipt.outcome, 'failed')
    assert.equal(restart.receipt.exit, 5)
    assert.match(restart.stderr, /restart openclaude-v5\.service failed rc=5/)

    const health = runWrapper('restart-v5-active-master-v1', {
      curlMode: 'all-fail',
      healthTimeout: 1,
    })
    assert.equal(health.status, 70)
    assert.equal(health.receipt.outcome, 'failed')
    assert.equal(health.receipt.exit, 70)

    const publicHealth = runWrapper('restart-v5-active-master-v1', {
      curlMode: 'public-fail',
      healthTimeout: 1,
    })
    assert.equal(publicHealth.receipt.outcome, 'failed')
    assert.equal(publicHealth.receipt.detail?.privateHealth, true)
    assert.equal(publicHealth.receipt.detail?.publicHealth, false)
  })
})
