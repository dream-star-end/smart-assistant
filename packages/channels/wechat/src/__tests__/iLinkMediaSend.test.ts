import * as assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { sendIlinkMedia } from '../iLink.js'

interface CapturedRequest {
  url: string
  method: string | undefined
  headers: Record<string, string>
  body: any
}

let captured: CapturedRequest[] = []
let originalFetch: typeof globalThis.fetch | undefined

beforeEach(() => {
  originalFetch = globalThis.fetch
  captured = []
  globalThis.fetch = async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url
    const headers: Record<string, string> = {}
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers)) headers[k] = String(v)
    }
    let body: any = init?.body
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body)
      } catch {}
    }
    captured.push({ url, method: init?.method, headers, body })
    if (url.includes('/ilink/bot/getuploadurl')) {
      return new Response(JSON.stringify({ upload_param: 'upload-param' }), { status: 200 })
    }
    if (url.includes('/c2c/upload')) {
      return new Response('', {
        status: 200,
        headers: { 'x-encrypted-param': 'download-param' },
      })
    }
    if (url.includes('/ilink/bot/sendmessage')) {
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
    }
    return new Response('unexpected', { status: 500 })
  }
})

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch
})

describe('sendIlinkMedia', () => {
  it('uploads encrypted media then sends image item', async () => {
    await sendIlinkMedia('bot-token', 'wx-user', {
      kind: 'image',
      filename: 'out.png',
      content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]),
      contextToken: 'ctx',
    })

    assert.equal(captured.length, 3)
    assert.match(captured[0]!.url, /\/ilink\/bot\/getuploadurl$/)
    assert.equal(captured[0]!.body.media_type, 1)
    assert.equal(captured[0]!.body.to_user_id, 'wx-user@im.wechat')
    assert.match(captured[1]!.url, /\/c2c\/upload\?/)
    assert.equal(captured[1]!.headers['Content-Type'], 'application/octet-stream')
    assert.ok(captured[1]!.body instanceof Uint8Array)
    assert.match(captured[2]!.url, /\/ilink\/bot\/sendmessage$/)
    assert.equal(captured[2]!.body.msg.context_token, 'ctx')
    const item = captured[2]!.body.msg.item_list[0]
    assert.equal(item.type, 2)
    assert.equal(item.image_item.media.encrypt_query_param, 'download-param')
  })

  it('uses file and voice item shapes', async () => {
    await sendIlinkMedia('bot-token', 'wx-user@im.wechat', {
      kind: 'file',
      filename: 'report.pdf',
      content: Buffer.from('%PDF-1.7'),
      contextToken: 'ctx-file',
    })
    let item = captured.at(-1)!.body.msg.item_list[0]
    assert.equal(item.type, 4)
    assert.equal(item.file_item.file_name, 'report.pdf')
    assert.equal(item.file_item.len, String(Buffer.byteLength('%PDF-1.7')))

    await sendIlinkMedia('bot-token', 'wx-user', {
      kind: 'voice',
      filename: 'voice.mp3',
      content: Buffer.from('ID3voice'),
      contextToken: 'ctx-voice',
      mimeType: 'audio/mpeg',
    })
    item = captured.at(-1)!.body.msg.item_list[0]
    assert.equal(item.type, 3)
    assert.equal(item.voice_item.encode_type, 7)
  })
})
