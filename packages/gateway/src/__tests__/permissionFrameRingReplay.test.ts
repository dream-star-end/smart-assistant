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
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

process.env.OPENCLAUDE_HOME = mkdtempSync(join(tmpdir(), 'oc-permission-ring-'))
const { OutboundRingBuffer } = await import('../outboundRing.js')
const { Gateway } = await import('../server.js')
const {
  appendClientSessionTapeFrame,
  listClientSessionTapePage,
  listClientSessions,
  upsertClientSession,
} = await import('@openclaude/storage')

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
  _outboundRing: InstanceType<typeof OutboundRingBuffer>
  _redisPendingFrames: Map<string, Map<number, unknown>>
  _redisGapTimers: Map<string, ReturnType<typeof setTimeout>>
  _sessionDeliveryChains: Map<string, Promise<void>>
  invalidatedSessionLists: string[]
  clientsByPeer: Map<string, Set<unknown>>
  _sendStampedSessionFrame: (
    sessionKey: string,
    peerKey: string,
    wireFrame: Record<string, unknown>,
    tapeTurnKey?: string,
  ) => void
  _deliverWebchatAsync: (
    wire: Record<string, unknown>,
    peerKey: string,
    sessionKey: string,
    userId: string,
    turnKey: string,
  ) => Promise<void>
  _handleRedisSessionFrame: (frame: Record<string, unknown>) => void
}

// Create a Gateway instance without invoking its constructor — we only need
// the two fields the stamped-broadcast helper touches. Bypassing the
// constructor avoids pulling in storage / sessions / config plumbing that
// the helper does not depend on.
function harness(): TestHarness {
  const gw = Object.create(Gateway.prototype) as any
  gw._outboundRing = new OutboundRingBuffer()
  gw._redisPendingFrames = new Map()
  gw._redisGapTimers = new Map()
  gw._sessionDeliveryChains = new Map()
  gw._tapePoisoned = new Set()
  gw.invalidatedSessionLists = []
  gw.sessions = { getByKey: () => ({ userId: 'default', _activeTurnId: 'turn-test' }) }
  gw._redisSessionBus = {
    reserveFrameSeq: async () => null,
    advanceFrameSeq: async () => null,
    publishFrame: () => {},
    invalidateSessionList: (userId: string) => gw.invalidatedSessionLists.push(userId),
  }
  gw.log = { warn: () => {} }
  gw.clientsByPeer = new Map()
  return gw as TestHarness
}

async function flushSessionDelivery(gw: TestHarness, sessionKey: string): Promise<void> {
  const pending = gw._sessionDeliveryChains.get(sessionKey)
  if (pending) await pending
}

