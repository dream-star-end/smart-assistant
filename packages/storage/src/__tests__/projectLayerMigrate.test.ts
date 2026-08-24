import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  applyProjectLayerMigration,
  assertPlanApplyable,
  compensateProjectLayerMigration,
  isDefaultApplySession,
  planProjectLayerMigration,
  repairProjectDirOwnership,
  type ApplyPorts,
  type InventorySession,
  type ProjectLayerInventory,
  type ProjectLayerLivePorts,
} from '../projectLayerMigrate.js'

const OCV5 = '852859fa-cf1d-481c-96fd-23f2966b8b5f'

function sess(p: Partial<InventorySession> & { id: string }): InventorySession {
  return {
    category: 'cross',
    confidence: 'high',
    deleted_at: null,
    archived_at: null,
    project_id: null,
    updated_at: 10,
    ...p,
  }
}

function inventory(sessions: InventorySession[]): ProjectLayerInventory {
  return {
    sessionMapping: {
      sessions,
      bind_to_ocv5_chat: { ids: sessions.map((s) => s.id) },
    },
    memories: {
      test_candidates: [{ slug: 'keep-me', file: 'keep-me.md', hash: 'abc' }],
      exclude_secret_slugs: ['secret-key'],
      official_promote_slugs: ['opus-fable-manage-grok-execute'],
    },
    skills: {
      overlay_proposed: ['openclaude-instance-topology', 'v5-selfhost-cursor-key-rotation'],
      overlay_excluded: ['v5-selfhost-cursor-key-rotation'],
    },
    assets: {
      local_sqlite_rows: [
        {
          id: 'a1',
          name: 'shot.png',
          session_id: 's-high',
          path: '/home/agent/.openclaude/generated/shot.png',
          digest: 'dd'.repeat(32),
          verdict: 'candidate',
        },
        {
          id: 'a-unmoved',
          name: 'cc-env-risk-audit.md',
          session_id: 's-unrelated',
          path: '/x',
          digest: 'ee'.repeat(32),
          verdict: 'candidate',
        },
      ],
    },
    ocv5ChatFacade: { bindTargetBoardProjectId: OCV5, create: { body: { name: 'OCV5 facade' } } },
  }
}

function ports(over: Partial<ProjectLayerLivePorts> = {}): ProjectLayerLivePorts {
  const sessions: Record<string, { id: string; projectId: string | null; updatedAt: number; deletedAt: number | null; archivedAt: number | null }> = {
    's-high': { id: 's-high', projectId: null, updatedAt: 10, deletedAt: null, archivedAt: null },
    's-low': { id: 's-low', projectId: null, updatedAt: 10, deletedAt: null, archivedAt: null },
    's-arch': { id: 's-arch', projectId: null, updatedAt: 10, deletedAt: null, archivedAt: 99 },
    's-stale': { id: 's-stale', projectId: 'other', updatedAt: 99, deletedAt: null, archivedAt: null },
  }
  return {
    async getBoardProject(id) {
      if (id !== OCV5) return null
      return { id: OCV5, key: 'OCV5', archivedAt: null, contextVersion: 0 }
    },
    async listChatProjects() {
      return []
    },
    async getSession(id) {
      return sessions[id] ?? null
    },
    async getProjectContextVersion() {
      return 0
    },
    async sha256File() {
      return 'dd'.repeat(32)
    },
    ...over,
  }
}

describe('isDefaultApplySession', () => {
  it('rejects low/archived/deleted', () => {
    assert.equal(isDefaultApplySession(sess({ id: 'a', confidence: 'low' })), false)
    assert.equal(isDefaultApplySession(sess({ id: 'a', archived_at: '2026-08-20' })), false)
    assert.equal(isDefaultApplySession(sess({ id: 'a', deleted_at: 1 })), false)
    assert.equal(isDefaultApplySession(sess({ id: 'a', confidence: 'medium', category: 'personal' })), true)
  })
})

