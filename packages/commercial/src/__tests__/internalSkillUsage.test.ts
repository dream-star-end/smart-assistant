/**
 * Unit tests for /internal/v3/marketplace/skill-usage.
 * Run: npx tsx --test packages/commercial/src/__tests__/internalSkillUsage.test.ts
 */

import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, test } from 'node:test'

import { hashSecret, type ContainerIdentityRepo } from '../auth/containerIdentity.js'
import {
  MAX_EVENTS_PER_BATCH,
  SKILL_USAGE_PATH,
  insertSkillUsageEvents,
  isSkillUsageEnabled,
  makeSkillUsageHandler,
  type QueryRunner,
  type SkillUsageEvent,
} from '../http/internalSkillUsage.js'

const SECRET = 'a'.repeat(64)
const TOKEN = `oc-v3.7.${SECRET}`
const CTX = { hostUuid: 'host-1', boundIp: '172.31.0.7' }
const TRACE = 'f'.repeat(32)

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

function ev(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: 'evt-1',
    slug: 'pdf-helper',
    agentId: 'main',
    sessionKey: 'agent:main:webchat:dm:s1',
    traceId: TRACE,
    at: '2026-07-10T00:00:00.000Z',
    ...overrides,
  }
}

function makeReq(opts: { method?: string; auth?: string; body?: unknown }): IncomingMessage {
  const raw = opts.body === undefined ? '' : JSON.stringify(opts.body)
  const req = Readable.from(raw ? [Buffer.from(raw)] : []) as unknown as IncomingMessage
  req.method = opts.method ?? 'POST'
  req.url = SKILL_USAGE_PATH
  req.headers = {}
  if (opts.auth) req.headers.authorization = opts.auth
  return req
}

function makeRes(): ServerResponse & { body: any } {
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
  return res as unknown as ServerResponse & { body: any }
}

function fakeResult(rowCount: number) {
  return { rows: [], rowCount }
}

describe('isSkillUsageEnabled', () => {
  test('default ON; only explicit "0" turns it off', () => {
    // 与 tool-failure(必须显式 '1')相反:低敏产品信号,默认开。
    assert.equal(isSkillUsageEnabled({}), true)
    assert.equal(isSkillUsageEnabled({ OC_MARKET_SKILL_USAGE: '1' }), true)
    assert.equal(isSkillUsageEnabled({ OC_MARKET_SKILL_USAGE: 'true' }), true)
    assert.equal(isSkillUsageEnabled({ OC_MARKET_SKILL_USAGE: '' }), true)
    assert.equal(isSkillUsageEnabled({ OC_MARKET_SKILL_USAGE: '0' }), false)
  })
})

describe('insertSkillUsageEvents', () => {
  test('batches into one INSERT; accepted = rowCount, duplicate = rest', async () => {
    const calls: Array<{ sql: string; params?: readonly unknown[] }> = []
    const runner: QueryRunner = {
      async query(sql, params) {
        calls.push({ sql, params })
        return fakeResult(2) // 3 unique in → PG 落库 2(1 已存在)
      },
    }
    const events: SkillUsageEvent[] = [
      { eventId: 'e1', slug: 'a', agentId: 'main', sessionKey: null, traceId: TRACE, layer: 'hub' },
      { eventId: 'e2', slug: 'b', agentId: null, sessionKey: null, traceId: null, layer: 'user' },
      { eventId: 'e3', slug: 'c', agentId: null, sessionKey: null, traceId: null, layer: 'hub' },
    ]
    const r = await insertSkillUsageEvents(runner, 42, events)
    assert.deepEqual(r, { accepted: 2, duplicate: 1 })
    assert.equal(calls.length, 1)
    assert.match(calls[0].sql, /INSERT INTO marketplace_skill_usage_events/)
    assert.match(calls[0].sql, /ON CONFLICT \(user_id, event_id\) DO NOTHING/)
    // INSERT 列含 layer;第 2 行事件走 user 层。
    assert.match(calls[0].sql, /, layer\)/)
    // 7 列 × 3 行 = 21 参数;第一列恒为服务端推导 userId(不信容器 uid);末列为 layer。
    assert.equal(calls[0].params?.length, 21)
    assert.equal(calls[0].params?.[0], 42)
    assert.equal(calls[0].params?.[6], 'hub') // 首行 layer
    assert.equal(calls[0].params?.[13], 'user') // 次行 layer
  })

  test('intra-batch duplicate eventId is collapsed before insert', async () => {
    let insertedRows = 0
    const runner: QueryRunner = {
      async query(_sql, params) {
        insertedRows = (params?.length ?? 0) / 7
        return fakeResult(insertedRows)
      },
    }
    const events: SkillUsageEvent[] = [
      { eventId: 'dup', slug: 'a', agentId: null, sessionKey: null, traceId: null, layer: 'hub' },
      { eventId: 'dup', slug: 'a', agentId: null, sessionKey: null, traceId: null, layer: 'hub' },
    ]
    const r = await insertSkillUsageEvents(runner, 42, events)
    // 批内去重后只 INSERT 1 行;另一条算 duplicate。
    assert.equal(insertedRows, 1)
    assert.deepEqual(r, { accepted: 1, duplicate: 1 })
  })
})

