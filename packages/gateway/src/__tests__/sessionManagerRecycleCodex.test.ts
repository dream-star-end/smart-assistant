/**
 * Phase 5 Plan v3 Step G — sessionManager.recyclePeerForRepoChange 在
 * codex-native session 上的"per-turn isRunning=false 也必须重置 thread / resume
 * 残留"行为契约。这是 Plan v3 三轮 Codex review 之后的 BLOCKER 修复:
 *
 *   - CodexRunner 是 per-turn `codex exec`,turn 结束后子进程退出,
 *     session.runner.isRunning 变 false,但:
 *       a) runner.threadId 仍保留(下次 spawn 会带 `exec resume <oldThreadId>`)
 *       b) session.ccbSessionId 仍保留(_saveResumeMap 会从这里反推回
 *          _resumeMap,等于把 thread 复活)
 *       c) _resumeMap[sessionKey] 仍指着旧 thread
 *     repo 切换时若不清,下一轮 turn codex 仍会 attach 到旧 repo 的 thread,
 *     LLM 上下文里的文件结构 / 命令历史会跨 repo 漂移。
 *
 *   - SubprocessRunner(CCB)是 long-running:isRunning=false ⇒ 子进程已死,
 *     下次 submit() 自然 spawn 新进程并读最新 snapshot,不需要清任何 in-memory
 *     状态。recyclePeerForRepoChange 在这种情况短路 return 是对的。
 *
 * 这套测试在 fake runner + 直接 inject AgentSession 的层面验证:
 *   - codex-native + isRunning=false + version 不一致 → 必须清四张 resume map +
 *     ccbSessionId + 调 runner.clearSessionId,但不调 shutdown(进程已死)。
 *   - codex-native + isRunning=true + version 不一致 → 清完之后还要 shutdown。
 *   - codex-native + version 一致 → 短路,不清不 shutdown。
 *   - ccb + isRunning=false → 早返,不清不 shutdown(submit() 自然兜)。
 *   - 任何 sessionId 不在 _sessionIdToKey 的调用 → 不抛、不动状态。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/sessionManagerRecycleCodex.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { SessionManager, type AgentSession } from '../sessionManager.js'
import type { OpenClaudeConfig } from '@openclaude/storage'
import type { RepoSnapshot } from '../sessionRepoWorkspace.js'

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeConfigStub(): OpenClaudeConfig {
  return {
    version: 1,
    gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
    auth: { mode: 'subscription', claudeCodePath: '' },
    sessions: { dbPath: '' },
  } as unknown as OpenClaudeConfig
}

interface FakeRunner {
  isRunning: boolean
  threadId: string | null
  bindingState: { selectionVersion: number; workspaceDir: string } | null
  shutdownCalls: number
  clearCalls: number
  shutdown(): Promise<void>
  clearSessionId(): void
  getBoundRepoBinding(): { selectionVersion: number; workspaceDir: string } | null
}

function makeFakeRunner(opts: {
  isRunning: boolean
  threadId?: string | null
  binding?: { selectionVersion: number; workspaceDir: string } | null
}): FakeRunner {
  const r: FakeRunner = {
    isRunning: opts.isRunning,
    threadId: opts.threadId ?? null,
    bindingState: opts.binding ?? null,
    shutdownCalls: 0,
    clearCalls: 0,
    async shutdown() {
      this.shutdownCalls += 1
      this.isRunning = false
    },
    clearSessionId() {
      this.clearCalls += 1
      this.threadId = null
    },
    getBoundRepoBinding() {
      return this.bindingState
    },
  }
  return r
}

function injectSession(
  sm: SessionManager,
  args: {
    sessionKey: string
    sessionId: string
    providerTag: string
    runner: FakeRunner
    ccbSessionId?: string | null
  },
): AgentSession {
  const sess: AgentSession = {
    sessionKey: args.sessionKey,
    agentId: 'agent-x',
    channel: 'webchat',
    peerId: args.sessionId,
    title: 't',
    startedAt: Date.now(),
    runner: args.runner as any,
    ccbSessionId: args.ccbSessionId ?? null,
    lock: Promise.resolve(),
    lastUsedAt: Date.now(),
    totalCostUSD: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    turns: 0,
    _lastCcbCumulativeCost: 0,
    toolUseIdToName: new Map(),
    executionTarget: { kind: 'local' },
    providerTag: args.providerTag,
    agentProvider: args.providerTag === 'codex-native' ? 'codex-native' : 'claude-subscription',
  } as AgentSession
  const priv = sm as unknown as {
    sessions: Map<string, AgentSession>
    _sessionIdToKey: Map<string, string>
    _resumeMap: Map<string, string>
    _resumeMapTimestamps: Map<string, number>
    _resumeMapProvider: Map<string, string>
    _resumeMapLastCost: Map<string, number>
    _saveResumeMap(): void
  }
  priv.sessions.set(args.sessionKey, sess)
  priv._sessionIdToKey.set(args.sessionId, args.sessionKey)
  return sess
}

function stubSaveResumeMap(sm: SessionManager): { calls: number } {
  const counter = { calls: 0 }
  ;(sm as any)._saveResumeMap = () => {
    counter.calls += 1
  }
  return counter
}

const readySnap: RepoSnapshot = {
  status: 'ready',
  selectionVersion: 9,
  owner: 'octo',
  repo: 'demo',
  branch: 'main',
  workspaceDir: '/repos/sess-1/9',
  headSha: 'a'.repeat(40),
  errorCode: null,
  errorMessage: null,
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('recyclePeerForRepoChange — codex-native per-turn reset (Plan v3 G.1/G.2)', () => {
  test('codex isRunning=false + binding version mismatch → reset all resume state, no shutdown', async () => {
    const sm = new SessionManager(makeConfigStub())
    const saveCounter = stubSaveResumeMap(sm)
    const runner = makeFakeRunner({
      isRunning: false,
      threadId: 'thr_old',
      binding: { selectionVersion: 7, workspaceDir: '/repos/sess-1/7' },
    })
    injectSession(sm, {
      sessionKey: 'sk-1',
      sessionId: 'sess-1',
      providerTag: 'codex-native',
      runner,
      ccbSessionId: 'thr_old',
    })

    const priv = sm as unknown as {
      _resumeMap: Map<string, string>
      _resumeMapTimestamps: Map<string, number>
      _resumeMapProvider: Map<string, string>
      _resumeMapLastCost: Map<string, number>
      sessions: Map<string, AgentSession>
    }
    priv._resumeMap.set('sk-1', 'thr_old')
    priv._resumeMapTimestamps.set('sk-1', Date.now())
    priv._resumeMapProvider.set('sk-1', 'codex-native')
    priv._resumeMapLastCost.set('sk-1', 0)

    await sm.recyclePeerForRepoChange('sess-1', readySnap)

    assert.equal(priv._resumeMap.has('sk-1'), false, '_resumeMap entry must be cleared')
    assert.equal(priv._resumeMapTimestamps.has('sk-1'), false)
    assert.equal(priv._resumeMapProvider.has('sk-1'), false)
    assert.equal(priv._resumeMapLastCost.has('sk-1'), false)
    assert.equal(priv.sessions.get('sk-1')!.ccbSessionId, null, 'session.ccbSessionId must be null (otherwise _saveResumeMap rebuilds it)')
    assert.equal(runner.clearCalls, 1, 'runner.clearSessionId() must be called exactly once')
    assert.equal(runner.shutdownCalls, 0, 'shutdown must NOT run when isRunning=false')
    assert.ok(saveCounter.calls >= 1, '_saveResumeMap must run after the reset (atomic on-disk view)')
  })

  test('codex isRunning=true + binding version mismatch → reset AND shutdown', async () => {
    const sm = new SessionManager(makeConfigStub())
    stubSaveResumeMap(sm)
    const runner = makeFakeRunner({
      isRunning: true,
      threadId: 'thr_old',
      binding: { selectionVersion: 5, workspaceDir: '/repos/sess-1/5' },
    })
    injectSession(sm, {
      sessionKey: 'sk-2',
      sessionId: 'sess-2',
      providerTag: 'codex-native',
      runner,
      ccbSessionId: 'thr_old',
    })

    await sm.recyclePeerForRepoChange('sess-2', readySnap)

    assert.equal(runner.clearCalls, 1)
    assert.equal(runner.shutdownCalls, 1, 'shutdown must run when isRunning=true')
    const priv = sm as unknown as { sessions: Map<string, AgentSession> }
    assert.equal(priv.sessions.get('sk-2')!.ccbSessionId, null)
  })

  test('codex binding version matches new snapshot → no reset, no shutdown', async () => {
    const sm = new SessionManager(makeConfigStub())
    stubSaveResumeMap(sm)
    const runner = makeFakeRunner({
      isRunning: false,
      threadId: 'thr_active',
      binding: { selectionVersion: 9, workspaceDir: '/repos/sess-3/9' },
    })
    injectSession(sm, {
      sessionKey: 'sk-3',
      sessionId: 'sess-3',
      providerTag: 'codex-native',
      runner,
      ccbSessionId: 'thr_active',
    })

    await sm.recyclePeerForRepoChange('sess-3', readySnap)

    assert.equal(runner.clearCalls, 0, 'no version diff → must not clear')
    assert.equal(runner.shutdownCalls, 0)
    const priv = sm as unknown as { sessions: Map<string, AgentSession> }
    assert.equal(
      priv.sessions.get('sk-3')!.ccbSessionId,
      'thr_active',
      'ccbSessionId must be preserved when binding matches',
    )
  })

  test('codex new snapshot is cloning → no reset, no shutdown (let codex stay on old binding dir)', async () => {
    const sm = new SessionManager(makeConfigStub())
    stubSaveResumeMap(sm)
    const runner = makeFakeRunner({
      isRunning: false,
      threadId: 'thr_old',
      binding: { selectionVersion: 7, workspaceDir: '/repos/sess-4/7' },
    })
    injectSession(sm, {
      sessionKey: 'sk-4',
      sessionId: 'sess-4',
      providerTag: 'codex-native',
      runner,
      ccbSessionId: 'thr_old',
    })

    await sm.recyclePeerForRepoChange('sess-4', { ...readySnap, status: 'cloning' })

    assert.equal(runner.clearCalls, 0)
    assert.equal(runner.shutdownCalls, 0)
  })

  test('CCB isRunning=false → short-circuit (next submit re-spawns with latest snapshot)', async () => {
    const sm = new SessionManager(makeConfigStub())
    stubSaveResumeMap(sm)
    const runner = makeFakeRunner({
      isRunning: false,
      binding: { selectionVersion: 1, workspaceDir: '/repos/old/1' },
    })
    injectSession(sm, {
      sessionKey: 'sk-5',
      sessionId: 'sess-5',
      providerTag: 'ccb',
      runner,
      ccbSessionId: 'ccb_old',
    })

    await sm.recyclePeerForRepoChange('sess-5', readySnap)

    assert.equal(runner.clearCalls, 0, 'CCB must not be touched on isRunning=false')
    assert.equal(runner.shutdownCalls, 0)
    const priv = sm as unknown as { sessions: Map<string, AgentSession> }
    assert.equal(priv.sessions.get('sk-5')!.ccbSessionId, 'ccb_old')
  })

  test('CCB isRunning=true + version mismatch → shutdown only, no resume-map reset', async () => {
    const sm = new SessionManager(makeConfigStub())
    stubSaveResumeMap(sm)
    const runner = makeFakeRunner({
      isRunning: true,
      binding: { selectionVersion: 1, workspaceDir: '/repos/old/1' },
    })
    injectSession(sm, {
      sessionKey: 'sk-6',
      sessionId: 'sess-6',
      providerTag: 'ccb',
      runner,
      ccbSessionId: 'ccb_old',
    })
    const priv = sm as unknown as {
      sessions: Map<string, AgentSession>
      _resumeMap: Map<string, string>
    }
    priv._resumeMap.set('sk-6', 'ccb_old')

    await sm.recyclePeerForRepoChange('sess-6', readySnap)

    assert.equal(runner.shutdownCalls, 1)
    assert.equal(runner.clearCalls, 0, 'CCB recycle does not clear thread/resume — long-lived spawn naturally re-resumes after shutdown')
    assert.equal(
      priv.sessions.get('sk-6')!.ccbSessionId,
      'ccb_old',
      'CCB ccbSessionId is preserved (legitimate --resume target on next spawn)',
    )
    assert.equal(priv._resumeMap.get('sk-6'), 'ccb_old')
  })

  test('unknown sessionId is a no-op (does not throw)', async () => {
    const sm = new SessionManager(makeConfigStub())
    stubSaveResumeMap(sm)
    await sm.recyclePeerForRepoChange('does-not-exist', readySnap)
    // Just don't throw.
  })
})
