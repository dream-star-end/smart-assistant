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
  SwarmMemberSnapshot,
  SwarmSnapshot,
} from '@openclaude/protocol'
import {
  DEFAULT_SWARM_STALL_DIAGNOSTIC_THROTTLE_MS,
  DEFAULT_SWARM_STALL_EXHAUSTED_GRACE_MS,
  DEFAULT_SWARM_STALL_MAX_ALERTS,
  DEFAULT_SWARM_STALL_RETRY_COOLDOWN_MS,
  DEFAULT_SWARM_STALL_THRESHOLD_MS,
  DEFAULT_SWARM_WORKING_STALL_THRESHOLD_MS,
  GATEWAY_STALL_MONITOR_AGENT,
  formatIdleMinutes,
  isCoordinatorDonePost,
  isMemberEffectivelyWaiting,
  isMonitorPost,
  isProgressUpdatePost,
  isSwarmAuxiliaryRole,
  isSwarmMonitorAgentName,
  mentionMatchesWorker,
  postHasLiveCoreRecipient,
  sanitizeQuotedText,
  type SwarmStallAlert,
  type SwarmStallDiagnosticEvent,
  type SwarmStallDiagnosticKind,
  type SwarmStallExhaustion,
  type SwarmStallMonitorOptions,
  type SwarmStallReason,
} from './swarmStallTypes.js'

import { classifyWork, findPeerHandoffs } from './swarmStallBoard.js'

export {
  DEFAULT_SWARM_STALL_DIAGNOSTIC_THROTTLE_MS,
  DEFAULT_SWARM_STALL_EXHAUSTED_GRACE_MS,
  DEFAULT_SWARM_STALL_MAX_ALERTS,
  DEFAULT_SWARM_STALL_RETRY_COOLDOWN_MS,
  DEFAULT_SWARM_STALL_THRESHOLD_MS,
  DEFAULT_SWARM_WORKING_STALL_THRESHOLD_MS,
  GATEWAY_STALL_MONITOR_AGENT,
  isMemberEffectivelyWaiting,
  isProgressUpdatePost,
  isSwarmAuxiliaryRole,
  isSwarmMonitorAgentName,
  type SwarmStallAlert,
  type SwarmStallDiagnosticEvent,
  type SwarmStallDiagnosticKind,
  type SwarmStallExhaustion,
  type SwarmStallMonitorOptions,
  type SwarmStallReason,
}

export class SwarmStallMonitor {
  private readonly stallThresholdMs: number
  private readonly workingStallThresholdMs: number
  private readonly retryCooldownMs: number
  private readonly exhaustedGraceMs: number
  private readonly maxAlerts: number
  private readonly onDiagnostic?: (event: SwarmStallDiagnosticEvent) => void
  private readonly onStallExhausted?: (event: SwarmStallExhaustion) => void
  private readonly diagnosticThrottleMs: number

