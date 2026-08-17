/**
 * 55s hybrid wait for handleEngineAskUser + handlePermissionResponse.
 *
 * In-window allow returns {status:'answered'} and must not dispatchInbound.
 * Timeout returns {status:'posted'}; a later allow still starts a turn.
 * Deny/skip only settles. Persistence runs before the wait, so a rebuilt
 * pending remains answerable after the HTTP waiter is gone.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/askUserHybridWait.test.ts
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import { Gateway } from '../server.js'
import { AskUserWaiter } from '../askUserWaiter.js'

const SESSION_KEY = 'agent:main:webchat:dm:wsess-askuserhybrid01'
const PEER = { id: 'wsess-askuserhybrid01', kind: 'dm' as const }
const QUESTION = 'Which editor do you want?'
const QUESTIONS = [
  {
    question: QUESTION,
    header: 'Editor',
    options: [
      { label: 'VS Code', description: 'Microsoft editor' },
      { label: 'Vim', description: 'Modal editor' },
    ],
  },
]

function pendingInput() {
  return { questions: QUESTIONS }
}

function makeGateway(): {
  gateway: any
  persistCalls: number
  persistOrder: string[]
  frames: unknown[]
  inboundFrames: unknown[]
  patches: Array<{ requestId: string; patch: Record<string, unknown>; userAnswer?: unknown }>
  runnerCalls: Array<{ requestId: string; response: unknown }>
} {
  const persistOrder: string[] = []
  const frames: unknown[] = []
  const inboundFrames: unknown[] = []
  const patches: Array<{ requestId: string; patch: Record<string, unknown>; userAnswer?: unknown }> = []
  const runnerCalls: Array<{ requestId: string; response: unknown }> = []
  let persistCalls = 0
  const gateway = Object.create(Gateway.prototype) as any
  gateway.log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  gateway._pendingPermissions = new Map()
  gateway._askUserWaiters = new Map()
  gateway.sessions = {
    getByKey: (key: string) =>
      key === SESSION_KEY
        ? {
            agentId: 'main',
            userId: 'default',
            channel: 'webchat',
            peerId: PEER.id,
            providerTag: 'cursor',
            runner: {
              isRunning: true,
              sendPermissionResponse: (requestId: string, response: unknown) => {
                runnerCalls.push({ requestId, response })
                return true
              },
            },
          }
        : undefined,
  }
  gateway._recordSettlement = () => {}
  gateway._broadcastPermissionSettled = () => {}
  gateway._sendStampedSessionFrame = (_sessionKey: string, _peerKey: string, frame: unknown) => {
    persistOrder.push('frame')
    frames.push(frame)
  }
  gateway._persistDetachedAskUserCard = async () => {
    persistCalls += 1
    persistOrder.push('persist')
  }
  gateway._patchDetachedAskUserResolved = async (
    _pending: unknown,
    requestId: string,
    patch: Record<string, unknown>,
    userAnswer?: unknown,
  ) => {
    patches.push({ requestId, patch, userAnswer })
  }
  gateway.dispatchInbound = async (frame: unknown) => {
    inboundFrames.push(frame)
  }
  Object.defineProperty(gateway, 'persistCalls', {
    get: () => persistCalls,
  })
  return { gateway, persistCalls: 0, persistOrder, frames, inboundFrames, patches, runnerCalls }
}

async function callAskUser(
  gateway: any,
  body: Record<string, unknown>,
  reqExtra?: EventEmitter,
): Promise<{ status: number; body: any; req: EventEmitter; abort: () => void }> {
  const req: any = reqExtra ?? new EventEmitter()
  req.method = 'POST'
  req.headers = {}
  gateway.readBody = async () => JSON.stringify(body)
  let status = 0
  let raw = ''
  const res: any = {
    headersSent: false,
    writableEnded: false,
    writeHead: (code: number) => {
      status = code
      res.headersSent = true
    },
    end: (chunk?: unknown) => {
      raw = String(chunk ?? '')
      res.writableEnded = true
    },
  }
  const abort = () => {
    req.emit('aborted')
    req.emit('close')
  }
  await gateway.handleEngineAskUser(req, res, 'main')
  return { status, body: raw ? JSON.parse(raw) : {}, req, abort }
}

function installDetached(gateway: any, requestId: string, waiter?: AskUserWaiter) {
  gateway._pendingPermissions.set(requestId, {
    sessionKey: SESSION_KEY,
    toolName: 'AskUserQuestion',
    input: pendingInput(),
    peerKey: 'default:webchat:wsess-askuserhybrid01',
    userId: 'default',
    channel: 'webchat',
    peer: PEER,
    expiresAt: Date.now() + 24 * 60 * 60_000,
    detachedAskUser: true,
  })
  if (waiter) gateway._askUserWaiters.set(requestId, waiter)
}

describe('handleEngineAskUser — hybrid wait', () => {
  it('persists before waiting, then returns posted when the window elapses', async () => {
    const { gateway, persistOrder, inboundFrames } = makeGateway()
    const started = Date.now()
    const r = await callAskUser(gateway, {
      sessionKey: SESSION_KEY,
      questions: QUESTIONS,
      waitMs: 30,
    })
    const elapsed = Date.now() - started
    assert.equal(r.status, 200)
    assert.equal(r.body.status, 'posted')
    assert.match(String(r.body.message), /End your turn now/)
    assert.ok(elapsed < 400, `must not hang past waitMs; elapsed=${elapsed}`)
    assert.deepEqual(persistOrder, ['persist', 'frame'])
    assert.equal(gateway.persistCalls, 1)
    assert.equal(inboundFrames.length, 0)
    assert.equal(gateway._pendingPermissions.size, 1)
    const requestId = [...gateway._pendingPermissions.keys()][0] as string
    assert.match(requestId, /^ask-user:/)
    assert.equal(gateway._askUserWaiters.has(requestId), false)
  })

  it('in-window allow returns the answer and does not start a new turn', async () => {
    const { gateway, inboundFrames, patches, runnerCalls } = makeGateway()
    const pending = callAskUser(gateway, {
      sessionKey: SESSION_KEY,
      questions: QUESTIONS,
      waitMs: 2_000,
    })
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(gateway._pendingPermissions.size, 1)
    const requestId = [...gateway._pendingPermissions.keys()][0] as string
    await gateway.handlePermissionResponse({
      type: 'inbound.permission_response',
      channel: 'webchat',
      peer: PEER,
      requestId,
      behavior: 'allow',
      updatedInput: { answers: { [QUESTION]: 'Vim' } },
    })
    const r = await pending
    assert.equal(r.status, 200)
    assert.equal(r.body.status, 'answered')
    assert.equal(r.body.answers[QUESTION], 'Vim')
    assert.match(String(r.body.message), /already answered/)
    assert.match(String(r.body.message), /Do not call ask_user again/)
    assert.match(String(r.body.message), /Do not wait for a new user message/)
    assert.match(String(r.body.message), /Vim/)
    assert.equal(inboundFrames.length, 0)
    assert.deepEqual(runnerCalls, [])
    assert.equal(gateway._pendingPermissions.has(requestId), false)
    assert.equal(patches.length, 1)
    assert.equal(patches[0]!.patch._resolved, true)
    assert.equal(patches[0]!.patch._behavior, 'allow')
    assert.equal((patches[0]!.patch._answers as Record<string, string>)[QUESTION], 'Vim')
    assert.equal(patches[0]!.userAnswer, undefined)
  })

  it('in-window deny/skip settles without starting a turn', async () => {
    const { gateway, inboundFrames, patches } = makeGateway()
    const pending = callAskUser(gateway, {
      sessionKey: SESSION_KEY,
      questions: QUESTIONS,
      waitMs: 2_000,
    })
    await new Promise((r) => setTimeout(r, 20))
    const requestId = [...gateway._pendingPermissions.keys()][0] as string
    await gateway.handlePermissionResponse({
      type: 'inbound.permission_response',
      channel: 'webchat',
      peer: PEER,
      requestId,
      behavior: 'deny',
      message: 'User skipped the questions',
    })
    const r = await pending
    assert.equal(r.status, 200)
    assert.equal(r.body.status, 'skipped')
    assert.match(String(r.body.message), /skipped/)
    assert.equal(inboundFrames.length, 0)
    assert.equal(patches.length, 1)
    assert.equal(patches[0]!.patch._behavior, 'deny')
    assert.equal(patches[0]!.userAnswer, undefined)
  })

  it('omitting waitMs (legacy client) returns posted immediately; later allow still starts a turn', async () => {
    const { gateway, inboundFrames, patches } = makeGateway()
    const started = Date.now()
    const r = await callAskUser(gateway, {
      sessionKey: SESSION_KEY,
      questions: QUESTIONS,
    })
    const elapsed = Date.now() - started
    assert.equal(r.status, 200)
    assert.equal(r.body.status, 'posted')
    assert.match(String(r.body.message), /End your turn now/)
    assert.ok(elapsed < 400, `legacy client must not be held; elapsed=${elapsed}`)
    assert.equal(gateway._pendingPermissions.size, 1)
    const requestId = [...gateway._pendingPermissions.keys()][0] as string
    assert.match(requestId, /^ask-user:/)
    assert.equal(gateway._askUserWaiters.has(requestId), false)
    await gateway.handlePermissionResponse({
      type: 'inbound.permission_response',
      channel: 'webchat',
      peer: PEER,
      requestId,
      behavior: 'allow',
      updatedInput: { answers: { [QUESTION]: 'Vim' } },
    })
    assert.equal(inboundFrames.length, 1, 'legacy omit-waitMs path must start a new turn')
    assert.match(String((inboundFrames[0] as { content?: { text?: string } }).content?.text ?? ''), /Vim/)
    assert.equal(patches.length, 1)
    assert.ok(patches[0]!.userAnswer, 'detached path persists the user-answer tape row')
  })

  it('after posted, a later allow still starts a new turn', async () => {
    const { gateway, inboundFrames, patches } = makeGateway()
    const r = await callAskUser(gateway, {
      sessionKey: SESSION_KEY,
      questions: QUESTIONS,
      waitMs: 25,
    })
    assert.equal(r.body.status, 'posted')
    const requestId = [...gateway._pendingPermissions.keys()][0] as string
    await gateway.handlePermissionResponse({
      type: 'inbound.permission_response',
      channel: 'webchat',
      peer: PEER,
      requestId,
      behavior: 'allow',
      updatedInput: { answers: { [QUESTION]: 'VS Code' } },
    })
    assert.equal(inboundFrames.length, 1)
    assert.match(String((inboundFrames[0] as { content?: { text?: string } }).content?.text ?? ''), /VS Code/)
    assert.equal(patches.length, 1)
    assert.ok(patches[0]!.userAnswer, 'detached path persists the user-answer tape row')
  })

  it('client abort releases to detached so a later answer still starts a turn', async () => {
    const { gateway, inboundFrames } = makeGateway()
    const req = new EventEmitter()
    const pending = callAskUser(gateway, {
      sessionKey: SESSION_KEY,
      questions: QUESTIONS,
      waitMs: 2_000,
    }, req)
    await new Promise((r) => setTimeout(r, 20))
    const requestId = [...gateway._pendingPermissions.keys()][0] as string
    req.emit('aborted')
    const r = await pending
    assert.equal(r.status, 0)
    assert.equal(gateway._pendingPermissions.has(requestId), true)
    await gateway.handlePermissionResponse({
      type: 'inbound.permission_response',
      channel: 'webchat',
      peer: PEER,
      requestId,
      behavior: 'allow',
      updatedInput: { answers: { [QUESTION]: 'Vim' } },
    })
    assert.equal(inboundFrames.length, 1)
  })

  it('wait failure / missing waiter still leaves the tape card answerable (hydrate path)', async () => {
    const { gateway, inboundFrames, runnerCalls } = makeGateway()
    const requestId = 'ask-user:hydrated-hybrid'
    gateway._hydrateDetachedAskUserPending = async () => ({
      sessionKey: SESSION_KEY,
      toolName: 'AskUserQuestion',
      input: pendingInput(),
      peerKey: 'default:webchat:wsess-askuserhybrid01',
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
      updatedInput: { answers: { [QUESTION]: 'Emacs' } },
    })
    assert.deepEqual(runnerCalls, [])
    assert.equal(inboundFrames.length, 1)
    assert.match(String((inboundFrames[0] as { content?: { text?: string } }).content?.text ?? ''), /Emacs/)
  })
})

describe('handlePermissionResponse — in-window vs released single-flight', () => {
  it('boundary race through the gateway: only one path consumes the allow', async () => {
    const { gateway, inboundFrames, patches } = makeGateway()
    const requestId = 'ask-user:race-1'
    const waiter = new AskUserWaiter()
    installDetached(gateway, requestId, waiter)

    const timeoutSide = Promise.resolve().then(() => waiter.tryRelease())
    const answerSide = gateway.handlePermissionResponse({
      type: 'inbound.permission_response',
      channel: 'webchat',
      peer: PEER,
      requestId,
      behavior: 'allow',
      updatedInput: { answers: { [QUESTION]: 'Vim' } },
    })
    const [released] = await Promise.all([timeoutSide, answerSide])
    const result = await waiter.wait()

    if (released) {
      assert.equal(result.status, 'posted')
      assert.equal(inboundFrames.length, 1, 'released waiter must start a new turn')
      assert.equal(patches.length, 1)
      assert.ok(patches[0]!.userAnswer)
    } else {
      assert.equal(result.status, 'answered')
      assert.equal(inboundFrames.length, 0, 'in-window winner must not start a new turn')
      assert.equal(patches.length, 1)
      assert.equal(patches[0]!.userAnswer, undefined)
    }
    assert.equal(gateway._pendingPermissions.has(requestId), false)
  })

  it('deny after release still does not start a turn', async () => {
    const { gateway, inboundFrames } = makeGateway()
    const requestId = 'ask-user:deny-released'
    const waiter = new AskUserWaiter()
    waiter.tryRelease()
    installDetached(gateway, requestId, waiter)
    await gateway.handlePermissionResponse({
      type: 'inbound.permission_response',
      channel: 'webchat',
      peer: PEER,
      requestId,
      behavior: 'deny',
      message: 'User skipped the questions',
    })
    assert.equal(inboundFrames.length, 0)
    assert.equal(gateway._pendingPermissions.has(requestId), false)
  })
})
