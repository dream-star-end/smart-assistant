/**
 * Phase 4 — sessionRepoBindBridge 单元测试。
 *
 * 覆盖:
 *   1. parseBindRequest / parseUnbindRequest / parseStatusFrame schema 校验
 *   2. enrichBindRequest 富化逻辑:
 *      - STALE_OR_MISSING(行不存在 / version 不匹配 / status='cleared')
 *      - INVALID_BIND_PAYLOAD(DB 里 owner/repo/branch 含坏字符)
 *      - GITHUB_NOT_LINKED(link 已 revoke)
 *      - happy path
 *   3. applyStatusFrame 落库:
 *      - 普通 status → 仅 UPDATE
 *      - failed + token_invalid → revoke 先于 UPDATE(顺序约束)
 *      - revoke 抛异常时仍尝试 UPDATE
 *      - stale ack(rowCount=0)→ dbUpdated=false 不抛
 *   4. buildAutoRebindFrames:
 *      - 无匹配 → 空结果不查 link
 *      - 有匹配 + link 健康 → enriched 帧 + sessionId 列表
 *      - 有匹配 + link 已 revoke → 每行一个 GITHUB_NOT_LINKED error
 *      - DB 里 owner/branch 坏字符 → INVALID_BIND_PAYLOAD per row
 *   5. listActiveGithubWorkspaceSelections / updateGithubWorkspaceStatusIfVersion
 *      DAO SQL shape & rowCount 语义。
 */

import assert from 'node:assert/strict'
import { before, beforeEach, describe, test } from 'node:test'
import { encrypt } from '../crypto/aead.js'
import {
  applyStatusFrame,
  buildAutoRebindFrames,
  enrichBindRequest,
  fetchActiveSelectionsForRebind,
  parseBindRequest,
  parseStatusFrame,
  parseUnbindRequest,
} from '../ws/sessionRepoBindBridge.js'
import {
  listActiveGithubWorkspaceSelections,
  updateGithubWorkspaceStatusIfVersion,
  type GithubSelectionRow,
} from '../github/sessionWorkspaces.js'

// ─── KMS key setup ────────────────────────────────────────────────────
const TEST_KMS_KEY = Buffer.alloc(32, 0xab)
before(() => {
  process.env.OPENCLAUDE_KMS_KEY = TEST_KMS_KEY.toString('base64')
})

// ─── Mock pool helpers ────────────────────────────────────────────────

interface MockQueryCall {
  sql: string
  params: unknown[]
}
interface MockQueryResult<T = Record<string, unknown>> {
  rowCount: number
  rows: T[]
}

interface MockPool {
  query: (sql: string, params: unknown[]) => Promise<MockQueryResult>
  connect: () => Promise<{
    query: (sql: string, params?: unknown[]) => Promise<MockQueryResult>
    release: () => void
  }>
}

/**
 * Build a mock pool that records calls + returns preset rows. The same
 * sequence is shared between `pool.query` and the client returned by
 * `pool.connect()` (so a single ordered list captures all SQL — the order
 * of revoke (transaction client) vs subsequent versioned UPDATE (pool query)
 * is exactly what we want to assert in applyStatusFrame).
 */
function makeMockPool(responses: MockQueryResult[]): {
  pool: MockPool
  calls: MockQueryCall[]
} {
  const calls: MockQueryCall[] = []
  let idx = 0
  const next = (sql: string, params: unknown[] | undefined): MockQueryResult => {
    calls.push({ sql, params: params ?? [] })
    const r = responses[idx]
    idx++
    return r ?? { rowCount: 0, rows: [] }
  }
  const pool: MockPool = {
    async query(sql, params) {
      return next(sql, params)
    },
    async connect() {
      return {
        async query(sql: string, params?: unknown[]) {
          return next(sql, params)
        },
        release() {
          /* no-op */
        },
      }
    },
  }
  return { pool, calls }
}

function encToken(plain: string): { ct: Buffer; nonce: Buffer } {
  const r = encrypt(plain, TEST_KMS_KEY)
  return { ct: r.ciphertext, nonce: r.nonce }
}

function selectionRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    user_id: '7',
    session_id: 'sess-1',
    selection_version: '3',
    owner: 'octocat',
    repo: 'hello-world',
    branch: 'main',
    default_branch: 'main',
    status: 'pending',
    head_sha: null,
    error_code: null,
    error_message: null,
    selected_at: new Date('2026-01-01'),
    updated_at: new Date('2026-01-01'),
    ...over,
  }
}

