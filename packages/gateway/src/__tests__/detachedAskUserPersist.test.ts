/**
 * Detached ask_user durable persist: must go through the master sink
 * (container SQLite is empty on v3/v5 selfhost) and must not swallow failures.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/detachedAskUserPersist.test.ts
 */
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { Gateway } from '../server.js'
import {
  DETACHED_ASK_USER_TTL_MS,
  buildDetachedAskUserPersistMessage,
  buildDetachedAskUserResolvedSinkPayload,
  buildDetachedAskUserSinkPayload,
  isDetachedAskUserPending,
} from '../detachedAskUser.js'
import {
  setV3MasterSinkSingleton,
  type PersistOutcome,
  type V3MasterSink,
  type V3MasterSinkPayload,
} from '../v3MasterSink.js'

const REQUEST_ID = 'ask-user:' + 'ab'.repeat(16)
const QUESTIONS = [{ question: 'Which editor?', options: [{ label: 'Vim' }, { label: 'Emacs' }] }]

function makeGateway(log: {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}): any {
  const gateway = Object.create(Gateway.prototype) as any
  gateway.log = { debug: () => {}, ...log }
  return gateway
}

function mockSink(
  persistOrQueue: (payload: V3MasterSinkPayload) => Promise<PersistOutcome>,
): V3MasterSink {
  return {
    persistOrQueue,
    attemptOnce: async () => {},
  }
}

afterEach(() => {
  setV3MasterSinkSingleton(null)
})

describe('buildDetachedAskUserSinkPayload', () => {
  it('builds a permission-only sidecar for the master v1 body', () => {
    const payload = buildDetachedAskUserSinkPayload({
      requestId: REQUEST_ID,
      questions: QUESTIONS,
      sessionKey: 'agent:main:webchat:dm:sess12345',
      agentId: 'main',
      sessionId: 'sess12345',
      channel: 'webchat',
      peer: { id: 'sess12345', kind: 'dm' },
      expiresAt: 1_720_086_400_000,
      ts: 1_720_000_000_000,
    })
    assert.equal(payload.text, '')
    assert.equal(payload.status, 'completed')
    assert.equal(payload.permissionCards.length, 1)
    assert.equal(payload.permissionCards[0]!.requestId, REQUEST_ID)
    assert.equal(payload.permissionCards[0]!.expiresAt, 1_720_086_400_000)
  })
})

describe('_persistDetachedAskUserCard — master sink path', () => {
  const args = {
    requestId: REQUEST_ID,
    questions: QUESTIONS,
    sessionKey: 'agent:main:webchat:dm:sess12345',
    userId: 'c:3',
    channel: 'webchat',
    peer: { id: 'sess12345', kind: 'dm' as const },
    expiresAt: Date.now() + 24 * 60 * 60_000,
    agentId: 'main',
  }

  it('POSTs the durable card through persistOrQueue (not local SQLite)', async () => {
    const captured: V3MasterSinkPayload[] = []
    setV3MasterSinkSingleton(mockSink(async (payload) => {
      captured.push(payload)
      return { ok: true }
    }))
    const gateway = makeGateway({ info: () => {}, warn: () => {}, error: () => {} })
    await gateway._persistDetachedAskUserCard(args)
    assert.equal(captured.length, 1)
    assert.equal(captured[0]!.text, '')
    assert.equal(captured[0]!.permissionCards?.[0]?.requestId, REQUEST_ID)
    assert.equal(captured[0]!.sessionId, 'sess12345')
  })

  it('logs error when the sink drops the card (no longer silent warn)', async () => {
    setV3MasterSinkSingleton(mockSink(async () => ({
      ok: false,
      queued: false,
      droppedReason: 'session deleted',
    })))
    const errors: unknown[][] = []
    const warns: unknown[][] = []
    const gateway = makeGateway({
      info: () => {},
      warn: (...a) => warns.push(a),
      error: (...a) => errors.push(a),
    })
    await gateway._persistDetachedAskUserCard(args)
    assert.equal(errors.length, 1)
    assert.match(String(errors[0]![0]), /dropped by master sink/)
    assert.equal(warns.length, 0)
  })

  it('logs error when persistOrQueue throws', async () => {
    setV3MasterSinkSingleton(mockSink(async () => {
      throw new Error('ENOSPC')
    }))
    const errors: unknown[][] = []
    const gateway = makeGateway({
      info: () => {},
      warn: () => {},
      error: (...a) => errors.push(a),
    })
    await gateway._persistDetachedAskUserCard(args)
    assert.equal(errors.length, 1)
    assert.match(String(errors[0]![0]), /master sink failed/)
  })

  it('logs error when the first attempt fails but the card is queued for retry', async () => {
    setV3MasterSinkSingleton(mockSink(async () => ({
      ok: false,
      queued: true,
      errorClass: 'transient',
    })))
    const errors: unknown[][] = []
    const gateway = makeGateway({
      info: () => {},
      warn: () => {},
      error: (...a) => errors.push(a),
    })
    await gateway._persistDetachedAskUserCard(args)
    assert.equal(errors.length, 1)
    assert.match(String(errors[0]![0]), /queued for master-sink retry/)
  })
})

