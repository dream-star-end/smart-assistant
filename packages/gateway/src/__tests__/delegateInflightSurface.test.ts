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

import type { DurableAgentGroup } from '@openclaude/protocol'
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

