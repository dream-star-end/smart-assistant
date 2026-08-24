import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  applyProjectLayerMigration,
  assertPlanApplyable,
  compensateProjectLayerMigration,
  isDefaultApplySession,
  isPathInsideRoot,
  planProjectLayerMigration,
  readMemoryContent,
  repairProjectDirOwnership,
  type ApplyPorts,
  type ApplyResult,
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
          verdict: 'promote',
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

function emptyManifest(): ApplyResult['manifest'] {
  return {
    facadeCreate: null,
    bind: null,
    context: null,
    memoryCandidates: [],
    skillOverlay: null,
  }
}

function applyStub(over: Partial<ApplyPorts> = {}): ApplyPorts {
  return {
    ...ports(),
    async createChatProject() {
      return { id: 'facade-1', created: true }
    },
    async bindChatProject() {
      return { old: null, new: 'facade-1' }
    },
    async ensureProjectContext() {
      return { created: true, version: 0 }
    },
    async batchMoveSessions(input) {
      if (!input.operationId.endsWith('rollback')) {
        return {
          ok: true,
          updated: input.ids.length,
          post: input.ids.map((id) => ({
            id,
            projectId: input.projectId,
            updatedAt: 11,
            oldProjectId: null,
            oldUpdatedAt: 10,
          })),
        }
      }
      return {
        ok: true,
        updated: input.ids.length,
        post: input.expected.map((row) => ({ ...row })),
      }
    },
    async createMemoryCandidate() {
      return { id: 'mem-1', version: 1, hash: 'aa'.repeat(32) }
    },
    async putSkillOverlay(names) {
      return { old: [], new: names }
    },
    async createAsset() {
      return { id: 'asset-created', created: true }
    },
    async deleteAsset() {},
    async readMemoryContent() {
      return 'body unique-marker-keep-me'
    },
    ...over,
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
    assert.equal(plan.usageBackfill.queried, true)
    assert.equal(plan.usageBackfill.rows[0]?.id, 'u-1')
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
        manifest: emptyManifest(),
        rollback: {
          sessionRestores: [],
          assetDeletes: [],
          chatFacadeDelete: false,
          forbidden: [],
          usageRestores: [
            { id: 'u-keep', oldBoardProjectId: null, postBoardProjectId: OCV5 },
            { id: 'u-changed', oldBoardProjectId: null, postBoardProjectId: OCV5 },
          ],
        },
      },
      {
        async batchMoveSessions() {
          return { ok: true, updated: 0, post: [] }
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
    const applyPorts = applyStub({
      async batchMoveSessions(input) {
        moved.push(input.ids)
        if (!input.operationId.endsWith('rollback')) {
          return { ok: false, error: 'stale_session', staleIds: input.ids }
        }
        return { ok: true, updated: input.ids.length, post: [] }
      },
      async deleteAsset(id) {
        deletedAssets.push(id)
      },
    })
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
        manifest: emptyManifest(),
        rollback: {
          sessionRestores: [],
          assetDeletes: ['new-a'],
          chatFacadeDelete: false,
          forbidden: [],
        },
      },
      {
        async batchMoveSessions() {
          return { ok: true, updated: 0, post: [] }
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

describe('apply order + memory allowlist', () => {
  it('repairs uid1000 volume before ensure ProjectContext (EACCES order)', async () => {
    const plan = await planProjectLayerMigration({
      inventory: inventory([sess({ id: 's-high', category: 'personal' })]),
      ports: ports(),
    })
    const ops = plan.operations.map((o) => o.op)
    assert.ok(ops.indexOf('repair_project_ownership') >= 0)
    assert.ok(ops.indexOf('ensure_project_context_dir') >= 0)
    assert.ok(
      ops.indexOf('repair_project_ownership') < ops.indexOf('ensure_project_context_dir'),
      'repair must precede ensure so uid1000 can write ProjectContext',
    )
    assert.ok(ops.indexOf('ensure_project_context_dir') < ops.indexOf('copy_memory_candidate'))
  })

  it('readMemoryContent allowlists inventory files, checks hash, blocks escape', async () => {
    const helloHash = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    const allow = [{ slug: 'keep-me', file: 'keep-me.md', hash: helloHash, absPath: '/home/agent/.openclaude/memory/keep-me.md' }]
    const body = await readMemoryContent({
      slug: 'keep-me',
      file: 'keep-me.md',
      allowlist: allow,
      realpathImpl: async () => '/home/agent/.openclaude/memory/keep-me.md',
      readFileImpl: async () => Buffer.from('hello'),
    })
    assert.equal(body, 'hello')
    await assert.rejects(
      () =>
        readMemoryContent({
          slug: 'keep-me',
          allowlist: allow,
          expectedSha256: 'cd'.repeat(32),
          realpathImpl: async () => '/home/agent/.openclaude/memory/keep-me.md',
          readFileImpl: async () => Buffer.from('hello'),
        }),
      /memory_hash_mismatch/,
    )
    await assert.rejects(
      () =>
        readMemoryContent({
          slug: 'secret-key',
          allowlist: allow,
          realpathImpl: async () => '/etc/passwd',
          readFileImpl: async () => Buffer.from('x'),
        }),
      /memory_not_allowlisted/,
    )
    await assert.rejects(
      () =>
        readMemoryContent({
          slug: 'keep-me',
          allowlist: allow,
          realpathImpl: async () => '/etc/passwd',
          readFileImpl: async () => Buffer.from('hello'),
        }),
      /memory_path_escape/,
    )
    assert.equal(isPathInsideRoot('/home/agent/.openclaude/memory/x', '/home/agent/.openclaude'), true)
    assert.equal(isPathInsideRoot('/etc/passwd', '/home/agent/.openclaude'), false)
  })

  it('compensate uses true NULL projectId and post updated_at CAS', async () => {
    const moves: Array<{ projectId: string | null; expectedAt: number; allowNull?: boolean }> = []
    await compensateProjectLayerMigration(
      {
        ok: false,
        operationId: 'op-null',
        applied: ['OP_MOVE_SESSIONS'],
        createdAssetIds: [],
        facadeId: 'f',
        manifest: emptyManifest(),
        rollback: {
          sessionRestores: [{ id: 's-high', projectId: null, updatedAt: 11 }],
          assetDeletes: [],
          chatFacadeDelete: false,
          forbidden: [],
        },
      },
      {
        async batchMoveSessions(input) {
          moves.push({
            projectId: input.projectId,
            expectedAt: input.expected[0]?.updatedAt ?? 0,
            allowNull: input.allowNullProject,
          })
          assert.equal(input.projectId, null)
          assert.notEqual(input.projectId, '')
          return { ok: true, updated: 1, post: input.expected }
        },
        async deleteAsset() {},
      },
    )
    assert.equal(moves[0]?.projectId, null)
    assert.equal(moves[0]?.allowNull, true)
    assert.equal(moves[0]?.expectedAt, 11)
  })

  it('skips compensate delete for reused assets; fail-loud on restore error', async () => {
    const deleted: string[] = []
    const plan = await planProjectLayerMigration({
      inventory: inventory([sess({ id: 's-high', category: 'personal' })]),
      ports: ports(),
    })
    const result = await applyProjectLayerMigration(
      plan,
      applyStub({
        async createAsset() {
          return { id: 'reused-a', created: false, reused: true }
        },
      }),
    )
    assert.equal(result.ok, true)
    assert.deepEqual(result.createdAssetIds, [])
    await assert.rejects(
      () =>
        compensateProjectLayerMigration(
          {
            ...result,
            rollback: {
              ...result.rollback,
              usageRestores: [{ id: '1', oldBoardProjectId: null, postBoardProjectId: OCV5 }],
            },
          },
          {
            async batchMoveSessions() {
              return { ok: true, updated: 0, post: [] }
            },
            async deleteAsset() {
              deleted.push('nope')
            },
            async restoreUsage() {
              throw new Error('cas_miss')
            },
          },
        ),
      /cas_miss/,
    )
    assert.deepEqual(deleted, [])
  })
})
