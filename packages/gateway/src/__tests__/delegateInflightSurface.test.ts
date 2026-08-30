/**
 * OCV5-22 R2: session-level inflight surface.
 *
 * Covers: flag default off; slot survives parent-turn end; sqlite restart
 * readback; terminal fold into DurableAgentGroup; INC-20260827-PHASE-B-DEFER-VANISH
 * deferred stub must not wipe the live slot; GET wiring; flag-off leaves
 * turn_status dual-write path untouched.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/delegateInflightSurface.test.ts
 */
import assert from 'node:assert/strict'
import { chmodSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import { isDelegateTerminalState, type DurableAgentGroup } from '@openclaude/protocol'
import { DelegateJobStore } from '../delegateJobs.js'
import { DelegateDurableDb } from '../delegateDurable.js'
import {
  DelegateInflightSurfaceStore,
  boundFoldedGroup,
  handleInflightDelegatesRequest,
  isDeferredExactProcessStub,
  parentKeyMatchesSessionId,
  INFLIGHT_FOLDED_GROUP_MAX_BYTES,
  INFLIGHT_GET_MAX_RESPONSE_BYTES,
  INFLIGHT_SURFACE_BUSY_TIMEOUT_MS,
  SURFACE_SCHEMA_VERSION,
} from '../delegateInflightSurface.js'
import {
  isDelegateInflightSurfaceEffective,
  isDelegateInflightSurfaceEnabled,
} from '../delegateSmFlag.js'

const here = dirname(fileURLToPath(import.meta.url))
const serverSrc = readFileSync(join(here, '../server.ts'), 'utf8')
const PARENT = 'agent:main:webchat:dm:web-r2parent'
const SESS = 'web-r2parent'

function group(overrides: Partial<DurableAgentGroup> = {}): DurableAgentGroup {
  return {
    runId: 'dlg-run-1',
    agentId: 'coding-assistant',
    goal: '实现子任务',
    status: 'ok',
    resultSummary: 'done',
    transcript: [{ kind: 'text', text: '完整过程' }],
    completedAt: 1_700_000_000_000,
    ...overrides,
  }
}

async function withStore<T>(
  fn: (store: DelegateInflightSurfaceStore, dir: string) => Promise<T> | T,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'oc-r2-surface-'))
  const store = new DelegateInflightSurfaceStore({
    dbPath: join(dir, 'delegate-inflight-surface.db'),
    now: () => 1_000,
  })
  try {
    return await fn(store, dir)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
}

describe('OC_DELEGATE_INFLIGHT_SURFACE flag', () => {
  it('defaults off; lone flag enables; does not require SM/DURABLE', () => {
    assert.equal(isDelegateInflightSurfaceEnabled({}), false)
    assert.equal(isDelegateInflightSurfaceEffective({}), false)
    assert.equal(isDelegateInflightSurfaceEnabled({ OC_DELEGATE_INFLIGHT_SURFACE: '1' }), true)
    assert.equal(isDelegateInflightSurfaceEffective({ OC_DELEGATE_INFLIGHT_SURFACE: '1' }), true)
    assert.equal(
      isDelegateInflightSurfaceEffective({
        OC_DELEGATE_INFLIGHT_SURFACE: '1',
        OC_DELEGATE_SM: '0',
        OC_DELEGATE_DURABLE: '0',
      }),
      true,
    )
  })
})

describe('session-level inflight slot (turn-decoupled)', () => {
  it('survives a simulated parent turn end (drain of turn buffers is a no-op)', async () => {
    await withStore((store) => {
      store.upsertEnqueue({
        jobId: 'dlgjob-live-1',
        parentSessionKey: PARENT,
        agentId: 'coding-assistant',
        goal: '实现子任务',
        runId: 'dlg-run-1',
        state: 'running',
        liveHint: '子任务 编程助手: Read foo.ts',
      })
      // Parent turn_status / _pendingAgentGroups drain must not clear the slot.
      const afterTurn = store.listForParent(PARENT)
      assert.equal(afterTurn.length, 1)
      assert.equal(afterTurn[0].state, 'running')
      assert.equal(afterTurn[0].liveHint.includes('Read'), true)
      assert.equal(store.listForSessionId(SESS).items.length, 1)
    })
  })

  it('keeps parallel jobs on the same parent', async () => {
    await withStore((store) => {
      store.upsertEnqueue({
        jobId: 'dlgjob-a',
        parentSessionKey: PARENT,
        agentId: 'researcher',
        goal: 'a',
        state: 'running',
      })
      store.upsertEnqueue({
        jobId: 'dlgjob-b',
        parentSessionKey: PARENT,
        agentId: 'coding-assistant',
        goal: 'b',
        state: 'queued',
      })
      assert.equal(store.listForParent(PARENT).length, 2)
    })
  })
})