// ─── parseBindRequest ─────────────────────────────────────────────────

describe('parseBindRequest', () => {
  const valid = {
    type: 'inbound.control.session_repo_bind',
    sessionId: 'sess-1',
    selectionVersion: 3,
    peer: { id: 'sess-1', kind: 'dm' },
    agentId: 'main',
    channel: 'webchat',
  }
  test('accepts well-formed frame', () => {
    const r = parseBindRequest(valid)
    assert.ok(r)
    assert.equal(r.sessionId, 'sess-1')
    assert.equal(r.selectionVersion, 3)
    assert.equal(r.peer.id, 'sess-1')
  })
  test('rejects wrong type', () => {
    assert.equal(parseBindRequest({ ...valid, type: 'inbound.control.other' }), null)
  })
  test('rejects bad sessionId chars', () => {
    assert.equal(
      parseBindRequest({ ...valid, sessionId: 'bad/char', peer: { id: 'bad/char', kind: 'dm' } }),
      null,
    )
  })
  test('rejects non-integer selectionVersion', () => {
    assert.equal(parseBindRequest({ ...valid, selectionVersion: 1.5 }), null)
  })
  test('rejects zero selectionVersion', () => {
    assert.equal(parseBindRequest({ ...valid, selectionVersion: 0 }), null)
  })
  test('rejects selectionVersion > MAX_SAFE_INTEGER (safe-int alignment with gateway)', () => {
    assert.equal(
      parseBindRequest({ ...valid, selectionVersion: Number.MAX_SAFE_INTEGER + 1 }),
      null,
    )
  })
  test('rejects peer.id !== sessionId', () => {
    assert.equal(
      parseBindRequest({ ...valid, peer: { id: 'other', kind: 'dm' } }),
      null,
    )
  })
  test('rejects peer.kind !== dm', () => {
    assert.equal(
      parseBindRequest({ ...valid, peer: { id: 'sess-1', kind: 'broadcast' } }),
      null,
    )
  })
  test('rejects bad agentId', () => {
    assert.equal(parseBindRequest({ ...valid, agentId: 'bad agent' }), null)
  })
  test('rejects null', () => {
    assert.equal(parseBindRequest(null), null)
  })
})

// ─── parseUnbindRequest ───────────────────────────────────────────────

describe('parseUnbindRequest', () => {
  test('accepts valid frame with selectionVersion', () => {
    const r = parseUnbindRequest({
      type: 'inbound.control.session_repo_unbind',
      sessionId: 'sess-1',
      selectionVersion: 3,
    })
    assert.deepEqual(r, {
      type: 'inbound.control.session_repo_unbind',
      sessionId: 'sess-1',
      selectionVersion: 3,
    })
  })
  test('rejects wrong type', () => {
    assert.equal(
      parseUnbindRequest({
        type: 'inbound.control.session_repo_bind',
        sessionId: 'sess-1',
        selectionVersion: 1,
      }),
      null,
    )
  })
  test('rejects bad sessionId', () => {
    assert.equal(
      parseUnbindRequest({
        type: 'inbound.control.session_repo_unbind',
        sessionId: 'bad/x',
        selectionVersion: 1,
      }),
      null,
    )
  })
  test('rejects missing selectionVersion (Phase 5 tombstone requirement)', () => {
    // Phase 5 — gateway 用 selectionVersion 做 tombstone-too-old 校验,
    // unbind 帧必须带这个字段;否则 fall-through 到 gateway 会被丢。
    assert.equal(
      parseUnbindRequest({
        type: 'inbound.control.session_repo_unbind',
        sessionId: 'sess-1',
      }),
      null,
    )
  })
  test('rejects non-integer selectionVersion', () => {
    assert.equal(
      parseUnbindRequest({
        type: 'inbound.control.session_repo_unbind',
        sessionId: 'sess-1',
        selectionVersion: 1.5,
      }),
      null,
    )
  })
  test('rejects zero / negative selectionVersion', () => {
    assert.equal(
      parseUnbindRequest({
        type: 'inbound.control.session_repo_unbind',
        sessionId: 'sess-1',
        selectionVersion: 0,
      }),
      null,
    )
    assert.equal(
      parseUnbindRequest({
        type: 'inbound.control.session_repo_unbind',
        sessionId: 'sess-1',
        selectionVersion: -1,
      }),
      null,
    )
  })
  test('rejects selectionVersion > MAX_SAFE_INTEGER', () => {
    assert.equal(
      parseUnbindRequest({
        type: 'inbound.control.session_repo_unbind',
        sessionId: 'sess-1',
        selectionVersion: Number.MAX_SAFE_INTEGER + 1,
      }),
      null,
    )
  })
})

