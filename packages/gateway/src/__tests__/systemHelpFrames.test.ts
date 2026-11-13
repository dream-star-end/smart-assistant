import assert from 'node:assert/strict'
import test from 'node:test'
import { SYSTEM_HELP_BOOTSTRAP_FIELD, takeSystemHelpBootstrap } from '@openclaude/protocol'
import { captureSystemHelpFrame, getSystemHelpBootstrap } from '../systemHelpFrames.js'
import { attachDispatchContext } from '../turnDispatchInbox.js'
const dispatch = { uid: '765', sessionId: 'synthetic-session', clientMessageId: 'synthetic-message', dispatchId: '00000000-0000-4000-8000-000000000001', attemptNo: 1, payloadHash: 'a'.repeat(64), billingRequestId: 'synthetic-billing' }
test('opaque help is stripped from every wire shape and attached only after trusted bridge dispatch verification', () => {
  const frame = { type: 'inbound.message', [SYSTEM_HELP_BOOTSTRAP_FIELD]: 'synthetic-bootstrap' }
  const opaque = takeSystemHelpBootstrap(frame)
  assert.equal(JSON.stringify(frame).includes('synthetic-bootstrap'), false)
  captureSystemHelpFrame(frame, opaque, true); assert.equal(getSystemHelpBootstrap(frame), undefined)
  attachDispatchContext(frame, dispatch)
  captureSystemHelpFrame(frame, opaque, false); assert.equal(getSystemHelpBootstrap(frame), undefined)
  captureSystemHelpFrame(frame, opaque, true); assert.equal(getSystemHelpBootstrap(frame), opaque)
  assert.equal(JSON.stringify(frame).includes('synthetic-bootstrap'), false)
  for (const value of [null, {}, 12, 'a'.repeat(4097)]) {
    const forged = { [SYSTEM_HELP_BOOTSTRAP_FIELD]: value }
    assert.equal(takeSystemHelpBootstrap(forged), undefined)
    assert.equal(SYSTEM_HELP_BOOTSTRAP_FIELD in forged, false)
  }
})
