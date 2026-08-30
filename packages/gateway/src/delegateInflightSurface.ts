/**
 * OCV5-22 R2: session-level inflight delegate surface (design v3 §N4).
 *
 * Decoupled from parent turn_status working-detail. Flag
 * OC_DELEGATE_INFLIGHT_SURFACE defaults off. Authority remains the job row;
 * this store is a fail-open projection (goal / runId / liveHint / bounded
 * folded DurableAgentGroup). Job-store terminal projections may correct a
 * previous surface terminal; runner fold / stale overlay may not. Queue-full
 * drops persist a durable tombstone so another gateway cannot resurrect the
 * row. I/O errors never throw into the delegate / Completer / Notifier chain.
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import {
  isDelegateTerminalState,
  isLegalDelegateTransition,
  type DelegateJobState,
  type InflightDelegateSurface,
} from '@openclaude/protocol'
import type { DurableAgentGroup } from '@openclaude/protocol'

import { resolveDelegateJobsDbPath } from './delegateDurable.js'
import { DEFAULT_DELEGATE_JOB_TTL_MS, type DelegateJobSnapshot } from './delegateJobs.js'
import { createLogger } from './logger.js'

const log = createLogger({ module: 'delegate-inflight-surface' })

export const SURFACE_SCHEMA_VERSION = 3
/** 1 = job-store CAS winner projection; 0 = runner fold / live overlay. */
const AUTHORITY_JOB_STORE = 1
const AUTHORITY_PROJECTION = 0

export const INFLIGHT_FOLDED_GROUP_MAX_BYTES = 16 * 1024
export const INFLIGHT_GET_DEFAULT_LIMIT = 20
export const INFLIGHT_GET_MAX_LIMIT = 50
export const INFLIGHT_GET_MAX_RESPONSE_BYTES = 256 * 1024
export const INFLIGHT_MAX_TERMINAL_ROWS_PER_SESSION = 32
export const INFLIGHT_GOAL_MAX_CHARS = 4_000
export const INFLIGHT_LIVE_HINT_MAX_CHARS = 2_000
export const INFLIGHT_RESULT_SUMMARY_MAX_CHARS = 2_048
/** Auxiliary projection must never stall the gateway event loop on a lock. */
export const INFLIGHT_SURFACE_BUSY_TIMEOUT_MS = 0

const TERMINAL_SQL = `'completed','failed','cancelled','killed_by_cutover'`

const DDL = `
CREATE TABLE IF NOT EXISTS inflight_delegate_surface (
  job_id TEXT PRIMARY KEY,
  parent_session_key TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  user_id TEXT NOT NULL DEFAULT '',
  run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,
  live_hint TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  fencing_epoch INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 0,
  folded_group_json TEXT,
  payload_truncated INTEGER NOT NULL DEFAULT 0,
  payload_bytes INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  nested INTEGER NOT NULL DEFAULT 0,
  owner_run_id TEXT NOT NULL DEFAULT '',
  tombstoned INTEGER NOT NULL DEFAULT 0,
  authority INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_inflight_surface_parent
  ON inflight_delegate_surface(parent_session_key);
CREATE INDEX IF NOT EXISTS idx_inflight_surface_user_session
  ON inflight_delegate_surface(user_id, session_id);
CREATE INDEX IF NOT EXISTS idx_inflight_surface_expires
  ON inflight_delegate_surface(expires_at);
`

type SurfaceRow = InflightDelegateSurface & {
  userId: string
  sessionId: string
  fencingEpoch: number
  generation: number
  payloadBytes: number
  expiresAt: number | null
  authority: number
  tombstoned?: boolean
}

export function resolveDelegateInflightSurfaceDbPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.OPENCLAUDE_DELEGATE_INFLIGHT_DB?.trim()
  if (override) return override
  return join(dirname(resolveDelegateJobsDbPath(env)), 'delegate-inflight-surface.db')
}

/** INC-20260827-PHASE-B-DEFER-VANISH: a deferred stub is not exact process. */
export function isDeferredExactProcessStub(group: unknown): boolean {
  if (!group || typeof group !== 'object' || Array.isArray(group)) return false
  return (group as { _payloadDeferred?: unknown })._payloadDeferred === true
}

export function stripDeferredStubBit<T extends object>(group: T): T {
  if (!('_payloadDeferred' in group)) return group
  const clone = { ...group } as T & { _payloadDeferred?: unknown }
  delete clone._payloadDeferred
  return clone
}

export type FoldTerminalResult =
  | { folded: true; surface: InflightDelegateSurface }
  | { folded: false; reason: 'missing' | 'deferred_stub' }

export type InflightEnqueueInput = {
  jobId: string
  parentSessionKey: string
  agentId: string
  goal?: string
  runId?: string
  state?: DelegateJobState
  liveHint?: string
  userId?: string
  fencingEpoch?: number
  generation?: number
  nested?: boolean
  ownerRunId?: string
  preserveIdentity?: boolean
  /** Job-store CAS winner projection; allows correcting a previous terminal. */
  authoritative?: boolean
}

function defaultRunId(jobId: string): string {
  return `dlg-${jobId}`
}

export function sessionIdFromParentKey(parentSessionKey: string): string {
  if (!parentSessionKey) return ''
  const last = parentSessionKey.split(':').pop()
  return last || parentSessionKey
}

function clampText(value: string | undefined, max: number): string {
  if (!value) return ''
  return value.length <= max ? value : value.slice(0, max)
}

function cloneSurface(row: SurfaceRow): InflightDelegateSurface {
  const out: InflightDelegateSurface = {
    jobId: row.jobId,
    runId: row.runId,
    agentId: row.agentId,
    goal: row.goal,
    state: row.state,
    liveHint: row.liveHint,
    updatedAt: row.updatedAt,
    parentSessionKey: row.parentSessionKey,
    ...(row.foldedGroup ? { foldedGroup: structuredClone(row.foldedGroup) } : {}),
  }
  if (row.truncated) out.truncated = true
  if (row.nested) out.nested = true
  if (row.ownerRunId) out.ownerRunId = row.ownerRunId
  return out
}

function publicView(row: SurfaceRow): InflightDelegateSurface {
  const out = cloneSurface(row)
  if (out.foldedGroup) {
    const bounded = boundFoldedGroup(out.foldedGroup)
    out.foldedGroup = bounded.group
    if (bounded.truncated) out.truncated = true
  }
  return out
}

