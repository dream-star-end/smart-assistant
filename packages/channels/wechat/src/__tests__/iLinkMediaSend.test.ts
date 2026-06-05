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
let uploadResponse: unknown

const currentUploadFullUrl =
  'https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=current-param&filekey=current-filekey'

beforeEach(() => {
  originalFetch = globalThis.fetch
  captured = []
  uploadResponse = { upload_full_url: currentUploadFullUrl }
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
      return new Response(JSON.stringify(uploadResponse), { status: 200 })
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
      clientId: 'oc-media-stable',
    })

    assert.equal(captured.length, 3)
    assert.match(captured[0]!.url, /\/ilink\/bot\/getuploadurl$/)
    assert.equal(captured[0]!.body.media_type, 1)
    assert.equal(captured[0]!.body.to_user_id, 'wx-user@im.wechat')
    assert.equal(captured[1]!.url, currentUploadFullUrl)
    assert.equal(captured[1]!.headers['Content-Type'], 'application/octet-stream')
    assert.ok(captured[1]!.body instanceof Uint8Array)
    assert.match(captured[2]!.url, /\/ilink\/bot\/sendmessage$/)
    assert.equal(captured[2]!.body.msg.context_token, 'ctx')
    assert.equal(captured[2]!.body.msg.client_id, 'oc-media-stable')
    const item = captured[2]!.body.msg.item_list[0]
    assert.equal(item.type, 2)
    assert.equal(item.image_item.media.encrypt_query_param, 'download-param')
  })

  it('keeps the legacy upload_param response shape', async () => {
    uploadResponse = { upload_param: 'legacy-param' }

    await sendIlinkMedia('bot-token', 'wx-user', {
      kind: 'file',
      filename: 'report.pdf',
      content: Buffer.from('%PDF-1.7'),
      contextToken: 'ctx-file',
    })

    assert.match(
      captured[1]!.url,
      /^https:\/\/novac2c\.cdn\.weixin\.qq\.com\/c2c\/upload\?/,
    )
    assert.match(captured[1]!.url, /encrypted_query_param=legacy-param/)
    assert.match(captured[1]!.url, /filekey=[0-9a-f]{32}/)
    const item = captured[2]!.body.msg.item_list[0]
    assert.equal(item.type, 4)
    assert.equal(item.file_item.media.encrypt_query_param, 'download-param')
  })

  it('throws a redacted error when getuploadurl has no usable upload target', async () => {
    uploadResponse = {
      errcode: 0,
      upload_url: 'https://sensitive.example/upload?token=secret-token',
      nested: { upload_param: 'secret-param' },
    }

    await assert.rejects(
      () =>
        sendIlinkMedia('bot-token', 'wx-user', {
          kind: 'file',
          filename: 'report.pdf',
          content: Buffer.from('%PDF-1.7'),
          contextToken: 'ctx-file',
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.match(
          err.message,
          /iLink getuploadurl returned no upload target \(keys: errcode, upload_url, nested\)/,
        )
        assert.doesNotMatch(err.message, /secret-token|secret-param|sensitive\.example/)
        return true
      },
    )
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

  it('uses separate stable client_id values for caption text and media ref', async () => {
    await sendIlinkMedia('bot-token', 'wx-user', {
      kind: 'file',
      filename: 'report.pdf',
      content: Buffer.from('%PDF-1.7'),
      contextToken: 'ctx-file',
      caption: 'caption text',
      captionClientId: 'oc-caption-stable',
      clientId: 'oc-file-stable',
    })

    const sendMessages = captured.filter((req) => /\/ilink\/bot\/sendmessage$/.test(req.url))
    assert.equal(sendMessages.length, 2)
    assert.equal(sendMessages[0]!.body.msg.client_id, 'oc-caption-stable')
    assert.equal(sendMessages[0]!.body.msg.item_list[0].text_item.text, 'caption text')
    assert.equal(sendMessages[1]!.body.msg.client_id, 'oc-file-stable')
    assert.equal(sendMessages[1]!.body.msg.item_list[0].type, 4)
  })
})
