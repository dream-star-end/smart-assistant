import * as assert from 'node:assert/strict'
import { createCipheriv } from 'node:crypto'
import { describe, it } from 'node:test'

import {
  decryptIlinkMediaBuffer,
  extractIlinkMediaAttachments,
} from '../iLinkMedia.js'

const AES_KEY = '00112233445566778899aabbccddeeff'

describe('iLink generic media extraction', () => {
  it('extracts voice/file/video attachments with decoded AES keys', () => {
    const b64Hex = Buffer.from(AES_KEY, 'utf8').toString('base64')
    const raw = {
      item_list: [
        {
          type: 3,
          voice_item: {
            text: '语音转写',
            encode_type: 7,
            media: { encrypt_query_param: 'voice-param', aes_key: b64Hex },
          },
        },
        {
          type: 4,
          file_item: {
            file_name: 'report.pdf',
            len: '123',
            media: { full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?a=1', aes_key: b64Hex },
          },
        },
        {
          type: 5,
          video_item: {
            video_size: 456,
            media: { encrypt_query_param: 'video-param', aes_key: b64Hex },
          },
        },
      ],
    }

    const out = extractIlinkMediaAttachments(raw)
    assert.equal(out.length, 3)
    assert.equal(out[0]!.kind, 'voice')
    assert.equal(out[0]!.voiceText, '语音转写')
    assert.equal(out[0]!.aesKeyHex, AES_KEY)
    assert.match(out[0]!.fullUrl, /novac2c\.cdn\.weixin\.qq\.com\/c2c\/download/)
    assert.equal(out[1]!.kind, 'file')
    assert.equal(out[1]!.fileName, 'report.pdf')
    assert.equal(out[2]!.kind, 'video')
    assert.equal(out[2]!.size, 456)
  })
})

describe('iLink generic media decryption', () => {
  it('decrypts files and preserves safe file names', () => {
    const pdf = Buffer.from('%PDF-1.7\nhello')
    const encrypted = encryptEcb(pdf)
    const decrypted = decryptIlinkMediaBuffer(encrypted, AES_KEY, {
      kind: 'file',
      fileName: '../unsafe/report.pdf',
    })
    assert.equal(decrypted.mimeType, 'application/pdf')
    assert.equal(decrypted.ext, 'pdf')
    assert.equal(decrypted.filename, 'report.pdf')
    assert.deepEqual(decrypted.buffer, pdf)
  })
})

function encryptEcb(plain: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', Buffer.from(AES_KEY, 'hex'), null)
  return Buffer.concat([cipher.update(plain), cipher.final()])
}