function cloneRow(row: SurfaceRow): SurfaceRow {
  return {
    ...row,
    foldedGroup: row.foldedGroup ? structuredClone(row.foldedGroup) : undefined,
    authority: row.authority ?? AUTHORITY_PROJECTION,
  }
}

export function parentKeyMatchesSessionId(parentSessionKey: string, sessionId: string): boolean {
  if (!parentSessionKey || !sessionId) return false
  if (parentSessionKey === sessionId) return true
  if (parentSessionKey.endsWith(`:${sessionId}`)) return true
  return sessionIdFromParentKey(parentSessionKey) === sessionId
}

export function boundFoldedGroup(
  group: DurableAgentGroup,
  maxBytes: number = INFLIGHT_FOLDED_GROUP_MAX_BYTES,
): { group: DurableAgentGroup; truncated: boolean; bytes: number } {
  const clone = stripDeferredStubBit(structuredClone(group))
  // Never persist the INC deferred-stub bit: a truncated summary is not exact process.
  if ('_payloadDeferred' in clone) {
    delete (clone as { _payloadDeferred?: unknown })._payloadDeferred
  }
  if (clone.goal) clone.goal = clampText(clone.goal, INFLIGHT_GOAL_MAX_CHARS)
  if (clone.resultSummary) {
    clone.resultSummary = clampText(clone.resultSummary, INFLIGHT_RESULT_SUMMARY_MAX_CHARS)
  }
  const encoded = Buffer.byteLength(JSON.stringify(clone), 'utf8')
  if (encoded <= maxBytes) return { group: clone, truncated: false, bytes: encoded }
  const summary: DurableAgentGroup = {
    runId: clone.runId,
    agentId: clone.agentId,
    goal: clampText(clone.goal, INFLIGHT_GOAL_MAX_CHARS),
    status: clone.status,
    completedAt: clone.completedAt,
    ...(clone.resultSummary ? { resultSummary: clone.resultSummary } : {}),
    ...(clone.verdict ? { verdict: clone.verdict } : {}),
  }
  let bytes = Buffer.byteLength(JSON.stringify(summary), 'utf8')
  if (bytes > maxBytes && summary.resultSummary) {
    summary.resultSummary = clampText(summary.resultSummary, 256)
    bytes = Buffer.byteLength(JSON.stringify(summary), 'utf8')
  }
  if (bytes > maxBytes && summary.goal) {
    summary.goal = clampText(summary.goal, 256)
    bytes = Buffer.byteLength(JSON.stringify(summary), 'utf8')
  }
  return { group: summary, truncated: true, bytes }
}

export function summaryGroupFromJob(
  job: DelegateJobSnapshot,
  existing?: Pick<InflightDelegateSurface, 'runId' | 'goal' | 'agentId'>,
): DurableAgentGroup {
  const body = job.result?.body ?? {}
  const output = typeof body.output === 'string' ? body.output : ''
  const error =
    typeof body.error === 'string'
      ? body.error
      : typeof job.failureDetail === 'string'
        ? job.failureDetail
        : ''
  const ok = job.state === 'completed'
  return {
    runId: existing?.runId || defaultRunId(job.id),
    agentId: existing?.agentId || job.agentId,
    goal: existing?.goal || '',
    status: ok ? 'ok' : 'failed',
    resultSummary: clampText(ok ? output || error : error || output, INFLIGHT_RESULT_SUMMARY_MAX_CHARS),
    completedAt: job.lastActivityAt ?? job.createdAt ?? Date.now(),
  }
}

function canAdvanceState(
  from: DelegateJobState,
  to: DelegateJobState,
  opts: { authoritative?: boolean } = {},
): boolean {
  if (from === to) return true
  if (isDelegateTerminalState(from) && !isDelegateTerminalState(to)) return false
  if (isDelegateTerminalState(from) && isDelegateTerminalState(to)) {
    // Read model follows the job-store CAS winner, not "first writer wins".
    // Runner fold / stale overlay cannot replace a different terminal.
    return opts.authoritative === true
  }
  return isLegalDelegateTransition(from, to)
}

function fenceBeats(
  incoming: { fencingEpoch: number; generation: number },
  existing: { fencingEpoch: number; generation: number },
): boolean {
  if (incoming.fencingEpoch > existing.fencingEpoch) return true
  if (incoming.fencingEpoch < existing.fencingEpoch) return false
  return incoming.generation >= existing.generation
}

export class DelegateInflightSurfaceStore {
  readonly path: string | null
  writeFailures = 0
  private readonly now: () => number
  private readonly terminalTtlMs: number
  private readonly maxTerminalPerSession: number
  private readonly foldedMaxBytes: number
  private readonly onWriteError?: (err: unknown, ctx: Record<string, unknown>) => void
  private readonly byJob = new Map<string, SurfaceRow>()
  /** Queue-full / explicit drops. Backed by durable tombstone rows. */
  private readonly droppedJobs = new Set<string>()
  private db: InstanceType<typeof Database> | null = null
  private upsertStmt: ReturnType<InstanceType<typeof Database>['prepare']> | null = null
  private tombstoneStmt: ReturnType<InstanceType<typeof Database>['prepare']> | null = null
  private deleteStmt: ReturnType<InstanceType<typeof Database>['prepare']> | null = null
  private loadStmt: ReturnType<InstanceType<typeof Database>['prepare']> | null = null
  private closed = false

  constructor(
    opts: {
      dbPath?: string | null
      now?: () => number
      terminalTtlMs?: number
      maxTerminalPerSession?: number
      foldedMaxBytes?: number
      onWriteError?: (err: unknown, ctx: Record<string, unknown>) => void
    } = {},
  ) {
    this.now = opts.now ?? Date.now
    this.terminalTtlMs = opts.terminalTtlMs ?? DEFAULT_DELEGATE_JOB_TTL_MS
    this.maxTerminalPerSession = opts.maxTerminalPerSession ?? INFLIGHT_MAX_TERMINAL_ROWS_PER_SESSION
    this.foldedMaxBytes = opts.foldedMaxBytes ?? INFLIGHT_FOLDED_GROUP_MAX_BYTES
    this.onWriteError = opts.onWriteError
    this.path = opts.dbPath === undefined ? resolveDelegateInflightSurfaceDbPath() : opts.dbPath
    if (this.path) {
      try {
        this.openDb(this.path)
      } catch (err) {
        this.noteWriteError(err, { phase: 'open', dbPath: this.path })
        this.db = null
        this.upsertStmt = null
        this.tombstoneStmt = null
        this.deleteStmt = null
        this.loadStmt = null
      }
    }
  }

