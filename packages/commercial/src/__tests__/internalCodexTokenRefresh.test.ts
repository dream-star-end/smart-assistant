/**
 * V3 commercial — master-side handler unit tests for the container → master
 * codex token refresh endpoint (P0 of account-pool resilience plan).
 *
 * Covers:
 *   - method whitelist (only POST)
 *   - container identity gate (bad token / bad ip)
 *   - 404 NO_BOUND_ACCOUNT when codex_account_id IS NULL
 *   - 422 ACCOUNT_NOT_FOUND when refresh.ts says account vanished
 *   - 503 NETWORK_TRANSIENT path
 *   - 502 REFRESH_FAILED path
 *   - 200 happy path returns {accessToken, chatgptAccountId, chatgptPlanType}
 *   - 409 CONTAINER_BINDING_CHANGED when row drifts under FOR UPDATE
 *   - 429 RATE_LIMITED on per-(uid,account) burst
 *   - file write failure → 500 FILE_WRITE_FAILED
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/internalCodexTokenRefresh.test.ts
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, test } from 'node:test'

import { RefreshError } from '../account-pool/refresh.js'
import type { ContainerIdentityRepo } from '../auth/containerIdentity.js'
import {
  CODEX_TOKEN_REFRESH_PATH,
  type CodexTokenRefreshDb,
  type CodexTokenRefreshFileWriter,
  type CodexTokenRefreshHandlerCtx,
  type CodexTokenRefreshHandlerDeps,
  type ContainerAccountRow,
  makeCodexTokenRefreshHandler,
} from '../http/internalCodexTokenRefresh.js'
import type { RateLimitRedis } from '../middleware/rateLimit.js'

// ─── fixtures ───────────────────────────────────────────────────────────────

const VALID_SECRET = 'a'.repeat(64)
const VALID_TOKEN = `oc-v3.7.${VALID_SECRET}`
const VALID_HOST = 'host-uuid-1'
const VALID_IP = '172.30.0.5'
const CONTAINER_ID = 7
const USER_ID = 42n
const ACCOUNT_ID = 1001n

// JWT with chatgpt_account_id claim.
// header.payload.signature
function makeJwtWithChatgptAccountId(aid: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: aid },
      sub: 'user',
      exp: 9_999_999_999,
    }),
  ).toString('base64url')
  return `${header}.${payload}.fake-sig`
}

const FRESH_ACCESS_TOKEN = makeJwtWithChatgptAccountId('cgpt-acc-xyz')

function makeRepo(): ContainerIdentityRepo {
  const secretHash = createHash('sha256').update(Buffer.from(VALID_SECRET, 'hex')).digest()
  return {
    async findActiveByHostAndBoundIp(h, ip) {
      if (h !== VALID_HOST || ip !== VALID_IP) return null
      return {
        id: CONTAINER_ID,
        user_id: Number(USER_ID),
        bound_ip: VALID_IP,
        host_uuid: VALID_HOST,
        secret_hash: secretHash,
      }
    },
  }
}

function makeReq(opts: {
  method?: string
  body?: string | Buffer
  auth?: string
  url?: string
}): IncomingMessage {
  const body = opts.body ?? ''
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
  const req = Readable.from(buf.length > 0 ? [buf] : []) as unknown as IncomingMessage
  req.method = opts.method ?? 'POST'
  req.url = opts.url ?? CODEX_TOKEN_REFRESH_PATH
  req.headers = {}
  if (opts.auth) req.headers.authorization = opts.auth
  return req
}

interface RecordedRes {
  status?: number
  headers: Record<string, string | number>
  body: string
  ended: boolean
}

function makeRes(): { res: ServerResponse; rec: RecordedRes } {
  const rec: RecordedRes = { headers: {}, body: '', ended: false }
  const res = {
    headersSent: false,
    setHeader(k: string, v: string | number) {
      rec.headers[String(k).toLowerCase()] = v
    },
    writeHead(status: number, headers: Record<string, string | number>) {
      rec.status = status
      for (const [k, v] of Object.entries(headers)) {
        rec.headers[String(k).toLowerCase()] = v
      }
      ;(this as { headersSent: boolean }).headersSent = true
    },
    end(chunk?: string) {
      if (chunk !== undefined) rec.body += chunk
      rec.ended = true
    },
  } as unknown as ServerResponse
  return { res, rec }
}

const CTX: CodexTokenRefreshHandlerCtx = { hostUuid: VALID_HOST, boundIp: VALID_IP }

/** Permissive rate limit redis stub: never blocks. */
function makeRateLimit(): RateLimitRedis {
  let count = 0
  return {
    async incr() {
      count += 1
      return count
    },
    async expire() {
      return 1
    },
  }
}

