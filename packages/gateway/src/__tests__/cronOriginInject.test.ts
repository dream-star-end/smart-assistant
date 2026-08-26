/**
 * origin-session 容器→master 注入 client。
 * Run: npx tsx --test packages/gateway/src/__tests__/cronOriginInject.test.ts
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import {
  postCronOriginInject,
  CRON_ORIGIN_INJECT_PATH,
} from '../v3CronOriginInject.js'

const CONFIG = { baseUrl: 'http://master:18791', bearer: 'oc-v3.7.secret', agentId: 'main' }

interface Captured {
  url: string
  init: { method?: string; headers?: Record<string, string>; body?: string }
}

function mockFetcher(captured: Captured[], statusCode = 200) {
  return (async (url: string, init: any) => {
    captured.push({ url, init })
    return {
      statusCode,
      headers: {},
      body: Readable.from([Buffer.from('{}', 'utf8')]),
    }
  }) as unknown as typeof import('undici').request
}

const PAYLOAD = {
  sessionId: 'webmt4irxnsr3brv0',
  text: '⏰ 定时续跑\n\n核验\n',
  clientMessageId: 'cron-origin-abc',
  agentId: 'main',
}

describe('postCronOriginInject', () => {
  test('无 config → retryable NO_MASTER，不发请求', async () => {
    const captured: Captured[] = []
    const r = await postCronOriginInject(PAYLOAD, {
      config: null,
      fetcher: mockFetcher(captured),
    })
    assert.deepEqual(r, { kind: 'retryable', code: 'NO_MASTER' })
    assert.equal(captured.length, 0)
  })

  test('POST 到 CRON_ORIGIN_INJECT_PATH，带 Bearer，body 无 userId', async () => {
    const captured: Captured[] = []
    const r = await postCronOriginInject(PAYLOAD, {
      config: CONFIG,
      fetcher: mockFetcher(captured, 200),
    })
    assert.equal(r.kind, 'injected')
    assert.equal(captured.length, 1)
    assert.equal(captured[0].url, `${CONFIG.baseUrl}${CRON_ORIGIN_INJECT_PATH}`)
    assert.equal(captured[0].init.method, 'POST')
    assert.equal(captured[0].init.headers?.authorization, `Bearer ${CONFIG.bearer}`)
    const body = JSON.parse(captured[0].init.body ?? '{}')
    assert.equal(body.sessionId, PAYLOAD.sessionId)
    assert.equal(body.clientMessageId, PAYLOAD.clientMessageId)
    assert.equal('userId' in body, false)
  })

  test('404/409/503 映射 gone / in_flight / retryable', async () => {
    const r404 = await postCronOriginInject(PAYLOAD, {
      config: CONFIG,
      fetcher: mockFetcher([], 404),
    })
    assert.deepEqual(r404, { kind: 'gone' })
    const r409 = await postCronOriginInject(PAYLOAD, {
      config: CONFIG,
      fetcher: mockFetcher([], 409),
    })
    assert.deepEqual(r409, { kind: 'in_flight' })
    const r503 = await postCronOriginInject(PAYLOAD, {
      config: CONFIG,
      fetcher: mockFetcher([], 503),
    })
    assert.equal(r503.kind, 'retryable')
  })
})