  private noteWriteError(err: unknown, ctx: Record<string, unknown>): void {
    this.writeFailures += 1
    try {
      this.onWriteError?.(err, ctx)
    } catch {
      /* listener must not poison the projection */
    }
    log.warn('inflight surface write failed', { ...ctx, writeFailures: this.writeFailures }, err)
  }

  private openDb(dbPath: string): void {
    mkdirSync(dirname(dbPath), { recursive: true })
    const db = new Database(dbPath)
    try {
      // Non-authoritative projection: never stall the gateway event loop on
      // writer-lock contention. SQLITE_BUSY fails immediately and is counted.
      db.pragma(`busy_timeout = ${INFLIGHT_SURFACE_BUSY_TIMEOUT_MS}`)
      db.pragma('journal_mode = WAL')
      this.migrate(db)
      this.db = db
      this.upsertStmt = db.prepare(`
        INSERT INTO inflight_delegate_surface (
          job_id, parent_session_key, session_id, user_id, run_id, agent_id, goal, state,
          live_hint, updated_at, fencing_epoch, generation, folded_group_json,
          payload_truncated, payload_bytes, expires_at, nested, owner_run_id,
          tombstoned, authority
        ) VALUES (
          @job_id, @parent_session_key, @session_id, @user_id, @run_id, @agent_id, @goal, @state,
          @live_hint, @updated_at, @fencing_epoch, @generation, @folded_group_json,
          @payload_truncated, @payload_bytes, @expires_at, @nested, @owner_run_id,
          0, @authority
        )
        ON CONFLICT(job_id) DO UPDATE SET
          parent_session_key=excluded.parent_session_key,
          session_id=excluded.session_id,
          user_id=CASE
            WHEN excluded.user_id != '' THEN excluded.user_id
            ELSE inflight_delegate_surface.user_id
          END,
          run_id=excluded.run_id,
          agent_id=excluded.agent_id,
          goal=excluded.goal,
          state=excluded.state,
          live_hint=excluded.live_hint,
          updated_at=excluded.updated_at,
          fencing_epoch=excluded.fencing_epoch,
          generation=excluded.generation,
          folded_group_json=excluded.folded_group_json,
          payload_truncated=excluded.payload_truncated,
          payload_bytes=excluded.payload_bytes,
          expires_at=excluded.expires_at,
          nested=excluded.nested,
          owner_run_id=excluded.owner_run_id,
          authority=excluded.authority
        WHERE
          inflight_delegate_surface.tombstoned = 0
          AND (
            inflight_delegate_surface.state NOT IN (${TERMINAL_SQL})
            OR excluded.state = inflight_delegate_surface.state
            OR (
              excluded.authority >= ${AUTHORITY_JOB_STORE}
              AND excluded.state IN (${TERMINAL_SQL})
            )
          )
          AND (
            excluded.fencing_epoch > inflight_delegate_surface.fencing_epoch
            OR (
              excluded.fencing_epoch = inflight_delegate_surface.fencing_epoch
              AND excluded.generation >= inflight_delegate_surface.generation
            )
          )
      `)
      this.tombstoneStmt = db.prepare(`
        INSERT INTO inflight_delegate_surface (
          job_id, parent_session_key, session_id, user_id, run_id, agent_id, goal, state,
          live_hint, updated_at, fencing_epoch, generation, folded_group_json,
          payload_truncated, payload_bytes, expires_at, nested, owner_run_id,
          tombstoned, authority
        ) VALUES (
          @job_id, @parent_session_key, @session_id, @user_id, @run_id, @agent_id, @goal, @state,
          '', @updated_at, @fencing_epoch, @generation, NULL,
          0, 0, @expires_at, 0, '',
          1, ${AUTHORITY_JOB_STORE}
        )
        ON CONFLICT(job_id) DO UPDATE SET
          tombstoned = 1,
          updated_at = excluded.updated_at,
          expires_at = excluded.expires_at,
          fencing_epoch = MAX(inflight_delegate_surface.fencing_epoch, excluded.fencing_epoch),
          generation = MAX(inflight_delegate_surface.generation, excluded.generation),
          authority = ${AUTHORITY_JOB_STORE},
          live_hint = '',
          folded_group_json = NULL
      `)
      this.deleteStmt = db.prepare('DELETE FROM inflight_delegate_surface WHERE job_id = ?')
      this.loadStmt = db.prepare('SELECT * FROM inflight_delegate_surface WHERE job_id = ?')
      const rows = db.prepare('SELECT * FROM inflight_delegate_surface').all() as Array<
        Record<string, unknown>
      >
      for (const row of rows) {
        const id = typeof row.job_id === 'string' ? row.job_id : ''
        if (id && Number(row.tombstoned ?? 0) === 1) {
          this.droppedJobs.add(id)
          continue
        }
        const parsed = fromRow(row)
        if (parsed) this.byJob.set(parsed.jobId, parsed)
      }
    } catch (err) {
      try {
        db.close()
      } catch {
        /* open failed */
      }
      throw err
    }
  }