// ─── parseStatusFrame ─────────────────────────────────────────────────

describe('parseStatusFrame', () => {
  test('accepts valid cloning frame', () => {
    const r = parseStatusFrame({
      type: 'outbound.control.session_repo_status',
      sessionId: 'sess-1',
      selectionVersion: 2,
      status: 'cloning',
    })
    assert.ok(r)
    assert.equal(r.status, 'cloning')
    assert.equal(r.headSha, null)
  })
  test('accepts ready with headSha', () => {
    const r = parseStatusFrame({
      type: 'outbound.control.session_repo_status',
      sessionId: 'sess-1',
      selectionVersion: 2,
      status: 'ready',
      headSha: 'abc123',
    })
    assert.ok(r)
    assert.equal(r.headSha, 'abc123')
  })
  test('rejects unknown status', () => {
    assert.equal(
      parseStatusFrame({
        type: 'outbound.control.session_repo_status',
        sessionId: 'sess-1',
        selectionVersion: 2,
        status: 'pending',
      }),
      null,
    )
  })
  test('rejects bad sessionId', () => {
    assert.equal(
      parseStatusFrame({
        type: 'outbound.control.session_repo_status',
        sessionId: 'bad/x',
        selectionVersion: 2,
        status: 'ready',
      }),
      null,
    )
  })
})

// ─── enrichBindRequest ────────────────────────────────────────────────

describe('enrichBindRequest', () => {
  const baseReq = {
    sessionId: 'sess-1',
    selectionVersion: 3,
    peer: { id: 'sess-1', kind: 'dm' as const },
    agentId: 'main',
    channel: 'webchat',
  }

  test('STALE_OR_MISSING when row missing', async () => {
    const { pool } = makeMockPool([{ rowCount: 0, rows: [] }])
    const r = await enrichBindRequest(pool as never, 7, baseReq)
    assert.equal(r.type, 'outbound.control.session_repo_bind_error')
    assert.equal(r.errorCode, 'STALE_OR_MISSING')
  })

  test('STALE_OR_MISSING when version mismatch', async () => {
    const { pool } = makeMockPool([
      { rowCount: 1, rows: [selectionRow({ selection_version: '2' })] }, // user has v2, req v3
    ])
    const r = await enrichBindRequest(pool as never, 7, baseReq)
    assert.equal(r.type, 'outbound.control.session_repo_bind_error')
    if (r.type !== 'outbound.control.session_repo_bind_error') return
    assert.equal(r.errorCode, 'STALE_OR_MISSING')
  })

  test('STALE_OR_MISSING when status=cleared', async () => {
    const { pool } = makeMockPool([
      { rowCount: 1, rows: [selectionRow({ status: 'cleared' })] },
    ])
    const r = await enrichBindRequest(pool as never, 7, baseReq)
    assert.equal(r.type, 'outbound.control.session_repo_bind_error')
    if (r.type !== 'outbound.control.session_repo_bind_error') return
    assert.equal(r.errorCode, 'STALE_OR_MISSING')
  })

  test('INVALID_BIND_PAYLOAD when DB owner has shell-injection char', async () => {
    const { pool } = makeMockPool([
      { rowCount: 1, rows: [selectionRow({ owner: 'oct;rm -rf' })] },
    ])
    const r = await enrichBindRequest(pool as never, 7, baseReq)
    assert.equal(r.type, 'outbound.control.session_repo_bind_error')
    if (r.type !== 'outbound.control.session_repo_bind_error') return
    assert.equal(r.errorCode, 'INVALID_BIND_PAYLOAD')
  })

  test('GITHUB_NOT_LINKED when link missing', async () => {
    const { pool } = makeMockPool([
      { rowCount: 1, rows: [selectionRow()] }, // selection found
      { rowCount: 0, rows: [] },                // link query → 0 rows
    ])
    const r = await enrichBindRequest(pool as never, 7, baseReq)
    assert.equal(r.type, 'outbound.control.session_repo_bind_error')
    if (r.type !== 'outbound.control.session_repo_bind_error') return
    assert.equal(r.errorCode, 'GITHUB_NOT_LINKED')
  })

  test('happy path: returns enriched frame with token', async () => {
    const { ct, nonce } = encToken('ghp_test_12345')
    const { pool } = makeMockPool([
      { rowCount: 1, rows: [selectionRow()] },
      {
        rowCount: 1,
        rows: [
          {
            user_id: '7',
            github_user_id: '100',
            login: 'octocat',
            avatar_url: null,
            access_token_enc: ct,
            access_token_nonce: nonce,
            scopes: 'repo',
            revoked_at: null,
          },
        ],
      },
    ])
    const r = await enrichBindRequest(pool as never, 7, baseReq)
    assert.equal(r.type, 'inbound.control.session_repo_bind')
    if (r.type !== 'inbound.control.session_repo_bind') return
    assert.equal(r.owner, 'octocat')
    assert.equal(r.repo, 'hello-world')
    assert.equal(r.branch, 'main')
    assert.equal(r.accessToken, 'ghp_test_12345')
    assert.equal(r.scopes, 'repo')
    assert.equal(r.peer.id, 'sess-1')
  })
})

