import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_MAX_RESIDENT_RUNNERS,
  DEFAULT_MEMORY_PRESSURE_RATIO,
  readCgroupMemoryUsage,
  resolveMaxResidentRunners,
  resolveMemoryPressureThreshold,
} from '../cgroupMemoryGuard.js'
import {
  retireKeepResume,
  runEvictionPass,
  type SessionLifecycleHost,
} from '../sessionLifecycle.js'
import {
  noteCcbTaskNotification,
  resetCcbLocalAgentCallbackDedupeForTest,
} from '../ccbLocalAgentCallback.js'
import type { AgentSession } from '../sessionTypes.js'

function makeSession(opts: {
  key: string
  peerId: string
  lastUsedAt: number
  isRunning?: boolean
  activeTurnCount?: number
  activeClientTurnCount?: number
  idleInternalTurns?: number
  admittingClientMessageId?: string
}): { session: AgentSession; shutdownCalls: () => number } {
  let shutdowns = 0
  let running = opts.isRunning ?? true
  const session = {
    sessionKey: opts.key,
    peerId: opts.peerId,
    lastUsedAt: opts.lastUsedAt,
    executionTarget: { kind: 'local' as const },
    _activeTurnCount: opts.activeTurnCount ?? 0,
    _activeClientTurnCount: opts.activeClientTurnCount ?? 0,
    _idleInternalTurns: opts.idleInternalTurns ?? 0,
    _admittingClientMessageId: opts.admittingClientMessageId,
    runner: {
      get isRunning() {
        return running
      },
      lastActivityAt: opts.lastUsedAt,
      shutdown: async () => {
        shutdowns++
        running = false
      },
    },
  } as unknown as AgentSession
  return { session, shutdownCalls: () => shutdowns }
}

function makeHost(opts: {
  sessions: AgentSession[]
  maxRunners?: number
  memThreshold?: number
  readCgroupMemory?: SessionLifecycleHost['_readCgroupMemory']
  preheatKeys?: string[]
  promptQueueHeldKeys?: Set<string>
}): {
  host: SessionLifecycleHost
  savedResumeCount: () => number
  prunedCount: () => number
  destroyedEvents: string[]
} {
  const sessionMap = new Map<string, AgentSession>()
  const idToKey = new Map<string, string>()
  const resumeMap = new Map<string, string>()
  for (const s of opts.sessions) {
    sessionMap.set(s.sessionKey, s)
    idToKey.set(s.peerId, s.sessionKey)
    resumeMap.set(s.sessionKey, `native-${s.peerId}`)
  }
  let saves = 0
  let prunes = 0
  const destroyedEvents: string[] = []
  const preheatInFlight = new Map<string, Promise<any>>()
  for (const k of opts.preheatKeys ?? []) {
    preheatInFlight.set(k, Promise.resolve('started'))
  }

  const host: SessionLifecycleHost = {
    sessions: sessionMap as any,
    _sessionIdToKey: idToKey,
    _resumeMap: resumeMap,
    _resumeMapTimestamps: new Map(),
    _resumeMapLastCost: new Map(),
    _resumeMapCostImprecise: new Map(),
    _resumeMapProvider: new Map(),
    _resumeMapHistory: new Map(),
    _resumeMapWrite: Promise.resolve(),
    _preheatActive: 0,
    _preheatInFlight: preheatInFlight,
    _promptQueueHolds: (s: AgentSession) => Boolean(opts.promptQueueHeldKeys?.has(s.sessionKey)),
    _flushTailFolding: async () => {},
    _getRepoSnapshot: () => null,
    _remoteTargetController: undefined,
    _runtimeRecycleDrainTimer: null,
    _runtimeRecycleDrainUntil: 0,
    _saveResumeMap: () => {
      saves++
    },
    _pruneResumeMap: () => {
      prunes++
    },
    awaitPendingPersistence: async () => {},
    finishIdleUnderLock: async () => 'done' as any,
    markPlannedServiceRestart: (s: AgentSession) => {
      s._plannedTeardown = 'service_restart'
    },
    maxIdleMsChat: 2 * 60 * 60 * 1000,
    maxIdleMsCron: 30 * 60 * 1000,
    onSessionDestroyed: (k: string) => destroyedEvents.push(k),
    releaseRuntimeRecycleDrain: () => {},
    scheduleIdleDrain: () => {},
    submit: async () => ({} as any),
    _maxResidentRunners: opts.maxRunners,
    _memoryPressureThreshold: opts.memThreshold,
    _readCgroupMemory: opts.readCgroupMemory,
    retireKeepResume: async function (key: string) {
      await retireKeepResume.call(host, key)
    },
  }
  return {
    host,
    savedResumeCount: () => saves,
    prunedCount: () => prunes,
    destroyedEvents,
  }
}