  private migrate(db: InstanceType<typeof Database>): void {
    const current = Number(db.pragma('user_version', { simple: true }) ?? 0)
    if (current < 1) db.exec(DDL)
    if (current === 1) {
      const existing = new Set(
        (db.prepare('PRAGMA table_info(inflight_delegate_surface)').all() as Array<{ name: string }>).map(
          (row) => row.name,
        ),
      )
      const columns: Array<[string, string]> = [
        ['session_id', "TEXT NOT NULL DEFAULT ''"],
        ['user_id', "TEXT NOT NULL DEFAULT ''"],
        ['fencing_epoch', 'INTEGER NOT NULL DEFAULT 0'],
        ['generation', 'INTEGER NOT NULL DEFAULT 0'],
        ['payload_truncated', 'INTEGER NOT NULL DEFAULT 0'],
        ['payload_bytes', 'INTEGER NOT NULL DEFAULT 0'],
        ['expires_at', 'INTEGER'],
        ['nested', 'INTEGER NOT NULL DEFAULT 0'],
        ['owner_run_id', "TEXT NOT NULL DEFAULT ''"],
      ]
      for (const [name, spec] of columns) {
        if (existing.has(name)) continue
        db.exec(`ALTER TABLE inflight_delegate_surface ADD COLUMN ${name} ${spec}`)
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_inflight_surface_user_session
          ON inflight_delegate_surface(user_id, session_id);
        CREATE INDEX IF NOT EXISTS idx_inflight_surface_expires
          ON inflight_delegate_surface(expires_at);
      `)
      const legacy = db.prepare('SELECT job_id, parent_session_key FROM inflight_delegate_surface').all() as Array<{
        job_id: string
        parent_session_key: string
      }>
      const fill = db.prepare('UPDATE inflight_delegate_surface SET session_id = ? WHERE job_id = ?')
      for (const row of legacy) {
        fill.run(sessionIdFromParentKey(row.parent_session_key), row.job_id)
      }
    }
    if (current < 3) {
      const existing = new Set(
        (db.prepare('PRAGMA table_info(inflight_delegate_surface)').all() as Array<{ name: string }>).map(
          (row) => row.name,
        ),
      )
      if (!existing.has('tombstoned')) {
        db.exec('ALTER TABLE inflight_delegate_surface ADD COLUMN tombstoned INTEGER NOT NULL DEFAULT 0')
      }
      if (!existing.has('authority')) {
        db.exec('ALTER TABLE inflight_delegate_surface ADD COLUMN authority INTEGER NOT NULL DEFAULT 0')
      }
    }
    if (current < SURFACE_SCHEMA_VERSION) {
      db.pragma(`user_version = ${SURFACE_SCHEMA_VERSION}`)
    }
    // v1→v2 (and already-v2 disks that skipped clipping) must bound payload
    // + backfill TTL before the Map load parses JSON.
    this.clipLegacyRows(db)
  }

  /**
   * Transactionally rewrite oversized/immortal terminal rows. Safe to run on
   * every open: a cheap EXISTS probe skips the rewrite when already bounded.
   */
  private clipLegacyRows(db: InstanceType<typeof Database>): void {
    const needs = db
      .prepare(
        `SELECT 1 AS n FROM inflight_delegate_surface
         WHERE IFNULL(tombstoned, 0) = 0
           AND ((folded_group_json IS NOT NULL AND folded_group_json != ''
                AND (IFNULL(payload_bytes, 0) = 0 OR payload_bytes > ?))
            OR (state IN (${TERMINAL_SQL}) AND expires_at IS NULL))
         LIMIT 1`,
      )
      .get(this.foldedMaxBytes) as { n: number } | undefined
    if (!needs) return
    const now = this.now()
    const rows = db
      .prepare(
        `SELECT job_id, state, folded_group_json, updated_at, expires_at, IFNULL(tombstoned, 0) AS tombstoned
         FROM inflight_delegate_surface`,
      )
      .all() as Array<{
      job_id: string
      state: string
      folded_group_json: string | null
      updated_at: number
      expires_at: number | null
      tombstoned: number
    }>
    const update = db.prepare(
      `UPDATE inflight_delegate_surface
       SET folded_group_json = @json,
           payload_truncated = @trunc,
           payload_bytes = @bytes,
           expires_at = @exp
       WHERE job_id = @id`,
    )
    const del = db.prepare('DELETE FROM inflight_delegate_surface WHERE job_id = ?')
    const tx = db.transaction(() => {
      for (const row of rows) {
        if (Number(row.tombstoned) === 1) continue
        const terminal = isDelegateTerminalState(row.state as DelegateJobState)
        let json: string | null = null
        let trunc = 0
        let bytes = 0
        if (typeof row.folded_group_json === 'string' && row.folded_group_json) {
          try {
            const parsed = JSON.parse(row.folded_group_json) as DurableAgentGroup
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              const bounded = boundFoldedGroup(parsed, this.foldedMaxBytes)
              json = JSON.stringify(bounded.group)
              trunc = bounded.truncated ? 1 : 0
              bytes = bounded.bytes
            }
          } catch {
            json = null
          }
        }
        let expires: number | null = row.expires_at == null ? null : Number(row.expires_at)
        if (terminal) {
          if (expires == null || !Number.isFinite(expires)) {
            expires = Number(row.updated_at || now) + this.terminalTtlMs
          }
        } else {
          expires = null
        }
        if (terminal && expires != null && expires <= now) {
          del.run(row.job_id)
          continue
        }
        update.run({ json, trunc, bytes, exp: expires, id: row.job_id })
      }
    })
    tx()
  }

  get(jobId: string): InflightDelegateSurface | undefined {
    const row = this.byJob.get(jobId)
    return row ? publicView(row) : undefined
  }

  upsertEnqueue(input: InflightEnqueueInput): InflightDelegateSurface {
    if (this.droppedJobs.has(input.jobId)) {
      const existingDropped = this.byJob.get(input.jobId)
      if (existingDropped) return publicView(existingDropped)
      return publicView({
        jobId: input.jobId,
        parentSessionKey: input.parentSessionKey,
        sessionId: sessionIdFromParentKey(input.parentSessionKey),
        userId: input.userId || '',
        agentId: input.agentId,
        runId: input.runId || defaultRunId(input.jobId),
        goal: clampText(input.goal ?? '', INFLIGHT_GOAL_MAX_CHARS),
        state: 'failed',
        liveHint: '',
        updatedAt: this.now(),
        fencingEpoch: 0,
        generation: 0,
        payloadBytes: 0,
        expiresAt: null,
        nested: false,
        ownerRunId: '',
        authority: AUTHORITY_PROJECTION,
      })
    }
    const existing = this.byJob.get(input.jobId)
    const nextState: DelegateJobState = input.state ?? existing?.state ?? 'queued'
    if (existing && !canAdvanceState(existing.state, nextState, { authoritative: input.authoritative })) {
      return publicView(existing)
    }
    const fencingEpoch = input.fencingEpoch ?? existing?.fencingEpoch ?? 0
    const generation =
      input.generation ??
      (existing ? existing.generation + 1 : 0)
    if (existing && !fenceBeats({ fencingEpoch, generation }, existing)) {
      return publicView(existing)
    }
    const next: SurfaceRow = {
      jobId: input.jobId,
      parentSessionKey: input.parentSessionKey,
      sessionId: sessionIdFromParentKey(input.parentSessionKey),
      userId: input.userId || existing?.userId || '',
      agentId: input.preserveIdentity && existing ? existing.agentId : input.agentId,
      runId:
        input.preserveIdentity && existing
          ? existing.runId
          : input.runId || existing?.runId || defaultRunId(input.jobId),
      goal: input.preserveIdentity && existing
        ? existing.goal
        : clampText(input.goal ?? existing?.goal ?? '', INFLIGHT_GOAL_MAX_CHARS),
      state: nextState,
      liveHint: clampText(input.liveHint ?? existing?.liveHint ?? '', INFLIGHT_LIVE_HINT_MAX_CHARS),
      updatedAt: this.now(),
      fencingEpoch,
      generation,
      payloadBytes: existing?.payloadBytes ?? 0,
      expiresAt: isDelegateTerminalState(nextState)
        ? (existing?.expiresAt ?? this.now() + this.terminalTtlMs)
        : null,
      nested: input.nested ?? existing?.nested ?? false,
      ownerRunId: input.ownerRunId ?? existing?.ownerRunId ?? '',
      truncated: existing?.truncated,
      authority: input.authoritative ? AUTHORITY_JOB_STORE : AUTHORITY_PROJECTION,
      ...(existing?.foldedGroup && isDelegateTerminalState(nextState)
        ? { foldedGroup: existing.foldedGroup }
        : {}),
    }
    if (!isDelegateTerminalState(next.state)) {
      delete next.foldedGroup
      next.truncated = undefined
      next.payloadBytes = 0
      next.expiresAt = null
    }
    this.persist(next)
    this.enforceTerminalCap(next.userId, next.sessionId)
    return publicView(this.byJob.get(next.jobId) ?? next)
  }

  updateLive(input: {
    jobId: string
    state?: DelegateJobState
    liveHint?: string
    runId?: string
    goal?: string
    agentId?: string
    parentSessionKey?: string
    userId?: string
    fencingEpoch?: number
    generation?: number
    nested?: boolean
    ownerRunId?: string
    preserveIdentity?: boolean
    authoritative?: boolean
  }): InflightDelegateSurface | undefined {
    if (this.droppedJobs.has(input.jobId)) return undefined
    const existing = this.byJob.get(input.jobId)
    if (!existing) return undefined
    const nextState = input.state ?? existing.state
    if (!canAdvanceState(existing.state, nextState, { authoritative: input.authoritative })) {
      return publicView(existing)
    }
    const fencingEpoch = input.fencingEpoch ?? existing.fencingEpoch
    const generation = input.generation ?? existing.generation + 1
    if (!fenceBeats({ fencingEpoch, generation }, existing)) {
      return publicView(existing)
    }
    const next = cloneRow(existing)
    if (!input.preserveIdentity) {
      if (input.parentSessionKey) {
        next.parentSessionKey = input.parentSessionKey
        next.sessionId = sessionIdFromParentKey(input.parentSessionKey)
      }
      if (input.agentId) next.agentId = input.agentId
      if (input.runId) next.runId = input.runId
      if (input.goal !== undefined && input.goal !== '') {
        next.goal = clampText(input.goal, INFLIGHT_GOAL_MAX_CHARS)
      }
    }
    if (input.userId) next.userId = input.userId
    if (input.nested !== undefined) next.nested = input.nested
    if (input.ownerRunId) next.ownerRunId = input.ownerRunId
    next.state = nextState
    if (input.liveHint !== undefined) {
      next.liveHint = clampText(input.liveHint, INFLIGHT_LIVE_HINT_MAX_CHARS)
    }
    next.fencingEpoch = fencingEpoch
    next.generation = generation
    next.updatedAt = this.now()
    next.authority = input.authoritative ? AUTHORITY_JOB_STORE : AUTHORITY_PROJECTION
    if (isDelegateTerminalState(next.state)) {
      next.expiresAt = next.expiresAt ?? this.now() + this.terminalTtlMs
    } else {
      delete next.foldedGroup
      next.truncated = undefined
      next.payloadBytes = 0
      next.expiresAt = null
    }
    this.persist(next)
    return publicView(this.byJob.get(input.jobId) ?? existing)
  }

  foldTerminal(input: {
    jobId: string
    group: DurableAgentGroup
    state?: DelegateJobState
    parentSessionKey?: string
    userId?: string
    fencingEpoch?: number
    generation?: number
    summaryOnly?: boolean
    authoritative?: boolean
  }): FoldTerminalResult {
    if (isDeferredExactProcessStub(input.group)) {
      return { folded: false, reason: 'deferred_stub' }
    }
    if (this.droppedJobs.has(input.jobId)) return { folded: false, reason: 'missing' }
    const existing = this.byJob.get(input.jobId)
    if (!existing) return { folded: false, reason: 'missing' }
    // Job-authority mapping: a finished DurableAgentGroup is a completed job
    // even when group.status is failed/timeout (complete(http 200, ok:false)).
    const state: DelegateJobState = input.state ?? 'completed'
    if (
      !canAdvanceState(existing.state, state, { authoritative: input.authoritative }) &&
      existing.state !== state
    ) {
      return { folded: true, surface: publicView(existing) }
    }
    const fencingEpoch = input.fencingEpoch ?? existing.fencingEpoch
    const generation = input.generation ?? existing.generation + 1
    if (!fenceBeats({ fencingEpoch, generation }, existing)) {
      return { folded: true, surface: publicView(existing) }
    }
    if (
      input.summaryOnly &&
      existing.foldedGroup &&
      existing.state === state &&
      isDelegateTerminalState(existing.state)
    ) {
      return { folded: true, surface: publicView(existing) }
    }
    const bounded = boundFoldedGroup(input.group, this.foldedMaxBytes)
    const next = cloneRow(existing)
    next.state = state
    next.authority = input.authoritative ? AUTHORITY_JOB_STORE : AUTHORITY_PROJECTION
    next.runId = bounded.group.runId || existing.runId
    if (bounded.group.goal) next.goal = clampText(bounded.group.goal, INFLIGHT_GOAL_MAX_CHARS)
    if (bounded.group.agentId) next.agentId = bounded.group.agentId
    if (input.parentSessionKey) {
      next.parentSessionKey = input.parentSessionKey
      next.sessionId = sessionIdFromParentKey(input.parentSessionKey)
    }
    if (input.userId) next.userId = input.userId
    next.liveHint = ''
    next.foldedGroup = bounded.group
    next.truncated = bounded.truncated || undefined
    next.payloadBytes = bounded.bytes
    next.fencingEpoch = fencingEpoch
    next.generation = generation
    next.updatedAt = this.now()
    next.expiresAt = existing.expiresAt ?? this.now() + this.terminalTtlMs
    this.persist(next)
    this.enforceTerminalCap(next.userId, next.sessionId)
    const committed = this.byJob.get(input.jobId) ?? existing
    return { folded: true, surface: publicView(committed) }
  }

  /**
   * Shared projection commit point for every job terminal (early-exit,
   * complete, fail, cancel, cutover, capacity). Fail-open: never throws.
   */
  projectJob(job: DelegateJobSnapshot): InflightDelegateSurface | undefined {
    if (this.droppedJobs.has(job.id)) return undefined
    if (!job.parentSessionKey) return undefined
    const existing = this.byJob.get(job.id)
    const fence = { fencingEpoch: job.fencingEpoch, generation: job.generation }
    if (!existing) {
      this.upsertEnqueue({
        jobId: job.id,
        parentSessionKey: job.parentSessionKey,
        agentId: job.agentId,
        state: isDelegateTerminalState(job.state) ? 'running' : job.state,
        userId: job.callbackOriginUserId,
        runId: defaultRunId(job.id),
        ...fence,
      })
    }
    if (isDelegateTerminalState(job.state)) {
      const row = this.byJob.get(job.id)
      if (!row) return undefined
      const group = summaryGroupFromJob(job, row)
      const folded = this.foldTerminal({
        jobId: job.id,
        group,
        state: job.state,
        parentSessionKey: job.parentSessionKey,
        userId: job.callbackOriginUserId || row.userId,
        summaryOnly: true,
        authoritative: true,
        ...fence,
      })
      return folded.folded ? folded.surface : this.get(job.id)
    }
    return this.updateLive({
      jobId: job.id,
      state: job.state,
      parentSessionKey: job.parentSessionKey,
      userId: job.callbackOriginUserId,
      ...fence,
    })
  }

  listForParent(parentSessionKey: string): InflightDelegateSurface[] {
    this.sweepExpired()
    const out: InflightDelegateSurface[] = []
    for (const row of this.byJob.values()) {
      if (row.parentSessionKey === parentSessionKey) out.push(publicView(row))
    }
    out.sort((a, b) => a.updatedAt - b.updatedAt)
    return out
  }

  listForSessionId(
    sessionId: string,
    opts: {
      userId?: string
      limit?: number
      cursor?: string
      maxBytes?: number
    } = {},
  ): { items: InflightDelegateSurface[]; nextCursor: string | null; truncated: boolean } {
    this.sweepExpired()
    const matched: SurfaceRow[] = []
    for (const row of this.byJob.values()) {
      if (opts.userId && row.userId && row.userId !== opts.userId) continue
      if (row.sessionId === sessionId || parentKeyMatchesSessionId(row.parentSessionKey, sessionId)) {
        matched.push(row)
      }
    }
    matched.sort((a, b) => a.updatedAt - b.updatedAt || a.jobId.localeCompare(b.jobId))
    let start = 0
    if (opts.cursor) {
      const idx = matched.findIndex((row) => row.jobId === opts.cursor)
      start = idx >= 0 ? idx + 1 : 0
    }
    const limit = Math.min(
      Math.max(1, opts.limit ?? INFLIGHT_GET_DEFAULT_LIMIT),
      INFLIGHT_GET_MAX_LIMIT,
    )
    const maxBytes = opts.maxBytes ?? INFLIGHT_GET_MAX_RESPONSE_BYTES
    const items: InflightDelegateSurface[] = []
    let used = 2
    let truncated = false
    let i = start
    for (; i < matched.length && items.length < limit; i++) {
      let view = publicView(matched[i])
      if (view.foldedGroup) {
        const bounded = boundFoldedGroup(view.foldedGroup, this.foldedMaxBytes)
        if (bounded.truncated) {
          view = { ...view, foldedGroup: bounded.group, truncated: true }
        }
      }
      let size = Buffer.byteLength(JSON.stringify(view), 'utf8') + 1
      if (used + size > maxBytes) {
        const summary = summarizeInflightView(view)
        size = Buffer.byteLength(JSON.stringify(summary), 'utf8') + 1
        if (used + size > maxBytes) {
          truncated = true
          break
        }
        view = summary
      }
      items.push(view)
      used += size
    }
    if (i < matched.length) truncated = true
    const nextCursor = truncated ? (items[items.length - 1]?.jobId ?? matched[i]?.jobId ?? null) : null
    return { items, nextCursor, truncated }
  }

  /**
   * Remove a projection whose job never became live (queue-full drop) or was
   * otherwise deleted. Persists a durable tombstone so another gateway's
   * stale overlay cannot INSERT the row back. Fail-open: never throws.
   */
  drop(jobId: string): boolean {
    const existing = this.byJob.get(jobId)
    this.rememberTombstone(jobId)
    this.persistTombstone({
      jobId,
      parentSessionKey: existing?.parentSessionKey ?? '',
      sessionId: existing?.sessionId ?? '',
      userId: existing?.userId ?? '',
      runId: existing?.runId ?? defaultRunId(jobId),
      agentId: existing?.agentId ?? '',
      goal: existing?.goal ?? '',
      state: existing?.state ?? 'failed',
      fencingEpoch: existing?.fencingEpoch ?? 0,
      generation: (existing?.generation ?? 0) + 1,
      expiresAt: this.now() + this.terminalTtlMs,
    })
    return Boolean(existing)
  }

  sweepExpired(now: number = this.now()): number {
    let dropped = 0
    for (const [jobId, row] of [...this.byJob.entries()]) {
      if (row.expiresAt != null && row.expiresAt <= now && isDelegateTerminalState(row.state)) {
        this.byJob.delete(jobId)
        this.deleteSafe(jobId)
        dropped += 1
      }
    }
    return dropped + this.sweepTombstones(now)
  }

  private enforceTerminalCap(userId: string, sessionId: string): void {
    if (!sessionId) return
    const terminals = [...this.byJob.values()].filter((row) => {
      if (!isDelegateTerminalState(row.state)) return false
      if (row.sessionId !== sessionId) return false
      if (userId && row.userId && row.userId !== userId) return false
      return true
    })
    if (terminals.length <= this.maxTerminalPerSession) return
    terminals.sort((a, b) => a.updatedAt - b.updatedAt || a.jobId.localeCompare(b.jobId))
    const extra = terminals.length - this.maxTerminalPerSession
    for (let i = 0; i < extra; i++) {
      this.byJob.delete(terminals[i].jobId)
      this.deleteSafe(terminals[i].jobId)
    }
  }

  /**
   * Job rows are authority for liveness. Cached goal/runId/liveHint overlay.
   * Folded terminals stay even when the job has expired from the live set.
   * When `dropMissingLive` (boot/restart), missing jobs drop non-folded live
   * rows so a dead Map cannot impersonate "still running". GET overlays only,
   * but still folds live rows whose job is already terminal.
   */
  rebuildFromJobs(
    jobs: readonly DelegateJobSnapshot[],
    opts: {
      dropMissingLive?: boolean
      resolveJob?: (jobId: string) => DelegateJobSnapshot | undefined
    } = {},
  ): InflightDelegateSurface[] {
    this.sweepExpired()
    const live = new Map<string, DelegateJobSnapshot>()
    for (const job of jobs) {
      if (!job.parentSessionKey) continue
      if (isDelegateTerminalState(job.state)) {
        this.projectJob(job)
        continue
      }
      live.set(job.id, job)
    }
    for (const [jobId, row] of [...this.byJob.entries()]) {
      if (live.has(jobId)) continue
      // Terminal rows (with or without a bounded group) must survive boot.
      // Dropping them is the "fake running → 404 evaporate" anti-pattern.
      if (isDelegateTerminalState(row.state)) continue
      const resolved = opts.resolveJob?.(jobId)
      if (resolved && isDelegateTerminalState(resolved.state)) {
        this.projectJob(resolved)
        continue
      }
      if (opts.dropMissingLive || row.state === 'queued') {
        this.drop(jobId)
      }
    }
    for (const job of live.values()) {
      const existing = this.byJob.get(job.id)
      this.upsertEnqueue({
        jobId: job.id,
        parentSessionKey: job.parentSessionKey!,
        agentId: job.agentId,
        state: job.state,
        runId: existing?.runId,
        goal: existing?.goal,
        liveHint: existing?.liveHint,
        userId: existing?.userId || job.callbackOriginUserId,
        fencingEpoch: job.fencingEpoch,
        generation: job.generation,
        preserveIdentity: Boolean(existing),
      })
    }
    return [...this.byJob.values()].map(publicView)
  }

  /** Stable synthetic id for sync (no background job) slots. */
  static syncJobId(progressRunId: string): string {
    return `dlgjob-${progressRunId}`
  }

  static resolveJobId(backgroundJobId: unknown, progressRunId?: string): string | undefined {
    if (typeof backgroundJobId === 'string' && /^dlgjob-[A-Za-z0-9-]{1,160}$/.test(backgroundJobId)) {
      return backgroundJobId
    }
    if (progressRunId) return DelegateInflightSurfaceStore.syncJobId(progressRunId)
    return undefined
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      // PASSIVE: never truncate WAL while another gateway handle may still
      // hold the file. TRUNCATE here was able to hide a committed terminal
      // from the next process (cross-gateway probe).
      this.db?.pragma('wal_checkpoint(PASSIVE)')
    } catch {
      /* shutdown */
    }
    try {
      this.db?.close()
    } catch {
      /* already closed */
    }
    this.db = null
    this.upsertStmt = null
    this.tombstoneStmt = null
    this.deleteStmt = null
    this.loadStmt = null
  }

  private rememberTombstone(jobId: string): void {
    this.droppedJobs.add(jobId)
    this.byJob.delete(jobId)
  }

  private persistTombstone(row: {
    jobId: string
    parentSessionKey: string
    sessionId: string
    userId: string
    runId: string
    agentId: string
    goal: string
    state: DelegateJobState
    fencingEpoch: number
    generation: number
    expiresAt: number
  }): void {
    try {
      this.tombstoneStmt?.run({
        job_id: row.jobId,
        parent_session_key: row.parentSessionKey,
        session_id: row.sessionId,
        user_id: row.userId,
        run_id: row.runId,
        agent_id: row.agentId,
        goal: row.goal,
        state: row.state,
        updated_at: this.now(),
        fencing_epoch: row.fencingEpoch,
        generation: row.generation,
        expires_at: row.expiresAt,
      })
    } catch (err) {
      this.noteWriteError(err, { phase: 'tombstone', jobId: row.jobId })
    }
  }

  private sweepTombstones(now: number): number {
    if (!this.db) return 0
    try {
      const rows = this.db
        .prepare(
          `SELECT job_id FROM inflight_delegate_surface
           WHERE tombstoned = 1 AND expires_at IS NOT NULL AND expires_at <= ?`,
        )
        .all(now) as Array<{ job_id: string }>
      for (const row of rows) {
        this.droppedJobs.delete(row.job_id)
        this.deleteSafe(row.job_id)
      }
      return rows.length
    } catch (err) {
      this.noteWriteError(err, { phase: 'sweep-tombstone' })
      return 0
    }
  }

  private deleteSafe(jobId: string): void {
    try {
      this.deleteStmt?.run(jobId)
    } catch (err) {
      this.noteWriteError(err, { phase: 'delete', jobId })
    }
  }

  private persist(row: SurfaceRow): boolean {
    if (this.droppedJobs.has(row.jobId)) return false
    try {
      if (!this.upsertStmt) {
        this.byJob.set(row.jobId, row)
        return true
      }
      const info = this.upsertStmt.run({
        job_id: row.jobId,
        parent_session_key: row.parentSessionKey,
        session_id: row.sessionId,
        user_id: row.userId,
        run_id: row.runId,
        agent_id: row.agentId,
        goal: row.goal,
        state: row.state,
        live_hint: row.liveHint,
        updated_at: row.updatedAt,
        fencing_epoch: row.fencingEpoch,
        generation: row.generation,
        folded_group_json: row.foldedGroup ? JSON.stringify(row.foldedGroup) : null,
        payload_truncated: row.truncated ? 1 : 0,
        payload_bytes: row.payloadBytes,
        expires_at: row.expiresAt,
        nested: row.nested ? 1 : 0,
        owner_run_id: row.ownerRunId,
        authority: row.authority ?? AUTHORITY_PROJECTION,
      })
      if (info.changes === 0) {
        if (this.rowIsTombstoned(row.jobId)) {
          this.rememberTombstone(row.jobId)
          return false
        }
        const fresh = this.loadFromDb(row.jobId)
        if (fresh) this.byJob.set(fresh.jobId, fresh)
        return false
      }
      this.byJob.set(row.jobId, row)
      return true
    } catch (err) {
      this.noteWriteError(err, { phase: 'persist', jobId: row.jobId })
      // Fail-open, fail-fast: never throw into Enqueue / Completer / Notifier.
      // SQLITE_BUSY is immediate (busy_timeout=0); keep the in-process row.
      this.byJob.set(row.jobId, row)
      return false
    }
  }

  private loadFromDb(jobId: string): SurfaceRow | null {
    try {
      const raw = this.loadStmt?.get(jobId) as Record<string, unknown> | undefined
      return raw ? fromRow(raw) : null
    } catch (err) {
      this.noteWriteError(err, { phase: 'load', jobId })
      return null
    }
  }

  private rowIsTombstoned(jobId: string): boolean {
    if (this.droppedJobs.has(jobId)) return true
    try {
      const raw = this.loadStmt?.get(jobId) as Record<string, unknown> | undefined
      return Boolean(raw) && Number(raw?.tombstoned ?? 0) === 1
    } catch (err) {
      this.noteWriteError(err, { phase: 'load-tombstone', jobId })
      return false
    }
  }
}

function fromRow(row: Record<string, unknown>): SurfaceRow | null {
  const jobId = typeof row.job_id === 'string' ? row.job_id : ''
  const parentSessionKey = typeof row.parent_session_key === 'string' ? row.parent_session_key : ''
  if (!jobId || !parentSessionKey) return null
  let foldedGroup: DurableAgentGroup | undefined
  let payloadBytes = Number(row.payload_bytes ?? 0)
  let truncated = Number(row.payload_truncated ?? 0) === 1
  if (typeof row.folded_group_json === 'string' && row.folded_group_json) {
    try {
      const parsed = JSON.parse(row.folded_group_json) as DurableAgentGroup
      if (parsed && typeof parsed === 'object' && !isDeferredExactProcessStub(parsed)) {
        const bounded = boundFoldedGroup(stripDeferredStubBit(parsed))
        foldedGroup = bounded.group
        payloadBytes = bounded.bytes
        truncated = truncated || bounded.truncated
      }
    } catch {
      foldedGroup = undefined
    }
  }
  return {
    jobId,
    parentSessionKey,
    sessionId:
      typeof row.session_id === 'string' && row.session_id
        ? row.session_id
        : sessionIdFromParentKey(parentSessionKey),
    userId: typeof row.user_id === 'string' ? row.user_id : '',
    runId: typeof row.run_id === 'string' && row.run_id ? row.run_id : defaultRunId(jobId),
    agentId: typeof row.agent_id === 'string' ? row.agent_id : '',
    goal: typeof row.goal === 'string' ? row.goal : '',
    state: (typeof row.state === 'string' ? row.state : 'running') as DelegateJobState,
    liveHint: typeof row.live_hint === 'string' ? row.live_hint : '',
    updatedAt: Number(row.updated_at ?? 0),
    fencingEpoch: Number(row.fencing_epoch ?? 0),
    generation: Number(row.generation ?? 0),
    payloadBytes,
    expiresAt: row.expires_at == null ? null : Number(row.expires_at),
    nested: Number(row.nested ?? 0) === 1,
    ownerRunId: typeof row.owner_run_id === 'string' ? row.owner_run_id : '',
    truncated: truncated || undefined,
    authority: Number(row.authority ?? 0),
    tombstoned: Number(row.tombstoned ?? 0) === 1,
    ...(foldedGroup ? { foldedGroup } : {}),
  }
}

function summarizeInflightView(view: InflightDelegateSurface): InflightDelegateSurface {
  const folded = view.foldedGroup
  const summary: InflightDelegateSurface = {
    jobId: view.jobId,
    runId: view.runId,
    agentId: view.agentId,
    goal: view.goal,
    state: view.state,
    liveHint: view.liveHint,
    updatedAt: view.updatedAt,
    parentSessionKey: view.parentSessionKey,
    truncated: true,
  }
  if (view.nested) summary.nested = true
  if (view.ownerRunId) summary.ownerRunId = view.ownerRunId
  if (folded) {
    summary.foldedGroup = {
      runId: folded.runId,
      agentId: folded.agentId,
      goal: clampText(folded.goal, 256),
      status: folded.status,
      completedAt: folded.completedAt,
    }
  }
  return summary
}

export type InflightDelegatesHttpResult = {
  status: number
  body: Record<string, unknown>
}

/**
 * Production GET /api/sessions/:id/inflight-delegates. Flag-off is 404
 * `{error:'not found'}` (653ef6339 path-equivalent). Ownership is
 * getClientSession(sessId, userId) fail-closed.
 */
export async function handleInflightDelegatesRequest(args: {
  method: string
  sessionId: string
  userId: string
  enabled: boolean
  searchParams?: URLSearchParams
  loadSession: (sessionId: string, userId: string) => Promise<unknown>
  store?: DelegateInflightSurfaceStore | null
  overlayJobs?: () => readonly DelegateJobSnapshot[]
  resolveJob?: (jobId: string) => DelegateJobSnapshot | undefined
  dropMissingLive?: boolean
}): Promise<InflightDelegatesHttpResult> {
  if (!args.enabled) {
    return { status: 404, body: { error: 'not found' } }
  }
  if (args.method !== 'GET') {
    return { status: 405, body: { error: 'method not allowed' } }
  }
  const sess = await args.loadSession(args.sessionId, args.userId)
  if (!sess) {
    return { status: 404, body: { error: 'not found' } }
  }
  const store = args.store
  if (!store) {
    return { status: 200, body: { enabled: true, items: [], nextCursor: null, truncated: false } }
  }
  try {
    if (args.overlayJobs) {
      store.rebuildFromJobs(args.overlayJobs(), {
        resolveJob: args.resolveJob,
        dropMissingLive: args.dropMissingLive === true,
      })
    }
  } catch (err) {
    log.warn('inflight surface overlay failed', { sessionId: args.sessionId }, err)
  }
  const rawLimit = Number(args.searchParams?.get('limit') ?? '')
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : INFLIGHT_GET_DEFAULT_LIMIT
  const cursor = args.searchParams?.get('cursor') || undefined
  const page = store.listForSessionId(args.sessionId, {
    userId: args.userId,
    limit,
    cursor,
  })
  return {
    status: 200,
    body: {
      enabled: true,
      items: page.items,
      nextCursor: page.nextCursor,
      truncated: page.truncated,
    },
  }
}