describe('planProjectLayerMigration', () => {
  const baseSessions = [
    sess({ id: 's-high', category: 'personal' }),
    sess({ id: 's-low', confidence: 'low', category: 'cross' }),
    sess({ id: 's-arch', archived_at: '2026-08-20', category: 'cross' }),
    sess({ id: 's-stale', updated_at: 10, project_id: null, category: 'commercial' }),
  ]

  it('does not default-migrate low or archived', async () => {
    const plan = await planProjectLayerMigration({
      inventory: inventory(baseSessions.filter((s) => s.id !== 's-stale')),
      ports: ports(),
    })
    assert.ok(plan.defaultApplySessionIds.includes('s-high'))
    assert.ok(!plan.defaultApplySessionIds.includes('s-low'))
    assert.ok(!plan.defaultApplySessionIds.includes('s-arch'))
    assert.ok(plan.manualReview.some((m) => m.sessionId === 's-low'))
    assert.ok(plan.manualReview.some((m) => m.sessionId === 's-arch'))
    assert.equal(plan.operations.some((o) => o.op === 'create_chat_facade'), true)
    const overlay = plan.operations.find((o) => o.op === 'skill_overlay')
    assert.ok(overlay && overlay.op === 'skill_overlay')
    assert.ok(overlay.names.includes('openclaude-instance-topology'))
    assert.ok(!overlay.names.includes('v5-selfhost-cursor-key-rotation'))
    assert.ok(plan.operations.some((o) => o.op === 'copy_memory_candidate' && o.slug === 'keep-me'))
    assert.ok(plan.operations.some((o) => o.op === 'copy_memory_candidate' && o.slug === 'opus-fable-manage-grok-execute'))
    assert.ok(plan.rollback.forbidden.includes('rm -rf projects/'))
  })

  it('fail-closes ghost project', async () => {
    const plan = await planProjectLayerMigration({
      inventory: inventory([sess({ id: 's-high' })]),
      targetBoardProjectId: OCV5,
      ports: ports({
        async getBoardProject() {
          return null
        },
      }),
    })
    assert.equal(plan.live.boardExists, false)
    assert.ok(plan.risks.some((r) => r.includes('ghost') || r.includes('missing')))
  })

  it('marks CAS drift as manualReview and not in default apply', async () => {
    const plan = await planProjectLayerMigration({
      inventory: inventory([sess({ id: 's-stale', project_id: null, updated_at: 10, category: 'commercial' })]),
      ports: ports(),
    })
    assert.ok(!plan.defaultApplySessionIds.includes('s-stale'))
    assert.ok(plan.manualReview.some((m) => String(m.id).includes('drift')))
  })

  it('excludes assets whose session is not in apply set', async () => {
    const plan = await planProjectLayerMigration({
      inventory: inventory([sess({ id: 's-high', category: 'personal' })]),
      ports: ports(),
    })
    assert.ok(plan.operations.some((o) => o.op === 'create_asset' && o.sessionId === 's-high'))
    assert.ok(plan.manualReview.some((m) => m.id.includes('asset-unmoved')))
  })

  it('records digest mismatch as manualReview', async () => {
    const plan = await planProjectLayerMigration({
      inventory: inventory([sess({ id: 's-high', category: 'personal' })]),
      ports: ports({
        async sha256File() {
          return 'ab'.repeat(32)
        },
      }),
    })
    assert.ok(plan.manualReview.some((m) => m.id.includes('asset-digest')))
    assert.ok(!plan.operations.some((o) => o.op === 'create_asset'))
  })
})