describe('skill usage handler', () => {
  test('rejects non-POST and missing bearer', async () => {
    const h = makeSkillUsageHandler({ identityRepo: repoFor(), queryRunner: { async query() { return fakeResult(0) } } })
    let res = makeRes()
    await h(makeReq({ auth: `Bearer ${TOKEN}`, method: 'GET', body: { events: [ev()] } }), res, CTX)
    assert.equal(res.statusCode, 405)

    res = makeRes()
    await h(makeReq({ body: { events: [ev()] } }), res, CTX)
    assert.equal(res.statusCode, 401)
  })

  test('valid batch inserts and reports accepted/duplicate', async () => {
    const runner: QueryRunner = { async query() { return fakeResult(1) } }
    const h = makeSkillUsageHandler({ identityRepo: repoFor(99), queryRunner: runner })
    const res = makeRes()
    await h(makeReq({ auth: `Bearer ${TOKEN}`, body: { events: [ev(), ev({ eventId: 'evt-2' })] } }), res, CTX)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.ok, true)
    assert.equal(res.body.accepted, 1)
    assert.equal(res.body.duplicate, 1)
    assert.ok(res.body.requestId)
  })

  test('over-batch (>100) → 400 TOO_MANY_EVENTS', async () => {
    const h = makeSkillUsageHandler({ identityRepo: repoFor(), queryRunner: { async query() { return fakeResult(0) } } })
    const events = Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, (_, i) => ev({ eventId: `e${i}` }))
    const res = makeRes()
    await h(makeReq({ auth: `Bearer ${TOKEN}`, body: { events } }), res, CTX)
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.error.code, 'TOO_MANY_EVENTS')
  })

  test('empty events / non-array / bad slug / bad traceId → 400', async () => {
    const h = makeSkillUsageHandler({ identityRepo: repoFor(), queryRunner: { async query() { return fakeResult(0) } } })
    for (const bad of [
      { events: [] },
      { events: 'x' },
      { events: [ev({ slug: 'Bad Slug!' })] },
      { events: [ev({ eventId: '' })] },
      { events: [ev({ traceId: 'not-hex' })] },
      // 非法 layer(越界串 / 非串)→ 整批 400,不静默降级为 hub。
      { events: [ev({ layer: 'platform' })] },
      { events: [ev({ layer: 123 })] },
      { nope: 1 },
    ]) {
      const res = makeRes()
      await h(makeReq({ auth: `Bearer ${TOKEN}`, body: bad }), res, CTX)
      assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(bad)}`)
    }
  })

  test('null/absent optional fields are accepted (traceId null → no attribution)', async () => {
    const runner: QueryRunner = { async query() { return fakeResult(1) } }
    const h = makeSkillUsageHandler({ identityRepo: repoFor(), queryRunner: runner })
    const res = makeRes()
    await h(
      makeReq({ auth: `Bearer ${TOKEN}`, body: { events: [{ eventId: 'e', slug: 'ok-slug', agentId: null, sessionKey: null, traceId: null }] } }),
      res,
      CTX,
    )
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.accepted, 1)
  })

  test('layer:缺省→hub、显式 user 都被接受并流入 INSERT 参数', async () => {
    const captured: Array<readonly unknown[] | undefined> = []
    const runner: QueryRunner = {
      async query(_sql, params) {
        captured.push(params)
        return fakeResult(2)
      },
    }
    const h = makeSkillUsageHandler({ identityRepo: repoFor(), queryRunner: runner })
    const res = makeRes()
    await h(
      makeReq({
        auth: `Bearer ${TOKEN}`,
        // 第一条不带 layer(应默认 hub),第二条显式 user。
        body: { events: [ev({ eventId: 'e1', layer: undefined }), ev({ eventId: 'e2', layer: 'user' })] },
      }),
      res,
      CTX,
    )
    assert.equal(res.statusCode, 200)
    // 7 列 × 2 行:layer 是每行第 7 个参数(索引 6、13)。
    assert.equal(captured[0]?.length, 14)
    assert.equal(captured[0]?.[6], 'hub')
    assert.equal(captured[0]?.[13], 'user')
  })
})
