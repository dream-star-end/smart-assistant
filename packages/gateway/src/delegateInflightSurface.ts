/**
 * OCV5-22 R2: session-level inflight delegate surface (design v3 §N4).
 *
 * Decoupled from parent turn_status working-detail. Flag
 * OC_DELEGATE_INFLIGHT_SURFACE defaults off. Authority remains the job row;
 * this store is a projection (goal / runId / liveHint / folded DurableAgentGroup).
 * Restart rebuilds live slots from durable jobs and overlays the cached hint.
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import {
  isDelegateTerminalState,
  type DelegateJobState,
  type InflightDelegateSurface,
} from '@openclaude/protocol'
import type { DurableAgentGroup } from '@openclaude/protocol'

import { resolveDelegateJobsDbPath } from './delegateDurable.js'
import type { DelegateJobSnapshot } from './delegateJobs.js'

const SURFACE_SCHEMA_VERSION = 1

const DDL = `
CREATE TABLE IF NOT EXISTS inflight_delegate_surface (
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
CREATE INDEX IF NOT EXISTS idx_inflight_surface_parent
  ON inflight_delegate_surface(parent_session_key);
`

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
}

function defaultRunId(jobId: string): string {
  return `dlg-${jobId}`
}

function cloneSurface(row: InflightDelegateSurface): InflightDelegateSurface {
  return {
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
}

function publicView(row: InflightDelegateSurface): InflightDelegateSurface {
  const out = cloneSurface(row)
  if (out.foldedGroup) out.foldedGroup = stripDeferredStubBit(out.foldedGroup)
  return out
}

export function parentKeyMatchesSessionId(parentSessionKey: string, sessionId: string): boolean {
  if (!parentSessionKey || !sessionId) return false
  if (parentSessionKey === sessionId) return true
  if (parentSessionKey.endsWith(`:${sessionId}`)) return true
  // webchat peerId is the last segment of agent:<id>:webchat:dm:<peerId>
  const last = parentSessionKey.split(':').pop()
  return last === sessionId
}

export class DelegateInflightSurfaceStore {
  readonly path: string | null
  private readonly now: () => number
  private readonly byJob = new Map<string, InflightDelegateSurface>()
  private db: InstanceType<typeof Database> | null = null
  private upsertStmt: ReturnType<InstanceType<typeof Database>['prepare']> | null = null
  private deleteStmt: ReturnType<InstanceType<typeof Database>['prepare']> | null = null
  private closed = false

  constructor(opts: { dbPath?: string | null; now?: () => number } = {}) {
    this.now = opts.now ?? Date.now
    this.path = opts.dbPath === undefined ? resolveDelegateInflightSurfaceDbPath() : opts.dbPath
    if (this.path) this.openDb(this.path)
  }

  private openDb(dbPath: string): void {
    mkdirSync(dirname(dbPath), { recursive: true })
    const db = new Database(dbPath)
    db.pragma('busy_timeout = 10000')
    db.pragma('journal_mode = WAL')
    const current = Number(db.pragma('user_version', { simple: true }) ?? 0)
    if (current < SURFACE_SCHEMA_VERSION) {
      db.exec(DDL)
      db.pragma(`user_version = ${SURFACE_SCHEMA_VERSION}`)
    }
    this.db = db
    this.upsertStmt = db.prepare(`
      INSERT INTO inflight_delegate_surface (
        job_id, parent_session_key, run_id, agent_id, goal, state, live_hint,
        updated_at, folded_group_json
      ) VALUES (
        @job_id, @parent_session_key, @run_id, @agent_id, @goal, @state, @live_hint,
        @updated_at, @folded_group_json
      )
      ON CONFLICT(job_id) DO UPDATE SET
        parent_session_key=excluded.parent_session_key,
        run_id=excluded.run_id,
        agent_id=excluded.agent_id,
        goal=excluded.goal,
        state=excluded.state,
        live_hint=excluded.live_hint,
        updated_at=excluded.updated_at,
        folded_group_json=excluded.folded_group_json
    `)
    this.deleteStmt = db.prepare('DELETE FROM inflight_delegate_surface WHERE job_id = ?')
    const rows = db.prepare('SELECT * FROM inflight_delegate_surface').all() as Array<
      Record<string, unknown>
    >
    for (const row of rows) {
      const parsed = fromRow(row)
      if (parsed) this.byJob.set(parsed.jobId, parsed)
    }
  }

  get(jobId: string): InflightDelegateSurface | undefined {
    const row = this.byJob.get(jobId)
    return row ? publicView(row) : undefined
  }

  upsertEnqueue(input: InflightEnqueueInput): InflightDelegateSurface {
    const existing = this.byJob.get(input.jobId)
    const next: InflightDelegateSurface = {
      jobId: input.jobId,
      parentSessionKey: input.parentSessionKey,
      agentId: input.agentId,
      runId: input.runId || existing?.runId || defaultRunId(input.jobId),
      goal: input.goal ?? existing?.goal ?? '',
      state: input.state ?? existing?.state ?? 'queued',
      liveHint: input.liveHint ?? existing?.liveHint ?? '',
      updatedAt: this.now(),
      ...(existing?.foldedGroup ? { foldedGroup: existing.foldedGroup } : {}),
    }
    // Enqueue of a live job must not keep a previous folded group as "still running".
    if (!isDelegateTerminalState(next.state)) delete next.foldedGroup
    this.persist(next)
    return publicView(next)
  }

  updateLive(input: {
    jobId: string
    state?: DelegateJobState
    liveHint?: string
    runId?: string
    goal?: string
    agentId?: string
    parentSessionKey?: string
  }): InflightDelegateSurface | undefined {
    const existing = this.byJob.get(input.jobId)
    if (!existing) return undefined
    if (existing.foldedGroup && isDelegateTerminalState(existing.state)) {
      // Live hint must not resurrect a folded terminal as running.
      if (input.state && isDelegateTerminalState(input.state)) {
        existing.state = input.state
        existing.updatedAt = this.now()
        this.persist(existing)
      }
      return publicView(existing)
    }
    if (input.parentSessionKey) existing.parentSessionKey = input.parentSessionKey
    if (input.agentId) existing.agentId = input.agentId
    if (input.runId) existing.runId = input.runId
    if (input.goal !== undefined && input.goal !== '') existing.goal = input.goal
    if (input.state) existing.state = input.state
    if (input.liveHint !== undefined) existing.liveHint = input.liveHint
    existing.updatedAt = this.now()
    this.persist(existing)
    return publicView(existing)
  }

  foldTerminal(input: {
    jobId: string
    group: DurableAgentGroup
    state?: DelegateJobState
    parentSessionKey?: string
  }): FoldTerminalResult {
    if (isDeferredExactProcessStub(input.group)) {
      return { folded: false, reason: 'deferred_stub' }
    }
    const existing = this.byJob.get(input.jobId)
    if (!existing) return { folded: false, reason: 'missing' }
    const group = stripDeferredStubBit(structuredClone(input.group))
    const state: DelegateJobState =
      input.state ??
      (group.status === 'ok' ? 'completed' : group.status === 'timeout' ? 'failed' : 'failed')
    existing.state = state
    existing.runId = group.runId || existing.runId
    if (group.goal) existing.goal = group.goal
    if (group.agentId) existing.agentId = group.agentId
    if (input.parentSessionKey) existing.parentSessionKey = input.parentSessionKey
    existing.liveHint = ''
    existing.foldedGroup = group
    existing.updatedAt = this.now()
    this.persist(existing)
    return { folded: true, surface: publicView(existing) }
  }

  listForParent(parentSessionKey: string): InflightDelegateSurface[] {
    const out: InflightDelegateSurface[] = []
    for (const row of this.byJob.values()) {
      if (row.parentSessionKey === parentSessionKey) out.push(publicView(row))
    }
    out.sort((a, b) => a.updatedAt - b.updatedAt)
    return out
  }

  listForSessionId(sessionId: string): InflightDelegateSurface[] {
    const out: InflightDelegateSurface[] = []
    for (const row of this.byJob.values()) {
      if (parentKeyMatchesSessionId(row.parentSessionKey, sessionId)) out.push(publicView(row))
    }
    out.sort((a, b) => a.updatedAt - b.updatedAt)
    return out
  }

  /**
   * Job rows are authority for liveness. Cached goal/runId/liveHint overlay.
   * Folded terminals stay even when the job has expired from the live set.
   * When `dropMissingLive` (boot/restart), missing jobs drop non-folded live
   * rows so a dead Map cannot impersonate "still running". GET overlays only.
   */
  rebuildFromJobs(
    jobs: readonly DelegateJobSnapshot[],
    opts: { dropMissingLive?: boolean } = {},
  ): InflightDelegateSurface[] {
    const live = new Map<string, DelegateJobSnapshot>()
    for (const job of jobs) {
      if (!job.parentSessionKey) continue
      if (isDelegateTerminalState(job.state)) continue
      live.set(job.id, job)
    }
    if (opts.dropMissingLive) {
      for (const [jobId, row] of [...this.byJob.entries()]) {
        if (row.foldedGroup && isDelegateTerminalState(row.state)) continue
        if (live.has(jobId)) continue
        this.byJob.delete(jobId)
        this.deleteStmt?.run(jobId)
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
      this.db?.pragma('wal_checkpoint(TRUNCATE)')
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
    this.deleteStmt = null
  }

  private persist(row: InflightDelegateSurface): void {
    this.byJob.set(row.jobId, row)
    this.upsertStmt?.run({
      job_id: row.jobId,
      parent_session_key: row.parentSessionKey,
      run_id: row.runId,
      agent_id: row.agentId,
      goal: row.goal,
      state: row.state,
      live_hint: row.liveHint,
      updated_at: row.updatedAt,
      folded_group_json: row.foldedGroup ? JSON.stringify(row.foldedGroup) : null,
    })
  }
}

function fromRow(row: Record<string, unknown>): InflightDelegateSurface | null {
  const jobId = typeof row.job_id === 'string' ? row.job_id : ''
  const parentSessionKey = typeof row.parent_session_key === 'string' ? row.parent_session_key : ''
  if (!jobId || !parentSessionKey) return null
  let foldedGroup: DurableAgentGroup | undefined
  if (typeof row.folded_group_json === 'string' && row.folded_group_json) {
    try {
      const parsed = JSON.parse(row.folded_group_json) as DurableAgentGroup
      if (parsed && typeof parsed === 'object' && !isDeferredExactProcessStub(parsed)) {
        foldedGroup = stripDeferredStubBit(parsed)
      }
    } catch {
      foldedGroup = undefined
    }
  }
  return {
    jobId,
    parentSessionKey,
    runId: typeof row.run_id === 'string' && row.run_id ? row.run_id : defaultRunId(jobId),
    agentId: typeof row.agent_id === 'string' ? row.agent_id : '',
    goal: typeof row.goal === 'string' ? row.goal : '',
    state: (typeof row.state === 'string' ? row.state : 'running') as DelegateJobState,
    liveHint: typeof row.live_hint === 'string' ? row.live_hint : '',
    updatedAt: Number(row.updated_at ?? 0),
    ...(foldedGroup ? { foldedGroup } : {}),
  }
}
