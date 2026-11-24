/**
 * Deterministic zero-token stall monitor for Antigravity Swarms (OCV5-848).
 *
 * Replaces the built-in LLM `@monitor` worker (which woke on a 3-minute cron
 * inside its own growing conversation history and burned tens of millions of
 * cache-read tokens on idle ticks).
 *
 * Bounded state only (never accumulates transcript/prompt history):
 *   1. Stage boundary (`lastDoneSeq`, `doneMemberSnapshot`) — resets cleanly
 *      only on an explicit new-stage start signal (coordinator non-`[done]`
 *      post or newly recruited core worker), ignoring late worker stragglers.
 *   2. Business progress key (`lastBusinessKey`) separated from transient
 *      activity (`lastActivityKey`, `lastQuietSince`): transient wake/re-park
 *      (e.g. a member waking on `[stall]`, bumping `stepCount`, and re-entering
 *      `swarm_wait` without posting work) delays the idle clock but NEVER resets
 *      `alertCount` or `repingedMentions`.
 *   3. Alert backoff state (`alertCount`, `lastAlertAt`) — hard-capped at
 *      `maxAlerts`.
 *   4. Per-member re-ping map (`repingedMentions`) — bounded by active roster
 *      size, escalating to `@coordinator` if a direct re-ping went unanswered.
 */
import type {
  SwarmBoardPost,
  SwarmMemberRole,
  SwarmMemberSnapshot,
  SwarmSnapshot,
} from '@openclaude/protocol'

export const GATEWAY_STALL_MONITOR_AGENT = 'gateway-monitor'
export const DEFAULT_SWARM_STALL_THRESHOLD_MS = 180_000
export const DEFAULT_SWARM_WORKING_STALL_THRESHOLD_MS = 2_400_000
export const DEFAULT_SWARM_STALL_RETRY_COOLDOWN_MS = 540_000
export const DEFAULT_SWARM_STALL_MAX_ALERTS = 3
export const DEFAULT_SWARM_STALL_DIAGNOSTIC_THROTTLE_MS = 30_000

export type SwarmStallReason =
  | 'member_failed'
  | 'working_member_stalled'
  | 'unanswered_mention'
  | 'unanswered_mention_escalated'
  | 'unclaimed_result'
  | 'channel_stalled'
  | 'idle_waiting'

export type SwarmStallDiagnosticKind =
  | 'skipped_phase'
  | 'skipped_no_workers'
  | 'stage_done_entered'
  | 'stage_done_suppressed'
  | 'stage_rearmed'
  | 'progress_reset'
  | 'skipped_working'
  | 'activity_postponed'
  | 'quiet_waiting'
  | 'suppressed_max_alerts'
  | 'suppressed_cooldown'
  | 'alert_emitted'

export interface SwarmStallDiagnosticEvent {
  readonly kind: SwarmStallDiagnosticKind
  readonly swarmId: string
  readonly phase: SwarmSnapshot['phase']
  readonly headSeq: number
  readonly idleMs: number
  readonly alertCount: number
  readonly workingMembers: readonly string[]
  readonly waitingMembers: readonly string[]
  readonly reason?: SwarmStallReason
  readonly target?: string
  readonly detail?: string
}

export interface SwarmStallAlert {
  /** Single target member name (without leading `@`, never `all`). */
  readonly target: string
  /** Target board channel (typically `main`). */
  readonly channel: string
  readonly reason: SwarmStallReason
  /** Formatted board post beginning with `@<target> [stall] ...`. */
  readonly message: string
  readonly attempt: number
  readonly idleMs: number
  /** Highest sequence number of non-monitor posts observed. */
  readonly headSeq: number
  readonly citedSeqs: readonly number[]
}

