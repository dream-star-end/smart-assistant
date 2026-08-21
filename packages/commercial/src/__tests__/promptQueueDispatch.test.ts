import assert from 'node:assert/strict'
import * as http from 'node:http'
import { describe, test } from 'node:test'
import { WebSocket, WebSocketServer } from 'ws'

import { signAccess } from '../auth/jwt.js'
import {
  BRIDGE_WS_PATH,
  PROMPT_QUEUE_DISPATCH_ACTIVATED_TYPE,
  PROMPT_QUEUE_DISPATCH_CANCEL_TYPE,
  PROMPT_QUEUE_DISPATCH_REQUEST_TYPE,
  PROMPT_QUEUE_DISPATCH_RESULT_TYPE,
  type UserChatBridgeDeps,
  createUserChatBridge,
  parsePromptQueueDispatchRequest,
  parsePromptQueueDispatchCancel,
  parsePromptQueueDispatchActivated,
  shouldRejectCodexTurnForG7,
} from '../ws/userChatBridge.js'

const request = {
  type: PROMPT_QUEUE_DISPATCH_REQUEST_TYPE,
  grantId: '123e4567-e89b-12d3-a456-426614174000',
  owner: {
    sessionKey: 'agent:main:webchat:dm:peer-1',
    clientSessionId: 'peer-1',
    agentId: 'main',
    peer: { id: 'peer-1', kind: 'dm' },
  },
  claim: { epoch: '7', claimToken: 'ab'.repeat(32) },
  item: {
    itemId: 'queue-item-1',
    clientMessageId: 'client-message-1',
    contentHash: 'cd'.repeat(32),
    content: {
      text: 'queued',
      media: [{ kind: 'image', url: `/api/media/${'ef'.repeat(32)}.png` }],
    },
    requestedExecution: { agentId: 'main', model: 'gpt-5.6-sol', effortLevel: 'high' },
  },
} as const

const JWT_SECRET = 'q'.repeat(32)

async function waitJson(
  ws: WebSocket,
  predicate: (value: Record<string, unknown>) => boolean,
  timeoutMs = 2_000,
): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage)
      reject(new Error('waitJson timeout'))
    }, timeoutMs)
    const onMessage = (raw: WebSocket.RawData) => {
      try {
        const value = JSON.parse(raw.toString()) as Record<string, unknown>
        if (!predicate(value)) return
        clearTimeout(timer)
        ws.off('message', onMessage)
        resolve(value)
      } catch {
        /* ignore non-JSON */
      }
    }
    ws.on('message', onMessage)
  })
}

async function startBridge(options: {
  enabled: boolean
  allowed?: boolean
  persistMasterUserMessage?: UserChatBridgeDeps['persistMasterUserMessage']
  loadMasterSessionMessages?: UserChatBridgeDeps['loadMasterSessionMessages']
  promptQueuePreparationTimeoutMs?: number
  accounting?: Pick<
    UserChatBridgeDeps,
    'codexBinding' | 'pgPool' | 'preCheckRedis' | 'pricing'
  >
}) {
  const containerWss = new WebSocketServer({ port: 0 })
  await new Promise<void>((resolve) => containerWss.once('listening', resolve))
  const containerPort = (containerWss.address() as { port: number }).port
  const containerSocketPromise = new Promise<WebSocket>((resolve) => {
    containerWss.once('connection', resolve)
  })
  const bridge = createUserChatBridge({
    jwtSecret: JWT_SECRET,
    promptQueueEnabled: options.enabled,
    resolveContainerEndpoint: async () => ({ host: '127.0.0.1', port: containerPort }),
    containerConnectTimeoutMs: 1_500,
    loadAllowedModelChecker: async () => () => options.allowed ?? true,
    persistMasterUserMessage: options.persistMasterUserMessage,
    loadMasterSessionMessages: options.loadMasterSessionMessages,
    promptQueuePreparationTimeoutMs: options.promptQueuePreparationTimeoutMs,
    ...options.accounting,
  })
  const gateway = http.createServer((_, response) => response.end())
  gateway.on('upgrade', (req, socket, head) => {
    if (!bridge.handleUpgrade(req, socket, head)) socket.destroy()
  })
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve))
  const token = (await signAccess({ sub: '42', role: 'user' }, JWT_SECRET)).token
  const client = new WebSocket(
    `ws://127.0.0.1:${(gateway.address() as { port: number }).port}${BRIDGE_WS_PATH}`,
    ['bearer', token],
  )
  await new Promise<void>((resolve) => client.once('open', resolve))
  const container = await containerSocketPromise
  return {
    client,
    container,
    async close() {
      try {
        client.close()
      } catch {}
      await bridge.shutdown()
      await new Promise<void>((resolve) => containerWss.close(() => resolve()))
      await new Promise<void>((resolve) => gateway.close(() => resolve()))
    },
  }
}