/** Rate limit redis that always returns "over the cap" — count starts at 999. */
function makeBlockedRateLimit(): RateLimitRedis {
  let count = 100
  return {
    async incr() {
      count += 1
      return count
    },
    async expire() {
      return 1
    },
  }
}

interface DbStubState {
  initialRow: ContainerAccountRow | null
  /** Row visible *under* FOR UPDATE — defaults to initialRow if not set,
   *  used to inject drift between initial read and lock. */
  lockedRow?: ContainerAccountRow | null
  /** Force txWithLock callback to throw. */
  throwInLock?: Error
}

function makeDb(s: DbStubState): CodexTokenRefreshDb {
  return {
    async readContainerAccount() {
      return s.initialRow
    },
    async txWithLock(_cid, fn) {
      const row = s.lockedRow !== undefined ? s.lockedRow : s.initialRow
      // Pass null for client — handler doesn't use it directly; fine for unit.
      return await fn(null as never, row)
    },
  }
}

interface WriterCalls {
  local: number
  remote: number
  throwLocal?: Error
  throwRemote?: Error
}

function makeWriter(c: WriterCalls): CodexTokenRefreshFileWriter {
  return {
    async writeLocal() {
      c.local += 1
      if (c.throwLocal) throw c.throwLocal
    },
    async writeRemote() {
      c.remote += 1
      if (c.throwRemote) throw c.throwRemote
    },
  }
}

function makeDeps(
  overrides: Partial<CodexTokenRefreshHandlerDeps> = {},
): CodexTokenRefreshHandlerDeps {
  const dbState: DbStubState = {
    initialRow: {
      codexAccountId: ACCOUNT_ID,
      userId: USER_ID,
      state: 'active',
      hostUuid: VALID_HOST,
      accountStatus: 'active',
    },
  }
  const writerCalls: WriterCalls = { local: 0, remote: 0 }
  return {
    identityRepo: makeRepo(),
    db: makeDb(dbState),
    fileWriter: makeWriter(writerCalls),
    codexContainerDir: '/tmp/codex-test',
    containerUid: 1000,
    containerGid: 1000,
    selfHostId: VALID_HOST,
    rateLimitRedis: makeRateLimit(),
    refreshFn: async () => ({
      token: Buffer.from(FRESH_ACCESS_TOKEN, 'utf8'),
      refresh: Buffer.from('new-refresh', 'utf8'),
      expires_at: new Date(Date.now() + 3600_000),
      plan: 'pro',
    }),
    // v1.0.120 feat/codex-disable-rebind:M1 in-turn rebind 默认 stub。
    // 多数旧 case 走"happy refreshFn"分支(accountStatus='active'),不会触发
    // M1 路径,这两个 stub 只在 status!=active 的新 case 才会被调用。
    // 默认返 pool_empty —— 保留旧 case "非 active → 422 ACCOUNT_NOT_ACTIVE"
    // 的可观察结果(老测试用例只断 status code,与新语义"pool 空"匹配)。
    acquireAndPickInTxFn: async () => ({ kind: 'pool_empty' }) as const,
    commitCodexRebindInTxFn: async () => { /* not reached when pool_empty */ },
    fetchSnapshotAndWriteContainerAuthFn: async () => ({
      accessToken: FRESH_ACCESS_TOKEN,
      chatgptAccountId: null,
      lastRefreshIso: new Date().toISOString(),
    }),
    ...overrides,
  }
}

// ─── method + identity gate ─────────────────────────────────────────────────