// ─── applyStatusFrame ─────────────────────────────────────────────────

describe('applyStatusFrame', () => {
  test('plain status: only versioned UPDATE issued', async () => {
    const { pool, calls } = makeMockPool([
      { rowCount: 1, rows: [] }, // UPDATE github_session_workspaces
    ])
    const r = await applyStatusFrame(pool as never, 7, {
      type: 'outbound.control.session_repo_status',
      sessionId: 'sess-1',
      selectionVersion: 3,
      status: 'ready',
      headSha: 'abc',
    })
    assert.equal(r.dbUpdated, true)
    assert.equal(r.revoked, false)
    assert.equal(calls.length, 1)
    assert.match(calls[0]!.sql, /UPDATE github_session_workspaces/)
  })

  test('failed + token_invalid: revoke runs BEFORE versioned UPDATE', async () => {
    const { pool, calls } = makeMockPool([
      { rowCount: 0, rows: [] }, // BEGIN
      { rowCount: 1, rows: [] }, // UPDATE github_links revoked_at
      { rowCount: 1, rows: [] }, // UPDATE github_session_workspaces clear-all
      { rowCount: 0, rows: [] }, // COMMIT
      { rowCount: 0, rows: [] }, // versioned UPDATE — likely stale (already cleared); rowCount=0 OK
    ])
    const r = await applyStatusFrame(pool as never, 7, {
      type: 'outbound.control.session_repo_status',
      sessionId: 'sess-1',
      selectionVersion: 3,
      status: 'failed',
      errorCode: 'token_invalid',
      errorMessage: 'token expired',
    })
    assert.equal(r.revoked, true)
    assert.equal(r.dbUpdated, false) // versioned UPDATE found 0 (cleared by revoke first)
    // Order: BEGIN → revoke link → clear workspaces → COMMIT → final versioned UPDATE
    assert.match(calls[0]!.sql, /BEGIN/)
    assert.match(calls[1]!.sql, /UPDATE github_links/)
    assert.match(calls[2]!.sql, /UPDATE github_session_workspaces[\s\S]*'cleared'/)
    assert.match(calls[3]!.sql, /COMMIT/)
    assert.match(calls[4]!.sql, /UPDATE github_session_workspaces[\s\S]*selection_version = \$3/)
  })

  test('revoke throws → versioned UPDATE still runs (best-effort revoke)', async () => {
    const calls: MockQueryCall[] = []
    let connectCalls = 0
    const pool: MockPool = {
      async query(sql, params) {
        calls.push({ sql, params })
        return { rowCount: 1, rows: [] }
      },
      async connect() {
        connectCalls++
        return {
          async query(sql: string, params?: unknown[]) {
            calls.push({ sql, params: params ?? [] })
            // throw on revoke 的第一条 SQL after BEGIN
            if (sql.match(/UPDATE github_links/)) {
              throw new Error('pg connection lost')
            }
            return { rowCount: 0, rows: [] }
          },
          release() {
            /* no-op */
          },
        }
      },
    }
    const r = await applyStatusFrame(pool as never, 7, {
      type: 'outbound.control.session_repo_status',
      sessionId: 'sess-1',
      selectionVersion: 3,
      status: 'failed',
      errorCode: 'token_invalid',
    })
    assert.equal(r.revoked, false) // swallowed
    assert.equal(r.dbUpdated, true) // pool.query mock returns 1
    assert.equal(connectCalls, 1)
    // 最后一条必为 versioned UPDATE(走 pool.query 路径)
    assert.match(calls[calls.length - 1]!.sql, /UPDATE github_session_workspaces/)
  })

  test('stale ack (rowCount=0): returns dbUpdated=false, no throw', async () => {
    const { pool } = makeMockPool([{ rowCount: 0, rows: [] }])
    const r = await applyStatusFrame(pool as never, 7, {
      type: 'outbound.control.session_repo_status',
      sessionId: 'sess-1',
      selectionVersion: 1, // stale
      status: 'ready',
    })
    assert.equal(r.dbUpdated, false)
    assert.equal(r.revoked, false)
  })
})

