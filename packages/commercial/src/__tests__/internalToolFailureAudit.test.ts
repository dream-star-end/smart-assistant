/**
 * Unit tests for /internal/v3/agent-audit/tool-failure.
 * Run: npx tsx --test packages/commercial/src/__tests__/internalToolFailureAudit.test.ts
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, test } from 'node:test'

import { type ContainerIdentityRepo, hashSecret } from '../auth/containerIdentity.js'
import {
  type QueryRunner,
  TOOL_AUDIT_SCHEMA_HEADER,
  TOOL_FAILURE_AUDIT_PATH,
  type ToolCallRollupBody,
  type ToolFailureAuditBodyV1,
  type ToolFailureAuditBodyV2,
  type ToolFailureAuditBodyV3,
  insertToolCallRollup,
  insertToolFailureAudit,
  isToolFailureAuditEnabled,
  makeToolCallRollupHandler,
  makeToolFailureAuditHandler,
} from '../http/internalToolFailureAudit.js'

const SECRET = 'a'.repeat(64)
const TOKEN = `oc-v3.7.${SECRET}`
const CTX = { hostUuid: 'host-1', boundIp: '172.31.0.7' }
const NOW_MS = 1_750_000_000_000

function repoFor(userId = 42): ContainerIdentityRepo {
  return {
    async findActiveByHostAndBoundIp(hostUuid, boundIp) {
      if (hostUuid !== CTX.hostUuid || boundIp !== CTX.boundIp) return null
      return {
        id: 7,
        user_id: userId,
        bound_ip: boundIp,
        host_uuid: hostUuid,
        secret_hash: hashSecret(SECRET),
      }
    },
  }
}

function body(overrides: Partial<ToolFailureAuditBodyV1> = {}): ToolFailureAuditBodyV1 {
  return {
    schemaVersion: 1,
    eventId: 'evt-1',
    sessionKey: 'agent:codex:webchat:dm:sess1',
    agentId: 'codex',
    turnIndex: 3,
    toolName: 'Bash',
    durationMs: 12,
    inputPreview: '{"cmd":"bad"}',
    outputPreview: 'failed',
    timestamp: NOW_MS - 3_000,
    ...overrides,
  }
}

function bodyV2(overrides: Partial<ToolFailureAuditBodyV2> = {}): ToolFailureAuditBodyV2 {
  return {
    schemaVersion: 2,
    eventId: 'evt-v2',
    sessionKey: 'agent:codex:webchat:dm:sess2',
    agentId: 'codex',
    turnIndex: 4,
    toolName: 'Glob',
    durationMs: 19,
    inputHash: 'a'.repeat(64),
    outputHash: 'b'.repeat(64),
    errorClass: 'file_not_found',
    timestamp: NOW_MS - 2_000,
    ...overrides,
  }
}

function bodyV3(overrides: Partial<ToolFailureAuditBodyV3> = {}): ToolFailureAuditBodyV3 {
  return {
    schemaVersion: 3,
    eventId: 'evt-v3',
    sessionKey: 'agent:codex:webchat:dm:sess3',
    agentId: 'codex',
    turnIndex: 5,
    toolName: 'Bash',
    durationMs: 23,
    inputHash: 'c'.repeat(64),
    outputHash: 'd'.repeat(64),
    errorClass: 'command_not_found',
    failureKind: 'process_exit',
    exitCode: 127,
    terminationReason: 'exit_code',
    timestamp: NOW_MS - 1_000,
    ...overrides,
  }
}

function rollupBody(overrides: Partial<ToolCallRollupBody> = {}): ToolCallRollupBody {
  return {
    schemaVersion: 1,
    reportId: '1'.repeat(32),
    reporterRunId: '2'.repeat(32),
    sequence: 1,
    windowStartedAt: NOW_MS - 5 * 60_000,
    windowEndedAt: NOW_MS,
    counts: [
      {
        agentId: 'main',
        toolName: 'Bash',
        outcome: 'success',
        errorClass: 'none',
        failureKind: 'none',
        count: 4,
      },
      {
        agentId: 'main',
        toolName: 'Bash',
        outcome: 'failure',
        errorClass: 'process_exit',
        failureKind: 'process_exit',
        count: 1,
      },
    ],
    ...overrides,
  }
}

function makeReq(opts: { method?: string; auth?: string; body?: unknown }): IncomingMessage {
  const raw = opts.body === undefined ? '' : JSON.stringify(opts.body)
  const req = Readable.from(raw ? [Buffer.from(raw)] : []) as unknown as IncomingMessage
  req.method = opts.method ?? 'POST'
  req.url = TOOL_FAILURE_AUDIT_PATH
  req.headers = {}
  if (opts.auth) req.headers.authorization = opts.auth
  return req
}

function makeRes(): ServerResponse & { body: any; headers: Record<string, string | number> } {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string | number>,
    setHeader(k: string, v: string | number) {
      this.headers[k.toLowerCase()] = v
    },
    end(s?: string) {
      ;(this as any).body = s ? JSON.parse(s) : {}
    },
  }
  return res as unknown as ServerResponse & {
    body: any
    headers: Record<string, string | number>
  }
}

function fakeResult(rows: any[] = []) {
  return { rows, rowCount: rows.length }
}

describe('isToolFailureAuditEnabled', () => {
  test('route gate requires explicit OC_TOOL_FAILURE_AUDIT=1', () => {
    // 未开启 → index.ts 不注册路由(path 落到 internalProxyHandler 返 404,
    // 容器侧 fatal-drop),与"功能未部署"等价;防合回 v3 时静默对现网开启遥测。
    assert.equal(isToolFailureAuditEnabled({}), false)
    assert.equal(isToolFailureAuditEnabled({ OC_TOOL_FAILURE_AUDIT: '0' }), false)
    assert.equal(isToolFailureAuditEnabled({ OC_TOOL_FAILURE_AUDIT: 'true' }), false)
    assert.equal(isToolFailureAuditEnabled({ OC_TOOL_FAILURE_AUDIT: ' 1' }), false)
    assert.equal(isToolFailureAuditEnabled({ OC_TOOL_FAILURE_AUDIT: '1' }), true)
  })
})

describe('insertToolFailureAudit', () => {
  test('accepts legacy v1 during rolling upgrade but persists hashes and category only', async () => {
    const calls: Array<{ sql: string; params?: readonly unknown[] }> = []
    const runner: QueryRunner = {
      async query(sql, params) {
        calls.push({ sql, params })
        return calls.length === 1 ? fakeResult([]) : fakeResult([])
      },
    }
    assert.deepEqual(await insertToolFailureAudit(runner, 42, body()), { duplicate: false })
    assert.equal(calls.length, 2)
    assert.match(calls[1].sql, /INSERT INTO agent_audit/)
    assert.equal(calls[1].params?.[0], 42)
    assert.equal(calls[1].params?.[1], body().sessionKey)
    assert.equal(calls[1].params?.[2], 'Bash')
    assert.equal(calls[1].params?.[6], 12)
    const meta = JSON.parse(String(calls[1].params?.[3]))
    assert.equal(meta.error_class, 'other')
    assert.equal('input_preview' in meta, false)
    assert.equal(calls[1].params?.[4], createHash('sha256').update('{"cmd":"bad"}').digest('hex'))
    assert.equal(calls[1].params?.[5], createHash('sha256').update('failed').digest('hex'))
    assert.equal(calls[1].params?.[7], null)

    const dupRunner: QueryRunner = {
      async query() {
        return fakeResult([{ id: '99' }])
      },
    }
    assert.deepEqual(await insertToolFailureAudit(dupRunner, 42, body()), { duplicate: true })
  })

  test('persists v2 hashes and category without raw error text', async () => {
    const calls: Array<{ sql: string; params?: readonly unknown[] }> = []
    const runner: QueryRunner = {
      async query(sql, params) {
        calls.push({ sql, params })
        return fakeResult([])
      },
    }
    assert.deepEqual(await insertToolFailureAudit(runner, 42, bodyV2()), { duplicate: false })
    const meta = JSON.parse(String(calls[1].params?.[3]))
    assert.deepEqual(meta.error_class, 'file_not_found')
    assert.equal(calls[1].params?.[4], 'a'.repeat(64))
    assert.equal(calls[1].params?.[5], 'b'.repeat(64))
    assert.equal(calls[1].params?.[7], null)
  })

  test('persists v3 bounded metadata without raw previews', async () => {
    const calls: Array<{ sql: string; params?: readonly unknown[] }> = []
    const runner: QueryRunner = {
      async query(sql, params) {
        calls.push({ sql, params })
        return fakeResult([])
      },
    }
    assert.deepEqual(await insertToolFailureAudit(runner, 42, bodyV3()), { duplicate: false })
    const meta = JSON.parse(String(calls[1].params?.[3]))
    assert.deepEqual(meta, {
      schema_version: 3,
      event_id: 'evt-v3',
      agent_id: 'codex',
      turn_index: 5,
      timestamp: NOW_MS - 1_000,
      error_class: 'command_not_found',
      failure_kind: 'process_exit',
      exit_code: 127,
      termination_reason: 'exit_code',
    })
    assert.equal(JSON.stringify(meta).includes('cmd'), false)
    assert.equal(calls[1].params?.[7], null)
    assert.equal(calls[1].params?.[8], NOW_MS - 1_000)
  })
})

describe('insertToolCallRollup', () => {
  test('uses one atomic CTE and derives user/container outside payload', async () => {
    const calls: Array<{ sql: string; params?: readonly unknown[] }> = []
    const runner: QueryRunner = {
      async query(sql, params) {
        calls.push({ sql, params })
        return fakeResult([{ inserted: true }])
      },
    }
    assert.deepEqual(await insertToolCallRollup(runner, 42, 7, rollupBody()), { duplicate: false })
    assert.equal(calls.length, 1)
    assert.match(calls[0].sql, /WITH inserted_report AS/)
    assert.match(calls[0].sql, /jsonb_to_recordset/)
    assert.equal(calls[0].params?.[1], 42)
    assert.equal(calls[0].params?.[2], 7)
    assert.equal(String(calls[0].params?.[7]).includes('private'), false)

    const duplicateRunner: QueryRunner = {
      async query() {
        return fakeResult([{ inserted: false }])
      },
    }
    assert.deepEqual(await insertToolCallRollup(duplicateRunner, 42, 7, rollupBody()), {
      duplicate: true,
    })
  })
})

describe('tool failure audit handler', () => {
  test('rejects missing bearer and non-POST', async () => {
    const h = makeToolFailureAuditHandler({
      identityRepo: repoFor(),
      queryRunner: {
        async query() {
          return fakeResult([])
        },
      },
      now: () => NOW_MS,
    })
    let res = makeRes()
    await h(makeReq({ auth: `Bearer ${TOKEN}`, method: 'GET', body: body() }), res, CTX)
    assert.equal(res.statusCode, 405)
    assert.equal(res.headers[TOOL_AUDIT_SCHEMA_HEADER.toLowerCase()], '3')

    res = makeRes()
    await h(makeReq({ body: body() }), res, CTX)
    assert.equal(res.statusCode, 401)
  })

  test('valid report inserts and duplicate returns ok', async () => {
    let selectRows: any[] = []
    const runner: QueryRunner = {
      async query(sql) {
        return /SELECT/.test(sql) ? fakeResult(selectRows) : fakeResult([])
      },
    }
    const h = makeToolFailureAuditHandler({
      identityRepo: repoFor(99),
      queryRunner: runner,
      now: () => NOW_MS,
    })
    let res = makeRes()
    await h(makeReq({ auth: `Bearer ${TOKEN}`, body: body() }), res, CTX)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.ok, true)
    assert.equal(res.body.duplicate, false)

    selectRows = [{ id: '1' }]
    res = makeRes()
    await h(makeReq({ auth: `Bearer ${TOKEN}`, body: body() }), res, CTX)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.duplicate, true)
  })

  test('accepts privacy-safe v2 and rejects malformed hashes/categories', async () => {
    const runner: QueryRunner = {
      async query() {
        return fakeResult([])
      },
    }
    const h = makeToolFailureAuditHandler({
      identityRepo: repoFor(),
      queryRunner: runner,
      now: () => NOW_MS,
    })

    let res = makeRes()
    await h(makeReq({ auth: `Bearer ${TOKEN}`, body: bodyV2() }), res, CTX)
    assert.equal(res.statusCode, 200)

    res = makeRes()
    await h(
      makeReq({ auth: `Bearer ${TOKEN}`, body: bodyV2({ inputHash: 'raw-secret' }) }),
      res,
      CTX,
    )
    assert.equal(res.statusCode, 400)

    res = makeRes()
    await h(
      makeReq({ auth: `Bearer ${TOKEN}`, body: { ...bodyV2(), errorClass: 'free-form error' } }),
      res,
      CTX,
    )
    assert.equal(res.statusCode, 400)
  })

  test('accepts schema v3 and rejects unbounded structured metadata', async () => {
    const runner: QueryRunner = {
      async query() {
        return fakeResult([])
      },
    }
    const h = makeToolFailureAuditHandler({
      identityRepo: repoFor(),
      queryRunner: runner,
      now: () => NOW_MS,
    })

    let res = makeRes()
    await h(makeReq({ auth: `Bearer ${TOKEN}`, body: bodyV3() }), res, CTX)
    assert.equal(res.statusCode, 200)

    res = makeRes()
    await h(makeReq({ auth: `Bearer ${TOKEN}`, body: bodyV3({ exitCode: 256 }) }), res, CTX)
    assert.equal(res.statusCode, 400)

    res = makeRes()
    await h(
      makeReq({
        auth: `Bearer ${TOKEN}`,
        body: { ...bodyV3(), terminationReason: 'raw signal detail' },
      }),
      res,
      CTX,
    )
    assert.equal(res.statusCode, 400)
  })

  test('invalid body returns 400', async () => {
    const h = makeToolFailureAuditHandler({
      identityRepo: repoFor(),
      queryRunner: {
        async query() {
          return fakeResult([])
        },
      },
      now: () => NOW_MS,
    })
    const res = makeRes()
    await h(makeReq({ auth: `Bearer ${TOKEN}`, body: { schemaVersion: 1, eventId: '' } }), res, CTX)
    assert.equal(res.statusCode, 400)
  })

  test('accepts queue-age/future-skew boundaries and rejects timestamps outside them', async () => {
    const h = makeToolFailureAuditHandler({
      identityRepo: repoFor(),
      queryRunner: { async query() { return fakeResult([]) } },
      now: () => NOW_MS,
    })
    for (const timestamp of [NOW_MS - 25 * 60 * 60_000, NOW_MS + 10 * 60_000]) {
      const res = makeRes()
      await h(makeReq({ auth: `Bearer ${TOKEN}`, body: bodyV3({ timestamp }) }), res, CTX)
      assert.equal(res.statusCode, 200)
    }
    for (const timestamp of [
      NOW_MS - 25 * 60 * 60_000 - 1,
      NOW_MS + 10 * 60_000 + 1,
    ]) {
      const res = makeRes()
      await h(makeReq({ auth: `Bearer ${TOKEN}`, body: bodyV3({ timestamp }) }), res, CTX)
      assert.equal(res.statusCode, 400)
    }
  })
})

describe('tool call rollup handler', () => {
  test('accepts bounded counts and empty heartbeat, rejects raw/invalid shapes', async () => {
    const runner: QueryRunner = {
      async query() {
        return fakeResult([{ inserted: true }])
      },
    }
    const h = makeToolCallRollupHandler({
      identityRepo: repoFor(99),
      queryRunner: runner,
      now: () => NOW_MS,
    })

    let res = makeRes()
    await h(makeReq({ auth: `Bearer ${TOKEN}`, body: rollupBody() }), res, CTX)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.duplicate, false)

    res = makeRes()
    await h(makeReq({ auth: `Bearer ${TOKEN}`, body: rollupBody({ counts: [] }) }), res, CTX)
    assert.equal(res.statusCode, 200)

    const maxCounts = Array.from({ length: 256 }, (_, index) => ({
      agentId: 'main',
      toolName: `Tool${index}`,
      outcome: 'success' as const,
      errorClass: 'none' as const,
      failureKind: 'none' as const,
      count: 1,
    }))
    res = makeRes()
    await h(makeReq({ auth: `Bearer ${TOKEN}`, body: rollupBody({ counts: maxCounts }) }), res, CTX)
    assert.equal(res.statusCode, 200)

    res = makeRes()
    await h(
      makeReq({
        auth: `Bearer ${TOKEN}`,
        body: rollupBody({ counts: [...maxCounts, { ...maxCounts[0], toolName: 'overflow' }] }),
      }),
      res,
      CTX,
    )
    assert.equal(res.statusCode, 400)

    res = makeRes()
    await h(
      makeReq({
        auth: `Bearer ${TOKEN}`,
        body: rollupBody({ counts: [maxCounts[0], { ...maxCounts[0] }] }),
      }),
      res,
      CTX,
    )
    assert.equal(res.statusCode, 400)

    res = makeRes()
    await h(
      makeReq({
        auth: `Bearer ${TOKEN}`,
        body: {
          ...rollupBody(),
          counts: [{ ...rollupBody().counts[0], command: 'cat /private/path' }],
        },
      }),
      res,
      CTX,
    )
    assert.equal(res.statusCode, 400)

    res = makeRes()
    await h(
      makeReq({
        auth: `Bearer ${TOKEN}`,
        body: {
          ...rollupBody(),
          counts: [{ ...rollupBody().counts[0], errorClass: 'other' }],
        },
      }),
      res,
      CTX,
    )
    assert.equal(res.statusCode, 400)

    res = makeRes()
    await h(
      makeReq({
        auth: `Bearer ${TOKEN}`,
        body: rollupBody({ windowEndedAt: NOW_MS + 10 * 60_000 + 1 }),
      }),
      res,
      CTX,
    )
    assert.equal(res.statusCode, 400)

    res = makeRes()
    await h(
      makeReq({
        auth: `Bearer ${TOKEN}`,
        body: rollupBody({
          windowStartedAt: NOW_MS - 25 * 60 * 60_000 - 5 * 60_000 - 1,
          windowEndedAt: NOW_MS - 25 * 60 * 60_000 - 1,
        }),
      }),
      res,
      CTX,
    )
    assert.equal(res.statusCode, 400)
  })
})