describe('internalCodexTokenRefresh — method + identity gate', () => {
  test('405 on non-POST', async () => {
    const h = makeCodexTokenRefreshHandler(makeDeps())
    const { res, rec } = makeRes()
    await h(makeReq({ method: 'GET', auth: `Bearer ${VALID_TOKEN}` }), res, CTX)
    assert.equal(rec.status, 405)
  })

  test('401 when bearer missing', async () => {
    const h = makeCodexTokenRefreshHandler(makeDeps())
    const { res, rec } = makeRes()
    await h(makeReq({ body: '{}' }), res, CTX)
    assert.equal(rec.status, 401)
  })

  test('401 when (host,ip) does not match repo', async () => {
    const h = makeCodexTokenRefreshHandler(makeDeps())
    const { res, rec } = makeRes()
    await h(makeReq({ body: '{}', auth: `Bearer ${VALID_TOKEN}` }), res, {
      hostUuid: 'other-host',
      boundIp: '1.2.3.4',
    })
    assert.equal(rec.status, 401)
  })

  test('401 when secret mismatches', async () => {
    const wrongSecret = 'b'.repeat(64)
    const h = makeCodexTokenRefreshHandler(makeDeps())
    const { res, rec } = makeRes()
    await h(makeReq({ body: '{}', auth: `Bearer oc-v3.7.${wrongSecret}` }), res, CTX)
    assert.equal(rec.status, 401)
  })
})

// ─── happy path ─────────────────────────────────────────────────────────────

describe('internalCodexTokenRefresh — happy path', () => {
  test('200 returns {accessToken, chatgptAccountId, chatgptPlanType}', async () => {
    const writer: WriterCalls = { local: 0, remote: 0 }
    const h = makeCodexTokenRefreshHandler(
      makeDeps({
        fileWriter: makeWriter(writer),
      }),
    )
    const { res, rec } = makeRes()
    await h(
      makeReq({
        body: JSON.stringify({ reason: 'unauthorized', previousAccountId: null }),
        auth: `Bearer ${VALID_TOKEN}`,
      }),
      res,
      CTX,
    )
    assert.equal(rec.status, 200)
    const body = JSON.parse(rec.body)
    assert.equal(body.accessToken, FRESH_ACCESS_TOKEN)
    assert.equal(body.chatgptAccountId, 'cgpt-acc-xyz')
    assert.equal(body.chatgptPlanType, 'pro')
    assert.equal(writer.local, 1, 'wrote local auth.json once')
    assert.equal(writer.remote, 0, 'no remote write on self-host row')
  })

  test('200 even when body is empty (codex sometimes drops params)', async () => {
    const h = makeCodexTokenRefreshHandler(makeDeps())
    const { res, rec } = makeRes()
    await h(makeReq({ auth: `Bearer ${VALID_TOKEN}` }), res, CTX)
    assert.equal(rec.status, 200)
  })

  test('200 routes to remote writer when host_uuid != self', async () => {
    const writer: WriterCalls = { local: 0, remote: 0 }
    const dbState: DbStubState = {
      initialRow: {
        codexAccountId: ACCOUNT_ID,
        userId: USER_ID,
        state: 'active',
        hostUuid: 'other-host-uuid',
        accountStatus: 'active',
      },
    }
    const h = makeCodexTokenRefreshHandler(
      makeDeps({
        db: makeDb(dbState),
        fileWriter: makeWriter(writer),
        // selfHostId stays VALID_HOST → routing decides remote
      }),
    )
    const { res, rec } = makeRes()
    await h(makeReq({ body: '{}', auth: `Bearer ${VALID_TOKEN}` }), res, CTX)
    assert.equal(rec.status, 200)
    assert.equal(writer.local, 0)
    assert.equal(writer.remote, 1)
  })
})

// ─── error mapping ──────────────────────────────────────────────────────────

