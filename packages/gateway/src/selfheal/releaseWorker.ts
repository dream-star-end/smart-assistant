/**
 * Self-heal Tier2 release worker (batch1b §8 / §9) — the durable, at-most-once
 * deployer of approved code repairs.
 *
 * A single background loop drains `selfheal_release_jobs`:
 *
 *   received  → (fuse? revoked? manual plan?) → CLAIM (global singleflight,
 *               enqueues the 'deploying' callback in the claim txn) → spawn the
 *               release LANE in a systemd transient scope → stream its JSON
 *               events (checkpoint persisted immediately, receipt held) → on exit
 *               adjudicate the receipt → terminalize + terminal callback.
 *
 * Crash recovery (startup + every tick): a `deploying` row whose scope is dead is
 * settled from durable state ALONE — NEVER by re-running deploy:
 *   - receipt_json present   → adjudicate it (idempotent terminalize);
 *   - checkpoint present      → deploy effect already applied → retry canonical
 *                               push only, then close deployed from the checkpoint;
 *   - neither                 → engage the local fuse + terminalize deploy_unknown.
 *
 * At-most-once is enforced by the durable pre-claim (`claimed_at` set-once), NOT
 * by holding a lock across the deploy; the per-repair mutex only serializes the
 * claim decision against cancel. The lane itself takes the global deploy lock and
 * the remote production-mutation lease.
 */