describe('permission frame ring replay', () => {
  it('permission_request via _sendStampedSessionFrame stamps frameSeq + stores in ring', async () => {
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
    await flushSessionDelivery(gw, sessionKey)

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

  it('settled frame stamped after request preserves request → settled order on replay', async () => {
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
    await flushSessionDelivery(gw, sessionKey)

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

  it('helper still stamps + stores when no clients are connected', async () => {
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
    await flushSessionDelivery(gw, sessionKey)

    const replay = gw._outboundRing.peekReplay(sessionKey, 0)
    assert.equal(replay.ok, true)
    if (!replay.ok) return
    assert.equal(replay.sent.length, 1)
    const stored = JSON.parse(replay.sent[0].data)
    assert.equal(stored.type, 'outbound.permission_settled')
    assert.equal(stored.requestId, 'req-orphan')
    assert.equal(stored.reason, 'disconnect')
  })

  it('keeps permission sidecars and the final inside one canonical tape turn', async () => {
    const gw = harness()
    const sessionId = 'p-unified'
    const sessionKey = `agent:main:webchat:dm:${sessionId}`
    const peerKey = `default:webchat:${sessionId}`
    const turnKey = 'client-turn-key'
    await upsertClientSession({
      id: sessionId,
      userId: 'default',
      agentId: 'main',
      title: 'Unified',
      pinned: false,
      createdAt: 1,
      lastAt: 1,
      updatedAt: 1,
      messages: [],
    })
    await appendClientSessionTapeFrame({
      sessionId,
      userId: 'default',
      turnKey,
      direction: 'inbound',
      ts: 1,
      frame: { type: 'inbound.message', clientMessage: { id: 'u-unified' } },
    })
    gw._sendStampedSessionFrame(
      sessionKey,
      peerKey,
      {
        type: 'outbound.permission_request',
        sessionKey,
        channel: 'webchat',
        peer: { id: sessionId, kind: 'dm' },
        requestId: 'req-unified',
        toolName: 'Bash',
      },
      turnKey,
    )
    gw._sendStampedSessionFrame(
      sessionKey,
      peerKey,
      {
        type: 'outbound.permission_settled',
        sessionKey,
        channel: 'webchat',
        peer: { id: sessionId, kind: 'dm' },
        requestId: 'req-unified',
        behavior: 'allow',
        reason: 'remote',
      },
      turnKey,
    )
    await flushSessionDelivery(gw, sessionKey)
    await gw._deliverWebchatAsync(
      {
        type: 'outbound.message',
        sessionKey,
        channel: 'webchat',
        peer: { id: sessionId, kind: 'dm' },
        blocks: [],
        isFinal: true,
      },
      peerKey,
      sessionKey,
      'default',
      turnKey,
    )

    const page = await listClientSessionTapePage(sessionId, 'default', { turns: 1 })
    assert.deepEqual(new Set(page?.frames.map((frame) => frame.turnKey)), new Set([turnKey]))
    assert.deepEqual(
      page?.frames.map((frame) => frame.frame.type),
      [
        'inbound.message',
        'outbound.permission_request',
        'outbound.permission_settled',
        'outbound.message',
      ],
    )
    assert.equal(page?.hasMore, false)
    assert.deepEqual(
      gw.invalidatedSessionLists,
      ['default'],
      'final tape commit makes the new lastTapeSeq visible to the next list sync',
    )
    const meta = (await listClientSessions('default')).find((item) => item.id === sessionId)
    assert.equal(meta?.tapeTurnCount, 1)
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

  it('redis pub/sub fanout waits for contiguous frameSeq before ws.send', () => {
    const gw = harness()
    const ws = createMockWs()
    const peerKey = 'default:webchat:p1'
    const sessionKey = 'agent:main:webchat:dm:p1'
    gw.clientsByPeer.set(peerKey, new Set([ws]))

    const redisFrame = (seq: number) => ({
      originId: 'other',
      sessionKey,
      peerKey,
      frameSeq: seq,
      ts: 1000 + seq,
      data: JSON.stringify({
        type: 'outbound.message',
        sessionKey,
        channel: 'webchat',
        peer: { id: 'p1', kind: 'dm' },
        frameSeq: seq,
      }),
    })

    gw._handleRedisSessionFrame(redisFrame(2))
    assert.equal(ws.sent.length, 0, 'seq=2 must wait for missing seq=1')
    assert.equal(gw._outboundRing.lastFrameSeq(sessionKey), 0)

    gw._handleRedisSessionFrame(redisFrame(1))
    assert.equal(ws.sent.length, 2)
    assert.deepEqual(
      ws.sent.map((raw) => JSON.parse(raw).frameSeq),
      [1, 2],
    )
    assert.equal(gw._outboundRing.lastFrameSeq(sessionKey), 2)
  })

  it('redis pub/sub gap timeout signals resume_failed and advances cursor', async () => {
    const gw = harness()
    const ws = createMockWs()
    const peerKey = 'default:webchat:p1'
    const sessionKey = 'agent:main:webchat:dm:p1'
    gw.clientsByPeer.set(peerKey, new Set([ws]))

    gw._handleRedisSessionFrame({
      originId: 'other',
      sessionKey,
      peerKey,
      frameSeq: 2,
      ts: 1002,
      data: JSON.stringify({
        type: 'outbound.message',
        sessionKey,
        channel: 'webchat',
        peer: { id: 'p1', kind: 'dm' },
        frameSeq: 2,
      }),
    })

    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(ws.sent.length, 1)
    const failed = JSON.parse(ws.sent[0])
    assert.equal(failed.type, 'outbound.resume_failed')
    assert.equal(failed.reason, 'buffer_miss')
    assert.equal(gw._outboundRing.lastFrameSeq(sessionKey), 2)
  })
})
