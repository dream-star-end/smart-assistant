import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { PromptQueueMutationFrame, PromptQueueSnapshot } from '@openclaude/protocol'

import {
  PromptQueueRunnerInvariantError,
  assertPromptQueueRunnerAdmission,
} from '../engine/codexAppServerRunner.js'
import {
  type PromptQueueClaimRequest,
  type PromptQueueClaimResult,
  type PromptQueueClientApi,
  type PromptQueueDetail,
  readPromptQueueClientConfig,
} from '../promptQueueClient.js'
import {
  PROMPT_QUEUE_DISPATCH_RESULT_TYPE,
  PromptQueueCoordinator,
  type PromptQueueDispatchRequest,
  type PromptQueueSessionContext,
} from '../promptQueueCoordinator.js'
import { assertPromptQueueExecutionAdmission } from '../sessionManager.js'

const context: PromptQueueSessionContext = {
  userId: '42',
  owner: {
    sessionKey: 'agent:main:webchat:dm:peer-1',
    clientSessionId: 'peer-1',
    agentId: 'main',
    peer: { id: 'peer-1', kind: 'dm' },
  },
}

const mediaUrl = `/api/media/${'ab'.repeat(32)}.png`
const detail: PromptQueueDetail = {
  owner: { userId: '42', ...context.owner },
  snapshotVersion: '2',
  itemId: 'item-1',
  clientMessageId: 'message-1',
  state: 'dispatch_claimed',
  content: { text: 'queued turn', media: [{ kind: 'image', url: mediaUrl }] },
  contentHash: 'cd'.repeat(32),
  contentBytes: '123',
  attachments: [
    {
      ordinal: 0,
      kind: 'image',
      url: mediaUrl,
      contentSha256: 'ab'.repeat(32),
      sizeBytes: '99',
    },
  ],
  requestedExecution: { agentId: 'main', model: 'gpt-5.6-sol', effortLevel: 'high' },
  createdAt: 1,
  updatedAt: 2,
}

function snapshot(
  version: string,
  options: {
    active?: { id: string; itemId: string }
    items?: PromptQueueSnapshot['items']
    outcome?: NonNullable<PromptQueueSnapshot['mutation']>['outcome']
  } = {},
): PromptQueueSnapshot {
  return {
    type: 'outbound.prompt_queue.snapshot',
    owner: { userId: '42', ...context.owner },
    version,
    activeTurn: options.active
      ? {
          id: options.active.id,
          sourceItemId: options.active.itemId,
          startedAt: 10,
          steerDelivery: 'turn-boundary',
        }
      : null,
    items: options.items ?? [],
    ...(options.outcome
      ? {
          mutation: {
            idempotencyKey: 'mutation-1',
            operation: 'enqueue',
            outcome: options.outcome,
          },
        }
      : {}),
    serverTs: Date.now(),
  }
}

function marker(frame: PromptQueueDispatchRequest) {
  return {
    grantId: frame.grantId,
    itemId: frame.item.itemId,
    contentHash: frame.item.contentHash,
    epoch: frame.claim.epoch,
    claimToken: frame.claim.claimToken,
  }
}

