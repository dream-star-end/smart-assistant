import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { getUserError } from '../userErrorCatalog.js'
import {
  MAX_INLINE_TEXT_BYTES,
  MAX_UPLOAD_SINGLE_BYTES,
  MAX_UPLOAD_TOTAL_BYTES,
  attachmentSplitCount,
  attachmentTotalExceededFailureCode,
  attachmentTotalLimitMessage,
  formatUploadMegabytes,
  parseAttachmentTotalExceeded,
} from '../uploadLimits.js'

describe('upload total limit copy', () => {
  test('345649213 bytes formats as 330MB over 300MB in two messages', () => {
    const limit = 300 * 1024 * 1024
    const message = attachmentTotalLimitMessage(345649213, limit)
    assert.equal(formatUploadMegabytes(345649213), 330)
    assert.match(message, /330MB/)
    assert.match(message, /300MB/)
    assert.match(message, /两条/)
    assert.equal(message.includes('请重试'), false)
    assert.equal(attachmentSplitCount(345649213, limit), 2)
  })

  test('2GiB is within the total limit and one extra byte is over', () => {
    assert.equal(MAX_UPLOAD_SINGLE_BYTES, 100 * 1024 * 1024)
    assert.equal(MAX_UPLOAD_TOTAL_BYTES, 2 * 1024 * 1024 * 1024)
    assert.equal(MAX_INLINE_TEXT_BYTES, 300 * 1024 * 1024)
    assert.equal(attachmentSplitCount(300 * 1024 * 1024), 1)
    assert.equal(attachmentSplitCount(MAX_UPLOAD_TOTAL_BYTES), 1)
    const over = attachmentTotalLimitMessage(MAX_UPLOAD_TOTAL_BYTES + 1)
    assert.match(over, /超过/)
    assert.match(over, /2048MB/)
    assert.equal(over.includes('请重试'), false)
    assert.ok(attachmentSplitCount(MAX_UPLOAD_TOTAL_BYTES + 1) >= 2)
  })

  test('attachment total failure code round-trips and rejects other codes', () => {
    const code = attachmentTotalExceededFailureCode(345649213)
    assert.equal(code, 'ATTACHMENT_TOTAL_EXCEEDED:345649213')
    assert.deepEqual(parseAttachmentTotalExceeded(code), { totalBytes: 345649213 })
    assert.deepEqual(parseAttachmentTotalExceeded('attachment_total_exceeded:12'), { totalBytes: 12 })
    assert.equal(parseAttachmentTotalExceeded('DISPATCH_NOT_ACCEPTED'), null)
    assert.equal(parseAttachmentTotalExceeded('ATTACHMENT_TOTAL_EXCEEDED:'), null)
    assert.equal(parseAttachmentTotalExceeded('ATTACHMENT_TOTAL_EXCEEDED:-1'), null)
    assert.equal(parseAttachmentTotalExceeded('ATTACHMENT_TOTAL_EXCEEDED:1.5'), null)
    assert.equal(getUserError(code).code, 'attachment_total_exceeded')
    assert.deepEqual(getUserError(code).actions, [])
    assert.equal(getUserError(code).message.includes('请重试'), false)
  })
})