export interface SwarmStallMonitorOptions {
  /** Quiet duration before emitting the first stall alert when all core members are parked (default 3 min). */
  stallThresholdMs?: number
  /** Quiet duration with zero step/tool/board progress before alerting on a stuck `working` member (default `max(2 * stallThresholdMs, 6 min)`). */
  workingStallThresholdMs?: number
  /** Cooldown between repeated alerts for the same stall (default 9 min). */
  retryCooldownMs?: number
  /** Max consecutive alerts for the same stall before going silent (default 3). */
  maxAlerts?: number
  /** Optional structured diagnostic observer (throttled on repetitive checks, immediate on transitions/alerts). */
  onDiagnostic?: (event: SwarmStallDiagnosticEvent) => void
  /** Minimum interval between repetitive diagnostic logs of the same kind (default 30s). */
  diagnosticThrottleMs?: number
}

const MONITOR_NAME_RE = /^monitor(?:-\d+)?$/i
const DONE_PREFIX_RE = /^\s*(?:@all\s+)?(?:\*{1,2}|_{1,2})?\[done\](?::|：)?(?:\*{1,2}|_{1,2})?(?:\s|$|:|：|-|—)/i
const PARKED_WAIT_ACTIVITIES = new Set(['等待讨论板消息', '已完成本轮思考'])

export function isSwarmMonitorAgentName(name: string): boolean {
  const lower = name.trim().toLowerCase()
  return lower === GATEWAY_STALL_MONITOR_AGENT || MONITOR_NAME_RE.test(lower)
}

export function isSwarmAuxiliaryRole(role: SwarmMemberRole): boolean {
  return role === 'monitor' || role === 'narrator'
}

/**
 * True when a live member is parked waiting for board activity rather than
 * actively executing tools or thinking.
 *
 * Note: in native Antigravity transcripts, a member currently blocked inside
 * `swarm_wait` shows `status: 'working'` with `activity: '等待讨论板消息'`.
 * Treating that state as effectively waiting prevents deadlocked `swarm_wait`
 * pairs from looking permanently busy.
 */
export function isMemberEffectivelyWaiting(member: SwarmMemberSnapshot): boolean {
  if (member.status === 'killed') return false
  if (member.status === 'waiting' || member.status === 'stopped') return true
  if (typeof member.waitingOnBoard === 'boolean') return member.waitingOnBoard
  return (
    member.status === 'working' &&
    typeof member.activity === 'string' &&
    PARKED_WAIT_ACTIVITIES.has(member.activity)
  )
}

function isMonitorPost(post: SwarmBoardPost): boolean {
  return isSwarmMonitorAgentName(post.agent)
}

function isCoordinatorDonePost(post: SwarmBoardPost): boolean {
  return post.agent.trim().toLowerCase() === 'coordinator' && DONE_PREFIX_RE.test(post.text)
}

function mentionMatchesWorker(mention: string, workerName: string): boolean {
  const m = mention.toLowerCase()
  const w = workerName.toLowerCase()
  if (!m || m === 'all' || m.startsWith('#')) return false
  if (m === w) return true
  return w.startsWith(`${m}-`) && /^\d+$/.test(w.slice(m.length + 1))
}

function postHasLiveCoreRecipient(
  post: SwarmBoardPost,
  liveCoreMembers: readonly SwarmMemberSnapshot[],
): boolean {
  if (post.mentions.length === 0) return false
  const senderLower = post.agent.trim().toLowerCase()
  for (const rawMention of post.mentions) {
    const m = rawMention.toLowerCase()
    if (m === 'all') return true
    if (m === 'coordinator') return senderLower !== 'coordinator'
    if (m.startsWith('#')) {
      const ch = m.slice(1)
      if (
        ch &&
        liveCoreMembers.some(
          (member) =>
            member.name.toLowerCase() !== senderLower &&
            (member.channels ?? ['main']).includes(ch),
        )
      ) {
        return true
      }
      continue
    }
    if (
      liveCoreMembers.some(
        (member) =>
          member.name.toLowerCase() !== senderLower && mentionMatchesWorker(m, member.name),
      )
    ) {
      return true
    }
  }
  return false
}

