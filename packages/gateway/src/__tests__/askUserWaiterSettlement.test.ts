/**
 * Detached ask_user settlement in handlePermissionResponse.
 *
 * Cursor has no permission channel (sendPermissionResponse is a no-op there).
 * A detached ask_user entry must:
 *   - allow → submit a user message / start a turn via dispatchInbound
 *   - deny  → settle with no turn
 *   - never call runner.sendPermissionResponse
 *
 * Harness style matches wechatLiveDispatch.test.ts: Object.create(Gateway.prototype)
 * plus the handful of fields this private method actually touches.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/askUserWaiterSettlement.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Gateway } from '../server.js'

const SESSION_KEY = 'agent:main:webchat:dm:wsess-askuserwait01'
const PEER = { id: 'wsess-askuserwait01', kind: 'dm' as const }
const QUESTION = 'Which editor do you want?'

function pendingInput() {
  return {
    questions: [
      {
        question: QUESTION,
        header: 'Editor',
        options: [
          { label: 'VS Code', description: 'Microsoft editor' },
          { label: 'Vim', description: 'Modal editor' },
        ],
      },
    ],
  }
}

function makeGateway(): {
  gateway: any
  runnerCalls: Array<{ requestId: string; response: unknown }>
  settlements: unknown[]
  broadcasts: unknown[]
  inboundFrames: unknown[]
} {
  const runnerCalls: Array<{ requestId: string; response: unknown }> = []
  const settlements: unknown[] = []
  const broadcasts: unknown[] = []
  const inboundFrames: unknown[] = []
  const gateway = Object.create(Gateway.prototype) as any
  gateway.log = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }
  gateway._pendingPermissions = new Map()
  gateway.sessions = {
    getByKey: (key: string) =>
      key === SESSION_KEY
        ? {
            providerTag: 'cursor',
            runner: {
              isRunning: false,
              sendPermissionResponse: (requestId: string, response: unknown) => {
                runnerCalls.push({ requestId, response })
                return true
              },
            },
          }
        : undefined,
  }
  gateway._recordSettlement = (...args: unknown[]) => {
    settlements.push(args)
  }
  gateway._broadcastPermissionSettled = (...args: unknown[]) => {
    broadcasts.push(args)
  }
  gateway._patchDetachedAskUserResolved = async () => {}
  gateway._persistDetachedAskUserCard = async () => {}
  gateway.dispatchInbound = async (frame: unknown) => {
    inboundFrames.push(frame)
  }
  return { gateway, runnerCalls, settlements, broadcasts, inboundFrames }
}

function installDetached(gateway: any, requestId: string) {
  gateway._pendingPermissions.set(requestId, {
    sessionKey: SESSION_KEY,
    toolName: 'AskUserQuestion',
    input: pendingInput(),
    peerKey: 'default:webchat:wsess-askuserwait01',
    userId: 'default',
    channel: 'webchat',
    peer: PEER,
    expiresAt: Date.now() + 24 * 60 * 60_000,
    detachedAskUser: true,
  })
}

describe('handlePermissionResponse — detached ask_user', () => {
  it('allow submits a user turn and does not call the runner', async () => {
    const { gateway, runnerCalls, inboundFrames, broadcasts } = makeGateway()
    const requestId = 'ask-user:allow-1'
    installDetached(gateway, requestId)

    await gateway.handlePermissionResponse({
      type: 'inbound.permission_response',
      channel: 'webchat',
      peer: PEER,
      requestId,
      behavior: 'allow',
      updatedInput: { answers: { [QUESTION]: 'Vim' } },
    })

    assert.deepEqual(runnerCalls, [])
    assert.equal(gateway._pendingPermissions.has(requestId), false)
    assert.equal(inboundFrames.length, 1)
    const frame = inboundFrames[0] as {
      type: string
      content?: { text?: string }
      channel: string
      peer: { id: string }
    }
    assert.equal(frame.type, 'inbound.message')
    assert.equal(frame.channel, 'webchat')
    assert.equal(frame.peer.id, PEER.id)
    assert.match(String(frame.content?.text ?? ''), /Which editor do you want/)
    assert.match(String(frame.content?.text ?? ''), /Vim/)
    assert.equal(broadcasts.length, 1)
  })

  it('deny settles with no turn and does not call the runner', async () => {
    const { gateway, runnerCalls, inboundFrames, broadcasts } = makeGateway()
    const requestId = 'ask-user:deny-1'
    installDetached(gateway, requestId)

    await gateway.handlePermissionResponse({
      type: 'inbound.permission_response',
      channel: 'webchat',
      peer: PEER,
      requestId,
      behavior: 'deny',
      message: 'User skipped the questions',
    })

    assert.deepEqual(runnerCalls, [])
    assert.equal(inboundFrames.length, 0)
    assert.equal(gateway._pendingPermissions.has(requestId), false)
    assert.equal(broadcasts.length, 1)
  })

  it('hydrated durable card is answerable after the in-memory registry is empty', async () => {
    const { gateway, runnerCalls, inboundFrames } = makeGateway()
    const requestId = 'ask-user:hydrated-1'
    gateway._hydrateDetachedAskUserPending = async () => ({
      sessionKey: SESSION_KEY,
      toolName: 'AskUserQuestion',
      input: pendingInput(),
      peerKey: 'default:webchat:wsess-askuserwait01',
      userId: 'default',
      channel: 'webchat',
      peer: PEER,
      expiresAt: Date.now() + 24 * 60 * 60_000,
      detachedAskUser: true,
    })

    await gateway.handlePermissionResponse({
      type: 'inbound.permission_response',
      channel: 'webchat',
      peer: PEER,
      requestId,
      behavior: 'allow',
      updatedInput: { answers: { [QUESTION]: 'VS Code' } },
    })

    assert.deepEqual(runnerCalls, [])
    assert.equal(inboundFrames.length, 1)
    assert.match(String((inboundFrames[0] as { content?: { text?: string } }).content?.text ?? ''), /VS Code/)
  })
})

describe('_sweepStalePendingPermissions — detached ask_user', () => {
  it('does not auto-deny a detached ask-user entry within the 24h TTL', () => {
    const { gateway } = makeGateway()
    const denied: Array<{ requestId: string; reason: string }> = []
    gateway._forceDenyPendingPermission = (requestId: string, reason: string) => {
      denied.push({ requestId, reason })
      return true
    }
    gateway._pendingPermissions.set('ask-user:live', {
      sessionKey: SESSION_KEY,
      toolName: 'AskUserQuestion',
      input: pendingInput(),
      peerKey: 'default:webchat:wsess-askuserwait01',
      userId: 'default',
      channel: 'webchat',
      peer: PEER,
      expiresAt: Date.now() + 20 * 60 * 60_000,
      detachedAskUser: true,
    })
    gateway._pendingPermissions.set('engine-perm-stale', {
      sessionKey: SESSION_KEY,
      toolName: 'Bash',
      input: {},
      peerKey: 'default:webchat:wsess-askuserwait01',
      userId: 'default',
      channel: 'webchat',
      peer: PEER,
      expiresAt: Date.now() - 1000,
    })

    gateway._sweepStalePendingPermissions()

    assert.deepEqual(denied, [{ requestId: 'engine-perm-stale', reason: 'timeout' }])
    assert.equal(gateway._pendingPermissions.has('ask-user:live'), true)
  })

  it('does not treat a missing session as a crash for detached ask-user', () => {
    const { gateway } = makeGateway()
    const denied: Array<{ requestId: string; reason: string }> = []
    gateway.sessions.getByKey = () => undefined
    gateway._forceDenyPendingPermission = (requestId: string, reason: string) => {
      denied.push({ requestId, reason })
      return true
    }
    gateway._pendingPermissions.set('ask-user:orphaned-session', {
      sessionKey: 'agent:main:webchat:dm:gone',
      toolName: 'AskUserQuestion',
      input: pendingInput(),
      peerKey: 'default:webchat:gone',
      userId: 'default',
      channel: 'webchat',
      peer: { id: 'gone', kind: 'dm' as const },
      expiresAt: Date.now() + 20 * 60 * 60_000,
      detachedAskUser: true,
    })

    gateway._sweepStalePendingPermissions()

    assert.deepEqual(denied, [])
    assert.equal(gateway._pendingPermissions.has('ask-user:orphaned-session'), true)
  })
})

describe('_reapCrashedSessionPendingPermissions — detached ask_user', () => {
  it('does not crash-settle a detached ask-user card', () => {
    const { gateway, runnerCalls, broadcasts } = makeGateway()
    installDetached(gateway, 'ask-user:crash-survive')

    gateway._reapCrashedSessionPendingPermissions(SESSION_KEY)

    assert.equal(gateway._pendingPermissions.has('ask-user:crash-survive'), true)
    assert.deepEqual(runnerCalls, [])
    assert.deepEqual(broadcasts, [])
  })

  it('still crash-settles ordinary permission requests on the same session', () => {
    const { gateway, runnerCalls, broadcasts } = makeGateway()
    installDetached(gateway, 'ask-user:crash-keep')
    gateway._pendingPermissions.set('engine-perm-crash', {
      sessionKey: SESSION_KEY,
      toolName: 'Bash',
      input: {},
      toolUseId: 'toolu-1',
      peerKey: 'default:webchat:wsess-askuserwait01',
      userId: 'default',
      channel: 'webchat',
      peer: PEER,
      expiresAt: Date.now() + 30 * 60_000,
    })

    gateway._reapCrashedSessionPendingPermissions(SESSION_KEY)

    assert.equal(gateway._pendingPermissions.has('ask-user:crash-keep'), true)
    assert.equal(gateway._pendingPermissions.has('engine-perm-crash'), false)
    assert.equal(runnerCalls.length, 1)
    assert.equal(runnerCalls[0]!.requestId, 'engine-perm-crash')
    assert.equal((runnerCalls[0]!.response as { behavior: string }).behavior, 'deny')
    assert.equal(broadcasts.length, 1)
    const payload = broadcasts[0] as unknown[]
    const settled = payload[1] as { requestId: string; reason: string }
    assert.equal(settled.requestId, 'engine-perm-crash')
    assert.equal(settled.reason, 'crashed')
  })
})
