import * as assert from 'node:assert/strict'
/**
 * Permission frames must flow through the outbound ring buffer so that a
 * reconnecting client (e.g. iOS Safari restoring a suspended tab) can replay
 * any approval prompt or settlement it missed during the disconnect window.
 *
 * Without this, the inline permission card persists in IndexedDB but the
 * modal never re-fires after reconnect, leaving the agent stuck waiting for
 * an approval the user can never give.
 *
 * These tests exercise the helper-and-broadcast path used by both
 * `permission_request` (in the active turn loop) and `_broadcastPermissionSettled`
 * — they must both stamp `frameSeq` + store in the ring, not naked `ws.send()`.
 */
import { describe, it } from 'node:test'
import { OutboundRingBuffer } from '../outboundRing.js'
import { Gateway } from '../server.js'

// Minimal mock WebSocket that just records sent payloads.
function createMockWs(): { send: (data: string) => void; sent: string[] } {
  const sent: string[] = []
  return {
    sent,
    send(data: string) {
      sent.push(data)
    },
  }
}

// Test harness type — Gateway's private fields can't be intersected (TS
// reduces intersections containing private members to `never`), so we
// describe the test surface independently and `any`-cast through.
type TestHarness = {
  _outboundRing: OutboundRingBuffer
  clientsByPeer: Map<string, Set<unknown>>
  _sendStampedSessionFrame: (
    sessionKey: string,
    peerKey: string,
    wireFrame: Record<string, unknown>,
  ) => void
}

// Create a Gateway instance without invoking its constructor — we only need
// the two fields the stamped-broadcast helper touches. Bypassing the
// constructor avoids pulling in storage / sessions / config plumbing that
// the helper does not depend on.
function harness(): TestHarness {
  // biome-ignore lint/suspicious/noExplicitAny: bypassing private-field check
  const gw = Object.create(Gateway.prototype) as any
  gw._outboundRing = new OutboundRingBuffer()
  gw.clientsByPeer = new Map()
  return gw as TestHarness
}

describe('permission frame ring replay', () => {
  it('permission_request via _sendStampedSessionFrame stamps frameSeq + stores in ring', () => {
    const gw = harness()
    const ws = createMockWs()
    const peerKey = 'default:webchat:p1'
    const sessionKey = 'agent:main:webchat:dm:p1'
    gw.clientsByPeer.set(peerKey, new Set([ws]))

    gw._sendStampedSessionFrame(sessionKey, peerKey, {
      type: 'outbound.permission_request',
      sessionKey,
      channel: 'webchat',
      peer: { id: 'p1', kind: 'dm' },
      requestId: 'req-1',
      toolName: 'Write',
      inputPreview: '{"file_path":"/tmp/x"}',
      inputJson: { file_path: '/tmp/x', content: 'hi' },
    })

    // Live broadcast lands on the connected ws with frameSeq stamped.
    assert.equal(ws.sent.length, 1)
    const live = JSON.parse(ws.sent[0])
    assert.equal(live.type, 'outbound.permission_request')
    assert.equal(live.frameSeq, 1)
    assert.equal(typeof live.ts, 'number')
    assert.equal(live.requestId, 'req-1')

    // Ring buffer holds the same frame for replay from cursor=0.
    const replay = gw._outboundRing.peekReplay(sessionKey, 0)
    assert.equal(replay.ok, true)
    if (!replay.ok) return
    assert.equal(replay.sent.length, 1)
    const replayed = JSON.parse(replay.sent[0].data)
    assert.equal(replayed.type, 'outbound.permission_request')
    assert.equal(replayed.frameSeq, 1)
    assert.equal(replayed.requestId, 'req-1')
  })

  it('settled frame stamped after request preserves request → settled order on replay', () => {
    const gw = harness()
    const ws = createMockWs()
    const peerKey = 'default:webchat:p1'
    const sessionKey = 'agent:main:webchat:dm:p1'
    gw.clientsByPeer.set(peerKey, new Set([ws]))

    gw._sendStampedSessionFrame(sessionKey, peerKey, {
      type: 'outbound.permission_request',
      sessionKey,
      channel: 'webchat',
      peer: { id: 'p1', kind: 'dm' },
      requestId: 'req-1',
      toolName: 'Write',
    })
    gw._sendStampedSessionFrame(sessionKey, peerKey, {
      type: 'outbound.permission_settled',
      sessionKey,
      channel: 'webchat',
      peer: { id: 'p1', kind: 'dm' },
      requestId: 'req-1',
      behavior: 'allow',
      reason: 'remote',
    })

    const replay = gw._outboundRing.peekReplay(sessionKey, 0)
    assert.equal(replay.ok, true)
    if (!replay.ok) return
    assert.equal(replay.sent.length, 2)
    const f1 = JSON.parse(replay.sent[0].data)
    const f2 = JSON.parse(replay.sent[1].data)
    assert.equal(f1.type, 'outbound.permission_request')
    assert.equal(f2.type, 'outbound.permission_settled')
    assert.ok(f2.frameSeq > f1.frameSeq, 'settled frameSeq must follow request')
  })

  it('helper still stamps + stores when no clients are connected', () => {
    // The disconnect-time settled path uses this: when the last WS for a
    // peerKey closes, _autoDenyPendingPermissions broadcasts a settled frame
    // to a now-empty client set. Writing it to the ring lets the next
    // reconnect replay the settled state and update the still-pending card.
    //
    // NOTE: actual `permission_request` does NOT take this branch — the
    // request handler auto-denies via session.runner before ever calling the
    // helper when clients.size === 0. We use a settled-shape frame here to
    // reflect the real-world flow.
    const gw = harness()
    const peerKey = 'default:webchat:p1'
    const sessionKey = 'agent:main:webchat:dm:p1'
    // No client registered.

    gw._sendStampedSessionFrame(sessionKey, peerKey, {
      type: 'outbound.permission_settled',
      sessionKey,
      channel: 'webchat',
      peer: { id: 'p1', kind: 'dm' },
      requestId: 'req-orphan',
      behavior: 'deny',
      reason: 'disconnect',
    })

    const replay = gw._outboundRing.peekReplay(sessionKey, 0)
    assert.equal(replay.ok, true)
    if (!replay.ok) return
    assert.equal(replay.sent.length, 1)
    const stored = JSON.parse(replay.sent[0].data)
    assert.equal(stored.type, 'outbound.permission_settled')
    assert.equal(stored.requestId, 'req-orphan')
    assert.equal(stored.reason, 'disconnect')
  })

  it('empty sessionKey skips ring storage but still broadcasts', () => {
    // Fallback path used by the no-prior-settlement branch in
    // handlePermissionResponse: sessionKey=''. The helper must NOT throw
    // on empty key and the frame must NOT pollute the ring.
    const gw = harness()
    const ws = createMockWs()
    const peerKey = 'default:webchat:p1'
    gw.clientsByPeer.set(peerKey, new Set([ws]))

    gw._sendStampedSessionFrame('', peerKey, {
      type: 'outbound.permission_settled',
      sessionKey: '',
      channel: 'webchat',
      peer: { id: 'p1', kind: 'dm' },
      requestId: 'req-late',
      behavior: 'deny',
      reason: 'already_settled',
    })

    assert.equal(ws.sent.length, 1)
    const live = JSON.parse(ws.sent[0])
    assert.equal(live.type, 'outbound.permission_settled')
    assert.equal(typeof live.ts, 'number')
    // No frameSeq when sessionKey is empty.
    assert.equal(live.frameSeq, undefined)
  })
})
