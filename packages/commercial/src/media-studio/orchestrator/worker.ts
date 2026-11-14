// OCV5-591 A2-1a — the studio worker. Runs on both A/B masters: claims due tasks (Muse-affine ones
// only while this process's bridge is online), renews leases while a task runs, aborts a task whose
// lease is lost or that exceeds the hard timeout, and advances the project after every task.

import { randomBytes } from 'node:crypto'
import type { Pool } from 'pg'

import type { Logger } from '../../logging/logger.js'
import { STUDIO_TASK_HARD_TIMEOUT_MS } from '../providers/charges.js'
import { type StudioTask, claimStudioTasks, renewStudioTask } from '../queue.js'
import { type AdvanceDeps, advanceProject } from './advance.js'
import type { ComposeRunnerLike } from './compose.js'
import { type ExecuteDeps, LeaseLostError, executeTask } from './execute.js'
import { RECONCILE_INTERVAL_MS, reconcileCharges } from './reconcile.js'

export const WORKER_POLL_MS = 2_000
export const WORKER_IDLE_MS = 10_000
export const MAX_RUNNING_PER_PROCESS = 8
const RENEW_EVERY_MS = 30_000
const SWEEP_EVERY_MS = 30_000

export interface WorkerDeps extends ExecuteDeps, AdvanceDeps {
  /** Both sides read the sandbox; the executor needs the full runner. */
  compose?: ComposeRunnerLike
  pool: Pool
  museOnline: () => boolean
  log: Logger
  slot: string
}

export class StudioWorker {
  readonly owner: string
  private running = new Set<Promise<void>>()
  private stopped = false
  private timers: NodeJS.Timeout[] = []

  constructor(private readonly deps: WorkerDeps) {
    this.owner = `${deps.slot}:${process.pid}:${randomBytes(3).toString('hex')}`
  }

  start(): void {
    const loop = async () => {
      if (this.stopped) return
      let next = WORKER_IDLE_MS
      try {
        const free = MAX_RUNNING_PER_PROCESS - this.running.size
        if (free > 0) {
          const tasks = await claimStudioTasks(this.deps.pool, {
            owner: this.owner,
            limit: Math.min(4, free),
            museOnline: this.deps.museOnline(),
          })
          for (const t of tasks) this.track(this.run(t))
          if (tasks.length) next = WORKER_POLL_MS
        } else {
          next = WORKER_POLL_MS
        }
      } catch (err) {
        this.deps.log.warn('studio_claim_failed', { err: err as Error })
      }
      if (!this.stopped) this.timers.push(setTimeout(() => void loop(), next).unref())
    }
    void loop()
    const sweep = setInterval(() => void this.sweep(), SWEEP_EVERY_MS)
    const recon = setInterval(() => {
      void reconcileCharges(this.deps).catch((err) =>
        this.deps.log.warn('studio_reconcile_failed', { err: err as Error }),
      )
    }, RECONCILE_INTERVAL_MS)
    sweep.unref()
    recon.unref()
    this.timers.push(sweep, recon)
  }

  /** Stop claiming; give in-flight tasks a moment, the rest expire to the other slot. */
  async stop(graceMs = 30_000): Promise<void> {
    this.stopped = true
    for (const t of this.timers) clearTimeout(t)
    await Promise.race([
      Promise.allSettled([...this.running]),
      new Promise((r) => setTimeout(r, graceMs).unref()),
    ])
  }

  private track(p: Promise<void>) {
    this.running.add(p)
    void p.finally(() => this.running.delete(p))
  }

  private async run(task: StudioTask): Promise<void> {
    const ac = new AbortController()
    const hard = setTimeout(
      () => ac.abort(new Error('studio task timed out')),
      STUDIO_TASK_HARD_TIMEOUT_MS,
    )
    const renew = setInterval(() => {
      void renewStudioTask(this.deps.pool, task)
        .then((ok) => {
          if (!ok) ac.abort(new LeaseLostError())
        })
        .catch(() => {})
    }, RENEW_EVERY_MS)
    try {
      await executeTask(this.deps, task, ac.signal)
    } catch (err) {
      if (!(err instanceof LeaseLostError)) {
        this.deps.log.warn('studio_task_failed', {
          taskId: task.id,
          kind: task.kind,
          err: err as Error,
        })
      }
    } finally {
      clearTimeout(hard)
      clearInterval(renew)
    }
    await this.advance(task.projectId)
  }

  /** Advance now; if another process holds the project's lock, try once more shortly. */
  async advance(projectId: string): Promise<void> {
    try {
      if (!(await advanceProject(this.deps, projectId))) {
        setTimeout(() => void advanceProject(this.deps, projectId).catch(() => {}), 2_000).unref()
      }
    } catch (err) {
      this.deps.log.warn('studio_advance_failed', { projectId, err: err as Error })
    }
  }

  /** Safety net: projects in an active state with no recent event get another pass. */
  private async sweep(): Promise<void> {
    try {
      const r = await this.deps.pool.query<{ id: string }>(
        `SELECT p.id::text AS id FROM studio_projects p
          WHERE p.deleted_at IS NULL AND p.status IN ('planning', 'running', 'composing')
            AND NOT EXISTS (SELECT 1 FROM studio_events e WHERE e.project_id = p.id AND e.ts > NOW() - INTERVAL '2 minutes')
          LIMIT 20`,
      )
      for (const row of r.rows) await this.advance(row.id)
    } catch (err) {
      this.deps.log.warn('studio_sweep_failed', { err: err as Error })
    }
  }
}
