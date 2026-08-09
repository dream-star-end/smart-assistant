import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Gateway } from '../server.js'
import { SessionManager } from '../sessionManager.js'

describe('session transcript shutdown barrier', () => {
  it('waits for delivery chains that are still committing', async () => {
    const gateway = Object.create(Gateway.prototype) as any
    gateway._sessionDeliveryChains = new Map()
    gateway._tapePoisoned = new Set()
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const delivery = gateway._enqueueSessionDelivery('session-a', async () => pending)
    let drained = false
    const barrier = gateway._awaitSessionDeliveryDrain().then(() => {
      drained = true
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(drained, false)
    release()
    await delivery
    await barrier
    assert.equal(gateway._sessionDeliveryChains.size, 0)
  })

  it('refuses to certify a poisoned tape as drained', async () => {
    const gateway = Object.create(Gateway.prototype) as any
    gateway._sessionDeliveryChains = new Map()
    gateway._tapePoisoned = new Set(['session-b'])
    await assert.rejects(
      gateway._awaitSessionDeliveryDrain(),
      /cannot establish transcript write barrier/,
    )
  })

  it('waits for an in-flight REST session mutation', async () => {
    const gateway = Object.create(Gateway.prototype) as any
    gateway._sessionAuthorityWrites = new Set()
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const write = gateway._trackSessionAuthorityWrite(pending)
    let drained = false
    const barrier = gateway._awaitSessionAuthorityWriteDrain().then(() => {
      drained = true
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(drained, false)
    release()
    await write
    await barrier
    assert.equal(gateway._sessionAuthorityWrites.size, 0)
  })

  it('waits for an inbound dispatch accepted before shutdown', async () => {
    const gateway = Object.create(Gateway.prototype) as any
    gateway._inboundDispatches = new Set()
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const dispatch = gateway._trackInboundDispatch(pending)
    let drained = false
    const barrier = gateway._awaitInboundDispatchDrain().then(() => {
      drained = true
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(drained, false)
    release()
    await dispatch
    await barrier
    assert.equal(gateway._inboundDispatches.size, 0)
  })

  it('cancels and joins a submit queued behind an active turn', async () => {
    const manager = Object.create(SessionManager.prototype) as any
    manager._shuttingDown = false
    manager.sessions = new Map()
    manager._resumeMap = new Map()
    manager._resumeMapProvider = new Map()
    manager._resumeMapLastCost = new Map()
    manager._resumeMapWrite = Promise.resolve()
    manager._saveResumeMap = () => {}
    manager._endContinuationWatch = () => {}

    let releaseActive!: () => void
    const active = new Promise<void>((resolve) => {
      releaseActive = resolve
    })
    let turnsStarted = 0
    manager.runOneTurnWithRetry = async () => {
      turnsStarted++
      await active
    }
    const runner = {
      effortLevel: undefined,
      model: undefined,
      lastActivityAt: Date.now(),
      shutdown: async () => releaseActive(),
      off: () => {},
    }
    const session = {
      sessionKey: 'queued-shutdown',
      agentId: 'main',
      channel: 'webchat',
      peerId: 'web-queued-shutdown',
      userId: 'owner',
      title: 'queued',
      startedAt: Date.now(),
      runner,
      runnerProviderTag: 'ccb',
      ccbSessionId: null,
      lock: Promise.resolve(),
      lastUsedAt: Date.now(),
      totalCostUSD: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      turns: 1,
      _lastCcbCumulativeCost: 0,
      toolUseIdToName: new Map(),
      _historicalContextInjected: true,
    }
    manager.sessions.set(session.sessionKey, session)

    const first = manager.submit(session, 'first', () => {})
    while (turnsStarted === 0) await new Promise((resolve) => setTimeout(resolve, 1))
    const second = manager.submit(session, 'second', () => {})
    await new Promise((resolve) => setTimeout(resolve, 5))

    await manager.shutdownAll()
    await Promise.all([first, second])
    assert.equal(turnsStarted, 1)
    assert.equal(manager.sessions.size, 0)
  })
})
