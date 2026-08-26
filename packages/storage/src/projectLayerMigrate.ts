/**
 * OCV5 project-layer migration coordinator.
 * Default mode is dry-run. Apply is explicit, CAS-gated, compensating rollback only.
 * Does not create a second tb_project. Does not auto-promote memories.
 */

import { createHash } from 'node:crypto'
import { readFile as fsReadFile, realpath as fsRealpath, chmod, lstat, readdir } from 'node:fs/promises'
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
    test_candidates?: Array<{
      slug: string
      file?: string
      hash?: string
      content?: string
      absPath?: string
      projectId?: string
    }>
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

/** Unique people/sessions in manualReview. Duplicate asset-unmoved on an already-listed session does not add a person. */
export function summarizeManualReview(items: readonly ManualReviewItem[]): {
  rows: number
  people: number
  uniqueSessions: number
  anonymousRows: number
  duplicateSessionRows: number
} {
  const seen = new Set<string>()
  let uniqueSessions = 0
  let anonymousRows = 0
  let duplicateSessionRows = 0
  for (const item of items) {
    const sid = item.sessionId?.trim()
    if (!sid) {
      anonymousRows += 1
      continue
    }
    if (seen.has(sid)) {
      duplicateSessionRows += 1
      continue
    }
    seen.add(sid)
    uniqueSessions += 1
  }
  return {
    rows: items.length,
    people: uniqueSessions + anonymousRows,
    uniqueSessions,
    anonymousRows,
    duplicateSessionRows,
  }
}

export type DriftReason = {
  kind: string
  detail: string
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
    actualManualReviewRows: number
    drifted: boolean
    driftReasons: DriftReason[]
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
    rows: Array<{
      id: string
      sessionId: string | null
      parentSessionId: string | null
      boardProjectId: string | null
      source: string | null
    }>
    queried: boolean
    source: 'migration_backfill'
  }
}

