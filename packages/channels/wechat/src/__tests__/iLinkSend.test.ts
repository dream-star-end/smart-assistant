/**
 * Tests for sendIlinkText — verifies the canonical → wire (`@im.wechat`)
 * conversion happens at the iLink HTTP boundary on outbound.
 *
 * 不变量:
 *   1. canonical 入参(如 'abc')→ HTTP body.msg.to_user_id === 'abc@im.wechat'
 *   2. 已是 wire 形态(如 'abc@im.wechat')→ HTTP body.msg.to_user_id 不变,不重复加后缀
 *   3. 其他 body 字段(message_type/state, context_token, item_list, base_info)未受影响
 *
 * 通过 stub globalThis.fetch 抓 outbound request,assert body 形态。
 *
 * Run: npx tsx --test packages/channels/wechat/src/__tests__/iLinkSend.test.ts
 */
import * as assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { sendIlinkText } from '../iLink.js'

interface CapturedRequest {
  url: string
  method: string | undefined
  headers: Record<string, string>
  body: any
}

let captured: CapturedRequest[] = []
let originalFetch: typeof globalThis.fetch | undefined

function stubFetch(respBody: any = { errcode: 0, ret: 0 }, status = 200): void {
  originalFetch = globalThis.fetch
  globalThis.fetch = async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url
    const headers: Record<string, string> = {}
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers)) headers[k] = String(v)
    }
    let parsedBody: any = undefined
    if (typeof init?.body === 'string') {
      try {
        parsedBody = JSON.parse(init.body)
      } catch {
        parsedBody = init.body
      }
    }
    captured.push({ url, method: init?.method, headers, body: parsedBody })
    return new Response(JSON.stringify(respBody), { status })
  }
}

function restoreFetch(): void {
  if (originalFetch) globalThis.fetch = originalFetch
  originalFetch = undefined
  captured = []
}

describe('sendIlinkText — canonical → wire conversion on outbound', () => {
  beforeEach(() => {
    stubFetch()
  })
  afterEach(() => {
    restoreFetch()
  })

  it('canonical senderId gets @im.wechat suffix in wire body', async () => {
    await sendIlinkText('bot-token-A', 'o9cq803RaiYffHD5475dcduJaDgg', 'ctx-tok-1', 'hello')
    assert.equal(captured.length, 1)
    const req = captured[0]!
    assert.match(req.url, /\/ilink\/bot\/sendmessage$/)
    assert.equal(req.method, 'POST')
    assert.equal(req.headers.Authorization, 'Bearer bot-token-A')
    assert.equal(req.body.msg.to_user_id, 'o9cq803RaiYffHD5475dcduJaDgg@im.wechat')
    assert.equal(req.body.msg.context_token, 'ctx-tok-1')
    assert.equal(req.body.msg.message_type, 2)
    assert.equal(req.body.msg.item_list[0].text_item.text, 'hello')
  })

  it('already-wire senderId is idempotent (no double suffix)', async () => {
    await sendIlinkText('bot-token-B', 'abc@im.wechat', 'ctx-2', 'hi')
    assert.equal(captured.length, 1)
    const req = captured[0]!
    assert.equal(req.body.msg.to_user_id, 'abc@im.wechat', '不能拼成 abc@im.wechat@im.wechat')
  })

  it('outbound preserves base_info channel_version sentinel', async () => {
    await sendIlinkText('tok', 'sender', 'ctx', 'msg')
    assert.equal(captured[0]!.body.base_info.channel_version, 'openclaude-0.0.1')
  })
})