describe('internalCodexTokenRefresh — error mapping', () => {
  test('404 NO_BOUND_ACCOUNT when codex_account_id IS NULL', async () => {
    const dbState: DbStubState = {
      initialRow: {
        codexAccountId: null,
        userId: USER_ID,
        state: 'active',
        hostUuid: VALID_HOST,
        accountStatus: 'active',
      },
    }
    const h = makeCodexTokenRefreshHandler(makeDeps({ db: makeDb(dbState) }))
    const { res, rec } = makeRes()
    await h(makeReq({ body: '{}', auth: `Bearer ${VALID_TOKEN}` }), res, CTX)
    assert.equal(rec.status, 404)
    const body = JSON.parse(rec.body)
    assert.equal(body.error.code, 'NO_BOUND_ACCOUNT')
  })

  test('422 ACCOUNT_NOT_FOUND when refresh.ts says account vanished', async () => {
    const h = makeCodexTokenRefreshHandler(
      makeDeps({
        refreshFn: async () => {
          throw new RefreshError('account_not_found', 'gone')
        },
      }),
    )
    const { res, rec } = makeRes()
    await h(makeReq({ body: '{}', auth: `Bearer ${VALID_TOKEN}` }), res, CTX)
    assert.equal(rec.status, 422)
    assert.equal(JSON.parse(rec.body).error.code, 'ACCOUNT_NOT_FOUND')
  })

  test('503 NETWORK_TRANSIENT with Retry-After header', async () => {
    const h = makeCodexTokenRefreshHandler(
      makeDeps({
        refreshFn: async () => {
          throw new RefreshError('network_transient', 'flaked')
        },
      }),
    )
    const { res, rec } = makeRes()
    await h(makeReq({ body: '{}', auth: `Bearer ${VALID_TOKEN}` }), res, CTX)
    assert.equal(rec.status, 503)
    assert.equal(JSON.parse(rec.body).error.code, 'NETWORK_TRANSIENT')
    assert.equal(rec.headers['retry-after'], '1')
  })

  test('502 REFRESH_FAILED on http_error / bad_response / persist_error', async () => {
    for (const code of [
      'http_error',
      'bad_response',
      'persist_error',
      'no_refresh_token',
    ] as const) {
      const h = makeCodexTokenRefreshHandler(
        makeDeps({
          refreshFn: async () => {
            throw new RefreshError(code, `${code} occurred`)
          },
        }),
      )
      const { res, rec } = makeRes()
      await h(makeReq({ body: '{}', auth: `Bearer ${VALID_TOKEN}` }), res, CTX)
      assert.equal(rec.status, 502, `code=${code} should map to 502`)
      assert.equal(JSON.parse(rec.body).error.code, 'REFRESH_FAILED')
    }
  })

  test('429 RATE_LIMITED with Retry-After when over cap', async () => {
    const h = makeCodexTokenRefreshHandler(makeDeps({ rateLimitRedis: makeBlockedRateLimit() }))
    const { res, rec } = makeRes()
    await h(makeReq({ body: '{}', auth: `Bearer ${VALID_TOKEN}` }), res, CTX)
    assert.equal(rec.status, 429)
    assert.equal(JSON.parse(rec.body).error.code, 'RATE_LIMITED')
    assert.ok(rec.headers['retry-after'], 'must include Retry-After')
  })

  test('500 FILE_WRITE_FAILED when writer throws', async () => {
    const h = makeCodexTokenRefreshHandler(
      makeDeps({
        fileWriter: makeWriter({ local: 0, remote: 0, throwLocal: new Error('disk full') }),
      }),
    )
    const { res, rec } = makeRes()
    await h(makeReq({ body: '{}', auth: `Bearer ${VALID_TOKEN}` }), res, CTX)
    assert.equal(rec.status, 500)
    assert.equal(JSON.parse(rec.body).error.code, 'FILE_WRITE_FAILED')
  })

  // codex round 2 BLOCKER#2:bound 账号非 active 时拒刷
  test('422 ACCOUNT_NOT_ACTIVE when bound account.status=disabled', async () => {
    const dbState: DbStubState = {
      initialRow: {
        codexAccountId: ACCOUNT_ID,
        userId: USER_ID,
        state: 'active',
        hostUuid: VALID_HOST,
        accountStatus: 'disabled',
      },
    }
    let refreshCalled = false
    const writer: WriterCalls = { local: 0, remote: 0 }
    const h = makeCodexTokenRefreshHandler(
      makeDeps({
        db: makeDb(dbState),
        fileWriter: makeWriter(writer),
        refreshFn: async () => {
          refreshCalled = true
          return {
            token: Buffer.from(FRESH_ACCESS_TOKEN, 'utf8'),
            refresh: null,
            expires_at: new Date(Date.now() + 3600_000),
            plan: 'pro',
          }
        },
      }),
    )
    const { res, rec } = makeRes()
    await h(makeReq({ body: '{}', auth: `Bearer ${VALID_TOKEN}` }), res, CTX)
    assert.equal(rec.status, 422)
    assert.equal(JSON.parse(rec.body).error.code, 'ACCOUNT_NOT_ACTIVE')
    assert.equal(refreshCalled, false, 'must not call upstream refresh for non-active account')
    assert.equal(writer.local, 0, 'must not write auth.json for non-active account')
  })

  test('422 ACCOUNT_NOT_ACTIVE when bound account.status=quarantined', async () => {
    const dbState: DbStubState = {
      initialRow: {
        codexAccountId: ACCOUNT_ID,
        userId: USER_ID,
        state: 'active',
        hostUuid: VALID_HOST,
        accountStatus: 'quarantined',
      },
    }
    const h = makeCodexTokenRefreshHandler(makeDeps({ db: makeDb(dbState) }))
    const { res, rec } = makeRes()
    await h(makeReq({ body: '{}', auth: `Bearer ${VALID_TOKEN}` }), res, CTX)
    assert.equal(rec.status, 422)
    assert.equal(JSON.parse(rec.body).error.code, 'ACCOUNT_NOT_ACTIVE')
  })

  test('422 ACCOUNT_NOT_ACTIVE when bound account vanished from claude_accounts (left join NULL)', async () => {
    const dbState: DbStubState = {
      initialRow: {
        codexAccountId: ACCOUNT_ID,
        userId: USER_ID,
        state: 'active',
        hostUuid: VALID_HOST,
        accountStatus: null, // LEFT JOIN miss — admin deleted account row
      },
    }
    const h = makeCodexTokenRefreshHandler(makeDeps({ db: makeDb(dbState) }))
    const { res, rec } = makeRes()
    await h(makeReq({ body: '{}', auth: `Bearer ${VALID_TOKEN}` }), res, CTX)
    assert.equal(rec.status, 422)
    assert.equal(JSON.parse(rec.body).error.code, 'ACCOUNT_NOT_ACTIVE')
  })
})

