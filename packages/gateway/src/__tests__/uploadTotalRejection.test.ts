import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { noteAttachmentTotalRejection, readUploadUserFailureCode } from '../uploadTotalRejection.js'

const testHome = await mkdtemp(join(tmpdir(), 'oc-gw-upload-total-'))
process.env.OPENCLAUDE_HOME = testHome

const { closeSessionsDb, insertQueuedTurnDispatch } = await import('@openclaude/storage')
const { buildTurnDispatchStateResponse, inboxReject } = await import('../turnDispatchInbox.js')

after(async () => {
  await closeSessionsDb()
  await rm(testHome, { recursive: true, force: true })
})

test('noteAttachmentTotalRejection stamps 330MB copy and a parseable code', () => {
  const frame: { __oc_upload_user_failure_code?: string } = {}
  const message = noteAttachmentTotalRejection(frame, 345649213)
  assert.match(message, /330MB/)
  assert.match(message, /300MB/)
  assert.match(message, /两条/)
  assert.equal(message.includes('请重试'), false)
  assert.equal(readUploadUserFailureCode(frame), 'ATTACHMENT_TOTAL_EXCEEDED:345649213')
  assert.equal(readUploadUserFailureCode({}), undefined)
  assert.equal(
    readUploadUserFailureCode({ __oc_upload_user_failure_code: 'DISPATCH_NOT_ACCEPTED' } as object),
    undefined,
  )
})

test('stamped attachment total code round-trips on the state response and is omitted when absent', async () => {
  const plain = buildTurnDispatchStateResponse(null)
  assert.equal('userFailureCode' in plain, false)
  const key = { userId: 'u1', sessionId: 'web-up-total', clientMessageId: 'cm-up-total' }
  await insertQueuedTurnDispatch({ ...key, dispatchId: 'd-up-total', attemptNo: 1, payloadHash: 'h' })
  const rejected = await inboxReject(key, undefined, 'ATTACHMENT_TOTAL_EXCEEDED:345649213')
  assert.equal(rejected?.state, 'rejected')
  assert.equal(rejected?.outcome, 'not_accepted')
  assert.equal(rejected?.userFailureCode, 'ATTACHMENT_TOTAL_EXCEEDED:345649213')
  const body = buildTurnDispatchStateResponse(rejected)
  assert.equal(body.userFailureCode, 'ATTACHMENT_TOTAL_EXCEEDED:345649213')
  assert.equal(body.outcome, 'not_accepted')
  await insertQueuedTurnDispatch({
    userId: 'u1',
    sessionId: 'web-up-other',
    clientMessageId: 'cm-up-other',
    dispatchId: 'd-up-other',
    attemptNo: 1,
    payloadHash: 'h',
  })
  const generic = await inboxReject(
    { userId: 'u1', sessionId: 'web-up-other', clientMessageId: 'cm-up-other' },
    undefined,
    'PLEASE_RETRY',
  )
  assert.equal(generic?.userFailureCode, undefined)
  assert.equal('userFailureCode' in buildTurnDispatchStateResponse(generic), false)
})