// ─── buildAutoRebindFrames ────────────────────────────────────────────

function selectionObj(over: Partial<GithubSelectionRow> = {}): GithubSelectionRow {
  return {
    userId: 7,
    sessionId: 'sess-1',
    selectionVersion: 3,
    owner: 'octocat',
    repo: 'hello-world',
    branch: 'main',
    defaultBranch: 'main',
    status: 'ready',
    headSha: 'abc',
    errorCode: null,
    errorMessage: null,
    selectedAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }
}

describe('buildAutoRebindFrames', () => {
  test('no hello peer matches: empty result, link not queried', async () => {
    const { pool, calls } = makeMockPool([])
    const m = new Map<string, GithubSelectionRow>([['sess-other', selectionObj()]])
    const r = await buildAutoRebindFrames(pool as never, 7, ['sess-1'], m)
    assert.equal(r.frames.length, 0)
    assert.equal(r.errors.length, 0)
    assert.equal(r.matchedSessionIds.length, 0)
    assert.equal(calls.length, 0) // no DB hit
  })

  test('happy path: matched peers + healthy link → enriched frames', async () => {
    const { ct, nonce } = encToken('ghp_xyz')
    const { pool } = makeMockPool([
      {
        rowCount: 1,
        rows: [
          {
            user_id: '7',
            github_user_id: '100',
            login: 'octocat',
            avatar_url: null,
            access_token_enc: ct,
            access_token_nonce: nonce,
            scopes: 'repo',
            revoked_at: null,
          },
        ],
      },
    ])
    const m = new Map<string, GithubSelectionRow>([
      ['sess-1', selectionObj()],
      ['sess-2', selectionObj({ sessionId: 'sess-2', selectionVersion: 5 })],
    ])
    const r = await buildAutoRebindFrames(
      pool as never,
      7,
      ['sess-1', 'sess-2', 'sess-unrelated'],
      m,
    )
    assert.equal(r.frames.length, 2)
    assert.equal(r.errors.length, 0)
    assert.deepEqual(r.matchedSessionIds.sort(), ['sess-1', 'sess-2'])
    for (const f of r.frames) {
      assert.equal(f.accessToken, 'ghp_xyz')
      assert.equal(f.peer.id, f.sessionId) // peerId === sessionId convention
      assert.equal(f.agentId, 'main')
      assert.equal(f.channel, 'webchat')
    }
  })

  test('link revoked between open and hello → GITHUB_NOT_LINKED per matched row', async () => {
    const { pool } = makeMockPool([
      { rowCount: 0, rows: [] }, // link query: 0 rows = revoked
    ])
    const m = new Map<string, GithubSelectionRow>([
      ['sess-1', selectionObj()],
      ['sess-2', selectionObj({ sessionId: 'sess-2' })],
    ])
    const r = await buildAutoRebindFrames(pool as never, 7, ['sess-1', 'sess-2'], m)
    assert.equal(r.frames.length, 0)
    assert.equal(r.errors.length, 2)
    for (const e of r.errors) assert.equal(e.errorCode, 'GITHUB_NOT_LINKED')
    assert.deepEqual(r.matchedSessionIds.sort(), ['sess-1', 'sess-2'])
  })

  test('row with bad ref → INVALID_BIND_PAYLOAD; healthy rows still produce frames', async () => {
    const { ct, nonce } = encToken('ghp_xyz')
    const { pool } = makeMockPool([
      {
        rowCount: 1,
        rows: [
          {
            user_id: '7',
            github_user_id: '100',
            login: 'octocat',
            avatar_url: null,
            access_token_enc: ct,
            access_token_nonce: nonce,
            scopes: 'repo',
            revoked_at: null,
          },
        ],
      },
    ])
    const m = new Map<string, GithubSelectionRow>([
      ['sess-1', selectionObj({ branch: 'bad branch' })], // invalid: space
      ['sess-2', selectionObj({ sessionId: 'sess-2' })],
    ])
    const r = await buildAutoRebindFrames(pool as never, 7, ['sess-1', 'sess-2'], m)
    assert.equal(r.frames.length, 1)
    assert.equal(r.frames[0]!.sessionId, 'sess-2')
    assert.equal(r.errors.length, 1)
    assert.equal(r.errors[0]!.sessionId, 'sess-1')
    assert.equal(r.errors[0]!.errorCode, 'INVALID_BIND_PAYLOAD')
  })
})

