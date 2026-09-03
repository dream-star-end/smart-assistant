/**
 * INC-20260904-STOP-LEAVES-PERMISSION-PENDING
 *
 * When the user presses Stop while the turn is blocked on a permission
 * request (incl. a blocking AskUserQuestion), `handleStop` must settle the
 * runtime `_pendingPermissions` entry with reason `user_stop`:
 *   - deny is pushed to the CCB runner so the subprocess unblocks
 *   - `outbound.permission_settled` is broadcast so every tab (and the master
 *     durable row via the bridge side-effect) closes the card immediately
 *   - detached ask_user cards are left alone (they outlive the turn by design)
 *   - a Stop fenced to a different clientMessageId does not touch entries
 *     owned by another turn
 *
 * Harness style matches askUserWaiterSettlement.test.ts:
 * Object.create(Gateway.prototype) + the fields handleStop actually touches.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/stopSettlesPendingPermission.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Gateway } from '../server.js'

const PEER_ID = 'wsess-stopsettle01'
const PEER = { id: PEER_ID, kind: 'dm' as const }
const SESSION_KEY = `agent:main:webchat:dm:${PEER_ID}`
const OTHER_SESSION_KEY = `agent:coder:webchat:dm:${PEER_ID}`
const PEER_KEY = `default:webchat:${PEER_ID}`
const RUNNING_CMID = 'm-abc123def456'
const STALE_CMID = 'm-stale0000000'

type Live = { sessionKey: string; runningClientMessageId?: string }

function makeGateway(lives: Live[]): {
  gateway: any
  runnerCalls: Array<{ sessionKey: string; requestId: string; response: any }>
  broadcasts: Array<{ peerKey: string; payload: any }>
  settlements: unknown[]
  interrupts: string[]
} {
  const runnerCalls: Array<{ sessionKey: string; requestId: string; response: any }> = []
  const broadcasts: Array<{ peerKey: string; payload: any }> = []
  const settlements: unknown[] = []
  const interrupts: string[] = []
  const byKey = new Map(
    lives.map((l) => [
      l.sessionKey,
      {
        sessionKey: l.sessionKey,
        _runningClientMessageId: l.runningClientMessageId,
        runner: {
          isRunning: true,
          sendPermissionResponse: (requestId: string, response: unknown) => {
            runnerCalls.push({ sessionKey: l.sessionKey, requestId, response })
            return true
          },
        },
      },
    ]),
  )
  const gateway = Object.create(Gateway.prototype) as any
  gateway.log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  gateway._pendingPermissions = new Map()
  gateway._askUserWaiters = new Map()
  gateway.sessions = {
    list: () => [...byKey.values()],
    getByKey: (key: string) => byKey.get(key),
    interrupt: (key: string) => {
      if (!byKey.has(key)) return false
      interrupts.push(key)
      return true
    },
    interruptClientTurn: (key: string, cmid: string) => {
      const s = byKey.get(key)
      if (!s || s._runningClientMessageId !== cmid) return false
      interrupts.push(key)
      return true
    },
  }
  gateway._interruptDelegationsForParent = () => false
  gateway._recordSettlement = (...args: unknown[]) => {
    settlements.push(args)
  }
  gateway._broadcastPermissionSettled = (peerKey: string, payload: unknown) => {
    broadcasts.push({ peerKey, payload })
  }
  gateway._patchDetachedAskUserResolved = async () => {}
  gateway.router = {
    route: () => ({ sessionKey: SESSION_KEY }),
  }
  return { gateway, runnerCalls, broadcasts, settlements, interrupts }
}

function installPending(gateway: any, requestId: string, overrides: Record<string, unknown> = {}) {
  gateway._pendingPermissions.set(requestId, {
    sessionKey: SESSION_KEY,
    toolName: 'AskUserQuestion',
    input: { questions: [{ question: 'Deploy now?', header: 'Deploy', options: [] }] },
    toolUseId: `toolu-${requestId}`,
    clientMessageId: RUNNING_CMID,
    peerKey: PEER_KEY,
    userId: 'default',
    channel: 'webchat',
    peer: PEER,
    expiresAt: Date.now() + 10 * 60_000,
    blockingUserInput: true,
    ...overrides,
  })
}

function stopFrame(extra: Record<string, unknown> = {}) {
  return {
    type: 'inbound.control.stop' as const,
    channel: 'webchat',
    peer: PEER,
    ...extra,
  }
}

describe('handleStop — settles the stopped turn’s pending permissions', () => {
  it('clientMessageId stop denies the blocking AskUserQuestion with reason user_stop', async () => {
    const { gateway, runnerCalls, broadcasts, settlements, interrupts } = makeGateway([
      { sessionKey: SESSION_KEY, runningClientMessageId: RUNNING_CMID },
    ])
    installPending(gateway, 'perm-ask-1')

    const ok = await gateway.handleStop(stopFrame({ clientMessageId: RUNNING_CMID }))

    assert.equal(ok, true)
    assert.deepEqual(interrupts, [SESSION_KEY])
    assert.equal(gateway._pendingPermissions.has('perm-ask-1'), false)
    assert.equal(runnerCalls.length, 1)
    assert.equal(runnerCalls[0]!.requestId, 'perm-ask-1')
    assert.equal(runnerCalls[0]!.response.behavior, 'deny')
    assert.equal(runnerCalls[0]!.response.toolUseID, 'toolu-perm-ask-1')
    assert.equal(settlements.length, 1)
    assert.equal(broadcasts.length, 1)
    assert.equal(broadcasts[0]!.peerKey, PEER_KEY)
    assert.equal(broadcasts[0]!.payload.type, undefined) // payload is stamped by the real helper
    assert.equal(broadcasts[0]!.payload.requestId, 'perm-ask-1')
    assert.equal(broadcasts[0]!.payload.behavior, 'deny')
    assert.equal(broadcasts[0]!.payload.reason, 'user_stop')
    assert.equal(broadcasts[0]!.payload.sessionKey, SESSION_KEY)
    assert.deepEqual(broadcasts[0]!.payload.peer, PEER)
  })

  it('releases a held ask_user waiter for the stopped request', async () => {
    const { gateway } = makeGateway([
      { sessionKey: SESSION_KEY, runningClientMessageId: RUNNING_CMID },
    ])
    installPending(gateway, 'perm-ask-waiter')
    let released = 0
    gateway._askUserWaiters.set('perm-ask-waiter', {
      tryRelease: () => {
        released += 1
      },
    })

    await gateway.handleStop(stopFrame({ clientMessageId: RUNNING_CMID }))

    assert.equal(released, 1)
    assert.equal(gateway._askUserWaiters.has('perm-ask-waiter'), false)
  })

  it('a stale clientMessageId stop is fenced out and leaves the live permission alone', async () => {
    const { gateway, runnerCalls, broadcasts, interrupts } = makeGateway([
      { sessionKey: SESSION_KEY, runningClientMessageId: RUNNING_CMID },
    ])
    installPending(gateway, 'perm-ask-live')

    const ok = await gateway.handleStop(stopFrame({ clientMessageId: STALE_CMID }))

    assert.equal(ok, false)
    assert.deepEqual(interrupts, [])
    assert.equal(gateway._pendingPermissions.has('perm-ask-live'), true)
    assert.deepEqual(runnerCalls, [])
    assert.deepEqual(broadcasts, [])
  })

  it('entries recorded without a clientMessageId are settled by a clientMessageId stop', async () => {
    const { gateway, broadcasts } = makeGateway([
      { sessionKey: SESSION_KEY, runningClientMessageId: RUNNING_CMID },
    ])
    installPending(gateway, 'perm-no-cmid', { clientMessageId: undefined })

    await gateway.handleStop(stopFrame({ clientMessageId: RUNNING_CMID }))

    assert.equal(gateway._pendingPermissions.has('perm-no-cmid'), false)
    assert.equal(broadcasts.length, 1)
    assert.equal(broadcasts[0]!.payload.reason, 'user_stop')
  })

  it('does not touch entries owned by another turn id on the same session', async () => {
    const { gateway, broadcasts } = makeGateway([
      { sessionKey: SESSION_KEY, runningClientMessageId: RUNNING_CMID },
    ])
    installPending(gateway, 'perm-mine')
    installPending(gateway, 'perm-other-turn', { clientMessageId: 'm-othertturn0000' })

    await gateway.handleStop(stopFrame({ clientMessageId: RUNNING_CMID }))

    assert.equal(gateway._pendingPermissions.has('perm-mine'), false)
    assert.equal(gateway._pendingPermissions.has('perm-other-turn'), true)
    assert.equal(broadcasts.length, 1)
    assert.equal(broadcasts[0]!.payload.requestId, 'perm-mine')
  })

  it('leaves a detached ask_user card untouched', async () => {
    const { gateway, runnerCalls, broadcasts } = makeGateway([
      { sessionKey: SESSION_KEY, runningClientMessageId: RUNNING_CMID },
    ])
    installPending(gateway, 'ask-user:detached', {
      detachedAskUser: true,
      blockingUserInput: undefined,
      expiresAt: Date.now() + 24 * 60 * 60_000,
    })
    installPending(gateway, 'perm-blocking')

    await gateway.handleStop(stopFrame({ clientMessageId: RUNNING_CMID }))

    assert.equal(gateway._pendingPermissions.has('ask-user:detached'), true)
    assert.equal(gateway._pendingPermissions.has('perm-blocking'), false)
    assert.equal(runnerCalls.length, 1)
    assert.equal(runnerCalls[0]!.requestId, 'perm-blocking')
    assert.equal(broadcasts.length, 1)
  })

  it('sessionKey stop (no clientMessageId) settles every pending permission of that session only', async () => {
    const { gateway, broadcasts, interrupts } = makeGateway([
      { sessionKey: SESSION_KEY, runningClientMessageId: RUNNING_CMID },
      { sessionKey: OTHER_SESSION_KEY, runningClientMessageId: 'm-other000000000' },
    ])
    installPending(gateway, 'perm-a')
    installPending(gateway, 'perm-b', { toolName: 'Bash', blockingUserInput: undefined })
    installPending(gateway, 'perm-other-session', {
      sessionKey: OTHER_SESSION_KEY,
      clientMessageId: 'm-other000000000',
    })

    const ok = await gateway.handleStop(stopFrame({ sessionKey: SESSION_KEY }))

    assert.equal(ok, true)
    assert.deepEqual(interrupts, [SESSION_KEY])
    assert.equal(gateway._pendingPermissions.has('perm-a'), false)
    assert.equal(gateway._pendingPermissions.has('perm-b'), false)
    assert.equal(gateway._pendingPermissions.has('perm-other-session'), true)
    assert.equal(broadcasts.length, 2)
    assert.deepEqual(broadcasts.map((b) => b.payload.requestId).sort(), ['perm-a', 'perm-b'])
    assert.ok(broadcasts.every((b) => b.payload.reason === 'user_stop'))
  })

  it('peer-wide stop (no sessionKey, no agentId) settles across all peer sessions', async () => {
    const { gateway, broadcasts } = makeGateway([
      { sessionKey: SESSION_KEY, runningClientMessageId: RUNNING_CMID },
      { sessionKey: OTHER_SESSION_KEY, runningClientMessageId: 'm-other000000000' },
    ])
    installPending(gateway, 'perm-main')
    installPending(gateway, 'perm-coder', {
      sessionKey: OTHER_SESSION_KEY,
      clientMessageId: 'm-other000000000',
    })

    const ok = await gateway.handleStop(stopFrame())

    assert.equal(ok, true)
    assert.equal(gateway._pendingPermissions.size, 0)
    assert.equal(broadcasts.length, 2)
  })

  it('a stop that interrupts nothing does not settle anything', async () => {
    const { gateway, broadcasts } = makeGateway([])
    installPending(gateway, 'perm-orphan')

    const ok = await gateway.handleStop(stopFrame({ sessionKey: SESSION_KEY }))

    assert.equal(ok, false)
    assert.equal(gateway._pendingPermissions.has('perm-orphan'), true)
    assert.deepEqual(broadcasts, [])
  })
})
