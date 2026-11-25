/**
 * OCV5-887 Gateway Swarm Fixes:
 *   1. Per-container local Antigravity swarm FIFO concurrency gate (prevents 3+ concurrent swarms OOMing 4GB container).
 *   2. Lingering background CLI process-group reaper before turn finish.
 *   3. Fail-closed git worktree + `swarm/*` branch cleanup for killed native swarm workers.
 *   4. AntigravityAdapter durable `billing` event (`engine: 'antigravity'`, `turnKey`) + worker token delta aggregation.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { OpenClaudeConfig } from '@openclaude/storage'

import { AntigravityAdapter } from '../engine/antigravityAdapter.js'
import { renewAntigravityRouteLeaseDetailed } from '../delegateAntigravityRoute.js'
import {
  acquireLocalAntigravitySwarmSlot,
  awaitLocalAntigravitySwarmSlotIfActive,
  buildAntigravityDurableBillingEvent,
  cleanupKilledNativeSwarmWorktrees,
  getLocalSwarmConcurrencyStateForTests,
  reapLingeringCliProcessGroup,
  releaseSwarmSlotAfterBoundedReap,
  setLocalSwarmConcurrencyLimitForTests,
} from '../engine/antigravitySwarmConcurrency.js'
import {
  readBoundedFileWithinRoot,
  readBoundedFileWithinRootAsync,
} from '../engine/antigravitySwarmTelemetry.js'
import type { EngineCreateOpts } from '../engine/registry.js'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'antigravity')

describe('OCV5-887 local Antigravity swarm concurrency gate', () => {
  test('caps concurrent local swarms at 2, queues 3rd FIFO with queue status callback, cancels cleanly, and bypasses non-swarm turns', async () => {
    setLocalSwarmConcurrencyLimitForTests(2)
    const releases: Array<() => void> = []
    try {
      let plainRelease: (() => void) | null = null
      await awaitLocalAntigravitySwarmSlotIfActive({
        compactionMode: undefined,
        keepaliveMs: 1_000,
        onStatus: () => {},
        onHeartbeat: () => {},
        setRelease: (fn) => { plainRelease = fn },
      })
      assert.equal(plainRelease, null)
      assert.deepEqual(getLocalSwarmConcurrencyStateForTests(), { active: 0, queued: 0, limit: 2 })

      const s1 = acquireLocalAntigravitySwarmSlot()
      const s2 = acquireLocalAntigravitySwarmSlot()
      assert.equal(s1.waited, false)
      assert.equal(s2.waited, false)
      const rel1 = await s1.promise
      const rel2 = await s2.promise
      releases.push(rel1, rel2)
      assert.deepEqual(getLocalSwarmConcurrencyStateForTests(), { active: 2, queued: 0, limit: 2 })

      const statusMessages: string[] = []
      const rel3Box: { fn: (() => void) | null } = { fn: null }
      let s3Done = false
      const p3 = awaitLocalAntigravitySwarmSlotIfActive({
        compactionMode: 'on_full',
        keepaliveMs: 500,
        onStatus: (msg) => statusMessages.push(msg),
        onHeartbeat: () => {},
        setRelease: (fn) => { rel3Box.fn = fn },
      }).then(() => {
        s3Done = true
      })

      // 4th queued turn cancels while waiting -> rejects cleanly without leaking slot
      const s4 = acquireLocalAntigravitySwarmSlot()
      assert.equal(s4.waited, true)
      await new Promise((r) => setTimeout(r, 15))
      assert.equal(statusMessages.length, 1)
      assert.ok(statusMessages[0]!.includes('排队 #1'))
      assert.equal(s3Done, false)
      assert.deepEqual(getLocalSwarmConcurrencyStateForTests(), { active: 2, queued: 2, limit: 2 })

      s4.cancel()
      await assert.rejects(() => s4.promise, /ANTIGRAVITY_SWARM_SLOT_CANCELLED/)
      assert.deepEqual(getLocalSwarmConcurrencyStateForTests(), { active: 2, queued: 1, limit: 2 })

      // Releasing s1 unblocks s3 immediately
      rel1()
      await p3
      assert.equal(s3Done, true)
      assert.ok(rel3Box.fn)
      releases.push(rel3Box.fn)
      assert.deepEqual(getLocalSwarmConcurrencyStateForTests(), { active: 2, queued: 0, limit: 2 })

      rel2()
      rel3Box.fn()
      rel3Box.fn() // idempotent double release
      assert.deepEqual(getLocalSwarmConcurrencyStateForTests(), { active: 0, queued: 0, limit: 2 })
    } finally {
      for (const r of releases) {
        try { r() } catch { /* ignore */ }
      }
      setLocalSwarmConcurrencyLimitForTests(null)
    }
  })
})