export type ProjectLayerLivePorts = {
  getBoardProject(id: string): Promise<LiveBoardProject | null>
  listChatProjects(): Promise<LiveChatProject[]>
  getSession(id: string): Promise<LiveSessionSnapshot | null>
  getProjectContextVersion(id: string): Promise<number | null>
  sha256File?(absPath: string): Promise<string>
  listNullUsage?(sessionIds: string[]): Promise<
    Array<{
      id: string
      sessionId: string | null
      parentSessionId: string | null
      boardProjectId?: string | null
      source?: string | null
    }>
  >
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
    id: 'OP_REPAIR_OWNERSHIP',
    op: 'repair_project_ownership',
    dryRun: true,
    boardProjectId: target,
    uid: opts.agentUid ?? 1000,
    gid: opts.agentGid ?? 1000,
  })
  operations.push({
    id: 'OP_ENSURE_CONTEXT',
    op: 'ensure_project_context_dir',
    dryRun: true,
    boardProjectId: target,
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
    if (row.verdict !== 'promote' && row.verdict !== 'candidate') continue
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

  const usageRows: ProjectLayerPlan['usageBackfill']['rows'] = []
  let usageQueried = false
  if (moveIds.length) {
    if (opts.ports.listNullUsage) {
      usageQueried = true
      const rows = await opts.ports.listNullUsage(moveIds)
      for (const row of rows) {
        usageRows.push({
          id: row.id,
          sessionId: row.sessionId,
          parentSessionId: row.parentSessionId,
          boardProjectId: row.boardProjectId ?? null,
          source: row.source ?? null,
        })
      }
    }
    operations.push({
      id: 'OP_USAGE_BACKFILL',
      op: 'usage_backfill',
      dryRun: true,
      sessionIds: moveIds,
      boardProjectId: target,
      source: 'migration_backfill',
      rowIds: usageRows.map((r) => r.id),
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
  const reviewSummary = summarizeManualReview(manualReview)
  const actualManualReview = reviewSummary.people
  const driftReasons: DriftReason[] = []
  if (reviewSummary.duplicateSessionRows) {
    driftReasons.push({
      kind: 'manualReview_duplicate_session_rows',
      detail: 'asset-unmoved (or other) rows that share a sessionId already counted in low/archived do not add people',
      extra: {
        rows: reviewSummary.rows,
        people: reviewSummary.people,
        duplicateSessionRows: reviewSummary.duplicateSessionRows,
      },
    })
  }
  const drifted =
    bindCount >= AUTHORITATIVE_BIND_MIN &&
    (actualApply !== AUTHORITATIVE_DEFAULT_APPLY || actualManualReview !== AUTHORITATIVE_MANUAL_REVIEW)
  if (drifted) {
    if (actualApply !== AUTHORITATIVE_DEFAULT_APPLY) {
      driftReasons.push({
        kind: 'apply_count',
        detail: `apply ${actualApply} != sealed ${AUTHORITATIVE_DEFAULT_APPLY}`,
      })
    }
    if (actualManualReview !== AUTHORITATIVE_MANUAL_REVIEW) {
      driftReasons.push({
        kind: 'manualReview_people',
        detail: `manualReview people ${actualManualReview} != sealed ${AUTHORITATIVE_MANUAL_REVIEW}`,
        extra: { rows: reviewSummary.rows, people: reviewSummary.people },
      })
    }
    risks.push(
      `inventory_count_drift apply=${actualApply} expected=${AUTHORITATIVE_DEFAULT_APPLY} manualReviewPeople=${actualManualReview} rows=${reviewSummary.rows} expectedPeople=${AUTHORITATIVE_MANUAL_REVIEW} — abort apply`,
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
      actualManualReviewRows: reviewSummary.rows,
      drifted,
      driftReasons,
    },
    cronImpact,
    usageBackfill: {
      sessionIds: moveIds,
      rowIds: usageRows.map((r) => r.id),
      rows: usageRows,
      queried: usageQueried,
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

export type SessionCasRow = { id: string; projectId: string | null; updatedAt: number }

export type ApplyPorts = ProjectLayerLivePorts & {
  createChatProject(name: string): Promise<{ id: string; created?: boolean }>
  bindChatProject(
    id: string,
    boardProjectId: string | null,
  ): Promise<{ old: string | null; new: string | null }>
  ensureProjectContext(boardProjectId: string): Promise<{ created: boolean; version: number }>
  batchMoveSessions(input: {
    operationId: string
    ids: string[]
    projectId: string | null
    expected: SessionCasRow[]
    allowNullProject?: boolean
  }): Promise<
    | {
        ok: true
        updated: number
        post: Array<SessionCasRow & { oldProjectId?: string | null; oldUpdatedAt?: number }>
      }
    | { ok: false; error: string; staleIds?: string[] }
  >
  createMemoryCandidate(input: {
    slug: string
    content: string
  }): Promise<{ id: string; version: number; hash: string }>
  rejectMemoryCandidate?(input: { id: string; version: number; slug?: string }): Promise<void>
  putSkillOverlay(
    names: string[],
    expectedVersion: number,
  ): Promise<{ old: string[]; new: string[] }>
  createAsset(input: {
    name: string
    sessionId: string
    containerPath: string
    digest: string
    source: 'output' | 'upload'
    projectId?: string
  }): Promise<{ id: string; created: boolean; reused?: boolean }>
  deleteAsset(id: string): Promise<void>
  readMemoryContent?(slug: string, file?: string, expectedSha256?: string): Promise<string>
  repairOwnership?(boardProjectId: string, uid: number, gid: number): Promise<void>
  searchMemoryMarker?(marker: string): Promise<boolean>
  backfillUsage?(input: {
    operationId: string
    sessionIds: string[]
    rowIds: string[]
    boardProjectId: string
    source: 'migration_backfill'
    planned?: number
  }): Promise<
    Array<{
      id: string
      oldBoardProjectId: string | null
      newBoardProjectId?: string | null
      postBoardProjectId?: string | null
    }>
  >
  restoreUsage?(
    rows: Array<{
      id: string
      oldBoardProjectId: string | null
      postBoardProjectId?: string | null
      newBoardProjectId?: string | null
    }>,
  ): Promise<number>
}

export type ApplyResult = {
  ok: boolean
  operationId: string
  applied: string[]
  createdAssetIds: string[]
  facadeId: string | null
  error?: string
  manifest: {
    facadeCreate: { id: string } | null
    bind: { old: string | null; new: string | null } | null
    context: { created: boolean; version: number } | null
    memoryCandidates: Array<{ id: string; version: number; hash: string; slug: string }>
    skillOverlay: { old: string[]; new: string[] } | null
  }
  rollback: ProjectLayerPlan['rollback'] & {
    usageRestores?: Array<{
      id: string
      oldBoardProjectId: string | null
      postBoardProjectId?: string | null
      newBoardProjectId?: string | null
    }>
    memoryRejects?: Array<{ id: string; version: number; slug: string }>
    skillOverlayOld?: string[]
    bindOld?: string | null
  }
}

export const MEMORY_ALLOW_ROOTS = [
  '/home/agent/.openclaude',
  '/var/lib/docker/volumes/oc-v5-data-u3/_data',
]

export function isPathInsideRoot(resolved: string, root: string): boolean {
  const normalized = resolved.endsWith('/') ? resolved.slice(0, -1) : resolved
  const base = root.endsWith('/') ? root.slice(0, -1) : root
  return normalized === base || normalized.startsWith(`${base}/`)
}

export async function readMemoryContent(opts: {
  slug: string
  file?: string
  expectedSha256?: string
  allowlist: Array<{
    slug: string
    file?: string
    hash?: string
    absPath?: string
    projectId?: string
  }>
  roots?: string[]
  readFileImpl?: (p: string) => Promise<Buffer>
  realpathImpl?: (p: string) => Promise<string>
}): Promise<string> {
  const hit = opts.allowlist.find((row) => row.slug === opts.slug || (opts.file && row.file === opts.file))
  if (!hit) throw new Error('memory_not_allowlisted')
  const roots = opts.roots ?? MEMORY_ALLOW_ROOTS
  const file = hit.file || opts.file || opts.slug
  const testId = hit.projectId || 'b12fc2f7-c466-49de-892b-b44326b782c4'
  const candidates: string[] = []
  if (hit.absPath) candidates.push(hit.absPath)
  for (const root of roots) {
    candidates.push(join(root, 'projects', testId, 'memory-candidates', file))
    candidates.push(join(root, 'memory', 'agents', 'main', 'memory', opts.slug))
    candidates.push(join(root, 'memory', 'agents', 'main', 'memory', `${opts.slug}.md`))
    candidates.push(join(root, 'agents', 'main', 'memory', opts.slug))
    candidates.push(join(root, 'agents', 'main', 'memory', `${opts.slug}.md`))
  }
  const realpathImpl = opts.realpathImpl ?? ((p: string) => fsRealpath(p))
  const readImpl = opts.readFileImpl ?? ((p: string) => fsReadFile(p))
  let lastErr: Error | null = null
  for (const cand of candidates) {
    try {
      const resolved = await realpathImpl(cand)
      if (!roots.some((root) => isPathInsideRoot(resolved, root))) {
        throw new Error('memory_path_escape')
      }
      const buf = await readImpl(resolved)
      const hash = createHash('sha256').update(buf).digest('hex')
      const expected = (opts.expectedSha256 || hit.hash || '').toLowerCase()
      if (expected && hash !== expected) throw new Error('memory_hash_mismatch')
      return buf.toString('utf8')
    } catch (err) {
      const msg = (err as Error).message
      if (msg === 'memory_hash_mismatch' || msg === 'memory_path_escape') throw err
      lastErr = err as Error
    }
  }
  throw lastErr ?? new Error('memory_not_found')
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

export async function applyProjectLayerMigration(
  plan: ProjectLayerPlan,
  ports: ApplyPorts,
): Promise<ApplyResult> {
  assertPlanApplyable(plan)
  const applied: string[] = []
  const createdAssetIds: string[] = []
  let facadeId = plan.live.facadeId
  const manifest = emptyManifest()
  const rollback: ApplyResult['rollback'] = {
    ...plan.rollback,
    sessionRestores: [],
    assetDeletes: [],
    usageRestores: [],
    memoryRejects: [],
    skillOverlayOld: [],
    bindOld: undefined,
  }
  const fail = (err: unknown): ApplyResult => ({
    ok: false,
    operationId: plan.operationId,
    applied,
    createdAssetIds,
    facadeId,
    error: (err as Error).message,
    manifest,
    rollback,
  })
  try {
    for (const op of plan.operations) {
      if (op.op === 'create_chat_facade') {
        const created = await ports.createChatProject(op.name)
        facadeId = created.id
        manifest.facadeCreate = { id: created.id }
        applied.push(op.id)
      } else if (op.op === 'bind_chat_facade') {
        const fromOp =
          op.chatProjectId && op.chatProjectId !== op.boardProjectId ? op.chatProjectId : undefined
        const fromLive = facadeId && facadeId !== op.boardProjectId ? facadeId : undefined
        const id = fromOp || fromLive
        if (!id) throw new Error('facade_missing')
        const bound = await ports.bindChatProject(id, op.boardProjectId)
        facadeId = id
        manifest.bind = { old: bound.old, new: bound.new }
        rollback.bindOld = bound.old
        applied.push(op.id)
      } else if (op.op === 'repair_project_ownership') {
        await ports.repairOwnership?.(op.boardProjectId, op.uid, op.gid)
        applied.push(op.id)
      } else if (op.op === 'ensure_project_context_dir') {
        const ctx = await ports.ensureProjectContext(op.boardProjectId)
        manifest.context = { created: ctx.created, version: ctx.version }
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
        rollback.sessionRestores = moved.post.map((row) => ({
          id: row.id,
          projectId: row.oldProjectId ?? op.expected.find((e) => e.id === row.id)?.projectId ?? null,
          updatedAt: row.updatedAt,
        }))
        applied.push(op.id)
      } else if (op.op === 'copy_memory_candidate') {
        let content: string | undefined
        try {
          content = await ports.readMemoryContent?.(op.slug, op.source, op.sha256)
        } catch (err) {
          const msg = (err as Error).message || ''
          if (msg === 'memory_not_found' || msg.includes('ENOENT')) continue
          throw err
        }
        if (!content) continue
        const cand = await ports.createMemoryCandidate({ slug: op.slug, content })
        manifest.memoryCandidates.push({
          id: cand.id,
          version: cand.version,
          hash: cand.hash,
          slug: op.slug,
        })
        rollback.memoryRejects?.push({ id: cand.id, version: cand.version, slug: op.slug })
        const marker = content.slice(0, 80)
        if (ports.searchMemoryMarker) {
          const hit = await ports.searchMemoryMarker(marker || op.slug)
          if (!hit) throw new Error('memory_search_miss')
        }
        applied.push(op.id)
      } else if (op.op === 'skill_overlay') {
        const overlay = await ports.putSkillOverlay(op.names, plan.live.contextVersion ?? 0)
        manifest.skillOverlay = overlay
        rollback.skillOverlayOld = overlay.old
        applied.push(op.id)
      } else if (op.op === 'create_asset') {
        if (!facadeId) throw new Error('facade_missing')
        const asset = await ports.createAsset({ ...op, projectId: facadeId })
        if (asset.created) {
          createdAssetIds.push(asset.id)
          rollback.assetDeletes.push(asset.id)
        }
        applied.push(op.id)
      } else if (op.op === 'usage_backfill') {
        const rowIds = op.rowIds ?? []
        if (ports.backfillUsage && rowIds.length) {
          const rows = await ports.backfillUsage({
            operationId: plan.operationId,
            sessionIds: op.sessionIds,
            rowIds,
            boardProjectId: op.boardProjectId,
            source: 'migration_backfill',
            planned: rowIds.length,
          })
          ;(rollback.usageRestores ??= []).push(
            ...rows.map((row) => ({
              ...row,
              postBoardProjectId: row.postBoardProjectId ?? row.newBoardProjectId ?? op.boardProjectId,
            })),
          )
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
      manifest,
      rollback,
    }
  } catch (err) {
    const failed = fail(err)
    await compensateProjectLayerMigration(failed, ports)
    return failed
  }
}

export async function compensateProjectLayerMigration(
  result: ApplyResult,
  ports: Pick<ApplyPorts, 'batchMoveSessions' | 'deleteAsset'> &
    Partial<Pick<ApplyPorts, 'restoreUsage' | 'rejectMemoryCandidate' | 'putSkillOverlay' | 'bindChatProject'>>,
): Promise<void> {
  const usageRestores = result.rollback.usageRestores ?? []
  if (usageRestores.length && ports.restoreUsage) {
    await ports.restoreUsage(usageRestores)
  }
  for (const id of [...result.rollback.assetDeletes].reverse()) {
    await ports.deleteAsset(id)
  }
  for (const cand of [...(result.rollback.memoryRejects ?? [])].reverse()) {
    if (!ports.rejectMemoryCandidate) throw new Error('memory_reject_port_missing')
    await ports.rejectMemoryCandidate(cand)
  }
  if (result.rollback.skillOverlayOld && ports.putSkillOverlay && result.manifest.skillOverlay) {
    await ports.putSkillOverlay(result.rollback.skillOverlayOld, result.manifest.context?.version ?? 0)
  }
  if (result.rollback.sessionRestores.length) {
    const byDest = new Map<string, SessionCasRow[]>()
    for (const row of result.rollback.sessionRestores) {
      const key = row.projectId === null ? '__NULL__' : row.projectId
      const list = byDest.get(key) ?? []
      list.push(row)
      byDest.set(key, list)
    }
    for (const [key, rows] of byDest) {
      const dest = key === '__NULL__' ? null : key
      const moved = await ports.batchMoveSessions({
        operationId: `${result.operationId}-rollback`,
        ids: rows.map((r) => r.id),
        projectId: dest,
        expected: rows,
        allowNullProject: dest === null,
      })
      if (!moved.ok) throw new Error(moved.error || 'session_compensate_failed')
    }
  }
  if (result.rollback.bindOld !== undefined && result.manifest.bind?.new && ports.bindChatProject) {
    await ports.bindChatProject(result.manifest.bind.new, result.rollback.bindOld)
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
