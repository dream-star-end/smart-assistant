// Skill-training Job registry — the durable state behind an async training run.
//
// A training run is a background agent session that stages skill drafts. Because it
// is async, the user may close/reopen the panel or the gateway may restart, so the
// run STATE is the authoritative artifact; the WebSocket push is just a live view of
// it. This module owns that state (in-memory index + a run.json mirror under the
// run's draft dir so discarding the run cleans both). It deliberately knows nothing
// about WebSockets or sessions — the gateway passes an onChange callback to push
// progress, keeping this module pure enough to unit-test.
//
// Phases are derived DETERMINISTICALLY from the agent's observable tool calls (which
// tool it just invoked → which phase), never from the model self-reporting progress.

import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { paths } from '@openclaude/storage'
import type { SessionStreamEvent } from './ccbMessageParser.js'

/** Same shape as SkillTrainJobStore.newRunId() output; guards path construction. */
const VALID_RUN_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/

export type SkillTrainStatus =
  | 'queued'
  | 'running'
  | 'diff_ready'
  | 'merged'
  | 'discarded'
  | 'failed'

export type SkillTrainPhase =
  | 'queued'
  | 'scanning_sessions'
  | 'evaluating'
  | 'drafting'
  | 'diff_ready'
  | 'done'
  | 'failed'

export interface SkillTrainRun {
  runId: string
  /** Target skill, or null for auto-select among the user's own skills. */
  skillName: string | null
  agentId: string
  userId: string
  model: string
  effort: string
  status: SkillTrainStatus
  phase: SkillTrainPhase
  /** How many skill_propose calls landed (= candidate drafts). */
  proposalCount: number
  /** Total tool calls observed (for the activity readout). */
  toolCalls: number
  error: string | null
  /** Final agent text (truncated) — the run summary. */
  summary: string | null
  startedAt: number
  updatedAt: number
  finishedAt: number | null
}

/** A live status terminal for active-run accounting. */
const ACTIVE_STATUSES: ReadonlySet<SkillTrainStatus> = new Set(['queued', 'running'])

/**
 * Map a stream event to the phase it implies, deterministically from the tool the
 * agent just called. Returns null when the event does not advance the phase.
 */
export function phaseForToolName(toolName: string): SkillTrainPhase | null {
  switch (toolName) {
    case 'session_search':
      return 'scanning_sessions'
    case 'skill_list':
    case 'skill_search':
    case 'skill_view':
      return 'evaluating'
    case 'skill_propose':
      return 'drafting'
    default:
      return null
  }
}

/** Monotonic phase ordering so out-of-order tool calls never regress the bar. */
const PHASE_RANK: Record<SkillTrainPhase, number> = {
  queued: 0,
  scanning_sessions: 1,
  evaluating: 2,
  drafting: 3,
  diff_ready: 4,
  done: 4,
  failed: 5,
}

export type SkillTrainRunChange = (run: SkillTrainRun) => void

export interface StartGuard {
  ok: boolean
  reason?: string
}

export class SkillTrainJobStore {
  private readonly runs = new Map<string, SkillTrainRun>()
  private readonly maxConcurrent: number
  private readonly onChange: SkillTrainRunChange

  constructor(opts: { maxConcurrent?: number; onChange?: SkillTrainRunChange } = {}) {
    this.maxConcurrent = Math.max(1, opts.maxConcurrent ?? 2)
    this.onChange = opts.onChange ?? (() => {})
  }

  /** New run id (caller may also pass one). */
  static newRunId(): string {
    return `train-${randomUUID()}`
  }

  /**
   * Concurrency guard: cap total active runs per container and forbid two active
   * runs against the SAME skill (avoids racing drafts on one target). A null skill
   * (auto-select) only counts against the global cap.
   */
  canStart(skillName: string | null): StartGuard {
    let active = 0
    for (const r of this.runs.values()) {
      if (!ACTIVE_STATUSES.has(r.status)) continue
      active++
      if (skillName && r.skillName === skillName) {
        return { ok: false, reason: `a training run for "${skillName}" is already in progress` }
      }
    }
    if (active >= this.maxConcurrent) {
      return { ok: false, reason: `too many concurrent training runs (max ${this.maxConcurrent})` }
    }
    return { ok: true }
  }

  async create(input: {
    runId: string
    skillName: string | null
    agentId: string
    userId: string
    model: string
    effort: string
    now: number
  }): Promise<SkillTrainRun> {
    const run: SkillTrainRun = {
      runId: input.runId,
      skillName: input.skillName,
      agentId: input.agentId,
      userId: input.userId,
      model: input.model,
      effort: input.effort,
      status: 'queued',
      phase: 'queued',
      proposalCount: 0,
      toolCalls: 0,
      error: null,
      summary: null,
      startedAt: input.now,
      updatedAt: input.now,
      finishedAt: null,
    }
    this.runs.set(run.runId, run)
    await this.persist(run)
    this.onChange(run)
    return run
  }

  get(runId: string): SkillTrainRun | undefined {
    return this.runs.get(runId)
  }

  list(userId?: string): SkillTrainRun[] {
    const out = [...this.runs.values()]
    return (userId ? out.filter((r) => r.userId === userId) : out).sort(
      (a, b) => b.startedAt - a.startedAt,
    )
  }

