/**
 * OCV5 project-layer migration coordinator.
 * Default mode is dry-run. Apply is explicit, CAS-gated, compensating rollback only.
 * Does not create a second tb_project. Does not auto-promote memories.
 */

import { createHash } from 'node:crypto'
import { chmod, lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { BOARD_PROJECT_ID_RE, projectContextDir } from './projectContext.js'

export const OCV5_DEFAULT_BOARD_ID = '852859fa-cf1d-481c-96fd-23f2966b8b5f'
/** Live uid3 inventory (phase-1 dry-run). Apply aborts if a large bind list drifts. */
export const AUTHORITATIVE_DEFAULT_APPLY = 62
export const AUTHORITATIVE_MANUAL_REVIEW = 47
export const AUTHORITATIVE_BIND_MIN = 50

export type InventorySession = {
  id: string
  title?: string
  category?: string
  confidence?: 'high' | 'medium' | 'low' | string
  deleted_at?: string | number | null
  archived_at?: string | number | null
  project_id?: string | null
  updated_at?: number | null
  map?: string
}

export type InventoryAssetRow = {
  id?: string
  name?: string
  session_id?: string | null
  path?: string
  digest?: string
  verdict?: string
  reason?: string
  sensitive?: boolean
}

export type ProjectLayerInventory = {
  generatedAt?: string
  sessionMapping: {
    sessions: InventorySession[]
    bind_to_ocv5_chat?: { ids?: string[] }
  }
  memories?: {
    test_candidates?: Array<{ slug: string; file?: string; hash?: string; content?: string }>
    exclude_secret_slugs?: string[]
    official_promote_slugs?: string[]
  }
  skills?: {
    overlay_proposed?: string[]
    overlay_excluded?: string[]
  }
  assets?: {
    local_sqlite_rows?: InventoryAssetRow[]
  }
  ocv5ChatFacade?: {
    bindTargetBoardProjectId?: string
    create?: { body?: { name?: string } }
  }
}

export type LiveSessionSnapshot = {
  id: string
  projectId: string | null
  updatedAt: number
  deletedAt: number | null
  archivedAt: number | null
}

export type LiveBoardProject = {
  id: string
  key: string
  archivedAt: number | null
  contextVersion: number
}

export type LiveChatProject = {
  id: string
  name: string
  boardProjectId: string | null
  deletedAt?: number | null
}

export type PlannedOp =
  | {
      id: string
      op: 'create_chat_facade'
      dryRun: true
      name: string
      bindBoardProjectId: string
    }
  | {
      id: string
      op: 'bind_chat_facade'
      dryRun: true
      chatProjectId?: string
      boardProjectId: string
    }
  | {
      id: string
      op: 'ensure_project_context_dir'
      dryRun: true
      boardProjectId: string
    }
  | {
      id: string
      op: 'repair_project_ownership'
      dryRun: true
      boardProjectId: string
      uid: number
      gid: number
    }
  | {
      id: string
      op: 'move_sessions'
      dryRun: true
      ids: string[]
      expected: Array<{ id: string; projectId: string | null; updatedAt: number }>
    }
  | {
      id: string
      op: 'copy_memory_candidate'
      dryRun: true
      slug: string
      source?: string
      sha256?: string
    }
  | {
      id: string
      op: 'skill_overlay'
      dryRun: true
      names: string[]
    }
  | {
      id: string
      op: 'create_asset'
      dryRun: true
      name: string
      sessionId: string
      containerPath: string
      digest: string
      source: 'output' | 'upload'
    }
  | {
      id: string
      op: 'usage_backfill'
      dryRun: true
      sessionIds: string[]
      boardProjectId: string
      source: 'migration_backfill'
      rowIds?: string[]
    }

export type ManualReviewItem = {
  id: string
  reason: string
  sessionId?: string
  extra?: Record<string, unknown>
}

export type ProjectLayerPlan = {
  operationId: string
  targetBoardProjectId: string
  mode: 'dry-run' | 'apply'
  createdAt: number
  defaultApplySessionIds: string[]
  operations: PlannedOp[]
  manualReview: ManualReviewItem[]
  risks: string[]
  rollback: {
    sessionRestores: Array<{ id: string; projectId: string | null; updatedAt: number }>
    assetDeletes: string[]
    chatFacadeDelete: boolean
    forbidden: string[]
  }
  live: {
    boardExists: boolean
    boardArchived: boolean
    facadeId: string | null
    facadeUnique: boolean
    contextVersion: number | null
  }
  expectedCounts: {
    defaultApply: number
    manualReview: number
    actualApply: number
    actualManualReview: number
    drifted: boolean
  }
  cronImpact: Array<{
    jobId: string
    projectMode: string
    originSessionId: string | null
    action: 'manualReview'
    reason: string
  }>
  usageBackfill: {
    sessionIds: string[]
    rowIds: string[]
    source: 'migration_backfill'
  }
}

export type ProjectLayerLivePorts = {
  getBoardProject(id: string): Promise<LiveBoardProject | null>
  listChatProjects(): Promise<LiveChatProject[]>
  getSession(id: string): Promise<LiveSessionSnapshot | null>
  getProjectContextVersion(id: string): Promise<number | null>
  sha256File?(absPath: string): Promise<string>
  listNullUsage?(sessionIds: string[]): Promise<Array<{ id: string; sessionId: string | null; parentSessionId: string | null }>>
  listCronJobs?(): Promise<Array<{
    id: string
    projectMode?: string
    boardProjectId?: string | null
    sourceSessionKey?: string
  }>>
}

export function isDefaultApplySession(s: InventorySession): boolean {
  if (s.deleted_at) return false
  if (s.archived_at) return false
  if (s.confidence !== 'high' && s.confidence !== 'medium') return false
  const cat = s.category
  return cat === 'personal' || cat === 'commercial' || cat === 'cross'
}

function newOperationId(): string {
  return `ocv5-mig-${Date.now().toString(36)}-${createHash('sha256')
    .update(String(Math.random()))
    .digest('hex')
    .slice(0, 10)}`
}

export async function planProjectLayerMigration(opts: {
  inventory: ProjectLayerInventory
  targetBoardProjectId?: string
  ports: ProjectLayerLivePorts
  agentUid?: number
  agentGid?: number
}): Promise<ProjectLayerPlan> {
  const target =
    opts.targetBoardProjectId ||
    opts.inventory.ocv5ChatFacade?.bindTargetBoardProjectId ||
    OCV5_DEFAULT_BOARD_ID
  if (!BOARD_PROJECT_ID_RE.test(target)) {
    throw new Error(`invalid target board project id: ${target}`)
  }

  const board = await opts.ports.getBoardProject(target)
  const chats = await opts.ports.listChatProjects()
  const facades = chats.filter((c) => !c.deletedAt && c.boardProjectId === target)
  const contextVersion = board ? await opts.ports.getProjectContextVersion(target) : null

  const bindIds = new Set(opts.inventory.sessionMapping.bind_to_ocv5_chat?.ids ?? [])
  const sessions = opts.inventory.sessionMapping.sessions

  const manualReview: ManualReviewItem[] = []
  const defaultApply: InventorySession[] = []

  const considered = bindIds.size > 0 ? sessions.filter((s) => bindIds.has(s.id)) : sessions.filter(isDefaultApplySession)

  for (const s of considered) {
    if (s.deleted_at) {
      manualReview.push({ id: `deleted:${s.id}`, reason: 'deleted_at is not null', sessionId: s.id })
      continue
    }
    if (s.archived_at) {
      manualReview.push({ id: `archived:${s.id}`, reason: 'archived_at is not null — human only', sessionId: s.id })
      continue
    }
    if (s.confidence === 'low') {
      manualReview.push({
        id: `low:${s.id}`,
        reason: 'low-confidence — never default-migrate',
        sessionId: s.id,
        extra: { category: s.category, title: s.title },
      })
      continue
    }
    if (!isDefaultApplySession(s)) {
      manualReview.push({ id: `skip:${s.id}`, reason: 'not high/medium personal|commercial|cross', sessionId: s.id })
      continue
    }
    defaultApply.push(s)
  }

  const operations: PlannedOp[] = []
  const risks: string[] = []

  if (!board) {
    risks.push('target tb_project missing (ghost) — abort apply')
  } else if (board.archivedAt) {
    risks.push('target tb_project is archived — abort apply')
  }
  if (facades.length > 1) {
    risks.push(`multiple live chat facades bound to target (${facades.length}) — abort apply`)
  }

  const facadeName =
    opts.inventory.ocv5ChatFacade?.create?.body?.name || board?.key || 'V5个人版和商业版项目开发'
  if (facades.length === 0) {
    operations.push({
      id: 'OP_CREATE_FACADE',
      op: 'create_chat_facade',
      dryRun: true,
      name: facadeName,
      bindBoardProjectId: target,
    })
    operations.push({
      id: 'OP_BIND_FACADE',
      op: 'bind_chat_facade',
      dryRun: true,
      boardProjectId: target,
    })
  } else {
    operations.push({
      id: 'OP_BIND_FACADE',
      op: 'bind_chat_facade',
      dryRun: true,
      chatProjectId: facades[0].id,
      boardProjectId: target,
    })
  }

  operations.push({
    id: 'OP_ENSURE_CONTEXT',
    op: 'ensure_project_context_dir',
    dryRun: true,
    boardProjectId: target,
  })
  operations.push({
    id: 'OP_REPAIR_OWNERSHIP',
    op: 'repair_project_ownership',
    dryRun: true,
    boardProjectId: target,
    uid: opts.agentUid ?? 1000,
    gid: opts.agentGid ?? 1000,
  })

  const expected: Array<{ id: string; projectId: string | null; updatedAt: number }> = []
  const stale: string[] = []
  for (const s of defaultApply) {
    const live = await opts.ports.getSession(s.id)
    if (!live) {
      stale.push(s.id)
      manualReview.push({ id: `missing:${s.id}`, reason: 'session gone at plan time', sessionId: s.id })
      continue
    }
    if (live.deletedAt) {
      stale.push(s.id)
      manualReview.push({ id: `live-deleted:${s.id}`, reason: 'live deleted_at set', sessionId: s.id })
      continue
    }
    if (live.archivedAt) {
      stale.push(s.id)
      manualReview.push({ id: `live-archived:${s.id}`, reason: 'live archived_at set', sessionId: s.id })
      continue
    }
    const snapProject = s.project_id ?? null
    if (snapProject !== live.projectId) {
      stale.push(s.id)
      manualReview.push({
        id: `drift-project:${s.id}`,
        reason: 'project_id drifted since inventory',
        sessionId: s.id,
        extra: { inventory: snapProject, live: live.projectId },
      })
      continue
    }
    if (typeof s.updated_at === 'number' && s.updated_at !== live.updatedAt) {
      stale.push(s.id)
      manualReview.push({
        id: `drift-updated:${s.id}`,
        reason: 'updated_at drifted since inventory',
        sessionId: s.id,
        extra: { inventory: s.updated_at, live: live.updatedAt },
      })
      continue
    }
    expected.push({ id: live.id, projectId: live.projectId, updatedAt: live.updatedAt })
  }

  if (stale.length) {
    risks.push(`session CAS drift/missing: ${stale.length} ids — whole session move aborts on apply`)
  }

  const moveIds = expected.map((e) => e.id)
  if (moveIds.length) {
    operations.push({
      id: 'OP_MOVE_SESSIONS',
      op: 'move_sessions',
      dryRun: true,
      ids: moveIds,
      expected,
    })
  }

  const excludeSecrets = new Set(opts.inventory.memories?.exclude_secret_slugs ?? [])
  const testCandidates = opts.inventory.memories?.test_candidates ?? []
  for (const c of testCandidates) {
    if (excludeSecrets.has(c.slug)) {
      manualReview.push({ id: `secret-memory:${c.slug}`, reason: 'secret slug excluded from copy' })
      continue
    }
    operations.push({
      id: `OP_MEM_${c.slug}`,
      op: 'copy_memory_candidate',
      dryRun: true,
      slug: c.slug,
      source: c.file,
      sha256: c.hash,
    })
  }
  for (const slug of opts.inventory.memories?.official_promote_slugs ?? []) {
    if (excludeSecrets.has(slug)) continue
    operations.push({
      id: `OP_MEM_CORE_${slug}`,
      op: 'copy_memory_candidate',
      dryRun: true,
      slug,
      source: 'agents/main/memory',
    })
  }

  const excludedSkills = new Set(opts.inventory.skills?.overlay_excluded ?? [])
  const overlay = (opts.inventory.skills?.overlay_proposed ?? []).filter((n) => !excludedSkills.has(n))
  if (overlay.length) {
    operations.push({
      id: 'OP_SKILL_OVERLAY',
      op: 'skill_overlay',
      dryRun: true,
      names: overlay,
    })
  }

  const applyIdSet = new Set(moveIds)
  for (const row of opts.inventory.assets?.local_sqlite_rows ?? []) {
    if (row.verdict !== 'candidate') continue
    if (row.sensitive) {
      manualReview.push({ id: `asset-sensitive:${row.id}`, reason: 'sensitive asset excluded' })
      continue
    }
    const sid = row.session_id ?? ''
    if (!applyIdSet.has(sid)) {
      manualReview.push({
        id: `asset-unmoved:${row.id}`,
        reason: 'asset session not in default apply set',
        sessionId: sid || undefined,
      })
      continue
    }
    if (!row.path || !row.name) continue
    let digest = (row.digest || '').toLowerCase()
    if (opts.ports.sha256File) {
      try {
        digest = (await opts.ports.sha256File(row.path)).toLowerCase()
      } catch (err) {
        manualReview.push({
          id: `asset-hash:${row.id}`,
          reason: `sha256 failed: ${(err as Error).message}`,
        })
        continue
      }
    }
    if (row.digest && row.digest.toLowerCase() !== digest) {
      risks.push(`asset digest mismatch ${row.name}`)
      manualReview.push({
        id: `asset-digest:${row.id}`,
        reason: 'digest mismatch vs live file',
        extra: { expected: row.digest, actual: digest },
      })
      continue
    }
    operations.push({
      id: `OP_ASSET_${row.id ?? digest.slice(0, 8)}`,
      op: 'create_asset',
      dryRun: true,
      name: row.name,
      sessionId: sid,
      containerPath: row.path,
      digest,
      source: 'output',
    })
  }

  if (contextVersion != null && contextVersion > 0) {
    risks.push(`target contextVersion=${contextVersion} — overlay/memory writes must use CAS expectedVersion`)
  }

  const usageRowIds: string[] = []
  if (moveIds.length) {
    if (opts.ports.listNullUsage) {
      const rows = await opts.ports.listNullUsage(moveIds)
      for (const row of rows) usageRowIds.push(row.id)
    }
    operations.push({
      id: 'OP_USAGE_BACKFILL',
      op: 'usage_backfill',
      dryRun: true,
      sessionIds: moveIds,
      boardProjectId: target,
      source: 'migration_backfill',
      rowIds: usageRowIds,
    })
  }

  const cronImpact: ProjectLayerPlan['cronImpact'] = []
  if (opts.ports.listCronJobs) {
    const jobs = await opts.ports.listCronJobs()
    const applySet = new Set(moveIds)
    for (const job of jobs) {
      const origin = job.sourceSessionKey?.match(/:webchat:dm:([A-Za-z0-9_-]{1,64})$/)?.[1] ?? null
      const mode = job.projectMode === 'fixed' ? 'fixed' : 'follow_session'
      if (origin && applySet.has(origin)) {
        cronImpact.push({
          jobId: job.id,
          projectMode: mode,
          originSessionId: origin,
          action: 'manualReview',
          reason: 'origin session in default apply set — cron YAML not auto-changed',
        })
      }
    }
  }

  const bindCount = opts.inventory.sessionMapping.bind_to_ocv5_chat?.ids?.length ?? 0
  const actualApply = moveIds.length
  const actualManualReview = manualReview.length
  const drifted =
    bindCount >= AUTHORITATIVE_BIND_MIN &&
    (actualApply !== AUTHORITATIVE_DEFAULT_APPLY || actualManualReview !== AUTHORITATIVE_MANUAL_REVIEW)
  if (drifted) {
    risks.push(
      `inventory_count_drift apply=${actualApply} expected=${AUTHORITATIVE_DEFAULT_APPLY} manualReview=${actualManualReview} expected=${AUTHORITATIVE_MANUAL_REVIEW} — abort apply`,
    )
  }

  return {
    operationId: newOperationId(),
    targetBoardProjectId: target,
    mode: 'dry-run',
    createdAt: Date.now(),
    defaultApplySessionIds: moveIds,
    operations,
    manualReview,
    risks,
    rollback: {
      sessionRestores: expected.map((e) => ({
        id: e.id,
        projectId: e.projectId,
        updatedAt: e.updatedAt,
      })),
      assetDeletes: [],
      chatFacadeDelete: facades.length === 0,
      forbidden: [
        'drop database',
        'rm -rf projects/',
        'restore whole taskboard.db',
        'touch commercial production',
        'hard-delete sessions',
        'whole-table usage rollback',
      ],
    },
    live: {
      boardExists: Boolean(board),
      boardArchived: Boolean(board?.archivedAt),
      facadeId: facades[0]?.id ?? null,
      facadeUnique: facades.length <= 1,
      contextVersion,
    },
    expectedCounts: {
      defaultApply: AUTHORITATIVE_DEFAULT_APPLY,
      manualReview: AUTHORITATIVE_MANUAL_REVIEW,
      actualApply,
      actualManualReview,
      drifted,
    },
    cronImpact,
    usageBackfill: {
      sessionIds: moveIds,
      rowIds: usageRowIds,
      source: 'migration_backfill',
    },
  }
}

export function assertPlanApplyable(plan: ProjectLayerPlan): void {
  if (!plan.live.boardExists) throw new Error('ghost_project')
  if (plan.live.boardArchived) throw new Error('archived_project')
  if (!plan.live.facadeUnique) throw new Error('facade_not_unique')
  if (plan.manualReview.some((m) => m.reason.includes('drift'))) throw new Error('stale_session')
  if (plan.expectedCounts?.drifted) throw new Error('inventory_count_drift')
}

export type ApplyPorts = ProjectLayerLivePorts & {
  createChatProject(name: string): Promise<{ id: string }>
  bindChatProject(id: string, boardProjectId: string): Promise<void>
  ensureProjectContext(boardProjectId: string): Promise<void>
  batchMoveSessions(input: {
    operationId: string
    ids: string[]
    projectId: string
    expected: Array<{ id: string; projectId: string | null; updatedAt: number }>
  }): Promise<{ ok: true; updated: number } | { ok: false; error: string; staleIds?: string[] }>
  createMemoryCandidate(input: { slug: string; content: string }): Promise<void>
  putSkillOverlay(names: string[], expectedVersion: number): Promise<void>
  createAsset(input: {
    name: string
    sessionId: string
    containerPath: string
    digest: string
    source: 'output' | 'upload'
  }): Promise<{ id: string; created: boolean }>
  deleteAsset(id: string): Promise<void>
  readMemoryContent?(slug: string, file?: string): Promise<string>
  repairOwnership?(boardProjectId: string, uid: number, gid: number): Promise<void>
  backfillUsage?(input: {
    operationId: string
    sessionIds: string[]
    boardProjectId: string
    source: 'migration_backfill'
  }): Promise<Array<{ id: string; oldBoardProjectId: string | null }>>
  restoreUsage?(rows: Array<{ id: string; oldBoardProjectId: string | null }>): Promise<number>
}

export type ApplyResult = {
  ok: boolean
  operationId: string
  applied: string[]
  createdAssetIds: string[]
  facadeId: string | null
  error?: string
  rollback: ProjectLayerPlan['rollback'] & {
    usageRestores?: Array<{ id: string; oldBoardProjectId: string | null }>
  }
}

export async function applyProjectLayerMigration(
  plan: ProjectLayerPlan,
  ports: ApplyPorts,
): Promise<ApplyResult> {
  assertPlanApplyable(plan)
  const applied: string[] = []
  const createdAssetIds: string[] = []
  let facadeId = plan.live.facadeId
  const rollback = {
    ...plan.rollback,
    assetDeletes: [] as string[],
    usageRestores: [] as Array<{ id: string; oldBoardProjectId: string | null }>,
  }
  try {
    for (const op of plan.operations) {
      if (op.op === 'create_chat_facade') {
        const created = await ports.createChatProject(op.name)
        facadeId = created.id
        applied.push(op.id)
      } else if (op.op === 'bind_chat_facade') {
        const id = op.chatProjectId || facadeId
        if (!id) throw new Error('facade_missing')
        await ports.bindChatProject(id, op.boardProjectId)
        facadeId = id
        applied.push(op.id)
      } else if (op.op === 'ensure_project_context_dir') {
        await ports.ensureProjectContext(op.boardProjectId)
        applied.push(op.id)
      } else if (op.op === 'repair_project_ownership') {
        await ports.repairOwnership?.(op.boardProjectId, op.uid, op.gid)
        applied.push(op.id)
      } else if (op.op === 'move_sessions') {
        if (!facadeId) throw new Error('facade_missing')
        const moved = await ports.batchMoveSessions({
          operationId: plan.operationId,
          ids: op.ids,
          projectId: facadeId,
          expected: op.expected,
        })
        if (!moved.ok) throw new Error(moved.error || 'stale_session')
        applied.push(op.id)
      } else if (op.op === 'copy_memory_candidate') {
        const content = (await ports.readMemoryContent?.(op.slug, op.source)) ?? ''
        if (!content) {
          continue
        }
        await ports.createMemoryCandidate({ slug: op.slug, content })
        applied.push(op.id)
      } else if (op.op === 'skill_overlay') {
        await ports.putSkillOverlay(op.names, plan.live.contextVersion ?? 0)
        applied.push(op.id)
      } else if (op.op === 'create_asset') {
        const asset = await ports.createAsset(op)
        createdAssetIds.push(asset.id)
        rollback.assetDeletes.push(asset.id)
        applied.push(op.id)
      } else if (op.op === 'usage_backfill') {
        if (ports.backfillUsage) {
          const rows = await ports.backfillUsage({
            operationId: plan.operationId,
            sessionIds: op.sessionIds,
            boardProjectId: op.boardProjectId,
            source: 'migration_backfill',
          })
          rollback.usageRestores.push(...rows)
        }
        applied.push(op.id)
      }
    }
    return {
      ok: true,
      operationId: plan.operationId,
      applied,
      createdAssetIds,
      facadeId,
      rollback,
    }
  } catch (err) {
    await compensateProjectLayerMigration(
      {
        ok: false,
        operationId: plan.operationId,
        applied,
        createdAssetIds,
        facadeId,
        error: (err as Error).message,
        rollback,
      },
      ports,
    )
    return {
      ok: false,
      operationId: plan.operationId,
      applied,
      createdAssetIds,
      facadeId,
      error: (err as Error).message,
      rollback,
    }
  }
}

export async function compensateProjectLayerMigration(
  result: ApplyResult,
  ports: Pick<ApplyPorts, 'batchMoveSessions' | 'deleteAsset' | 'restoreUsage'>,
): Promise<void> {
  const usageRestores = result.rollback.usageRestores ?? []
  if (usageRestores.length && ports.restoreUsage) {
    await ports.restoreUsage(usageRestores).catch(() => {})
  }
  for (const id of [...result.rollback.assetDeletes].reverse()) {
    await ports.deleteAsset(id).catch(() => {})
  }
  if (result.rollback.sessionRestores.length) {
    const byDest = new Map<string, Array<{ id: string; projectId: string | null; updatedAt: number }>>()
    for (const row of result.rollback.sessionRestores) {
      const key = row.projectId ?? ''
      const list = byDest.get(key) ?? []
      list.push(row)
      byDest.set(key, list)
    }
    for (const [dest, rows] of byDest) {
      await ports.batchMoveSessions({
        operationId: `${result.operationId}-rollback`,
        ids: rows.map((r) => r.id),
        projectId: dest,
        expected: rows,
      }).catch(() => {})
    }
  }
}

export async function repairProjectDirOwnership(opts: {
  boardProjectId: string
  uid: number
  gid: number
  home?: string
  dryRun?: boolean
  chownImpl?: (path: string, uid: number, gid: number) => Promise<void>
}): Promise<{ changed: string[]; skipped: string[] }> {
  if (!BOARD_PROJECT_ID_RE.test(opts.boardProjectId)) {
    throw new Error('invalid board project id')
  }
  const root = projectContextDir(opts.boardProjectId)
  const changed: string[] = []
  const skipped: string[] = []
  let st
  try {
    st = await lstat(root)
  } catch {
    return { changed, skipped: [root] }
  }
  if (!st.isDirectory() || st.isSymbolicLink()) {
    skipped.push(root)
    return { changed, skipped }
  }
  const queue = [root]
  while (queue.length) {
    const dir = queue.pop()!
    const entries = await readdir(dir, { withFileTypes: true })
    for (const ent of entries) {
      const p = join(dir, ent.name)
      if (ent.isSymbolicLink()) {
        skipped.push(p)
        continue
      }
      if (ent.isDirectory()) queue.push(p)
      const rel = p.slice(root.length)
      if (rel.includes('..')) {
        skipped.push(p)
        continue
      }
      changed.push(p)
      if (!opts.dryRun && opts.chownImpl) await opts.chownImpl(p, opts.uid, opts.gid)
      if (!opts.dryRun) await chmod(p, 0o750).catch(() => {})
    }
  }
  changed.unshift(root)
  if (!opts.dryRun && opts.chownImpl) await opts.chownImpl(root, opts.uid, opts.gid)
  if (!opts.dryRun) await chmod(root, 0o750).catch(() => {})
  return { changed, skipped }
}

export function sessionProjectFilterSql(
  projectId: string | null | undefined,
  alias = 'cs',
): { sql: string; params: unknown[] } {
  if (projectId === undefined) return { sql: '', params: [] }
  if (projectId === null) return { sql: ` AND ${alias}.project_id IS NULL`, params: [] }
  return { sql: ` AND ${alias}.project_id = ?`, params: [projectId] }
}