// ─── drift detection (FOR UPDATE recheck) ───────────────────────────────────

describe('internalCodexTokenRefresh — drift under FOR UPDATE', () => {
  test('409 CONTAINER_BINDING_CHANGED when state drifts to vanished under lock', async () => {
    const dbState: DbStubState = {
      initialRow: {
        codexAccountId: ACCOUNT_ID,
        userId: USER_ID,
        state: 'active',
        hostUuid: VALID_HOST,
        accountStatus: 'active',
      },
      lockedRow: {
        codexAccountId: ACCOUNT_ID,
        userId: USER_ID,
        state: 'vanished',
        hostUuid: VALID_HOST,
        accountStatus: 'active',
      },
    }
    const writer: WriterCalls = { local: 0, remote: 0 }
    const h = makeCodexTokenRefreshHandler(
      makeDeps({ db: makeDb(dbState), fileWriter: makeWriter(writer) }),
    )
    const { res, rec } = makeRes()
    await h(makeReq({ body: '{}', auth: `Bearer ${VALID_TOKEN}` }), res, CTX)
    assert.equal(rec.status, 409)
    assert.equal(JSON.parse(rec.body).error.code, 'CONTAINER_BINDING_CHANGED')
    assert.equal(writer.local, 0, 'must not write file when drift detected')
  })

  test('409 when account_id rebinds to a different account under lock', async () => {
    const dbState: DbStubState = {
      initialRow: {
        codexAccountId: ACCOUNT_ID,
        userId: USER_ID,
        state: 'active',
        hostUuid: VALID_HOST,
        accountStatus: 'active',
      },
      lockedRow: {
        codexAccountId: ACCOUNT_ID + 1n, // lazy migrate switched binding
        userId: USER_ID,
        state: 'active',
        hostUuid: VALID_HOST,
        accountStatus: 'active',
      },
    }
    const writer: WriterCalls = { local: 0, remote: 0 }
    const h = makeCodexTokenRefreshHandler(
      makeDeps({ db: makeDb(dbState), fileWriter: makeWriter(writer) }),
    )
    const { res, rec } = makeRes()
    await h(makeReq({ body: '{}', auth: `Bearer ${VALID_TOKEN}` }), res, CTX)
    assert.equal(rec.status, 409)
    assert.equal(writer.local, 0)
  })

  // codex round 2 BLOCKER#2:account 在 refresh 后/锁内变非 active 时不写 auth.json
  test('409 when bound account becomes non-active under lock (admin disabled mid-flight)', async () => {
    const dbState: DbStubState = {
      initialRow: {
        codexAccountId: ACCOUNT_ID,
        userId: USER_ID,
        state: 'active',
        hostUuid: VALID_HOST,
        accountStatus: 'active',
      },
      lockedRow: {
        codexAccountId: ACCOUNT_ID,
        userId: USER_ID,
        state: 'active',
        hostUuid: VALID_HOST,
        accountStatus: 'disabled', // disabled by admin between read and lock
      },
    }
    const writer: WriterCalls = { local: 0, remote: 0 }
    const h = makeCodexTokenRefreshHandler(
      makeDeps({ db: makeDb(dbState), fileWriter: makeWriter(writer) }),
    )
    const { res, rec } = makeRes()
    await h(makeReq({ body: '{}', auth: `Bearer ${VALID_TOKEN}` }), res, CTX)
    assert.equal(rec.status, 409)
    assert.equal(JSON.parse(rec.body).error.code, 'CONTAINER_BINDING_CHANGED')
    assert.equal(writer.local, 0)
  })

  // codex round 2 非阻塞建议:user_mismatch 用 409 而非 401
  test('409 when user_id changes under lock (cross-tenant rebind)', async () => {
    const dbState: DbStubState = {
      initialRow: {
        codexAccountId: ACCOUNT_ID,
        userId: USER_ID,
        state: 'active',
        hostUuid: VALID_HOST,
        accountStatus: 'active',
      },
      lockedRow: {
        codexAccountId: ACCOUNT_ID,
        userId: USER_ID + 1n, // different tenant somehow
        state: 'active',
        hostUuid: VALID_HOST,
        accountStatus: 'active',
      },
    }
    const writer: WriterCalls = { local: 0, remote: 0 }
    const h = makeCodexTokenRefreshHandler(
      makeDeps({ db: makeDb(dbState), fileWriter: makeWriter(writer) }),
    )
    const { res, rec } = makeRes()
    await h(makeReq({ body: '{}', auth: `Bearer ${VALID_TOKEN}` }), res, CTX)
    assert.equal(rec.status, 409)
    assert.equal(JSON.parse(rec.body).error.code, 'CONTAINER_BINDING_CHANGED')
    assert.equal(writer.local, 0)
  })

  test('409 when locked row vanishes (deleted between identity & lock)', async () => {
    const dbState: DbStubState = {
      initialRow: {
        codexAccountId: ACCOUNT_ID,
        userId: USER_ID,
        state: 'active',
        hostUuid: VALID_HOST,
        accountStatus: 'active',
      },
      lockedRow: null,
    }
    const writer: WriterCalls = { local: 0, remote: 0 }
    const h = makeCodexTokenRefreshHandler(
      makeDeps({ db: makeDb(dbState), fileWriter: makeWriter(writer) }),
    )
    const { res, rec } = makeRes()
    await h(makeReq({ body: '{}', auth: `Bearer ${VALID_TOKEN}` }), res, CTX)
    assert.equal(rec.status, 409)
    assert.equal(writer.local, 0)
  })
})

