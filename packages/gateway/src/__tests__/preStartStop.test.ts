/**
 * OCV5-435 — a browser Stop that reaches the gateway after the turn was
 * accepted but before its engine run exists (cold start, lock wait) must bind
 * to that exact turn. It used to be answered TURN_NOT_ACTIVE: the turn then
 * ran anyway while Master treated it as stopped, so a Codex question became a
 * hidden user_stop card and the session hung in waiting_for_user.
 *
 * Harness style matches stopSettlesPendingPermission.test.ts:
 * Object.create(Gateway.prototype) + the fields handleStop actually touches.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/preStartStop.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Gateway } from '../server.js'
import { PRE_ADMISSION_STOP_TTL_MS, preStartStopKey } from '../sessionManager.js'

const PEER_ID = 'wsess-prestart0001'
const PEER = { id: PEER_ID, kind: 'dm' as const }
const CMID = 'm-prestart-abc1'

function makeGateway(): {
  gateway: any
  fences: string[]
  ttls: Array<number | undefined>
  attempts: Array<number | undefined>
  adopted: Array<[string, number | undefined]>
  cleared: string[]
  interrupts: string[]
} {
  const fences: string[] = []
  const ttls: Array<number | undefined> = []
  const attempts: Array<number | undefined> = []
  const adopted: Array<[string, number | undefined]> = []
  const cleared: string[] = []
  const interrupts: string[] = []
  const gateway = Object.create(Gateway.prototype) as any
  gateway.log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  gateway._pendingPermissions = new Map()
  gateway.sessions = {
    // A session for this peer exists but runs no turn for CMID yet.
    list: () => [{ sessionKey: `agent:main:webchat:dm:${PEER_ID}` }],
    interruptClientTurn: () => false,
    interrupt: (key: string) => {
      interrupts.push(key)
      return false
    },
    fencePreStartStop: (peerId: string, cmid: string, ttlMs?: number, sendAttempt?: number) => {
      fences.push(preStartStopKey(peerId, cmid))
      ttls.push(ttlMs)
      attempts.push(sendAttempt)
    },
    adoptPreStartStopOnAdmission: (peerId: string, cmid: string, sendAttempt?: number) =>
      adopted.push([preStartStopKey(peerId, cmid), sendAttempt]),
    clearPreStartStop: (peerId: string, cmid: string) => cleared.push(preStartStopKey(peerId, cmid)),
  }
  gateway._interruptDelegationsForParent = () => false
  return { gateway, fences, ttls, attempts, adopted, cleared, interrupts }
}

function stopFrame(controlId = `control:stop:${CMID}`) {
  return { type: 'inbound.control.stop' as const, channel: 'webchat', peer: PEER, clientMessageId: CMID, controlId }
}

function messageFrame() {
  return {
    type: 'inbound.message' as const,
    idempotencyKey: `web:${CMID}:0`,
    channel: 'webchat',
    peer: PEER,
    agentId: 'main',
    clientMessageId: CMID,
    content: { text: 'hi' },
    ts: Date.now(),
  }
}

describe('handleStop before the engine run exists (OCV5-435)', () => {
  it('binds the Stop to an admitted turn and reports it applied', async () => {
    const { gateway, fences, ttls } = makeGateway()
    let release!: () => void
    gateway.dispatchInbound = () => new Promise<void>((resolve) => { release = resolve })
    const dispatch = gateway._dispatchAdmittedClientTurn(messageFrame())

    assert.equal(await gateway.handleStop(stopFrame()), true)
    assert.deepEqual(fences, [preStartStopKey(PEER_ID, CMID)])
    assert.deepEqual(ttls, [undefined], 'an admitted turn keeps the default fence lifetime')

    release()
    await dispatch
  })

  it('a Stop that overtook its message answers not-active but arms a short fence', async () => {
    const { gateway, fences, ttls, attempts, interrupts } = makeGateway()
    assert.equal(await gateway.handleStop(stopFrame()), false)
    assert.equal(await gateway.handleStop(stopFrame(`control:stop:${CMID}:attempt:2`)), false)
    assert.equal(await gateway.handleStop(stopFrame('control:stop:h1x2y3')), false)
    assert.deepEqual(fences, Array(3).fill(preStartStopKey(PEER_ID, CMID)))
    assert.deepEqual(ttls, Array(3).fill(PRE_ADMISSION_STOP_TTL_MS))
    assert.deepEqual(attempts, [0, 2, undefined], 'the fence names the send attempt the Stop was for')
    assert.deepEqual(interrupts, [], 'an exact Stop never falls back to a peer-wide interrupt')
  })

  it('admission hands the message send attempt to any fence armed before it', async () => {
    const { gateway, adopted } = makeGateway()
    gateway.dispatchInbound = async () => {}
    await gateway._dispatchAdmittedClientTurn(messageFrame())
    await gateway._dispatchAdmittedClientTurn({ ...messageFrame(), idempotencyKey: `web:${CMID}:3` })
    await gateway._dispatchAdmittedClientTurn({ ...messageFrame(), idempotencyKey: 'opaque' })
    assert.deepEqual(adopted, [
      [preStartStopKey(PEER_ID, CMID), 0],
      [preStartStopKey(PEER_ID, CMID), 3],
      [preStartStopKey(PEER_ID, CMID), undefined],
    ])
  })

  it('forgets the admitted turn and any unused fence once dispatch settles', async () => {
    const { gateway, fences, cleared } = makeGateway()
    gateway.dispatchInbound = async () => {
      throw new Error('rejected before the engine run')
    }
    await assert.rejects(gateway._dispatchAdmittedClientTurn(messageFrame()), /rejected/)
    assert.deepEqual(cleared, [preStartStopKey(PEER_ID, CMID)])
    assert.equal(await gateway.handleStop(stopFrame()), false, 'a late Stop is not bound to a finished turn')
    assert.equal(gateway._admittedClientTurns.size, 0)
  })

  it('does not track frames without an exact webchat clientMessageId', async () => {
    const { gateway, cleared } = makeGateway()
    let seen = 0
    gateway.dispatchInbound = async () => { seen += 1 }
    await gateway._dispatchAdmittedClientTurn({ ...messageFrame(), clientMessageId: undefined })
    await gateway._dispatchAdmittedClientTurn({ ...messageFrame(), channel: 'wechat' })
    assert.equal(seen, 2)
    assert.equal(gateway._admittedClientTurns, undefined)
    assert.equal(gateway._admittedClientTurnMeta, undefined)
    assert.deepEqual(cleared, [])
  })
})

describe('handleStop preStart blocking-turn interrupt (OCV5-923)', () => {
  const MAIN_SESSION_KEY = `agent:main:webchat:dm:${PEER_ID}`
  const ALPHA_SESSION_KEY = `agent:alpha:webchat:dm:${PEER_ID}`
  const BETA_SESSION_KEY = `agent:beta:webchat:dm:${PEER_ID}`

  type MockLiveSession = {
    sessionKey: string
    agentId?: string
    _runningClientMessageId?: string
    _persistActiveTurn?: unknown
  }

  function makeBlockingGateway(lives: MockLiveSession[]) {
    const fences: string[] = []
    const ttls: Array<number | undefined> = []
    const cleared: string[] = []
    const interrupts: string[] = []
    const clientTurnInterrupts: Array<{ sessionKey: string; cmid: string }> = []
    const directInterrupts: string[] = []
    const delegateInterrupts: string[] = []
    const swarmInterrupts: Array<{ sessionKey: string; reason: string }> = []
    const settledPermissions: Array<{ sessionKey: string; clientMessageId?: string }> = []
    const logs: Array<Record<string, unknown>> = []
    const byKey = new Map(lives.map((l) => [l.sessionKey, l]))

    const gateway = Object.create(Gateway.prototype) as any
    gateway.log = {
      debug: () => {},
      info: (_msg: string, fields?: Record<string, unknown>) => {
        if (fields) logs.push(fields)
      },
      warn: () => {},
      error: () => {},
    }
    gateway._pendingPermissions = new Map()
    gateway.sessions = {
      // Production SessionManager.list() returns summaries ONLY (no _runningClientMessageId / _persistActiveTurn).
      list: () =>
        lives.map((l) => ({
          sessionKey: l.sessionKey,
          agentId: l.agentId ?? l.sessionKey.split(':')[1] ?? 'main',
          lastUsedAt: Date.now(),
          ccbSessionId: null,
          turns: 1,
          totalCostUSD: 0,
        })),
      // Production SessionManager.getByKey() returns the real AgentSession with internal turn fields.
      getByKey: (sessionKey: string) => byKey.get(sessionKey),
      interruptClientTurn: (sessionKey: string, cmid: string) => {
        const live = byKey.get(sessionKey)
        if (!live || live._runningClientMessageId !== cmid) return false
        interrupts.push(sessionKey)
        clientTurnInterrupts.push({ sessionKey, cmid })
        return true
      },
      interrupt: (sessionKey: string) => {
        interrupts.push(sessionKey)
        directInterrupts.push(sessionKey)
        return true
      },
      fencePreStartStop: (peerId: string, cmid: string, ttlMs?: number) => {
        fences.push(preStartStopKey(peerId, cmid))
        ttls.push(ttlMs)
      },
      adoptPreStartStopOnAdmission: () => {},
      clearPreStartStop: (peerId: string, cmid: string) => {
        cleared.push(preStartStopKey(peerId, cmid))
      },
    }
    gateway._interruptDelegationsForParent = (sessionKey: string) => {
      delegateInterrupts.push(sessionKey)
      return true
    }
    gateway._interruptRemoteSwarmForSession = async (sessionKey: string, reason: string) => {
      swarmInterrupts.push({ sessionKey, reason })
      return true
    }
    gateway._settlePendingPermissionsForStop = (sessionKey: string, clientMessageId?: string) => {
      settledPermissions.push({ sessionKey, clientMessageId })
      return 1
    }
    return {
      gateway,
      fences,
      ttls,
      cleared,
      interrupts,
      clientTurnInterrupts,
      directInterrupts,
      delegateInterrupts,
      swarmInterrupts,
      settledPermissions,
      logs,
    }
  }

  function msgFor(cmid: string, extra: Record<string, unknown> = {}) {
    return {
      type: 'inbound.message' as const,
      idempotencyKey: `web:${cmid}:0`,
      channel: 'webchat',
      peer: PEER,
      agentId: 'main',
      clientMessageId: cmid,
      content: { text: 'hello' },
      ts: Date.now(),
      ...extra,
    }
  }

  it('queued M2 Stop interrupts older running M1 on the same sessionKey, cascades delegates & swarm, settles M1 permissions, and fences M2 & intermediate M1.5', async () => {
    const M1 = 'm-blocking-m1'
    const M1_5 = 'm-queued-m15'
    const M2 = 'm-queued-m2'
    const lives: MockLiveSession[] = [
      { sessionKey: MAIN_SESSION_KEY, _runningClientMessageId: M1 },
      { sessionKey: ALPHA_SESSION_KEY, _runningClientMessageId: 'm-other-agent-live' },
    ]
    const {
      gateway,
      fences,
      interrupts,
      clientTurnInterrupts,
      directInterrupts,
      delegateInterrupts,
      swarmInterrupts,
      settledPermissions,
      logs,
    } = makeBlockingGateway(lives)

    const releases: Array<() => void> = []
    gateway.dispatchInbound = () =>
      new Promise<void>((resolve) => {
        releases.push(resolve)
      })

    const d1 = gateway._dispatchAdmittedClientTurn(msgFor(M1))
    const d15 = gateway._dispatchAdmittedClientTurn(msgFor(M1_5))
    const d2 = gateway._dispatchAdmittedClientTurn(msgFor(M2))
    // Also queue a turn on alpha to ensure cross-agent turns are not fenced.
    const dAlpha = gateway._dispatchAdmittedClientTurn(msgFor('m-alpha-queued', { agentId: 'alpha' }))

    // Stop frame for M2 omits agentId & sessionKey (exact real production browser payload).
    const ok = await gateway.handleStop({
      type: 'inbound.control.stop',
      channel: 'webchat',
      peer: PEER,
      clientMessageId: M2,
      controlId: `control:stop:${M2}`,
    })

    assert.equal(ok, true)
    assert.deepEqual(interrupts, [MAIN_SESSION_KEY])
    assert.deepEqual(
      clientTurnInterrupts,
      [{ sessionKey: MAIN_SESSION_KEY, cmid: M1 }],
      'must interrupt exact blocking turn M1 via interruptClientTurn using getByKey() (list() summaries lack _runningClientMessageId)',
    )
    assert.deepEqual(directInterrupts, [], 'must not fall back to broad sessions.interrupt() when runningCmid is known')
    assert.deepEqual(delegateInterrupts, [MAIN_SESSION_KEY])
    assert.deepEqual(swarmInterrupts, [{ sessionKey: MAIN_SESSION_KEY, reason: 'user_stop' }])
    assert.deepEqual(settledPermissions, [{ sessionKey: MAIN_SESSION_KEY, clientMessageId: M1 }])
    assert.ok(fences.includes(preStartStopKey(PEER_ID, M2)), 'M2 itself must be fenced so it does not start')
    assert.ok(fences.includes(preStartStopKey(PEER_ID, M1_5)), 'intermediate queued M1.5 on same session must be fenced')
    assert.ok(!fences.includes(preStartStopKey(PEER_ID, 'm-alpha-queued')), 'queued turn on another agent must not be fenced')
    assert.equal(logs.at(-1)?.preStart, true)
    assert.equal(logs.at(-1)?.interruptedBlockingTurn, true)
    assert.equal(logs.at(-1)?.blockingClientMessageId, M1)

    for (const release of releases) release()
    await Promise.all([d1, d15, d2, dAlpha])
    assert.equal(gateway._admittedClientTurns.size, 0)
    assert.equal(gateway._admittedClientTurnMeta.size, 0)
  })

  it('falls back to sessions.interrupt() only when blocking session has _persistActiveTurn without _runningClientMessageId', async () => {
    const M2 = 'm-queued-persist-m2'
    const lives: MockLiveSession[] = [
      { sessionKey: MAIN_SESSION_KEY, _persistActiveTurn: () => Promise.resolve() },
    ]
    const {
      gateway,
      fences,
      clientTurnInterrupts,
      directInterrupts,
      delegateInterrupts,
      swarmInterrupts,
      settledPermissions,
    } = makeBlockingGateway(lives)

    let release!: () => void
    gateway.dispatchInbound = () =>
      new Promise<void>((resolve) => {
        release = resolve
      })

    const d2 = gateway._dispatchAdmittedClientTurn(msgFor(M2))
    const ok = await gateway.handleStop({
      type: 'inbound.control.stop',
      channel: 'webchat',
      peer: PEER,
      clientMessageId: M2,
    })

    assert.equal(ok, true)
    assert.deepEqual(clientTurnInterrupts, [])
    assert.deepEqual(directInterrupts, [MAIN_SESSION_KEY])
    assert.deepEqual(delegateInterrupts, [MAIN_SESSION_KEY])
    assert.deepEqual(swarmInterrupts, [{ sessionKey: MAIN_SESSION_KEY, reason: 'user_stop' }])
    assert.deepEqual(settledPermissions, [{ sessionKey: MAIN_SESSION_KEY, clientMessageId: undefined }])
    assert.deepEqual(fences, [preStartStopKey(PEER_ID, M2)])

    release()
    await d2
  })

  it('routing parity (B2/B5): conflicting frame.sessionKey is ignored in favor of frame.agentId and never touches another agent', async () => {
    const ALPHA_M1 = 'm-alpha-live-b2'
    const ALPHA_Q1 = 'm-alpha-queued-b2'
    const BETA_M1 = 'm-beta-live-b2'
    const BETA_M2 = 'm-beta-queued-b2'
    const lives: MockLiveSession[] = [
      { sessionKey: ALPHA_SESSION_KEY, _runningClientMessageId: ALPHA_M1 },
      { sessionKey: BETA_SESSION_KEY, _runningClientMessageId: BETA_M1 },
    ]
    const {
      gateway,
      fences,
      clientTurnInterrupts,
      directInterrupts,
      delegateInterrupts,
      swarmInterrupts,
      settledPermissions,
    } = makeBlockingGateway(lives)

    const releases: Array<() => void> = []
    gateway.dispatchInbound = () =>
      new Promise<void>((resolve) => {
        releases.push(resolve)
      })

    // Earlier queued turn on alpha
    const dAlphaQ1 = gateway._dispatchAdmittedClientTurn(msgFor(ALPHA_Q1, { agentId: 'alpha' }))
    // Conflicting frame: claims sessionKey=alphaKey, but execution routing uses agentId='beta'
    const dBetaM2 = gateway._dispatchAdmittedClientTurn(
      msgFor(BETA_M2, { agentId: 'beta', sessionKey: ALPHA_SESSION_KEY }),
    )

    // Even if the Stop frame also carries a conflicting sessionKey=alphaKey, attribution stays strictly on betaKey
    const ok = await gateway.handleStop({
      type: 'inbound.control.stop',
      channel: 'webchat',
      peer: PEER,
      sessionKey: ALPHA_SESSION_KEY,
      clientMessageId: BETA_M2,
    })

    assert.equal(ok, true)
    assert.deepEqual(clientTurnInterrupts, [{ sessionKey: BETA_SESSION_KEY, cmid: BETA_M1 }])
    assert.deepEqual(directInterrupts, [])
    assert.deepEqual(delegateInterrupts, [BETA_SESSION_KEY])
    assert.deepEqual(swarmInterrupts, [{ sessionKey: BETA_SESSION_KEY, reason: 'user_stop' }])
    assert.deepEqual(settledPermissions, [{ sessionKey: BETA_SESSION_KEY, clientMessageId: BETA_M1 }])
    assert.ok(fences.includes(preStartStopKey(PEER_ID, BETA_M2)))
    assert.ok(!fences.includes(preStartStopKey(PEER_ID, ALPHA_Q1)), 'stopping beta must NEVER fence earlier queued turn on alpha')

    // When meta exists with undefined targetSessionKey (no agentId & no router), frame.sessionKey on Stop must NOT be guessed.
    const UNATTR = 'm-unattr-b2'
    const dUnattr = gateway._dispatchAdmittedClientTurn(
      msgFor(UNATTR, { agentId: undefined, sessionKey: ALPHA_SESSION_KEY }),
    )
    const okUnattr = await gateway.handleStop({
      type: 'inbound.control.stop',
      channel: 'webchat',
      peer: PEER,
      sessionKey: ALPHA_SESSION_KEY,
      clientMessageId: UNATTR,
    })
    assert.equal(okUnattr, true)
    assert.deepEqual(clientTurnInterrupts, [{ sessionKey: BETA_SESSION_KEY, cmid: BETA_M1 }], 'unattributed meta must not guess from Stop frame.sessionKey')
    assert.ok(!fences.includes(preStartStopKey(PEER_ID, ALPHA_Q1)), 'unattributed Stop must not expand fencing to alpha')

    for (const release of releases) release()
    await Promise.all([dAlphaQ1, dBetaM2, dUnattr])
  })

  it('cross-agent isolation (B5): pre-start Stop for agent:beta NEVER interrupts a running turn on agent:alpha sharing the same peer.id', async () => {
    const ALPHA_M1 = 'm-alpha-running1'
    const BETA_M2 = 'm-beta-queued2'
    const lives: MockLiveSession[] = [
      { sessionKey: ALPHA_SESSION_KEY, _runningClientMessageId: ALPHA_M1 },
      { sessionKey: BETA_SESSION_KEY },
    ]
    const {
      gateway,
      fences,
      interrupts,
      delegateInterrupts,
      swarmInterrupts,
      settledPermissions,
    } = makeBlockingGateway(lives)

    const releases: Array<() => void> = []
    gateway.dispatchInbound = () =>
      new Promise<void>((resolve) => {
        releases.push(resolve)
      })

    const dBeta = gateway._dispatchAdmittedClientTurn(msgFor(BETA_M2, { agentId: 'beta' }))

    const ok = await gateway.handleStop({
      type: 'inbound.control.stop',
      channel: 'webchat',
      peer: PEER,
      agentId: 'beta',
      clientMessageId: BETA_M2,
    })

    assert.equal(ok, true)
    assert.deepEqual(fences, [preStartStopKey(PEER_ID, BETA_M2)])
    assert.deepEqual(interrupts, [], 'beta pre-start Stop must NEVER interrupt alpha')
    assert.deepEqual(delegateInterrupts, [])
    assert.deepEqual(swarmInterrupts, [])
    assert.deepEqual(settledPermissions, [])

    // Also verify unattributed pre-start Stop (no agentId/sessionKey/router) never falls back to peer-wide interrupt.
    const UNATTRIBUTED_M = 'm-unattributed-1'
    const dUnattr = gateway._dispatchAdmittedClientTurn(msgFor(UNATTRIBUTED_M, { agentId: undefined }))
    const okUnattr = await gateway.handleStop({
      type: 'inbound.control.stop',
      channel: 'webchat',
      peer: PEER,
      clientMessageId: UNATTRIBUTED_M,
    })
    assert.equal(okUnattr, true)
    assert.deepEqual(interrupts, [], 'unattributed pre-start Stop must NEVER fall back to peer-wide interrupt')

    for (const release of releases) release()
    await Promise.all([dBeta, dUnattr])
  })

  it('newer-turn fence: stopping M2 when a newer turn M3 (seq > M2.seq) is running fences M2 without interrupting M3', async () => {
    const M2 = 'm-older-m2'
    const M3 = 'm-newer-m3'
    const lives: MockLiveSession[] = [
      { sessionKey: MAIN_SESSION_KEY, _runningClientMessageId: M3 },
    ]
    const {
      gateway,
      fences,
      interrupts,
      delegateInterrupts,
      swarmInterrupts,
      settledPermissions,
    } = makeBlockingGateway(lives)

    const releases: Array<() => void> = []
    gateway.dispatchInbound = () =>
      new Promise<void>((resolve) => {
        releases.push(resolve)
      })

    // Admitted in order: M2 first (lower seq), then M3 (higher seq) which overtook and is running.
    const d2 = gateway._dispatchAdmittedClientTurn(msgFor(M2))
    const d3 = gateway._dispatchAdmittedClientTurn(msgFor(M3))

    const ok = await gateway.handleStop({
      type: 'inbound.control.stop',
      channel: 'webchat',
      peer: PEER,
      clientMessageId: M2,
    })

    assert.equal(ok, true)
    assert.deepEqual(fences, [preStartStopKey(PEER_ID, M2)])
    assert.deepEqual(interrupts, [], 'must NOT interrupt newer turn M3')
    assert.deepEqual(delegateInterrupts, [])
    assert.deepEqual(swarmInterrupts, [])
    assert.deepEqual(settledPermissions, [])

    for (const release of releases) release()
    await Promise.all([d2, d3])
  })

  it('idle session (no _runningClientMessageId / _persistActiveTurn): pre-start Stop fences M2 without calling interrupt()', async () => {
    const M2 = 'm-idle-m2'
    const lives: MockLiveSession[] = [{ sessionKey: MAIN_SESSION_KEY }]
    const {
      gateway,
      fences,
      interrupts,
      delegateInterrupts,
      swarmInterrupts,
      settledPermissions,
    } = makeBlockingGateway(lives)

    let release!: () => void
    gateway.dispatchInbound = () =>
      new Promise<void>((resolve) => {
        release = resolve
      })

    const d2 = gateway._dispatchAdmittedClientTurn(msgFor(M2))
    const ok = await gateway.handleStop({
      type: 'inbound.control.stop',
      channel: 'webchat',
      peer: PEER,
      clientMessageId: M2,
    })

    assert.equal(ok, true)
    assert.deepEqual(fences, [preStartStopKey(PEER_ID, M2)])
    assert.deepEqual(interrupts, [])
    assert.deepEqual(delegateInterrupts, [])
    assert.deepEqual(swarmInterrupts, [])
    assert.deepEqual(settledPermissions, [])

    release()
    await d2
  })

  it('stale Stop (not in _admittedClientTurns): still returns false and never interrupts a live turn', async () => {
    const M1 = 'm-live-m1'
    const STALE = 'm-stale-unknown'
    const lives: MockLiveSession[] = [
      { sessionKey: MAIN_SESSION_KEY, _runningClientMessageId: M1 },
    ]
    const {
      gateway,
      fences,
      ttls,
      interrupts,
      delegateInterrupts,
      swarmInterrupts,
      settledPermissions,
    } = makeBlockingGateway(lives)

    const ok = await gateway.handleStop({
      type: 'inbound.control.stop',
      channel: 'webchat',
      peer: PEER,
      agentId: 'main',
      clientMessageId: STALE,
    })

    assert.equal(ok, false)
    assert.deepEqual(fences, [preStartStopKey(PEER_ID, STALE)])
    assert.deepEqual(ttls, [PRE_ADMISSION_STOP_TTL_MS])
    assert.deepEqual(interrupts, [])
    assert.deepEqual(delegateInterrupts, [])
    assert.deepEqual(swarmInterrupts, [])
    assert.deepEqual(settledPermissions, [])
  })

  it('R2-B1: unsequenced newer callback M3 starting after M2 admission is NEVER interrupted by M2 Stop', async () => {
    const M2 = 'm-user-admitted-m2'
    const M3_CALLBACK = 'm-callback-unsequenced-m3'
    // Session is idle when M2 is admitted; then a background callback M3 (bypassing _dispatchAdmittedClientTurn, no seq) starts running!
    const liveMain: MockLiveSession = { sessionKey: MAIN_SESSION_KEY }
    const {
      gateway,
      fences,
      interrupts,
      clientTurnInterrupts,
      delegateInterrupts,
      swarmInterrupts,
      settledPermissions,
    } = makeBlockingGateway([liveMain])

    let release!: () => void
    gateway.dispatchInbound = () =>
      new Promise<void>((resolve) => {
        release = resolve
      })

    const d2 = gateway._dispatchAdmittedClientTurn(msgFor(M2))
    // Background callback starts running on MAIN_SESSION_KEY without being in _admittedClientTurnMeta.
    liveMain._runningClientMessageId = M3_CALLBACK

    const ok = await gateway.handleStop({
      type: 'inbound.control.stop',
      channel: 'webchat',
      peer: PEER,
      clientMessageId: M2,
    })

    assert.equal(ok, true)
    assert.deepEqual(fences, [preStartStopKey(PEER_ID, M2)])
    assert.deepEqual(interrupts, [], 'must NOT interrupt unsequenced newer callback M3')
    assert.deepEqual(clientTurnInterrupts, [])
    assert.deepEqual(delegateInterrupts, [])
    assert.deepEqual(swarmInterrupts, [])
    assert.deepEqual(settledPermissions, [])

    release()
    await d2
  })

  it('R2-B2: agentId-less turn shares single authoritative route from inboundDispatch across router hot-reloads', async () => {
    const ALPHA_M1 = 'm-alpha-running-r2b2'
    const BETA_M1 = 'm-beta-running-r2b2'
    const M2 = 'm-routed-no-agentid-r2b2'
    const lives: MockLiveSession[] = [
      { sessionKey: ALPHA_SESSION_KEY, _runningClientMessageId: ALPHA_M1 },
      { sessionKey: BETA_SESSION_KEY, _runningClientMessageId: BETA_M1 },
    ]
    const {
      gateway,
      fences,
      clientTurnInterrupts,
      delegateInterrupts,
      swarmInterrupts,
      settledPermissions,
    } = makeBlockingGateway(lives)
    // Simulate router initially pointing to alpha at admission, then hot-reloading to beta before execution routing!
    let routedTarget = ALPHA_SESSION_KEY
    gateway.router = { route: () => ({ sessionKey: routedTarget }) }

    const { bindAdmittedClientTurnSessionKey } = await import('../turnDispatch.js')
    let release!: () => void
    gateway.dispatchInbound = async (frame: any) => {
      // Router hot-reloads to beta before execution resolves route:
      routedTarget = BETA_SESSION_KEY
      const resolved = gateway.router.route(frame).sessionKey
      bindAdmittedClientTurnSessionKey(gateway, frame, resolved)
      await new Promise<void>((resolve) => {
        release = resolve
      })
    }

    const d2 = gateway._dispatchAdmittedClientTurn(msgFor(M2, { agentId: undefined }))
    // Wait one microtask so dispatchInbound binds betaKey (never alphaKey!)
    await Promise.resolve()

    const ok = await gateway.handleStop({
      type: 'inbound.control.stop',
      channel: 'webchat',
      peer: PEER,
      clientMessageId: M2,
    })

    assert.equal(ok, true)
    assert.deepEqual(fences, [preStartStopKey(PEER_ID, M2)])
    assert.deepEqual(
      clientTurnInterrupts,
      [{ sessionKey: BETA_SESSION_KEY, cmid: BETA_M1 }],
      'must interrupt beta (the single authoritative route), NEVER pre-hot-reload alpha',
    )
    assert.deepEqual(delegateInterrupts, [BETA_SESSION_KEY])
    assert.deepEqual(swarmInterrupts, [{ sessionKey: BETA_SESSION_KEY, reason: 'user_stop' }])
    assert.deepEqual(settledPermissions, [{ sessionKey: BETA_SESSION_KEY, clientMessageId: BETA_M1 }])

    release()
    await d2
  })

  it('R2 P1-2a: un-numbered blocking turn A finishing and un-numbered callback C replacing _persistActiveTurn is NEVER interrupted by Stop(B)', async () => {
    const B = 'm-p12a-queued-b'
    const persistA = () => Promise.resolve()
    const persistC = () => Promise.resolve()
    // At B admission, un-numbered turn A is running on MAIN_SESSION_KEY (`_persistActiveTurn = persistA`).
    const liveMain: MockLiveSession = { sessionKey: MAIN_SESSION_KEY, _persistActiveTurn: persistA }
    const {
      gateway,
      fences,
      interrupts,
      clientTurnInterrupts,
      delegateInterrupts,
      swarmInterrupts,
      settledPermissions,
    } = makeBlockingGateway([liveMain])

    let release!: () => void
    gateway.dispatchInbound = () =>
      new Promise<void>((resolve) => {
        release = resolve
      })

    const dB = gateway._dispatchAdmittedClientTurn(msgFor(B))
    // Turn A finishes and a newer un-numbered callback turn C starts before B runs or Stop(B) arrives!
    liveMain._persistActiveTurn = persistC

    const ok = await gateway.handleStop({
      type: 'inbound.control.stop',
      channel: 'webchat',
      peer: PEER,
      clientMessageId: B,
    })

    assert.equal(ok, true)
    assert.deepEqual(fences, [preStartStopKey(PEER_ID, B)])
    assert.deepEqual(interrupts, [], 'P1-2a: must NOT interrupt replacement un-numbered turn C')
    assert.deepEqual(clientTurnInterrupts, [])
    assert.deepEqual(delegateInterrupts, [])
    assert.deepEqual(swarmInterrupts, [])
    assert.deepEqual(settledPermissions, [])

    release()
    await dB
  })

  it('R2 P1-2b: session observed empty at B admission -> un-numbered callback C starting BEFORE bindAdmittedClientTurnSessionKey is NEVER interrupted by Stop(B)', async () => {
    const B = 'm-p12b-routed-b'
    const persistC = () => Promise.resolve()
    // Session is empty/idle when B enters _dispatchAdmittedClientTurn (without explicit agentId).
    const liveMain: MockLiveSession = { sessionKey: MAIN_SESSION_KEY }
    const {
      gateway,
      fences,
      interrupts,
      clientTurnInterrupts,
      delegateInterrupts,
      swarmInterrupts,
      settledPermissions,
    } = makeBlockingGateway([liveMain])
    gateway.router = { route: () => ({ sessionKey: MAIN_SESSION_KEY }) }

    const { bindAdmittedClientTurnSessionKey } = await import('../turnDispatch.js')
    let release!: () => void
    gateway.dispatchInbound = async (frame: any) => {
      // Simulate async pre-bind gap (`await syncMarketplaceHub` / `await fetchIdentityCompatProjection`)
      // during which un-numbered callback turn C starts on MAIN_SESSION_KEY!
      await Promise.resolve()
      liveMain._persistActiveTurn = persistC
      bindAdmittedClientTurnSessionKey(gateway, frame, MAIN_SESSION_KEY)
      await new Promise<void>((resolve) => {
        release = resolve
      })
    }

    const dB = gateway._dispatchAdmittedClientTurn(msgFor(B, { agentId: undefined }))
    await Promise.resolve()
    await Promise.resolve()

    const ok = await gateway.handleStop({
      type: 'inbound.control.stop',
      channel: 'webchat',
      peer: PEER,
      clientMessageId: B,
    })

    assert.equal(ok, true)
    assert.deepEqual(fences, [preStartStopKey(PEER_ID, B)])
    assert.deepEqual(interrupts, [], 'P1-2b: C started after B admission and must NOT be interrupted')
    assert.deepEqual(clientTurnInterrupts, [])
    assert.deepEqual(delegateInterrupts, [])
    assert.deepEqual(swarmInterrupts, [])
    assert.deepEqual(settledPermissions, [])

    release()
    await dB
  })

  it('Steward R1-B2: persist_only Stop settles older turn permissions synchronously before await interruptRemoteSwarm and never denies successor turn permissions created during remote await', async () => {
    const B = 'm-r1b2-queued'
    const persistA = () => Promise.resolve()
    const liveMain: MockLiveSession = { sessionKey: MAIN_SESSION_KEY, _persistActiveTurn: persistA }
    const { gateway } = makeBlockingGateway([liveMain])

    const { _settlePendingPermissionsForStop } = await import('../askUserPermissions.js')
    const deniedIds: string[] = []
    gateway._pendingPermissions = new Map([
      ['perm-old-turn-a', { sessionKey: MAIN_SESSION_KEY, peerKey: PEER_ID }],
    ])
    gateway._forceDenyPendingPermission = (requestId: string) => {
      if (!gateway._pendingPermissions.has(requestId)) return false
      gateway._pendingPermissions.delete(requestId)
      deniedIds.push(requestId)
      return true
    }
    gateway._settlePendingPermissionsForStop = _settlePendingPermissionsForStop.bind(gateway)

    let releaseDispatch!: () => void
    gateway.dispatchInbound = () =>
      new Promise<void>((resolve) => {
        releaseDispatch = resolve
      })

    let resolveRemoteSwarm!: (val: boolean) => void
    let swarmStarted!: () => void
    const swarmEntered = new Promise<void>((resolve) => {
      swarmStarted = resolve
    })
    gateway._interruptRemoteSwarmForSession = () => {
      swarmStarted()
      return new Promise<boolean>((resolve) => {
        resolveRemoteSwarm = resolve
      })
    }

    const dB = gateway._dispatchAdmittedClientTurn(msgFor(B))
    const stopPromise = gateway.handleStop({
      type: 'inbound.control.stop',
      channel: 'webchat',
      peer: PEER,
      clientMessageId: B,
    })

    await swarmEntered
    assert.deepEqual(
      deniedIds,
      ['perm-old-turn-a'],
      'old turn A permission must already be settled synchronously before remote swarm await suspends',
    )

    // Successor turn creates a new pending permission while interruptRemoteSwarm is suspended!
    gateway._pendingPermissions.set('perm-successor-turn-c', {
      sessionKey: MAIN_SESSION_KEY,
      peerKey: PEER_ID,
      clientMessageId: 'm-successor-c',
    })

    resolveRemoteSwarm(true)
    const ok = await stopPromise
    assert.equal(ok, true)
    assert.equal(
      gateway._pendingPermissions.has('perm-successor-turn-c'),
      true,
      'successor turn permission created during remote swarm await must remain pending',
    )
    assert.deepEqual(deniedIds, ['perm-old-turn-a'])

    releaseDispatch()
    await dB
  })
})