function lifecycleHarness(engine: 'ccb' | 'codex') {
  const turnId = engine === 'ccb' ? '11'.repeat(32) : '22'.repeat(32)
  const calls: PromptQueueClaimRequest[] = []
  const broadcasts: PromptQueueSnapshot[] = []
  const directs: PromptQueueSnapshot[] = []
  const dispatches: PromptQueueDispatchRequest[] = []
  let anchored = true
  const queued = snapshot('1', {
    items: [
      {
        id: detail.itemId,
        clientMessageId: detail.clientMessageId,
        position: 1,
        displayText: 'queued turn',
        contentHash: detail.contentHash,
        contentBytes: detail.contentBytes,
        attachmentRefs: [{ ordinal: 0, kind: 'image', url: mediaUrl }],
        state: 'queued',
        requestedExecution: detail.requestedExecution,
        createdAt: 1,
        updatedAt: 2,
      },
    ],
  })
  const active = snapshot('3', { active: { id: turnId, itemId: detail.itemId } })
  const client: PromptQueueClientApi = {
    async mutate() {
      throw new Error('not used')
    },
    async snapshot() {
      return calls.some((call) => call.action === 'activate') ? active : queued
    },
    async detail() {
      return calls.some((call) => call.action === 'activate')
        ? { ...detail, state: 'active', engineReceipt: { turnIndex: 9 } }
        : detail
    },
    async claim(_owner, claim): Promise<PromptQueueClaimResult> {
      calls.push(claim)
      if (claim.action === 'acquire') {
        if (calls.some((call) => call.action === 'complete')) {
          return { snapshot: snapshot('4'), outcome: 'empty' }
        }
        return {
          snapshot: snapshot('2'),
          outcome: 'acquired',
          claim: {
            itemId: detail.itemId,
            epoch: '5',
            claimToken: 'ef'.repeat(32),
            leaseUntil: Date.now() + 30_000,
            renewed: false,
          },
        }
      }
      if (claim.action === 'activate') return { snapshot: active, outcome: 'activated' }
      if (claim.action === 'release') return { snapshot: snapshot('4'), outcome: 'released' }
      if (claim.action === 'complete') {
        return anchored
          ? { snapshot: snapshot('4'), outcome: 'completed' }
          : { snapshot: active, outcome: 'rejected', code: 'TAPE_NOT_ACKED' }
      }
      throw new Error(`unexpected claim ${claim.action}`)
    },
  }
  const coordinator = new PromptQueueCoordinator(client, {
    broadcast: (_context, value) => broadcasts.push(value),
    direct: (_context, _requester, value) => directs.push(value),
    sendDispatch: (_context, value) => {
      dispatches.push(value)
      return true
    },
    interruptExact: async () => false,
  })
  return {
    turnId,
    calls,
    broadcasts,
    directs,
    dispatches,
    coordinator,
    setAnchored(value: boolean) {
      anchored = value
    },
  }
}