import { execFile, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { join, resolve } from 'node:path'
import {
  type SelfhealReleaseJob,
  cancelReleaseJob,
  engageReleaseFuse,
  getJob as getSelfhealJob,
  getReleaseFuse,
  getReleaseJob,
  listReleaseJobsByStatus,
  claimReleaseJob,
  markReleaseJobCanonicalPushed,
  setReleaseJobCheckpoint,
  setReleaseJobFailureReason,
  setReleaseJobReceipt,
  terminalizeReleaseJobWithCallback,
} from '@openclaude/storage'
import { type Logger, createLogger } from '../logger.js'
import { withRepairLock } from './executionLedger.js'
import { createWecomNotifier } from './notify.js'
import { planIsManual } from './releaseIntake.js'

const log = createLogger({ module: 'selfheal-release-worker' })

const DEFAULT_TICK_MS = 10_000
const DEFAULT_LANE_TIMEOUT_MS = 90 * 60_000
const CANONICAL_PUSH_ATTEMPTS = 3
/** After a timeout kill, wait up to this long for the scope's cgroup to die
 *  before reading durable state (§F5①). */
const DEFAULT_KILL_GRACE_MS = 30_000

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Three-state scope liveness (R2-2). 'unknown' is fail-CLOSED — a job is NEVER
 *  settled while its scope is 'active' OR 'unknown' (only a confirmed 'inactive'
 *  can be adjudicated from durable state). */
export type ScopeLiveness = 'active' | 'inactive' | 'unknown'

/** A single JSON event line emitted by the lane on stdout. */
export interface LaneEvent {
  evt: 'checkpoint' | 'receipt'
  [k: string]: unknown
}

interface ReceiptShape {
  evt: string
  rrid: string
  sha: string
  outcome: string
  reason?: string
  proofs?: Record<string, unknown>
  canonicalPush?: string
  exit?: number
}

/** Injectable host primitives (tests substitute a fake lane runner + git). */
export interface ReleaseWorkerPrimitives {
  /** Spawn the lane, stream its events, resolve when it exits (or was killed on
   *  timeout). The default spawns `systemd-run --scope … bash <lane> <argsFile>`. */
  runLane(input: {
    argsFilePath: string
    scopeUnit: string
    laneScriptPath: string
    timeoutMs: number
    onEvent: (evt: LaneEvent) => Promise<void>
  }): Promise<{ timedOut: boolean }>
  /** Three-state scope liveness (R2-2, fail-CLOSED). Maps `systemctl is-active
   *  <scopeUnit>.scope`:
   *    - 'active'   — active|activating|deactivating|reloading (still alive);
   *    - 'inactive' — inactive|failed|dead (confirmed gone → safe to settle);
   *    - 'unknown'  — the probe could not determine the state (exception, empty,
   *                   or an unrecognized string). NEVER settled on. */
  scopeLiveness(scopeUnit: string): Promise<ScopeLiveness>
  /** Escalate to `systemctl kill -s SIGKILL <scopeUnit>.scope` — the second
   *  teardown attempt when a timed-out lane's cgroup is still alive/unknown. */
  killScope(scopeUnit: string): Promise<void>
  /** Retry the canonical fast-forward push, idempotently. */
  pushCanonical(input: {
    canonicalRepo: string
    canonicalBranch: string
    sha: string
  }): Promise<'pushed' | 'pending'>
}

export interface SelfhealReleaseWorkerDeps {
  canonicalRepo: string
  canonicalBranch: string
  laneScriptPath: string
  primitives?: ReleaseWorkerPrimitives
  notify?: (text: string) => void
  tickMs?: number
  laneTimeoutMs?: number
  /** Max wait for a killed scope's cgroup to die before durable settle (§F5①).
   *  Small in tests. */
  killGraceMs?: number
  log?: Logger
  now?: () => number
  /** Injectable env gate re-read each tick (default process.env). */
  env?: NodeJS.ProcessEnv
}

/**
 * Assemble the release-worker deps from env, or null when release is not
 * configured. Gated exactly like the jobWorker (its caller only constructs this
 * when the jobWorker deps exist); the per-tick OC_SELFHEAL_RELEASE_DISABLED kill
 * switch is honored at runtime.
 */
export function getSelfhealReleaseWorkerDeps(
  env: NodeJS.ProcessEnv = process.env,
): SelfhealReleaseWorkerDeps {
  const canonicalRepo =
    env.OC_SELFHEAL_CANONICAL_DIR?.trim() || '/opt/openclaude/openclaude-v5-aurora'
  const canonicalBranch =
    env.OC_SELFHEAL_CANONICAL_BRANCH?.trim() || 'feat/v5-aurora-rewrite'
  const repoRoot = resolve(import.meta.dirname, '../../../..')
  const laneScriptPath =
    env.OC_SELFHEAL_RELEASE_LANE_SCRIPT?.trim() || join(repoRoot, 'ops/selfheal-release-lane.sh')
  const laneTimeoutMs = Number(env.OC_SELFHEAL_RELEASE_LANE_TIMEOUT_MS) || DEFAULT_LANE_TIMEOUT_MS
  return { canonicalRepo, canonicalBranch, laneScriptPath, laneTimeoutMs, env }
}

// ── default host primitives ──────────────────────────────────────────────────

function runCmd(
  cmd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code =
        err && typeof (err as { code?: unknown }).code === 'number'
          ? ((err as { code: number }).code)
          : err
            ? 1
            : 0
      res({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

export const defaultReleaseWorkerPrimitives: ReleaseWorkerPrimitives = {
  async runLane(input) {
    return await new Promise<{ timedOut: boolean }>((resolvePromise) => {
      const child = spawn(
        'systemd-run',
        [
          '--scope',
          `--unit=${input.scopeUnit}`,
          '--collect',
          '--',
          'bash',
          input.laneScriptPath,
          input.argsFilePath,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      const pending: Promise<void>[] = []
      const rl = createInterface({ input: child.stdout })
      rl.on('line', (line) => {
        const t = line.trim()
        if (!t) return
        let evt: unknown
        try {
          evt = JSON.parse(t)
        } catch {
          return
        }
        if (
          evt &&
          typeof evt === 'object' &&
          ((evt as LaneEvent).evt === 'checkpoint' || (evt as LaneEvent).evt === 'receipt')
        ) {
          pending.push(Promise.resolve(input.onEvent(evt as LaneEvent)).catch(() => {}))
        }
      })
      child.stderr.on('data', (chunk: Buffer) => {
        log.info('release lane', { line: String(chunk).slice(0, 400) })
      })
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        // Kill the whole scope's cgroup (the deploy may have forked children).
        void runCmd('systemctl', ['kill', `${input.scopeUnit}.scope`])
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }, input.timeoutMs)
      timer.unref?.()
      child.on('error', (err) => {
        log.error('release lane spawn error', { scopeUnit: input.scopeUnit }, err)
      })
      child.on('exit', () => {
        clearTimeout(timer)
        void Promise.all(pending).then(() => resolvePromise({ timedOut }))
      })
    })
  },
  async scopeLiveness(scopeUnit) {
    // `systemctl is-active` prints the ActiveState to stdout regardless of exit
    // code (exit is 0 only for 'active'), so classify by the STATE STRING — never
    // by the exit code alone (a truly-dead scope reports 'inactive' with a
    // non-zero exit; treating every non-zero as 'unknown' would livelock it).
    const r = await runCmd('systemctl', ['is-active', `${scopeUnit}.scope`])
    return classifyScopeState(r.stdout)
  },
  async killScope(scopeUnit) {
    await runCmd('systemctl', ['kill', '-s', 'SIGKILL', `${scopeUnit}.scope`])
  },
  async pushCanonical({ canonicalRepo, canonicalBranch, sha }) {
    const ls = await runCmd('git', ['-C', canonicalRepo, 'ls-remote', 'origin', `refs/heads/${canonicalBranch}`])
    const remoteHead = ls.stdout.split(/\s+/)[0] ?? ''
    if (remoteHead === sha) return 'pushed'
    const push = await runCmd('git', [
      '-C',
      canonicalRepo,
      'push',
      'origin',
      `${sha}:refs/heads/${canonicalBranch}`,
    ])
    return push.code === 0 ? 'pushed' : 'pending'
  },
}

// ── worker ───────────────────────────────────────────────────────────────────

export class SelfhealReleaseWorker {
  private readonly deps: SelfhealReleaseWorkerDeps
  private readonly primitives: ReleaseWorkerPrimitives
  private readonly notify: (text: string) => void
  private readonly log: Logger
  private readonly now: () => number
  private readonly tickMs: number
  private readonly laneTimeoutMs: number
  private readonly killGraceMs: number
  private readonly env: NodeJS.ProcessEnv
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private stopped = false
  private ticking = false
  /** rrids being handled in THIS process — the recovery sweep skips them. */
  private readonly inFlight = new Set<string>()
  /** rrids whose scope could not be confirmed dead — alert a human ONCE, not
   *  every tick (R2-2). Cleared when the job finally settles. */
  private readonly stuckAlerted = new Set<string>()

  constructor(deps: SelfhealReleaseWorkerDeps) {
    this.deps = deps
    this.primitives = deps.primitives ?? defaultReleaseWorkerPrimitives
    this.notify = deps.notify ?? createWecomNotifier()
    this.log = deps.log ?? log
    this.now = deps.now ?? (() => Date.now())
    this.tickMs = deps.tickMs ?? DEFAULT_TICK_MS
    this.laneTimeoutMs = deps.laneTimeoutMs ?? DEFAULT_LANE_TIMEOUT_MS
    this.killGraceMs = deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS
    this.env = deps.env ?? process.env
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.stopped = false
    this.log.info('selfheal release worker started', {
      canonicalRepo: this.deps.canonicalRepo,
      laneTimeoutMs: this.laneTimeoutMs,
    })
    this.scheduleNext(0)
  }

  stop(): void {
    this.stopped = true
    this.running = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** Wake the loop immediately (e.g. right after a release job is enqueued). */
  kick(): void {
    if (!this.running || this.ticking) return
    this.scheduleNext(0)
  }

  private disabled(): boolean {
    return (this.env.OC_SELFHEAL_RELEASE_DISABLED ?? '') === '1'
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.tick(), delayMs)
    this.timer.unref?.()
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.ticking) return
    this.ticking = true
    try {
      if (!this.disabled()) await this.pumpOnce()
    } catch (err) {
      this.log.error('selfheal release worker tick error', undefined, err as Error)
    } finally {
      this.ticking = false
      this.scheduleNext(this.tickMs)
    }
  }

  /** One full sweep: crash recovery of `deploying` rows, then claim + deploy of
   *  `received` rows. Public + deterministic (no timers) for tests. */
  async pumpOnce(): Promise<void> {
    // 1. Recover any orphaned `deploying` rows first (frees the singleflight).
    const deploying = await listReleaseJobsByStatus(['deploying'])
    for (const job of deploying) {
      if (this.stopped) return
      if (this.inFlight.has(job.releaseRequestId)) continue
      await this.recoverDeploying(job)
    }
    // 2. Drain `received` rows.
    const received = await listReleaseJobsByStatus(['received'])
    for (const job of received) {
      if (this.stopped) return
      await this.processReceived(job)
    }
  }

  private async processReceived(job: SelfhealReleaseJob): Promise<void> {
    // Local fuse blocks ALL new claims before we even take the per-repair lock.
    const fuse = await getReleaseFuse()
    if (fuse.engaged) {
      this.log.warn('release job held — local fuse engaged', {
        releaseRequestId: job.releaseRequestId,
      })
      return
    }
    const scopeUnit = `oc-selfheal-rel-${sanitizeUnit(job.releaseRequestId)}-${this.now()}`
    const claimed = await withRepairLock(job.repairId, async (): Promise<SelfhealReleaseJob | null> => {
      const fresh = await getReleaseJob(job.releaseRequestId)
      if (!fresh || fresh.status !== 'received') return null
      // release revoked (cancel of a terminal repair) → cancel-close, never deploy.
      const repair = await getSelfhealJob(job.repairId)
      if (repair?.releaseRevoked) {
        await cancelReleaseJob(job.releaseRequestId)
        this.log.warn('release job cancel-closed — repair release revoked', {
          releaseRequestId: job.releaseRequestId,
        })
        return null
      }
      // Single manual adjudicator (§11 note): a non-deployable plan is closed
      // manual_required with a callback — no claim, no lane, no unsafe argv.
      const manual = planIsManual(safeParse(fresh.planJson))
      if (manual.manual) {
        await this.terminalizeManual(fresh, `plan_manual:${manual.reasons.join(',')}`)
        return null
      }
      const res = await claimReleaseJob({
        releaseRequestId: job.releaseRequestId,
        scopeUnit,
        deployingCallback: {
          repairId: job.repairId,
          message: 'deploying: release lane started',
          detail: {
            releaseRequestId: job.releaseRequestId,
            releasePhase: 'deploying',
          },
        },
      })
      if (res.outcome === 'claimed') return res.job
      // busy (another deploy in flight) / noop (lost CAS) — retry a later tick.
      return null
    })
    if (!claimed) return
    await this.runClaimed(claimed)
  }

  /** Deploy a freshly-claimed job: write the argsFile, spawn the lane, stream
   *  its events, persist the receipt, adjudicate. */
  private async runClaimed(job: SelfhealReleaseJob): Promise<void> {
    const rrid = job.releaseRequestId
    this.inFlight.add(rrid)
    let dir: string | null = null
    try {
      const plan = safeParse(job.planJson)
      const cls = (plan.classification ?? {}) as Record<string, unknown>
      const surfaces = Array.isArray(cls.surfaces) ? (cls.surfaces as string[]) : []
      const deployArgs = Array.isArray(cls.deployArgs) ? (cls.deployArgs as string[]) : []
      const requiredAxes = Array.isArray(cls.requiredAxes) ? (cls.requiredAxes as string[]) : []
      const baseSha =
        typeof plan.baseSha === 'string' ? (plan.baseSha as string) : (job.baseSha ?? '')
      const sha = job.approvedSha
      const candidateRef = candidateRefFor(job.repairId, sha)
      const argsObj = {
        rrid,
        repairId: job.repairId,
        canonicalRepo: this.deps.canonicalRepo,
        canonicalBranch: this.deps.canonicalBranch,
        baseSha,
        sha,
        candidateRef,
        deployArgs,
        requiredAxes,
        manifestHash: job.manifestHash ?? '',
        planHash: job.deployPlanHash ?? '',
        proofPlan: { surfaces },
      }
      dir = mkdtempSync(join(tmpdir(), 'oc-selfheal-rel-'))
      const argsFilePath = join(dir, 'args.json')
      writeFileSync(argsFilePath, JSON.stringify(argsObj), { mode: 0o600 })

      let receiptRaw: string | null = null
      const scopeUnit = job.scopeUnit ?? ''
      const { timedOut } = await this.primitives.runLane({
        argsFilePath,
        scopeUnit,
        laneScriptPath: this.deps.laneScriptPath,
        timeoutMs: this.laneTimeoutMs,
        onEvent: async (evt) => {
          if (evt.evt === 'checkpoint') {
            // Persist ONLY a checkpoint that strongly binds to this job (§F5③);
            // a mis-bound one is ignored so recovery can never "retry push" for a
            // stranger's deploy effect.
            if (this.checkpointEventBinds(evt, job)) {
              await setReleaseJobCheckpoint(rrid, JSON.stringify(evt))
            } else {
              this.log.error('release lane checkpoint failed strong binding — ignored', {
                releaseRequestId: rrid,
              })
            }
          } else if (evt.evt === 'receipt') {
            receiptRaw = JSON.stringify(evt)
          }
        },
      })
      if (timedOut) {
        // §F5①② + R2-2: the lane was killed. CONFIRM the scope's cgroup is
        // actually dead before settling — NEVER terminalize a job whose scope may
        // still be mutating production (split-brain / double deploy). Escalate to
        // SIGKILL if the graceful kill did not take; if it STILL cannot be
        // confirmed dead (or liveness stays unknown), keep the job 'deploying'
        // (alert + retry next tick), never terminalize. Only once dead do we
        // settle from what durably LANDED (a streamed+persisted checkpoint proves
        // the deploy effect IS applied → "push only", never blanket unknown).
        this.log.error('release lane timed out — killed; confirming scope death', {
          releaseRequestId: rrid,
        })
        if (!(await this.confirmScopeDead(job))) {
          this.alertStuckScope(job, 'lane_kill_unconfirmed')
          return
        }
        await this.settleFromDurableState(job, 'lane_timeout')
        return
      }
      // Persist the receipt set-once; adjudicate the LANDED value (authoritative
      // even if a recovery sweep raced us).
      let landed: string | null = receiptRaw
      if (receiptRaw) {
        const r = await setReleaseJobReceipt(rrid, receiptRaw)
        landed = r.receiptJson
      }
      await this.adjudicate(job, landed)
    } catch (err) {
      this.log.error('release lane handling crashed — settling from durable state', {
        releaseRequestId: rrid,
      }, err as Error)
      // §F5 catch path: same rule as timeout — honor an already-persisted
      // checkpoint/receipt before ever declaring unknown.
      await this.settleFromDurableState(job, 'worker_crash')
    } finally {
      this.inFlight.delete(rrid)
      if (dir) {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          /* best effort */
        }
      }
    }
  }

  private async recoverDeploying(job: SelfhealReleaseJob): Promise<void> {
    const scope = job.scopeUnit ?? ''
    if (scope) {
      const live = await this.scopeLivenessSafe(scope)
      if (live === 'active') {
        // Still running (this process or another). Leave it.
        return
      }
      if (live === 'unknown') {
        // R2-2③: liveness indeterminate — NEVER adjudicate (settling here could
        // race a still-live deploy). Alert (deduped) and retry on the next tick.
        this.alertStuckScope(job, 'recovery_liveness_unknown')
        return
      }
    }
    // Confirmed 'inactive' (or no scope to probe). Dead lane — NEVER re-run
    // deploy; settle from durable state alone (§8/§9).
    await this.settleFromDurableState(job, 'crash_no_checkpoint')
  }

  /**
   * Settle a 'deploying' job whose lane is no longer producing a trustworthy
   * in-process result (timeout / worker crash / crash recovery). NEVER re-runs
   * deploy — reads durable state ALONE (§8/§9/§F5):
   *   - a persisted receipt        → adjudicate it (idempotent);
   *   - a strongly-bound checkpoint → deploy effect applied → retry push only;
   *   - neither (or a checkpoint that fails the strong binding) → deploy_unknown
   *     + local fuse.
   */
  private async settleFromDurableState(
    job: SelfhealReleaseJob,
    unknownReason: string,
  ): Promise<void> {
    const rrid = job.releaseRequestId
    // We only reach here once the scope is confirmed dead — drop any stuck-scope
    // alert flag so the rrid does not linger in the de-dup set.
    this.stuckAlerted.delete(rrid)
    const fresh = (await getReleaseJob(rrid)) ?? job
    // Another path may have already terminalized it — respect the terminal and
    // never re-engage the fuse on an already-settled (possibly deployed) job.
    if (fresh.status !== 'deploying') {
      this.log.info('release job already settled — no durable re-settle', {
        releaseRequestId: rrid,
        status: fresh.status,
      })
      return
    }
    if (fresh.receiptJson) {
      this.log.warn('settling deploying job from persisted receipt', { releaseRequestId: rrid })
      await this.adjudicate(fresh, fresh.receiptJson)
      return
    }
    if (this.checkpointBinds(fresh)) {
      this.log.warn('settling deploying job from checkpoint — retry push only', {
        releaseRequestId: rrid,
      })
      await this.closeDeployedFromCheckpoint(fresh)
      return
    }
    this.log.error('settling deploying job with no receipt/bound checkpoint → deploy_unknown', {
      releaseRequestId: rrid,
    })
    await this.terminalizeUnknown(fresh, unknownReason, undefined)
  }

  /** Poll scope liveness until it is CONFIRMED 'inactive', up to the kill-grace
   *  cap (§F5① + R2-2). Returns true ONLY on a confirmed-dead scope; 'active' OR
   *  'unknown' (including a thrown probe) keeps waiting and, at the cap, returns
   *  false — the caller then escalates / holds the job (NEVER settles). This is
   *  the fix for the old fail-OPEN `catch → false → settle`. Wall-clock bounded
   *  (independent of the injected logical `now`). */
  private async waitScopeInactive(scopeUnit: string): Promise<boolean> {
    if (!scopeUnit) return true
    const deadline = Date.now() + this.killGraceMs
    const pollMs = Math.max(1, Math.min(500, Math.floor(this.killGraceMs / 4)))
    for (;;) {
      if ((await this.scopeLivenessSafe(scopeUnit)) === 'inactive') return true
      if (Date.now() >= deadline) return false
      await sleep(pollMs)
    }
  }

  /** Never-throwing liveness probe: a thrown probe is 'unknown' (fail-CLOSED),
   *  NOT 'inactive'. The old catch→false was the R2-2 fail-OPEN bug that let a
   *  probe failure settle a possibly-live scope. */
  private async scopeLivenessSafe(scopeUnit: string): Promise<ScopeLiveness> {
    try {
      return await this.primitives.scopeLiveness(scopeUnit)
    } catch {
      return 'unknown'
    }
  }

  /** Confirm a timed-out lane's scope cgroup is DEAD before any durable settle
   *  (R2-2). Round 1: wait for the graceful `systemctl kill` (issued by the lane
   *  timeout) to take. Round 2: escalate to `systemctl kill -s SIGKILL` and wait
   *  once more. Returns false if the scope is still alive OR its liveness stays
   *  unknown after both rounds — the caller then holds the job 'deploying'. */
  private async confirmScopeDead(job: SelfhealReleaseJob): Promise<boolean> {
    const scope = job.scopeUnit ?? ''
    if (!scope) return true
    if (await this.waitScopeInactive(scope)) return true
    try {
      await this.primitives.killScope(scope)
    } catch (err) {
      this.log.error(
        'release lane SIGKILL escalation failed',
        { releaseRequestId: job.releaseRequestId },
        err as Error,
      )
    }
    return await this.waitScopeInactive(scope)
  }

  /** Hold a job whose scope could not be confirmed dead: log, and alert a human
   *  ONCE (deduped per rrid). The job stays 'deploying' — the next tick retries
   *  liveness — so at-most-once is never traded for liveness (R2-2). */
  private alertStuckScope(job: SelfhealReleaseJob, reason: string): void {
    this.log.error('release scope not confirmed dead — job held deploying (NOT settled)', {
      releaseRequestId: job.releaseRequestId,
      reason,
    })
    if (this.stuckAlerted.has(job.releaseRequestId)) return
    this.stuckAlerted.add(job.releaseRequestId)
    this.notify(
      `[selfheal] repair ${job.repairId} 部署 lane 已结束但 scope cgroup 未能确认死亡(${reason}),为避免双部署本 job 保持 deploying 不终态化并已排入下轮重试,需人工确认 scope=${job.scopeUnit ?? '?'} 是否残留。rrid=${job.releaseRequestId}`,
    )
  }

  /** Strong checkpoint binding (§F5③) against a job's frozen values: rrid / sha /
   *  planHash / manifestHash must each be equal (same null→'' normalization the
   *  lane argsFile uses for the hashes) and kind must be deploy_effect_applied. */
  private checkpointBinds(job: SelfhealReleaseJob): boolean {
    if (!job.checkpointJson) return false
    return checkpointRecordBinds(safeParse(job.checkpointJson), job)
  }

  private checkpointEventBinds(evt: LaneEvent, job: SelfhealReleaseJob): boolean {
    return checkpointRecordBinds(evt as unknown as Record<string, unknown>, job)
  }

  // ── receipt adjudication (§8.2) ────────────────────────────────────────────

  private async adjudicate(job: SelfhealReleaseJob, receiptRaw: string | null): Promise<void> {
    const r = parseReceipt(receiptRaw)
    if (!receiptValid(r, job)) {
      await this.terminalizeUnknown(job, 'malformed_receipt', r?.proofs)
      return
    }
    const receipt = r as ReceiptShape
    switch (receipt.outcome) {
      case 'deployed':
        await this.terminalizeDeployed(job, receipt.proofs ?? {}, receipt.canonicalPush)
        return
      case 'deploy_failed':
        await this.terminalizeFailed(job, receipt.reason ?? 'proof_not_applied', receipt.proofs)
        return
      case 'manual':
        await this.terminalizeManual(job, receipt.reason ?? 'lane_manual')
        return
      default: // 'deploy_unknown'
        await this.terminalizeUnknown(
          job,
          receipt.reason ?? 'proof_indeterminate',
          receipt.proofs,
        )
        return
    }
  }

  private async terminalizeDeployed(
    job: SelfhealReleaseJob,
    proofs: Record<string, unknown>,
    laneCanonicalPush: string | undefined,
  ): Promise<void> {
    const canonicalPush =
      laneCanonicalPush === 'pushed' ? 'pushed' : await this.retryCanonicalPush(job)
    if (canonicalPush === 'pushed') {
      await markReleaseJobCanonicalPushed(job.releaseRequestId)
    } else {
      await setReleaseJobFailureReason(job.releaseRequestId, 'canonical_push_pending')
      // F12: the release IS deployed (effect is live) but its retry budget for the
      // canonical ff-push is exhausted — source and production now diverge. Pull
      // the LOCAL Tier2 fuse so NO further auto-deploy proceeds until a human
      // ff-pushes canonical and clears it. The job stays `deployed` (terminal);
      // only the NEXT release is gated. The candidate ref is never auto-deleted.
      await engageReleaseFuse({
        reason: 'canonical_push_pending',
        releaseRequestId: job.releaseRequestId,
      })
      this.notify(
        `[selfheal] repair ${job.repairId} 已部署但 canonical push 未完成(candidate ref 已保留,已拉起本地 Tier2 熔断),需人工 ff push canonical 后清熔断。rrid=${job.releaseRequestId} sha=${job.approvedSha}`,
      )
    }
    const detail = await this.buildDeployedDetail(job, proofs, canonicalPush)
    await terminalizeReleaseJobWithCallback({
      releaseRequestId: job.releaseRequestId,
      repairId: job.repairId,
      fromStatuses: ['deploying'],
      toStatus: 'deployed',
      message: 'released and deployed',
      detail,
      failureReason: canonicalPush === 'pushed' ? null : 'canonical_push_pending',
    })
    this.log.info('release deployed', {
      releaseRequestId: job.releaseRequestId,
      sha: job.approvedSha,
      canonicalPush,
    })
  }

  private async closeDeployedFromCheckpoint(job: SelfhealReleaseJob): Promise<void> {
    const cp = safeParse(job.checkpointJson ?? '{}')
    const proofs = (cp.proofs ?? {}) as Record<string, unknown>
    // Deploy effect is proven applied (checkpoint) → deployed regardless of push.
    await this.terminalizeDeployed(job, proofs, undefined)
  }

  private async terminalizeUnknown(
    job: SelfhealReleaseJob,
    reason: string,
    proofs: Record<string, unknown> | undefined,
  ): Promise<void> {
    // Engage the local fuse FIRST so no new release can claim while we settle.
    await engageReleaseFuse({
      reason: `deploy_unknown:${job.releaseRequestId}:${reason}`,
      releaseRequestId: job.releaseRequestId,
    })
    const applied = await terminalizeReleaseJobWithCallback({
      releaseRequestId: job.releaseRequestId,
      repairId: job.repairId,
      fromStatuses: ['deploying'],
      toStatus: 'deploy_unknown',
      message: 'deploy outcome unknown — local Tier2 fuse engaged',
      detail: {
        releaseRequestId: job.releaseRequestId,
        releasePhase: 'deploy_unknown',
        reason,
        detailText: `部署结果不确定(${reason}),已拉起本地熔断,待人工按 /version + deploy_state 裁决`,
        ...(proofs ? { proofs } : {}),
      },
      failureReason: reason,
    })
    if (applied) {
      this.notify(
        `[selfheal] repair ${job.repairId} 部署结果未知(${reason})— 已拉起本地 Tier2 熔断,禁止后续自动部署,需人工裁决。rrid=${job.releaseRequestId} sha=${job.approvedSha}`,
      )
    }
    this.log.error('release deploy_unknown — fuse engaged', {
      releaseRequestId: job.releaseRequestId,
      reason,
    })
  }

  private async terminalizeFailed(
    job: SelfhealReleaseJob,
    reason: string,
    proofs: Record<string, unknown> | undefined,
  ): Promise<void> {
    await terminalizeReleaseJobWithCallback({
      releaseRequestId: job.releaseRequestId,
      repairId: job.repairId,
      fromStatuses: ['deploying'],
      toStatus: 'deploy_failed',
      message: 'release deploy failed (fully rolled back / not applied)',
      detail: {
        releaseRequestId: job.releaseRequestId,
        releasePhase: 'deploy_failed',
        reason,
        detailText: `部署失败且已确认未生效/已完整回滚(${reason})`,
        ...(proofs ? { proofs } : {}),
      },
      failureReason: reason,
    })
    this.log.warn('release deploy_failed', { releaseRequestId: job.releaseRequestId, reason })
  }

  private async terminalizeManual(job: SelfhealReleaseJob, reason: string): Promise<void> {
    // manual_required is reachable from BOTH received (pre-claim manual gate) and
    // deploying (lane exit 78). Accept either as the CAS from-set.
    await terminalizeReleaseJobWithCallback({
      releaseRequestId: job.releaseRequestId,
      repairId: job.repairId,
      fromStatuses: ['received', 'deploying'],
      toStatus: 'manual_required',
      message: 'release requires manual handling',
      detail: {
        releaseRequestId: job.releaseRequestId,
        releasePhase: 'manual_required',
        reason,
        detailText: `该修复无法安全自动部署(${reason}),需人工线下处理`,
      },
      failureReason: reason,
    })
    this.log.warn('release manual_required', { releaseRequestId: job.releaseRequestId, reason })
  }

  private async retryCanonicalPush(job: SelfhealReleaseJob): Promise<'pushed' | 'pending'> {
    for (let i = 0; i < CANONICAL_PUSH_ATTEMPTS; i++) {
      const r = await this.primitives.pushCanonical({
        canonicalRepo: this.deps.canonicalRepo,
        canonicalBranch: this.deps.canonicalBranch,
        sha: job.approvedSha,
      })
      if (r === 'pushed') return 'pushed'
    }
    return 'pending'
  }

  private async buildDeployedDetail(
    job: SelfhealReleaseJob,
    proofs: Record<string, unknown>,
    canonicalPush: 'pushed' | 'pending',
  ): Promise<Record<string, unknown>> {
    const plan = safeParse(job.planJson)
    const cls = (plan.classification ?? {}) as Record<string, unknown>
    const surfaces = Array.isArray(cls.surfaces) ? (cls.surfaces as string[]) : []
    const attestation = await this.buildAttestation(job)
    return {
      releaseRequestId: job.releaseRequestId,
      releasePhase: 'deployed',
      sha: job.approvedSha,
      surfaces,
      proofs,
      ...(canonicalPush === 'pending' ? { canonicalPush: 'pending' } : {}),
      ...(attestation ? { trusted_attestation: attestation } : {}),
    }
  }

  /**
   * Root-authored trusted attestation — ONLY for the fully-automatic origin
   * (`auto`) reaching a `deployed` terminal (red line 1). Human (`v5`) and
   * break-glass releases never mint one. Equivalent to the broker's
   * buildTrustedAttestation, sourced from the frozen repair routing.
   */
  private async buildAttestation(
    job: SelfhealReleaseJob,
  ): Promise<Record<string, unknown> | null> {
    if (job.origin !== 'auto') return null
    const repair = await getSelfhealJob(job.repairId)
    const conditionKey = repair?.conditionKey ?? ''
    const target =
      conditionKey === 'ops.monitor:svc_v5' || conditionKey === 'ops.monitor:http_v5'
        ? 'service:v5'
        : ''
    if (!target || !job.incidentId) return null
    return {
      version: 1,
      repairId: job.repairId,
      incidentId: job.incidentId,
      conditionKey,
      target,
      action: 'deploy_v5',
      executionMode: 'fully_automatic',
      executed: true,
      remoteResult: {
        ok: true,
        target,
        healthOk: true,
        checkedAt: new Date(this.now()).toISOString(),
      },
    }
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** systemd unit names allow [a-zA-Z0-9:_.\-]; sanitize the rrid for the scope. */
function sanitizeUnit(rrid: string): string {
  return rrid.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80)
}

/** The candidate ref a job's release lane pushes its verified sha to. Computed
 *  at spawn (into the lane argsFile) AND re-derived to bind a checkpoint — SAME
 *  construction, single source (R2-3). */
export function candidateRefFor(repairId: string, sha: string): string {
  return `refs/heads/selfheal/candidates/${repairId}-${sha.slice(0, 12)}`
}

/** Classify a `systemctl is-active` state string into three-state liveness
 *  (R2-2). Alive (active|activating|deactivating|reloading) → 'active';
 *  definitively dead (inactive|failed|dead) → 'inactive'; anything else
 *  (unknown|empty|unexpected) → 'unknown' (fail-closed — never settled on). */
export function classifyScopeState(stdout: string): ScopeLiveness {
  switch (stdout.trim()) {
    case 'active':
    case 'activating':
    case 'deactivating':
    case 'reloading':
      return 'active'
    case 'inactive':
    case 'failed':
    case 'dead':
      return 'inactive'
    default:
      return 'unknown'
  }
}

/** Mirror of the prover's surface→face mapping (ops/selfheal-release-proof.ts
 *  proveSurfaces): every plan surface MUST have its face present in a valid
 *  checkpoint. Fail-closed: an unknown surface name yields null (no valid
 *  expectation can be computed → the checkpoint cannot bind). */
const SURFACE_TO_FACE: Record<string, string> = {
  master: 'master',
  web: 'web',
  egress: 'egress',
  'runtime-source': 'runtime',
  'platform-runtime': 'platform',
}
const STAGING_SURFACES = new Set(['web', 'runtime-source', 'platform-runtime', 'egress'])
function expectedFacesForSurfaces(surfaces: string[]): string[] | null {
  if (surfaces.length === 0) return null
  const faces = new Set<string>()
  for (const s of surfaces) {
    const f = SURFACE_TO_FACE[s]
    if (!f) return null
    faces.add(f)
  }
  if (surfaces.some((s) => STAGING_SURFACES.has(s))) faces.add('slot')
  return [...faces]
}

/** Proofs cover the FROZEN plan and all pass (R2-3 + R3-2): a NON-EMPTY object
 *  whose keys are a superset of every face the plan's touched surfaces demand
 *  (a one-face proof can never validate a multi-surface plan), and whose every
 *  value is an object with `.ok === true`. Anything else → NOT a valid
 *  deploy_effect_applied proof. */
function proofsCoverPlan(proofs: unknown, planSurfaces: string[]): boolean {
  if (!proofs || typeof proofs !== 'object' || Array.isArray(proofs)) return false
  const rec = proofs as Record<string, unknown>
  const present = Object.keys(rec)
  if (present.length === 0) return false
  const expected = expectedFacesForSurfaces(planSurfaces)
  if (!expected) return false
  if (!expected.every((f) => present.includes(f))) return false
  return present.every((k) => {
    const f = rec[k]
    return !!f && typeof f === 'object' && (f as { ok?: unknown }).ok === true
  })
}

/** Frozen plan surfaces from the job's planJson (same extraction runClaimed uses). */
function planSurfacesOf(job: SelfhealReleaseJob): string[] {
  const plan = safeParse(job.planJson)
  const cls = (plan.classification ?? {}) as Record<string, unknown>
  return Array.isArray(cls.surfaces) ? (cls.surfaces as string[]).filter((s) => typeof s === 'string') : []
}

/** Strong checkpoint binding predicate (§F5③ + R2-3), shared by the persist-time
 *  gate and the recovery-time consumer. A checkpoint is honored (deploy effect
 *  proven applied) ONLY when it binds the job's frozen values on ALL of: kind,
 *  rrid, sha, planHash, manifestHash (SAME null→'' normalization the lane
 *  argsFile writes), the EXPECTED candidateRef (so a stranger's push can never be
 *  mistaken for this job's effect), AND non-empty all-ok proofs. Anything else is
 *  rejected (treated as no checkpoint → the unknown path). */
function checkpointRecordBinds(cp: Record<string, unknown>, job: SelfhealReleaseJob): boolean {
  return (
    cp.kind === 'deploy_effect_applied' &&
    cp.rrid === job.releaseRequestId &&
    cp.sha === job.approvedSha &&
    cp.planHash === (job.deployPlanHash ?? '') &&
    cp.manifestHash === (job.manifestHash ?? '') &&
    cp.candidateRef === candidateRefFor(job.repairId, job.approvedSha) &&
    proofsCoverPlan(cp.proofs, planSurfacesOf(job))
  )
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const o = JSON.parse(json)
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function parseReceipt(raw: string | null): ReceiptShape | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw)
    if (o && typeof o === 'object' && !Array.isArray(o)) return o as ReceiptShape
  } catch {
    /* fall through */
  }
  return null
}

/** Strong receipt binding (§8.2): rrid/sha must equal the job's frozen values,
 *  outcome must be a known code, exit must be an integer. Any deviation is
 *  malformed → the caller settles deploy_unknown. */
function receiptValid(r: ReceiptShape | null, job: SelfhealReleaseJob): boolean {
  return (
    !!r &&
    r.evt === 'receipt' &&
    r.rrid === job.releaseRequestId &&
    r.sha === job.approvedSha &&
    ['deployed', 'deploy_failed', 'deploy_unknown', 'manual'].includes(r.outcome) &&
    Number.isInteger(r.exit)
  )
}
