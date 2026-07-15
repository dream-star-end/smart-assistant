/**
 * cron-master-wake 两个容器→master best-effort poster 的单测:
 *   - v3CronIndexPush.postCronIndex(唤醒索引上报)
 *   - v3InboxPost.postInboxMessage(离线送达兜底站内信)
 *
 * 覆盖:无 config → no-op(不发请求)、POST 形态(path/header/body)、永不抛、
 * inbox 正文/标题截断。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/cronMasterWakePosters.test.ts
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import { postCronIndex, CRON_INDEX_PATH } from '../v3CronIndexPush.js'
import {
  postInboxMessage,
  postInboxMessageDurable,
  INBOX_POST_PATH,
} from '../v3InboxPost.js'

const CONFIG = { baseUrl: 'http://master:18791', bearer: 'oc-v3.7.secret', agentId: 'main' }

interface Captured {
  url: string
  init: { method?: string; headers?: Record<string, string>; body?: string }
}

/** mock undici request → 固定 2xx,捕获调用参数。 */
function mockFetcher(captured: Captured[], statusCode = 202) {
  return (async (url: string, init: any) => {
    captured.push({ url, init })
    return {
      statusCode,
      headers: {},
      body: Readable.from([Buffer.from('{}', 'utf8')]),
    }
  }) as unknown as typeof import('undici').request
}

describe('postCronIndex — 唤醒索引上报', () => {
  test('无 config(个人版无 master env)→ no-op,不发请求', async () => {
    const captured: Captured[] = []
    await postCronIndex(
      { nextFireAt: '2026-07-07T01:00:00.000Z', enabledCount: 3 },
      { config: null, fetcher: mockFetcher(captured) },
    )
    assert.equal(captured.length, 0)
  })

  test('POST 到 CRON_INDEX_PATH,带 Bearer + JSON body', async () => {
    const captured: Captured[] = []
    await postCronIndex(
      { nextFireAt: '2026-07-07T01:00:00.000Z', enabledCount: 3 },
      { config: CONFIG, fetcher: mockFetcher(captured) },
    )
    assert.equal(captured.length, 1)
    const { url, init } = captured[0]
    assert.equal(url, `${CONFIG.baseUrl}${CRON_INDEX_PATH}`)
    assert.equal(init.method, 'POST')
    assert.equal(init.headers?.authorization, `Bearer ${CONFIG.bearer}`)
    const body = JSON.parse(init.body as string)
    assert.equal(body.nextFireAt, '2026-07-07T01:00:00.000Z')
    assert.equal(body.enabledCount, 3)
    // master BodySchema 是 .strict():不能捎带 agentId(会被拒 400)。
    assert.equal(body.agentId, undefined)
    assert.deepEqual(Object.keys(body).sort(), ['enabledCount', 'nextFireAt'])
  })

  test('nextFireAt=null(无 enabled 任务)照常上报', async () => {
    const captured: Captured[] = []
    await postCronIndex({ nextFireAt: null, enabledCount: 0 }, { config: CONFIG, fetcher: mockFetcher(captured) })
    const body = JSON.parse(captured[0].init.body as string)
    assert.equal(body.nextFireAt, null)
    assert.equal(body.enabledCount, 0)
  })

  test('网络错误永不抛(fire-and-forget)', async () => {
    const throwing = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof import('undici').request
    await assert.doesNotReject(() =>
      postCronIndex({ nextFireAt: null, enabledCount: 0 }, { config: CONFIG, fetcher: throwing }),
    )
  })
})

describe('postInboxMessage — 离线兜底站内信', () => {
  test('无 config → no-op,不发请求', async () => {
    const captured: Captured[] = []
    await postInboxMessage({ title: 't', bodyMd: 'b' }, { config: null, fetcher: mockFetcher(captured) })
    assert.equal(captured.length, 0)
  })

  test('POST 到 INBOX_POST_PATH,带 Bearer + title/bodyMd', async () => {
    const captured: Captured[] = []
    await postInboxMessage({ title: '定时任务结果', bodyMd: '正文内容' }, { config: CONFIG, fetcher: mockFetcher(captured) })
    assert.equal(captured.length, 1)
    const { url, init } = captured[0]
    assert.equal(url, `${CONFIG.baseUrl}${INBOX_POST_PATH}`)
    assert.equal(init.headers?.authorization, `Bearer ${CONFIG.bearer}`)
    const body = JSON.parse(init.body as string)
    assert.equal(body.title, '定时任务结果')
    assert.equal(body.bodyMd, '正文内容')
    // strict schema:只允许 title/bodyMd(level 可选,此处不发)。
    assert.deepEqual(Object.keys(body).sort(), ['bodyMd', 'title'])
  })

  test('bodyMd 超 4096 字符 → 截断', async () => {
    const captured: Captured[] = []
    const huge = 'x'.repeat(5000)
    await postInboxMessage({ title: 't', bodyMd: huge }, { config: CONFIG, fetcher: mockFetcher(captured) })
    const body = JSON.parse(captured[0].init.body as string)
    assert.ok(body.bodyMd.length <= 4096, `bodyMd length ${body.bodyMd.length} 应 <= 4096`)
    assert.ok(body.bodyMd.endsWith('…'), '截断应以省略号收尾')
  })

  test('title 超 200 字符 → 截断', async () => {
    const captured: Captured[] = []
    await postInboxMessage({ title: 'y'.repeat(400), bodyMd: 'b' }, { config: CONFIG, fetcher: mockFetcher(captured) })
    const body = JSON.parse(captured[0].init.body as string)
    assert.ok(body.title.length <= 200)
  })

  test('网络错误永不抛', async () => {
    const throwing = (async () => {
      throw new Error('boom')
    }) as unknown as typeof import('undici').request
    await assert.doesNotReject(() =>
      postInboxMessage({ title: 't', bodyMd: 'b' }, { config: CONFIG, fetcher: throwing }),
    )
  })

  test('durable inbox POST carries stable key and rejects transport failure', async () => {
    const captured: Captured[] = []
    const deliveryKey = `cron.${'a'.repeat(64)}`
    const successFetcher = (async (url: string, init: any) => {
      captured.push({ url, init })
      return {
        statusCode: 200,
        headers: {},
        body: Readable.from([Buffer.from('{"ok":true}', 'utf8')]),
      }
    }) as unknown as typeof import('undici').request
    await assert.doesNotReject(() => postInboxMessageDurable(
      { title: '定时任务结果', bodyMd: '正文内容', deliveryKey },
      { config: CONFIG, fetcher: successFetcher },
    ))
    const body = JSON.parse(captured[0]!.init.body as string)
    assert.equal(body.deliveryKey, deliveryKey)

    const throwing = (async () => { throw new Error('master down') }) as unknown as typeof import('undici').request
    await assert.rejects(
      () => postInboxMessageDurable(
        { title: '定时任务结果', bodyMd: '正文内容', deliveryKey },
        { config: CONFIG, fetcher: throwing },
      ),
      (err: unknown) => (
        err instanceof Error &&
        (err as Error & { code?: string; retryable?: boolean }).code === 'INBOX_TRANSPORT_FAILED' &&
        (err as Error & { retryable?: boolean }).retryable === true
      ),
    )
  })
})
