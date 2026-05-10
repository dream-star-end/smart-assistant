/**
 * Phase 5 Plan v3 Step C — codex 系两条 runner(per-turn `codex exec` 与
 * long-lived `codex app-server`)Phase 5 GitHub repo binding 行为的契约。
 *
 * 不调真子进程,只锁住:
 *   1. getBoundRepoBinding 初始 null,_applyRepoBindingFromSnapshot(ready+workspaceDir)
 *      之后填上 selectionVersion + workspaceDir,_currentRepoSnapshot 调
 *      opts.getRepoSnapshot(opts.sessionId)。
 *   2. 非 ready 状态(cloning / pending / failed / null)时 _boundRepoBinding 必须
 *      回到 null,effective cwd 回到 opts.cwd —— 确保 cloning 阶段子进程不会
 *      跑去一个还没 ready 的目录。
 *   3. clearSessionId() 把 threadId / app-server 的 baseline 字段全清掉 —— 这是
 *      sessionManager.recyclePeerForRepoChange 跨 repo 切换不污染线程上下文的
 *      必要前提(Plan v3 G.2 / Codex Round 2 BLOCKER)。
 *   4. opts.sessionId 或 opts.getRepoSnapshot 缺其一(legacy caller 没接入)时,
 *      _currentRepoSnapshot 安全回 null,不抛 —— 向后兼容。
 *   5. opts.getRepoSnapshot 抛错时,_currentRepoSnapshot 吞错回 null,运行不被
 *      第三方 provider bug 拖崩。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/codexRunnerRepoBinding.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CodexAppServerRunner } from '../codexAppServerRunner.js'
import { CodexRunner } from '../codexRunner.js'
import type { RepoSnapshot } from '../sessionRepoWorkspace.js'

const baseSnap: RepoSnapshot = {
  status: 'ready',
  selectionVersion: 7,
  owner: 'octo',
  repo: 'demo',
  branch: 'main',
  workspaceDir: '/home/agent/.openclaude/repos/sess-1/7',
  headSha: '0123456789abcdef0123456789abcdef01234567',
  errorCode: null,
  errorMessage: null,
}

// ── CodexRunner (per-turn `codex exec`) ──────────────────────────────────────

describe('CodexRunner — Phase 5 repo binding', () => {
  it('getBoundRepoBinding returns null before any apply', () => {
    const r = new CodexRunner({
      sessionKey: 'sk',
      agentId: 'a',
      cwd: '/agent-base',
      sessionId: 'sess-1',
      getRepoSnapshot: () => baseSnap,
    })
    assert.equal(r.getBoundRepoBinding(), null)
  })

  it('_applyRepoBindingFromSnapshot(ready) sets binding + returns workspaceDir', () => {
    const r = new CodexRunner({
      sessionKey: 'sk',
      agentId: 'a',
      cwd: '/agent-base',
      sessionId: 'sess-1',
      getRepoSnapshot: () => baseSnap,
    })
    const eff = (r as any)._applyRepoBindingFromSnapshot(baseSnap)
    assert.equal(eff, baseSnap.workspaceDir)
    assert.deepEqual(r.getBoundRepoBinding(), {
      selectionVersion: baseSnap.selectionVersion,
      workspaceDir: baseSnap.workspaceDir,
    })
  })

  it('_applyRepoBindingFromSnapshot(cloning) clears binding + falls back to opts.cwd', () => {
    const r = new CodexRunner({
      sessionKey: 'sk',
      agentId: 'a',
      cwd: '/agent-base',
      sessionId: 'sess-1',
      getRepoSnapshot: () => baseSnap,
    })
    // First seed it as ready
    ;(r as any)._applyRepoBindingFromSnapshot(baseSnap)
    assert.notEqual(r.getBoundRepoBinding(), null)
    // Then cloning must wipe it
    const eff = (r as any)._applyRepoBindingFromSnapshot({
      ...baseSnap,
      status: 'cloning',
      workspaceDir: null,
    })
    assert.equal(eff, '/agent-base')
    assert.equal(r.getBoundRepoBinding(), null)
  })

  it('_applyRepoBindingFromSnapshot(null) clears binding + falls back to opts.cwd', () => {
    const r = new CodexRunner({
      sessionKey: 'sk',
      agentId: 'a',
      cwd: '/agent-base',
    })
    ;(r as any)._applyRepoBindingFromSnapshot(baseSnap)
    const eff = (r as any)._applyRepoBindingFromSnapshot(null)
    assert.equal(eff, '/agent-base')
    assert.equal(r.getBoundRepoBinding(), null)
  })

  it('_currentRepoSnapshot returns provider result when sessionId+getRepoSnapshot provided', () => {
    const calls: string[] = []
    const r = new CodexRunner({
      sessionKey: 'sk',
      agentId: 'a',
      cwd: '/agent-base',
      sessionId: 'sess-1',
      getRepoSnapshot: (sid) => {
        calls.push(sid)
        return baseSnap
      },
    })
    const snap = (r as any)._currentRepoSnapshot()
    assert.equal(snap, baseSnap)
    assert.deepEqual(calls, ['sess-1'])
  })

  it('_currentRepoSnapshot returns null when sessionId is missing (legacy)', () => {
    const r = new CodexRunner({
      sessionKey: 'sk',
      agentId: 'a',
      cwd: '/agent-base',
      getRepoSnapshot: () => baseSnap,
    })
    assert.equal((r as any)._currentRepoSnapshot(), null)
  })

  it('_currentRepoSnapshot returns null when getRepoSnapshot is missing (legacy)', () => {
    const r = new CodexRunner({
      sessionKey: 'sk',
      agentId: 'a',
      cwd: '/agent-base',
      sessionId: 'sess-1',
    })
    assert.equal((r as any)._currentRepoSnapshot(), null)
  })

  it('_currentRepoSnapshot swallows provider exceptions and returns null', () => {
    const r = new CodexRunner({
      sessionKey: 'sk',
      agentId: 'a',
      cwd: '/agent-base',
      sessionId: 'sess-1',
      getRepoSnapshot: () => {
        throw new Error('boom')
      },
    })
    assert.equal((r as any)._currentRepoSnapshot(), null)
  })

  it('clearSessionId nulls threadId (per-turn exec has no usage baselines to clear)', () => {
    const r = new CodexRunner({
      sessionKey: 'sk',
      agentId: 'a',
      cwd: '/agent-base',
      resumeSessionId: 'thr_old',
    })
    // threadId is private; we read it via cast.
    assert.equal((r as any).threadId, 'thr_old')
    r.clearSessionId()
    assert.equal((r as any).threadId, null)
  })

  it('clearSessionId also invalidates cachedOverrides + sessionDir (Codex code-review BLOCKER fix)', async () => {
    const { mkdtemp } = await import('node:fs/promises')
    const { existsSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const r = new CodexRunner({
      sessionKey: 'sk',
      agentId: 'a',
      cwd: '/agent-base',
    })
    // Inject a real sessionDir + fake overrides — without invalidation, the
    // ensureLaunchOverrides() cache hit on next turn returns the previous
    // repo's REPO slot even after recycle (cwd 与 system prompt 分裂)。
    const dir = await mkdtemp(join(tmpdir(), 'codex-clear-'))
    ;(r as any).sessionDir = dir
    ;(r as any).cachedOverrides = { extraConfig: ['-c', 'k=v'] }
    assert.equal(existsSync(dir), true)

    r.clearSessionId()

    assert.equal((r as any).sessionDir, null, 'sessionDir must be nulled')
    assert.equal((r as any).cachedOverrides, null, 'cachedOverrides must be nulled')
    assert.equal(existsSync(dir), false, 'physical sessionDir must be rmSynced')
  })

  it('clearSessionId tolerates already-cleared cachedOverrides (idempotent)', () => {
    const r = new CodexRunner({
      sessionKey: 'sk',
      agentId: 'a',
      cwd: '/agent-base',
    })
    // No sessionDir, no cachedOverrides — must not throw.
    r.clearSessionId()
    assert.equal((r as any).sessionDir, null)
    assert.equal((r as any).cachedOverrides, null)
  })
})

// ── CodexAppServerRunner (long-lived JSON-RPC) ───────────────────────────────

describe('CodexAppServerRunner — Phase 5 repo binding', () => {
  it('getBoundRepoBinding starts null + becomes ready binding after apply', () => {
    const r = new CodexAppServerRunner({
      sessionKey: 'sk',
      agentId: 'a',
      cwd: '/agent-base',
      sessionId: 'sess-1',
      getRepoSnapshot: () => baseSnap,
    })
    assert.equal(r.getBoundRepoBinding(), null)
    const eff = (r as any)._applyRepoBindingFromSnapshot(baseSnap)
    assert.equal(eff, baseSnap.workspaceDir)
    assert.deepEqual(r.getBoundRepoBinding(), {
      selectionVersion: baseSnap.selectionVersion,
      workspaceDir: baseSnap.workspaceDir,
    })
  })

  it('clearSessionId clears threadId AND token usage baselines (avoid underbilling)', () => {
    const r = new CodexAppServerRunner({
      sessionKey: 'sk',
      agentId: 'a',
      cwd: '/agent-base',
      resumeSessionId: 'thr_old',
    })
    ;(r as any).priorTurnTotal = { input: 100, output: 200 }
    ;(r as any).activeTurnTotal = { input: 50, output: 75 }
    ;(r as any).currentTurnUsage = { input: 10, output: 5 }
    assert.equal((r as any).threadId, 'thr_old')

    r.clearSessionId()

    assert.equal((r as any).threadId, null)
    assert.equal((r as any).priorTurnTotal, null)
    assert.equal((r as any).activeTurnTotal, null)
    assert.equal((r as any).currentTurnUsage, null)
  })

  it('clearSessionId also invalidates cachedOverrides + sessionDir (Codex code-review BLOCKER fix)', async () => {
    const { mkdtemp } = await import('node:fs/promises')
    const { existsSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const r = new CodexAppServerRunner({
      sessionKey: 'sk',
      agentId: 'a',
      cwd: '/agent-base',
    })
    const dir = await mkdtemp(join(tmpdir(), 'codex-aps-clear-'))
    ;(r as any).sessionDir = dir
    ;(r as any).cachedOverrides = { extraConfig: ['-c', 'k=v'] }
    assert.equal(existsSync(dir), true)

    r.clearSessionId()

    assert.equal((r as any).sessionDir, null, 'sessionDir must be nulled')
    assert.equal((r as any).cachedOverrides, null, 'cachedOverrides must be nulled')
    assert.equal(existsSync(dir), false, 'physical sessionDir must be rmSynced')
  })

  it('_currentRepoSnapshot swallows provider exceptions and returns null', () => {
    const r = new CodexAppServerRunner({
      sessionKey: 'sk',
      agentId: 'a',
      cwd: '/agent-base',
      sessionId: 'sess-1',
      getRepoSnapshot: () => {
        throw new Error('boom')
      },
    })
    assert.equal((r as any)._currentRepoSnapshot(), null)
  })
})