  /** Highest coordinator `[done]` post seq observed. */
  private lastDoneSeq = 0
  private lastBoardHead = 0
  private lastRevision = 0
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
  private stageGeneration = 0
  private alertCount = 0
  private lastAlertAt = 0
  private prevAlertAt = 0
  private exhaustedEmitted = false
  private lastWorkingMembers: readonly string[] = []
  private lastIncompleteEvidence = false
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
    this.exhaustedGraceMs = Math.max(0, opts?.exhaustedGraceMs ?? this.retryCooldownMs)
    this.maxAlerts = Math.max(1, Math.floor(opts?.maxAlerts ?? DEFAULT_SWARM_STALL_MAX_ALERTS))
    this.onDiagnostic = opts?.onDiagnostic
    this.onStallExhausted = opts?.onStallExhausted
    this.diagnosticThrottleMs = Math.max(
      0,
      opts?.diagnosticThrottleMs ?? DEFAULT_SWARM_STALL_DIAGNOSTIC_THROTTLE_MS,
    )
  }

  /** True iff the active stage has exhausted all stall alerts, zero core members are working, and transcript evidence is complete. */
  isStallSuppressedAllParked(): boolean {
    return (
      !this.stageDone &&
      !this.lastIncompleteEvidence &&
      this.alertCount >= this.maxAlerts &&
      this.lastWorkingMembers.length === 0
    )
  }

  /** Clear all state on turn end, user stop, or swarm teardown. */
  reset(): void {
    this.lastDoneSeq = 0
    this.lastBoardHead = 0
    this.lastRevision = 0
    this.stageDone = false
    this.doneWorkerNames.clear()
    this.lastBusinessKey = null
    this.lastActivityKey = null
    this.lastQuietSince = 0
    this.lastWorkingMembers = []
    this.lastIncompleteEvidence = false
    this.lastDiagnosticKind = null
    this.lastDiagnosticAt = 0
    this.clearAlertState()
  }

  private clearAlertState(): void {
    this.stageGeneration += 1
    this.alertCount = 0
    this.lastAlertAt = 0
    this.prevAlertAt = 0
    this.exhaustedEmitted = false
    this.repingedMentions.clear()
  }

  /**
   * Roll back the most recently emitted alert when board lock contention or
   * delivery failure prevented it from actually landing on `board.jsonl`.
   * Rejects stale callbacks from an earlier `stageGeneration` (OCV5-887 P2-09).
   */
  rollbackAlert(alert: SwarmStallAlert, expectedGeneration?: number): void {
    const gen = expectedGeneration ?? alert.generation
    if (gen !== this.stageGeneration) return
    if (this.alertCount !== alert.attempt || this.alertCount <= 0) return
    this.alertCount -= 1
    this.lastAlertAt = this.prevAlertAt
    if (this.alertCount < this.maxAlerts) this.exhaustedEmitted = false
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
   * Inspect the watcher's full, bounded snapshot with zero I/O and zero LLM calls.
   * Working members and accepted peer handoffs get a longer quiet window.
   */
  evaluate(snap: SwarmSnapshot, now: number = Date.now()): SwarmStallAlert | null {
    if (snap.revision < this.lastRevision) return null
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

    const nonMonitorPosts = snap.posts.filter((p) => !isMonitorPost(p)).sort((a, b) => a.seq - b.seq)
    const effectiveHeadSeq = nonMonitorPosts.at(-1)?.seq ?? 0
    if (effectiveHeadSeq < this.lastBoardHead) return null
    this.lastBoardHead = effectiveHeadSeq
    this.lastRevision = snap.revision

    const liveCoreMembers = snap.members.filter(
      (m) => m.status !== 'killed' && !isSwarmAuxiliaryRole(m.role),
    )
    const liveWorkers = liveCoreMembers.filter((m) => m.role !== 'coordinator')
    if (liveWorkers.length === 0) {
      this.lastBusinessKey = null
      this.lastActivityKey = null
      this.lastQuietSince = now
      this.lastWorkingMembers = []
      this.lastIncompleteEvidence = false
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

    const { workingMembers, waitingMembers } = classifyWork(liveCoreMembers)
    this.lastWorkingMembers = workingMembers
    this.lastIncompleteEvidence = liveCoreMembers.some(
      (m) =>
        m.livenessEvidencePartial === true ||
        (m.livenessEvidencePartial === undefined && m.telemetryPartial === true),
    )

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

    if (activityKey !== this.lastActivityKey) {
      // Member briefly woke / stepped and re-parked with no new business post:
      // postpone idle timer, but keep `alertCount` and `repingedMentions` intact.
      this.lastActivityKey = activityKey
      this.lastQuietSince = now
      this.emitDiagnostic(now, {
        kind: anyWorking ? 'skipped_working' : 'activity_postponed',
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
      return this.handleMaxAlertsReached(snap, now, idleMs, effectiveHeadSeq, workingMembers, waitingMembers)
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
    const diagnosis = this.diagnoseStall({
      snap, liveCoreMembers, liveWorkers, workingMembers, stagePosts, effectiveHeadSeq, idleMs, attempt,
    })
    if (!diagnosis) return null
    const alert = { ...diagnosis, generation: this.stageGeneration }

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

  private handleMaxAlertsReached(
    snap: SwarmSnapshot,
    now: number,
    idleMs: number,
    effectiveHeadSeq: number,
    workingMembers: readonly string[],
    waitingMembers: readonly string[],
  ): null {
    if (
      workingMembers.length === 0 &&
      !this.lastIncompleteEvidence &&
      now - this.lastAlertAt >= this.exhaustedGraceMs &&
      !this.exhaustedEmitted
    ) {
      this.exhaustedEmitted = true
      this.emitDiagnostic(
        now,
        {
          kind: 'stall_exhausted',
          swarmId: snap.swarmId,
          phase: snap.phase,
          headSeq: effectiveHeadSeq,
          idleMs,
          alertCount: this.alertCount,
          workingMembers,
          waitingMembers,
          detail: 'max_alerts_exhausted',
        },
        { immediate: true },
      )
      if (this.onStallExhausted) {
        try {
          this.onStallExhausted({
            swarmId: snap.swarmId,
            generation: this.stageGeneration,
            idleMs,
            alertCount: this.alertCount,
            headSeq: effectiveHeadSeq,
            waitingMembers: [...waitingMembers],
            reason: 'max_alerts_exhausted',
          })
        } catch (err) {
          void err
        }
      }
      return null
    }
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

  private diagnoseStall(input: {
    snap: SwarmSnapshot
    liveCoreMembers: readonly SwarmMemberSnapshot[]
    liveWorkers: readonly SwarmMemberSnapshot[]
    workingMembers: readonly string[]
    stagePosts: readonly SwarmBoardPost[]
    effectiveHeadSeq: number
    idleMs: number
    attempt: number
  }): Omit<SwarmStallAlert, 'generation'> | null {
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

    // A parked coordinator is not the recipient of a peer handoff. A direct
    // request to that coordinator, however, needs follow-through even if read.
    const mentionsOnly = coordinator?.wakeMode?.toLowerCase() === 'mentions'
    const coordLastPostSeq = coordinator?.lastPostSeq ?? 0
    const outstanding = stagePosts.filter((post) =>
      post.seq > coordLastPostSeq && post.agent.trim().toLowerCase() !== 'coordinator',
    )
    const coordinatorRequests = mentionsOnly
      ? outstanding.filter((post) => post.mentions.includes('coordinator'))
      : []
    const peerHandoffs = mentionsOnly ? findPeerHandoffs(outstanding, liveWorkers) : undefined

    if (coordinatorRequests.length === 0) {
      const unanswered = this.diagnoseUnansweredMention({
        stagePosts: stagePosts.filter((post) => !peerHandoffs?.coveredSeqs.has(post.seq)),
        liveWorkers, idleMs, attempt, effectiveHeadSeq,
      })
      if (unanswered) return unanswered
    }

    const boardHeadSeq = snap.posts.reduce((head, post) => Math.max(head, post.seq), 0)
    const coordLastReadSeq = Math.max(0, boardHeadSeq - (coordinator?.unreadCount ?? boardHeadSeq))
    const unclaimedPosts = coordinatorRequests.length > 0 ? coordinatorRequests : outstanding.filter((post) =>
      !peerHandoffs?.coveredSeqs.has(post.seq) &&
      !(post.mentions.length === 0 && isProgressUpdatePost(post)) &&
      (post.seq > coordLastReadSeq || !postHasLiveCoreRecipient(post, liveCoreMembers)),
    )
    if (unclaimedPosts.length > 0) {
      const recent = unclaimedPosts.slice(-3)
      const seqLabel = recent.map((p) => `#${p.seq}`).join('、')
      const ownership = coordinatorRequests.length > 0 ? '已点名协调者但尚无回复' : '无人认领或未读'
      const authors = [...new Set(recent.map((p) => `\`${sanitizeQuotedText(p.agent, 64, 'worker')}\``))].join('、')
      return {
        target: 'coordinator',
        channel: 'main',
        reason: 'unclaimed_result',
        message: `@coordinator [stall] ${seqLabel}（来自 ${authors}）${ownership}，全员已静默 ${idleMins} 分钟，请审阅并分派下一步（如已完成请发 [done]）。`,
        attempt,
        idleMs,
        headSeq: effectiveHeadSeq,
        citedSeqs: recent.map((p) => p.seq),
      }
    }

    // A verified handoff at the head gets the working quiet window even when
    // a native DONE/no-calls planner tail makes the verifier look parked.
    // This delays only the generic fallback, not concrete intervention requests.
    const handoffAtHead = peerHandoffs?.receiptSeq === effectiveHeadSeq
    if (handoffAtHead && idleMs < this.workingStallThresholdMs) return null

    // 4. Non-main channel stalled without notifying coordinator.
    const latestStagePost = handoffAtHead ? undefined : stagePosts.at(-1)
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
      message: handoffAtHead
        ? `@coordinator [stall] 交接回执 #${effectiveHeadSeq} 后已连续 ${idleMins} 分钟无新步骤、工具或讨论板进展，请核查任务是否停滞。`
        : `@coordinator [stall] 全员已静默等待 ${idleMins} 分钟${headHint}，请推进下一步任务或发送 [done] 结束本阶段。`,
      attempt,
      idleMs,
      headSeq: effectiveHeadSeq,
      citedSeqs: effectiveHeadSeq > 0 ? [effectiveHeadSeq] : [],
    }
  }

  private diagnoseUnansweredMention(input: {
    stagePosts: readonly SwarmBoardPost[]
    liveWorkers: readonly SwarmMemberSnapshot[]
    effectiveHeadSeq: number
    idleMs: number
    attempt: number
  }): Omit<SwarmStallAlert, 'generation'> | null {
    const { stagePosts, liveWorkers, effectiveHeadSeq, idleMs, attempt } = input
    const idleMins = formatIdleMinutes(idleMs)
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

    return null
  }
}
