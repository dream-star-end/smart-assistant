import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { getUserError } from '../userErrorCatalog.js'
import {
  MAX_INLINE_TEXT_BYTES,
  MAX_UPLOAD_CHUNK_BYTES,
  MAX_UPLOAD_FILE_BYTES,
  MAX_UPLOAD_SINGLE_BYTES,
  MAX_UPLOAD_TOTAL_BYTES,
  MAX_USER_UPLOAD_QUOTA_BYTES,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_PART_MAX_AGE_MS,
  UPLOAD_RETENTION_MS,
  attachmentSplitCount,
  attachmentTotalExceededFailureCode,
  attachmentTotalLimitMessage,
  formatUploadMegabytes,
  isStaleUploadPartName,
  parseAttachmentTotalExceeded,
  shouldDeleteAgedUpload,
  uploadFailureCanContinue,
  uploadFileLimitMessage,
  uploadFileTooLarge,
  uploadQuotaExceeded,
  uploadQuotaMessage,
} from '../uploadLimits.js'
import { uploadChunkCount, uploadChunkLength } from '../uploadChunkSizing.js'

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

describe('chunked file cap, quota, and retention', () => {
  test('assembled file cap is 1GiB and one HTTP body stays 100MiB', () => {
    assert.equal(MAX_UPLOAD_FILE_BYTES, 1024 * 1024 * 1024)
    assert.equal(MAX_UPLOAD_SINGLE_BYTES, 100 * 1024 * 1024)
    assert.equal(UPLOAD_CHUNK_BYTES, 16 * 1024 * 1024)
    assert.ok(UPLOAD_CHUNK_BYTES >= 8 * 1024 * 1024)
    assert.ok(UPLOAD_CHUNK_BYTES <= MAX_UPLOAD_CHUNK_BYTES)
    assert.equal(uploadFileTooLarge(MAX_UPLOAD_FILE_BYTES), false)
    assert.equal(uploadFileTooLarge(MAX_UPLOAD_FILE_BYTES + 1), true)
    assert.equal(uploadChunkCount(1), 1)
    assert.equal(uploadChunkCount(UPLOAD_CHUNK_BYTES + 1), 2)
    assert.equal(uploadChunkCount(MAX_UPLOAD_FILE_BYTES), 64)
    assert.equal(uploadChunkLength(UPLOAD_CHUNK_BYTES + 1, 1), 1)
    const message = uploadFileLimitMessage(MAX_UPLOAD_FILE_BYTES + 1)
    assert.match(message, /单个文件/)
    assert.match(message, /1024MB/)
    assert.match(message, /超过/)
    assert.equal(message.includes('请重试'), false)
  })

  test('10GiB quota tells the user to delete old files and does not charge', () => {
    assert.equal(MAX_USER_UPLOAD_QUOTA_BYTES, 10 * 1024 * 1024 * 1024)
    assert.equal(uploadQuotaExceeded(MAX_USER_UPLOAD_QUOTA_BYTES, 0), false)
    assert.equal(uploadQuotaExceeded(MAX_USER_UPLOAD_QUOTA_BYTES - 1, 1), false)
    assert.equal(uploadQuotaExceeded(MAX_USER_UPLOAD_QUOTA_BYTES, 1), true)
    const message = uploadQuotaMessage(9 * 1024 * 1024 * 1024, 2 * 1024 * 1024 * 1024)
    assert.match(message, /免费额度/)
    assert.match(message, /请删除旧文件/)
    assert.match(message, /本次不收费/)
    assert.equal(message.includes('请重试'), false)
    assert.equal(uploadFailureCanContinue(message), false)
    assert.equal(uploadFailureCanContinue(uploadFileLimitMessage(MAX_UPLOAD_FILE_BYTES + 1)), false)
    assert.equal(uploadFailureCanContinue('网络中断'), true)
  })

  test('30 day files stay when a recent session references them, and stale parts are removable', () => {
    assert.equal(shouldDeleteAgedUpload(UPLOAD_RETENTION_MS - 1, false), false)
    assert.equal(shouldDeleteAgedUpload(UPLOAD_RETENTION_MS, false), true)
    assert.equal(shouldDeleteAgedUpload(UPLOAD_RETENTION_MS + 1, true), false)
    const part = `.part-${'a'.repeat(32)}-0`
    const meta = `.upload-${'b'.repeat(32)}.json`
    assert.equal(isStaleUploadPartName(part, UPLOAD_PART_MAX_AGE_MS), true)
    assert.equal(isStaleUploadPartName(part, UPLOAD_PART_MAX_AGE_MS - 1), false)
    assert.equal(isStaleUploadPartName(meta, UPLOAD_PART_MAX_AGE_MS), true)
    assert.equal(isStaleUploadPartName('abc.txt', UPLOAD_PART_MAX_AGE_MS * 2), false)
    assert.equal(isStaleUploadPartName('.tmp-abc', UPLOAD_PART_MAX_AGE_MS * 2), false)
  })
})