describe('durable restart readback', () => {
  it('reopens sqlite and still lists the live slot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-r2-restart-'))
    try {
      const s1 = new DelegateInflightSurfaceStore({
        dbPath: join(dir, 'delegate-inflight-surface.db'),
        now: () => 5,
      })
      s1.upsertEnqueue({
        jobId: 'dlgjob-restart',
        parentSessionKey: PARENT,
        agentId: 'coding-assistant',
        goal: '跨重启',
        runId: 'dlg-restart',
        state: 'running',
        liveHint: 'Bash ls',
      })
      s1.close()
      const s2 = new DelegateInflightSurfaceStore({
        dbPath: join(dir, 'delegate-inflight-surface.db'),
      })
      const items = s2.listForSessionId(SESS).items
      assert.equal(items.length, 1)
      assert.equal(items[0].jobId, 'dlgjob-restart')
      assert.equal(items[0].goal, '跨重启')
      assert.equal(items[0].runId, 'dlg-restart')
      assert.equal(items[0].liveHint, 'Bash ls')
      s2.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rebuildFromJobs overlays job state and drops ghosts when asked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-r2-rebuild-'))
    try {
      const jobsDb = new DelegateDurableDb(join(dir, 'delegate-jobs.db'))
      const jobs = new DelegateJobStore({
        sm: true,
        ttlMs: 60_000,
        durable: jobsDb,
        bootId: 'gw:r2',
      })
      const created = jobs.create('coding-assistant', {
        queued: true,
        parentSessionKey: PARENT,
        sessionKey: 'agent:coding-assistant:delegate:main:1',
      })
      assert.ok('jobId' in created)
      const surface = new DelegateInflightSurfaceStore({
        dbPath: join(dir, 'delegate-inflight-surface.db'),
      })
      surface.upsertEnqueue({
        jobId: created.jobId,
        parentSessionKey: PARENT,
        agentId: 'coding-assistant',
        goal: 'from-cache',
        state: 'queued',
      })
      surface.upsertEnqueue({
        jobId: 'dlgjob-ghost',
        parentSessionKey: PARENT,
        agentId: 'researcher',
        goal: 'ghost',
        state: 'running',
      })
      jobs.claimQueued(created.jobId)
      surface.rebuildFromJobs(jobs.listNonTerminal(), { dropMissingLive: true })
      const items = surface.listForParent(PARENT)
      assert.equal(items.length, 1)
      assert.equal(items[0].jobId, created.jobId)
      assert.equal(items[0].state, 'running')
      assert.equal(items[0].goal, 'from-cache')
      surface.close()
      jobs.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('terminal fold + INC-20260827-PHASE-B-DEFER-VANISH', () => {
  it('folds a real DurableAgentGroup and keeps the terminal visible (no 404)', async () => {
    await withStore((store) => {
      store.upsertEnqueue({
        jobId: 'dlgjob-fold',
        parentSessionKey: PARENT,
        agentId: 'coding-assistant',
        goal: '实现子任务',
        runId: 'dlg-run-1',
        state: 'running',
        liveHint: '还在跑',
      })
      const folded = store.foldTerminal({
        jobId: 'dlgjob-fold',
        group: group(),
        state: 'completed',
      })
      assert.equal(folded.folded, true)
      const items = store.listForSessionId(SESS).items
      assert.equal(items.length, 1)
      assert.equal(items[0].state, 'completed')
      assert.equal(items[0].liveHint, '')
      assert.equal(items[0].foldedGroup?.runId, 'dlg-run-1')
      assert.equal(items[0].foldedGroup?.status, 'ok')
      assert.equal(isDeferredExactProcessStub(items[0].foldedGroup), false)
      assert.ok(items[0].foldedGroup?.transcript)
    })
  })

  it('refuses to fold a _payloadDeferred stub and leaves the live slot', async () => {
    await withStore((store) => {
      store.upsertEnqueue({
        jobId: 'dlgjob-stub',
        parentSessionKey: PARENT,
        agentId: 'coding-assistant',
        goal: '实现子任务',
        runId: 'dlg-run-stub',
        state: 'running',
        liveHint: '子任务 编程助手: Write',
      })
      const stub = {
        ...group({ resultSummary: '', transcript: undefined }),
        _payloadDeferred: true,
      } as DurableAgentGroup & { _payloadDeferred: true }
      const result = store.foldTerminal({ jobId: 'dlgjob-stub', group: stub })
      assert.equal(result.folded, false)
      if (!result.folded) assert.equal(result.reason, 'deferred_stub')
      const items = store.listForSessionId(SESS).items
      assert.equal(items.length, 1, 'live slot must not vanish')
      assert.equal(items[0].state, 'running')
      assert.equal(items[0].liveHint.includes('Write'), true)
      assert.equal(items[0].foldedGroup, undefined)
    })
  })
})

describe('R2 gateway wiring (flag-off equivalent + read endpoint)', () => {
  it('GET /api/sessions/:id/inflight-delegates is a pathname.match literal', () => {
    assert.ok(
      serverSrc.includes('/inflight-delegates$'),
      'containerRouteInventory needs a pathname.match literal',
    )
    assert.ok(serverSrc.includes("isDelegateInflightSurfaceEffective()"))
    assert.ok(serverSrc.includes("'/api/sessions/:id/inflight-delegates'"))
    assert.match(serverSrc, /handleInflightDelegatesRequest/)
    assert.match(serverSrc, /getClientSession\(id, uid\)/)
    assert.doesNotMatch(serverSrc, /enabled: false/)
  })

  it('turn_status working-detail path remains outside the inflight flag (dual-write / flag-off)', () => {
    const idx = serverSrc.lastIndexOf('formatDelegateParentWorkingDetail({')
    assert.ok(idx > 0)
    const window = serverSrc.slice(idx, idx + 2200)
    assert.match(window, /_buildTurnStatusFrame/)
    assert.match(window, /status: 'working'/)
    const liveIdx = window.indexOf('if (liveDetail)')
    const touchIdx = window.indexOf('_touchDelegateInflightSurface')
    assert.ok(liveIdx >= 0 && touchIdx > liveIdx)
    const turnStatusBlock = window.slice(liveIdx, touchIdx)
    assert.doesNotMatch(turnStatusBlock, /isDelegateInflightSurfaceEffective/)
  })

  it('wires the inflight store without gating the existing turn_status emit', () => {
    const inflightUses = [
      ...serverSrc.matchAll(
        /_touchDelegateInflightSurface|_ensureDelegateInflightSurface|_delegateInflightSurface/g,
      ),
    ]
    assert.ok(inflightUses.length >= 4)
    assert.match(serverSrc, /foldTerminal/)
    assert.match(serverSrc, /onDrop:/)
    assert.match(serverSrc, /_forgetDelegateInflight|_dropDelegateInflightSurface/)
    assert.match(
      serverSrc,
      /snap && isDelegateTerminalState\(snap\.state\) \? snap\.state : 'completed'/,
    )
  })

  it('parentKeyMatchesSessionId accepts webchat peer ids', () => {
    assert.equal(parentKeyMatchesSessionId(PARENT, SESS), true)
    assert.equal(parentKeyMatchesSessionId(PARENT, 'other'), false)
    assert.equal(parentKeyMatchesSessionId(SESS, SESS), true)
  })
})

describe('blocker 1 — tenant isolation on GET handler', () => {
  it('refuses user A reading user B session content (404, not 200 with items)', async () => {
    await withStore(async (store) => {
      store.upsertEnqueue({
        jobId: 'dlgjob-secret',
        parentSessionKey: 'agent:main:webchat:dm:web-victima',
        agentId: 'coding-assistant',
        goal: 'SECRET-GOAL-DO-NOT-LEAK',
        runId: 'dlg-secret',
        state: 'running',
        liveHint: 'secret-hint',
        userId: 'user-b',
      })
      const loadSession = async (id: string, uid: string) =>
        uid === 'user-b' && id === 'web-victima' ? { userId: 'user-b', id } : null
      const asA = await handleInflightDelegatesRequest({
        method: 'GET',
        sessionId: 'web-victima',
        userId: 'user-a',
        enabled: true,
        loadSession,
        store,
      })
      assert.equal(asA.status, 404)
      assert.deepEqual(asA.body, { error: 'not found' })
      assert.equal(JSON.stringify(asA.body).includes('SECRET'), false)
      const missing = await handleInflightDelegatesRequest({
        method: 'GET',
        sessionId: 'web-nosuch',
        userId: 'user-b',
        enabled: true,
        loadSession,
        store,
      })
      assert.equal(missing.status, 404)
      const asB = await handleInflightDelegatesRequest({
        method: 'GET',
        sessionId: 'web-victima',
        userId: 'user-b',
        enabled: true,
        loadSession,
        store,
      })
      assert.equal(asB.status, 200)
      const items = (asB.body.items as Array<{ goal: string; userId?: string }>) ?? []
      assert.equal(items.length, 1)
      assert.equal(items[0].goal, 'SECRET-GOAL-DO-NOT-LEAK')
      assert.equal(items[0].userId, undefined)
      const leaked = store.listForSessionId('web-victima', { userId: 'user-a' }).items
      assert.equal(leaked.length, 0)
    })
  })
})

describe('blocker 2 — fence / monotonic CAS', () => {
  it('cross-gateway late live write cannot resurrect a folded terminal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-r2-fence-'))
    const dbPath = join(dir, 'delegate-inflight-surface.db')
    try {
      let now = 10
      const g0 = new DelegateInflightSurfaceStore({ dbPath, now: () => now })
      g0.upsertEnqueue({
        jobId: 'dlgjob-race',
        parentSessionKey: 'agent:main:webchat:dm:web-racea',
        agentId: 'worker',
        goal: 'g',
        runId: 'dlg-race',
        state: 'running',
        liveHint: 'live',
        userId: 'user-race',
      })
      now = 11
      const g1 = new DelegateInflightSurfaceStore({ dbPath, now: () => now })
      const folded = g1.foldTerminal({
        jobId: 'dlgjob-race',
        group: group({ runId: 'dlg-race', status: 'ok' }),
        state: 'completed',
      })
      assert.equal(folded.folded, true)
      const late = g0.updateLive({
        jobId: 'dlgjob-race',
        state: 'running',
        liveHint: 'late-old-writer',
      })
      assert.equal(late?.state, 'completed')
      assert.equal(late?.liveHint, '')
      assert.equal(g1.get('dlgjob-race')?.state, 'completed')
      g1.close()
      g0.close()
      now = 12
      const g2 = new DelegateInflightSurfaceStore({ dbPath, now: () => now })
      g2.rebuildFromJobs([], { dropMissingLive: true })
      const afterBoot = g2.get('dlgjob-race')
      assert.equal(afterBoot?.state, 'completed')
      assert.equal(afterBoot?.foldedGroup?.status, 'ok')
      g2.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('maps complete(http 200, ok:false) to surface completed, not failed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-r2-state-'))
    try {
      const jobsDb = new DelegateDurableDb(join(dir, 'delegate-jobs.db'))
      const jobs = new DelegateJobStore({
        sm: true,
        ttlMs: 60_000,
        durable: jobsDb,
        bootId: 'gw:r2-state',
      })
      const created = jobs.create('coding-assistant', {
        queued: true,
        parentSessionKey: PARENT,
        sessionKey: 'agent:coding-assistant:delegate:main:state',
      })
      assert.ok('jobId' in created)
      jobs.claimQueued(created.jobId)
      const claimed = jobs.snapshotOf(created.jobId)
      assert.ok(claimed)
      const winner = jobs.complete(
        created.jobId,
        { httpStatus: 200, body: { ok: false, output: '', error: 'child exploded' } },
        { claimToken: claimed.claimToken!, fencingEpoch: claimed.fencingEpoch },
      )
      assert.equal(winner, true)
      assert.equal(jobs.snapshotOf(created.jobId)?.state, 'completed')
      const surface = new DelegateInflightSurfaceStore({
        dbPath: join(dir, 'delegate-inflight-surface.db'),
      })
      surface.upsertEnqueue({
        jobId: created.jobId,
        parentSessionKey: PARENT,
        agentId: 'coding-assistant',
        goal: 'g',
        state: 'running',
      })
      surface.foldTerminal({
        jobId: created.jobId,
        group: group({ status: 'failed', resultSummary: 'child exploded' }),
        state: 'completed',
      })
      assert.equal(surface.get(created.jobId)?.state, 'completed')
      assert.equal(surface.get(created.jobId)?.foldedGroup?.status, 'failed')
      surface.projectJob(jobs.snapshotOf(created.jobId)!)
      assert.equal(surface.get(created.jobId)?.state, 'completed')
      assert.equal(surface.get(created.jobId)?.foldedGroup?.status, 'failed')
      surface.close()
      jobs.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rebuildFromJobs folds a live slot whose job is already terminal (no fake running / no 404)', async () => {
    await withStore((store) => {
      store.upsertEnqueue({
        jobId: 'dlgjob-early-exit',
        parentSessionKey: PARENT,
        agentId: 'coding-assistant',
        goal: 'queued then failed',
        state: 'queued',
        userId: 'user-r2',
      })
      store.rebuildFromJobs([], {
        resolveJob: () => ({
          id: 'dlgjob-early-exit',
          agentId: 'coding-assistant',
          state: 'failed',
          parentSessionKey: PARENT,
          fencingEpoch: 1,
          generation: 2,
          attemptNo: 1,
          checkpointKind: 'none',
          callback: 'none',
          callbackState: 'none',
          callbackEpoch: 0,
          kind: 'delegate',
          failureClass: 'depth_exceeded',
          failureDetail: 'too deep',
        }),
      })
      const row = store.get('dlgjob-early-exit')
      assert.equal(row?.state, 'failed')
      assert.equal(row?.foldedGroup?.status, 'failed')
      assert.equal(store.listForSessionId(SESS).items.length, 1)
    })
  })
})

describe('blocker 3 — projection I/O is fail-open', () => {
  it('readonly /dev/full writes do not throw and do not block enqueue', () => {
    const errors: unknown[] = []
    const store = new DelegateInflightSurfaceStore({
      dbPath: '/dev/full',
      onWriteError: (err) => errors.push(err),
    })
    assert.doesNotThrow(() => {
      store.upsertEnqueue({
        jobId: 'dlgjob-io',
        parentSessionKey: PARENT,
        agentId: 'coding-assistant',
        goal: 'must-not-throw',
        state: 'queued',
      })
    })
    assert.equal(store.get('dlgjob-io')?.goal, 'must-not-throw')
    store.close()
  })

  it('chmod 444 after first write does not throw on foldTerminal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-r2-ro-'))
    const dbPath = join(dir, 'delegate-inflight-surface.db')
    try {
      const store = new DelegateInflightSurfaceStore({ dbPath })
      store.upsertEnqueue({
        jobId: 'dlgjob-ro',
        parentSessionKey: PARENT,
        agentId: 'coding-assistant',
        goal: 'g',
        state: 'running',
      })
      chmodSync(dbPath, 0o444)
      try {
        chmodSync(`${dbPath}-wal`, 0o444)
      } catch {
        /* no wal */
      }
      try {
        chmodSync(`${dbPath}-shm`, 0o444)
      } catch {
        /* no shm */
      }
      assert.doesNotThrow(() => {
        store.foldTerminal({
          jobId: 'dlgjob-ro',
          group: group(),
          state: 'completed',
        })
      })
      assert.equal(store.get('dlgjob-ro')?.state, 'completed')
      store.close()
    } finally {
      try {
        chmodSync(dbPath, 0o644)
      } catch {
        /* already writable */
      }
      try {
        chmodSync(`${dbPath}-wal`, 0o644)
      } catch {
        /* no wal */
      }
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('blocker 4 — flag-off path equals baseline 404', () => {
  it('returns 404 {error:not found} when the inflight flag is off', async () => {
    const result = await handleInflightDelegatesRequest({
      method: 'GET',
      sessionId: 'web-1234',
      userId: 'user-a',
      enabled: false,
      loadSession: async () => {
        throw new Error('flag-off must not load sessions')
      },
    })
    assert.equal(result.status, 404)
    assert.deepEqual(result.body, { error: 'not found' })
    const post = await handleInflightDelegatesRequest({
      method: 'POST',
      sessionId: 'web-1234',
      userId: 'user-a',
      enabled: false,
      loadSession: async () => ({ id: 'web-1234' }),
    })
    assert.equal(post.status, 404)
  })
})

describe('blocker 5 — bounded payload, pagination, TTL', () => {
  it('does not persist or return multi-megabyte transcripts', async () => {
    await withStore((store) => {
      const blob = 'x'.repeat(2 * 1024 * 1024)
      for (const id of ['dlgjob-p1', 'dlgjob-p2', 'dlgjob-p3']) {
        store.upsertEnqueue({
          jobId: id,
          parentSessionKey: PARENT,
          agentId: 'coding-assistant',
          goal: id,
          state: 'running',
          userId: 'user-r2',
        })
        const folded = store.foldTerminal({
          jobId: id,
          group: group({
            runId: id,
            transcript: [{ kind: 'text', text: blob }],
            runtimeEvents: [{ ordinal: 1, observedAt: 1, source: 'gateway', payload: blob }],
          }),
          state: 'completed',
        })
        assert.equal(folded.folded, true)
        if (folded.folded) {
          assert.equal(folded.surface.truncated, true)
          assert.equal(folded.surface.foldedGroup?.transcript, undefined)
          const encoded = JSON.stringify(folded.surface)
          assert.ok(Buffer.byteLength(encoded, 'utf8') < INFLIGHT_FOLDED_GROUP_MAX_BYTES * 2)
        }
      }
      const page = store.listForSessionId(SESS, { userId: 'user-r2' })
      const encoded = JSON.stringify({ enabled: true, items: page.items })
      assert.ok(Buffer.byteLength(encoded, 'utf8') < INFLIGHT_GET_MAX_RESPONSE_BYTES)
      assert.ok(page.items.length >= 1)
      for (const item of page.items) {
        assert.equal(item.foldedGroup?.transcript, undefined)
      }
    })
  })

  it('paginates GET and respects a byte budget', async () => {
    await withStore(async (store) => {
      for (let i = 0; i < 5; i++) {
        store.upsertEnqueue({
          jobId: `dlgjob-page-${i}`,
          parentSessionKey: PARENT,
          agentId: 'coding-assistant',
          goal: `g${i}`,
          state: 'running',
          userId: 'user-r2',
        })
      }
      const loadSession = async () => ({ userId: 'user-r2', id: SESS })
      const first = await handleInflightDelegatesRequest({
        method: 'GET',
        sessionId: SESS,
        userId: 'user-r2',
        enabled: true,
        searchParams: new URLSearchParams('limit=2'),
        loadSession,
        store,
      })
      assert.equal(first.status, 200)
      const items1 = first.body.items as Array<{ jobId: string }>
      assert.equal(items1.length, 2)
      assert.equal(typeof first.body.nextCursor, 'string')
      const second = await handleInflightDelegatesRequest({
        method: 'GET',
        sessionId: SESS,
        userId: 'user-r2',
        enabled: true,
        searchParams: new URLSearchParams(`limit=2&cursor=${String(first.body.nextCursor)}`),
        loadSession,
        store,
      })
      const items2 = second.body.items as Array<{ jobId: string }>
      assert.equal(items2.length, 2)
      assert.notEqual(items2[0].jobId, items1[0].jobId)
    })
  })

  it('sweeps expired terminal rows (TTL, not immediate 404)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-r2-ttl-'))
    let now = 1_000
    try {
      const store = new DelegateInflightSurfaceStore({
        dbPath: join(dir, 'delegate-inflight-surface.db'),
        now: () => now,
        terminalTtlMs: 50,
      })
      store.upsertEnqueue({
        jobId: 'dlgjob-ttl',
        parentSessionKey: PARENT,
        agentId: 'coding-assistant',
        goal: 'g',
        state: 'running',
      })
      store.foldTerminal({ jobId: 'dlgjob-ttl', group: group(), state: 'completed' })
      assert.equal(store.listForSessionId(SESS).items.length, 1)
      now = 1_049
      assert.equal(store.listForSessionId(SESS).items.length, 1)
      now = 1_051
      assert.equal(store.listForSessionId(SESS).items.length, 0)
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('warning 1 — production fold sequence vs deferred stub', () => {
  it('folds the local DurableAgentGroup then ignores a later _payloadDeferred stub', async () => {
    await withStore((store) => {
      store.upsertEnqueue({
        jobId: 'dlgjob-seq',
        parentSessionKey: PARENT,
        agentId: 'coding-assistant',
        goal: '实现子任务',
        runId: 'dlg-run-seq',
        state: 'running',
        liveHint: 'Write',
      })
      const durableGroup = group({
        runId: 'dlg-run-seq',
        transcript: [{ kind: 'text', text: '完整过程' }],
      })
      // Production order: construct group → bufferPendingAgentGroup → foldTerminal.
      const buffered: DurableAgentGroup[] = [durableGroup]
      const folded = store.foldTerminal({
        jobId: 'dlgjob-seq',
        group: buffered[0],
        state: 'completed',
      })
      assert.equal(folded.folded, true)
      const stub = {
        ...durableGroup,
        resultSummary: '',
        transcript: undefined,
        _payloadDeferred: true,
      } as DurableAgentGroup & { _payloadDeferred: true }
      const later = store.foldTerminal({ jobId: 'dlgjob-seq', group: stub })
      assert.equal(later.folded, false)
      if (!later.folded) assert.equal(later.reason, 'deferred_stub')
      const row = store.get('dlgjob-seq')
      assert.equal(row?.state, 'completed')
      assert.equal(row?.foldedGroup?.transcript?.length, 1)
      assert.equal(isDeferredExactProcessStub(row?.foldedGroup), false)
    })
  })
})

describe('warning 2 — nested identity is not overwritten', () => {
  it('nested liveHint updates keep the first-level agentId/goal', async () => {
    await withStore((store) => {
      store.upsertEnqueue({
        jobId: 'dlgjob-parent',
        parentSessionKey: PARENT,
        agentId: 'coding-assistant',
        goal: 'parent-goal',
        runId: 'dlg-parent',
        state: 'running',
        userId: 'user-r2',
      })
      store.updateLive({
        jobId: 'dlgjob-parent',
        liveHint: '子任务 科研助手: Read',
        agentId: 'research-assistant',
        goal: 'child-goal',
        preserveIdentity: true,
      })
      const parent = store.get('dlgjob-parent')
      assert.equal(parent?.agentId, 'coding-assistant')
      assert.equal(parent?.goal, 'parent-goal')
      assert.equal(parent?.liveHint.includes('Read'), true)
      store.upsertEnqueue({
        jobId: 'dlgjob-child',
        parentSessionKey: PARENT,
        agentId: 'research-assistant',
        goal: 'child-goal',
        runId: 'dlg-child',
        state: 'running',
        nested: true,
        ownerRunId: 'dlg-parent',
        userId: 'user-r2',
      })
      const items = store.listForSessionId(SESS, { userId: 'user-r2' }).items
      assert.equal(items.length, 2)
      const child = items.find((row) => row.jobId === 'dlgjob-child')
      assert.equal(child?.nested, true)
      assert.equal(child?.ownerRunId, 'dlg-parent')
    })
  })
})

describe('boundFoldedGroup helper', () => {
  it('caps serialized bytes and never sets _payloadDeferred', () => {
    const huge = group({
      transcript: [{ kind: 'text', text: 'y'.repeat(80_000) }],
    })
    const bounded = boundFoldedGroup(huge, INFLIGHT_FOLDED_GROUP_MAX_BYTES)
    assert.equal(bounded.truncated, true)
    assert.ok(bounded.bytes <= INFLIGHT_FOLDED_GROUP_MAX_BYTES)
    assert.equal(
      (bounded.group as { _payloadDeferred?: unknown })._payloadDeferred,
      undefined,
    )
  })
})

describe('closeout residual — queue-full drop must tombstone the slot', () => {
  it('GET does not keep a queued ghost after dropIfUnclaimed + surface.drop', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-r2-drop-'))
    try {
      const jobsDb = new DelegateDurableDb(join(dir, 'delegate-jobs.db'))
      const surface = new DelegateInflightSurfaceStore({
        dbPath: join(dir, 'delegate-inflight-surface.db'),
      })
      const jobs = new DelegateJobStore({
        sm: true,
        ttlMs: 60_000,
        durable: jobsDb,
        bootId: 'gw:r2-drop',
        onDrop: (job) => surface.drop(job.id),
      })
      const created = jobs.create('coding-assistant', {
        queued: true,
        parentSessionKey: PARENT,
        sessionKey: 'agent:coding-assistant:delegate:main:drop',
      })
      assert.ok('jobId' in created)
      surface.upsertEnqueue({
        jobId: created.jobId,
        parentSessionKey: PARENT,
        agentId: 'coding-assistant',
        goal: 'ghost-queued',
        state: 'queued',
        userId: 'user-r2',
      })
      assert.equal(jobs.dropIfUnclaimed(created.jobId), true)
      assert.equal(jobs.snapshotOf(created.jobId), undefined)
      const afterDrop = await handleInflightDelegatesRequest({
        method: 'GET',
        sessionId: SESS,
        userId: 'user-r2',
        enabled: true,
        loadSession: async () => ({ id: SESS, userId: 'user-r2' }),
        store: surface,
        overlayJobs: () => jobs.listNonTerminal(),
        resolveJob: (jobId) => jobs.snapshotOf(jobId),
        dropMissingLive: false,
      })
      assert.equal(((afterDrop.body.items as unknown[]) ?? []).length, 0)
      assert.equal(surface.get(created.jobId), undefined)
      surface.upsertEnqueue({
        jobId: created.jobId,
        parentSessionKey: PARENT,
        agentId: 'coding-assistant',
        goal: 'must-not-resurrect',
        state: 'queued',
        userId: 'user-r2',
      })
      assert.equal(surface.get(created.jobId), undefined)
      surface.close()
      const afterBoot = new DelegateInflightSurfaceStore({
        dbPath: join(dir, 'delegate-inflight-surface.db'),
      })
      afterBoot.rebuildFromJobs([], { dropMissingLive: true })
      assert.equal(afterBoot.get(created.jobId), undefined)
      afterBoot.close()
      jobs.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('GET overlay with dropMissingLive heals a queue-full ghost even without drop()', async () => {
    await withStore(async (store) => {
      store.upsertEnqueue({
        jobId: 'dlgjob-ghost-q',
        parentSessionKey: PARENT,
        agentId: 'coding-assistant',
        goal: 'still-queued',
        state: 'queued',
        userId: 'user-r2',
      })
      const page = await handleInflightDelegatesRequest({
        method: 'GET',
        sessionId: SESS,
        userId: 'user-r2',
        enabled: true,
        loadSession: async () => ({ id: SESS, userId: 'user-r2' }),
        store,
        overlayJobs: () => [],
        dropMissingLive: true,
      })
      assert.equal(((page.body.items as unknown[]) ?? []).length, 0)
      assert.equal(store.get('dlgjob-ghost-q'), undefined)
    })
  })

  it('GET overlay keeps a running sync slot that has no job row', async () => {
    await withStore((store) => {
      store.upsertEnqueue({
        jobId: 'dlgjob-sync-live',
        parentSessionKey: PARENT,
        agentId: 'coding-assistant',
        goal: 'sync',
        state: 'running',
        userId: 'user-r2',
      })
      store.rebuildFromJobs([], { resolveJob: () => undefined })
      assert.equal(store.get('dlgjob-sync-live')?.state, 'running')
    })
  })
})

describe('closeout residual — terminal→terminal is sticky', () => {
  it('late completed fold cannot overwrite authoritative killed_by_cutover', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-r2-term-race-'))
    const dbPath = join(dir, 'delegate-inflight-surface.db')
    try {
      const g0 = new DelegateInflightSurfaceStore({ dbPath, now: () => 10 })
      g0.upsertEnqueue({
        jobId: 'dlgjob-cutover',
        parentSessionKey: PARENT,
        agentId: 'coding-assistant',
        goal: 'g',
        runId: 'dlg-cutover',
        state: 'running',
        userId: 'user-r2',
        fencingEpoch: 2,
        generation: 2,
      })
      const g1 = new DelegateInflightSurfaceStore({ dbPath, now: () => 11 })
      const authoritative = g1.foldTerminal({
        jobId: 'dlgjob-cutover',
        group: group({ runId: 'dlg-cutover', status: 'failed', resultSummary: 'cutover' }),
        state: 'killed_by_cutover',
        fencingEpoch: 2,
        generation: 3,
      })
      assert.equal(authoritative.folded, true)
      if (authoritative.folded) {
        assert.equal(authoritative.surface.state, 'killed_by_cutover')
      }
      const late = g0.foldTerminal({
        jobId: 'dlgjob-cutover',
        group: group({ runId: 'dlg-cutover', status: 'ok', resultSummary: 'late-ok' }),
        state: 'completed',
        fencingEpoch: 2,
        generation: 3,
      })
      assert.equal(late.folded, true)
      if (late.folded) {
        assert.equal(late.surface.state, 'killed_by_cutover')
        assert.notEqual(late.surface.foldedGroup?.status, 'ok')
      }
      g0.close()
      g1.close()
      const g2 = new DelegateInflightSurfaceStore({ dbPath, now: () => 12 })
      const persisted = g2.get('dlgjob-cutover')
      assert.equal(persisted?.state, 'killed_by_cutover')
      assert.notEqual(persisted?.foldedGroup?.status, 'ok')
      g2.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('authoritative job-store killed_by_cutover overwrites a runner-folded completed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-r2-auth-term-'))
    const surfaceDb = join(dir, 'delegate-inflight-surface.db')
    try {
      const jobsDb = new DelegateDurableDb(join(dir, 'delegate-jobs.db'))
      const surface = new DelegateInflightSurfaceStore({ dbPath: surfaceDb, now: () => 20 })
      const jobs = new DelegateJobStore({
        sm: true,
        ttlMs: 60_000,
        durable: jobsDb,
        bootId: 'gw:r2-auth',
        onTerminal: (job) => surface.projectJob(job),
      })
      const created = jobs.create('coding-assistant', {
        queued: true,
        parentSessionKey: PARENT,
        sessionKey: 'agent:coding-assistant:delegate:main:auth-term',
      })
      assert.ok('jobId' in created)
      surface.upsertEnqueue({
        jobId: created.jobId,
        parentSessionKey: PARENT,
        agentId: 'coding-assistant',
        goal: 'g',
        runId: 'dlg-auth-term',
        state: 'queued',
        userId: 'user-r2',
      })
      const claimed = jobs.claimQueued(created.jobId)
      assert.equal(claimed.ok, true)
      if (!claimed.ok) throw new Error('claim failed')
      const running = jobs.snapshotOf(created.jobId)!
      surface.updateLive({
        jobId: created.jobId,
        state: 'running',
        fencingEpoch: running.fencingEpoch,
        generation: running.generation,
      })
      // Production _runDelegateTask: fold completed from a running snapshot
      // before store.complete / cutover CAS.
      const runnerFold = surface.foldTerminal({
        jobId: created.jobId,
        group: group({
          runId: 'dlg-auth-term',
          status: 'ok',
          resultSummary: 'runner-finished',
        }),
        state: 'completed',
        fencingEpoch: running.fencingEpoch,
        generation: running.generation,
      })
      assert.equal(runnerFold.folded, true)
      if (runnerFold.folded) assert.equal(runnerFold.surface.state, 'completed')
      const paused = jobs.pauseForCutover(created.jobId, {
        claimToken: claimed.claimToken,
        fencingEpoch: claimed.fencingEpoch,
        generation: running.generation + 1,
        checkpointKind: 'none',
      })
      assert.ok(paused)
      const killed = jobs.killOwnedPaused(created.jobId)
      assert.equal(killed?.state, 'killed_by_cutover')
      assert.equal(jobs.snapshotOf(created.jobId)?.state, 'killed_by_cutover')
      const after = surface.get(created.jobId)
      assert.equal(after?.state, 'killed_by_cutover')
      assert.notEqual(after?.foldedGroup?.status, 'ok')
      assert.notEqual(after?.foldedGroup?.resultSummary, 'runner-finished')
      surface.close()
      const reopened = new DelegateInflightSurfaceStore({ dbPath: surfaceDb, now: () => 21 })
      const persisted = reopened.get(created.jobId)
      assert.equal(persisted?.state, 'killed_by_cutover')
      assert.notEqual(persisted?.foldedGroup?.status, 'ok')
      reopened.close()
      jobs.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('cutover-first then production same-state runner fold cannot replace authoritative payload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-r2-auth-payload-'))
    const surfaceDb = join(dir, 'delegate-inflight-surface.db')
    try {
      const jobsDb = new DelegateDurableDb(join(dir, 'delegate-jobs.db'))
      const surface = new DelegateInflightSurfaceStore({ dbPath: surfaceDb, now: () => 40 })
      const stale = new DelegateInflightSurfaceStore({ dbPath: surfaceDb, now: () => 40 })
      const jobs = new DelegateJobStore({
        sm: true,
        ttlMs: 60_000,
        durable: jobsDb,
        bootId: 'gw:r2-auth-payload',
        onTerminal: (job) => surface.projectJob(job),
      })
      const created = jobs.create('coding-assistant', {
        queued: true,
        parentSessionKey: PARENT,
        sessionKey: 'agent:coding-assistant:delegate:main:auth-payload',
      })
      assert.ok('jobId' in created)
      surface.upsertEnqueue({
        jobId: created.jobId,
        parentSessionKey: PARENT,
        agentId: 'coding-assistant',
        goal: 'g',
        runId: 'dlg-auth-payload',
        state: 'queued',
        userId: 'user-r2',
      })
      stale.upsertEnqueue({
        jobId: created.jobId,
        parentSessionKey: PARENT,
        agentId: 'coding-assistant',
        goal: 'g',
        runId: 'dlg-auth-payload',
        state: 'queued',
        userId: 'user-r2',
      })
      const claimed = jobs.claimQueued(created.jobId)
      assert.equal(claimed.ok, true)
      if (!claimed.ok) throw new Error('claim failed')
      const running = jobs.snapshotOf(created.jobId)!
      surface.updateLive({
        jobId: created.jobId,
        state: 'running',
        fencingEpoch: running.fencingEpoch,
        generation: running.generation,
      })
      stale.updateLive({
        jobId: created.jobId,
        state: 'running',
        fencingEpoch: running.fencingEpoch,
        generation: running.generation,
      })
      const paused = jobs.pauseForCutover(created.jobId, {
        claimToken: claimed.claimToken,
        fencingEpoch: claimed.fencingEpoch,
        generation: running.generation + 1,
        checkpointKind: 'none',
      })
      assert.ok(paused)
      const killed = jobs.killOwnedPaused(created.jobId)
      assert.equal(killed?.state, 'killed_by_cutover')
      const afterCutover = surface.get(created.jobId)
      assert.equal(afterCutover?.state, 'killed_by_cutover')
      assert.equal(afterCutover?.foldedGroup?.status, 'failed')

      // Production _runDelegateTask mapping (server.ts): snapshotOf().state
      // when the job is already terminal, plus the late runner's success group.
      const snap = jobs.snapshotOf(created.jobId)
      const foldState =
        snap && isDelegateTerminalState(snap.state) ? snap.state : 'completed'
      const fence = snap
        ? { fencingEpoch: snap.fencingEpoch, generation: snap.generation }
        : {}
      const late = surface.foldTerminal({
        jobId: created.jobId,
        group: group({
          runId: 'dlg-auth-payload',
          status: 'ok',
          resultSummary: 'runner-finished-after-kill',
        }),
        state: foldState,
        ...fence,
      })
      assert.equal(late.folded, true)
      if (late.folded) {
        assert.equal(late.surface.state, 'killed_by_cutover')
        assert.equal(late.surface.foldedGroup?.status, 'failed')
        assert.notEqual(late.surface.foldedGroup?.resultSummary, 'runner-finished-after-kill')
      }

      // Stale in-memory running + same production mapping must lose at SQL too.
      const staleFold = stale.foldTerminal({
        jobId: created.jobId,
        group: group({
          runId: 'dlg-auth-payload',
          status: 'ok',
          resultSummary: 'runner-finished-after-kill',
        }),
        state: foldState,
        ...fence,
      })
      assert.equal(staleFold.folded, true)
      if (staleFold.folded) {
        assert.equal(staleFold.surface.state, 'killed_by_cutover')
        assert.equal(staleFold.surface.foldedGroup?.status, 'failed')
        assert.notEqual(staleFold.surface.foldedGroup?.resultSummary, 'runner-finished-after-kill')
      }

      surface.close()
      stale.close()
      const reopened = new DelegateInflightSurfaceStore({ dbPath: surfaceDb, now: () => 41 })
      const persisted = reopened.get(created.jobId)
      assert.equal(persisted?.state, 'killed_by_cutover')
      assert.equal(persisted?.foldedGroup?.status, 'failed')
      assert.notEqual(persisted?.foldedGroup?.resultSummary, 'runner-finished-after-kill')
      reopened.close()
      jobs.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('closeout residual — durable tombstone survives cross-gateway overlay', () => {
  it('stale queued overlay cannot resurrect a dropped job after durable tombstone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-r2-tombstone-'))
    const surfaceDb = join(dir, 'delegate-inflight-surface.db')
    try {
      const jobsDb = new DelegateDurableDb(join(dir, 'delegate-jobs.db'))
      const g0 = new DelegateInflightSurfaceStore({ dbPath: surfaceDb, now: () => 30 })
      const jobs = new DelegateJobStore({
        sm: true,
        ttlMs: 60_000,
        durable: jobsDb,
        bootId: 'gw:r2-tomb-0',
      })
      const created = jobs.create('coding-assistant', {
        queued: true,
        parentSessionKey: PARENT,
        sessionKey: 'agent:coding-assistant:delegate:main:tomb',
      })
      assert.ok('jobId' in created)
      g0.upsertEnqueue({
        jobId: created.jobId,
        parentSessionKey: PARENT,
        agentId: 'coding-assistant',
        goal: 'ghost-queued',
        state: 'queued',
        userId: 'user-r2',
        fencingEpoch: jobs.snapshotOf(created.jobId)!.fencingEpoch,
        generation: jobs.snapshotOf(created.jobId)!.generation,
      })
      const staleOverlay = [structuredClone(jobs.snapshotOf(created.jobId)!)]
      assert.equal(staleOverlay[0].state, 'queued')

      const g1 = new DelegateInflightSurfaceStore({ dbPath: surfaceDb, now: () => 31 })
      assert.equal(jobs.dropIfUnclaimed(created.jobId), true)
      assert.equal(jobs.snapshotOf(created.jobId), undefined)
      assert.equal(g1.drop(created.jobId), true)

      const page = await handleInflightDelegatesRequest({
        method: 'GET',
        sessionId: SESS,
        userId: 'user-r2',
        enabled: true,
        loadSession: async () => ({ id: SESS, userId: 'user-r2' }),
        store: g0,
        overlayJobs: () => staleOverlay,
        resolveJob: () => undefined,
        dropMissingLive: false,
      })
      assert.equal(page.status, 200)
      const states = ((page.body.items as Array<{ state: string }>) ?? []).map((row) => row.state)
      assert.deepEqual(states, [])
      assert.equal(g0.get(created.jobId), undefined)
      g0.upsertEnqueue({
        jobId: created.jobId,
        parentSessionKey: PARENT,
        agentId: 'coding-assistant',
        goal: 'must-not-resurrect',
        state: 'queued',
        userId: 'user-r2',
      })
      assert.equal(g0.get(created.jobId), undefined)

      g0.close()
      g1.close()
      const g2 = new DelegateInflightSurfaceStore({ dbPath: surfaceDb, now: () => 32 })
      g2.rebuildFromJobs(staleOverlay, { dropMissingLive: false })
      assert.equal(g2.get(created.jobId), undefined)
      g2.upsertEnqueue({
        jobId: created.jobId,
        parentSessionKey: PARENT,
        agentId: 'coding-assistant',
        goal: 'must-not-resurrect-after-boot',
        state: 'queued',
        userId: 'user-r2',
      })
      assert.equal(g2.get(created.jobId), undefined)
      const raw = new Database(surfaceDb)
      const tomb = raw
        .prepare('SELECT tombstoned FROM inflight_delegate_surface WHERE job_id = ?')
        .get(created.jobId) as { tombstoned: number } | undefined
      assert.equal(tomb?.tombstoned, 1)
      raw.close()
      g2.close()
      jobs.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('durable tombstone wins even when the stale overlay fence would lose', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-r2-tomb-fence-'))
    const surfaceDb = join(dir, 'delegate-inflight-surface.db')
    try {
      const jobsDb = new DelegateDurableDb(join(dir, 'delegate-jobs.db'))
      const g0 = new DelegateInflightSurfaceStore({ dbPath: surfaceDb, now: () => 40 })
      const jobs = new DelegateJobStore({
        sm: true,
        ttlMs: 60_000,
        durable: jobsDb,
        bootId: 'gw:r2-tomb-fence',
      })
      const created = jobs.create('coding-assistant', {
        queued: true,
        parentSessionKey: PARENT,
        sessionKey: 'agent:coding-assistant:delegate:main:tomb-fence',
      })
      assert.ok('jobId' in created)
      const snap = jobs.snapshotOf(created.jobId)!
      g0.upsertEnqueue({
        jobId: created.jobId,
        parentSessionKey: PARENT,
        agentId: 'coding-assistant',
        goal: 'ghost-queued',
        state: 'queued',
        userId: 'user-r2',
        fencingEpoch: snap.fencingEpoch,
        generation: snap.generation + 8,
      })
      const staleOverlay = [structuredClone(snap)]
      const g1 = new DelegateInflightSurfaceStore({ dbPath: surfaceDb, now: () => 41 })
      assert.equal(jobs.dropIfUnclaimed(created.jobId), true)
      assert.equal(g1.drop(created.jobId), true)
      const page = await handleInflightDelegatesRequest({
        method: 'GET',
        sessionId: SESS,
        userId: 'user-r2',
        enabled: true,
        loadSession: async () => ({ id: SESS, userId: 'user-r2' }),
        store: g0,
        overlayJobs: () => staleOverlay,
        resolveJob: () => undefined,
        dropMissingLive: false,
      })
      assert.equal(page.status, 200)
      const states = ((page.body.items as Array<{ state: string }>) ?? []).map((row) => row.state)
      assert.deepEqual(states, [])
      assert.equal(g0.get(created.jobId), undefined)
      g0.close()
      g1.close()
      jobs.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('closeout residual — writer lock must not stall the gateway', () => {
  it('updateLive returns immediately when another connection holds the writer lock', async () => {
    assert.equal(INFLIGHT_SURFACE_BUSY_TIMEOUT_MS, 0)
    const dir = await mkdtemp(join(tmpdir(), 'oc-r2-busy-'))
    const dbPath = join(dir, 'delegate-inflight-surface.db')
    let locker: InstanceType<typeof Database> | null = null
    try {
      const store = new DelegateInflightSurfaceStore({ dbPath })
      store.upsertEnqueue({
        jobId: 'dlgjob-busy',
        parentSessionKey: PARENT,
        agentId: 'coding-assistant',
        goal: 'g',
        state: 'running',
        liveHint: 'before',
      })
      locker = new Database(dbPath)
      locker.pragma('busy_timeout = 0')
      locker.exec('BEGIN IMMEDIATE')
      const t0 = Date.now()
      assert.doesNotThrow(() => {
        store.updateLive({ jobId: 'dlgjob-busy', liveHint: 'after-lock' })
      })
      const elapsedMs = Date.now() - t0
      assert.ok(elapsedMs < 250, `updateLive stalled ${elapsedMs}ms under writer lock`)
      assert.ok(store.writeFailures >= 1)
      assert.equal(store.get('dlgjob-busy')?.liveHint, 'after-lock')
      assert.equal(store.get('dlgjob-busy')?.state, 'running')
      locker.exec('ROLLBACK')
      locker.close()
      locker = null
      store.close()
    } finally {
      try {
        locker?.exec('ROLLBACK')
      } catch {
        /* already rolled back */
      }
      try {
        locker?.close()
      } catch {
        /* closed */
      }
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('writer-lock drop retries the tombstone so a stale overlay cannot resurrect queued', async () => {
    assert.equal(INFLIGHT_SURFACE_BUSY_TIMEOUT_MS, 0)
    const dir = await mkdtemp(join(tmpdir(), 'oc-r2-lock-tomb-'))
    const surfaceDb = join(dir, 'delegate-inflight-surface.db')
    let locker: InstanceType<typeof Database> | null = null
    try {
      const jobsDb = new DelegateDurableDb(join(dir, 'delegate-jobs.db'))
      const g0 = new DelegateInflightSurfaceStore({ dbPath: surfaceDb, now: () => 50 })
      const g1 = new DelegateInflightSurfaceStore({ dbPath: surfaceDb, now: () => 51 })
      const jobs = new DelegateJobStore({
        sm: true,
        ttlMs: 60_000,
        durable: jobsDb,
        bootId: 'gw:r2-lock-tomb',
      })
      const created = jobs.create('coding-assistant', {
        queued: true,
        parentSessionKey: PARENT,
        sessionKey: 'agent:coding-assistant:delegate:main:lock-tomb',
      })
      assert.ok('jobId' in created)
      const snap = jobs.snapshotOf(created.jobId)!
      g0.upsertEnqueue({
        jobId: created.jobId,
        parentSessionKey: PARENT,
        agentId: 'coding-assistant',
        goal: 'ghost-queued',
        state: 'queued',
        userId: 'user-r2',
        fencingEpoch: snap.fencingEpoch,
        generation: snap.generation,
      })
      g1.upsertEnqueue({
        jobId: created.jobId,
        parentSessionKey: PARENT,
        agentId: 'coding-assistant',
        goal: 'ghost-queued',
        state: 'queued',
        userId: 'user-r2',
        fencingEpoch: snap.fencingEpoch,
        generation: snap.generation,
      })
      const staleOverlay = [structuredClone(snap)]
      assert.equal(jobs.dropIfUnclaimed(created.jobId), true)
      assert.equal(jobs.snapshotOf(created.jobId), undefined)

      locker = new Database(surfaceDb)
      locker.pragma('busy_timeout = 0')
      locker.exec('BEGIN IMMEDIATE')
      const t0 = Date.now()
      assert.equal(g1.drop(created.jobId), true)
      const elapsedMs = Date.now() - t0
      assert.ok(elapsedMs < 250, `drop stalled ${elapsedMs}ms under writer lock`)
      assert.ok(g1.writeFailures >= 1)
      const during = locker
        .prepare('SELECT state, tombstoned, generation FROM inflight_delegate_surface WHERE job_id = ?')
        .get(created.jobId) as { state: string; tombstoned: number; generation: number } | undefined
      assert.equal(during?.state, 'queued')
      assert.equal(during?.tombstoned, 0)

      locker.exec('ROLLBACK')
      locker.close()
      locker = null
      assert.equal(g1.flushPendingTombstones(), 0)
      const landed = new Database(surfaceDb)
      const tomb = landed
        .prepare('SELECT tombstoned FROM inflight_delegate_surface WHERE job_id = ?')
        .get(created.jobId) as { tombstoned: number } | undefined
      landed.close()
      assert.equal(tomb?.tombstoned, 1)

      const page = await handleInflightDelegatesRequest({
        method: 'GET',
        sessionId: SESS,
        userId: 'user-r2',
        enabled: true,
        loadSession: async () => ({ id: SESS, userId: 'user-r2' }),
        store: g0,
        overlayJobs: () => staleOverlay,
        resolveJob: () => undefined,
        dropMissingLive: false,
      })
      assert.equal(page.status, 200)
      const states = ((page.body.items as Array<{ state: string }>) ?? []).map((row) => row.state)
      assert.deepEqual(states, [])
      assert.equal(g0.get(created.jobId), undefined)

      g0.close()
      g1.close()
      const reopened = new DelegateInflightSurfaceStore({ dbPath: surfaceDb, now: () => 52 })
      assert.equal(reopened.get(created.jobId), undefined)
      reopened.rebuildFromJobs(staleOverlay, { dropMissingLive: false, resolveJob: () => undefined })
      assert.equal(reopened.get(created.jobId), undefined)
      const raw = new Database(surfaceDb)
      const persisted = raw
        .prepare('SELECT state FROM inflight_delegate_surface WHERE job_id = ? AND IFNULL(tombstoned, 0) = 0')
        .get(created.jobId) as { state: string } | undefined
      raw.close()
      assert.equal(persisted, undefined)
      reopened.close()
      jobs.close()
    } finally {
      try {
        locker?.exec('ROLLBACK')
      } catch {
        /* already rolled back */
      }
      try {
        locker?.close()
      } catch {
        /* closed */
      }
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('boot reconcile tombstones ownerless queued rows after process death', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-r2-boot-tomb-'))
    const surfaceDb = join(dir, 'delegate-inflight-surface.db')
    try {
      const seed = new DelegateInflightSurfaceStore({ dbPath: surfaceDb, now: () => 60 })
      seed.upsertEnqueue({
        jobId: 'dlgjob-orphan-q',
        parentSessionKey: PARENT,
        agentId: 'coding-assistant',
        goal: 'still-queued',
        state: 'queued',
        userId: 'user-r2',
        fencingEpoch: 1,
        generation: 8,
      })
      seed.close()
      const boot = new DelegateInflightSurfaceStore({ dbPath: surfaceDb, now: () => 61 })
      boot.rebuildFromJobs([], { dropMissingLive: true })
      assert.equal(boot.get('dlgjob-orphan-q'), undefined)
      const page = await handleInflightDelegatesRequest({
        method: 'GET',
        sessionId: SESS,
        userId: 'user-r2',
        enabled: true,
        loadSession: async () => ({ id: SESS, userId: 'user-r2' }),
        store: boot,
        overlayJobs: () => [],
        resolveJob: () => undefined,
        dropMissingLive: true,
      })
      assert.equal(((page.body.items as unknown[]) ?? []).length, 0)
      boot.close()
      const reopened = new DelegateInflightSurfaceStore({ dbPath: surfaceDb, now: () => 62 })
      assert.equal(reopened.get('dlgjob-orphan-q'), undefined)
      const raw = new Database(surfaceDb)
      const tomb = raw
        .prepare('SELECT tombstoned FROM inflight_delegate_surface WHERE job_id = ?')
        .get('dlgjob-orphan-q') as { tombstoned: number } | undefined
      raw.close()
      assert.equal(tomb?.tombstoned, 1)
      reopened.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('closeout residual — v1→v2 migration clips payload and backfills TTL', () => {
  it('upgrades a v1 disk of 2MiB terminals into bounded 2h rows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-r2-v1mig-'))
    const dbPath = join(dir, 'delegate-inflight-surface.db')
    try {
      const v1 = new Database(dbPath)
      v1.exec(`
        CREATE TABLE inflight_delegate_surface (
          job_id TEXT PRIMARY KEY,
          parent_session_key TEXT NOT NULL,
          run_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          goal TEXT NOT NULL DEFAULT '',
          state TEXT NOT NULL,
          live_hint TEXT NOT NULL DEFAULT '',
          updated_at INTEGER NOT NULL,
          folded_group_json TEXT
        );
      `)
      v1.pragma('user_version = 1')
      const blob = 'x'.repeat(2 * 1024 * 1024)
      const insert = v1.prepare(
        `INSERT INTO inflight_delegate_surface
          (job_id, parent_session_key, run_id, agent_id, goal, state, live_hint, updated_at, folded_group_json)
         VALUES (?, ?, ?, ?, ?, 'completed', '', 1000, ?)`,
      )
      for (const id of ['dlgjob-legacy-1', 'dlgjob-legacy-2', 'dlgjob-legacy-3']) {
        insert.run(
          id,
          PARENT,
          id,
          'coding-assistant',
          id,
          JSON.stringify(
            group({
              runId: id,
              goal: id,
              transcript: [{ kind: 'text', text: blob }],
              runtimeEvents: [{ ordinal: 1, observedAt: 1, source: 'gateway', payload: blob }],
            }),
          ),
        )
      }
      v1.close()

      const now = 1_000
      const store = new DelegateInflightSurfaceStore({
        dbPath,
        now: () => now,
        terminalTtlMs: 2 * 60 * 60 * 1000,
      })
      const page = store.listForSessionId(SESS, {
        userId: undefined,
        maxBytes: INFLIGHT_GET_MAX_RESPONSE_BYTES,
      })
      const encoded = JSON.stringify({ enabled: true, items: page.items, nextCursor: page.nextCursor })
      const responseBytes = Buffer.byteLength(encoded, 'utf8')
      assert.ok(
        responseBytes <= INFLIGHT_GET_MAX_RESPONSE_BYTES,
        `GET page ${responseBytes} exceeded ${INFLIGHT_GET_MAX_RESPONSE_BYTES}`,
      )
      assert.equal(page.items.length, 3)
      for (const item of page.items) {
        assert.equal(item.foldedGroup?.transcript, undefined)
        assert.equal(item.state, 'completed')
      }
      store.close()

      const v2 = new Database(dbPath)
      const schemaVersion = Number(v2.pragma('user_version', { simple: true }))
      assert.equal(schemaVersion, SURFACE_SCHEMA_VERSION)
      const rows = v2
        .prepare(
          `SELECT folded_group_json, payload_bytes, expires_at FROM inflight_delegate_surface`,
        )
        .all() as Array<{
        folded_group_json: string | null
        payload_bytes: number
        expires_at: number | null
      }>
      assert.equal(rows.length, 3)
      let payloadChars = 0
      let immortal = 0
      for (const row of rows) {
        payloadChars += row.folded_group_json?.length ?? 0
        if (row.expires_at == null) immortal += 1
        assert.ok(row.payload_bytes <= INFLIGHT_FOLDED_GROUP_MAX_BYTES)
        assert.equal(row.expires_at, now + 2 * 60 * 60 * 1000)
        if (row.folded_group_json) {
          assert.equal(JSON.parse(row.folded_group_json).transcript, undefined)
        }
      }
      assert.ok(payloadChars < 64 * 1024)
      assert.equal(immortal, 0)
      v2.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('GET byte budget applies to the first item (no oversized lead row)', async () => {
    await withStore((store) => {
      store.upsertEnqueue({
        jobId: 'dlgjob-lead',
        parentSessionKey: PARENT,
        agentId: 'coding-assistant',
        goal: 'lead',
        state: 'running',
        userId: 'user-r2',
      })
      store.foldTerminal({
        jobId: 'dlgjob-lead',
        group: group({ resultSummary: 'x'.repeat(400) }),
        state: 'completed',
      })
      const page = store.listForSessionId(SESS, { maxBytes: 80 })
      const encoded = JSON.stringify(page.items)
      assert.ok(Buffer.byteLength(encoded, 'utf8') <= 80 + 8)
      assert.equal(page.truncated, true)
    })
  })
})