describe('cgroupMemoryGuard (OCV5-825)', () => {
  it('reads cgroup v2, falls back to cgroup v1, and returns null when unlimited or missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-cgroup-'))
    try {
      const v2Cur = join(dir, 'memory.current')
      const v2Max = join(dir, 'memory.max')
      const v1Cur = join(dir, 'v1.usage')
      const v1Max = join(dir, 'v1.limit')

      // Missing files → safe null
      assert.equal(
        await readCgroupMemoryUsage({
          v2CurrentPath: v2Cur,
          v2MaxPath: v2Max,
          v1CurrentPath: v1Cur,
          v1MaxPath: v1Max,
        }),
        null,
      )

      // v2 reading
      await writeFile(v2Cur, '3221225472\n') // 3 GiB
      await writeFile(v2Max, '4294967296\n') // 4 GiB
      const r2 = await readCgroupMemoryUsage({
        v2CurrentPath: v2Cur,
        v2MaxPath: v2Max,
        v1CurrentPath: v1Cur,
        v1MaxPath: v1Max,
      })
      assert.equal(r2?.version, 'v2')
      assert.equal(r2?.ratio, 0.75)

      // v2 max = "max" (unlimited) → fallback to v1
      await writeFile(v2Max, 'max\n')
      await writeFile(v1Cur, '800000000\n')
      await writeFile(v1Max, '1000000000\n')
      const r1 = await readCgroupMemoryUsage({
        v2CurrentPath: v2Cur,
        v2MaxPath: v2Max,
        v1CurrentPath: v1Cur,
        v1MaxPath: v1Max,
      })
      assert.equal(r1?.version, 'v1')
      assert.equal(r1?.ratio, 0.8)

      // v1 unlimited sentinel (>= 1 PiB) → null
      await writeFile(v1Max, '9223372036854771712\n')
      assert.equal(
        await readCgroupMemoryUsage({
          v2CurrentPath: v2Cur,
          v2MaxPath: v2Max,
          v1CurrentPath: v1Cur,
          v1MaxPath: v1Max,
        }),
        null,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('parses env config with safe defaults', () => {
    assert.equal(resolveMaxResidentRunners({}), DEFAULT_MAX_RESIDENT_RUNNERS)
    assert.equal(resolveMaxResidentRunners({ OC_MAX_RESIDENT_RUNNERS: '4' }), 4)
    assert.equal(resolveMaxResidentRunners({ OC_MAX_RESIDENT_RUNNERS: '0' }), 0)
    assert.equal(resolveMaxResidentRunners({ OC_MAX_RESIDENT_RUNNERS: 'bad' }), DEFAULT_MAX_RESIDENT_RUNNERS)
    assert.equal(resolveMemoryPressureThreshold({}), DEFAULT_MEMORY_PRESSURE_RATIO)
    assert.equal(resolveMemoryPressureThreshold({ OC_MEMORY_PRESSURE_RATIO: '0.82' }), 0.82)
    assert.equal(resolveMemoryPressureThreshold({ OC_MEMORY_PRESSURE_RATIO: '2.5' }), DEFAULT_MEMORY_PRESSURE_RATIO)
  })
})

describe('runEvictionPass — memory watermark & resident runner cap (OCV5-825)', () => {
  it('retires LRU idle runners via retireKeepResume when cgroup memory > 75% and keeps resume-map', async () => {
    const now = Date.now()
    const sOldest = makeSession({ key: 'agent:main:webchat:dm:s1', peerId: 's1', lastUsedAt: now - 30_000 })
    const sMid = makeSession({ key: 'agent:main:webchat:dm:s2', peerId: 's2', lastUsedAt: now - 20_000 })
    const sNewest = makeSession({ key: 'agent:main:webchat:dm:s3', peerId: 's3', lastUsedAt: now - 10_000 })

    // First read 85% (>75%), after retiring s1 drops to 65% (<=75%) → stops retiring!
    let reads = 0
    const { host, savedResumeCount } = makeHost({
      sessions: [sNewest.session, sOldest.session, sMid.session],
      maxRunners: 10,
      readCgroupMemory: async () => {
        reads++
        return {
          currentBytes: reads === 1 ? 850 : 650,
          maxBytes: 1000,
          ratio: reads === 1 ? 0.85 : 0.65,
          version: 'v2',
        }
      },
    })

    const res = await runEvictionPass.call(host)
    assert.equal(res.pressureRetired, 1)
    assert.deepEqual(res.retiredKeys, ['agent:main:webchat:dm:s1'])
    assert.equal(sOldest.shutdownCalls(), 1)
    assert.equal(sMid.shutdownCalls(), 0)
    assert.equal(sNewest.shutdownCalls(), 0)
    assert.equal(host.sessions.has('agent:main:webchat:dm:s1'), false)
    assert.equal(host._resumeMap.get('agent:main:webchat:dm:s1'), 'native-s1', 'native resume-map MUST be preserved')
    assert.equal(savedResumeCount(), 1)
  })

  it('retires LRU idle runners when resident count exceeds cap, and NEVER evicts running/in-flight sessions', async () => {
    const now = Date.now()
    // Oldest is BUSY (activeTurnCount=1) → MUST NOT be evicted!
    const sBusyActive = makeSession({
      key: 'agent:main:webchat:dm:busy1',
      peerId: 'busy1',
      lastUsedAt: now - 90_000,
      activeTurnCount: 1,
    })
    // Second oldest is BUSY (client turn in-flight) → MUST NOT be evicted!
    const sBusyClient = makeSession({
      key: 'agent:main:webchat:dm:busy2',
      peerId: 'busy2',
      lastUsedAt: now - 80_000,
      activeClientTurnCount: 1,
    })
    // Third oldest is BUSY (admitting) → MUST NOT be evicted!
    const sBusyAdmit = makeSession({
      key: 'agent:main:webchat:dm:busy3',
      peerId: 'busy3',
      lastUsedAt: now - 70_000,
      admittingClientMessageId: 'msg-1',
    })
    // Idle candidates
    const sIdleOld = makeSession({ key: 'agent:main:webchat:dm:idle1', peerId: 'idle1', lastUsedAt: now - 50_000 })
    const sIdleNew = makeSession({ key: 'agent:main:webchat:dm:idle2', peerId: 'idle2', lastUsedAt: now - 10_000 })

    // Cap = 3, total resident = 5 (3 busy + 2 idle) → retires both idle sessions, touches 0 busy sessions!
    const { host } = makeHost({
      sessions: [
        sBusyActive.session,
        sBusyClient.session,
        sBusyAdmit.session,
        sIdleOld.session,
        sIdleNew.session,
      ],
      maxRunners: 3,
      readCgroupMemory: async () => ({ currentBytes: 950, maxBytes: 1000, ratio: 0.95, version: 'v2' }),
    })

    const res = await runEvictionPass.call(host)
    assert.deepEqual(res.retiredKeys, [
      'agent:main:webchat:dm:idle1',
      'agent:main:webchat:dm:idle2',
    ])
    assert.equal(host.sessions.has('agent:main:webchat:dm:busy1'), true)
    assert.equal(host.sessions.has('agent:main:webchat:dm:busy2'), true)
    assert.equal(host.sessions.has('agent:main:webchat:dm:busy3'), true)
    assert.equal(sBusyActive.shutdownCalls(), 0)
    assert.equal(sBusyClient.shutdownCalls(), 0)
    assert.equal(sBusyAdmit.shutdownCalls(), 0)
    // Native resume preserved for retired sessions
    assert.equal(host._resumeMap.get('agent:main:webchat:dm:idle1'), 'native-idle1')
    assert.equal(host._resumeMap.get('agent:main:webchat:dm:idle2'), 'native-idle2')
  })

  it('acts as a safe no-op when cgroup memory is unreadable and resident count is within cap', async () => {
    const now = Date.now()
    const s1 = makeSession({ key: 'agent:main:webchat:dm:s1', peerId: 's1', lastUsedAt: now - 5_000 })
    const { host } = makeHost({
      sessions: [s1.session],
      maxRunners: 6,
      readCgroupMemory: async () => null,
    })
    const res = await runEvictionPass.call(host)
    assert.equal(res.idleEvicted, 0)
    assert.equal(res.pressureRetired, 0)
    assert.equal(host.sessions.has('agent:main:webchat:dm:s1'), true)
  })

  it('B5: never evicts sessions in preparing/unconsumed prepared model-switch transition, pending CCB callbacks, or pending agent groups', async () => {
    const now = Date.now()
    resetCcbLocalAgentCallbackDedupeForTest()
    try {
      const sPreparing = makeSession({ key: 'agent:main:webchat:dm:prep', peerId: 'prep', lastUsedAt: now - 90_000 })
      sPreparing.session._modelSwitchTransition = {
        id: 'sw-1',
        sourceModel: 'glm-5.3',
        targetModel: 'gpt-5.6-sol',
        sourceEngine: 'ccb',
        state: 'preparing',
      }
      const sPreparedFresh = makeSession({ key: 'agent:main:webchat:dm:handoff', peerId: 'handoff', lastUsedAt: now - 80_000 })
      sPreparedFresh.session._modelSwitchTransition = {
        id: 'sw-2',
        sourceModel: 'glm-5.3',
        targetModel: 'gpt-5.6-sol',
        sourceEngine: 'ccb',
        state: 'prepared',
        summaryText: 'handoff summary',
        expiresAt: now + 60_000,
      }
      const sPreparedExpired = makeSession({ key: 'agent:main:webchat:dm:expired', peerId: 'expired', lastUsedAt: now - 70_000 })
      sPreparedExpired.session._modelSwitchTransition = {
        id: 'sw-3',
        sourceModel: 'glm-5.3',
        targetModel: 'gpt-5.6-sol',
        sourceEngine: 'ccb',
        state: 'prepared',
        summaryText: 'stale summary',
        expiresAt: now - 1_000,
      }
      const sPendingCcb = makeSession({ key: 'agent:main:webchat:dm:ccb-parent', peerId: 'ccb-parent', lastUsedAt: now - 60_000 })
      noteCcbTaskNotification({
        sessionKey: sPendingCcb.session.sessionKey,
        notification: {
          taskId: 'task-1',
          status: 'completed',
          summary: 'done',
          outputFile: '/tmp/out.txt',
        },
        hasInFlightTurn: false,
      })
      const sPendingGroups = makeSession({ key: 'agent:main:webchat:dm:group-parent', peerId: 'group-parent', lastUsedAt: now - 50_000 })
      sPendingGroups.session._pendingAgentGroups = [{ runId: 'r1' } as any]

      const { host } = makeHost({
        sessions: [
          sPreparing.session,
          sPreparedFresh.session,
          sPreparedExpired.session,
          sPendingCcb.session,
          sPendingGroups.session,
        ],
        maxRunners: 1,
        readCgroupMemory: async () => ({ currentBytes: 950, maxBytes: 1000, ratio: 0.95, version: 'v2' }),
      })

      const res = await runEvictionPass.call(host)
      // ONLY the expired prepared session is eligible!
      assert.deepEqual(res.retiredKeys, ['agent:main:webchat:dm:expired'])
      assert.equal(host.sessions.has('agent:main:webchat:dm:prep'), true)
      assert.equal(host.sessions.has('agent:main:webchat:dm:handoff'), true)
      assert.equal(host.sessions.has('agent:main:webchat:dm:ccb-parent'), true)
      assert.equal(host.sessions.has('agent:main:webchat:dm:group-parent'), true)
      assert.equal(sPreparing.shutdownCalls(), 0)
      assert.equal(sPreparedFresh.shutdownCalls(), 0)
      assert.equal(sPendingCcb.shutdownCalls(), 0)
      assert.equal(sPendingGroups.shutdownCalls(), 0)
    } finally {
      resetCcbLocalAgentCallbackDedupeForTest()
    }
  })

  it('B5: retireKeepResume serializes with per-key admission gate and deletes only matching object identity', async () => {
    const now = Date.now()
    const key = 'agent:main:webchat:dm:race-1'
    let resolveShutdown!: () => void
    const shutdownStarted = new Promise<void>((resolve) => {
      // resolved when shutdown begins
      void resolve
    })
    void shutdownStarted
    const order: string[] = []
    const sOld = makeSession({ key, peerId: 'race-1', lastUsedAt: now - 50_000 })
    sOld.session.runner.shutdown = async () => {
      order.push('retire-shutdown-start')
      await new Promise<void>((r) => { resolveShutdown = r })
      order.push('retire-shutdown-end')
    }
    const sNew = makeSession({ key, peerId: 'race-1', lastUsedAt: now })

    const gates = new Map<string, Promise<void>>()
    const enterGate = async <T>(k: string, work: () => Promise<T>): Promise<T> => {
      const prev = gates.get(k) ?? Promise.resolve()
      let rel!: () => void
      const held = new Promise<void>((r) => { rel = r })
      const tail = prev.then(() => held, () => held)
      gates.set(k, tail)
      try {
        await prev
        return await work()
      } finally {
        rel()
        if (gates.get(k) === tail) gates.delete(k)
      }
    }

    const { host, destroyedEvents } = makeHost({
      sessions: [sOld.session],
      maxRunners: 6,
    })
    host._enterSessionCreateGate = enterGate
    host.retireKeepResume = async (k, opts) => retireKeepResume.call(host, k, opts)

    // Start retireKeepResume on sOld; while shutdown is pending, concurrent getOrCreate queues behind gate
    const retirePromise = host.retireKeepResume(key, { expectedSession: sOld.session, onlyIfIdle: true })
    await new Promise((r) => setTimeout(r, 5))
    const admitPromise = enterGate(key, async () => {
      order.push('admit-start')
      assert.equal(host.sessions.has(key), false, 'concurrent admission must not see half-retired session')
      host.sessions.set(key, sNew.session)
      host._sessionIdToKey.set('race-1', key)
      order.push('admit-end')
    })

    resolveShutdown()
    await Promise.all([retirePromise, admitPromise])

    assert.deepEqual(order, ['retire-shutdown-start', 'retire-shutdown-end', 'admit-start', 'admit-end'])
    assert.strictEqual(host.sessions.get(key), sNew.session, 'successor session must remain mounted')
    assert.equal(host._sessionIdToKey.get('race-1'), key)
    assert.deepEqual(destroyedEvents, [key])

    // Calling retireKeepResume again with stale expectedSession=sOld must be a complete no-op
    await host.retireKeepResume(key, { expectedSession: sOld.session, onlyIfIdle: true })
    assert.strictEqual(host.sessions.get(key), sNew.session, 'stale retire must NOT delete successor object')
    assert.equal(destroyedEvents.length, 1, 'stale retire must NOT fire onSessionDestroyed for successor')
  })
})
