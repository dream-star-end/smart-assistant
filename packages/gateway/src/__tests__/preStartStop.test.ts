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

function makeGateway(): { gateway: any; fences: string[]; ttls: Array<number | undefined>; cleared: string[]; interrupts: string[] } {
  const fences: string[] = []
  const ttls: Array<number | undefined> = []
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
    fencePreStartStop: (peerId: string, cmid: string, ttlMs?: number) => {
      fences.push(preStartStopKey(peerId, cmid))
      ttls.push(ttlMs)
    },
    clearPreStartStop: (peerId: string, cmid: string) => cleared.push(preStartStopKey(peerId, cmid)),
  }
  gateway._interruptDelegationsForParent = () => false
  return { gateway, fences, ttls, cleared, interrupts }
}

function stopFrame() {
  return { type: 'inbound.control.stop' as const, channel: 'webchat', peer: PEER, clientMessageId: CMID }
}

function messageFrame() {
  return {
    type: 'inbound.message' as const,
    idempotencyKey: CMID,
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
    const { gateway, fences, ttls, interrupts } = makeGateway()
    assert.equal(await gateway.handleStop(stopFrame()), false)
    assert.deepEqual(fences, [preStartStopKey(PEER_ID, CMID)])
    assert.deepEqual(ttls, [PRE_ADMISSION_STOP_TTL_MS])
    assert.deepEqual(interrupts, [], 'an exact Stop never falls back to a peer-wide interrupt')
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
    assert.deepEqual(cleared, [])
  })
})