  /**
   * Fold a session stream event into a run's state, persist + notify on change.
   * Tool calls advance the phase monotonically; skill_propose increments the
   * proposal count; final/error close the run out.
   */
  async applyEvent(runId: string, ev: SessionStreamEvent, now: number): Promise<void> {
    const run = this.runs.get(runId)
    if (!run) return
    if (!ACTIVE_STATUSES.has(run.status)) return // already terminal

    let changed = false
    if (run.status === 'queued') {
      run.status = 'running'
      changed = true
    }

    if (ev.kind === 'block' && ev.block.kind === 'tool_use' && ev.block.partial !== true) {
      run.toolCalls++
      changed = true
      const phase = phaseForToolName(ev.block.toolName)
      if (phase && PHASE_RANK[phase] > PHASE_RANK[run.phase]) {
        run.phase = phase
      }
      if (ev.block.toolName === 'skill_propose') {
        run.proposalCount++
      }
    } else if (
      ev.kind === 'block' &&
      ev.block.kind === 'text' &&
      typeof ev.block.text === 'string'
    ) {
      // Keep the latest non-empty text as a rolling summary (truncated).
      const t = ev.block.text.trim()
      if (t) {
        run.summary = t.slice(0, 4000)
        changed = true
      }
    } else if (ev.kind === 'error') {
      run.status = 'failed'
      run.phase = 'failed'
      run.error = ev.error || 'training failed'
      run.finishedAt = now
      changed = true
    }
    // NOTE: 'final' is intentionally NOT terminal here. proposalCount counts
    // skill_propose *calls*, but a call can be rejected (bad name, etc.), so it is not
    // the source of truth for "are there drafts". The caller resolves the terminal
    // state from the actual draft-store count via finalize() instead.

    if (changed) {
      run.updatedAt = now
      await this.persist(run)
      this.onChange(run)
    }
  }

  /**
   * Resolve the terminal state on the agent's `final` event from the ACTUAL number of
   * staged drafts (source of truth), not the proposal-call count: drafts present →
   * wait at the diff/confirm gate; none → close as a no-op discard ("[SILENT]" / all
   * proposals rejected). `draftCount` also overwrites the displayed proposalCount so a
   * comment re-run that re-proposes the same skill doesn't inflate the number.
   */
  async finalize(runId: string, draftCount: number, now: number): Promise<void> {
    const run = this.runs.get(runId)
    if (!run || !ACTIVE_STATUSES.has(run.status)) return
    run.proposalCount = draftCount
    if (draftCount > 0) {
      run.status = 'diff_ready'
      run.phase = 'diff_ready'
    } else {
      run.status = 'discarded'
      run.phase = 'done'
    }
    run.finishedAt = now
    run.updatedAt = now
    await this.persist(run)
    this.onChange(run)
  }

  /**
   * Re-open a diff_ready run for another agentic pass (a user comment → AI revision).
   * Resets status to running and rewinds the phase so progress advances again from a
   * running baseline (the monotonic guard in applyEvent would otherwise pin it at
   * diff_ready). No-op if the run is already active or gone.
   */
  async reopen(runId: string, now: number): Promise<void> {
    const run = this.runs.get(runId)
    if (!run) return
    if (ACTIVE_STATUSES.has(run.status)) return
    run.status = 'running'
    run.phase = 'evaluating'
    run.finishedAt = null
    run.updatedAt = now
    await this.persist(run)
    this.onChange(run)
  }

  /** Mark a terminal user action (merge/discard) or an external failure. */
  async setStatus(
    runId: string,
    status: SkillTrainStatus,
    now: number,
    error?: string,
  ): Promise<SkillTrainRun | undefined> {
    const run = this.runs.get(runId)
    if (!run) return undefined
    run.status = status
    if (status === 'failed') {
      run.phase = 'failed'
      run.error = error ?? run.error ?? 'failed'
    }
    if (status === 'merged' || status === 'discarded' || status === 'failed') {
      run.finishedAt = now
    }
    run.updatedAt = now
    await this.persist(run)
    this.onChange(run)
    return run
  }

  /** Forget a run from the in-memory index (after discard cleanup). */
  forget(runId: string): void {
    this.runs.delete(runId)
  }

  /**
   * Reload persisted runs after a gateway restart. Any run still marked active is
   * reconciled to 'failed' — its background session did not survive the restart.
   */
  async loadAll(now: number): Promise<void> {
    const root = paths.skillDraftsDir
    if (!existsSync(root)) return
    let dirs: string[]
    try {
      dirs = await readdir(root)
    } catch {
      return
    }
    for (const runId of dirs) {
      if (!VALID_RUN_ID_RE.test(runId)) continue
      const file = join(root, runId, 'run.json')
      if (!existsSync(file)) continue
      try {
        const parsed = JSON.parse(await readFile(file, 'utf-8')) as SkillTrainRun
        if (!parsed?.runId) continue
        if (ACTIVE_STATUSES.has(parsed.status)) {
          parsed.status = 'failed'
          parsed.phase = 'failed'
          parsed.error = 'gateway restarted during training'
          parsed.finishedAt = now
        }
        this.runs.set(parsed.runId, parsed)
      } catch {}
    }
  }

  private async persist(run: SkillTrainRun): Promise<void> {
    try {
      if (!VALID_RUN_ID_RE.test(run.runId)) return
      const dir = paths.skillDraftRunDir(run.runId)
      await mkdir(dir, { recursive: true })
      // Verify the run dir resolves within the drafts root (guards a symlinked
      // skill-drafts dir from widening the write surface beyond HOME).
      const realDir = await realpath(dir)
      const root = existsSync(paths.skillDraftsDir)
        ? realpathSync(paths.skillDraftsDir)
        : resolve(paths.skillDraftsDir)
      if (realDir !== root && !realDir.startsWith(root + sep)) return
      const file = join(realDir, 'run.json')
      const tmp = join(realDir, `.run.json.tmp-${randomUUID()}`)
      await writeFile(tmp, `${JSON.stringify(run, null, 2)}\n`)
      await rename(tmp, file)
    } catch {
      // Best-effort durability; the in-memory index remains authoritative this process.
    }
  }
}