describe('_hydrateDetachedAskUserPending — authoritative master card', () => {
  const expiresAt = Date.now() + DETACHED_ASK_USER_TTL_MS
  const card = buildDetachedAskUserPersistMessage({
    requestId: REQUEST_ID,
    questions: QUESTIONS,
    sessionKey: 'agent:main:webchat:dm:sess12345',
    userId: 'c:3',
    channel: 'webchat',
    peer: { id: 'sess12345', kind: 'dm' },
    expiresAt,
  })

  it('rebuilds a 24h detached pending from the master card and the sweeper does not kill it', async () => {
    const gateway = makeGateway({ info: () => {}, warn: () => {}, error: () => {} })
    gateway._loadDetachedAskUserCard = async () => card
    const pending = await gateway._hydrateDetachedAskUserPending({
      requestId: REQUEST_ID,
      channel: 'webchat',
      peer: { id: 'sess12345', kind: 'dm' },
      _userId: 'c:3',
    })
    assert.ok(pending)
    assert.equal(pending!.detachedAskUser, true)
    assert.equal(isDetachedAskUserPending(pending), true)
    assert.equal(pending!.expiresAt, expiresAt)
    assert.ok(pending!.expiresAt - Date.now() > 20 * 60 * 60_000)

    gateway._pendingPermissions = new Map()
    gateway.sessions = { getByKey: () => undefined }
    const denied: string[] = []
    gateway._forceDenyPendingPermission = (requestId: string) => {
      denied.push(requestId)
      return true
    }
    gateway._pendingPermissions.set(REQUEST_ID, pending)
    gateway._sweepStalePendingPermissions()
    assert.deepEqual(denied, [])
    assert.equal(gateway._pendingPermissions.has(REQUEST_ID), true)
  })

  it('does not treat a resolved master card as answerable', async () => {
    const gateway = makeGateway({ info: () => {}, warn: () => {}, error: () => {} })
    gateway._loadDetachedAskUserCard = async () => ({ ...card, _resolved: true })
    const pending = await gateway._hydrateDetachedAskUserPending({
      requestId: REQUEST_ID,
      channel: 'webchat',
      peer: { id: 'sess12345', kind: 'dm' },
      _userId: 'c:3',
    })
    assert.equal(pending, null)
  })
})

describe('_patchDetachedAskUserResolved — master sink path', () => {
  const pending = {
    sessionKey: 'agent:main:webchat:dm:sess12345',
    userId: 'c:3',
    channel: 'webchat',
    peer: { id: 'sess12345', kind: 'dm' as const },
  }

  it('POSTs resolved state (+ user answer) through persistOrQueue, not local SQLite', async () => {
    const captured: V3MasterSinkPayload[] = []
    setV3MasterSinkSingleton(mockSink(async (payload) => {
      captured.push(payload)
      return { ok: true }
    }))
    const gateway = makeGateway({ info: () => {}, warn: () => {}, error: () => {} })
    await gateway._patchDetachedAskUserResolved(
      pending,
      REQUEST_ID,
      { _resolved: true, _behavior: 'allow', _settledReason: 'remote', _answers: { q: 'Vim' } },
      { id: 'ask-ans-sess12345abcdefghijkl', text: '用户已回答提问：' },
    )
    assert.equal(captured.length, 1)
    assert.equal(captured[0]!.text, '')
    assert.equal(captured[0]!.permissionPatches?.[0]?.requestId, REQUEST_ID)
    assert.equal(captured[0]!.permissionPatches?.[0]?.behavior, 'allow')
    assert.equal(captured[0]!.userAnswerMessages?.[0]?.id, 'ask-ans-sess12345abcdefghijkl')
  })

  it('logs error when resolved persist is dropped (no longer silent warn)', async () => {
    setV3MasterSinkSingleton(mockSink(async () => ({
      ok: false,
      queued: false,
      droppedReason: 'session deleted',
    })))
    const errors: unknown[][] = []
    const warns: unknown[][] = []
    const gateway = makeGateway({
      info: () => {},
      warn: (...a) => warns.push(a),
      error: (...a) => errors.push(a),
    })
    await gateway._patchDetachedAskUserResolved(
      pending,
      REQUEST_ID,
      { _resolved: true, _behavior: 'deny', _settledReason: 'timeout' },
    )
    assert.equal(errors.length, 1)
    assert.match(String(errors[0]![0]), /dropped by master sink/)
    assert.equal(warns.length, 0)
  })
})

describe('buildDetachedAskUserResolvedSinkPayload', () => {
  it('builds a patch-only sidecar with optional user answer', () => {
    const payload = buildDetachedAskUserResolvedSinkPayload({
      requestId: REQUEST_ID,
      agentId: 'main',
      sessionId: 'sess12345',
      sessionKey: 'agent:main:webchat:dm:sess12345',
      behavior: 'deny',
      settledReason: 'timeout',
    })
    assert.equal(payload.text, '')
    assert.equal(payload.permissionPatches[0]!.requestId, REQUEST_ID)
    assert.equal(payload.userAnswerMessages, undefined)
  })
})
