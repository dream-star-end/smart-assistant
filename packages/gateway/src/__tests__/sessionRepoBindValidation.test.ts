/**
 * Phase 5 — SessionRepoWorkspaceManager.bind() 的 early-return schema 校验。
 *
 * server.ts 已在 WS 帧入口做 schema check,但 bind() 是 manager 的公开 API
 * (Phase 5 Codex P1:不能依赖 caller 已校验)。本组测试 pin 住:
 *
 *   - sessionId 非字符串 / 非 [A-Za-z0-9_-]+   → INVALID_SESSION_ID
 *   - selectionVersion 非 safe int / <=0       → INVALID_VERSION
 *   - owner / repo / branch 非字符串 / 不合规则 → INVALID_REF
 *
 * 这些早 return 通过 sendStatus 回 'failed' 帧,不进 lock / 不分配状态,
 * 是廉价、纯同步行为,适合单元测试。
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  SessionRepoWorkspaceManager,
  type SessionRepoBindFrame,
  type SessionRepoStatusOut,
} from '../sessionRepoWorkspace.js'

function validFrame(over: Partial<SessionRepoBindFrame> = {}): SessionRepoBindFrame {
  return {
    type: 'inbound.control.session_repo_bind',
    sessionId: 'sess-1',
    selectionVersion: 1,
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

function makeMgr() {
  const out: SessionRepoStatusOut[] = []
  const mgr = new SessionRepoWorkspaceManager()
  const sendStatus = (s: SessionRepoStatusOut) => out.push(s)
  return { mgr, out, sendStatus }
}

describe('SessionRepoWorkspaceManager.bind() schema validation', () => {
  it('non-string sessionId → INVALID_SESSION_ID failed status', async () => {
    const { mgr, out, sendStatus } = makeMgr()
    await mgr.bind(
      validFrame({ sessionId: 123 as unknown as string }),
      sendStatus,
    )
    assert.equal(out.length, 1)
    assert.equal(out[0].status, 'failed')
    assert.equal(out[0].errorCode, 'INVALID_SESSION_ID')
  })

  it('sessionId with shell-meta chars → INVALID_SESSION_ID', async () => {
    const { mgr, out, sendStatus } = makeMgr()
    await mgr.bind(validFrame({ sessionId: 'bad;rm-rf' }), sendStatus)
    assert.equal(out[0].status, 'failed')
    assert.equal(out[0].errorCode, 'INVALID_SESSION_ID')
  })

  it('selectionVersion = 0 → INVALID_VERSION', async () => {
    const { mgr, out, sendStatus } = makeMgr()
    await mgr.bind(validFrame({ selectionVersion: 0 }), sendStatus)
    assert.equal(out[0].status, 'failed')
    assert.equal(out[0].errorCode, 'INVALID_VERSION')
  })

  it('selectionVersion negative → INVALID_VERSION', async () => {
    const { mgr, out, sendStatus } = makeMgr()
    await mgr.bind(validFrame({ selectionVersion: -1 }), sendStatus)
    assert.equal(out[0].status, 'failed')
    assert.equal(out[0].errorCode, 'INVALID_VERSION')
  })

  it('selectionVersion non-integer (1.5) → INVALID_VERSION', async () => {
    const { mgr, out, sendStatus } = makeMgr()
    await mgr.bind(validFrame({ selectionVersion: 1.5 }), sendStatus)
    assert.equal(out[0].status, 'failed')
    assert.equal(out[0].errorCode, 'INVALID_VERSION')
  })

  it('selectionVersion non-number → INVALID_VERSION', async () => {
    const { mgr, out, sendStatus } = makeMgr()
    await mgr.bind(
      validFrame({ selectionVersion: '1' as unknown as number }),
      sendStatus,
    )
    assert.equal(out[0].status, 'failed')
    assert.equal(out[0].errorCode, 'INVALID_VERSION')
  })

  it('selectionVersion > MAX_SAFE_INTEGER → INVALID_VERSION (Number.isSafeInteger guard)', async () => {
    const { mgr, out, sendStatus } = makeMgr()
    await mgr.bind(
      validFrame({ selectionVersion: Number.MAX_SAFE_INTEGER + 1 }),
      sendStatus,
    )
    assert.equal(out[0].status, 'failed')
    assert.equal(out[0].errorCode, 'INVALID_VERSION')
  })

  it('owner empty string → INVALID_REF', async () => {
    const { mgr, out, sendStatus } = makeMgr()
    await mgr.bind(validFrame({ owner: '' }), sendStatus)
    assert.equal(out[0].status, 'failed')
    assert.equal(out[0].errorCode, 'INVALID_REF')
  })

  it('owner non-string → INVALID_REF (no regex.test crash)', async () => {
    const { mgr, out, sendStatus } = makeMgr()
    // Codex P1: typeof check MUST guard regex.test from undefined.
    await mgr.bind(
      validFrame({ owner: undefined as unknown as string }),
      sendStatus,
    )
    assert.equal(out[0].status, 'failed')
    assert.equal(out[0].errorCode, 'INVALID_REF')
  })

  it('branch with shell-meta chars → INVALID_REF', async () => {
    const { mgr, out, sendStatus } = makeMgr()
    await mgr.bind(validFrame({ branch: 'main;rm' }), sendStatus)
    assert.equal(out[0].status, 'failed')
    assert.equal(out[0].errorCode, 'INVALID_REF')
  })

  it('repo with space → INVALID_REF', async () => {
    const { mgr, out, sendStatus } = makeMgr()
    await mgr.bind(validFrame({ repo: 'has space' }), sendStatus)
    assert.equal(out[0].status, 'failed')
    assert.equal(out[0].errorCode, 'INVALID_REF')
  })

  it('rejected frame leaves no state behind (getRepoSnapshot=null)', async () => {
    const { mgr, sendStatus } = makeMgr()
    await mgr.bind(validFrame({ sessionId: 'bad;rm' }), sendStatus)
    // Even with the exact sessionId we tried (after sanitizing),
    // the sane sessionId we'd have hoped for has no state either.
    assert.equal(mgr.getRepoSnapshot('bad'), null)
    assert.equal(mgr.getRepoSnapshot('bad;rm'), null)
  })
})

describe('SessionRepoWorkspaceManager.unbind() versioned tombstone', () => {
  it('unbind on never-bound sessionId returns false (caller does NOT recycle)', async () => {
    const mgr = new SessionRepoWorkspaceManager()
    const deleted = await mgr.unbind('never-existed', 1)
    assert.equal(deleted, false)
  })

  it('unbind with invalid sessionId returns false', async () => {
    const mgr = new SessionRepoWorkspaceManager()
    const deleted = await mgr.unbind('bad;rm', 1)
    assert.equal(deleted, false)
  })
})
