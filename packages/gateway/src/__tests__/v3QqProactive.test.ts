import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { describe, test } from 'node:test'

import { readV3QqProactiveConfig, sendV3QqProactive } from '../v3QqProactive.js'

const CONFIG = {
  baseUrl: 'http://master:18791',
  bearer: 'oc-v3.7.secret',
  agentId: 'main',
}

function mockFetcher(statusCode: number, body: unknown) {
  return (async (url: string | URL, options?: { body?: unknown }) => {
    assert.equal(String(url), 'http://master:18791/internal/v3/qq-proactive')
    assert.deepEqual(JSON.parse(String(options?.body)), {
      text: '提醒',
      outboundId: 'job1.qqproactive.abc',
    })
    return {
      statusCode,
      headers: {},
      body: Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]),
    }
  }) as unknown as typeof import('undici').request
}

describe('v3 QQ proactive client', () => {
  test('durably accepted outcomes are terminal delivery', async () => {
    for (const outcome of ['queued', 'pending', 'already_sent']) {
      assert.deepEqual(
        await sendV3QqProactive({
          config: CONFIG,
          text: '提醒',
          outboundId: 'job1.qqproactive.abc',
          fetcher: mockFetcher(200, { outcome }),
        }),
        { kind: 'delivered' },
      )
    }
  })

  test('preference or missing binding falls through to the next channel', async () => {
    for (const outcome of ['pref_off', 'no_binding']) {
      assert.deepEqual(
        await sendV3QqProactive({
          config: CONFIG,
          text: '提醒',
          outboundId: 'job1.qqproactive.abc',
          fetcher: mockFetcher(200, { outcome }),
        }),
        { kind: 'fallback', marked: false },
      )
    }
  })

  test('ambiguous failures remain retryable instead of duplicating cross-channel', async () => {
    assert.deepEqual(
      await sendV3QqProactive({
        config: CONFIG,
        text: '提醒',
        outboundId: 'job1.qqproactive.abc',
        fetcher: mockFetcher(500, {}),
      }),
      { kind: 'failure', retryable: true, code: 'QQ_MASTER_UNAVAILABLE' },
    )
    const throwing = (async () => {
      throw new Error('ECONNRESET')
    }) as unknown as typeof import('undici').request
    assert.deepEqual(
      await sendV3QqProactive({
        config: CONFIG,
        text: '提醒',
        outboundId: 'job1.qqproactive.abc',
        fetcher: throwing,
      }),
      { kind: 'failure', retryable: true, code: 'QQ_TRANSPORT_FAILED' },
    )
  })

  test('configuration shares the authenticated master transport', () => {
    assert.equal(readV3QqProactiveConfig({}), null)
    assert.deepEqual(
      readV3QqProactiveConfig({
        OPENCLAUDE_V3_MASTER_BASE_URL: 'http://master:18791/',
        OPENCLAUDE_V3_CONTAINER_TOKEN: 'oc-v3.7.secret',
      }),
      {
        baseUrl: 'http://master:18791',
        bearer: 'oc-v3.7.secret',
      },
    )
  })
})
