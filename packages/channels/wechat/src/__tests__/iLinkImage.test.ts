import * as assert from 'node:assert/strict'
import { createCipheriv } from 'node:crypto'
import { describe, it } from 'node:test'

import {
  decryptIlinkImageBuffer,
  extractIlinkImageAttachments,
  WECHAT_IMAGE_MAX_ATTACHMENTS,
} from '../iLinkImage.js'

const AES_KEY = '00112233445566778899aabbccddeeff'
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

function encryptEcb(buf: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', Buffer.from(AES_KEY, 'hex'), null)
  return Buffer.concat([cipher.update(buf), cipher.final()])
}

describe('iLink image extraction', () => {
  it('extracts full_url + direct hex aeskey from image item', () => {
    const out = extractIlinkImageAttachments({
      item_list: [
        { type: 1, text_item: { text: 'hello' } },
        {
          type: 2,
          image_item: {
            aeskey: AES_KEY,
            msg_id: 'img-1',
            mid_size: 123,
            media: { full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?x=1' },
          },
        },
      ],
    })
    assert.equal(out.length, 1)
    assert.equal(out[0]!.fullUrl, 'https://novac2c.cdn.weixin.qq.com/c2c/download?x=1')
    assert.equal(out[0]!.aesKeyHex, AES_KEY)
    assert.equal(out[0]!.msgId, 'img-1')
    assert.equal(out[0]!.midSize, 123)
  })

  it('decodes media.aes_key when it is base64-encoded ascii hex', () => {
    const out = extractIlinkImageAttachments({
      item_list: [
        {
          type: 2,
          image_item: {
            media: {
              full_url: 'https://cdn.weixin.qq.com/c2c/download?x=1',
              aes_key: Buffer.from(AES_KEY, 'utf8').toString('base64'),
            },
          },
        },
      ],
    })
    assert.equal(out.length, 1)
    assert.equal(out[0]!.aesKeyHex, AES_KEY)
  })

  it('builds fallback c2c download URL from encrypted query param', () => {
    const out = extractIlinkImageAttachments({
      item_list: [
        {
          type: 2,
          image_item: {
            aeskey: AES_KEY,
            media: { encrypt_query_param: 'abc+/=' },
          },
        },
      ],
    })
    assert.equal(out.length, 1)
    assert.equal(
      out[0]!.fullUrl,
      'https://ilinkai.weixin.qq.com/c2c/download?encrypted_query_param=abc%2B%2F%3D',
    )
  })

  it('caps extracted attachments', () => {
    const item = {
      type: 2,
      image_item: {
        aeskey: AES_KEY,
        media: { full_url: 'https://cdn.weixin.qq.com/c2c/download?x=1' },
      },
    }
    const out = extractIlinkImageAttachments({ item_list: Array.from({ length: 20 }, () => item) })
    assert.equal(out.length, WECHAT_IMAGE_MAX_ATTACHMENTS)
  })
})

describe('iLink image decryption', () => {
  it('decrypts AES-128-ECB image payload and validates raster magic', () => {
    const decrypted = decryptIlinkImageBuffer(encryptEcb(PNG), AES_KEY)
    assert.equal(decrypted.ext, 'png')
    assert.equal(decrypted.mimeType, 'image/png')
    assert.deepEqual(decrypted.buffer, PNG)
  })

  it('rejects invalid decrypted payloads', () => {
    const encrypted = encryptEcb(Buffer.from('not an image'))
    assert.throws(() => decryptIlinkImageBuffer(encrypted, AES_KEY), /supported raster image/)
  })
})
