import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import type { DurableAgentGroup } from '@openclaude/protocol'

import { SessionManager } from '../sessionManager.js'
import { makeV3MasterRetryQueue } from '../v3MasterRetryQueue.js'
import {
  makeV3MasterSink,
  setV3MasterSinkSingleton,
  type V3MasterSink,
} from '../v3MasterSink.js'

const owner = { parentSessionId: 'shutdown-owner', parentTurnKey: 'a'.repeat(64), turnIndex: 1 }
const group: DurableAgentGroup = {
  runId: 'shutdown-run', agentId: 'main', goal: 'durable shutdown',
  status: 'ok', completedAt: 1_720_000_000_000,
}
const manager = () => new SessionManager({
  version: 1,
  gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
  auth: { mode: 'subscription', claudeCodePath: '' },
  sessions: { dbPath: '' },
} as never)
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('late delegate shutdown persistence barrier', { concurrency: 1 }, () => {
  it('shutdown waits for the real durable receipt before clearing the sink, not for a local root lookup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'late-delegate-shutdown-'))
    let releaseStage!: () => void
    const stageGate = new Promise<void>((resolve) => { releaseStage = resolve })
    let releaseLookup!: () => void
    const legacyLookupGate = new Promise<void>((resolve) => { releaseLookup = resolve })
    const queue = makeV3MasterRetryQueue({ dir, attemptSend: async () => { throw new Error('root not ready') } })
    let stages = 0
    const sink = makeV3MasterSink({
      config: { baseUrl: 'http://master.test:18791', bearer: `oc-v3.7.${'b'.repeat(64)}` },
      retryQueue: {
        ...queue,
        stageDurable: async (entry) => { stages++; await stageGate; return queue.stageDurable(entry) },
        kick: () => {},
      },
      attemptSendImpl: async () => { throw new Error('root not ready') },
    })
    // A rolling fixture exposes the old hook. It must not create pre-stage
    // asynchronous work invisible to shutdownAll's persistence barrier.
    const rollingSink: V3MasterSink & { lookupRootLogicalRun: () => Promise<{ status: 'absent' }> } = {
      ...sink,
      lookupRootLogicalRun: async () => { await legacyLookupGate; return { status: 'absent' } },
    }
    setV3MasterSinkSingleton(rollingSink)
    const sm = manager()
    const delivery = Promise.resolve(sm.deliverLateDelegateAgentGroup({ owner, group }))
    void delivery.catch(() => {})
    let closed = false
    const closing = sm.shutdownAll().then(() => { closed = true })
    try {
      // Wait the real resume-map write, not an arbitrary delay, so an
      // unrelated filesystem operation cannot mask an already-open barrier.
      await (sm as unknown as { _resumeMapWrite: Promise<void> })._resumeMapWrite
      await nextTurn()
      assert.equal(closed, false, 'shutdown cannot finish before a durable receipt exists')
      assert.equal(stages, 1, 'late completion must stage without a local authority lookup')
      assert.equal((await readdir(dir)).filter((n) => n.endsWith('.json')).length, 0)
      releaseStage()
      await closing
      setV3MasterSinkSingleton(null) // production server order
      await delivery
      const names = (await readdir(dir)).filter((n) => n.endsWith('.json'))
      assert.equal(names.length, 1, 'root dependency stays in the existing durable queue')
      const receipt = JSON.parse(await readFile(join(dir, names[0]!), 'utf8'))
      assert.equal(receipt.payload.continuationOfTurnKey, owner.parentTurnKey)
      assert.equal(receipt.payload.agentGroups[0].runId, group.runId)
      assert.equal((await readdir(dir)).some((n) => n.endsWith('.jsonl')), false)
    } finally {
      releaseLookup()
      releaseStage()
      await delivery.catch(() => {})
      await sm.awaitPendingPersistence()
      await closing
      queue.stopPeriodic()
      setV3MasterSinkSingleton(null)
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('a missing managed sink rejection is consumed and releases admission for a later durable retry', async () => {
    const previous = process.env.OC_RUNTIME_CHANNEL
    process.env.OC_RUNTIME_CHANNEL = 'isolated-shutdown-test'
    const sm = manager()
    setV3MasterSinkSingleton(null)
    try {
      const accepted = await Promise.resolve(sm.deliverLateDelegateAgentGroup({ owner, group }))
        .then(() => true, () => false)
      assert.equal(accepted, true, 'public fire-and-forget callback must consume persistence rejection')
      await sm.awaitPendingPersistence()
      let writes = 0
      setV3MasterSinkSingleton({
        persistOrQueue: async () => { writes++; return { ok: true } },
        attemptOnce: async () => {},
      })
      assert.equal(await sm.deliverLateDelegateAgentGroup({ owner, group }), true)
      await sm.awaitPendingPersistence()
      assert.equal(writes, 1, 'a non-durable failure must not pin the run as already persisted')
    } finally {
      setV3MasterSinkSingleton(null)
      if (previous === undefined) delete process.env.OC_RUNTIME_CHANNEL
      else process.env.OC_RUNTIME_CHANNEL = previous
    }
  })
})
