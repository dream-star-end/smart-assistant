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
import { readFileSync } from 'node:fs'
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
  isDeferredExactProcessStub,
  parentKeyMatchesSessionId,
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
      assert.equal(store.listForSessionId(SESS).length, 1)
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
      const items = s2.listForSessionId(SESS)
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
      const items = store.listForSessionId(SESS)
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
      const items = store.listForSessionId(SESS)
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
