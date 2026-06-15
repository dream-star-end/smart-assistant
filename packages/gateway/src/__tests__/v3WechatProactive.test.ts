/**
 * 容器 → master 主动微信投递 client 单测。
 *
 * 覆盖 master outcome → 容器决策(ProactiveDeliveryResult)的分类,以及
 * 网络/HTTP/非法 JSON 错误一律回退 web 不标注(配置/网络问题非用户会话问题)。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/v3WechatProactive.test.ts
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import {
  sendV3WechatProactive,
  readV3WechatProactiveConfig,
  type ProactiveDeliveryResult,
} from '../v3WechatProactive.js'

const CONFIG = { baseUrl: 'http://master:18791', bearer: 'oc-v3.7.secret', agentId: 'main' }

/** mock undici request → 固定 statusCode + JSON body。 */
function mockFetcher(statusCode: number, bodyObj: unknown) {
  return (async () => ({
    statusCode,
    headers: {},
    body: Readable.from([Buffer.from(JSON.stringify(bodyObj), 'utf8')]),
  })) as unknown as typeof import('undici').request
}

async function send(fetcher: typeof import('undici').request): Promise<ProactiveDeliveryResult> {
  return sendV3WechatProactive({ config: CONFIG, text: '提醒', outboundId: 'job1.wxproactive.abc', fetcher })
}

describe('v3WechatProactive client', () => {
  test('queued → delivered', async () => {
    assert.deepEqual(await send(mockFetcher(200, { ok: true, outcome: 'queued' })), { kind: 'delivered' })
  })

  test('already_sent / pending → delivered', async () => {
    assert.deepEqual(await send(mockFetcher(200, { outcome: 'already_sent' })), { kind: 'delivered' })
    assert.deepEqual(await send(mockFetcher(200, { outcome: 'pending' })), { kind: 'delivered' })
  })

  test('no_context_token / no_session → fallback marked', async () => {
    assert.deepEqual(await send(mockFetcher(200, { outcome: 'no_context_token' })), { kind: 'fallback', marked: true })
    assert.deepEqual(await send(mockFetcher(200, { outcome: 'no_session' })), { kind: 'fallback', marked: true })
  })

  test('pref_off / no_binding → fallback unmarked', async () => {
    assert.deepEqual(await send(mockFetcher(200, { outcome: 'pref_off' })), { kind: 'fallback', marked: false })
    assert.deepEqual(await send(mockFetcher(200, { outcome: 'no_binding' })), { kind: 'fallback', marked: false })
  })

  test('non-2xx → fallback unmarked', async () => {
    assert.deepEqual(await send(mockFetcher(500, { outcome: 'queued' })), { kind: 'fallback', marked: false })
    assert.deepEqual(await send(mockFetcher(404, {})), { kind: 'fallback', marked: false })
  })

  test('network error never throws → fallback unmarked', async () => {
    const throwing = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof import('undici').request
    assert.deepEqual(await send(throwing), { kind: 'fallback', marked: false })
  })

  test('invalid JSON body → fallback unmarked', async () => {
    const badJson = (async () => ({
      statusCode: 200,
      headers: {},
      body: Readable.from([Buffer.from('not json', 'utf8')]),
    })) as unknown as typeof import('undici').request
    assert.deepEqual(await send(badJson), { kind: 'fallback', marked: false })
  })

  test('unknown outcome → fallback unmarked (conservative)', async () => {
    assert.deepEqual(await send(mockFetcher(200, { outcome: 'something_new' })), { kind: 'fallback', marked: false })
  })

  test('readV3WechatProactiveConfig: both env missing → null', () => {
    assert.equal(readV3WechatProactiveConfig({}), null)
    assert.equal(readV3WechatProactiveConfig({ OPENCLAUDE_V3_MASTER_BASE_URL: 'http://m' }), null)
  })

  test('readV3WechatProactiveConfig: both env present → config', () => {
    const cfg = readV3WechatProactiveConfig({
      OPENCLAUDE_V3_MASTER_BASE_URL: 'http://m:18791/',
      OPENCLAUDE_V3_CONTAINER_TOKEN: 'oc-v3.7.s',
    })
    assert.ok(cfg)
    assert.equal(cfg!.baseUrl, 'http://m:18791') // trailing slash stripped
    assert.equal(cfg!.bearer, 'oc-v3.7.s')
  })
})