// ─── DAO: listActiveGithubWorkspaceSelections ─────────────────────────

describe('listActiveGithubWorkspaceSelections', () => {
  test('SQL filters by user_id + status IN (pending,cloning,ready), orders by updated_at ASC', async () => {
    const { pool, calls } = makeMockPool([
      {
        rowCount: 2,
        rows: [
          selectionRow({ session_id: 'a' }),
          selectionRow({ session_id: 'b', status: 'cloning' }),
        ],
      },
    ])
    const rows = await listActiveGithubWorkspaceSelections(pool as never, 7)
    assert.equal(rows.length, 2)
    assert.equal(rows[0]!.sessionId, 'a')
    assert.equal(calls.length, 1)
    assert.match(calls[0]!.sql, /FROM github_session_workspaces/)
    assert.match(calls[0]!.sql, /status IN \('pending','cloning','ready'\)/)
    assert.match(calls[0]!.sql, /ORDER BY updated_at ASC/)
    assert.deepEqual(calls[0]!.params, [7])
  })

  test('fetchActiveSelectionsForRebind delegates to listActive', async () => {
    const { pool, calls } = makeMockPool([{ rowCount: 0, rows: [] }])
    const rows = await fetchActiveSelectionsForRebind(pool as never, 7)
    assert.equal(rows.length, 0)
    assert.equal(calls.length, 1)
    assert.match(calls[0]!.sql, /github_session_workspaces/)
  })
})

// ─── DAO: updateGithubWorkspaceStatusIfVersion ────────────────────────

describe('updateGithubWorkspaceStatusIfVersion', () => {
  test('returns updated:true when rowCount>0', async () => {
    const { pool, calls } = makeMockPool([{ rowCount: 1, rows: [] }])
    const r = await updateGithubWorkspaceStatusIfVersion(pool as never, {
      userId: 7,
      sessionId: 'sess-1',
      selectionVersion: 3,
      status: 'ready',
      headSha: 'abc',
    })
    assert.equal(r.updated, true)
    assert.equal(calls.length, 1)
    // version match + cleared lock both in WHERE
    assert.match(calls[0]!.sql, /WHERE user_id\s+= \$1/)
    assert.match(calls[0]!.sql, /AND session_id\s+= \$2/)
    assert.match(calls[0]!.sql, /AND selection_version = \$3/)
    assert.match(calls[0]!.sql, /AND status\s+<> 'cleared'/)
    // params order
    assert.deepEqual(calls[0]!.params.slice(0, 5), [7, 'sess-1', 3, 'ready', 'abc'])
  })

  test('returns updated:false on stale ack (rowCount=0), no throw', async () => {
    const { pool } = makeMockPool([{ rowCount: 0, rows: [] }])
    const r = await updateGithubWorkspaceStatusIfVersion(pool as never, {
      userId: 7,
      sessionId: 'sess-1',
      selectionVersion: 1, // stale
      status: 'ready',
    })
    assert.equal(r.updated, false)
  })

  test('headSha undefined → params[4]=null (preserve via COALESCE in SQL)', async () => {
    const { pool, calls } = makeMockPool([{ rowCount: 1, rows: [] }])
    await updateGithubWorkspaceStatusIfVersion(pool as never, {
      userId: 7,
      sessionId: 'sess-1',
      selectionVersion: 3,
      status: 'cloning',
    })
    assert.equal(calls[0]!.params[4], null) // headSha absent → null in params; SQL uses COALESCE
  })
})