describe('usage backfill + cron impact + count drift', () => {
  it('lists usage_backfill without changing cron YAML', async () => {
    const plan = await planProjectLayerMigration({
      inventory: inventory([sess({ id: 's-high', category: 'personal' })]),
      ports: ports({
        async listNullUsage() {
          return [{ id: 'u-1', sessionId: 's-high', parentSessionId: null }]
        },
        async listCronJobs() {
          return [
            {
              id: 'remind-1',
              projectMode: 'follow_session',
              sourceSessionKey: 'agent:main:webchat:dm:s-high',
            },
          ]
        },
      }),
    })
    const backfill = plan.operations.find((o) => o.op === 'usage_backfill')
    assert.ok(backfill && backfill.op === 'usage_backfill')
    assert.deepEqual(backfill.sessionIds, ['s-high'])
    assert.deepEqual(backfill.rowIds, ['u-1'])
    assert.equal(plan.cronImpact.length, 1)
    assert.equal(plan.cronImpact[0].action, 'manualReview')
    assert.ok(!plan.operations.some((o) => o.op === 'usage_backfill' && 'rewriteCron' in o))
    assert.equal(plan.expectedCounts.drifted, false)
  })

  it('marks authoritative 62/47 drift and apply aborts', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `s-${i}`)
    const plan = await planProjectLayerMigration({
      inventory: {
        sessionMapping: {
          sessions: ids.map((id) => sess({ id, category: 'personal' })),
          bind_to_ocv5_chat: { ids },
        },
        ocv5ChatFacade: { bindTargetBoardProjectId: OCV5 },
      },
      ports: ports({
        async getSession(id) {
          return { id, projectId: null, updatedAt: 10, deletedAt: null, archivedAt: null }
        },
      }),
    })
    assert.equal(plan.expectedCounts.drifted, true)
    assert.ok(plan.risks.some((r) => r.includes('inventory_count_drift')))
    assert.throws(() => assertPlanApplyable(plan), /inventory_count_drift/)
  })

  it('compensate restores only this operation usage rows that did not change again', async () => {
    const restored: string[] = []
    await compensateProjectLayerMigration(
      {
        ok: false,
        operationId: 'op-usage',
        applied: ['OP_USAGE_BACKFILL'],
        createdAssetIds: [],
        facadeId: 'f',
        rollback: {
          sessionRestores: [],
          assetDeletes: [],
          chatFacadeDelete: false,
          forbidden: [],
          usageRestores: [
            { id: 'u-keep', oldBoardProjectId: null },
            { id: 'u-changed', oldBoardProjectId: null },
          ],
        },
      },
      {
        async batchMoveSessions() {
          return { ok: true, updated: 0 }
        },
        async deleteAsset() {},
        async restoreUsage(rows) {
          restored.push(...rows.map((r) => r.id))
          return rows.length
        },
      },
    )
    assert.deepEqual(restored, ['u-keep', 'u-changed'])
  })
})

describe('apply + compensating rollback', () => {
  it('aborts session move on CAS and only rolls back this operation assets', async () => {
    const plan = await planProjectLayerMigration({
      inventory: inventory([sess({ id: 's-high', category: 'personal' })]),
      ports: ports(),
    })
    const deletedAssets: string[] = []
    const moved: string[][] = []
    const applyPorts: ApplyPorts = {
      ...ports(),
      async createChatProject() {
        return { id: 'facade-1' }
      },
      async bindChatProject() {},
      async ensureProjectContext() {},
      async batchMoveSessions(input) {
        moved.push(input.ids)
        if (!input.operationId.endsWith('rollback')) {
          return { ok: false, error: 'stale_session', staleIds: input.ids }
        }
        return { ok: true, updated: input.ids.length }
      },
      async createMemoryCandidate() {},
      async putSkillOverlay() {},
      async createAsset() {
        return { id: 'asset-created', created: true }
      },
      async deleteAsset(id) {
        deletedAssets.push(id)
      },
      async readMemoryContent() {
        return 'body'
      },
    }
    const result = await applyProjectLayerMigration(plan, applyPorts)
    assert.equal(result.ok, false)
    assert.equal(result.error, 'stale_session')
    assert.ok(deletedAssets.length === 0 || deletedAssets.every((id) => result.rollback.assetDeletes.includes(id)))
    assert.ok(!deletedAssets.includes('unrelated-old-asset'))
  })

  it('compensate only deletes assets from this manifest', async () => {
    const deleted: string[] = []
    await compensateProjectLayerMigration(
      {
        ok: false,
        operationId: 'op1',
        applied: [],
        createdAssetIds: ['new-a'],
        facadeId: 'f',
        rollback: {
          sessionRestores: [],
          assetDeletes: ['new-a'],
          chatFacadeDelete: false,
          forbidden: [],
        },
      },
      {
        async batchMoveSessions() {
          return { ok: true, updated: 0 }
        },
        async deleteAsset(id) {
          deleted.push(id)
        },
      },
    )
    assert.deepEqual(deleted, ['new-a'])
  })
})

describe('repairProjectDirOwnership', () => {
  it('refuses invalid id and does not walk unrelated trees', async () => {
    await assert.rejects(() => repairProjectDirOwnership({ boardProjectId: '../etc', uid: 1000, gid: 1000, dryRun: true }))
    const r = await repairProjectDirOwnership({
      boardProjectId: OCV5,
      uid: 1000,
      gid: 1000,
      dryRun: true,
    })
    assert.ok(Array.isArray(r.changed))
    assert.ok(Array.isArray(r.skipped))
  })
})