describe('PromptQueueCoordinator claimed execution', () => {
  for (const engine of ['ccb', 'codex'] as const) {
    test(`${engine} activates only after the real reservation and preserves attachments`, async () => {
      const h = lifecycleHarness(engine)
      try {
        await h.coordinator.hello(context, {})
        assert.equal(h.directs[0]?.version, '1')
        assert.equal(h.dispatches.length, 1)
        assert.deepEqual(h.dispatches[0]?.item.content, detail.content)
        assert.equal(
          (h.dispatches[0]?.item.content.media as Array<{ url: string }>)[0]?.url,
          mediaUrl,
        )
        const lifecycle = h.coordinator.acceptGrant(context, marker(h.dispatches[0]!))
        assert.ok(lifecycle)
        await lifecycle.onTurnReserved({
          turnIndex: 9,
          turnKey: h.turnId,
          traceId: 'trace_queue_123456',
        })
        const activate = h.calls.find((call) => call.action === 'activate')
        assert.deepEqual(activate, {
          action: 'activate',
          epoch: '5',
          claimToken: 'ef'.repeat(32),
          turnId: h.turnId,
          turnIndex: 9,
          traceId: 'trace_queue_123456',
          steerDelivery: 'turn-boundary',
        })
        await lifecycle.onSettled()
        assert.ok(h.calls.some((call) => call.action === 'complete'))
        assert.deepEqual(
          h.broadcasts.map((value) => value.version),
          ['2', '3', '4'],
        )
      } finally {
        h.coordinator.shutdown()
      }
    })
  }

  test('completion race waits for the master tape anchor and never reruns the item', async () => {
    const h = lifecycleHarness('ccb')
    h.setAnchored(false)
    try {
      await h.coordinator.hello(context, {})
      const lifecycle = h.coordinator.acceptGrant(context, marker(h.dispatches[0]!))!
      await lifecycle.onTurnReserved({ turnIndex: 9, turnKey: h.turnId })
      await lifecycle.onSettled()
      assert.equal(h.dispatches.length, 1)
      assert.equal(h.calls.filter((call) => call.action === 'complete').length, 1)
      h.setAnchored(true)
      await h.coordinator.reconcile(context)
      assert.equal(h.calls.filter((call) => call.action === 'complete').length, 2)
      assert.equal(h.dispatches.length, 1, 'active recovery must never auto-rerun')
    } finally {
      h.coordinator.shutdown()
    }
  })

  test('restart persists one exact interrupted tape before completion and never reruns', async () => {
    const turnId = '33'.repeat(32)
    const active = snapshot('8', { active: { id: turnId, itemId: detail.itemId } })
    const calls: PromptQueueClaimRequest[] = []
    const recoveries: Array<{ turnId: string; turnIndex: number; clientMessageId: string }> = []
    let dispatches = 0
    const client: PromptQueueClientApi = {
      async mutate() {
        throw new Error('not used')
      },
      async snapshot() {
        return active
      },
      async detail() {
        return { ...detail, state: 'active', engineReceipt: { turnIndex: 12 } }
      },
      async claim(_owner, claim) {
        calls.push(claim)
        if (claim.action === 'complete') return { snapshot: snapshot('9'), outcome: 'completed' }
        if (claim.action === 'acquire') return { snapshot: snapshot('9'), outcome: 'empty' }
        throw new Error(`unexpected ${claim.action}`)
      },
    }
    const coordinator = new PromptQueueCoordinator(client, {
      broadcast: () => {},
      direct: () => {},
      sendDispatch: () => {
        dispatches += 1
        return true
      },
      interruptExact: async () => false,
      persistInterrupted: async ({
        detail: recoveredDetail,
        turnId: recoveredTurnId,
        turnIndex,
      }) => {
        assert.equal(calls.length, 0, 'completion must wait for the interruption tape')
        recoveries.push({
          turnId: recoveredTurnId,
          turnIndex,
          clientMessageId: recoveredDetail.clientMessageId,
        })
      },
    })
    try {
      await coordinator.hello(context, {})
      assert.deepEqual(recoveries, [
        {
          turnId,
          turnIndex: 12,
          clientMessageId: detail.clientMessageId,
        },
      ])
      assert.deepEqual(calls[0], { action: 'complete', turnId, turnIndex: 12 })
      assert.equal(dispatches, 0)
    } finally {
      coordinator.shutdown()
    }
  })

  test('container restart renews the server claim and redispatches the same item', async () => {
    let dispatch: PromptQueueDispatchRequest | undefined
    const claims: PromptQueueClaimRequest[] = []
    const client: PromptQueueClientApi = {
      async mutate() {
        throw new Error('not used')
      },
      async snapshot() {
        return snapshot('12')
      },
      async detail() {
        return detail
      },
      async claim(_owner, claim) {
        claims.push(claim)
        if (claim.action === 'acquire')
          return {
            snapshot: snapshot('12'),
            outcome: 'renewed',
            claim: {
              itemId: detail.itemId,
              epoch: '9',
              claimToken: 'bb'.repeat(32),
              leaseUntil: Date.now() + 30_000,
              renewed: true,
            },
          }
        throw new Error(`unexpected ${claim.action}`)
      },
    }
    const coordinator = new PromptQueueCoordinator(client, {
      broadcast: () => {},
      direct: () => {},
      sendDispatch: (_context, frame) => {
        dispatch = frame
        return true
      },
      interruptExact: async () => false,
    })
    try {
      await coordinator.hello(context, {})
      assert.deepEqual(claims[0], { action: 'acquire', expectedVersion: '12' })
      assert.equal(dispatch?.item.itemId, detail.itemId)
      assert.deepEqual(dispatch?.claim, { epoch: '9', claimToken: 'bb'.repeat(32) })
    } finally {
      coordinator.shutdown()
    }
  })

  test('detail failure releases the exact acquired claim before retry', async () => {
    const claims: PromptQueueClaimRequest[] = []
    const client: PromptQueueClientApi = {
      async mutate() {
        throw new Error('not used')
      },
      async snapshot() {
        return snapshot('15')
      },
      async detail() {
        throw new Error('detail temporarily unavailable')
      },
      async claim(_owner, claim) {
        claims.push(claim)
        if (claim.action === 'acquire') {
          return {
            snapshot: snapshot('16'),
            outcome: 'acquired',
            claim: {
              itemId: detail.itemId,
              epoch: '17',
              claimToken: 'bc'.repeat(32),
              leaseUntil: Date.now() + 30_000,
              renewed: false,
            },
          }
        }
        if (claim.action === 'release') {
          return { snapshot: snapshot('17'), outcome: 'released' }
        }
        throw new Error(`unexpected ${claim.action}`)
      },
    }
    const coordinator = new PromptQueueCoordinator(client, {
      broadcast: () => {},
      direct: () => {},
      sendDispatch: () => {
        assert.fail('detail failure must not dispatch')
      },
      interruptExact: async () => false,
    })
    try {
      await coordinator.hello(context, {})
      assert.deepEqual(claims[1], {
        action: 'release',
        epoch: '17',
        claimToken: 'bc'.repeat(32),
        disposition: 'retryable',
        reasonCode: 'DETAIL_UNAVAILABLE',
      })
    } finally {
      coordinator.shutdown()
    }
  })

  test('late or altered dispatch grants cannot start a turn', async () => {
    const h = lifecycleHarness('codex')
    try {
      await h.coordinator.hello(context, {})
      assert.equal(
        h.coordinator.acceptGrant(context, {
          ...marker(h.dispatches[0]!),
          claimToken: '00'.repeat(32),
        }),
        null,
      )
      assert.ok(h.coordinator.acceptGrant(context, marker(h.dispatches[0]!)))
      assert.equal(h.coordinator.acceptGrant(context, marker(h.dispatches[0]!)), null)
    } finally {
      h.coordinator.shutdown()
    }
  })

  test('commercial negative grant releases the exact claim with its disposition', async () => {
    const h = lifecycleHarness('codex')
    try {
      await h.coordinator.hello(context, {})
      const frame = h.dispatches[0]!
      const accepted = await h.coordinator.rejectGrant(context, {
        type: PROMPT_QUEUE_DISPATCH_RESULT_TYPE,
        grantId: frame.grantId,
        owner: frame.owner,
        itemId: frame.item.itemId,
        contentHash: frame.item.contentHash,
        epoch: frame.claim.epoch,
        claimToken: frame.claim.claimToken,
        outcome: 'rejected',
        disposition: 'user_action_required',
        reasonCode: 'ERR_INSUFFICIENT_CREDITS',
      })
      assert.equal(accepted, true)
      assert.deepEqual(
        h.calls.find((call) => call.action === 'release'),
        {
          action: 'release',
          epoch: '5',
          claimToken: 'ef'.repeat(32),
          disposition: 'user_action_required',
          reasonCode: 'ERR_INSUFFICIENT_CREDITS',
        },
      )
      assert.equal(await h.coordinator.rejectGrant(context, {}), false)
    } finally {
      h.coordinator.shutdown()
    }
  })

  test('accepted grant keeps renewing its claim until real activation or rejection', async () => {
    const calls: PromptQueueClaimRequest[] = []
    let dispatch: PromptQueueDispatchRequest | undefined
    let acquireCount = 0
    let resolveRenewed!: () => void
    const renewed = new Promise<void>((resolve) => {
      resolveRenewed = resolve
    })
    const client: PromptQueueClientApi = {
      async mutate() {
        throw new Error('not used')
      },
      async snapshot() {
        return snapshot(String(acquireCount + 1))
      },
      async detail() {
        return detail
      },
      async claim(_owner, claim) {
        calls.push(claim)
        if (claim.action === 'acquire') {
          acquireCount += 1
          if (acquireCount > 1) resolveRenewed()
          return {
            snapshot: snapshot(String(acquireCount + 1)),
            outcome: acquireCount === 1 ? 'acquired' : 'renewed',
            claim: {
              itemId: detail.itemId,
              epoch: '5',
              claimToken: 'ef'.repeat(32),
              leaseUntil: Date.now() + (acquireCount === 1 ? 150 : 30_000),
              renewed: acquireCount > 1,
            },
          }
        }
        if (claim.action === 'release') return { snapshot: snapshot('4'), outcome: 'released' }
        throw new Error(`unexpected ${claim.action}`)
      },
    }
    const coordinator = new PromptQueueCoordinator(client, {
      broadcast: () => {},
      direct: () => {},
      sendDispatch: (_context, frame) => {
        dispatch = frame
        return true
      },
      interruptExact: async () => false,
    })
    try {
      await coordinator.hello(context, {})
      const lifecycle = coordinator.acceptGrant(context, marker(dispatch!))!
      await renewed
      await new Promise<void>((resolve) => setTimeout(resolve, 70))
      assert.equal(
        calls.some(
          (call) => call.action === 'release' && call.reasonCode === 'GRANT_TIMEOUT',
        ),
        false,
      )
      await lifecycle.onPreflightRejected('retryable', 'ATTACHMENT_UNAVAILABLE')
      assert.deepEqual(calls.at(-1), {
        action: 'release',
        epoch: '5',
        claimToken: 'ef'.repeat(32),
        disposition: 'retryable',
        reasonCode: 'ATTACHMENT_UNAVAILABLE',
      })
    } finally {
      coordinator.shutdown()
    }
  })

  test('accepted claim survives disconnect plus transient/version-conflict renewal races', async () => {
    const calls: PromptQueueClaimRequest[] = []
    const tab = {}
    let dispatch: PromptQueueDispatchRequest | undefined
    let snapshotCount = 0
    let acquireCount = 0
    let resolveRenewed!: () => void
    const renewedDone = new Promise<void>((resolve) => { resolveRenewed = resolve })
    const client: PromptQueueClientApi = {
      async mutate() {
        throw new Error('not used')
      },
      async snapshot() {
        snapshotCount += 1
        if (snapshotCount === 2) throw new Error('transient snapshot failure')
        return snapshot(String(snapshotCount))
      },
      async detail() {
        return detail
      },
      async claim(_owner, claim) {
        calls.push(claim)
        if (claim.action === 'acquire') {
          acquireCount += 1
          if (acquireCount === 1) {
            return {
              snapshot: snapshot('2'),
              outcome: 'acquired',
              claim: {
                itemId: detail.itemId,
                epoch: '9',
                claimToken: 'ac'.repeat(32),
                leaseUntil: Date.now() + 200,
                renewed: false,
              },
            }
          }
          if (acquireCount === 2) {
            return { snapshot: snapshot('7'), outcome: 'rejected', code: 'VERSION_CONFLICT' }
          }
          resolveRenewed()
          return {
            snapshot: snapshot('7'),
            outcome: 'renewed',
            claim: {
              itemId: detail.itemId,
              epoch: '9',
              claimToken: 'ac'.repeat(32),
              leaseUntil: Date.now() + 30_000,
              renewed: true,
            },
          }
        }
        if (claim.action === 'release') return { snapshot: snapshot('8'), outcome: 'released' }
        throw new Error(`unexpected ${claim.action}`)
      },
    }
    const coordinator = new PromptQueueCoordinator(
      client,
      {
        broadcast: () => {},
        direct: () => {},
        sendDispatch: (_context, frame) => {
          dispatch = frame
          return true
        },
        interruptExact: async () => false,
      },
      { leaseRenewMarginMs: 170, leaseRetryMs: 10 },
    )
    try {
      await coordinator.hello(context, tab)
      const lifecycle = coordinator.acceptGrant(context, marker(dispatch!))!
      await coordinator.disconnect(context, tab)
      assert.equal(
        calls.some((call) => call.action === 'release' && call.reasonCode === 'NO_CLIENT'),
        false,
      )
      await renewedDone
      assert.equal(lifecycle.signal.aborted, false)
      await lifecycle.onPreflightRejected('retryable', 'ATTACHMENT_UNAVAILABLE')
      assert.deepEqual(calls.at(-1), {
        action: 'release',
        epoch: '9',
        claimToken: 'ac'.repeat(32),
        disposition: 'retryable',
        reasonCode: 'ATTACHMENT_UNAVAILABLE',
      })
    } finally {
      coordinator.shutdown()
    }
  })

  for (const renewalLoss of ['rotated_after_expiry', 'claim_held'] as const) {
    test(`accepted lifecycle aborts and releases exactly on ${renewalLoss}`, async () => {
      const calls: PromptQueueClaimRequest[] = []
      const cancellations: Array<Record<string, unknown>> = []
      let dispatch: PromptQueueDispatchRequest | undefined
      let acquireCount = 0
      let resolveLost!: () => void
      const lost = new Promise<void>((resolve) => { resolveLost = resolve })
      const client: PromptQueueClientApi = {
        async mutate() {
          throw new Error('not used')
        },
        async snapshot() {
          return snapshot(String(acquireCount + 1))
        },
        async detail() {
          return detail
        },
        async claim(_owner, claim) {
          calls.push(claim)
          if (claim.action === 'acquire') {
            acquireCount += 1
            if (acquireCount === 1) {
              return {
                snapshot: snapshot('2'),
                outcome: 'acquired',
                claim: {
                  itemId: detail.itemId,
                  epoch: '12',
                  claimToken: 'ad'.repeat(32),
                  leaseUntil: Date.now() + 80,
                  renewed: false,
                },
              }
            }
            if (renewalLoss === 'claim_held') {
              return { snapshot: snapshot('3'), outcome: 'rejected', code: 'CLAIM_HELD' }
            }
            return {
              snapshot: snapshot('3'),
              outcome: 'acquired',
              claim: {
                itemId: detail.itemId,
                epoch: '13',
                claimToken: 'ae'.repeat(32),
                leaseUntil: Date.now() + 30_000,
                renewed: false,
              },
            }
          }
          if (claim.action === 'release') {
            resolveLost()
            return { snapshot: snapshot('4'), outcome: 'released' }
          }
          throw new Error(`unexpected ${claim.action}`)
        },
      }
      const coordinator = new PromptQueueCoordinator(
        client,
        {
          broadcast: () => {},
          direct: () => {},
          sendDispatch: (_context, frame) => {
            dispatch = frame
            return true
          },
          interruptExact: async () => false,
        },
        { leaseRenewMarginMs: 70, leaseRetryMs: 5 },
      )
      try {
        await coordinator.hello(context, {})
        const lifecycle = coordinator.acceptGrant(context, marker(dispatch!), (cancel) => {
          cancellations.push(cancel as unknown as Record<string, unknown>)
          return true
        })!
        await lost
        assert.equal(lifecycle.signal.aborted, true)
        assert.deepEqual(cancellations, [{
          type: 'outbound.prompt_queue.dispatch_cancel',
          grantId: dispatch!.grantId,
          owner: context.owner,
          itemId: detail.itemId,
          contentHash: detail.contentHash,
          epoch: '12',
          claimToken: 'ad'.repeat(32),
          reasonCode: 'LEASE_LOST',
        }])
        const expectedClaim = renewalLoss === 'rotated_after_expiry'
          ? { epoch: '13', claimToken: 'ae'.repeat(32) }
          : { epoch: '12', claimToken: 'ad'.repeat(32) }
        assert.deepEqual(calls.at(-1), {
          action: 'release',
          ...expectedClaim,
          disposition: 'retryable',
          reasonCode: 'LEASE_LOST',
        })
        await assert.rejects(
          lifecycle.onTurnReserved({ turnIndex: 30, turnKey: '77'.repeat(32) }),
          /claim changed/,
        )
      } finally {
        coordinator.shutdown()
      }
    })
  }

  test('unaccepted grant renewal cannot extend its original dispatch deadline', async () => {
    const calls: PromptQueueClaimRequest[] = []
    let acquireCount = 0
    let resolveReleased!: () => void
    const released = new Promise<void>((resolve) => {
      resolveReleased = resolve
    })
    const client: PromptQueueClientApi = {
      async mutate() {
        throw new Error('not used')
      },
      async snapshot() {
        return snapshot(String(acquireCount + 1))
      },
      async detail() {
        return detail
      },
      async claim(_owner, claim) {
        calls.push(claim)
        if (claim.action === 'acquire') {
          acquireCount += 1
          return {
            snapshot: snapshot(String(acquireCount + 1)),
            outcome: acquireCount === 1 ? 'acquired' : 'renewed',
            claim: {
              itemId: detail.itemId,
              epoch: '1',
              claimToken: 'aa'.repeat(32),
              leaseUntil: Date.now() + (acquireCount === 1 ? 200 : 30_000),
              renewed: acquireCount > 1,
            },
          }
        }
        if (claim.action === 'release') {
          resolveReleased()
          return { snapshot: snapshot('4'), outcome: 'released' }
        }
        throw new Error(`unexpected ${claim.action}`)
      },
    }
    const coordinator = new PromptQueueCoordinator(
      client,
      {
        broadcast: () => {},
        direct: () => {},
        sendDispatch: () => true,
        interruptExact: async () => false,
      },
      { grantTimeoutMs: 80, leaseRenewMarginMs: 150 },
    )
    try {
      await coordinator.hello(context, {})
      await released
      assert.ok(acquireCount >= 2, 'the claim should renew before its grant deadline')
      assert.deepEqual(calls.at(-1), {
        action: 'release',
        epoch: '1',
        claimToken: 'aa'.repeat(32),
        disposition: 'retryable',
        reasonCode: 'GRANT_TIMEOUT',
      })
    } finally {
      coordinator.shutdown()
    }
  })

  test('attachment preflight rejection blocks before activation', async () => {
    const h = lifecycleHarness('ccb')
    try {
      await h.coordinator.hello(context, {})
      const lifecycle = h.coordinator.acceptGrant(context, marker(h.dispatches[0]!))!
      await lifecycle.onPreflightRejected('user_action_required', 'ATTACHMENT_INVALID')
      assert.deepEqual(
        h.calls.find((call) => call.action === 'release'),
        {
          action: 'release',
          epoch: '5',
          claimToken: 'ef'.repeat(32),
          disposition: 'user_action_required',
          reasonCode: 'ATTACHMENT_INVALID',
        },
      )
      assert.equal(
        h.calls.some((call) => call.action === 'activate'),
        false,
      )
    } finally {
      h.coordinator.shutdown()
    }
  })

  test('activation CAS failure releases the claim instead of stranding it', async () => {
    const calls: PromptQueueClaimRequest[] = []
    let dispatch: PromptQueueDispatchRequest | undefined
    const client: PromptQueueClientApi = {
      async mutate() {
        throw new Error('not used')
      },
      async snapshot() {
        return snapshot('1')
      },
      async detail() {
        return detail
      },
      async claim(_owner, claim) {
        calls.push(claim)
        if (claim.action === 'acquire')
          return {
            snapshot: snapshot('2'),
            outcome: 'acquired',
            claim: {
              itemId: detail.itemId,
              epoch: '6',
              claimToken: 'aa'.repeat(32),
              leaseUntil: Date.now() + 30_000,
              renewed: false,
            },
          }
        if (claim.action === 'activate') {
          return { snapshot: snapshot('2'), outcome: 'rejected', code: 'CLAIM_LOST' }
        }
        if (claim.action === 'release') return { snapshot: snapshot('3'), outcome: 'released' }
        throw new Error(`unexpected ${claim.action}`)
      },
    }
    const coordinator = new PromptQueueCoordinator(client, {
      broadcast: () => {},
      direct: () => {},
      sendDispatch: (_context, frame) => {
        dispatch = frame
        return true
      },
      interruptExact: async () => false,
    })
    try {
      await coordinator.hello(context, {})
      const lifecycle = coordinator.acceptGrant(context, marker(dispatch!))!
      await assert.rejects(
        lifecycle.onTurnReserved({ turnIndex: 20, turnKey: '66'.repeat(32) }),
        /activation rejected/,
      )
      await lifecycle.onSettled(new Error('activation failed'))
      assert.ok(calls.some((call) => call.action === 'release'))
    } finally {
      coordinator.shutdown()
    }
  })
})

