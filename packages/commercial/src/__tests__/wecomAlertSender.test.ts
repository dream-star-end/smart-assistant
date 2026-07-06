/**
 * 企业微信告警发送器 + 通道校验 单测(mock fetch,无 PG / 无网络)。
 *
 * 覆盖:
 *   - sendWecomAlert:errcode=0 成功;errcode!=0 抛(transient);errcode=93000 抛
 *     WecomPermanentError;HTTP 非 2xx 抛(transient);200 非 JSON 抛(transient);
 *     网络 throw 抛(transient);URL 带 webhook key、body 带 markdown content。
 *   - validateWecomWebhook:整条 URL 抽 key / 裸 key / "?key=" 片段 / 非法拒绝。
 *   - AEAD round-trip:webhook key encrypt→decrypt 还原(通道凭据落库/取用链路)。
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/wecomAlertSender.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { randomBytes } from 'node:crypto'

import {
  sendWecomAlert,
  WecomPermanentError,
} from '../admin/wecomAlertSender.js'
import { validateWecomWebhook } from '../admin/alertChannels.js'
import { encrypt, decrypt } from '../crypto/aead.js'

// 让 sender 不去构造真实 directEgressDispatcher(测试环境无需真出口)。
const noDispatcher = () => undefined

function jsonResp(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('sendWecomAlert', () => {
  it('success (errcode=0): resolves + posts key in URL and markdown in body', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    await sendWecomAlert(
      { webhookKey: 'abc-123-key-value-000', markdown: '**hi** body' },
      {
        makeDispatcher: noDispatcher,
        fetchImpl: async (input, init) => {
          calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) })
          return jsonResp({ errcode: 0, errmsg: 'ok' })
        },
      },
    )
    assert.equal(calls.length, 1)
    assert.match(calls[0].url, /qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=abc-123-key-value-000/)
    assert.deepEqual(calls[0].body, {
      msgtype: 'markdown',
      markdown: { content: '**hi** body' },
    })
  })

  it('errcode!=0 (45009 rate limit): throws transient Error (not permanent)', async () => {
    await assert.rejects(
      sendWecomAlert(
        { webhookKey: 'k'.repeat(20), markdown: 'x' },
        {
          makeDispatcher: noDispatcher,
          fetchImpl: async () => jsonResp({ errcode: 45009, errmsg: 'api freq out of limit' }),
        },
      ),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.ok(!(err instanceof WecomPermanentError), 'must be transient')
        assert.match((err as Error).message, /45009/)
        return true
      },
    )
  })

  it('errcode=93000 (invalid webhook key): throws WecomPermanentError', async () => {
    await assert.rejects(
      sendWecomAlert(
        { webhookKey: 'k'.repeat(20), markdown: 'x' },
        {
          makeDispatcher: noDispatcher,
          fetchImpl: async () => jsonResp({ errcode: 93000, errmsg: 'invalid webhook url key' }),
        },
      ),
      (err: unknown) => {
        assert.ok(err instanceof WecomPermanentError, 'must be permanent')
        assert.match((err as Error).message, /93000/)
        return true
      },
    )
  })

  it('HTTP 500: throws transient Error', async () => {
    await assert.rejects(
      sendWecomAlert(
        { webhookKey: 'k'.repeat(20), markdown: 'x' },
        {
          makeDispatcher: noDispatcher,
          fetchImpl: async () => new Response('', { status: 500 }),
        },
      ),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.ok(!(err instanceof WecomPermanentError))
        assert.match((err as Error).message, /http 500/)
        return true
      },
    )
  })

  it('200 non-JSON body: throws transient Error (avoid silent drop)', async () => {
    await assert.rejects(
      sendWecomAlert(
        { webhookKey: 'k'.repeat(20), markdown: 'x' },
        {
          makeDispatcher: noDispatcher,
          fetchImpl: async () => new Response('<html>not json</html>', { status: 200 }),
        },
      ),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.ok(!(err instanceof WecomPermanentError))
        return true
      },
    )
  })

  it('network error throw: wrapped as transient Error', async () => {
    await assert.rejects(
      sendWecomAlert(
        { webhookKey: 'k'.repeat(20), markdown: 'x' },
        {
          makeDispatcher: noDispatcher,
          fetchImpl: async () => {
            throw new Error('connect ECONNREFUSED 1.2.3.4:443')
          },
        },
      ),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.ok(!(err instanceof WecomPermanentError))
        assert.match((err as Error).message, /wecom fetch failed/)
        return true
      },
    )
  })
})

describe('validateWecomWebhook', () => {
  it('extracts key from a full webhook URL', () => {
    const key = validateWecomWebhook(
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=693a91f6-7xoo-11d6-b9ff-abcabcabc123',
    )
    assert.equal(key, '693a91f6-7xoo-11d6-b9ff-abcabcabc123')
  })

  it('accepts a bare key', () => {
    assert.equal(validateWecomWebhook('693a91f6-7xoo-11d6-b9ff-abcabcabc123'), '693a91f6-7xoo-11d6-b9ff-abcabcabc123')
  })

  it('extracts key from a "?key=" fragment without protocol', () => {
    assert.equal(validateWecomWebhook('send?key=abcdefabcdef1234'), 'abcdefabcdef1234')
    assert.equal(validateWecomWebhook('key=abcdefabcdef1234'), 'abcdefabcdef1234')
  })

  it('trims surrounding whitespace', () => {
    assert.equal(validateWecomWebhook('  abcdefabcdef1234  '), 'abcdefabcdef1234')
  })

  it('rejects empty / too-short / non-string', () => {
    assert.throws(() => validateWecomWebhook(''), RangeError)
    assert.throws(() => validateWecomWebhook('short'), RangeError)
    assert.throws(() => validateWecomWebhook(123 as unknown), RangeError)
    assert.throws(() => validateWecomWebhook('https://qyapi.weixin.qq.com/cgi-bin/webhook/send'), RangeError)
  })
})

describe('webhook key AEAD round-trip', () => {
  it('encrypt(key) → decrypt = original (通道凭据落库/取用链路)', () => {
    const key = randomBytes(32)
    const webhookKey = '693a91f6-7xoo-11d6-b9ff-abcabcabc123'
    const enc = encrypt(webhookKey, key)
    assert.notEqual(enc.ciphertext.toString('hex'), Buffer.from(webhookKey, 'utf8').toString('hex'))
    const dec = decrypt(enc.ciphertext, enc.nonce, key)
    assert.equal(dec, webhookKey)
    key.fill(0)
  })
})
