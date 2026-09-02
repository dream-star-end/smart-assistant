/**
 * INC-20260903-PENDING-PERMISSION-LOST — hello-time catch-up of pending
 * permission prompts.
 *
 * A prompt emitted via _sendStampedSessionFrame only reaches sockets that were
 * registered at emit time. A browser attaching during the bridge reconnect
 * window never sees it, while the engine waits in waitingForUserInput with the
 * watchdog suppressed. autoResumeFromHello now replays still-answerable
 * pending prompts to the newly registered socket via this pure selector.
 *
 * Run: npx tsx --test --test-force-exit packages/gateway/src/__tests__/pendingPermissionHelloReplay.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  _pendingPermissionCatchupFrames,
  type PendingPermissionCatchupEntry,
} from '../server.js'

const SESSION_KEY = 'agent:main:webchat:dm:wsess-permreplay01'
const PEER_KEY = 'c:3|webchat|wsess-permreplay01'
const PEER = { id: 'wsess-permreplay01', kind: 'dm' as const }
const NOW = 1_760_000_000_000

function entry(overrides: Partial<PendingPermissionCatchupEntry> = {}): PendingPermissionCatchupEntry {
  return {
    sessionKey: SESSION_KEY,
    peerKey: PEER_KEY,
    toolName: 'AskUserQuestion',
    input: { questions: [{ question: 'How to handle the 3 incidents?', options: [] }] },
    channel: 'webchat',
    peer: PEER,
    expiresAt: NOW + 60_000,
    ...overrides,
  }
}

describe('_pendingPermissionCatchupFrames', () => {
  it('replays a still-answerable prompt for the exact sessionKey+peerKey without a frameSeq', () => {
    const pending = new Map<string, PendingPermissionCatchupEntry>([
      ['toolu_01', entry({ toolUseId: 'toolu_01', clientMessageId: 'm-mtk6eghg-7p-lxal' })],
    ])
    const frames = _pendingPermissionCatchupFrames(pending, SESSION_KEY, PEER_KEY, NOW)
    assert.equal(frames.length, 1)
    const frame = frames[0]!
    assert.equal(frame.type, 'outbound.permission_request')
    assert.equal(frame.sessionKey, SESSION_KEY)
    assert.equal(frame.requestId, 'toolu_01')
    assert.equal(frame.toolName, 'AskUserQuestion')
    assert.equal(frame.toolUseId, 'toolu_01')
    assert.equal(frame.clientMessageId, 'm-mtk6eghg-7p-lxal')
    assert.deepEqual(frame.peer, PEER)
    assert.deepEqual(frame.inputJson, pending.get('toolu_01')!.input)
    assert.equal(typeof frame.inputPreview, 'string')
    assert.equal(frame.expiresAt, NOW + 60_000)
    assert.equal(frame.ts, NOW)
    assert.equal('frameSeq' in frame, false, 'catch-up frames must not mint a ring seq')
    assert.equal('detachedAskUser' in frame, false)
  })

  it('drops expired prompts', () => {
    const pending = new Map<string, PendingPermissionCatchupEntry>([
      ['expired', entry({ expiresAt: NOW })],
      ['long-expired', entry({ expiresAt: NOW - 1 })],
      ['live', entry({ expiresAt: NOW + 1 })],
    ])
    const frames = _pendingPermissionCatchupFrames(pending, SESSION_KEY, PEER_KEY, NOW)
    assert.deepEqual(frames.map((f) => f.requestId), ['live'])
  })

  it('never crosses sessionKey or peerKey (other sessions / other users)', () => {
    const pending = new Map<string, PendingPermissionCatchupEntry>([
      ['other-session', entry({ sessionKey: 'agent:main:webchat:dm:wsess-other' })],
      ['other-user', entry({ peerKey: 'c:4|webchat|wsess-permreplay01' })],
      ['mine', entry()],
    ])
    const frames = _pendingPermissionCatchupFrames(pending, SESSION_KEY, PEER_KEY, NOW)
    assert.deepEqual(frames.map((f) => f.requestId), ['mine'])
  })

  it('keeps detached ask_user marker and omits absent optional fields', () => {
    const pending = new Map<string, PendingPermissionCatchupEntry>([
      ['ask-user:abc', entry({ detachedAskUser: true })],
    ])
    const [frame] = _pendingPermissionCatchupFrames(pending, SESSION_KEY, PEER_KEY, NOW)
    assert.equal(frame!.detachedAskUser, true)
    assert.equal('toolUseId' in frame!, false)
    assert.equal('clientMessageId' in frame!, false)
  })

  it('returns nothing when the map is empty', () => {
    assert.deepEqual(_pendingPermissionCatchupFrames(new Map(), SESSION_KEY, PEER_KEY, NOW), [])
  })
})