describe('PromptQueueCoordinator mutation and fallback semantics', () => {
  const interject = (mode: 'insert_current' | 'interrupt_then_head'): PromptQueueMutationFrame => ({
    type: 'inbound.prompt_queue.interject',
    peer: context.owner.peer,
    agentId: 'main',
    itemId: 'item-2',
    mode,
    expectedVersion: '5',
    expectedTurnId: '44'.repeat(32),
    idempotencyKey: `interject-${mode}`,
  })

  for (const mode of ['insert_current', 'interrupt_then_head'] as const) {
    test(`${mode} uses turn-boundary fallback without losing the queued item`, async () => {
      const active = snapshot('6', {
        active: { id: '44'.repeat(32), itemId: detail.itemId },
        items: [
          {
            id: 'item-2',
            clientMessageId: 'message-2',
            position: 1,
            displayText: 'next',
            contentHash: 'aa'.repeat(32),
            contentBytes: '4',
            attachmentRefs: [],
            state: 'queued',
            requestedExecution: { agentId: 'main' },
            createdAt: 1,
            updatedAt: 2,
          },
        ],
        outcome: 'delivery_pending',
      })
      let interrupts = 0
      let interruptAcks = 0
      const client: PromptQueueClientApi = {
        async mutate() {
          return { snapshot: active }
        },
        async snapshot() {
          return active
        },
        async detail() {
          return { ...detail, state: 'active', engineReceipt: {} }
        },
        async claim(_owner, claim) {
          if (claim.action === 'interrupt_ack') {
            interruptAcks += 1
            return { snapshot: active, outcome: 'interrupt_acknowledged' }
          }
          throw new Error(`unexpected ${claim.action}`)
        },
      }
      const coordinator = new PromptQueueCoordinator(client, {
        broadcast: () => {},
        direct: () => {},
        sendDispatch: () => false,
        interruptExact: async () => {
          interrupts += 1
          return true
        },
      })
      try {
        await coordinator.mutate(context, interject(mode), {})
        assert.equal(interrupts, mode === 'interrupt_then_head' ? 1 : 0)
        assert.equal(interruptAcks, mode === 'interrupt_then_head' ? 1 : 0)
        assert.equal(active.items[0]?.id, 'item-2')
        assert.equal(active.items[0]?.position, 1)
      } finally {
        coordinator.shutdown()
      }
    })
  }

  test('successful mutations broadcast all tabs while version conflicts are requester-only', async () => {
    const outcomes: Array<'applied' | 'version_conflict'> = ['applied', 'version_conflict']
    let broadcasts = 0
    let directs = 0
    const client: PromptQueueClientApi = {
      async mutate() {
        return { snapshot: snapshot('1', { outcome: outcomes.shift()! }) }
      },
      async snapshot() {
        return snapshot('1')
      },
      async detail() {
        throw new Error('not used')
      },
      async claim() {
        return { snapshot: snapshot('1'), outcome: 'empty' }
      },
    }
    const coordinator = new PromptQueueCoordinator(client, {
      broadcast: () => {
        broadcasts += 1
      },
      direct: () => {
        directs += 1
      },
      sendDispatch: () => false,
      interruptExact: async () => false,
    })
    const enqueue: PromptQueueMutationFrame = {
      type: 'inbound.prompt_queue.enqueue',
      peer: context.owner.peer,
      channel: 'webchat',
      agentId: 'main',
      itemId: 'item-1',
      clientMessageId: 'message-1',
      idempotencyKey: 'enqueue-1',
      content: { text: 'hello' },
      requestedExecution: {},
    }
    try {
      await coordinator.mutate(context, enqueue, {})
      await coordinator.mutate(context, { ...enqueue, idempotencyKey: 'enqueue-2' }, {})
      assert.equal(broadcasts, 1)
      assert.equal(directs, 1)
    } finally {
      coordinator.shutdown()
    }
  })

  test('browser tab restart receives a fresh snapshot without an AgentSession', async () => {
    const requesters: object[] = []
    let snapshots = 0
    const client: PromptQueueClientApi = {
      async mutate() {
        throw new Error('not used')
      },
      async snapshot() {
        snapshots += 1
        return snapshot('7')
      },
      async detail() {
        throw new Error('not used')
      },
      async claim() {
        return { snapshot: snapshot('7'), outcome: 'empty' }
      },
    }
    const coordinator = new PromptQueueCoordinator(client, {
      broadcast: () => {},
      direct: (_context, requester) => requesters.push(requester),
      sendDispatch: () => false,
      interruptExact: async () => false,
    })
    const firstTab = {}
    const restartedTab = {}
    try {
      await coordinator.hello(context, firstTab)
      await coordinator.hello(context, restartedTab)
      assert.equal(snapshots, 2)
      assert.deepEqual(requesters, [firstTab, restartedTab])
    } finally {
      coordinator.shutdown()
    }
  })
})

