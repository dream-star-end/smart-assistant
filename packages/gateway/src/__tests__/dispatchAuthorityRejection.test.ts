import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodeDispatchAuthorityEnvelope } from '@openclaude/protocol'
import type { WebSocket } from 'ws'
import { _rejectAuthority, type TurnDispatchHost } from '../turnDispatch.js'

test('OCV5-682: expired authority refusal echoes only exact delivery identities and redacts authority details', () => {
  const sent: string[] = []
  const host = { log: { warn() {} } } as unknown as TurnDispatchHost
  const ws = { send: (text: string) => sent.push(text) } as unknown as WebSocket
  const dispatch = {
    v: 1 as const, keyId: 'private-key-id', uid: '3', containerId: '8', sessionId: 'session-682',
    clientMessageId: 'cm-682', dispatchId: '00000000-0000-4000-8000-000000000682', attemptNo: 1,
    payloadHash: 'a'.repeat(64), billingRequestId: 'private-billing-id', connectionChallenge: 'private-challenge',
    issuedAt: 0, expiresAt: 120000,
  }
  _rejectAuthority.call(host, ws, 'expired', 'private-challenge private-key-id', {
    type: 'inbound.message', clientMessageId: 'cm-682', peer: { id: 'session-682', kind: 'dm' },
    __oc_dispatch: encodeDispatchAuthorityEnvelope(dispatch, Buffer.alloc(64)),
  })
  const frame = JSON.parse(sent[0]!)
  assert.equal(frame.clientMessageId, 'cm-682')
  assert.equal(frame.peer.id, 'session-682')
  assert.equal(frame.dispatchId, dispatch.dispatchId)
  assert.equal(frame.attemptNo, 1)
  assert.equal(frame.authorityExpired, true)
  assert.doesNotMatch(sent[0]!, /private-/)
  _rejectAuthority.call(host, ws, 'bad_shape', 'private-detail', { type: 'inbound.message', __oc_dispatch: 'broken' })
  assert.equal(JSON.parse(sent[1]!).dispatchId, undefined)
  assert.doesNotMatch(sent[1]!, /private-/)
})
