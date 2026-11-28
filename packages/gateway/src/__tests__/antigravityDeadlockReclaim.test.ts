/**
 * OCV5-923 Bug 2: Deadlocked Antigravity Swarm Auto-Termination & Full
 * Descendant Process-Tree Reclamation (including escaped PGIDs + oc-memory-mcp
 * managed_job/daemon_service preservation + orphaned PGID cleanup on abnormal exit).
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/antigravityDeadlockReclaim.test.ts
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { OpenClaudeConfig } from '@openclaude/storage'

import {
  killProcessTree,
  parseProcStat,
  snapshotDescendantProcessGroups,
  type ProcessTreeOpts,
} from '../processGroupShutdown.js'
import { reapLingeringCliProcessGroup } from '../engine/antigravitySwarmConcurrency.js'
import { advanceAntigravityRouteHeartbeatCounters } from '../engine/antigravityDeadlockGuard.js'
import { parseMemberTranscriptTail, readAntigravitySwarmSnapshot } from '../engine/antigravitySwarmWatcher.js'
import { SwarmStallMonitor, type SwarmStallExhaustion } from '../engine/swarmStallMonitor.js'
import { AntigravityAdapter, _internals } from '../engine/antigravityAdapter.js'
import { classifyRunError } from '../errorClassify.js'
import type { EngineEvent } from '../engine/engineEvents.js'
import type { EngineCreateOpts } from '../engine/registry.js'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'antigravity')
const TOKEN = 'b'.repeat(64)
const ROUTE = {
  baseUrl: `http://127.0.0.1:18789/internal/v5/antigravity-relay/route/${TOKEN}`,
  routeToken: TOKEN,
  accessToken: 'ya29.test-deadlock-reclaim',
  accessTokenExpiresAt: '2026-12-01T00:00:00Z',
}

function makeConfig(): OpenClaudeConfig {
  return {
    version: 1,
    gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
    auth: { mode: 'subscription', claudeCodePath: '' },
    sessions: { dbPath: '' },
    defaults: { model: 'antigravity-gemini-3.8-flash' },
  } as unknown as OpenClaudeConfig
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException | null)?.code === 'EPERM'
  }
}

function isPgrpAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException | null)?.code === 'EPERM'
  }
}

async function waitUntil(pred: () => boolean, timeoutMs: number, stepMs = 15): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, stepMs))
  }
  return pred()
}

describe('OCV5-923 Linux descendant process-tree snapshot & kill', () => {
  test('parseProcStat handles comm names containing spaces and parentheses', () => {
    const parsed = parseProcStat(9816, '9816 (python3 (audio) worker) S 8050 9816 8050 0 -1 4194304')
    assert.deepEqual(parsed, {
      pid: 9816,
      comm: 'python3 (audio) worker',
      ppid: 8050,
      pgid: 9816,
    })
    assert.equal(parseProcStat(1, 'malformed'), null)
  })

  test('kills escaped descendant PGIDs (build_audio.py + multiprocessing) while preserving oc-memory-mcp detached managed_job/daemon_service and never signaling gateway', () => {
    // Reproduces oc-v5-u4 production process tree:
    //   500 (gateway, pgid 500)
    //   └─ 8050 (antigravity, pgid 8050)
    //      ├─ 9816 (python3 (build audio), pgid 9816)  <-- escaped PGID!
    //      │  └─ 9850 (python3, pgid 9816)             <-- multiprocessing.spawn
    //      │     └─ 9900 (ffmpeg, pgid 9900)           <-- nested escaped PGID!
    //      └─ 8100 (node, pgid 8050, cmdline: node\0/opt/oc-memory-mcp.cjs\0--stdio)
    //         ├─ 8101 (sh, pgid 8050)                  <-- ephemeral_turn (same PGID)
    //         ├─ 8200 (node, pgid 8200)                <-- managed_job (detached!) -> MUST SURVIVE
    //         │  └─ 8201 (worker, pgid 8200)           <-- managed_job child -> MUST SURVIVE
    //         └─ 8300 (python3, pgid 8300)             <-- daemon_service (detached!) -> MUST SURVIVE
    const statLine = (pid: number, comm: string, ppid: number, pgid: number, startTicks = 1000) =>
      `${pid} (${comm}) S ${ppid} ${pgid} ${pgid} 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 ${startTicks}`
    const procTable: Record<number, { stat: string; cmdline: string }> = {
      500: { stat: statLine(500, 'node', 1, 500, 100), cmdline: 'node\0gateway.js' },
      8050: { stat: statLine(8050, 'antigravity', 500, 8050, 1000), cmdline: '/usr/local/bin/antigravity' },
      9816: { stat: statLine(9816, 'python3 (build audio)', 8050, 9816, 1010), cmdline: 'python3\0build_audio.py' },
      9850: { stat: statLine(9850, 'python3', 9816, 9816, 1015), cmdline: 'python3\0-c\0from multiprocessing.spawn import spawn_main' },
      9900: { stat: statLine(9900, 'ffmpeg', 9850, 9900, 1020), cmdline: 'ffmpeg\0-i\0in.wav' },
      8100: { stat: statLine(8100, 'node', 8050, 8050, 1005), cmdline: 'node\0/run/oc/oc-memory-mcp.cjs\0--stdio' },
      8101: { stat: statLine(8101, 'sh', 8100, 8050, 1008), cmdline: 'sh\0-c\0sleep 60' },
      8200: { stat: statLine(8200, 'node', 8100, 8200, 1012), cmdline: 'node\0managed-job.js' },
      8201: { stat: statLine(8201, 'worker', 8200, 8200, 1014), cmdline: 'node\0worker.js' },
      8300: { stat: statLine(8300, 'python3', 8100, 8300, 1016), cmdline: 'python3\0daemon.py' },
    }
    const baseOpts: ProcessTreeOpts = {
      platform: 'linux',
      selfPid: 500,
      selfPpid: 1,
      selfPgid: 500,
      readProcDir: () => Object.keys(procTable),
      readProcStat: (pid) => procTable[pid]?.stat ?? null,
      readProcCmdline: (pid) => procTable[pid]?.cmdline ?? null,
    }

    const snap = snapshotDescendantProcessGroups(8050, baseOpts)
    assert.deepEqual([...snap.descendantPgids].sort((a, b) => a - b), [9816, 9900])
    assert.ok(snap.descendantPids.includes(8100), 'oc-memory-mcp itself must be included so shutdown hook runs')
    assert.ok(snap.descendantPids.includes(8101), 'ephemeral same-PGID child of oc-memory-mcp is included')
    assert.ok(snap.descendantPids.includes(9816))
    assert.ok(snap.descendantPids.includes(9850))
    assert.ok(snap.descendantPids.includes(9900))
    assert.equal(snap.descendantPids.includes(8200), false, 'detached managed_job must be preserved')
    assert.equal(snap.descendantPids.includes(8201), false, 'managed_job grandchild must be preserved')
    assert.equal(snap.descendantPids.includes(8300), false, 'detached daemon_service must be preserved')

    const signals: Array<{ target: number; signal: NodeJS.Signals | number | undefined }> = []
    const procStub = {
      pid: 8050,
      kill: (sig: NodeJS.Signals) => {
        signals.push({ target: 8050, signal: sig })
        return true
      },
    }
    const captured = killProcessTree(procStub, 'SIGTERM', {
      ...baseOpts,
      kill: (pid, sig) => {
        signals.push({ target: pid, signal: sig })
        return true
      },
    })
    assert.deepEqual(
      signals,
      [
        { target: -8050, signal: 'SIGTERM' },
        { target: -9816, signal: 'SIGTERM' },
        { target: -9900, signal: 'SIGTERM' },
      ],
    )

    // Now simulate 8050 exiting and 9816 reparenting to PID 1 before SIGKILL:
    // reusing `captured` snapshot MUST still SIGKILL -8050 (8100/8101 alive), -9816, and -9900!
    Reflect.deleteProperty(procTable, 8050)
    procTable[9816] = { stat: statLine(9816, 'python3 (build audio)', 1, 9816, 1010), cmdline: 'python3\0build_audio.py' }
    signals.length = 0
    killProcessTree(procStub, 'SIGKILL', {
      ...baseOpts,
      snapshot: captured,
      kill: (pid, sig) => {
        signals.push({ target: pid, signal: sig })
        return true
      },
    })
    assert.deepEqual(
      signals,
      [
        { target: -8050, signal: 'SIGKILL' },
        { target: -9816, signal: 'SIGKILL' },
        { target: -9900, signal: 'SIGKILL' },
      ],
    )

    // Safety guard: never signal PID <= 1, selfPid, selfPpid, or gateway's own PGID
    assert.deepEqual(snapshotDescendantProcessGroups(1, baseOpts).descendantPgids, [])
    assert.deepEqual(snapshotDescendantProcessGroups(500, baseOpts).descendantPgids, [])
    signals.length = 0
    killProcessTree(
      { pid: 500, kill: () => { signals.push({ target: 500, signal: 'SIGKILL' }); return true } },
      'SIGKILL',
      {
        ...baseOpts,
        kill: (pid, sig) => { signals.push({ target: pid, signal: sig }); return true },
      },
    )
    assert.deepEqual(signals, [], 'gateway own PID/PGID must NEVER be signaled')
  })

  test('reapLingeringCliProcessGroup reaps real OS escaped-PGID descendants that ignore SIGTERM', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-reap-escaped-'))
    const pidFile = path.join(dir, 'escaped.pid')
    let escapedPid = 0
    try {
      let closed = false
      const leader = spawn(
        process.execPath,
        [
          '-e',
          `const fs = require('node:fs');
           const { spawn } = require('node:child_process');
           const esc = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
             detached: true,
             stdio: 'ignore',
           });
           fs.writeFileSync(${JSON.stringify(pidFile)}, String(esc.pid));
           setInterval(() => {}, 1000);`,
        ],
        { detached: true, stdio: ['pipe', 'pipe', 'pipe'] },
      )
      leader.once('close', () => { closed = true })
      const ready = await waitUntil(() => existsSync(pidFile), 3_000)
      assert.equal(ready, true, 'escaped child pid file must be written')
      escapedPid = Number(readFileSync(pidFile, 'utf8').trim())
      assert.ok(escapedPid > 1 && escapedPid !== leader.pid)
      assert.equal(isPgrpAlive(escapedPid), true)

      await reapLingeringCliProcessGroup(leader, () => closed, {
        naturalExitGraceMs: 0,
        termGraceMs: 80,
        killGraceMs: 300,
        pollIntervalMs: 15,
      })

      assert.equal(isPidAlive(leader.pid!), false, 'leader process must be dead')
      assert.equal(isPgrpAlive(escapedPid), false, 'escaped PGID ignoring SIGTERM must be killed by SIGKILL')
    } finally {
      if (escapedPid > 1) {
        try { process.kill(-escapedPid, 'SIGKILL') } catch { /* already dead */ }
      }
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('OCV5-923 AntigravityAdapter deadlock auto-termination & orphan reaping', () => {
  test('non-zero CLI exit automatically reaps orphaned child lingering in CLI process group (oc-memory-mcp.cjs scenario)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-agy-orphan-exit-'))
    const orphanPidFile = path.join(dir, 'orphan.pid')
    const saved = {
      OC_ANTIGRAVITY_CLI_BIN: process.env.OC_ANTIGRAVITY_CLI_BIN,
      OPENCLAUDE_HOME: process.env.OPENCLAUDE_HOME,
    }
    let orphanPid = 0
    try {
      const fakeCli = path.join(dir, 'fake-orphan-exit.cjs')
      await writeFile(
        fakeCli,
        `#!${process.execPath}
const fs = require('node:fs')
const { spawn } = require('node:child_process')
process.stdin.setEncoding('utf8')
let buf = ''
process.stdin.on('data', (c) => {
  buf += c
  if (!buf.includes('\\n')) return
  // Spawn a lingering child in the SAME process group (detached: false) mimicking oc-memory-mcp.cjs
  const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: false,
    stdio: 'ignore',
  })
  orphan.unref()
  fs.writeFileSync(${JSON.stringify(orphanPidFile)}, String(orphan.pid))
  process.stderr.write('error: ANTIGRAVITY_ROUTE_EXPIRED\\n')
  process.exit(1)
})
`,
      )
      await chmod(fakeCli, 0o755)
      process.env.OC_ANTIGRAVITY_CLI_BIN = fakeCli
      process.env.OPENCLAUDE_HOME = path.join(dir, 'oc-home')

      const adapter = new AntigravityAdapter({
        sessionKey: 'agent:main:webchat:dm:agy-orphan-test',
        agentId: 'main',
        agentBaseDir: dir,
        config: makeConfig(),
        model: 'antigravity-gemini-3.8-flash',
        effortLevel: 'high',
      } as EngineCreateOpts)
      adapter.on('error', () => {})
      adapter.setAntigravityRoute(ROUTE)

      const run = adapter.submitTurn({
        input: 'trigger non-zero exit with orphan',
        requestId: 'a'.repeat(32),
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await run.submitted
      const summary = await run.summary
      await adapter.waitForOutputDrain()

      assert.equal(summary?.isError, true)
      assert.match(summary?.errorDetail ?? '', /ANTIGRAVITY_ROUTE_EXPIRED/)
      assert.equal(existsSync(orphanPidFile), true)
      orphanPid = Number(readFileSync(orphanPidFile, 'utf8').trim())
      const reaped = await waitUntil(() => !isPidAlive(orphanPid), 1_500)
      assert.equal(reaped, true, 'orphaned child in CLI PGID must be reaped after non-zero exit')
    } finally {
      if (orphanPid > 1) {
        try { process.kill(orphanPid, 'SIGKILL') } catch { /* already dead */ }
      }
      if (saved.OC_ANTIGRAVITY_CLI_BIN === undefined) Reflect.deleteProperty(process.env, 'OC_ANTIGRAVITY_CLI_BIN')
      else process.env.OC_ANTIGRAVITY_CLI_BIN = saved.OC_ANTIGRAVITY_CLI_BIN
      if (saved.OPENCLAUDE_HOME === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_HOME')
      else process.env.OPENCLAUDE_HOME = saved.OPENCLAUDE_HOME
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('deadlocked swarm auto-terminates after stall exhaustion, kills escaped PGID descendants, unlocks submit, and is non-retryable', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-agy-deadlock-exhaust-'))
    const escapedPidFile = path.join(dir, 'escaped.pid')
    const swarmReadyFile = path.join(dir, 'swarm.ready')
    const saved = {
      OC_ANTIGRAVITY_CLI_BIN: process.env.OC_ANTIGRAVITY_CLI_BIN,
      OPENCLAUDE_HOME: process.env.OPENCLAUDE_HOME,
    }
    let escapedPid = 0
    try {
      const convId = '11111111-2222-4333-8444-555555555555'
      const workerConvId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
      const fakeCli = path.join(dir, 'fake-deadlock-swarm.cjs')
      await writeFile(
        fakeCli,
        `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
process.stdin.setEncoding('utf8')
let buf = ''
let started = false
process.stdin.on('data', (c) => {
  buf += c
  if (started || !buf.includes('\\n')) return
  started = true
  if (process.env.MODE === 'healthy') {
    for (const line of fs.readFileSync(${JSON.stringify(path.join(FIXTURES, 'stream-text.ndjson'))}, 'utf8').split('\\n')) {
      if (line.trim()) process.stdout.write(line + '\\n')
    }
    return
  }
  const brain = path.join(process.env.HOME, '.gemini', 'antigravity-cli', 'brain')
  const swarmDir = path.join(brain, '${convId}', '.system_generated', 'swarm')
  const coordLogs = path.join(brain, '${convId}', '.system_generated', 'logs')
  const workerLogs = path.join(brain, '${workerConvId}', '.system_generated', 'logs')
  fs.mkdirSync(swarmDir, { recursive: true })
  fs.mkdirSync(coordLogs, { recursive: true })
  fs.mkdirSync(workerLogs, { recursive: true })
  fs.writeFileSync(path.join(swarmDir, 'members.json'), JSON.stringify({
    title: '死锁蜂群自愈测试',
    members: {
      coordinator: { conversation_id: '${convId}', role: 'coordinator', wake_mode: 'mentions', last_read_seq: 1, killed: false },
      'worker-a': { conversation_id: '${workerConvId}', role: 'worker', wake_mode: 'mentions', last_read_seq: 1, killed: false },
    },
  }))
  fs.writeFileSync(path.join(swarmDir, 'board.jsonl'), JSON.stringify({ seq: 1, agent: 'coordinator', channel: 'main', text: '@worker-a run build_audio.py' }) + '\\n')
  fs.writeFileSync(path.join(coordLogs, 'transcript.jsonl'), JSON.stringify({ step_index: 0, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'swarm_wait', args: { since: 1 } }] }) + '\\n')
  fs.writeFileSync(path.join(workerLogs, 'transcript.jsonl'), JSON.stringify({ step_index: 0, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }) + '\\n')
  const escaped = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  fs.writeFileSync(${JSON.stringify(escapedPidFile)}, String(escaped.pid))
  process.stdout.write(JSON.stringify({ event: 'init', conversation_id: '${convId}' }) + '\\n')
  fs.writeFileSync(${JSON.stringify(swarmReadyFile)}, '1')
  setInterval(() => {}, 1000)
})
process.stdin.on('end', () => {
  if (process.env.MODE === 'healthy') process.exit(0)
})
`,
      )
      await chmod(fakeCli, 0o755)
      process.env.OC_ANTIGRAVITY_CLI_BIN = fakeCli
      process.env.OPENCLAUDE_HOME = path.join(dir, 'oc-home')

      let fakeNow = 1_000_000
      const diagKinds: string[] = []
      _internals.setTimingTestHooks({
        deadlockTermGraceMs: 80,
        deadlockKillGraceMs: 80,
        swarmWatcher: {
          pollMs: 15,
          now: () => fakeNow,
          stallMonitor: {
            stallThresholdMs: 10_000,
            retryCooldownMs: 20_000,
            exhaustedGraceMs: 20_000,
            maxAlerts: 3,
            diagnosticThrottleMs: 0,
            onDiagnostic: (d) => diagKinds.push(d.kind),
          },
        },
      })

      const adapter = new AntigravityAdapter({
        sessionKey: 'agent:main:webchat:dm:agy-deadlock-exhaust',
        agentId: 'main',
        agentBaseDir: dir,
        config: makeConfig(),
        model: 'antigravity-gemini-3.8-flash',
        effortLevel: 'high',
      } as EngineCreateOpts)
      adapter.on('error', () => {})
      adapter.setAntigravityRoute(ROUTE)

      const events: EngineEvent[] = []
      const run = adapter.submitTurn({
        input: 'start swarm',
        requestId: 'd'.repeat(32),
        onEvent: (e) => events.push(e),
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await run.submitted
      assert.equal(await waitUntil(() => existsSync(swarmReadyFile), 3_000), true)
      escapedPid = Number(readFileSync(escapedPidFile, 'utf8').trim())
      assert.equal(isPgrpAlive(escapedPid), true)

      // Wait for initial watcher baseline seed
      assert.equal(await waitUntil(() => diagKinds.includes('quiet_waiting'), 2_000), true)

      // Drive 3 stall alerts + exhaustedGraceMs without any swarm progress
      fakeNow += 15_000 // alert 1
      assert.equal(await waitUntil(() => diagKinds.filter((k) => k === 'alert_emitted').length >= 1, 2_000), true)
      fakeNow += 25_000 // alert 2
      assert.equal(await waitUntil(() => diagKinds.filter((k) => k === 'alert_emitted').length >= 2, 2_000), true)
      fakeNow += 25_000 // alert 3
      assert.equal(await waitUntil(() => diagKinds.filter((k) => k === 'alert_emitted').length >= 3, 2_000), true)
      // Inside grace window -> still alive, suppressed_max_alerts
      fakeNow += 10_000
      assert.equal(await waitUntil(() => diagKinds.includes('suppressed_max_alerts'), 2_000), true)
      assert.equal(run.finalized, false, 'must NOT terminate before exhaustedGraceMs')

      // Advance past exhaustedGraceMs -> triggers stall_exhausted & auto-termination!
      fakeNow += 15_000
      const summary = await run.summary
      await adapter.waitForOutputDrain()

      assert.ok(summary)
      assert.equal(summary.isError, true)
      assert.match(summary.errorDetail ?? '', /^ANTIGRAVITY_SWARM_DEADLOCKED:/)
      assert.equal(classifyRunError(summary.errorDetail).code, 'unknown', 'must NOT be auto-retried by sessionManager')
      assert.ok(diagKinds.includes('stall_exhausted'))
      assert.equal(isPgrpAlive(escapedPid), false, 'escaped PGID descendant must be killed')
      assert.equal(adapter.isRunning, false)
      assert.ok(
        events.some((e) => e.kind === 'block' && e.block.kind === 'swarm_snapshot' && e.block.snapshot.phase === 'error'),
        'terminal swarm_snapshot must settle with error phase',
      )

      // Verify session/adapter is cleanly unlocked for a subsequent healthy turn
      process.env.MODE = 'healthy'
      _internals.setTimingTestHooks(null)
      const next = adapter.submitTurn({
        input: 'healthy follow-up',
        requestId: 'e'.repeat(32),
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 1 },
        toolUseIdToName: new Map(),
      })
      await next.submitted
      const nextSummary = await next.summary
      await adapter.waitForOutputDrain()
      assert.equal(nextSummary?.isError, false)
    } finally {
      _internals.setTimingTestHooks(null)
      Reflect.deleteProperty(process.env, 'MODE')
      if (escapedPid > 1) {
        try { process.kill(-escapedPid, 'SIGKILL') } catch { /* already dead */ }
      }
      if (saved.OC_ANTIGRAVITY_CLI_BIN === undefined) Reflect.deleteProperty(process.env, 'OC_ANTIGRAVITY_CLI_BIN')
      else process.env.OC_ANTIGRAVITY_CLI_BIN = saved.OC_ANTIGRAVITY_CLI_BIN
      if (saved.OPENCLAUDE_HOME === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_HOME')
      else process.env.OPENCLAUDE_HOME = saved.OPENCLAUDE_HOME
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('route heartbeat fast-kills stalled parked swarm on 2 revoked or 3 transient failures, suppresses fake keepalive activity, and preserves healthy turns', async () => {
    // 1. Unit check of counter transitions (revoked vs transient_error vs ok reset)
    const state = { routeRenewRevokedCount: 0, routeRenewFailureCount: 0 }
    assert.deepEqual(advanceAntigravityRouteHeartbeatCounters(state, 'transient_error', true), {
      degraded: true,
      fastKillReason: null,
    })
    assert.deepEqual(state, { routeRenewRevokedCount: 0, routeRenewFailureCount: 1 })
    assert.deepEqual(advanceAntigravityRouteHeartbeatCounters(state, 'transient_error', true), {
      degraded: true,
      fastKillReason: null,
    })
    assert.deepEqual(state, { routeRenewRevokedCount: 0, routeRenewFailureCount: 2 })
    // Healthy non-stalled turn NEVER fast-kills even at 3+ transient errors or 2+ revoked
    assert.deepEqual(advanceAntigravityRouteHeartbeatCounters(state, 'transient_error', false), {
      degraded: true,
      fastKillReason: null,
    })
    // Now when stalled & parked, 3rd failure fast-kills
    assert.deepEqual(advanceAntigravityRouteHeartbeatCounters(state, 'transient_error', true), {
      degraded: true,
      fastKillReason: 'stalled_swarm_route_failed',
    })
    // 'ok' resets both counters to 0
    assert.deepEqual(advanceAntigravityRouteHeartbeatCounters(state, 'ok', true), {
      degraded: false,
      fastKillReason: null,
    })
    assert.deepEqual(state, { routeRenewRevokedCount: 0, routeRenewFailureCount: 0 })
    // 2 consecutive 'revoked' on stalled parked swarm triggers fast-kill
    assert.deepEqual(advanceAntigravityRouteHeartbeatCounters(state, 'revoked', true), {
      degraded: true,
      fastKillReason: null,
    })
    assert.deepEqual(advanceAntigravityRouteHeartbeatCounters(state, 'revoked', true), {
      degraded: true,
      fastKillReason: 'stalled_swarm_route_revoked',
    })

    // 2. End-to-end AntigravityAdapter fast-kill when swarm is in suppressed_max_alerts + route returns 'revoked'
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-agy-deadlock-route-'))
    const swarmReadyFile = path.join(dir, 'swarm.ready')
    const saved = {
      OC_ANTIGRAVITY_CLI_BIN: process.env.OC_ANTIGRAVITY_CLI_BIN,
      OPENCLAUDE_HOME: process.env.OPENCLAUDE_HOME,
    }
    try {
      const convId = '33333333-4444-4555-8666-777777777777'
      const workerConvId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
      const fakeCli = path.join(dir, 'fake-route-deadlock.cjs')
      await writeFile(
        fakeCli,
        `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
process.stdin.setEncoding('utf8')
let buf = ''
let started = false
process.stdin.on('data', (c) => {
  buf += c
  if (started || !buf.includes('\\n')) return
  started = true
  const brain = path.join(process.env.HOME, '.gemini', 'antigravity-cli', 'brain')
  const swarmDir = path.join(brain, '${convId}', '.system_generated', 'swarm')
  const coordLogs = path.join(brain, '${convId}', '.system_generated', 'logs')
  const workerLogs = path.join(brain, '${workerConvId}', '.system_generated', 'logs')
  fs.mkdirSync(swarmDir, { recursive: true })
  fs.mkdirSync(coordLogs, { recursive: true })
  fs.mkdirSync(workerLogs, { recursive: true })
  fs.writeFileSync(path.join(swarmDir, 'members.json'), JSON.stringify({
    title: '失活路由快速止损',
    members: {
      coordinator: { conversation_id: '${convId}', role: 'coordinator', wake_mode: 'mentions', last_read_seq: 1, killed: false },
      'worker-a': { conversation_id: '${workerConvId}', role: 'worker', wake_mode: 'mentions', last_read_seq: 1, killed: false },
    },
  }))
  fs.writeFileSync(path.join(swarmDir, 'board.jsonl'), JSON.stringify({ seq: 1, agent: 'coordinator', channel: 'main', text: '@worker-a wait' }) + '\\n')
  fs.writeFileSync(path.join(coordLogs, 'transcript.jsonl'), JSON.stringify({ step_index: 0, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'swarm_wait', args: { since: 1 } }] }) + '\\n')
  fs.writeFileSync(path.join(workerLogs, 'transcript.jsonl'), JSON.stringify({ step_index: 0, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }) + '\\n')
  process.stdout.write(JSON.stringify({ event: 'init', conversation_id: '${convId}' }) + '\\n')
  fs.writeFileSync(${JSON.stringify(swarmReadyFile)}, '1')
  setInterval(() => {}, 1000)
})
`,
      )
      await chmod(fakeCli, 0o755)
      process.env.OC_ANTIGRAVITY_CLI_BIN = fakeCli
      process.env.OPENCLAUDE_HOME = path.join(dir, 'oc-home')

      let fakeNow = 2_000_000
      let routeOutcome: 'ok' | 'revoked' = 'ok'
      let renewCalls = 0
      const diagKinds: string[] = []
      _internals.setTimingTestHooks({
        keepaliveMs: 15,
        routeRenewMs: 20,
        deadlockTermGraceMs: 80,
        deadlockKillGraceMs: 80,
        renewRoute: async () => {
          renewCalls += 1
          return routeOutcome
        },
        swarmWatcher: {
          pollMs: 15,
          now: () => fakeNow,
          stallMonitor: {
            stallThresholdMs: 10_000,
            retryCooldownMs: 20_000,
            // Long exhaustedGraceMs so ONLY route-revoked fast-kill can terminate this turn!
            exhaustedGraceMs: 3_600_000,
            maxAlerts: 2,
            diagnosticThrottleMs: 0,
            onDiagnostic: (d) => diagKinds.push(d.kind),
          },
        },
      })

      const adapter = new AntigravityAdapter({
        sessionKey: 'agent:main:webchat:dm:agy-deadlock-route',
        agentId: 'main',
        agentBaseDir: dir,
        config: makeConfig(),
        model: 'antigravity-gemini-3.8-flash',
        effortLevel: 'high',
      } as EngineCreateOpts)
      adapter.on('error', () => {})
      adapter.setAntigravityRoute(ROUTE)

      const run = adapter.submitTurn({
        input: 'start swarm for route fast-kill',
        requestId: 'f'.repeat(32),
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await run.submitted
      assert.equal(await waitUntil(() => existsSync(swarmReadyFile), 3_000), true)
      assert.equal(await waitUntil(() => diagKinds.includes('quiet_waiting'), 2_000), true)

      // Drive 2 stall alerts -> swarm enters suppressed_max_alerts with workingMembers=[]
      fakeNow += 15_000
      assert.equal(await waitUntil(() => diagKinds.filter((k) => k === 'alert_emitted').length >= 1, 2_000), true)
      fakeNow += 25_000
      assert.equal(await waitUntil(() => diagKinds.filter((k) => k === 'alert_emitted').length >= 2, 2_000), true)
      fakeNow += 25_000
      assert.equal(await waitUntil(() => diagKinds.includes('suppressed_max_alerts'), 2_000), true)

      // While in suppressed_max_alerts, keepalive MUST stop emitting fake `activity`
      let syntheticActivities = 0
      const onAct = () => { syntheticActivities += 1 }
      adapter.on('activity', onAct)
      await new Promise((r) => setTimeout(r, 70))
      adapter.off('activity', onAct)
      assert.equal(syntheticActivities, 0, 'keepalive must not emit fake activity once swarm is stuck in suppressed_max_alerts')
      assert.equal(run.finalized, false, 'route still ok -> not terminated yet')

      // Now master revokes the route -> 2 revoked heartbeats fast-kill immediately (far before 1h exhaustedGraceMs)!
      const callsBeforeRevoke = renewCalls
      routeOutcome = 'revoked'
      const summary = await run.summary
      await adapter.waitForOutputDrain()

      assert.ok(summary)
      assert.equal(summary.isError, true)
      assert.match(summary.errorDetail ?? '', /^ANTIGRAVITY_SWARM_DEADLOCKED:/)
      assert.ok(renewCalls >= callsBeforeRevoke + 2, 'must fast-kill after 2 consecutive revoked heartbeats')
      assert.equal(diagKinds.includes('stall_exhausted'), false, 'fast-kill happened via revoked route before stall_exhausted')
    } finally {
      _internals.setTimingTestHooks(null)
      if (saved.OC_ANTIGRAVITY_CLI_BIN === undefined) Reflect.deleteProperty(process.env, 'OC_ANTIGRAVITY_CLI_BIN')
      else process.env.OC_ANTIGRAVITY_CLI_BIN = saved.OC_ANTIGRAVITY_CLI_BIN
      if (saved.OPENCLAUDE_HOME === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_HOME')
      else process.env.OPENCLAUDE_HOME = saved.OPENCLAUDE_HOME
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('B3: abnormal CLI exit (code 1) reaps stderr-inheriting child so close unblocks and turn settles cleanly', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-agy-b3-stderr-pipe-'))
    const childPidFile = path.join(dir, 'stderr-holder.pid')
    const saved = {
      OC_ANTIGRAVITY_CLI_BIN: process.env.OC_ANTIGRAVITY_CLI_BIN,
      OPENCLAUDE_HOME: process.env.OPENCLAUDE_HOME,
    }
    let childPid = 0
    try {
      const fakeCli = path.join(dir, 'fake-b3-stderr-exit.cjs')
      await writeFile(
        fakeCli,
        `#!${process.execPath}
const fs = require('node:fs')
const { spawn } = require('node:child_process')
process.stdin.setEncoding('utf8')
let buf = ''
process.stdin.on('data', (c) => {
  buf += c
  if (!buf.includes('\\n')) return
  // Inherit stderr (NOT stdio: 'ignore') and ignore SIGTERM so 'close' would block forever without B3 exit-time reaping!
  const holder = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
    detached: false,
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  holder.unref()
  fs.writeFileSync(${JSON.stringify(childPidFile)}, String(holder.pid))
  process.stderr.write('error: ANTIGRAVITY_ROUTE_EXPIRED\\n')
  process.exit(1)
})
`,
      )
      await chmod(fakeCli, 0o755)
      process.env.OC_ANTIGRAVITY_CLI_BIN = fakeCli
      process.env.OPENCLAUDE_HOME = path.join(dir, 'oc-home')
      _internals.setTimingTestHooks({ deadlockTermGraceMs: 80, deadlockKillGraceMs: 120 })

      const adapter = new AntigravityAdapter({
        sessionKey: 'agent:main:webchat:dm:agy-b3-stderr',
        agentId: 'main',
        agentBaseDir: dir,
        config: makeConfig(),
        model: 'antigravity-gemini-3.8-flash',
        effortLevel: 'high',
      } as EngineCreateOpts)
      adapter.on('error', () => {})
      adapter.setAntigravityRoute(ROUTE)

      let spawnedAt = Date.now()
      adapter.once('spawn', () => {
        spawnedAt = Date.now()
      })
      const run = adapter.submitTurn({
        input: 'exit 1 while child holds stderr',
        requestId: '1'.repeat(32),
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await run.submitted
      const summary = await run.summary
      await adapter.waitForOutputDrain()

      assert.ok(Date.now() - spawnedAt < 5_000, 'close must unblock via bounded exit-time reap')
      assert.equal(summary?.isError, true)
      assert.match(summary?.errorDetail ?? '', /ANTIGRAVITY_ROUTE_EXPIRED/)
      assert.equal(existsSync(childPidFile), true)
      childPid = Number(readFileSync(childPidFile, 'utf8').trim())
      assert.equal(isPidAlive(childPid), false, 'stderr-inheriting child must be reaped before drain completes')
    } finally {
      _internals.setTimingTestHooks(null)
      if (childPid > 1) {
        try { process.kill(childPid, 'SIGKILL') } catch { /* already dead */ }
      }
      if (saved.OC_ANTIGRAVITY_CLI_BIN === undefined) Reflect.deleteProperty(process.env, 'OC_ANTIGRAVITY_CLI_BIN')
      else process.env.OC_ANTIGRAVITY_CLI_BIN = saved.OC_ANTIGRAVITY_CLI_BIN
      if (saved.OPENCLAUDE_HOME === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_HOME')
      else process.env.OPENCLAUDE_HOME = saved.OPENCLAUDE_HOME
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('B4: adapter.interrupt(user) snapshots escaped-PGID descendants BEFORE SIGINT and reaps them when CLI exits', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-agy-b4-interrupt-'))
    const escapedPidFile = path.join(dir, 'escaped.pid')
    const readyFile = path.join(dir, 'ready')
    const saved = {
      OC_ANTIGRAVITY_CLI_BIN: process.env.OC_ANTIGRAVITY_CLI_BIN,
      OPENCLAUDE_HOME: process.env.OPENCLAUDE_HOME,
    }
    let escapedPid = 0
    try {
      const fakeCli = path.join(dir, 'fake-b4-interrupt.cjs')
      await writeFile(
        fakeCli,
        `#!${process.execPath}
const fs = require('node:fs')
const { spawn } = require('node:child_process')
process.on('SIGINT', () => process.exit(0))
process.stdin.setEncoding('utf8')
let buf = ''
let spawned = false
process.stdin.on('data', (c) => {
  buf += c
  if (spawned || !buf.includes('\\n')) return
  spawned = true
  // Detached escaped-PGID worker with stdio: 'ignore' (reparents to PID 1 on CLI SIGINT exit!)
  const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  })
  worker.unref()
  fs.writeFileSync(${JSON.stringify(escapedPidFile)}, String(worker.pid))
  fs.writeFileSync(${JSON.stringify(readyFile)}, '1')
  setInterval(() => {}, 1000)
})
`,
      )
      await chmod(fakeCli, 0o755)
      process.env.OC_ANTIGRAVITY_CLI_BIN = fakeCli
      process.env.OPENCLAUDE_HOME = path.join(dir, 'oc-home')
      _internals.setTimingTestHooks({ deadlockTermGraceMs: 80, deadlockKillGraceMs: 120 })

      const adapter = new AntigravityAdapter({
        sessionKey: 'agent:main:webchat:dm:agy-b4-interrupt',
        agentId: 'main',
        agentBaseDir: dir,
        config: makeConfig(),
        model: 'antigravity-gemini-3.8-flash',
        effortLevel: 'high',
      } as EngineCreateOpts)
      adapter.on('error', () => {})
      adapter.setAntigravityRoute(ROUTE)

      const run = adapter.submitTurn({
        input: 'spawn escaped worker then user interrupt',
        requestId: '2'.repeat(32),
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await run.submitted
      assert.equal(await waitUntil(() => existsSync(readyFile), 3_000), true)
      escapedPid = Number(readFileSync(escapedPidFile, 'utf8').trim())
      assert.ok(escapedPid > 1)
      assert.equal(isPgrpAlive(escapedPid), true)

      assert.equal(adapter.interrupt('user'), true)
      const summary = await run.summary
      await adapter.waitForOutputDrain()

      assert.equal(summary?.stopReason, 'interrupted')
      assert.equal(isPgrpAlive(escapedPid), false, 'escaped-PGID worker must be reaped after interrupt()')
    } finally {
      _internals.setTimingTestHooks(null)
      if (escapedPid > 1) {
        try { process.kill(-escapedPid, 'SIGKILL') } catch { /* already dead */ }
      }
      if (saved.OC_ANTIGRAVITY_CLI_BIN === undefined) Reflect.deleteProperty(process.env, 'OC_ANTIGRAVITY_CLI_BIN')
      else process.env.OC_ANTIGRAVITY_CLI_BIN = saved.OC_ANTIGRAVITY_CLI_BIN
      if (saved.OPENCLAUDE_HOME === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_HOME')
      else process.env.OPENCLAUDE_HOME = saved.OPENCLAUDE_HOME
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('B5: mixed batch [run_command, swarm_wait] with unfinished run_command never fires stall_exhausted and keeps isStallSuppressedAllParked() false past 30m+', async () => {
    const brainDir = await mkdtemp(path.join(tmpdir(), 'oc-agy-b5-mixed-batch-'))
    try {
      const convId = '44444444-5555-4666-8777-888888888888'
      const workerConvId = 'cccccccc-dddd-4eee-8fff-111111111111'
      const swarmDir = path.join(brainDir, convId, '.system_generated', 'swarm')
      const coordLogs = path.join(brainDir, convId, '.system_generated', 'logs')
      const workerLogs = path.join(brainDir, workerConvId, '.system_generated', 'logs')
      await mkdir(swarmDir, { recursive: true })
      await mkdir(coordLogs, { recursive: true })
      await mkdir(workerLogs, { recursive: true })

      // Even if native CLI flipped wake_mode to 'mentions' for swarm_wait, worker's mixed batch still has unfinished run_command!
      await writeFile(
        path.join(swarmDir, 'members.json'),
        JSON.stringify({
          title: '混合工具批次保护测试',
          members: {
            coordinator: { conversation_id: convId, role: 'coordinator', phase: 'RUNNING', wake_mode: 'mentions', last_read_seq: 1, killed: false },
            'worker-a': { conversation_id: workerConvId, role: 'worker', phase: 'RUNNING', wake_mode: 'mentions', last_read_seq: 1, killed: false },
          },
        }),
      )
      await writeFile(
        path.join(swarmDir, 'board.jsonl'),
        `${JSON.stringify({ seq: 1, agent: 'coordinator', channel: 'main', text: '@worker-a run long build' })}\n`,
      )
      await writeFile(
        path.join(coordLogs, 'transcript.jsonl'),
        `${JSON.stringify({ step_index: 0, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'swarm_wait', args: { since: 1 } }] })}\n`,
      )
      const mixedTranscript = `${[
        JSON.stringify({
          step_index: 0,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          tool_calls: [
            { name: 'run_command', args: { CommandLine: 'python3 long_job.py' } },
            { name: 'swarm_wait', args: { since: 1 } },
          ],
        }),
        // Only swarm_wait emitted a GENERIC DONE result; run_command (2nd call) has NOT completed yet!
        JSON.stringify({ step_index: 1, type: 'GENERIC', status: 'DONE', content: 'Waiting...' }),
      ].join('\n')}\n`
      await writeFile(path.join(workerLogs, 'transcript.jsonl'), mixedTranscript)

      const parsed = parseMemberTranscriptTail(mixedTranscript)
      assert.equal(parsed.status, 'working')
      assert.equal(parsed.waitingOnBoard, false)
      assert.equal(parsed.activity, '运行命令')

      const snap = readAntigravitySwarmSnapshot({
        brainDir,
        conversationId: convId,
        phase: 'running',
        revision: 1,
        now: 1_000,
      })
      assert.ok(snap)
      const workerSnap = snap.members.find((m) => m.name === 'worker-a')
      assert.equal(workerSnap?.status, 'working', 'mixed batch with unfinished run_command must stay working despite wake_mode=mentions')
      assert.equal(workerSnap?.waitingOnBoard, false)

      const exhausted: SwarmStallExhaustion[] = []
      const mon = new SwarmStallMonitor({
        onStallExhausted: (e) => exhausted.push(e),
      })
      assert.equal(mon.evaluate(snap, 0), null)
      // Advance past 30 minutes (default parked deadlock window = 3m + 9m + 9m + 9m = 30m)
      assert.equal(mon.evaluate(snap, 180_000), null)
      assert.equal(mon.evaluate(snap, 720_000), null)
      assert.equal(mon.evaluate(snap, 1_260_000), null)
      assert.equal(mon.evaluate(snap, 1_800_000), null)
      assert.equal(mon.isStallSuppressedAllParked(), false, 'must remain false at 30m')
      assert.equal(exhausted.length, 0, 'must NOT trigger stall_exhausted at 30m')

      // Even past workingStallThresholdMs (40m) + 3 reminder alerts + exhaustedGraceMs (2+ hours):
      // working_member_stalled reminders are allowed, but auto-kill exhaustion and fast-kill guard stay FALSE!
      const r1 = mon.evaluate(snap, 2_400_000)
      assert.equal(r1?.reason, 'working_member_stalled')
      const r2 = mon.evaluate(snap, 2_940_000)
      assert.equal(r2?.reason, 'working_member_stalled')
      const r3 = mon.evaluate(snap, 3_480_000)
      assert.equal(r3?.reason, 'working_member_stalled')
      assert.equal(mon.evaluate(snap, 7_200_000), null)
      assert.equal(mon.isStallSuppressedAllParked(), false, 'active non-wait tool must NEVER flip isStallSuppressedAllParked()')
      assert.equal(exhausted.length, 0, 'active non-wait tool must NEVER trigger stall_exhausted')

      // R2-B5 Case ①: When run_command has explicitly completed (DONE) and ONLY swarm_wait remains pending,
      // worker IS parked on board and MUST trigger stall_exhausted after 30m dead silence!
      const runDoneWaitPendingTranscript = `${[
        JSON.stringify({
          step_index: 0,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          tool_calls: [
            { id: 'tc-cmd-1', name: 'run_command', args: { CommandLine: 'python3 build.py' } },
            { id: 'tc-wait-1', name: 'swarm_wait', args: { since: 1 } },
          ],
        }),
        JSON.stringify({
          step_index: 1,
          type: 'TOOL_RESULT',
          tool_call_id: 'tc-cmd-1',
          tool_name: 'run_command',
          status: 'DONE',
          content: 'ok',
        }),
      ].join('\n')}\n`
      await writeFile(path.join(workerLogs, 'transcript.jsonl'), runDoneWaitPendingTranscript)
      const snapOnlyWait = readAntigravitySwarmSnapshot({
        brainDir,
        conversationId: convId,
        phase: 'running',
        revision: 2,
        now: 1_000,
      })
      assert.ok(snapOnlyWait)
      const workerOnlyWait = snapOnlyWait.members.find((m) => m.name === 'worker-a')
      assert.equal(workerOnlyWait?.status, 'waiting', 'once run_command is DONE and only swarm_wait remains, worker is parked')
      assert.equal(workerOnlyWait?.waitingOnBoard, true)
      const exhaustedCase1: SwarmStallExhaustion[] = []
      const monCase1 = new SwarmStallMonitor({ onStallExhausted: (e) => exhaustedCase1.push(e) })
      assert.equal(monCase1.evaluate(snapOnlyWait, 0), null)
      assert.ok(monCase1.evaluate(snapOnlyWait, 180_000))
      assert.ok(monCase1.evaluate(snapOnlyWait, 720_000))
      assert.ok(monCase1.evaluate(snapOnlyWait, 1_260_000))
      assert.equal(monCase1.evaluate(snapOnlyWait, 1_800_000), null)
      assert.equal(monCase1.isStallSuppressedAllParked(), true, 'parked swarm must allow exhaustion once non-wait command finished')
      assert.equal(exhaustedCase1.length, 1, 'parked swarm must trigger stall_exhausted at 30m once only swarm_wait remains')

      // R2-B5 Case ②: When swarm_wait emits a single-step ERROR while sibling run_command is STILL running,
      // worker MUST stay working/waitingOnBoard=false and NEVER trigger stall_exhausted at 30m!
      const waitErrorCmdRunningTranscript = `${[
        JSON.stringify({
          step_index: 0,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          tool_calls: [
            { id: 'tc-cmd-2', name: 'run_command', args: { CommandLine: 'python3 train.py' } },
            { id: 'tc-wait-2', name: 'swarm_wait', args: { since: 1 } },
          ],
        }),
        JSON.stringify({
          step_index: 1,
          type: 'TOOL_RESULT',
          tool_call_id: 'tc-wait-2',
          tool_name: 'swarm_wait',
          status: 'ERROR',
          error: 'swarm_wait rejected',
        }),
      ].join('\n')}\n`
      await writeFile(path.join(workerLogs, 'transcript.jsonl'), waitErrorCmdRunningTranscript)
      const snapWaitErr = readAntigravitySwarmSnapshot({
        brainDir,
        conversationId: convId,
        phase: 'running',
        revision: 3,
        now: 1_000,
      })
      assert.ok(snapWaitErr)
      const workerWaitErr = snapWaitErr.members.find((m) => m.name === 'worker-a')
      assert.equal(workerWaitErr?.status, 'working', 'single-step swarm_wait ERROR must NOT mark worker parked while run_command is still unfinished')
      assert.equal(workerWaitErr?.waitingOnBoard, false)
      const exhaustedCase2: SwarmStallExhaustion[] = []
      const monCase2 = new SwarmStallMonitor({ onStallExhausted: (e) => exhaustedCase2.push(e) })
      assert.equal(monCase2.evaluate(snapWaitErr, 0), null)
      assert.equal(monCase2.evaluate(snapWaitErr, 180_000), null)
      assert.equal(monCase2.evaluate(snapWaitErr, 720_000), null)
      assert.equal(monCase2.evaluate(snapWaitErr, 1_260_000), null)
      assert.equal(monCase2.evaluate(snapWaitErr, 1_800_000), null)
      assert.equal(monCase2.isStallSuppressedAllParked(), false)
      assert.equal(exhaustedCase2.length, 0, 'unfinished run_command must NEVER be auto-killed because sibling swarm_wait errored')

      // R2 P1-1: [run_command(A, id=tc-a), run_command(B, id=tc-b), swarm_wait(C, id=tc-c)] where
      // later sibling B completes FIRST (with both id & tool_name) + emits duplicate DONE + anonymous GENERIC DONE!
      // A is still unfinished, so B's single ID-bound completion MUST NOT cancel both A and B!
      const outOfOrderSameNameTranscript = `${[
        JSON.stringify({
          step_index: 0,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          tool_calls: [
            { id: 'tc-a', name: 'run_command', args: { CommandLine: 'python3 job_a.py' } },
            { id: 'tc-b', name: 'run_command', args: { CommandLine: 'python3 job_b.py' } },
            { id: 'tc-c', name: 'swarm_wait', args: { since: 1 } },
          ],
        }),
        JSON.stringify({
          step_index: 1,
          type: 'TOOL_RESULT',
          tool_call_id: 'tc-b',
          tool_name: 'run_command',
          status: 'DONE',
          content: 'job_b finished first',
        }),
        // Duplicate DONE for tc-b + anonymous GENERIC DONE (total DONE lines >= 3, yet A is still running!)
        JSON.stringify({
          step_index: 2,
          type: 'TOOL_RESULT',
          tool_call_id: 'tc-b',
          tool_name: 'run_command',
          status: 'DONE',
          content: 'job_b duplicate log',
        }),
        JSON.stringify({
          step_index: 3,
          type: 'GENERIC',
          status: 'DONE',
          content: 'Waiting...',
        }),
      ].join('\n')}\n`
      await writeFile(path.join(workerLogs, 'transcript.jsonl'), outOfOrderSameNameTranscript)
      const snapP11 = readAntigravitySwarmSnapshot({
        brainDir,
        conversationId: convId,
        phase: 'running',
        revision: 4,
        now: 1_000,
      })
      assert.ok(snapP11)
      const workerP11 = snapP11.members.find((m) => m.name === 'worker-a')
      assert.equal(workerP11?.status, 'working', 'P1-1: B finishing first + duplicate DONE must NOT cancel A')
      assert.equal(workerP11?.waitingOnBoard, false)
      const exhaustedP11: SwarmStallExhaustion[] = []
      const monP11 = new SwarmStallMonitor({ onStallExhausted: (e) => exhaustedP11.push(e) })
      assert.equal(monP11.evaluate(snapP11, 0), null)
      assert.equal(monP11.evaluate(snapP11, 180_000), null)
      assert.equal(monP11.evaluate(snapP11, 720_000), null)
      assert.equal(monP11.evaluate(snapP11, 1_260_000), null)
      assert.equal(monP11.evaluate(snapP11, 1_800_000), null)
      assert.equal(monP11.isStallSuppressedAllParked(), false)
      assert.equal(exhaustedP11.length, 0, 'P1-1: swarm must NOT be reaped while run_command(A) is still unfinished')

      // R2-final P1-1 control matrix:
      // (a) un-ID'd [run_command(A), run_command(B), swarm_wait] + single named DONE -> working, 0 exhaustion
      // (b) same un-ID'd batch with B's exact DONE replayed (same step_index OR unindexed) -> STILL working, 0 exhaustion
      // (c) attributable completions for BOTH A (tc-a) and B (tc-b) -> waiting, normal stall_exhausted convergence
      const unIdBatchStep = JSON.stringify({
        step_index: 0,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [
          { name: 'run_command', args: { CommandLine: 'python3 job_a.py' } },
          { name: 'run_command', args: { CommandLine: 'python3 job_b.py' } },
          { name: 'swarm_wait', args: { since: 1 } },
        ],
      })
      const unIdDoneStep = JSON.stringify({
        step_index: 1,
        type: 'TOOL_RESULT',
        tool_name: 'run_command',
        status: 'DONE',
        content: 'job_b finished',
      })
      for (const [label, lines] of [
        ['single un-ID DONE', [unIdBatchStep, unIdDoneStep]],
        ['replayed un-ID DONE (same step_index)', [unIdBatchStep, unIdDoneStep, unIdDoneStep]],
      ] as const) {
        await writeFile(path.join(workerLogs, 'transcript.jsonl'), `${lines.join('\n')}\n`)
        const snapUnId = readAntigravitySwarmSnapshot({
          brainDir,
          conversationId: convId,
          phase: 'running',
          revision: 5,
          now: 1_000,
        })
        assert.ok(snapUnId)
        const wUnId = snapUnId.members.find((m) => m.name === 'worker-a')
        assert.equal(wUnId?.status, 'working', `${label}: must stay working while A is unfinished`)
        assert.equal(wUnId?.waitingOnBoard, false, `${label}: waitingOnBoard must stay false`)
        const exhUnId: SwarmStallExhaustion[] = []
        const monUnId = new SwarmStallMonitor({ onStallExhausted: (e) => exhUnId.push(e) })
        assert.equal(monUnId.evaluate(snapUnId, 0), null)
        assert.equal(monUnId.evaluate(snapUnId, 180_000), null)
        assert.equal(monUnId.evaluate(snapUnId, 720_000), null)
        assert.equal(monUnId.evaluate(snapUnId, 1_260_000), null)
        assert.equal(monUnId.evaluate(snapUnId, 1_800_000), null)
        assert.equal(exhUnId.length, 0, `${label}: must NOT fire max_alerts_exhausted`)
      }

      // Positive control (c): both A (tc-a) and B (tc-b) have attributable completions -> normal waiting convergence
      const bothDoneTranscript = `${[
        JSON.stringify({
          step_index: 0,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          tool_calls: [
            { id: 'tc-a', name: 'run_command', args: { CommandLine: 'python3 job_a.py' } },
            { id: 'tc-b', name: 'run_command', args: { CommandLine: 'python3 job_b.py' } },
            { id: 'tc-c', name: 'swarm_wait', args: { since: 1 } },
          ],
        }),
        JSON.stringify({ step_index: 1, type: 'TOOL_RESULT', tool_call_id: 'tc-b', tool_name: 'run_command', status: 'DONE', content: 'b ok' }),
        JSON.stringify({ step_index: 2, type: 'TOOL_RESULT', tool_call_id: 'tc-a', tool_name: 'run_command', status: 'DONE', content: 'a ok' }),
      ].join('\n')}\n`
      await writeFile(path.join(workerLogs, 'transcript.jsonl'), bothDoneTranscript)
      const snapBothDone = readAntigravitySwarmSnapshot({
        brainDir,
        conversationId: convId,
        phase: 'running',
        revision: 6,
        now: 1_000,
      })
      assert.ok(snapBothDone)
      const wBothDone = snapBothDone.members.find((m) => m.name === 'worker-a')
      assert.equal(wBothDone?.status, 'waiting', 'once both A and B have attributable DONEs, worker parks normally')
      assert.equal(wBothDone?.waitingOnBoard, true)
      const exhBoth: SwarmStallExhaustion[] = []
      const monBoth = new SwarmStallMonitor({ onStallExhausted: (e) => exhBoth.push(e) })
      assert.equal(monBoth.evaluate(snapBothDone, 0), null)
      assert.ok(monBoth.evaluate(snapBothDone, 180_000))
      assert.ok(monBoth.evaluate(snapBothDone, 720_000))
      assert.ok(monBoth.evaluate(snapBothDone, 1_260_000))
      assert.equal(monBoth.evaluate(snapBothDone, 1_800_000), null)
      assert.equal(exhBoth.length, 1, 'parked swarm converges normally once both A and B completed')
    } finally {
      await rm(brainDir, { recursive: true, force: true })
    }
  })

  test('R2 P1-3: spontaneous non-zero CLI exit WITHOUT prior Stop reaps reparented escaped-PGID worker (stdio: ignore), preserves managed_job, and releases swarm slot', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-agy-p13-reparent-'))
    const workerPidFile = path.join(dir, 'escaped-worker.pid')
    const managedPidFile = path.join(dir, 'managed-job.pid')
    const saved = {
      OC_ANTIGRAVITY_CLI_BIN: process.env.OC_ANTIGRAVITY_CLI_BIN,
      OPENCLAUDE_HOME: process.env.OPENCLAUDE_HOME,
    }
    let workerPid = 0
    let managedPid = 0
    const { setLocalSwarmConcurrencyLimitForTests, getLocalSwarmConcurrencyStateForTests } = await import(
      '../engine/antigravitySwarmConcurrency.js'
    )
    try {
      setLocalSwarmConcurrencyLimitForTests(1)
      const fakeCli = path.join(dir, 'fake-p13-spontaneous-exit.cjs')
      await writeFile(
        fakeCli,
        `#!${process.execPath}
const fs = require('node:fs')
const { spawn } = require('node:child_process')
process.stdin.setEncoding('utf8')
let buf = ''
process.stdin.on('data', (c) => {
  buf += c
  if (!buf.includes('\\n')) return
  if (process.env.MODE === 'followup') {
    for (const line of fs.readFileSync(${JSON.stringify(path.join(FIXTURES, 'stream-text.ndjson'))}, 'utf8').split('\\n')) {
      if (line.trim()) process.stdout.write(line + '\\n')
    }
    return
  }
  // 1) Independent PGID worker (detached: true, stdio: 'ignore') that reparents to PID 1 on CLI exit!
  const worker = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: 'ignore',
  })
  worker.unref()
  fs.writeFileSync(${JSON.stringify(workerPidFile)}, String(worker.pid))

  // 2) Survivable managed_job in its own PGID (carries OPENCLAUDE_LIFECYCLE_CLASS=managed_job) -> MUST SURVIVE!
  const managedEnv = { ...process.env, OPENCLAUDE_LIFECYCLE_CLASS: 'managed_job' }
  delete managedEnv.OPENCLAUDE_TURN_REAP_TAG
  const managed = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
    env: managedEnv,
  })
  managed.unref()
  fs.writeFileSync(${JSON.stringify(managedPidFile)}, String(managed.pid))

  process.stderr.write('error: spontaneous cli crash\\n')
  process.exit(1)
})
process.stdin.on('end', () => {
  if (process.env.MODE === 'followup') process.exit(0)
})
`,
      )
      await chmod(fakeCli, 0o755)
      process.env.OC_ANTIGRAVITY_CLI_BIN = fakeCli
      process.env.OPENCLAUDE_HOME = path.join(dir, 'oc-home')
      _internals.setTimingTestHooks({ deadlockTermGraceMs: 60, deadlockKillGraceMs: 120 })

      const adapter = new AntigravityAdapter({
        sessionKey: 'agent:main:webchat:dm:agy-p13-reparent',
        agentId: 'main',
        agentBaseDir: dir,
        config: makeConfig(),
        model: 'antigravity-gemini-3.8-flash',
        effortLevel: 'high',
      } as EngineCreateOpts)
      adapter.on('error', () => {})
      adapter.setAntigravityRoute(ROUTE)

      const run = adapter.submitTurn({
        input: 'swarm turn crashing spontaneously',
        requestId: '3'.repeat(32),
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
        antigravitySwarmCompaction: { appliedMode: 'on_full' } as never,
      })
      await run.submitted
      const summary = await run.summary
      await adapter.waitForOutputDrain()

      assert.equal(summary?.isError, true)
      workerPid = Number(readFileSync(workerPidFile, 'utf8').trim())
      managedPid = Number(readFileSync(managedPidFile, 'utf8').trim())
      assert.ok(workerPid > 1 && managedPid > 1)
      assert.equal(
        await waitUntil(() => !isPgrpAlive(workerPid), 1_500),
        true,
        'P1-3: reparented escaped-PGID worker (stdio: ignore) must be reaped even without prior Stop',
      )
      assert.equal(isPgrpAlive(managedPid), true, 'P1-3: survivable managed_job must remain alive')
      assert.equal(getLocalSwarmConcurrencyStateForTests().active, 0, 'swarm slot must be released after reap')

      // Successor swarm turn must acquire the slot cleanly without blocking
      process.env.MODE = 'followup'
      _internals.setTimingTestHooks(null)
      const next = adapter.submitTurn({
        input: 'followup swarm turn',
        requestId: '4'.repeat(32),
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 1 },
        toolUseIdToName: new Map(),
        antigravitySwarmCompaction: { appliedMode: 'on_full' } as never,
      })
      await next.submitted
      const nextSummary = await next.summary
      await adapter.waitForOutputDrain()
      assert.equal(nextSummary?.isError, false)
    } finally {
      setLocalSwarmConcurrencyLimitForTests(null)
      _internals.setTimingTestHooks(null)
      Reflect.deleteProperty(process.env, 'MODE')
      if (workerPid > 1) {
        try { process.kill(-workerPid, 'SIGKILL') } catch { /* already dead */ }
      }
      if (managedPid > 1) {
        try { process.kill(-managedPid, 'SIGKILL') } catch { /* already dead */ }
      }
      if (saved.OC_ANTIGRAVITY_CLI_BIN === undefined) Reflect.deleteProperty(process.env, 'OC_ANTIGRAVITY_CLI_BIN')
      else process.env.OC_ANTIGRAVITY_CLI_BIN = saved.OC_ANTIGRAVITY_CLI_BIN
      if (saved.OPENCLAUDE_HOME === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_HOME')
      else process.env.OPENCLAUDE_HOME = saved.OPENCLAUDE_HOME
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('Steward R1-B1: PGID reuse, recycled rootPid children, and pre-first-kill /proc races never signal another turn process group', async () => {
    const { killProcessTreeAsync, mergeProcessTreeSnapshots } = await import('../processGroupShutdown.js')
    const statLine = (pid: number, comm: string, ppid: number, pgid: number, startTicks: number) =>
      `${pid} (${comm}) S ${ppid} ${pgid} ${pgid} 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 ${startTicks}`
    const procTable: Record<number, { stat: string; cmdline: string; environ: string }> = {
      500: { stat: statLine(500, 'node', 1, 500, 100), cmdline: 'node\0gateway.js', environ: '' },
      8050: {
        stat: statLine(8050, 'antigravity', 500, 8050, 1000),
        cmdline: 'antigravity',
        environ: 'OPENCLAUDE_TURN_REAP_TAG=turn-alpha\0',
      },
      9816: {
        stat: statLine(9816, 'python3', 8050, 9816, 1010),
        cmdline: 'python3\0worker.py',
        environ: 'OPENCLAUDE_TURN_REAP_TAG=turn-alpha\0',
      },
      9900: {
        stat: statLine(9900, 'ffmpeg', 9816, 9900, 1020),
        cmdline: 'ffmpeg',
        environ: 'OPENCLAUDE_TURN_REAP_TAG=turn-alpha\0',
      },
    }
    const opts: ProcessTreeOpts = {
      platform: 'linux',
      selfPid: 500,
      selfPpid: 1,
      selfPgid: 500,
      turnReapTag: 'turn-alpha',
      readProcDir: () => Object.keys(procTable),
      readProcStat: (pid) => procTable[pid]?.stat ?? null,
      readProcCmdline: (pid) => procTable[pid]?.cmdline ?? null,
      readProcEnviron: (pid) => procTable[pid]?.environ ?? null,
    }
    const procStub = {
      pid: 8050,
      kill: () => true,
    }
    const preTerm = snapshotDescendantProcessGroups(8050, opts)

    // Point 2: Snapshot captured at T=0 when 9816 had startTicks=1010, then BEFORE the VERY FIRST
    // killProcessTree / killProcessTreeAsync call, 9816 exits and its PGID is recycled (startTicks=6000).
    // Live /proc re-verification before signaling MUST skip -9816 on the first kill!
    procTable[9816] = {
      stat: statLine(9816, 'recycled-before-first-kill', 1, 9816, 6000),
      cmdline: 'python3\0unrelated.py',
      environ: 'OPENCLAUDE_TURN_REAP_TAG=turn-gamma\0',
    }
    const raceSignals: Array<{ target: number; signal: NodeJS.Signals | number | undefined }> = []
    await killProcessTreeAsync(procStub, 'SIGTERM', {
      ...opts,
      snapshot: preTerm,
      kill: (pid, sig) => {
        raceSignals.push({ target: pid, signal: sig })
        return true
      },
    })
    assert.deepEqual(
      raceSignals,
      [
        { target: -8050, signal: 'SIGTERM' },
        { target: -9900, signal: 'SIGTERM' },
      ],
      'first kill after snapshot must re-read live /proc and skip PGID -9816 recycled before first signal',
    )

    // Restore 9816 to original turn-alpha identity for normal SIGTERM -> refresh -> SIGKILL flow
    procTable[9816] = {
      stat: statLine(9816, 'python3', 8050, 9816, 1010),
      cmdline: 'python3\0worker.py',
      environ: 'OPENCLAUDE_TURN_REAP_TAG=turn-alpha\0',
    }
    const termSignals: Array<{ target: number; signal: NodeJS.Signals | number | undefined }> = []
    const afterTerm = killProcessTree(procStub, 'SIGTERM', {
      ...opts,
      snapshot: preTerm,
      kill: (pid, sig) => {
        termSignals.push({ target: pid, signal: sig })
        return true
      },
    })
    assert.deepEqual(termSignals, [
      { target: -8050, signal: 'SIGTERM' },
      { target: -9816, signal: 'SIGTERM' },
      { target: -9900, signal: 'SIGTERM' },
    ])

    // Snapshot without live /proc reader MUST fail closed on Linux (0 signals)
    const staleSignals: number[] = []
    killProcessTree(procStub, 'SIGKILL', {
      platform: 'linux',
      selfPid: 500,
      selfPpid: 1,
      selfPgid: 500,
      snapshot: afterTerm,
      turnReapTag: 'turn-alpha',
      kill: (pid) => {
        staleSignals.push(pid)
        return true
      },
    })
    assert.deepEqual(staleSignals, [], 'historical snapshot without live /proc reader must fail closed')

    // Point 1: Simulate OS recycling root PGID 8050 (startTicks=5000) which spawns a brand-new child
    // group 9200 (ppid=8050, pgid=9200, startTicks=5010, turn-beta), AND recycling descendant PGID 9816
    // (leaderless recycled group: child 9817 in pgid 9816), while 9900 from turn-alpha remains alive.
    procTable[8050] = {
      stat: statLine(8050, 'other-turn-agy', 500, 8050, 5000),
      cmdline: 'antigravity',
      environ: 'OPENCLAUDE_TURN_REAP_TAG=turn-beta\0',
    }
    procTable[9200] = {
      stat: statLine(9200, 'other-turn-child', 8050, 9200, 5010),
      cmdline: 'python3\0new_root_child.py',
      environ: 'OPENCLAUDE_TURN_REAP_TAG=turn-beta\0',
    }
    Reflect.deleteProperty(procTable, 9816)
    procTable[9817] = {
      stat: statLine(9817, 'other-turn-worker', 1, 9816, 5020),
      cmdline: 'python3\0other.py',
      environ: 'OPENCLAUDE_TURN_REAP_TAG=turn-beta\0',
    }
    procTable[9900] = {
      stat: statLine(9900, 'ffmpeg', 1, 9900, 1020),
      cmdline: 'ffmpeg',
      environ: 'OPENCLAUDE_TURN_REAP_TAG=turn-alpha\0',
    }

    const refreshedWithPrev = snapshotDescendantProcessGroups(8050, { ...opts, prevSnapshot: afterTerm })
    assert.equal(refreshedWithPrev.rootAlive, false, 'prevSnapshot refresh must detect recycled rootPid 8050')
    assert.deepEqual(
      refreshedWithPrev.descendantPgids,
      [9900],
      'prevSnapshot refresh must NOT walk children (9200) of recycled rootPid 8050',
    )

    const freshBeforeKill = snapshotDescendantProcessGroups(8050, opts)
    assert.equal(
      freshBeforeKill.rootAlive,
      false,
      'unanchored first scan with turnReapTag must reject recycled rootPid 8050 lacking turn-alpha tag',
    )
    assert.deepEqual(
      freshBeforeKill.descendantPgids,
      [9900],
      'unanchored first scan must NOT walk children (9200) of recycled rootPid 8050',
    )
    const merged = mergeProcessTreeSnapshots(afterTerm, freshBeforeKill)
    assert.equal(merged?.rootAlive, false, 'recycled root PGID 8050 must be marked not alive for turn-alpha')
    assert.deepEqual(
      merged?.descendantPgids,
      [9900],
      'mergeProcessTreeSnapshots must prune recycled 9816 AND reject untagged child 9200 of dead root',
    )

    const killSignals: Array<{ target: number; signal: NodeJS.Signals | number | undefined }> = []
    killProcessTree(procStub, 'SIGKILL', {
      ...opts,
      snapshot: merged,
      kill: (pid, sig) => {
        killSignals.push({ target: pid, signal: sig })
        return true
      },
    })
    assert.deepEqual(
      killSignals,
      [{ target: -9900, signal: 'SIGKILL' }],
      'must signal ONLY verified surviving turn-alpha PGID -9900 and NEVER recycled -8050, -9200, or -9816',
    )

    // Empty-snapshot post-exit cleanup when 9900 is gone and 8050 + 9200 belong to turn-beta -> 0 signals
    Reflect.deleteProperty(procTable, 9900)
    const zeroSignals: number[] = []
    await killProcessTreeAsync(procStub, 'SIGTERM', {
      ...opts,
      snapshot: null,
      kill: (pid) => {
        zeroSignals.push(pid)
        return true
      },
    })
    assert.deepEqual(
      zeroSignals,
      [],
      'empty-snapshot cleanup after rootPid recycling with child PGID 9200 must send zero signals to new turn',
    )

    // Async spawn identity seed race: if PID 8050 exits and is recycled by turn-beta BEFORE async /proc
    // reads complete, probeSpawnedTurnProcessIdentity MUST reject the recycled process and return null!
    const { probeSpawnedTurnProcessIdentity } = await import('../engine/antigravityDeadlockGuard.js')
    const mockProc = { pid: 8050, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null }
    const raceSeed = await probeSpawnedTurnProcessIdentity(mockProc, 'turn-alpha', {
      platform: 'linux',
      readStat: async (pid) => procTable[pid]?.stat ?? null,
      readEnviron: async (pid) => procTable[pid]?.environ ?? null,
    })
    assert.equal(raceSeed, null, 'spawn seed must reject PID 8050 whose environ belongs to turn-beta')

    // Even if environ matched initially, if proc exits mid-probe (exitCode becomes 1), seed returns null
    procTable[8050] = {
      stat: statLine(8050, 'antigravity', 500, 8050, 1000),
      cmdline: 'antigravity',
      environ: 'OPENCLAUDE_TURN_REAP_TAG=turn-alpha\0',
    }
    const exitedMidProbe = await probeSpawnedTurnProcessIdentity(mockProc, 'turn-alpha', {
      platform: 'linux',
      readStat: async (pid) => procTable[pid]?.stat ?? null,
      readEnviron: async (pid) => {
        mockProc.exitCode = 1
        return procTable[pid]?.environ ?? null
      },
    })
    assert.equal(exitedMidProbe, null, 'spawn seed must abort if ChildProcess exits before probe completes')
  })

  test('Steward R1-B3: clean CLI exit with turnReapTag re-scans /proc across newly forked SIGTERM orphans, preserves managed_job, and holds swarm slot across timeout until drained', async () => {
    const {
      acquireLocalAntigravitySwarmSlot,
      getLocalSwarmConcurrencyStateForTests,
      releaseSwarmSlotAfterBoundedReap,
      setLocalSwarmConcurrencyLimitForTests,
    } = await import('../engine/antigravitySwarmConcurrency.js')
    const statLine = (pid: number, comm: string, ppid: number, pgid: number, startTicks: number) =>
      `${pid} (${comm}) S ${ppid} ${pgid} ${pgid} 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 ${startTicks}`
    const procTable: Record<number, { stat: string; cmdline: string; environ: string }> = {
      500: { stat: statLine(500, 'node', 1, 500, 100), cmdline: 'node\0gateway.js', environ: '' },
      // Root CLI 8050 has ALREADY exited cleanly (not in procTable), snapshot is null!
      9400: {
        stat: statLine(9400, 'python3', 1, 9400, 2100),
        cmdline: 'python3\0orphan.py',
        environ: 'OPENCLAUDE_TURN_REAP_TAG=turn-clean-0\0',
      },
      9500: {
        stat: statLine(9500, 'node', 1, 9500, 2110),
        cmdline: 'node\0managed.js',
        environ: 'OPENCLAUDE_TURN_REAP_TAG=turn-clean-0\0OPENCLAUDE_LIFECYCLE_CLASS=managed_job\0',
      },
    }
    let scanCount = 0
    const timeline: string[] = []
    let ephemeralSurvivorsAtRelease = -1

    const fakeProc = {
      pid: 8050,
      kill: () => false,
      once: () => fakeProc,
      removeListener: () => fakeProc,
    } as never

    const reapedClean = await releaseSwarmSlotAfterBoundedReap(
      fakeProc,
      () => true,
      () => {
        ephemeralSurvivorsAtRelease = Object.entries(procTable).filter(
          ([, v]) =>
            v.environ.includes('OPENCLAUDE_TURN_REAP_TAG=turn-clean-0') &&
            !v.environ.includes('OPENCLAUDE_LIFECYCLE_CLASS=managed_job'),
        ).length
        timeline.push('slot_released')
      },
      {
        naturalExitGraceMs: 0,
        termGraceMs: 30,
        killGraceMs: 30,
        snapshot: null,
        treeOpts: {
          platform: 'linux',
          selfPid: 500,
          selfPpid: 1,
          selfPgid: 500,
          turnReapTag: 'turn-clean-0',
          readProcDir: () => {
            scanCount += 1
            return Object.keys(procTable)
          },
          readProcStat: (pid) => procTable[pid]?.stat ?? null,
          readProcCmdline: (pid) => procTable[pid]?.cmdline ?? null,
          readProcEnviron: (pid) => procTable[pid]?.environ ?? null,
          kill: (target, sig) => {
            const pgid = Math.abs(target)
            if (sig === 0) {
              const hasMember = Object.keys(procTable).some((k) => Number(k) === pgid)
              if (!hasMember) {
                throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
              }
              return true
            }
            timeline.push(`signal:${target}:${String(sig)}`)
            // Point 3: On SIGTERM to -9400, 9400 exits cleanly during termGraceMs BUT forks a new
            // detached orphan group 9450 carrying turn-clean-0 that ignores SIGTERM until SIGKILL!
            if (sig === 'SIGTERM' && pgid === 9400) {
              Reflect.deleteProperty(procTable, 9400)
              procTable[9450] = {
                stat: statLine(9450, 'python3', 1, 9450, 2150),
                cmdline: 'python3\0late_fork.py',
                environ: 'OPENCLAUDE_TURN_REAP_TAG=turn-clean-0\0',
              }
            }
            if (sig === 'SIGKILL' && pgid === 9450) {
              Reflect.deleteProperty(procTable, 9450)
            }
            return true
          },
        },
      },
    )

    assert.equal(reapedClean, true, 'bounded reap must return true when all turn-tagged orphans are reaped')
    assert.ok(scanCount >= 2, 'must re-scan /proc after SIGTERM wait to catch newly forked turn-tagged orphan 9450')
    assert.equal(ephemeralSurvivorsAtRelease, 0, 'zero turn-clean-0 ephemeral orphans may remain when slot releases')
    assert.deepEqual(
      timeline,
      ['signal:-9400:SIGTERM', 'signal:-9450:SIGTERM', 'signal:-9450:SIGKILL', 'slot_released'],
      'both initial orphan -9400 and SIGTERM-forked orphan -9450 must be reaped BEFORE slot_released',
    )
    assert.ok(procTable[9500], 'survivable managed_job must remain alive')

    // Unkillable survivor must return false, invoke onTimeout, AND keep holding the FIFO swarm slot
    // (blocking queued turn from starting early) until background drain confirms 9499 exited!
    setLocalSwarmConcurrencyLimitForTests(1)
    try {
      const slot1 = acquireLocalAntigravitySwarmSlot()
      assert.equal(slot1.waited, false)
      const release1 = await slot1.promise
      const slot2 = acquireLocalAntigravitySwarmSlot()
      assert.equal(slot2.waited, true)
      let slot2Granted = false
      const slot2Done = slot2.promise.then((rel) => {
        slot2Granted = true
        return rel
      })

      procTable[9499] = {
        stat: statLine(9499, 'unkillable-d-state', 1, 9499, 2200),
        cmdline: 'dd',
        environ: 'OPENCLAUDE_TURN_REAP_TAG=turn-stuck\0',
      }
      let backgroundSigkillCount = 0
      let failStat9499 = false
      let transientNullObserved = false
      let timedOutCount = 0
      const stuckOutcome = await releaseSwarmSlotAfterBoundedReap(fakeProc, () => true, release1, {
        naturalExitGraceMs: 0,
        termGraceMs: 20,
        killGraceMs: 20,
        backgroundRetryIntervalMs: 20,
        passivePollIntervalMs: 20,
        maxBackgroundAttempts: 1,
        onTimeout: () => {
          timedOutCount += 1
        },
        treeOpts: {
          platform: 'linux',
          selfPid: 500,
          selfPpid: 1,
          selfPgid: 500,
          turnReapTag: 'turn-stuck',
          readProcDir: () => Object.keys(procTable),
          readProcStat: (pid) => {
            if (pid === 9499 && failStat9499) {
              transientNullObserved = true
              return null
            }
            return procTable[pid]?.stat ?? null
          },
          readProcCmdline: (pid) => procTable[pid]?.cmdline ?? null,
          readProcEnviron: (pid) => procTable[pid]?.environ ?? null,
          kill: (target, sig) => {
            const pgid = Math.abs(target)
            if (sig === 0 && !procTable[pgid]) {
              throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
            }
            if (sig === 'SIGKILL' && pgid === 9499 && timedOutCount > 0) {
              backgroundSigkillCount += 1
            }
            return true
          },
        },
      })
      assert.equal(stuckOutcome, false, 'unkillable survivor must return false on bounded reap timeout')
      assert.equal(timedOutCount, 1, 'onTimeout callback must fire exactly once')
      assert.equal(slot2Granted, false, 'queued swarm turn MUST NOT be granted slot while residual process 9499 is still alive')
      assert.equal(getLocalSwarmConcurrencyStateForTests().active, 1)

      // Wait until the single background SIGKILL budget (maxBackgroundAttempts=1) is exhausted while 9499 stays alive,
      // then inject a transient stat read failure (readProcStat(9499) -> null while 9499 remains in procTable) and
      // verify the FIFO slot stays held and NO unverified SIGKILL is sent!
      const keepLoopAlive = setInterval(() => {}, 20)
      try {
        await waitUntil(() => backgroundSigkillCount >= 1, 1_000)
        assert.equal(slot2Granted, false, 'slot must remain held even after maxBackgroundAttempts=1 SIGKILL budget is exhausted')

        failStat9499 = true
        await waitUntil(() => transientNullObserved, 1_000)
        await new Promise((r) => setTimeout(r, 35))
        assert.equal(slot2Granted, false, 'transient readProcStat(9499)===null while 9499 is still in /proc MUST NOT release slot')
        assert.equal(getLocalSwarmConcurrencyStateForTests().active, 1)
        failStat9499 = false

        // Now 9499 finally exits cleanly; passive drain check confirms exit and releases slot1 exactly once!
        Reflect.deleteProperty(procTable, 9499)
        const release2 = await slot2Done
        assert.equal(slot2Granted, true, 'passive drain monitor must release slot once 9499 exits after maxBackgroundAttempts')
        assert.equal(backgroundSigkillCount, 1, 'must stop sending SIGKILL after maxBackgroundAttempts=1')
        release2()
      } finally {
        clearInterval(keepLoopAlive)
      }
      assert.equal(getLocalSwarmConcurrencyStateForTests().active, 0)

      // Initial directory-enumeration failure (readProcDir throwing EMFILE / returning []) on a clean root exit
      // where snapshot started null and an unregistered turn-tagged orphan (9488) is alive:
      // MUST NOT treat descendantPgids=[] as drained or release the FIFO slot prematurely!
      const enumSlot1 = acquireLocalAntigravitySwarmSlot()
      assert.equal(enumSlot1.waited, false)
      const enumRelease1 = await enumSlot1.promise
      let enumReleaseCount = 0
      const trackedEnumRelease1 = () => {
        enumReleaseCount += 1
        enumRelease1()
      }
      const enumSlot2 = acquireLocalAntigravitySwarmSlot()
      assert.equal(enumSlot2.waited, true)
      let enumSlot2Granted = false
      const enumSlot2Done = enumSlot2.promise.then((rel) => {
        enumSlot2Granted = true
        return rel
      })

      procTable[9488] = {
        stat: statLine(9488, 'orphan-behind-emfile', 1, 9488, 2300),
        cmdline: 'python3 worker.py',
        environ: 'OPENCLAUDE_TURN_REAP_TAG=turn-enum-fail\0',
      }
      let enumMode: 'throw' | 'empty' | 'ok' = 'throw'
      let emptyDirObserved = false
      let orphanDiscovered9488 = false
      const enumOutcome = await releaseSwarmSlotAfterBoundedReap(fakeProc, () => true, trackedEnumRelease1, {
        naturalExitGraceMs: 0,
        termGraceMs: 20,
        killGraceMs: 20,
        backgroundRetryIntervalMs: 20,
        passivePollIntervalMs: 20,
        maxBackgroundAttempts: 3,
        snapshot: null,
        treeOpts: {
          platform: 'linux',
          selfPid: 500,
          selfPpid: 1,
          selfPgid: 500,
          turnReapTag: 'turn-enum-fail',
          readProcDir: () => {
            if (enumMode === 'throw') throw Object.assign(new Error('EMFILE'), { code: 'EMFILE' })
            if (enumMode === 'empty') {
              emptyDirObserved = true
              return []
            }
            return Object.keys(procTable)
          },
          readProcStat: (pid) => procTable[pid]?.stat ?? null,
          readProcCmdline: (pid) => procTable[pid]?.cmdline ?? null,
          readProcEnviron: (pid) => procTable[pid]?.environ ?? null,
          kill: (target, sig) => {
            const pgid = Math.abs(target)
            if (sig === 0 && !procTable[pgid]) {
              throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
            }
            if (pgid === 9488 && sig === 'SIGKILL') {
              orphanDiscovered9488 = true
            }
            return true
          },
        },
      })
      assert.equal(enumOutcome, false, 'directory enumeration failure MUST mark scanIncomplete and defer slot release')
      assert.equal(enumReleaseCount, 0, 'release() MUST NOT fire while initial /proc enumeration failed')
      assert.equal(enumSlot2Granted, false, 'FIFO slot2 MUST stay blocked during initial EMFILE enumeration failure')

      const keepEnumLoopAlive = setInterval(() => {}, 20)
      try {
        enumMode = 'empty'
        await waitUntil(() => emptyDirObserved, 1_000)
        await new Promise((r) => setTimeout(r, 35))
        assert.equal(enumReleaseCount, 0, 'empty readProcDir() result MUST also preserve scanIncomplete and hold slot')
        assert.equal(enumSlot2Granted, false)

        // Recover /proc directory enumeration while 9488 is still alive: discovers 9488 and still holds slot until 9488 exits!
        enumMode = 'ok'
        await waitUntil(() => orphanDiscovered9488, 1_000)
        assert.equal(enumSlot2Granted, false, 'slot MUST remain held after /proc recovers while newly discovered 9488 is alive')

        Reflect.deleteProperty(procTable, 9488)
        const enumRelease2 = await enumSlot2Done
        assert.equal(enumSlot2Granted, true, 'FIFO slot2 grants once 9488 exits after /proc recovery')
        assert.equal(enumReleaseCount, 1, 'release() MUST fire exactly once')
        enumRelease2()
      } finally {
        clearInterval(keepEnumLoopAlive)
      }
      assert.equal(getLocalSwarmConcurrencyStateForTests().active, 0)
    } finally {
      setLocalSwarmConcurrencyLimitForTests(null)
    }
  })

  test('Steward R1-B4: direct and planner transcript events share turn-wide call-ID reduction across planner boundaries', async () => {
    const brainDir = await mkdtemp(path.join(tmpdir(), 'oc-r1-b4-direct-'))
    try {
      const convId = '55555555-6666-4777-8888-999999999999'
      const workerId = 'dddddddd-eeee-4fff-8000-222222222222'
      const swarmDir = path.join(brainDir, convId, '.system_generated', 'swarm')
      const coordLogs = path.join(brainDir, convId, '.system_generated', 'logs')
      const workerLogs = path.join(brainDir, workerId, '.system_generated', 'logs')
      await mkdir(swarmDir, { recursive: true })
      await mkdir(coordLogs, { recursive: true })
      await mkdir(workerLogs, { recursive: true })
      await writeFile(
        path.join(swarmDir, 'members.json'),
        JSON.stringify({
          title: 'B4 Direct Transcript Swarm',
          members: {
            coordinator: { conversation_id: convId, role: 'coordinator', phase: 'RUNNING', wake_mode: 'mentions', last_read_seq: 1, killed: false },
            'worker-a': { conversation_id: workerId, role: 'worker', phase: 'RUNNING', wake_mode: 'mentions', last_read_seq: 1, killed: false },
          },
        }),
      )
      await writeFile(
        path.join(swarmDir, 'board.jsonl'),
        `${JSON.stringify({ seq: 1, agent: 'coordinator', channel: 'main', text: '@worker-a inspect file' })}\n`,
      )
      await writeFile(
        path.join(coordLogs, 'transcript.jsonl'),
        `${JSON.stringify({ step_index: 0, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'swarm_wait', args: { since: 1 } }] })}\n`,
      )

      // (1) Completed call: Read ACTIVE (call-1) -> Read DONE (call-1) -> swarm_wait ACTIVE (call-2)
      const completedDirect = `${[
        JSON.stringify({ step_index: 0, type: 'TOOL_CALL', tool_call_id: 'call-1', tool_name: 'Read', status: 'ACTIVE', args: { Path: '/a.ts' } }),
        JSON.stringify({ step_index: 1, type: 'TOOL_RESULT', tool_call_id: 'call-1', tool_name: 'Read', status: 'DONE', content: 'ok' }),
        JSON.stringify({ step_index: 2, type: 'TOOL_CALL', tool_call_id: 'call-2', tool_name: 'swarm_wait', status: 'ACTIVE', args: { since: 1 } }),
      ].join('\n')}\n`
      await writeFile(path.join(workerLogs, 'transcript.jsonl'), completedDirect)
      const snapCompleted = readAntigravitySwarmSnapshot({
        brainDir,
        conversationId: convId,
        phase: 'running',
        revision: 1,
        now: 1_000,
      })
      assert.ok(snapCompleted)
      const wCompleted = snapCompleted.members.find((m) => m.name === 'worker-a')
      assert.equal(wCompleted?.status, 'waiting', 'completed Read ACTIVE -> DONE followed by swarm_wait must mark worker waiting')
      assert.equal(wCompleted?.waitingOnBoard, true)
      const exhCompleted: SwarmStallExhaustion[] = []
      const monCompleted = new SwarmStallMonitor({ onStallExhausted: (e) => exhCompleted.push(e) })
      assert.equal(monCompleted.evaluate(snapCompleted, 0), null)
      assert.ok(monCompleted.evaluate(snapCompleted, 180_000))
      assert.ok(monCompleted.evaluate(snapCompleted, 720_000))
      assert.ok(monCompleted.evaluate(snapCompleted, 1_260_000))
      assert.equal(monCompleted.evaluate(snapCompleted, 1_800_000), null)
      assert.equal(exhCompleted.length, 1, 'all-parked swarm after Read DONE must fire stall_exhausted')

      // (2) Point 4: Cross-planner ID completion: Read(call-1) ACTIVE -> PLANNER_RESPONSE [swarm_wait] -> Read(call-1) DONE
      const crossPlannerCompleted = `${[
        JSON.stringify({ step_index: 0, type: 'TOOL_CALL', tool_call_id: 'call-1', tool_name: 'Read', status: 'ACTIVE', args: { Path: '/cross.ts' } }),
        JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'swarm_wait', args: { since: 1 } }] }),
        JSON.stringify({ step_index: 2, type: 'TOOL_RESULT', tool_call_id: 'call-1', tool_name: 'Read', status: 'DONE', content: 'ok' }),
      ].join('\n')}\n`
      const parsedCrossDone = parseMemberTranscriptTail(crossPlannerCompleted)
      assert.equal(parsedCrossDone.status, 'waiting', 'Read(call-1) DONE after PLANNER_RESPONSE must retire call-1 across planner boundary')
      assert.equal(parsedCrossDone.waitingOnBoard, true)

      // (3) Duplicate terminal across planner while sibling call-2 from before planner is still running:
      const crossPlannerSiblingRunning = `${[
        JSON.stringify({ step_index: 0, type: 'TOOL_CALL', tool_call_id: 'call-1', tool_name: 'Read', status: 'ACTIVE', args: { Path: '/a.ts' } }),
        JSON.stringify({ step_index: 1, type: 'TOOL_CALL', tool_call_id: 'call-2', tool_name: 'Read', status: 'ACTIVE', args: { Path: '/b.ts' } }),
        JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'swarm_wait', args: { since: 1 } }] }),
        JSON.stringify({ step_index: 3, type: 'TOOL_RESULT', tool_call_id: 'call-1', tool_name: 'Read', status: 'DONE', content: 'a' }),
        JSON.stringify({ step_index: 4, type: 'TOOL_RESULT', tool_call_id: 'call-1', tool_name: 'Read', status: 'DONE', content: 'a dup' }),
      ].join('\n')}\n`
      await writeFile(path.join(workerLogs, 'transcript.jsonl'), crossPlannerSiblingRunning)
      const snapSibling = readAntigravitySwarmSnapshot({
        brainDir,
        conversationId: convId,
        phase: 'running',
        revision: 2,
        now: 1_000,
      })
      assert.ok(snapSibling)
      const wSibling = snapSibling.members.find((m) => m.name === 'worker-a')
      assert.equal(wSibling?.status, 'working', 'sibling Read call-2 across planner boundary is still running despite duplicate DONE on call-1')
      assert.equal(wSibling?.waitingOnBoard, false)

      // (4) Unmatchable parallel un-ID'd direct Read calls: preserve active status
      const unIdParallel = `${[
        JSON.stringify({ step_index: 0, type: 'TOOL_CALL', tool_name: 'Read', status: 'ACTIVE', args: { Path: '/1.ts' } }),
        JSON.stringify({ step_index: 1, type: 'TOOL_CALL', tool_name: 'Read', status: 'ACTIVE', args: { Path: '/2.ts' } }),
        JSON.stringify({ step_index: 2, type: 'TOOL_RESULT', tool_name: 'Read', status: 'DONE', content: 'one done' }),
        JSON.stringify({ step_index: 3, type: 'TOOL_CALL', tool_name: 'swarm_wait', status: 'ACTIVE', args: { since: 1 } }),
      ].join('\n')}\n`
      const parsedUnId = parseMemberTranscriptTail(unIdParallel)
      assert.equal(parsedUnId.status, 'working', 'unmatchable parallel un-ID direct calls must remain working')
      assert.equal(parsedUnId.waitingOnBoard, false)

      // (5) Earlier PLANNER_RESPONSE with ID'd call (no direct ACTIVE step):
      // remains working across subsequent PLANNER_RESPONSE [swarm_wait] until matching ID DONE arrives!
      const plannerOnlyStartStillRunning = `${[
        JSON.stringify({ step_index: 0, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ id: 'call-plan-1', name: 'run_command', args: { CommandLine: 'npm test' } }] }),
        JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'swarm_wait', args: { since: 1 } }] }),
      ].join('\n')}\n`
      const parsedPlanRunning = parseMemberTranscriptTail(plannerOnlyStartStillRunning)
      assert.equal(parsedPlanRunning.status, 'working', 'ID-keyed earlier planner call without DONE must remain working across later planner')
      assert.equal(parsedPlanRunning.waitingOnBoard, false)

      const plannerOnlyStartThenDone = `${[
        JSON.stringify({ step_index: 0, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ id: 'call-plan-1', name: 'run_command', args: { CommandLine: 'npm test' } }] }),
        JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'swarm_wait', args: { since: 1 } }] }),
        JSON.stringify({ step_index: 2, type: 'TOOL_RESULT', tool_call_id: 'call-plan-1', tool_name: 'run_command', status: 'DONE', content: '0' }),
      ].join('\n')}\n`
      const parsedPlanDone = parseMemberTranscriptTail(plannerOnlyStartThenDone)
      assert.equal(parsedPlanDone.status, 'waiting', 'once call-plan-1 DONE arrives, member parks on swarm_wait')
      assert.equal(parsedPlanDone.waitingOnBoard, true)

      // (6) Planner Read(id='a') + un-ID'd Read ACTIVE + DONE(id='a') MUST NOT resurrect when
      // a subsequent PLANNER_RESPONSE [swarm_wait] is appended!
      const mixedIdPlannerUnIdDirectDone = `${[
        JSON.stringify({ step_index: 0, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ id: 'a', name: 'Read', args: { Path: '/m.ts' } }] }),
        JSON.stringify({ step_index: 1, type: 'TOOL_CALL', tool_name: 'Read', status: 'ACTIVE', args: { Path: '/m.ts' } }),
        JSON.stringify({ step_index: 2, type: 'TOOL_RESULT', tool_call_id: 'a', tool_name: 'Read', status: 'DONE', content: 'ok' }),
        JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'swarm_wait', args: { since: 1 } }] }),
      ].join('\n')}\n`
      const parsedNoResurrect = parseMemberTranscriptTail(mixedIdPlannerUnIdDirectDone)
      assert.equal(parsedNoResurrect.status, 'waiting', 'completed planner(id=a) + un-ID ACTIVE + DONE(a) must NOT resurrect after next planner')
      assert.equal(parsedNoResurrect.waitingOnBoard, true)

      // (7) Same-batch parallel Read(id='a', /A.ts) + Read(no-ID, /B.ts), followed by un-ID Read ACTIVE(/B.ts)
      // and DONE(id='a'): /B.ts MUST stay working BOTH before AND after appending PLANNER_RESPONSE [swarm_wait]!
      const dualReadBeforeNextPlanner = [
        JSON.stringify({
          step_index: 0,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          tool_calls: [
            { id: 'a', name: 'Read', args: { Path: '/A.ts' } },
            { name: 'Read', args: { Path: '/B.ts' } },
          ],
        }),
        JSON.stringify({ step_index: 1, type: 'TOOL_CALL', tool_name: 'Read', status: 'ACTIVE', args: { Path: '/B.ts' } }),
        JSON.stringify({ step_index: 2, type: 'TOOL_RESULT', tool_call_id: 'a', tool_name: 'Read', status: 'DONE', content: 'A done' }),
      ]
      const parsedBeforePlanner = parseMemberTranscriptTail(`${dualReadBeforeNextPlanner.join('\n')}\n`)
      assert.equal(parsedBeforePlanner.status, 'working', 'unfinished parallel Read(/B.ts) must be working before next planner')
      assert.equal(parsedBeforePlanner.waitingOnBoard, false)

      const parsedAfterPlanner = parseMemberTranscriptTail(
        `${[
          ...dualReadBeforeNextPlanner,
          JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'swarm_wait', args: { since: 1 } }] }),
        ].join('\n')}\n`,
      )
      assert.equal(parsedAfterPlanner.status, 'working', 'unfinished parallel Read(/B.ts) MUST remain working after swarm_wait planner is appended')
      assert.equal(parsedAfterPlanner.waitingOnBoard, false)

      // (8) Mixed [run_command (no ID), swarm_wait (with call ID)] + 1 anonymous GENERIC DONE:
      // 3-step verification:
      //   1. anonymous GENERIC DONE -> stays working
      //   2. swarm_wait's own TOOL_RESULT DONE arrives -> STILL working (must NOT re-credit anonymous DONE to run_command!)
      //   3. run_command's attributable TOOL_RESULT DONE arrives -> transitions to waiting
      const idSwarmWaitGenericBase = [
        JSON.stringify({
          step_index: 0,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          tool_calls: [
            { name: 'run_command', args: { CommandLine: 'python3 build.py' } },
            { id: 'sw-call-1', name: 'swarm_wait', args: { since: 1 } },
          ],
        }),
        JSON.stringify({ step_index: 1, type: 'GENERIC', status: 'DONE', content: 'Waiting...' }),
      ]
      const parsedIdSwarmWaitRunning = parseMemberTranscriptTail(`${idSwarmWaitGenericBase.join('\n')}\n`)
      assert.equal(parsedIdSwarmWaitRunning.status, 'working', 'swarm_wait with call ID + 1 anonymous GENERIC DONE must NOT retire run_command')
      assert.equal(parsedIdSwarmWaitRunning.waitingOnBoard, false)

      const idSwarmWaitPlusSwDone = [
        ...idSwarmWaitGenericBase,
        JSON.stringify({ step_index: 2, type: 'TOOL_RESULT', tool_call_id: 'sw-call-1', tool_name: 'swarm_wait', status: 'DONE', content: 'Waiting...' }),
      ]
      const parsedIdSwarmWaitAfterSwDone = parseMemberTranscriptTail(`${idSwarmWaitPlusSwDone.join('\n')}\n`)
      assert.equal(
        parsedIdSwarmWaitAfterSwDone.status,
        'working',
        'swarm_wait TOOL_RESULT DONE after anonymous GENERIC DONE must NOT re-credit anonymous DONE to run_command',
      )
      assert.equal(parsedIdSwarmWaitAfterSwDone.waitingOnBoard, false)

      const parsedIdSwarmWaitAfterCmdDone = parseMemberTranscriptTail(
        `${[
          ...idSwarmWaitPlusSwDone,
          JSON.stringify({ step_index: 3, type: 'TOOL_RESULT', tool_name: 'run_command', status: 'DONE', content: '0' }),
        ].join('\n')}\n`,
      )
      assert.equal(parsedIdSwarmWaitAfterCmdDone.status, 'waiting', 'attributable run_command DONE allows member to park on swarm_wait')
      assert.equal(parsedIdSwarmWaitAfterCmdDone.waitingOnBoard, true)

      // (9) Mixed [run_command (no ID), swarm_wait (no ID)] + direct TOOL_CALL ACTIVE(swarm_wait) + 1 anonymous GENERIC DONE:
      // 3-step verification:
      //   1. anonymous GENERIC DONE -> stays working
      //   2. swarm_wait's own TOOL_RESULT DONE arrives -> STILL working
      //   3. run_command's attributable TOOL_RESULT DONE arrives -> transitions to waiting
      const activeSwarmWaitGenericBase = [
        JSON.stringify({
          step_index: 0,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          tool_calls: [
            { name: 'run_command', args: { CommandLine: 'python3 build.py' } },
            { name: 'swarm_wait', args: { since: 1 } },
          ],
        }),
        JSON.stringify({ step_index: 1, type: 'TOOL_CALL', tool_name: 'swarm_wait', status: 'ACTIVE', args: { since: 1 } }),
        JSON.stringify({ step_index: 2, type: 'GENERIC', status: 'DONE', content: 'Waiting...' }),
      ]
      const parsedActiveSwarmWaitRunning = parseMemberTranscriptTail(`${activeSwarmWaitGenericBase.join('\n')}\n`)
      assert.equal(parsedActiveSwarmWaitRunning.status, 'working', 'direct ACTIVE on swarm_wait + 1 anonymous GENERIC DONE must NOT retire run_command')
      assert.equal(parsedActiveSwarmWaitRunning.waitingOnBoard, false)

      const activeSwarmWaitPlusSwDone = [
        ...activeSwarmWaitGenericBase,
        JSON.stringify({ step_index: 3, type: 'TOOL_RESULT', tool_name: 'swarm_wait', status: 'DONE', content: 'Waiting...' }),
      ]
      const parsedActiveSwarmWaitAfterSwDone = parseMemberTranscriptTail(`${activeSwarmWaitPlusSwDone.join('\n')}\n`)
      assert.equal(
        parsedActiveSwarmWaitAfterSwDone.status,
        'working',
        'swarm_wait TOOL_RESULT DONE after anonymous GENERIC DONE must keep activeSwarmWait variant working',
      )
      assert.equal(parsedActiveSwarmWaitAfterSwDone.waitingOnBoard, false)

      const parsedActiveSwarmWaitAfterCmdDone = parseMemberTranscriptTail(
        `${[
          ...activeSwarmWaitPlusSwDone,
          JSON.stringify({ step_index: 4, type: 'TOOL_RESULT', tool_name: 'run_command', status: 'DONE', content: '0' }),
        ].join('\n')}\n`,
      )
      assert.equal(parsedActiveSwarmWaitAfterCmdDone.status, 'waiting', 'attributable run_command DONE transitions activeSwarmWait variant to waiting')
      assert.equal(parsedActiveSwarmWaitAfterCmdDone.waitingOnBoard, true)
    } finally {
      await rm(brainDir, { recursive: true, force: true })
    }
  })
})