function formatIdleMinutes(idleMs: number): number {
  return Math.max(1, Math.round(idleMs / 60_000))
}

/**
 * Neutralize `@mention` tokens in quoted error/member strings so a single-target
 * stall alert can NEVER accidentally wake `@all`, `@#channel`, or other workers.
 */
function sanitizeQuotedText(text: string | undefined, maxChars: number, fallback: string): string {
  const clean = (text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/@/g, '＠')
    .replace(/`/g, "'")
    .trim()
  if (!clean) return fallback
  return clean.length <= maxChars ? clean : `${clean.slice(0, Math.max(1, maxChars - 1))}…`
}

export class SwarmStallMonitor {
  private readonly stallThresholdMs: number
  private readonly workingStallThresholdMs: number
  private readonly retryCooldownMs: number
  private readonly maxAlerts: number
  private readonly onDiagnostic?: (event: SwarmStallDiagnosticEvent) => void
  private readonly diagnosticThrottleMs: number

  /** Highest coordinator `[done]` post seq observed. */
  private lastDoneSeq = 0
  /** Whether the swarm is currently settled in a `[done]` stage awaiting an explicit new-stage start. */
  private stageDone = false
  /** Live core worker names present when the stage entered `[done]` (detects newly added workers). */
  private doneWorkerNames = new Set<string>()
  /**
   * Independent business-progress fingerprint (excludes `stepCount`, `unreadCount`,
   * and transient `working`/`waiting` toggles). Only a change here resets `alertCount`
   * and `repingedMentions`.
   */
  private lastBusinessKey: string | null = null
  /**
   * Transient activity fingerprint (includes `stepCount` and effective status).
   * A change here pushes `lastQuietSince` forward while members settle, without
   * resetting the alert budget.
   */
  private lastActivityKey: string | null = null
  private lastQuietSince = 0
  private alertCount = 0
  private lastAlertAt = 0
  private prevAlertAt = 0
  private readonly repingedMentions = new Map<string, number>()
  private lastDiagnosticKind: SwarmStallDiagnosticKind | null = null
  private lastDiagnosticAt = 0

  constructor(opts?: SwarmStallMonitorOptions) {
    this.stallThresholdMs = Math.max(1_000, opts?.stallThresholdMs ?? DEFAULT_SWARM_STALL_THRESHOLD_MS)
    this.workingStallThresholdMs = Math.max(
      this.stallThresholdMs,
      opts?.workingStallThresholdMs ??
        Math.max(this.stallThresholdMs * 2, DEFAULT_SWARM_WORKING_STALL_THRESHOLD_MS),
    )
    this.retryCooldownMs = Math.max(1_000, opts?.retryCooldownMs ?? DEFAULT_SWARM_STALL_RETRY_COOLDOWN_MS)
    this.maxAlerts = Math.max(1, Math.floor(opts?.maxAlerts ?? DEFAULT_SWARM_STALL_MAX_ALERTS))
    this.onDiagnostic = opts?.onDiagnostic
    this.diagnosticThrottleMs = Math.max(
      0,
      opts?.diagnosticThrottleMs ?? DEFAULT_SWARM_STALL_DIAGNOSTIC_THROTTLE_MS,
    )
  }

  /** Clear all state on turn end, user stop, or swarm teardown. */
  reset(): void {
    this.lastDoneSeq = 0
    this.stageDone = false
    this.doneWorkerNames.clear()
    this.lastBusinessKey = null
    this.lastActivityKey = null
    this.lastQuietSince = 0
    this.lastDiagnosticKind = null
    this.lastDiagnosticAt = 0
    this.clearAlertState()
  }

  private clearAlertState(): void {
    this.alertCount = 0
    this.lastAlertAt = 0
    this.prevAlertAt = 0
    this.repingedMentions.clear()
  }

  /**
   * Roll back the most recently emitted alert when board lock contention or
   * delivery failure prevented it from actually landing on `board.jsonl`.
   */
  rollbackAlert(alert: SwarmStallAlert): void {
    if (this.alertCount !== alert.attempt || this.alertCount <= 0) return
    this.alertCount -= 1
    this.lastAlertAt = this.prevAlertAt
    if (alert.reason === 'unanswered_mention') {
      const targetLower = alert.target.trim().toLowerCase()
      const cited = alert.citedSeqs[0]
      if (cited !== undefined && this.repingedMentions.get(targetLower) === cited) {
        this.repingedMentions.delete(targetLower)
      }
    }
  }

  private emitDiagnostic(
    now: number,
    event: SwarmStallDiagnosticEvent,
    opts?: { immediate?: boolean },
  ): void {
    if (!this.onDiagnostic) return
    const immediate = opts?.immediate === true
    if (
      !immediate &&
      this.lastDiagnosticKind === event.kind &&
      this.diagnosticThrottleMs > 0 &&
      now - this.lastDiagnosticAt < this.diagnosticThrottleMs
    ) {
      return
    }
    this.lastDiagnosticKind = event.kind
    this.lastDiagnosticAt = now
    try {
      this.onDiagnostic(event)
    } catch {
      // Diagnostic observer errors must never break stall monitoring.
    }
  }

  /**
   * Inspect a snapshot in O(members + recentPosts) memory time with zero I/O and
   * zero LLM calls. Returns an alert only when every live core member is parked
   * past `stallThresholdMs` and the current stage is active (not `[done]`).
   */
  evaluate(snap: SwarmSnapshot, now: number = Date.now()): SwarmStallAlert | null {
    if (snap.phase !== 'running' && snap.phase !== 'starting') {
      this.emitDiagnostic(now, {
        kind: 'skipped_phase',
        swarmId: snap.swarmId,
        phase: snap.phase,
        headSeq: 0,
        idleMs: 0,
        alertCount: this.alertCount,
        workingMembers: [],
        waitingMembers: [],
      })
      this.reset()
      return null
    }

    const liveCoreMembers = snap.members.filter(
      (m) => m.status !== 'killed' && !isSwarmAuxiliaryRole(m.role),
    )
    const liveWorkers = liveCoreMembers.filter((m) => m.role !== 'coordinator')
    if (liveWorkers.length === 0) {
      this.lastBusinessKey = null
      this.lastActivityKey = null
      this.lastQuietSince = now
      this.clearAlertState()
      this.emitDiagnostic(now, {
        kind: 'skipped_no_workers',
        swarmId: snap.swarmId,
        phase: snap.phase,
        headSeq: 0,
        idleMs: 0,
        alertCount: 0,
        workingMembers: [],
        waitingMembers: liveCoreMembers.map((m) => m.name),
      })
      return null
    }

    const nonMonitorPosts = snap.posts.filter((p) => !isMonitorPost(p))
    const effectiveHeadSeq =
      nonMonitorPosts.length > 0 ? nonMonitorPosts[nonMonitorPosts.length - 1]!.seq : 0

    const workingMembers: string[] = []
    const waitingMembers: string[] = []
    for (const m of liveCoreMembers) {
      if (isMemberEffectivelyWaiting(m)) waitingMembers.push(m.name)
      else workingMembers.push(m.name)
    }

    let newestDoneSeq = this.lastDoneSeq
    for (const post of nonMonitorPosts) {
      if (isCoordinatorDonePost(post) && post.seq > newestDoneSeq) {
        newestDoneSeq = post.seq
      }
    }
    const currentWorkerNames = new Set(liveWorkers.map((w) => w.name.toLowerCase()))

    if (newestDoneSeq > this.lastDoneSeq) {
      this.lastDoneSeq = newestDoneSeq
      this.stageDone = true
      this.doneWorkerNames = currentWorkerNames
      this.clearAlertState()
      this.emitDiagnostic(
        now,
        {
          kind: 'stage_done_entered',
          swarmId: snap.swarmId,
          phase: snap.phase,
          headSeq: effectiveHeadSeq,
          idleMs: 0,
          alertCount: 0,
          workingMembers,
          waitingMembers,
          detail: `doneSeq=#${newestDoneSeq}`,
        },
        { immediate: true },
      )
    }

    const postsAfterDone = nonMonitorPosts.filter((p) => p.seq > this.lastDoneSeq)
    if (this.stageDone) {
      // Only an explicit new-stage start signal re-arms monitoring after `[done]`:
      //   1. Coordinator posts a new non-`[done]` message after `lastDoneSeq`, OR
      //   2. A brand-new core worker was added after `[done]`.
      // Late worker straggler replies after `[done]` MUST NOT re-arm the monitor.
      const coordinatorStartedNewStage = postsAfterDone.some(
        (p) => p.agent.trim().toLowerCase() === 'coordinator' && !isCoordinatorDonePost(p),
      )
      const newWorkerRecruited = [...currentWorkerNames].some((n) => !this.doneWorkerNames.has(n))
      if (!coordinatorStartedNewStage && !newWorkerRecruited) {
        this.lastQuietSince = now
        this.emitDiagnostic(now, {
          kind: 'stage_done_suppressed',
          swarmId: snap.swarmId,
          phase: snap.phase,
          headSeq: effectiveHeadSeq,
          idleMs: 0,
          alertCount: this.alertCount,
          workingMembers,
          waitingMembers,
        })
        return null
      }
      this.stageDone = false
      this.doneWorkerNames.clear()
      this.clearAlertState()
      this.emitDiagnostic(
        now,
        {
          kind: 'stage_rearmed',
          swarmId: snap.swarmId,
          phase: snap.phase,
          headSeq: effectiveHeadSeq,
          idleMs: 0,
          alertCount: 0,
          workingMembers,
          waitingMembers,
          detail: coordinatorStartedNewStage ? 'coordinator_post' : 'new_worker',
        },
        { immediate: true },
      )
    }

    const stagePosts = postsAfterDone
    const sortedCore = [...liveCoreMembers].sort((a, b) => a.name.localeCompare(b.name))

    // Independent business progress key: strictly excludes `stepCount`, `unreadCount`,
    // and transient `working`/`waiting` toggles so an alert waking a member that merely
    // re-enters `swarm_wait` CANNOT reset `alertCount` or bypass the 3-alert cap.
    const businessKey = [
      effectiveHeadSeq,
      ...sortedCore.map((m) => `${m.name}:${m.failed ? 1 : 0}:${m.lastPostSeq ?? 0}`),
    ].join('|')

    // Activity key tracks transient work/step movement so we postpone alerting while
    // a member is actively stepping, without resetting the alert budget.
    const activityKey = [
      businessKey,
      ...sortedCore.map(
        (m) =>
          `${m.name}:${isMemberEffectivelyWaiting(m) ? 'parked' : m.status}:${m.stepCount}:${m.toolCalls ?? 0}:${m.lastActiveAt ?? 0}:${m.activity ?? ''}`,
      ),
    ].join('|')

    const anyWorking = workingMembers.length > 0

    if (this.lastBusinessKey === null) {
      this.lastBusinessKey = businessKey
      this.lastActivityKey = activityKey
      this.lastQuietSince = now
      this.emitDiagnostic(now, {
        kind: anyWorking ? 'skipped_working' : 'quiet_waiting',
        swarmId: snap.swarmId,
        phase: snap.phase,
        headSeq: effectiveHeadSeq,
        idleMs: 0,
        alertCount: this.alertCount,
        workingMembers,
        waitingMembers,
        detail: 'baseline_seeded',
      })
      return null
    }

    if (businessKey !== this.lastBusinessKey) {
      this.lastBusinessKey = businessKey
      this.lastActivityKey = activityKey
      this.lastQuietSince = now
      this.clearAlertState()
      this.emitDiagnostic(now, {
        kind: 'progress_reset',
        swarmId: snap.swarmId,
        phase: snap.phase,
        headSeq: effectiveHeadSeq,
        idleMs: 0,
        alertCount: 0,
        workingMembers,
        waitingMembers,
      })
      return null
    }

    if (anyWorking) {
      if (activityKey !== this.lastActivityKey) {
        this.lastActivityKey = activityKey
        this.lastQuietSince = now
        this.emitDiagnostic(now, {
          kind: 'skipped_working',
          swarmId: snap.swarmId,
          phase: snap.phase,
          headSeq: effectiveHeadSeq,
          idleMs: 0,
          alertCount: this.alertCount,
          workingMembers,
          waitingMembers,
        })
        return null
      }
      const workingIdleMs = Math.max(0, now - this.lastQuietSince)
      if (workingIdleMs < this.workingStallThresholdMs) {
        this.emitDiagnostic(now, {
          kind: 'skipped_working',
          swarmId: snap.swarmId,
          phase: snap.phase,
          headSeq: effectiveHeadSeq,
          idleMs: workingIdleMs,
          alertCount: this.alertCount,
          workingMembers,
          waitingMembers,
        })
        return null
      }
    } else if (activityKey !== this.lastActivityKey) {
      // Member briefly woke / stepped and re-parked with no new business post:
      // postpone idle timer, but keep `alertCount` and `repingedMentions` intact.
      this.lastActivityKey = activityKey
      this.lastQuietSince = now
      this.emitDiagnostic(now, {
        kind: 'activity_postponed',
        swarmId: snap.swarmId,
        phase: snap.phase,
        headSeq: effectiveHeadSeq,
        idleMs: 0,
        alertCount: this.alertCount,
        workingMembers,
        waitingMembers,
      })
      return null
    }

    const idleMs = Math.max(0, now - this.lastQuietSince)
    const activeThresholdMs = anyWorking ? this.workingStallThresholdMs : this.stallThresholdMs
    if (idleMs < activeThresholdMs) {
      this.emitDiagnostic(now, {
        kind: anyWorking ? 'skipped_working' : 'quiet_waiting',
        swarmId: snap.swarmId,
        phase: snap.phase,
        headSeq: effectiveHeadSeq,
        idleMs,
        alertCount: this.alertCount,
        workingMembers,
        waitingMembers,
      })
      return null
    }
    if (this.alertCount >= this.maxAlerts) {
      this.emitDiagnostic(now, {
        kind: 'suppressed_max_alerts',
        swarmId: snap.swarmId,
        phase: snap.phase,
        headSeq: effectiveHeadSeq,
        idleMs,
        alertCount: this.alertCount,
        workingMembers,
        waitingMembers,
      })
      return null
    }
    if (this.alertCount > 0 && now - this.lastAlertAt < this.retryCooldownMs) {
      this.emitDiagnostic(now, {
        kind: 'suppressed_cooldown',
        swarmId: snap.swarmId,
        phase: snap.phase,
        headSeq: effectiveHeadSeq,
        idleMs,
        alertCount: this.alertCount,
        workingMembers,
        waitingMembers,
      })
      return null
    }

    const attempt = this.alertCount + 1
    const alert = this.diagnoseStall({
      snap,
      liveCoreMembers,
      liveWorkers,
      workingMembers,
      stagePosts,
      effectiveHeadSeq,
      idleMs,
      attempt,
    })

    this.prevAlertAt = this.lastAlertAt
    this.alertCount = attempt
    this.lastAlertAt = now
    this.emitDiagnostic(
      now,
      {
        kind: 'alert_emitted',
        swarmId: snap.swarmId,
        phase: snap.phase,
        headSeq: effectiveHeadSeq,
        idleMs,
        alertCount: attempt,
        workingMembers,
        waitingMembers,
        reason: alert.reason,
        target: alert.target,
      },
      { immediate: true },
    )
    return alert
  }

  private diagnoseStall(input: {
    snap: SwarmSnapshot
    liveCoreMembers: readonly SwarmMemberSnapshot[]
    liveWorkers: readonly SwarmMemberSnapshot[]
    workingMembers: readonly string[]
    stagePosts: readonly SwarmBoardPost[]
    effectiveHeadSeq: number
    idleMs: number
    attempt: number
  }): SwarmStallAlert {
    const { snap, liveCoreMembers, liveWorkers, workingMembers, stagePosts, effectiveHeadSeq, idleMs, attempt } = input
    const idleMins = formatIdleMinutes(idleMs)
    const coordinator = liveCoreMembers.find((m) => m.role === 'coordinator')

    // 0. A working member has made zero step/tool/board progress past `workingStallThresholdMs`.
    if (workingMembers.length > 0) {
      const workingSet = new Set(workingMembers.map((n) => n.toLowerCase()))
      const stuckWorker =
        liveWorkers.find((w) => workingSet.has(w.name.toLowerCase())) ??
        liveCoreMembers.find((m) => workingSet.has(m.name.toLowerCase()))
      if (stuckWorker) {
        const safeName = sanitizeQuotedText(stuckWorker.name, 64, 'worker')
        const actSummary = sanitizeQuotedText(stuckWorker.activity, 80, '处理中')
        const cited = stuckWorker.lastPostSeq ? [stuckWorker.lastPostSeq] : []
        return {
          target: 'coordinator',
          channel: 'main',
          reason: 'working_member_stalled',
          message: `@coordinator [stall] 成员 \`${safeName}\` 在步骤 #${stuckWorker.stepCount}（${actSummary}）已连续 ${idleMins} 分钟无新步骤或讨论板进展，其余成员均在等待，请检查其状态、催促汇报或视情况改派。`,
          attempt,
          idleMs,
          headSeq: effectiveHeadSeq,
          citedSeqs: cited,
        }
      }
    }

    // 1. Failed worker needs coordinator intervention (never @ the failed worker itself,
    //    and strip `@` from error text so no bystander member or `@all` is ever woken).
    const failedWorker = liveWorkers.find((w) => w.failed === true)
    if (failedWorker) {
      const safeName = sanitizeQuotedText(failedWorker.name, 64, 'worker')
      const errSummary = sanitizeQuotedText(failedWorker.lastError, 120, '执行出错')
      const cited = failedWorker.lastPostSeq ? [failedWorker.lastPostSeq] : []
      return {
        target: 'coordinator',
        channel: 'main',
        reason: 'member_failed',
        message: `@coordinator [stall] 成员 \`${safeName}\` 执行异常（${errSummary}），全员已静默 ${idleMins} 分钟，请检查是否需要重试、切换模型或回收。`,
        attempt,
        idleMs,
        headSeq: effectiveHeadSeq,
        citedSeqs: cited,
      }
    }

    // 2. Direct @mention to a waiting worker went unanswered.
    for (let i = stagePosts.length - 1; i >= 0; i -= 1) {
      const post = stagePosts[i]!
      if (post.mentions.length === 0) continue
      const senderLower = post.agent.trim().toLowerCase()
      for (const worker of liveWorkers) {
        const workerLower = worker.name.toLowerCase()
        if (workerLower === senderLower) continue
        const mentioned = post.mentions.some((m) => mentionMatchesWorker(m, worker.name))
        if (!mentioned) continue
        if (worker.lastPostSeq !== undefined && worker.lastPostSeq >= post.seq) continue

        const alreadyRepingedSeq = this.repingedMentions.get(workerLower)
        if (alreadyRepingedSeq === post.seq) {
          const safeName = sanitizeQuotedText(worker.name, 64, 'worker')
          return {
            target: 'coordinator',
            channel: 'main',
            reason: 'unanswered_mention_escalated',
            message: `@coordinator [stall] 成员 \`${safeName}\` 对 #${post.seq}（此前已催促）仍无响应，全员已静默 ${idleMins} 分钟，可能受限或异常，请排查、切换模型或改派。`,
            attempt,
            idleMs,
            headSeq: effectiveHeadSeq,
            citedSeqs: [post.seq],
          }
        }
        this.repingedMentions.set(workerLower, post.seq)
        const targetChannel =
          post.channel && post.channel !== 'main' && (worker.channels ?? ['main']).includes(post.channel)
            ? post.channel
            : 'main'
        return {
          target: worker.name,
          channel: targetChannel,
          reason: 'unanswered_mention',
          message: `@${worker.name} [stall] #${post.seq} 提到了你但尚未见回复，全员已静默 ${idleMins} 分钟，请处理或汇报进展。`,
          attempt,
          idleMs,
          headSeq: effectiveHeadSeq,
          citedSeqs: [post.seq],
        }
      }
    }

    // 3. Result went to nobody or coordinator left unread worker posts.
    const boardHeadSeq = snap.posts.length > 0 ? snap.posts[snap.posts.length - 1]!.seq : 0
    const coordLastReadSeq = coordinator ? Math.max(0, boardHeadSeq - coordinator.unreadCount) : 0
    const coordLastPostSeq = coordinator?.lastPostSeq ?? 0
    const unclaimedPosts = stagePosts.filter((post) => {
      if (post.agent.trim().toLowerCase() === 'coordinator') return false
      if (post.seq <= coordLastPostSeq) return false
      const unreadByCoord = coordinator ? post.seq > coordLastReadSeq : true
      const unaddressed = !postHasLiveCoreRecipient(post, liveCoreMembers)
      return unreadByCoord || unaddressed
    })
    if (unclaimedPosts.length > 0) {
      const recent = unclaimedPosts.slice(-3)
      const seqLabel = recent.map((p) => `#${p.seq}`).join('、')
      const authors = [...new Set(recent.map((p) => `\`${sanitizeQuotedText(p.agent, 64, 'worker')}\``))].join('、')
      return {
        target: 'coordinator',
        channel: 'main',
        reason: 'unclaimed_result',
        message: `@coordinator [stall] ${seqLabel}（来自 ${authors}）无人认领或未读，全员已静默 ${idleMins} 分钟，请审阅并分派下一步（如已完成请发 [done]）。`,
        attempt,
        idleMs,
        headSeq: effectiveHeadSeq,
        citedSeqs: recent.map((p) => p.seq),
      }
    }

    // 4. Non-main channel stalled without notifying coordinator.
    const latestStagePost = stagePosts[stagePosts.length - 1]
    if (
      latestStagePost &&
      latestStagePost.channel &&
      latestStagePost.channel !== 'main' &&
      !latestStagePost.mentions.includes('coordinator')
    ) {
      const chMeta = snap.channels.find((c) => c.name === latestStagePost.channel)
      if (!chMeta?.archived) {
        const safeCh = sanitizeQuotedText(latestStagePost.channel, 64, 'channel')
        return {
          target: 'coordinator',
          channel: 'main',
          reason: 'channel_stalled',
          message: `@coordinator [stall] 频道 #${safeCh} 自 #${latestStagePost.seq} 后已静默 ${idleMins} 分钟且未通知协调者，请核查是否需要推进或收口。`,
          attempt,
          idleMs,
          headSeq: effectiveHeadSeq,
          citedSeqs: [latestStagePost.seq],
        }
      }
    }

    // 5. Fallback: everyone is parked with no active work.
    const headHint = effectiveHeadSeq > 0 ? `（最新讨论 #${effectiveHeadSeq}）` : ''
    return {
      target: 'coordinator',
      channel: 'main',
      reason: 'idle_waiting',
      message: `@coordinator [stall] 全员已静默等待 ${idleMins} 分钟${headHint}，请推进下一步任务或发送 [done] 结束本阶段。`,
      attempt,
      idleMs,
      headSeq: effectiveHeadSeq,
      citedSeqs: effectiveHeadSeq > 0 ? [effectiveHeadSeq] : [],
    }
  }
}