// ─── post-tx ordering (v1.0.116 wedge fix) ──────────────────────────────────
//
// v1.0.115 wrote auth.json INSIDE the FOR UPDATE callback, which serialized
// 60s remote node-agent PUTs on PG pool clients and wedged the master under
// codex 401 bursts. v1.0.116 moves the file write OUT of the tx callback.
// These tests pin the new ordering so a future regression cannot silently
// re-enter-tx without breaking the suite.

describe('internalCodexTokenRefresh — post-tx ordering (file write outside FOR UPDATE)', () => {
  function makeOrderingDb(state: DbStubState, events: string[]): CodexTokenRefreshDb {
    return {
      async readContainerAccount() {
        events.push('readContainerAccount')
        return state.initialRow
      },
      async txWithLock(_cid, fn) {
        events.push('tx:begin')
        const row = state.lockedRow !== undefined ? state.lockedRow : state.initialRow
        const result = await fn(null as never, row)
        events.push('tx:commit')
        return result
      },
    }
  }

  function makeOrderingWriter(
    events: string[],
    opts?: { throwRemote?: Error },
  ): CodexTokenRefreshFileWriter {
    return {
      async writeLocal() {
        events.push('writeLocal')
      },
      async writeRemote() {
        events.push('writeRemote')
        if (opts?.throwRemote) throw opts.throwRemote
      },
    }
  }

  test('writeLocal happens AFTER tx:commit (not inside FOR UPDATE callback)', async () => {
    const events: string[] = []
    const dbState: DbStubState = {
      initialRow: {
        codexAccountId: ACCOUNT_ID,
        userId: USER_ID,
        state: 'active',
        hostUuid: VALID_HOST,
        accountStatus: 'active',
      },
    }
    const h = makeCodexTokenRefreshHandler(
      makeDeps({
        db: makeOrderingDb(dbState, events),
        fileWriter: makeOrderingWriter(events),
      }),
    )
    const { res, rec } = makeRes()
    await h(makeReq({ body: '{}', auth: `Bearer ${VALID_TOKEN}` }), res, CTX)
    assert.equal(rec.status, 200)
    // Critical: writeLocal must come AFTER tx:commit, not between begin/commit.
    assert.deepEqual(events, ['readContainerAccount', 'tx:begin', 'tx:commit', 'writeLocal'])
  })

  test('writeRemote happens AFTER tx:commit when host_uuid != self', async () => {
    const events: string[] = []
    const dbState: DbStubState = {
      initialRow: {
        codexAccountId: ACCOUNT_ID,
        userId: USER_ID,
        state: 'active',
        hostUuid: 'other-host-uuid',
        accountStatus: 'active',
      },
    }
    const h = makeCodexTokenRefreshHandler(
      makeDeps({
        db: makeOrderingDb(dbState, events),
        fileWriter: makeOrderingWriter(events),
      }),
    )
    const { res, rec } = makeRes()
    await h(makeReq({ body: '{}', auth: `Bearer ${VALID_TOKEN}` }), res, CTX)
    assert.equal(rec.status, 200)
    assert.deepEqual(events, ['readContainerAccount', 'tx:begin', 'tx:commit', 'writeRemote'])
  })

  test('500 FILE_WRITE_FAILED when writeRemote rejects — tx already committed', async () => {
    const events: string[] = []
    const dbState: DbStubState = {
      initialRow: {
        codexAccountId: ACCOUNT_ID,
        userId: USER_ID,
        state: 'active',
        hostUuid: 'other-host-uuid',
        accountStatus: 'active',
      },
    }
    const h = makeCodexTokenRefreshHandler(
      makeDeps({
        db: makeOrderingDb(dbState, events),
        fileWriter: makeOrderingWriter(events, {
          throwRemote: new Error('node-agent unreachable'),
        }),
      }),
    )
    const { res, rec } = makeRes()
    await h(makeReq({ body: '{}', auth: `Bearer ${VALID_TOKEN}` }), res, CTX)
    assert.equal(rec.status, 500)
    assert.equal(JSON.parse(rec.body).error.code, 'FILE_WRITE_FAILED')
    // tx must have committed before writeRemote ran (so no PG client is
    // held while the remote PUT is in-flight).
    assert.deepEqual(events, ['readContainerAccount', 'tx:begin', 'tx:commit', 'writeRemote'])
  })

  test('drift short-circuits before any writer call (tx commits, writer never runs)', async () => {
    const events: string[] = []
    const dbState: DbStubState = {
      initialRow: {
        codexAccountId: ACCOUNT_ID,
        userId: USER_ID,
        state: 'active',
        hostUuid: VALID_HOST,
        accountStatus: 'active',
      },
      lockedRow: {
        codexAccountId: ACCOUNT_ID + 1n, // rebound under lock
        userId: USER_ID,
        state: 'active',
        hostUuid: VALID_HOST,
        accountStatus: 'active',
      },
    }
    const h = makeCodexTokenRefreshHandler(
      makeDeps({
        db: makeOrderingDb(dbState, events),
        fileWriter: makeOrderingWriter(events),
      }),
    )
    const { res, rec } = makeRes()
    await h(makeReq({ body: '{}', auth: `Bearer ${VALID_TOKEN}` }), res, CTX)
    assert.equal(rec.status, 409)
    assert.deepEqual(events, ['readContainerAccount', 'tx:begin', 'tx:commit'])
  })
})