describe('commercial prompt queue dispatch grant', () => {
  test('strictly accepts the server-shaped internal request', () => {
    assert.deepEqual(parsePromptQueueDispatchRequest(request), request)
    const withModelSwitch = {
      ...request,
      item: {
        ...request.item,
        requestedExecution: {
          ...request.item.requestedExecution,
          modelSwitchId: 'model-switch:test:1',
        },
      },
    }
    assert.deepEqual(parsePromptQueueDispatchRequest(withModelSwitch), withModelSwitch)
    assert.equal(parsePromptQueueDispatchRequest({
      ...withModelSwitch,
      item: {
        ...withModelSwitch.item,
        requestedExecution: { ...withModelSwitch.item.requestedExecution, modelSwitchId: 'bad id' },
      },
    }), null)
  })

  test('rejects owner drift, unknown fields and browser-shaped claims', () => {
    assert.equal(
      parsePromptQueueDispatchRequest({
        ...request,
        owner: { ...request.owner, sessionKey: 'agent:other:webchat:dm:peer-1' },
      }),
      null,
    )
    assert.equal(parsePromptQueueDispatchRequest({ ...request, userId: '42' }), null)
    assert.equal(
      parsePromptQueueDispatchRequest({
        ...request,
        claim: { ...request.claim, ttlSeconds: 30 },
      }),
      null,
    )
  })

  test('dispatch cancellation requires the complete original grant correlation', () => {
    const cancel = {
      type: PROMPT_QUEUE_DISPATCH_CANCEL_TYPE,
      grantId: request.grantId,
      owner: request.owner,
      itemId: request.item.itemId,
      contentHash: request.item.contentHash,
      epoch: request.claim.epoch,
      claimToken: request.claim.claimToken,
      reasonCode: 'LEASE_LOST',
    }
    assert.deepEqual(parsePromptQueueDispatchCancel(cancel), cancel)
    assert.equal(
      parsePromptQueueDispatchCancel({ ...cancel, claimToken: '00'.repeat(32), extra: true }),
      null,
    )
  })

  test('activation acknowledgement requires the complete original grant correlation', () => {
    const activated = {
      type: PROMPT_QUEUE_DISPATCH_ACTIVATED_TYPE,
      grantId: request.grantId,
      owner: request.owner,
      itemId: request.item.itemId,
      contentHash: request.item.contentHash,
      epoch: request.claim.epoch,
      claimToken: request.claim.claimToken,
    }
    assert.deepEqual(parsePromptQueueDispatchActivated(activated), activated)
    assert.equal(
      parsePromptQueueDispatchActivated({ ...activated, epoch: '01' }),
      null,
    )
  })

  test('new queue grant bypasses only G7 while legacy behavior is unchanged', () => {
    assert.equal(shouldRejectCodexTurnForG7(false, false), false)
    assert.equal(shouldRejectCodexTurnForG7(true, false), true)
    assert.equal(shouldRejectCodexTurnForG7(false, true), false)
    assert.equal(shouldRejectCodexTurnForG7(true, true), false)
  })

  test('queuing N items touches no account slot, precheck, journal, usage, or credits', async () => {
    const accounting = {
      slotAcquire: 0,
      slotRelease: 0,
      precheckReserve: 0,
      precheckRelease: 0,
      billingPgQuery: 0,
      pricingRead: 0,
    }
    const rig = await startBridge({
      enabled: true,
      accounting: {
        codexBinding: {
          async acquire() {
            accounting.slotAcquire += 1
            return { account_id: 91n, slotId: 'unexpected-slot' }
          },
          release() {
            accounting.slotRelease += 1
          },
        },
        preCheckRedis: {
          async atomicReserve() {
            accounting.precheckReserve += 1
            return { ok: true as const, locked: 0n, needed: 0n }
          },
          async releaseReservation() {
            accounting.precheckRelease += 1
            return true
          },
        },
        pgPool: {
          async query(statement: unknown) {
            const sql = typeof statement === 'string'
              ? statement
              : String((statement as { text?: unknown })?.text ?? '')
            if (/request_finalize_journal|usage_records|credit_ledger|credits\s*=/.test(sql)) {
              accounting.billingPgQuery += 1
            }
            return { rows: [{ status: 'active' }], rowCount: 1 }
          },
        } as unknown as NonNullable<UserChatBridgeDeps['pgPool']>,
        pricing: {
          get() {
            accounting.pricingRead += 1
            return null
          },
        } as unknown as NonNullable<UserChatBridgeDeps['pricing']>,
      },
    })
    try {
      // Bridge connection setup may perform unrelated user/account health
      // reads. Queue admission is required to add exactly zero accounting
      // activity relative to that established connection baseline.
      const beforeQueue = { ...accounting }
      for (let index = 0; index < 3; index++) {
        const itemId = `queued-zero-accounting-${index}`
        const forwarded = waitJson(
          rig.container,
          (value) => value.type === 'inbound.prompt_queue.enqueue' && value.itemId === itemId,
        )
        rig.client.send(JSON.stringify({
          type: 'inbound.prompt_queue.enqueue',
          channel: 'webchat',
          peer: request.owner.peer,
          agentId: 'main',
          itemId,
          clientMessageId: itemId,
          idempotencyKey: `zero-accounting-${index}`,
          content: { text: `queued ${index}` },
          requestedExecution: { model: 'gpt-5.6-sol' },
        }))
        await forwarded
      }
      assert.deepEqual(accounting, beforeQueue)
    } finally {
      await rig.close()
    }
  })

  test('flag off preserves the literal container-to-browser legacy path', async () => {
    const rig = await startBridge({ enabled: false })
    try {
      const seen = waitJson(
        rig.client,
        (value) => value.type === PROMPT_QUEUE_DISPATCH_REQUEST_TYPE,
      )
      rig.container.send(JSON.stringify(request))
      assert.deepEqual(await seen, request)
    } finally {
      await rig.close()
    }
  })

  test('flag on runs the real shared preparation path without pre-activation user persistence', async () => {
    let persisted = 0
    const rig = await startBridge({
      enabled: true,
      persistMasterUserMessage: async () => {
        persisted += 1
        return { applied: true }
      },
    })
    try {
      const forwarded = waitJson(rig.container, (value) => value.type === 'inbound.message')
      rig.container.send(JSON.stringify(request))
      const inbound = await forwarded
      assert.deepEqual(inbound.__oc_prompt_queue_grant, {
        grantId: request.grantId,
        itemId: request.item.itemId,
        contentHash: request.item.contentHash,
        epoch: request.claim.epoch,
        claimToken: request.claim.claimToken,
      })
      assert.deepEqual(inbound.content, request.item.content)
      assert.match(String(inbound.traceId), /^[0-9a-f]{32}$/)
      assert.equal(persisted, 0, 'PG activation owns atomic queue user-row materialization')
    } finally {
      await rig.close()
    }
  })

  test('policy rejection returns one exact negative grant and never forwards execution', async () => {
    const rig = await startBridge({ enabled: true, allowed: false })
    let executions = 0
    rig.container.on('message', (raw) => {
      try {
        if ((JSON.parse(raw.toString()) as { type?: string }).type === 'inbound.message') {
          executions += 1
        }
      } catch {}
    })
    try {
      const rejected = waitJson(
        rig.container,
        (value) => value.type === PROMPT_QUEUE_DISPATCH_RESULT_TYPE,
      )
      rig.container.send(JSON.stringify(request))
      assert.deepEqual(await rejected, {
        type: PROMPT_QUEUE_DISPATCH_RESULT_TYPE,
        grantId: request.grantId,
        owner: request.owner,
        itemId: request.item.itemId,
        contentHash: request.item.contentHash,
        epoch: request.claim.epoch,
        claimToken: request.claim.claimToken,
        outcome: 'rejected',
        disposition: 'user_action_required',
        reasonCode: 'UNAUTHORIZED_MODEL',
      })
      assert.equal(executions, 0)
    } finally {
      await rig.close()
    }
  })

  test('preparation timeout cancels the late grant instead of starting an unclaimed turn', async () => {
    let releasePreparation!: () => void
    const preparationBlocked = new Promise<void>((resolve) => {
      releasePreparation = resolve
    })
    const rig = await startBridge({
      enabled: true,
      promptQueuePreparationTimeoutMs: 20,
      loadMasterSessionMessages: async () => {
        await preparationBlocked
        return []
      },
    })
    let executions = 0
    rig.container.on('message', (raw) => {
      try {
        if ((JSON.parse(raw.toString()) as { type?: string }).type === 'inbound.message') {
          executions += 1
        }
      } catch {}
    })
    try {
      const rejected = waitJson(
        rig.container,
        (value) => value.type === PROMPT_QUEUE_DISPATCH_RESULT_TYPE,
      )
      rig.container.send(JSON.stringify(request))
      assert.equal((await rejected).reasonCode, 'DISPATCH_PREPARATION_TIMEOUT')
      releasePreparation()
      await new Promise<void>((resolve) => setTimeout(resolve, 30))
      assert.equal(executions, 0, 'a timed-out claim must never execute after preparation resumes')
    } finally {
      releasePreparation()
      await rig.close()
    }
  })
})