describe('prompt queue execution guards and flag', () => {
  test('strict opt-in requires the exact flag and commercial identity pair', () => {
    const base = {
      OPENCLAUDE_V3_MASTER_BASE_URL: 'http://master:18791/',
      OPENCLAUDE_V3_CONTAINER_TOKEN: 'secret',
      OC_USER_ID: '42',
    }
    assert.equal(readPromptQueueClientConfig(base), null)
    assert.equal(readPromptQueueClientConfig({ ...base, OC_PROMPT_QUEUE_V1: 'true' }), null)
    assert.deepEqual(readPromptQueueClientConfig({ ...base, OC_PROMPT_QUEUE_V1: '1' }), {
      baseUrl: 'http://master:18791',
      bearer: 'secret',
      userId: '42',
    })
  })

  test('promise-lock and Codex runner refuse a hidden second queue turn', () => {
    assert.doesNotThrow(() => assertPromptQueueExecutionAdmission(true, 0, 1))
    assert.throws(
      () => assertPromptQueueExecutionAdmission(true, 1, 2),
      /PROMPT_QUEUE_EXECUTION_INVARIANT/,
    )
    assert.doesNotThrow(() => assertPromptQueueExecutionAdmission(false, 4, 4))
    assert.doesNotThrow(() => assertPromptQueueRunnerAdmission(true, false, 0))
    assert.throws(
      () => assertPromptQueueRunnerAdmission(true, true, 0),
      PromptQueueRunnerInvariantError,
    )
    assert.throws(
      () => assertPromptQueueRunnerAdmission(true, false, 1),
      PromptQueueRunnerInvariantError,
    )
    assert.doesNotThrow(() => assertPromptQueueRunnerAdmission(false, true, 3))
  })
})