describe('OCV5-887 lingering process-group reaper & native worktree cleanup', () => {
  test('reapLingeringCliProcessGroup terminates lingering process group members before turn settle', async () => {
    let closed = false
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.once('close', () => { closed = true })
    assert.ok(child.pid)
    const pid = child.pid
    await reapLingeringCliProcessGroup(child, () => closed, { termGraceMs: 80, killGraceMs: 80 })
    let alive = true
    try {
      process.kill(pid, 0)
    } catch {
      alive = false
    }
    assert.equal(alive, false, 'process group leader must be reaped')
  })

  test('cleanupKilledNativeSwarmWorktrees removes clean killed worktree + branch while preserving dirty, unmerged, and live workers', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'oc-native-wt-clean-'))
    try {
      const repo = path.join(tmp, 'repo')
      const brainDir = path.join(tmp, 'brain')
      const convId = '11111111-2222-4333-8444-555555555555'
      await mkdir(repo, { recursive: true })
      execFileSync('git', ['-C', repo, 'init', '-b', 'main'])
      execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@openclaude.local'])
      execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test'])
      await writeFile(path.join(repo, 'README.md'), 'init\n')
      execFileSync('git', ['-C', repo, 'add', '.'])
      execFileSync('git', ['-C', repo, 'commit', '-m', 'init'])

      const wtRoot = path.join(tmp, 'worktrees')
      await mkdir(wtRoot, { recursive: true })
      const cleanWt = path.join(wtRoot, 'w-clean')
      const dirtyWt = path.join(wtRoot, 'w-dirty')
      const unmergedWt = path.join(wtRoot, 'w-unmerged')
      const liveWt = path.join(wtRoot, 'w-live')
      const otherSwarmWt = path.join(wtRoot, 'w-other-swarm')

      execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', 'swarm/11111111/w-clean', cleanWt, 'HEAD'])
      execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', 'swarm/11111111/w-dirty', dirtyWt, 'HEAD'])
      execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', 'swarm/11111111/w-unmerged', unmergedWt, 'HEAD'])
      execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', 'swarm/11111111/w-live', liveWt, 'HEAD'])
      // B7 R2: Another active swarm (`99999999`) reusing a path in the SAME repo must NOT be removed!
      execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', 'swarm/99999999/w-clean', otherSwarmWt, 'HEAD'])

      await writeFile(path.join(dirtyWt, 'dirty.txt'), 'uncommitted\n')
      await writeFile(path.join(unmergedWt, 'feature.txt'), 'unmerged work\n')
      execFileSync('git', ['-C', unmergedWt, 'add', '.'])
      execFileSync('git', ['-C', unmergedWt, 'commit', '-m', 'unmerged commit'])

      const swarmDir = path.join(brainDir, convId, '.system_generated', 'swarm')
      await mkdir(swarmDir, { recursive: true })
      await writeFile(
        path.join(swarmDir, 'members.json'),
        JSON.stringify({
          members: {
            coordinator: { role: 'coordinator', killed: false },
            'w-clean': { role: 'worker', killed: true, workspace: cleanWt, workspace_mode: 'branch' },
            'w-dirty': { role: 'worker', killed: true, workspace: dirtyWt, workspace_mode: 'branch' },
            'w-unmerged': { role: 'worker', killed: true, workspace: unmergedWt, workspace_mode: 'branch' },
            'w-live': { role: 'worker', killed: false, workspace: liveWt, workspace_mode: 'branch' },
            'w-reused': { role: 'worker', killed: true, workspace: otherSwarmWt, workspace_mode: 'branch' },
          },
        }),
      )

      const removed = cleanupKilledNativeSwarmWorktrees(brainDir, convId, repo)
      assert.deepEqual(removed, [cleanWt])
      assert.equal(existsSync(cleanWt), false, 'clean killed worktree owned by this conv/member must be removed')
      assert.equal(existsSync(dirtyWt), true, 'dirty worktree must be preserved')
      assert.equal(existsSync(unmergedWt), true, 'unmerged commit worktree must be preserved')
      assert.equal(existsSync(liveWt), true, 'live worker worktree must never be removed')
      assert.equal(existsSync(otherSwarmWt), true, 'B7: same-repo worktree owned by another swarm must be preserved')

      const branches = execFileSync('git', ['-C', repo, 'branch', '--list', 'swarm/*'], { encoding: 'utf8' })
      assert.ok(!branches.includes('swarm/11111111/w-clean'), 'merged branch of removed worktree must be deleted')
      assert.ok(branches.includes('swarm/11111111/w-unmerged'), 'unmerged branch must be preserved')
      assert.ok(branches.includes('swarm/11111111/w-live'), 'live branch must be preserved')
      assert.ok(branches.includes('swarm/99999999/w-clean'), 'other swarm branch must be preserved')

      // B7: Ordinary non-swarm checkout (e.g. feat/* outside .oc-swarm-worktrees) and foreign repo worktrees MUST NOT be removed!
      const userFeatureWt = path.join(wtRoot, 'user-feature-wt')
      execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', 'feat/user-work', userFeatureWt, 'HEAD'])
      const foreignRepo = path.join(tmp, 'foreign-repo')
      const foreignWt = path.join(tmp, 'foreign-wt')
      await mkdir(foreignRepo, { recursive: true })
      execFileSync('git', ['-C', foreignRepo, 'init', '-b', 'main'])
      execFileSync('git', ['-C', foreignRepo, 'config', 'user.email', 'test@openclaude.local'])
      execFileSync('git', ['-C', foreignRepo, 'config', 'user.name', 'Test'])
      await writeFile(path.join(foreignRepo, 'a.txt'), 'a\n')
      execFileSync('git', ['-C', foreignRepo, 'add', '.'])
      execFileSync('git', ['-C', foreignRepo, 'commit', '-m', 'init'])
      execFileSync('git', ['-C', foreignRepo, 'worktree', 'add', '-b', 'swarm/foreign/w1', foreignWt, 'HEAD'])

      await writeFile(
        path.join(swarmDir, 'members.json'),
        JSON.stringify({
          members: {
            coordinator: { role: 'coordinator', killed: false },
            'spoof-user-wt': { role: 'worker', killed: true, workspace: userFeatureWt, workspace_mode: 'branch' },
            'spoof-foreign-wt': { role: 'worker', killed: true, workspace: foreignWt, workspace_mode: 'branch' },
          },
        }),
      )
      const spoofRemoved = cleanupKilledNativeSwarmWorktrees(brainDir, convId, repo)
      assert.deepEqual(spoofRemoved, [])
      assert.equal(existsSync(userFeatureWt), true, 'non-swarm feature checkout must never be removed')
      assert.equal(existsSync(foreignWt), true, 'foreign repo worktree must never be removed')
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  test('B8 & N1: FIFO queue wait renews relay route lease and fails closed on expired route; >2MB final JSONL line with trailing newline recovers preceding step', async () => {
    setLocalSwarmConcurrencyLimitForTests(1)
    let rel1: (() => void) | null = null
    try {
      const s1 = acquireLocalAntigravitySwarmSlot()
      rel1 = await s1.promise

      let fakeClock = 0
      let renewCalls = 0
      let routeAlive = true
      let relWaiter: (() => void) | null = null
      const waiterDone = awaitLocalAntigravitySwarmSlotIfActive({
        compactionMode: 'on_full',
        keepaliveMs: 25,
        renewRouteIntervalMs: 50,
        now: () => fakeClock,
        onStatus: () => {},
        onHeartbeat: () => {},
        onRenewRoute: async () => {
          renewCalls += 1
          return routeAlive
        },
        setRelease: (fn) => {
          relWaiter = fn
        },
      })
      fakeClock = 60
      await new Promise((r) => setTimeout(r, 65))
      assert.ok(renewCalls >= 1, `queued swarm must renew route lease while waiting (renewCalls=${renewCalls})`)
      rel1()
      rel1 = null
      await waiterDone
      ;(relWaiter as (() => void) | null)?.()

      // Expired route while queued -> rejects with ANTIGRAVITY_ROUTE_EXPIRED_IN_QUEUE and releases slot!
      const hold = acquireLocalAntigravitySwarmSlot()
      const relHold = await hold.promise
      routeAlive = false
      const expiredWait = awaitLocalAntigravitySwarmSlotIfActive({
        compactionMode: 'on_resumed',
        keepaliveMs: 25,
        renewRouteIntervalMs: 50,
        onStatus: () => {},
        onHeartbeat: () => {},
        onRenewRoute: async () => false,
        setRelease: () => {},
      })
      relHold()
      await assert.rejects(() => expiredWait, /ANTIGRAVITY_ROUTE_EXPIRED_IN_QUEUE/)
      assert.deepEqual(getLocalSwarmConcurrencyStateForTests(), { active: 0, queued: 0, limit: 1 })
    } finally {
      rel1?.()
      setLocalSwarmConcurrencyLimitForTests(null)
    }

    // N1: >2.1MB final JSONL line WITH trailing newline still recovers preceding complete step
    const tmp = await mkdtemp(path.join(tmpdir(), 'oc-n1-oversized-'))
    try {
      const logDir = path.join(tmp, '11111111-2222-4333-8444-555555555555', '.system_generated', 'logs')
      await mkdir(logDir, { recursive: true })
      const step41 = JSON.stringify({ step_index: 41, type: 'PLANNER_RESPONSE', status: 'RUNNING', tool_calls: [{ name: 'run_command' }] })
      const step42Huge = JSON.stringify({ step_index: 42, type: 'GENERIC', status: 'DONE', output: 'Z'.repeat(2_150_000) })
      await writeFile(path.join(logDir, 'transcript.jsonl'), `${step41}\n${step42Huge}\n`)

      const syncTail = readBoundedFileWithinRoot(
        tmp,
        ['11111111-2222-4333-8444-555555555555', '.system_generated', 'logs', 'transcript.jsonl'],
        256 * 1024,
        { maxAdaptiveBytes: 2 * 1024 * 1024 },
      )
      const asyncTail = await readBoundedFileWithinRootAsync(
        tmp,
        ['11111111-2222-4333-8444-555555555555', '.system_generated', 'logs', 'transcript.jsonl'],
        256 * 1024,
        { maxAdaptiveBytes: 2 * 1024 * 1024 },
      )
      assert.ok(syncTail?.includes('"step_index":41'), `sync lookback must recover step 41, got len=${syncTail?.length}`)
      assert.ok(asyncTail?.includes('"step_index":41'), `async lookback must recover step 41, got len=${asyncTail?.length}`)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })
})

describe('OCV5-887 AntigravityAdapter durable billing event & worker usage folding', () => {
  test('emits durable billing event with engine=antigravity + 64-hex turnKey alongside external_billing and folds worker transcript tokens', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-agy-887-billing-'))
    const saved: Record<string, string | undefined> = {
      OC_ANTIGRAVITY_CLI_BIN: process.env.OC_ANTIGRAVITY_CLI_BIN,
      OPENCLAUDE_HOME: process.env.OPENCLAUDE_HOME,
    }
    try {
      const convId = '63f1f880-9ff7-459a-9585-a40781030fa3'
      const workerConv = '22222222-2222-4222-8222-222222222222'
      const openClaudeHome = path.join(dir, 'openclaude-home')
      const fakeCli = path.join(dir, 'fake-agy-swarm.cjs')
      const fixtureFile = path.join(FIXTURES, 'stream-text.ndjson')
      await writeFile(
        fakeCli,
        `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => {
  buf += c
  if (!buf.includes('\\n')) return
  const brain = path.join(process.env.HOME, '.gemini', 'antigravity-cli', 'brain')
  const swarmDir = path.join(brain, '${convId}', '.system_generated', 'swarm')
  const workerLogs = path.join(brain, '${workerConv}', '.system_generated', 'logs')
  fs.mkdirSync(swarmDir, { recursive: true })
  fs.mkdirSync(workerLogs, { recursive: true })
  fs.writeFileSync(path.join(swarmDir, 'members.json'), JSON.stringify({
    title: '计费聚合测试',
    members: {
      coordinator: { conversation_id: '${convId}', role: 'coordinator', killed: false },
      'worker-1': { conversation_id: '${workerConv}', role: 'worker', killed: false },
    },
  }))
  fs.writeFileSync(path.join(swarmDir, 'board.jsonl'), JSON.stringify({ seq: 1, agent: 'coordinator', channel: 'main', text: '[done] ok' }) + '\\n')
  fs.writeFileSync(path.join(workerLogs, 'transcript.jsonl'), JSON.stringify({
    step_index: 1,
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: new Date().toISOString(),
    usage: { input_tokens: 4000, output_tokens: 900, cache_read_input_tokens: 500 },
  }) + '\\n')
  for (const line of fs.readFileSync(${JSON.stringify(fixtureFile)}, 'utf8').split('\\n')) {
    if (line.trim()) process.stdout.write(line + '\\n')
  }
})
process.stdin.on('end', () => process.exit(0))
`,
      )
      await chmod(fakeCli, 0o755)
      process.env.OC_ANTIGRAVITY_CLI_BIN = fakeCli
      process.env.OPENCLAUDE_HOME = openClaudeHome

      const adapter = new AntigravityAdapter({
        sessionKey: 'agent:main:webchat:dm:agy-887-bill',
        agentId: 'main',
        agentBaseDir: dir,
        config: {
          version: 1,
          gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
          auth: { mode: 'subscription', claudeCodePath: '' },
          sessions: { dbPath: '' },
          defaults: { model: 'antigravity-gemini-3.8-flash' },
        } as unknown as OpenClaudeConfig,
        model: 'antigravity-gemini-3.8-flash',
        effortLevel: 'high',
      } as EngineCreateOpts)
      adapter.setAntigravityRoute({
        baseUrl: `http://127.0.0.1:18789/internal/v5/antigravity-relay/route/${'a'.repeat(64)}`,
        routeToken: 'a'.repeat(64),
        accessToken: 'ya29.stub',
        accessTokenExpiresAt: '2026-12-01T00:00:00Z',
      })

      const durableFrames: unknown[] = []
      const externalFrames: unknown[] = []
      adapter.on('billing', (f) => durableFrames.push(f))
      adapter.on('external_billing', (f) => externalFrames.push(f))

      const reqId = 'c'.repeat(32)
      const turnKey = 'd'.repeat(64)
      const run = adapter.submitTurn({
        input: '[OpenClaude Antigravity 蜂群模式已激活]\n测试',
        requestId: reqId,
        turnKey,
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      const detached = run.summary.then(() => run.end())
      await run.submitted
      const summary = await run.summary
      await detached
      await adapter.waitForOutputDrain()

      assert.equal(externalFrames.length, 1)
      assert.equal(durableFrames.length, 1)
      const df = durableFrames[0] as Record<string, unknown>
      assert.equal(df.engine, 'antigravity')
      assert.equal(df.requestId, reqId)
      assert.equal(df.turnKey, turnKey)
      assert.equal(df.status, 'success')
      assert.match(String(df.engineSessionId), /^oceng-[0-9a-f]{48}$/)

      assert.ok((summary?.usage?.inputTokens ?? 0) >= 4000)
      assert.ok((summary?.usage?.outputTokens ?? 0) >= 900)
      assert.ok((summary?.usage?.cacheReadTokens ?? 0) >= 500)

      const builtErr = buildAntigravityDurableBillingEvent({
        requestId: reqId,
        sessionKey: 'agent:main:webchat:dm:x',
        status: 'error',
        interrupted: true,
        budgetStop: false,
        durationMs: 10,
        usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 },
      })
      assert.equal(builtErr.terminalCode, 'USER_CANCELLED')
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) Reflect.deleteProperty(process.env, k)
        else process.env[k] = v
      }
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('OCV5-887 P1-08/P1-11/P2-03/P2-04: lingering pgrp reap + bounded slot release, strict conv brainDir worktree isolation, transient 503 vs revoked renewal, and AUTH/QUOTA billing codes', async () => {
    // 1. P1-08: Leader exits 0 (`isClosed() === true`) while a background grandchild remains in `-pid`;
    //    `reapLingeringCliProcessGroup` MUST still reap the process group, and `releaseSwarmSlotAfterBoundedReap`
    //    must wait for bounded reap before releasing the FIFO slot (never deadlocking on timeout).
    {
      let closed = false
      const leader = spawn(
        process.execPath,
        [
          '-e',
          `const { spawn } = require('node:child_process');
           const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
           g.unref();
           process.exit(0);`,
        ],
        { detached: true, stdio: ['pipe', 'pipe', 'pipe'] },
      )
      const pgid = leader.pid!
      await new Promise<void>((resolve) => {
        leader.once('close', () => {
          closed = true
          resolve()
        })
      })
      assert.equal(closed, true)
      await reapLingeringCliProcessGroup(leader, () => closed, {
        naturalExitGraceMs: 20,
        termGraceMs: 120,
        killGraceMs: 120,
        pollIntervalMs: 10,
      })
      let pgrpAlive = true
      try {
        process.kill(-pgid, 0)
      } catch {
        pgrpAlive = false
      }
      assert.equal(pgrpAlive, false, 'P1-08: grandchild remaining in exited leader pgrp must be reaped')

      // Bounded release when proc is still running: slot is released only AFTER bounded reap completes
      setLocalSwarmConcurrencyLimitForTests(1)
      let relHold: (() => void) | null = null
      try {
        const s = acquireLocalAntigravitySwarmSlot()
        relHold = await s.promise
        let stubClosed = false
        const stubborn = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        stubborn.once('close', () => { stubClosed = true })
        releaseSwarmSlotAfterBoundedReap(stubborn, () => stubClosed, relHold, {
          naturalExitGraceMs: 0,
          termGraceMs: 80,
          killGraceMs: 80,
        })
        relHold = null
        // Slot stays held synchronously until bounded reap finishes, then releases cleanly
        assert.equal(getLocalSwarmConcurrencyStateForTests().active, 1)
        const deadline = Date.now() + 1_000
        while (getLocalSwarmConcurrencyStateForTests().active > 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 15))
        }
        assert.equal(getLocalSwarmConcurrencyStateForTests().active, 0)
      } finally {
        relHold?.()
        setLocalSwarmConcurrencyLimitForTests(null)
      }
    }

    // 2. P1-11: Strict per-conversation brainDir isolation + detached HEAD guard + exact member boundary
    {
      const tmp = await mkdtemp(path.join(tmpdir(), 'oc-p1-11-wt-'))
      try {
        const repo = path.join(tmp, 'repo')
        const brainDir = path.join(tmp, 'brain')
        const convA = '11111111-2222-4333-8444-555555555555'
        const convB = '99999999-aaaa-4bbb-8ccc-dddddddddddd'
        await mkdir(repo, { recursive: true })
        execFileSync('git', ['-C', repo, 'init', '-b', 'main'])
        execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@openclaude.local'])
        execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test'])
        await writeFile(path.join(repo, 'README.md'), 'init\n')
        execFileSync('git', ['-C', repo, 'add', '.'])
        execFileSync('git', ['-C', repo, 'commit', '-m', 'init'])

        const ownBrainWt = path.join(brainDir, convA, 'worktrees', 'own-brain')
        const sameConvOtherMemberWt = path.join(brainDir, convA, 'worktrees', 'active-sibling')
        const siblingBrainWt = path.join(brainDir, convB, 'worktrees', 'w-1')
        const detachedOutsideWt = path.join(repo, '.oc-swarm-worktrees', '11111111-w-detached')
        const prefixCollideWt = path.join(tmp, 'wt-w10')
        await mkdir(path.dirname(ownBrainWt), { recursive: true })
        await mkdir(path.dirname(siblingBrainWt), { recursive: true })
        await mkdir(path.dirname(detachedOutsideWt), { recursive: true })

        execFileSync('git', ['-C', repo, 'worktree', 'add', '--detach', ownBrainWt, 'HEAD'])
        execFileSync('git', ['-C', repo, 'worktree', 'add', '--detach', sameConvOtherMemberWt, 'HEAD'])
        execFileSync('git', ['-C', repo, 'worktree', 'add', '--detach', siblingBrainWt, 'HEAD'])
        execFileSync('git', ['-C', repo, 'worktree', 'add', '--detach', detachedOutsideWt, 'HEAD'])
        execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', 'swarm/11111111/w-10', prefixCollideWt, 'HEAD'])

        const swarmDir = path.join(brainDir, convA, '.system_generated', 'swarm')
        await mkdir(swarmDir, { recursive: true })
        await writeFile(
          path.join(swarmDir, 'members.json'),
          JSON.stringify({
            members: {
              coordinator: { role: 'coordinator', killed: false },
              'own-brain': { role: 'worker', killed: true, workspace: ownBrainWt, workspace_mode: 'share' },
              'stale-member': { role: 'worker', killed: true, workspace: sameConvOtherMemberWt, workspace_mode: 'share' },
              'sibling-conv': { role: 'worker', killed: true, workspace: siblingBrainWt, workspace_mode: 'share' },
              'w-detached': { role: 'worker', killed: true, workspace: detachedOutsideWt, workspace_mode: 'share' },
              'w-1': { role: 'worker', killed: true, workspace: prefixCollideWt, workspace_mode: 'branch' },
            },
          }),
        )

        const cleaned = cleanupKilledNativeSwarmWorktrees(brainDir, convA, repo)
        assert.deepEqual(cleaned, [ownBrainWt])
        assert.equal(existsSync(ownBrainWt), false, 'worktree inside own convBrainDir matching member is cleaned')
        assert.equal(existsSync(sameConvOtherMemberWt), true, 'P1-11: same-conversation detached worktree owned by another member MUST NOT be removed')
        assert.equal(existsSync(siblingBrainWt), true, 'P1-11: sibling conversation brainDir worktree MUST NOT be removed')
        assert.equal(existsSync(detachedOutsideWt), true, 'P1-11: detached HEAD outside own convBrainDir MUST NOT be removed')
        assert.equal(existsSync(prefixCollideWt), true, 'P1-11: member w-1 must NOT match branch swarm/11111111/w-10')
      } finally {
        await rm(tmp, { recursive: true, force: true })
      }
    }

    // 3. P2-03: Detailed route lease renewal separates revoked vs transient 503/network error
    {
      const token = 'a'.repeat(64)
      const env = { OPENCLAUDE_V3_MASTER_BASE_URL: 'http://127.0.0.1:9999', OPENCLAUDE_V3_CONTAINER_TOKEN: 'tok' }
      const mockFetcher = (statusCode: number, body: string) =>
        (async () => ({
          statusCode,
          body: (async function* () {
            yield Buffer.from(body)
          })(),
        })) as never

      assert.equal(await renewAntigravityRouteLeaseDetailed(token, { env: {} }), 'unconfigured')
      assert.equal(await renewAntigravityRouteLeaseDetailed('bad-token', { env }), 'revoked')
      assert.equal(await renewAntigravityRouteLeaseDetailed(token, { env, fetcher: mockFetcher(200, '{"ok":true}') }), 'ok')
      assert.equal(await renewAntigravityRouteLeaseDetailed(token, { env, fetcher: mockFetcher(200, '{"ok":false}') }), 'revoked')
      assert.equal(await renewAntigravityRouteLeaseDetailed(token, { env, fetcher: mockFetcher(404, '{}') }), 'revoked')
      assert.equal(await renewAntigravityRouteLeaseDetailed(token, { env, fetcher: mockFetcher(410, '{}') }), 'revoked')
      assert.equal(await renewAntigravityRouteLeaseDetailed(token, { env, fetcher: mockFetcher(503, 'restarting') }), 'transient_error')
      assert.equal(
        await renewAntigravityRouteLeaseDetailed(token, {
          env,
          fetcher: (async () => {
            throw new Error('ECONNREFUSED')
          }) as never,
        }),
        'transient_error',
      )

      // Queued swarm survives transient 503 (retries once + warns) instead of dying,
      // while explicit 'revoked' still rejects with ANTIGRAVITY_ROUTE_EXPIRED_IN_QUEUE.
      setLocalSwarmConcurrencyLimitForTests(1)
      let rel1: (() => void) | null = null
      let rel2: (() => void) | null = null
      try {
        rel1 = await acquireLocalAntigravitySwarmSlot().promise
        let transientProbes = 0
        let warned = 0
        const pTransient = awaitLocalAntigravitySwarmSlotIfActive({
          compactionMode: 'on_full',
          keepaliveMs: 100,
          transientRetryDelayMs: 5,
          onStatus: () => {},
          onHeartbeat: () => {},
          onRenewRoute: async () => {
            transientProbes += 1
            return 'transient_error'
          },
          onRenewWarn: () => {
            warned += 1
          },
          setRelease: (fn) => { rel2 = fn },
        })
        rel1()
        rel1 = null
        await pTransient
        assert.equal(transientProbes, 2, 'must retry transient_error once before proceeding')
        assert.equal(warned, 1, 'must warn when transient_error persists on retry')
        assert.ok(rel2)

        // Revoked route fails closed and releases slot cleanly
        const pRevoked = awaitLocalAntigravitySwarmSlotIfActive({
          compactionMode: 'on_full',
          keepaliveMs: 100,
          onStatus: () => {},
          onHeartbeat: () => {},
          onRenewRoute: async () => 'revoked',
          setRelease: () => {},
        })
        ;(rel2 as (() => void) | null)?.()
        rel2 = null
        await assert.rejects(() => pRevoked, /ANTIGRAVITY_ROUTE_EXPIRED_IN_QUEUE/)
        assert.deepEqual(getLocalSwarmConcurrencyStateForTests(), { active: 0, queued: 0, limit: 1 })
      } finally {
        rel1?.()
        ;(rel2 as (() => void) | null)?.()
        setLocalSwarmConcurrencyLimitForTests(null)
      }
    }

    // 4. P2-04: Durable billing forwards AUTH_UNAVAILABLE and QUOTA_UNAVAILABLE terminal codes
    {
      const base = {
        requestId: 'e'.repeat(32),
        sessionKey: 'agent:main:webchat:dm:p2-04',
        budgetStop: false,
        interrupted: false,
        durationMs: 42,
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
      }
      assert.equal(
        buildAntigravityDurableBillingEvent({ ...base, status: 'unavailable', terminalCode: 'AUTH_UNAVAILABLE' }).terminalCode,
        'AUTH_UNAVAILABLE',
      )
      assert.equal(
        buildAntigravityDurableBillingEvent({ ...base, status: 'unavailable', terminalCode: 'QUOTA_UNAVAILABLE' }).terminalCode,
        'QUOTA_UNAVAILABLE',
      )
      assert.equal(
        buildAntigravityDurableBillingEvent({ ...base, status: 'error', terminalCode: 'ENGINE_ERROR' }).terminalCode,
        'CODEX_ERROR',
      )
      assert.equal(
        buildAntigravityDurableBillingEvent({ ...base, status: 'error', terminalCode: 'USER_CANCELLED' }).terminalCode,
        'USER_CANCELLED',
      )
      assert.equal(
        buildAntigravityDurableBillingEvent({ ...base, status: 'success', budgetStop: true, terminalCode: 'AUTH_UNAVAILABLE' }).terminalCode,
        undefined,
      )
    }
  })
})
