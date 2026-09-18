/**
 * 通用 JSON body 读取(httpJsonBody.ts,server.ts readJsonBody 的实现):
 * 超限 → 413、坏 JSON → 400、空 body → {}、正常 body 原样解析。
 * 用真实 node:http 服务器按 server.ts 的「handler 抛错 → 兜底映射」形态跑一遍。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/httpJsonBody.test.ts
 */
import * as assert from 'node:assert/strict'
import { type Server, createServer } from 'node:http'
import { after, before, describe, it } from 'node:test'

import {
  DEFAULT_JSON_BODY_MAX_BYTES,
  JsonBodyInvalidError,
  JsonBodyTooLargeError,
  jsonBodyErrorStatus,
  readJsonBodyBounded,
} from '../httpJsonBody.js'

const LIMIT = 64 * 1024
let server: Server
let base = ''

before(async () => {
  server = createServer((req, res) => {
    readJsonBodyBounded<Record<string, unknown>>(req, LIMIT)
      .then((body) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, keys: Object.keys(body) }))
      })
      .catch((err: unknown) => {
        // 与 server.ts sendInternalError 同形:先问 jsonBodyErrorStatus,再落 500。
        const status = jsonBodyErrorStatus(err)
        res.writeHead(status ?? 500, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            error:
              status === 413
                ? 'payload too large'
                : status === 400
                  ? 'invalid json body'
                  : 'internal error',
          }),
        )
      })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  )
})

async function post(raw: string) {
  const res = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw,
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('readJsonBodyBounded(通用 readJsonBody)', () => {
  it('默认上限是 4 MB', () => {
    assert.equal(DEFAULT_JSON_BODY_MAX_BYTES, 4 * 1024 * 1024)
  })

  it('正常 JSON 对象原样解析', async () => {
    const r = await post(JSON.stringify({ text: '你好', version: 'v1' }))
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, { ok: true, keys: ['text', 'version'] })
  })

  it('空 body → {}(历史语义:全部字段缺省)', async () => {
    const r = await post('')
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, { ok: true, keys: [] })
  })

  it('坏 JSON → 400 invalid json body(不再是 500)', async () => {
    const r = await post('{ not json')
    assert.equal(r.status, 400)
    assert.equal(r.body.error, 'invalid json body')
  })

  it('超过上限 → 413 payload too large,且客户端能收到响应体(不掐连接)', async () => {
    const huge = JSON.stringify({ text: 'x'.repeat(LIMIT + 1024) })
    assert.ok(Buffer.byteLength(huge) > LIMIT)
    const r = await post(huge)
    assert.equal(r.status, 413)
    assert.equal(r.body.error, 'payload too large')
  })

  it('恰好等于上限不算超限', async () => {
    const pad = LIMIT - Buffer.byteLength('{"t":""}')
    const exact = `{"t":"${'a'.repeat(pad)}"}`
    assert.equal(Buffer.byteLength(exact), LIMIT)
    const r = await post(exact)
    assert.equal(r.status, 200)
  })

  it('jsonBodyErrorStatus 只认自己的两类错误', () => {
    assert.equal(jsonBodyErrorStatus(new JsonBodyTooLargeError(1)), 413)
    assert.equal(jsonBodyErrorStatus(new JsonBodyInvalidError()), 400)
    assert.equal(jsonBodyErrorStatus(new Error('boom')), null)
    assert.equal(jsonBodyErrorStatus(undefined), null)
  })
})
