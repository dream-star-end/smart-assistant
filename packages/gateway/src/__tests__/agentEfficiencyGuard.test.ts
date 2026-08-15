/**
 * Run: npx tsx --test packages/gateway/src/__tests__/agentEfficiencyGuard.test.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

const TEST_HOME = mkdtempSync(join(tmpdir(), 'oc-eff-guard-'))
process.env.OPENCLAUDE_HOME = TEST_HOME
delete process.env.OPENCLAUDE_EFFICIENCY_GUARD
delete process.env.OPENCLAUDE_VERIFICATION_BUDGET_MS

const {
  lintBashCommand,
  observeToolUse,
  createTurnGuardState,
  classifyUserEfficiencyIntent,
  beginTurnBudget,
  endTurnBudget,
  shouldAskVerificationUpgrade,
  formatGuardNote,
  applyEfficiencyToolObservation,
  prepareEfficiencyTurnNote,
  finalizeEfficiencyTurn,
  readVerificationBudget,
  resolveGuardMode,
  DEFAULT_BASH_COUNT_WARN,
  DEFAULT_TOOL_COUNT_WARN,
  FANOUT_READ_PROBE_THRESHOLD,
} = await import('../agentEfficiencyGuard.js')
type EfficiencySessionState = import('../agentEfficiencyGuard.js').EfficiencySessionState

const ORIG_GUARD = process.env.OPENCLAUDE_EFFICIENCY_GUARD
afterEach(() => {
  if (ORIG_GUARD === undefined) delete process.env.OPENCLAUDE_EFFICIENCY_GUARD
  else process.env.OPENCLAUDE_EFFICIENCY_GUARD = ORIG_GUARD
})

function codes(cmd: string, mode: 'warn' | 'deny' | 'off' = 'warn') {
  return lintBashCommand(cmd, mode).map((h) => h.code)
}

describe('lintBashCommand — hits', () => {
  it('flags sleep >= 60 in seconds, 1m, and 2h', () => {
    assert.deepEqual(codes('sleep 60'), ['sleep_ge_60'])
    assert.deepEqual(codes('sleep 90'), ['sleep_ge_60'])
    assert.deepEqual(codes('sleep 1m'), ['sleep_ge_60'])
    assert.deepEqual(codes('sleep 2 min'), ['sleep_ge_60'])
    assert.deepEqual(codes('sleep 2h'), ['sleep_ge_60'])
    assert.ok(lintBashCommand('do sleep 120').some((h) => h.message.includes('后台')))
  })

  it('flags foreground gh watch pollers', () => {
    assert.deepEqual(codes('gh pr checks 123 --watch'), ['fg_watch'])
    assert.deepEqual(codes('gh pr checks --watch'), ['fg_watch'])
    assert.deepEqual(codes('gh run watch 456'), ['fg_watch'])
  })

  it('flags while-true heartbeat/renew loops', () => {
    assert.deepEqual(
      codes('while true; do oc-lease renew; sleep 5; done'),
      ['heartbeat_loop'],
    )
    assert.deepEqual(
      codes('while :; do echo heartbeat; sleep 10; done'),
      ['heartbeat_loop'],
    )
  })

  it('flags container-local source reads via cat/sed/rg', () => {
    assert.deepEqual(codes('cat /opt/openclaude/packages/gateway/src/promptSlots.ts'), [
      'local_file_via_shell',
    ])
    assert.deepEqual(codes("sed -n '1,20p' ./src/foo.ts"), ['local_file_via_shell'])
    assert.deepEqual(codes('rg efficiency packages/gateway/src/promptSlots.ts'), [
      'local_file_via_shell',
    ])
    assert.deepEqual(codes('head -n 20 /home/agent/.openclaude/workspace/app.ts'), [
      'local_file_via_shell',
    ])
  })

  it('deny mode upgrades action without changing detection', () => {
    const hits = lintBashCommand('sleep 120', 'deny')
    assert.equal(hits[0]?.action, 'deny')
    assert.equal(hits[0]?.code, 'sleep_ge_60')
  })

  it('off mode returns nothing', () => {
    assert.deepEqual(lintBashCommand('sleep 120', 'off'), [])
  })
})

describe('lintBashCommand — false positives (must not fire)', () => {
  it('allows sleep under 60s', () => {
    assert.deepEqual(codes('sleep 30'), [])
    assert.deepEqual(codes('sleep 0.5'), [])
    assert.deepEqual(codes('sleep 59'), [])
  })

  it('allows echo of the word sleep / quoted mention', () => {
    assert.deepEqual(codes('echo sleep 60'), [])
  })

  it('allows gh pr checks without --watch', () => {
    assert.deepEqual(codes('gh pr checks 123'), [])
    assert.deepEqual(codes('gh run list --limit 5'), [])
  })

  it('allows while-true that is not a heartbeat/renew loop', () => {
    assert.deepEqual(codes('while true; do read line; break; done'), [])
    assert.deepEqual(codes('echo "while true heartbeat"'), [])
  })

  it('does not treat heredoc / comment / string mentions as a heartbeat loop', () => {
    assert.deepEqual(
      codes("cat <<'EOF'\nwhile true; do echo heartbeat; sleep 5; done\nEOF"),
      [],
    )
    assert.deepEqual(codes('# while true; do oc-lease renew; done\ntrue'), [])
    assert.deepEqual(codes("printf '%s\\n' 'while true; do echo heartbeat; done'"), [])
  })

  it('allows short sleep and host-channel cat even in deny evaluation', async () => {
    const { evaluateShellForHook } = await import('../agentEfficiencyGuard.js')
    assert.equal(evaluateShellForHook('sleep 5', 'deny').decision, 'allow')
    assert.equal(
      evaluateShellForHook("host 'cat /opt/openclaude/openclaude-v5-aurora/README.md'", 'deny')
        .decision,
      'allow',
    )
  })

  it('allows host-channel reads of host files', () => {
    assert.deepEqual(codes("host 'cat /opt/openclaude/openclaude-v5-aurora/README.md'"), [])
    assert.deepEqual(
      codes("export HOME=/home/agent; /home/agent/.local/bin/host 'rg foo /opt/openclaude/x.ts'"),
      [],
    )
  })

  it('allows heredoc writes and redirect cats', () => {
    assert.deepEqual(codes("cat <<'EOF' | host 'cat > /opt/foo'\nhello\nEOF"), [])
    assert.deepEqual(codes('cat > /tmp/out.ts <<EOF\nexport const x = 1\nEOF'), [])
  })

  it('allows tail -f logs and /proc reads', () => {
    assert.deepEqual(codes('tail -f /tmp/build.log'), [])
    assert.deepEqual(codes('cat /proc/cpuinfo'), [])
    assert.deepEqual(codes('head -n 5 /sys/class/net/eth0/address'), [])
  })

  it('allows timeout 60 and non-source cat pipelines', () => {
    assert.deepEqual(codes('timeout 60 npm test'), [])
    assert.deepEqual(codes('cat /etc/os-release'), [])
  })
})

describe('observeToolUse — fan-out + counters', () => {
  it('suggests delegate_tasks after consecutive independent read probes', () => {
    const state = createTurnGuardState()
    const a = observeToolUse(state, { name: 'Read', input: { file_path: '/a.ts' } })
    const b = observeToolUse(state, { name: 'Grep', input: { pattern: 'x' } })
    const c = observeToolUse(state, { name: 'Glob', input: { glob_pattern: '*.ts' } })
    assert.deepEqual(a, [])
    assert.deepEqual(b, [])
    assert.equal(c[0]?.code, 'fanout')
    assert.match(c[0]?.message ?? '', /delegate_tasks/)
    assert.equal(state.consecutiveReadProbes, FANOUT_READ_PROBE_THRESHOLD)
  })

  it('does not suggest fan-out after a real delegate', () => {
    const state = createTurnGuardState()
    observeToolUse(state, { name: 'Read', input: {} })
    observeToolUse(state, { name: 'delegate_tasks', input: { tasks: [] } })
    const hits = observeToolUse(state, { name: 'Grep', input: {} })
    assert.equal(hits.some((h) => h.code === 'fanout'), false)
    assert.equal(state.delegatedThisTurn, true)
  })

  it('warns once when bash count hits the threshold', () => {
    const state = createTurnGuardState()
    let last: { code: string }[] = []
    for (let i = 0; i < DEFAULT_BASH_COUNT_WARN; i++) {
      last = observeToolUse(state, { name: 'Bash', input: { command: 'true' } })
    }
    assert.equal(last.some((h) => h.code === 'bash_count'), true)
    const again = observeToolUse(state, { name: 'Bash', input: { command: 'true' } })
    assert.equal(again.some((h) => h.code === 'bash_count'), false)
  })

  it('warns when toolCount reaches 80', () => {
    const state = createTurnGuardState()
    state.toolCount = DEFAULT_TOOL_COUNT_WARN
    const hits = observeToolUse(state, { name: 'Read', input: {} })
    assert.equal(hits.some((h) => h.code === 'tool_count'), true)
  })
})

describe('verification budget', () => {
  it('classifies waiver / verify-only / upgrade / tiers', () => {
    assert.deepEqual(classifyUserEfficiencyIntent('上线就行,本次不用你验证'), {
      tier: 'unknown',
      waived: true,
      verifyOnly: false,
      upgradeConfirmed: false,
    })
    assert.equal(classifyUserEfficiencyIntent('你实际去验下').verifyOnly, true)
    assert.equal(classifyUserEfficiencyIntent('走完整列车').upgradeConfirmed, true)
    assert.equal(classifyUserEfficiencyIntent('改一下 catalog').tier, 'T0')
    assert.equal(classifyUserEfficiencyIntent('修一下 packages/gateway 这个包').tier, 'T1')
    assert.equal(classifyUserEfficiencyIntent('跨包协议变更').tier, 'T2')
  })

  it('asks for upgrade after 15 minutes on T0/T1, but not when waived', () => {
    const t0 = Date.now()
    let budget = beginTurnBudget(null, '改一下 catalog', t0)
    budget = endTurnBudget(budget, t0 + 15 * 60_000)
    assert.equal(shouldAskVerificationUpgrade(budget), true)

    let waived = beginTurnBudget(null, '上线就行,本次不用你验证', t0)
    waived = endTurnBudget(waived, t0 + 15 * 60_000)
    assert.equal(shouldAskVerificationUpgrade(waived), false)
  })

  it('T2 and explicit upgrade skip the 15-minute ask', () => {
    const t0 = Date.now()
    let budget = beginTurnBudget(null, '跨包协议变更', t0)
    budget = endTurnBudget(budget, t0 + 20 * 60_000)
    assert.equal(shouldAskVerificationUpgrade(budget), false)

    let upgraded = beginTurnBudget(null, '升级到全量门', t0)
    upgraded = endTurnBudget(upgraded, t0 + 20 * 60_000)
    assert.equal(shouldAskVerificationUpgrade(upgraded), false)
  })

  it('persists budget across prepare/finalize for a session', async () => {
    const session = { sessionKey: 'agent:main:webchat:dm:sess-budget-1' }
    const note = await prepareEfficiencyTurnNote(session, '改一下 catalog', 1_000)
    assert.equal(note, null)
    await finalizeEfficiencyTurn(session, 1_000 + 16 * 60_000)
    const stored = await readVerificationBudget(session.sessionKey)
    assert.ok(stored)
    assert.equal(stored?.tier, 'T0')
    assert.ok((stored?.accumulatedMs ?? 0) >= 15 * 60_000)
    const again = await prepareEfficiencyTurnNote(session, '继续', 1_000 + 16 * 60_000)
    assert.match(again ?? '', /超过 15 分钟/)
    assert.match(again ?? '', /不用验证\/直接上/)
  })

  it('verify-only user text injects 只验不修', async () => {
    const session = { sessionKey: 'agent:main:webchat:dm:sess-verify-only' }
    const note = await prepareEfficiencyTurnNote(session, '你实际去验下', 2_000)
    assert.match(note ?? '', /只验不修/)
  })
})

describe('session hook helpers + format', () => {
  it('applyEfficiencyToolObservation stashes hits on the session', () => {
    const session: EfficiencySessionState = {}
    applyEfficiencyToolObservation(
      session,
      { name: 'Bash', input: { command: 'sleep 120' } },
      1,
    )
    assert.equal(session._efficiencyPendingHits?.[0]?.code, 'sleep_ge_60')
  })

  it('formatGuardNote wraps hits and marks deny wording', () => {
    const note = formatGuardNote(
      [{ code: 'sleep_ge_60', action: 'deny', message: '禁止 sleep 120' }],
      { mode: 'deny' },
    )
    assert.match(note ?? '', /<oc-efficiency-guard>/)
    assert.match(note ?? '', /拒绝建议/)
    assert.equal(formatGuardNote([]), null)
  })

  it('resolveGuardMode reads env', () => {
    process.env.OPENCLAUDE_EFFICIENCY_GUARD = 'off'
    assert.equal(resolveGuardMode(), 'off')
    process.env.OPENCLAUDE_EFFICIENCY_GUARD = 'deny'
    assert.equal(resolveGuardMode(), 'deny')
    delete process.env.OPENCLAUDE_EFFICIENCY_GUARD
    assert.equal(resolveGuardMode(), 'warn')
  })
})

describe('sessionManager mount contract', () => {
  it('hooks the existing tool_use_detected / submit / turn-end path', () => {
    const src = readFileSync(new URL('../sessionManager.ts', import.meta.url), 'utf8')
    assert.match(src, /applyEfficiencyToolObservation/)
    assert.match(src, /prepareEfficiencyTurnNote/)
    assert.match(src, /finalizeEfficiencyTurn/)
    assert.match(src, /tool_use_detected/)
  })

  it('does not tighten delegate limits without usage evidence', () => {
    const src = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
    assert.match(src, /MAX_CONCURRENT_DELEGATIONS = 5/)
    assert.match(src, /MEMBER_DELEGATIONS_PER_TURN_DEFAULT = 8/)
  })
})
