/**
 * Phase 5 — Codex final review P0 race regression.
 *
 * Hydrate-from-disk 路径上,bind() 在锁外 validateWorkspace 的 5–500ms 窗口里,
 * 旧实现没有把任何 state 落进 manager.states,导致并发 unbind() 找不到 state
 * 直接返 false,caller(server.ts session_repo_unbind handler)误判 "本来就没绑"
 * 跳过 recycle;然后旧 bind 继续 commit ready / fresh,把已被 tombstone 的 state
 * 复活,版本化 unbind 语义被破坏。
 *
 * 修复:lock #1 内 install 一个 'pending' placeholder state,后续 commit 路径用
 * identity-equality (cur === placeholderState) 检测被 unbind / 新 PUT 抢先。
 *
 * 这组测试锁住:
 *  - hydrate-OK 路径 + 中途 unbind  → state 不复活,unbind 返 true(触发 recycle)
 *  - hydrate-FAIL→fresh 兜底 + 中途 unbind → fresh state 不复活,runClone 不被调
 *
 * 全程不碰真盘 / 真 git:用 (mgr as any).validateWorkspace / writeTokenFile /
 * runClone 替身,把 IO 折叠成可控 promise。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/sessionRepoWorkspaceRace.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  SessionRepoWorkspaceManager,
  type SessionRepoBindFrame,
  type SessionRepoStatusOut,
} from '../sessionRepoWorkspace.js'

function makeFrame(over: Partial<SessionRepoBindFrame> = {}): SessionRepoBindFrame {
  return {
    type: 'inbound.control.session_repo_bind',
    sessionId: 'sess-race',
    selectionVersion: 7,
    peer: { id: 'p1', kind: 'dm' },
    agentId: 'a1',
    channel: 'web',
    owner: 'octo',
    repo: 'demo',
    branch: 'main',
    defaultBranch: 'main',
    headSha: null,
    accessToken: 't0k3n',
    scopes: 'repo',
    ...over,
  }
}

function makeMgr(): SessionRepoWorkspaceManager {
  return new SessionRepoWorkspaceManager({
    info: () => {},
    warn: () => {},
    error: () => {},
  })
}

/** 创建一个手控 promise — test 主线程 resolve() 才解锁 mocked async IO。 */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('SessionRepoWorkspaceManager — bind/unbind race in hydrate window', () => {
  it('hydrate-OK: unbind 在 validateWorkspace 期间到达,不允许 bind 把 state 复活成 ready', async () => {
    const mgr = makeMgr()
    const status: SessionRepoStatusOut[] = []
    const sendStatus = (s: SessionRepoStatusOut) => {
      status.push(s)
    }

    // validateWorkspace 卡在 deferred 上,模拟慢盘 / 慢 git rev-parse
    const validateGate = deferred<{ headSha: string } | null>()
    ;(mgr as any).validateWorkspace = (_dir: string) => validateGate.promise
    // writeTokenFile 也走异步,但立刻 resolve(异步顺序无所谓)
    ;(mgr as any).writeTokenFile = async () => '/fake/token'

    const frame = makeFrame()
    const bindP = mgr.bind(frame, sendStatus)

    // 让 bind() 跑到 lock #1 之后:placeholder 已 set,正在 await validateWorkspace
    await new Promise((r) => setImmediate(r))
    let snap = mgr.getRepoSnapshot(frame.sessionId)
    assert.ok(snap, 'placeholder state must be installed under lock #1')
    assert.equal(snap!.status, 'pending', 'placeholder must be pending status')

    // unbind(同 version)— 必须返回 true,因为 placeholder 落地后 unbind 命中正轨
    const unbindResult = await mgr.unbind(frame.sessionId, frame.selectionVersion)
    assert.equal(
      unbindResult,
      true,
      'unbind must observe placeholder, abort + delete it, return true → caller recycle',
    )
    assert.equal(
      mgr.getRepoSnapshot(frame.sessionId),
      null,
      'state map must be empty after unbind deletes placeholder',
    )

    // 现在让 validateWorkspace 完成 — bind 继续走 commit lock,但 cur !== placeholder
    // (placeholder 已被 unbind 删),commit 应失败,state 不被 set 回 ready。
    validateGate.resolve({ headSha: '0123456789abcdef0123456789abcdef01234567' })
    await bindP

    assert.equal(
      mgr.getRepoSnapshot(frame.sessionId),
      null,
      'BUG: bind must not revive state to ready after unbind deleted the placeholder',
    )

    // sendStatus 不应有 ready 帧(可以无任何帧;如有,绝不能是 ready)
    const readyFrames = status.filter((s) => s.status === 'ready')
    assert.equal(readyFrames.length, 0, 'no ready status should fire after unbind beat us')
  })

  it('hydrate-FAIL→fresh: unbind 在 validateWorkspace 期间到达,fresh fallback 不复活 state、runClone 不被调用', async () => {
    const mgr = makeMgr()
    const sendStatus = () => {}

    // validateWorkspace 卡住,但最终返 null(disk 状态不可信 → 走 fresh 兜底)
    const validateGate = deferred<{ headSha: string } | null>()
    ;(mgr as any).validateWorkspace = (_dir: string) => validateGate.promise

    let runCloneCalled = false
    ;(mgr as any).runClone = async () => {
      runCloneCalled = true
    }

    const frame = makeFrame({ sessionId: 'sess-race-2', selectionVersion: 3 })
    const bindP = mgr.bind(frame, sendStatus)

    // 让 placeholder 落地
    await new Promise((r) => setImmediate(r))
    assert.equal(mgr.getRepoSnapshot(frame.sessionId)?.status, 'pending')

    // unbind — placeholder 命中 + delete
    const unbindResult = await mgr.unbind(frame.sessionId, frame.selectionVersion)
    assert.equal(unbindResult, true, 'unbind must remove placeholder')
    assert.equal(mgr.getRepoSnapshot(frame.sessionId), null)

    // validateWorkspace 返 null → bind 走 fresh fallback,但 cur !== placeholder → null,
    // 不应再 set state、不应启动 runClone
    validateGate.resolve(null)
    await bindP

    assert.equal(
      mgr.getRepoSnapshot(frame.sessionId),
      null,
      'BUG: fresh fallback must not revive state after placeholder was deleted',
    )
    assert.equal(
      runCloneCalled,
      false,
      'BUG: runClone must not start after unbind beat us — clone would write to a tombstoned version dir',
    )
  })

  it('happy path: bind 完成后 state 应 ready;sanity check that the placeholder fix did not break the normal flow', async () => {
    const mgr = makeMgr()
    const status: SessionRepoStatusOut[] = []
    const sendStatus = (s: SessionRepoStatusOut) => {
      status.push(s)
    }

    ;(mgr as any).validateWorkspace = async () => ({
      headSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    })
    ;(mgr as any).writeTokenFile = async () => '/fake/token'

    const frame = makeFrame({ sessionId: 'sess-happy' })
    await mgr.bind(frame, sendStatus)

    const snap = mgr.getRepoSnapshot(frame.sessionId)
    assert.ok(snap, 'state must exist after happy-path bind')
    assert.equal(snap!.status, 'ready')
    assert.equal(snap!.selectionVersion, frame.selectionVersion)
    assert.equal(snap!.headSha, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')

    const readyFrames = status.filter((s) => s.status === 'ready')
    assert.equal(readyFrames.length, 1)
  })

  it('hydrate-FROM-DISK token-write failed: placeholder 转 failed,unbind 之后不应再发 failed 帧', async () => {
    const mgr = makeMgr()
    const status: SessionRepoStatusOut[] = []
    const sendStatus = (s: SessionRepoStatusOut) => {
      status.push(s)
    }

    ;(mgr as any).validateWorkspace = async () => ({ headSha: 'a'.repeat(40) })
    const writeGate = deferred<void>()
    ;(mgr as any).writeTokenFile = async () => {
      await writeGate.promise
      throw new Error('disk full')
    }

    const frame = makeFrame({ sessionId: 'sess-tokenfail' })
    const bindP = mgr.bind(frame, sendStatus)
    await new Promise((r) => setImmediate(r))
    // placeholder 落地后,先 unbind 再让 token write 失败
    await mgr.unbind(frame.sessionId, frame.selectionVersion)

    writeGate.resolve()
    await bindP

    // 因为 unbind 抢先,placeholder 已被 delete → commitHydrateFromDiskFailed 不发 status
    const failedFrames = status.filter((s) => s.status === 'failed')
    assert.equal(
      failedFrames.length,
      0,
      'after unbind beat us, no failed status should fire — state is gone',
    )
    assert.equal(mgr.getRepoSnapshot(frame.sessionId), null)
  })
})
