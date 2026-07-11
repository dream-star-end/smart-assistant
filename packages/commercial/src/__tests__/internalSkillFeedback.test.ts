/**
 * Unit tests for GET /internal/v3/marketplace/skill-feedback.
 * Run: npx tsx --test packages/commercial/src/__tests__/internalSkillFeedback.test.ts
 */

import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, test } from 'node:test'

import { hashSecret, type ContainerIdentityRepo } from '../auth/containerIdentity.js'
import type { QueryRunner } from '../http/internalSkillUsage.js'
import {
  SKILL_FEEDBACK_PATH,
  makeSkillFeedbackHandler,
  querySkillFeedbackRefs,
} from '../http/internalSkillFeedback.js'

const SECRET = 'a'.repeat(64)
const TOKEN = `oc-v3.7.${SECRET}`
const CTX = { hostUuid: 'host-1', boundIp: '172.31.0.7' }
const TRACE = 'f'.repeat(32)

function repoFor(userId = 42): ContainerIdentityRepo {
  return {
    async findActiveByHostAndBoundIp(hostUuid, boundIp) {
      if (hostUuid !== CTX.hostUuid || boundIp !== CTX.boundIp) return null
      return { id: 7, user_id: userId, bound_ip: boundIp, host_uuid: hostUuid, secret_hash: hashSecret(SECRET) }
    },
  }
}

function makeReq(opts: { method?: string; auth?: string; qs?: string }): IncomingMessage {
  const req = Readable.from([]) as unknown as IncomingMessage
  req.method = opts.method ?? 'GET'
  req.url = `${SKILL_FEEDBACK_PATH}${opts.qs ?? ''}`
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

/** 假 runner:记录最后一次 query 的 params,并返回预设 rows。 */
function runnerReturning(rows: any[]): QueryRunner & { calls: Array<{ sql: string; params?: readonly unknown[] }> } {
  const calls: Array<{ sql: string; params?: readonly unknown[] }> = []
  return {
    calls,
    async query(sql: string, params?: readonly unknown[]) {
      calls.push({ sql, params })
      return { rows, rowCount: rows.length }
    },
  } as any
}

describe('querySkillFeedbackRefs', () => {
  test('maps rows → refs (Date→ISO) + parses total; forwards (userId, slug, layer)', async () => {
    const at = new Date('2026-07-01T12:00:00.000Z')
    const runner = runnerReturning([
      { session_key: 's1', trace_id: TRACE, rated_at: at, total: '3' },
      { session_key: 's2', trace_id: 'e'.repeat(32), rated_at: '2026-06-20T00:00:00.000Z', total: '3' },
    ])
    const r = await querySkillFeedbackRefs(runner, 42, 'pdf-helper', 'user')
    assert.equal(r.total, 3, 'total 取 count(*) OVER (),不受 refs 上限影响')
    assert.deepEqual(r.refs, [
      { sessionKey: 's1', traceId: TRACE, at: '2026-07-01T12:00:00.000Z' },
      { sessionKey: 's2', traceId: 'e'.repeat(32), at: '2026-06-20T00:00:00.000Z' },
    ])
    // 参数顺序:userId, slug, layer, windowDays, limit。
    assert.deepEqual(runner.calls[0].params?.slice(0, 3), [42, 'pdf-helper', 'user'])
    assert.match(runner.calls[0].sql, /layer = \$3/)
    assert.match(runner.calls[0].sql, /rating = 'down'/)
    assert.match(runner.calls[0].sql, /DISTINCT ON \(e\.session_key\)/)
  })

  test('empty result → refs:[] total:0', async () => {
    const runner = runnerReturning([])
    const r = await querySkillFeedbackRefs(runner, 1, 'nope', 'hub')
    assert.deepEqual(r, { refs: [], total: 0 })
  })
})

describe('skill feedback handler', () => {
  test('rejects non-GET and missing bearer', async () => {
    const h = makeSkillFeedbackHandler({ identityRepo: repoFor(), queryRunner: runnerReturning([]) })
    let res = makeRes()
    await h(makeReq({ auth: `Bearer ${TOKEN}`, method: 'POST', qs: '?slug=x&layer=hub' }), res, CTX)
    assert.equal(res.statusCode, 405)

    res = makeRes()
    await h(makeReq({ qs: '?slug=pdf-helper&layer=hub' }), res, CTX)
    assert.equal(res.statusCode, 401)
  })

  test('bad/missing slug → 400 INVALID_SLUG', async () => {
    const h = makeSkillFeedbackHandler({ identityRepo: repoFor(), queryRunner: runnerReturning([]) })
    for (const qs of ['', '?layer=hub', '?slug=Bad Slug!&layer=hub', '?slug=&layer=hub']) {
      const res = makeRes()
      await h(makeReq({ auth: `Bearer ${TOKEN}`, qs }), res, CTX)
      assert.equal(res.statusCode, 400, `expected 400 for qs=${qs}`)
      assert.equal(res.body.error.code, 'INVALID_SLUG')
    }
  })

  test('bad layer → 400 INVALID_LAYER', async () => {
    const h = makeSkillFeedbackHandler({ identityRepo: repoFor(), queryRunner: runnerReturning([]) })
    const res = makeRes()
    await h(makeReq({ auth: `Bearer ${TOKEN}`, qs: '?slug=pdf-helper&layer=platform' }), res, CTX)
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.error.code, 'INVALID_LAYER')
  })

  test('layer omitted → defaults to hub (200)', async () => {
    const runner = runnerReturning([])
    const h = makeSkillFeedbackHandler({ identityRepo: repoFor(), queryRunner: runner })
    const res = makeRes()
    await h(makeReq({ auth: `Bearer ${TOKEN}`, qs: '?slug=pdf-helper' }), res, CTX)
    assert.equal(res.statusCode, 200)
    assert.equal(runner.calls[0].params?.[2], 'hub')
  })

  test('valid → 200 with {refs,total} and identity userId (not query uid)', async () => {
    const runner = runnerReturning([
      { session_key: 's9', trace_id: TRACE, rated_at: new Date('2026-07-05T00:00:00.000Z'), total: '1' },
    ])
    const h = makeSkillFeedbackHandler({ identityRepo: repoFor(99), queryRunner: runner })
    const res = makeRes()
    // query 里塞一个伪 uid,断言服务端**只用容器身份推导的 99**。
    await h(makeReq({ auth: `Bearer ${TOKEN}`, qs: '?slug=pdf-helper&layer=user&uid=1' }), res, CTX)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.total, 1)
    assert.equal(res.body.refs.length, 1)
    assert.equal(res.body.refs[0].sessionKey, 's9')
    assert.ok(res.body.requestId)
    assert.equal(runner.calls[0].params?.[0], 99, '用容器身份 userId,不信 query.uid')
  })
})
