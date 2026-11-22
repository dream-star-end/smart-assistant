/**
 * Deterministic zero-token stall monitor for Antigravity Swarms (OCV5-848).
 *
 * Replaces the built-in LLM `@monitor` worker (which woke on a 3-minute cron
 * inside its own growing conversation history and burned tens of millions of
 * cache-read tokens on idle ticks).
 *
 * Bounded state only (never accumulates transcript/prompt history):
 *   1. Stage boundary (`lastDoneSeq`) — resets cleanly across `[done]` stages.
 *   2. Last genuine non-monitor progress key & timestamp (`lastProgressKey`, `lastProgressAt`).
 *   3. Alert backoff state (`alertCount`, `lastAlertAt`) — capped at `maxAlerts`.
 *   4. Per-member re-ping map (`repingedMentions`) — bounded by active roster size,
 *      escalating to `@coordinator` if a direct re-ping went unanswered.
 */
import type {
  SwarmBoardPost,
  SwarmMemberRole,
  SwarmMemberSnapshot,
  SwarmSnapshot,
} from '@openclaude/protocol'

export const GATEWAY_STALL_MONITOR_AGENT = 'gateway-monitor'
export const DEFAULT_SWARM_STALL_THRESHOLD_MS = 180_000
export const DEFAULT_SWARM_STALL_RETRY_COOLDOWN_MS = 540_000
export const DEFAULT_SWARM_STALL_MAX_ALERTS = 3

export type SwarmStallReason =
  | 'member_failed'
  | 'unanswered_mention'
  | 'unanswered_mention_escalated'
  | 'unclaimed_result'
  | 'channel_stalled'
  | 'idle_waiting'

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
  /** Quiet duration before emitting the first stall alert (default 3 min). */
  stallThresholdMs?: number
  /** Cooldown between repeated alerts for the same stall (default 9 min). */
  retryCooldownMs?: number
  /** Max consecutive alerts for the same stall before going silent (default 3). */
  maxAlerts?: number
}

const MONITOR_NAME_RE = /^monitor(?:-\d+)?$/i
const DONE_PREFIX_RE = /^\s*\[done\](?:\s|$|:|：|-)/i
const PARKED_WAIT_ACTIVITY = '等待讨论板消息'

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
  return member.status === 'working' && member.activity === PARKED_WAIT_ACTIVITY
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

function clampInlineError(text: string | undefined): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!clean) return '执行出错'
  return clean.length <= 120 ? clean : `${clean.slice(0, 119)}…`
}

export class SwarmStallMonitor {
  private readonly stallThresholdMs: number
  private readonly retryCooldownMs: number
  private readonly maxAlerts: number

  private lastDoneSeq = 0
  private lastProgressKey: string | null = null
  private lastProgressAt = 0
  private alertCount = 0
  private lastAlertAt = 0
  private readonly repingedMentions = new Map<string, number>()

  constructor(opts?: SwarmStallMonitorOptions) {
    this.stallThresholdMs = Math.max(1_000, opts?.stallThresholdMs ?? DEFAULT_SWARM_STALL_THRESHOLD_MS)
    this.retryCooldownMs = Math.max(1_000, opts?.retryCooldownMs ?? DEFAULT_SWARM_STALL_RETRY_COOLDOWN_MS)
    this.maxAlerts = Math.max(1, Math.floor(opts?.maxAlerts ?? DEFAULT_SWARM_STALL_MAX_ALERTS))
  }

  /** Clear all state on turn end, user stop, or swarm teardown. */
  reset(): void {
    this.lastDoneSeq = 0
    this.lastProgressKey = null
    this.lastProgressAt = 0
    this.clearAlertState()
  }

  private clearAlertState(): void {
    this.alertCount = 0
    this.lastAlertAt = 0
    this.repingedMentions.clear()
  }

  /**
   * Inspect a snapshot in O(members + recentPosts) memory time with zero I/O and
   * zero LLM calls. Returns an alert only when every live core member is parked
   * past `stallThresholdMs` and the current stage is not `[done]`.
   */
  evaluate(snap: SwarmSnapshot, now: number = Date.now()): SwarmStallAlert | null {
    if (snap.phase !== 'running' && snap.phase !== 'starting') {
      this.reset()
      return null
    }

    const liveCoreMembers = snap.members.filter(
      (m) => m.status !== 'killed' && !isSwarmAuxiliaryRole(m.role),
    )
    const liveWorkers = liveCoreMembers.filter((m) => m.role !== 'coordinator')
    if (liveWorkers.length === 0) {
      this.lastProgressKey = null
      this.lastProgressAt = now
      this.clearAlertState()
      return null
    }

    const nonMonitorPosts = snap.posts.filter((p) => !isMonitorPost(p))
    const effectiveHeadSeq =
      nonMonitorPosts.length > 0 ? nonMonitorPosts[nonMonitorPosts.length - 1]!.seq : 0

    for (const post of nonMonitorPosts) {
      if (isCoordinatorDonePost(post) && post.seq > this.lastDoneSeq) {
        this.lastDoneSeq = post.seq
      }
    }
    const stagePosts = nonMonitorPosts.filter((p) => p.seq > this.lastDoneSeq)

    // Intentionally exclude `unreadCount` from progressKey: posting a `[stall]`
    // alert increments other members' unreadCount, which must NOT look like
    // genuine swarm progress and reset the backoff counter.
    const sortedCore = [...liveCoreMembers].sort((a, b) => a.name.localeCompare(b.name))
    const progressKey = [
      effectiveHeadSeq,
      ...sortedCore.map(
        (m) =>
          `${m.name}:${isMemberEffectivelyWaiting(m) ? 'parked' : m.status}:${m.stepCount}:${m.failed ? 1 : 0}:${m.lastPostSeq ?? 0}`,
      ),
    ].join('|')

    const anyWorking = liveCoreMembers.some((m) => !isMemberEffectivelyWaiting(m))
    if (anyWorking) {
      this.lastProgressKey = progressKey
      this.lastProgressAt = now
      this.clearAlertState()
      return null
    }

    if (this.lastProgressKey === null || this.lastProgressKey !== progressKey) {
      this.lastProgressKey = progressKey
      this.lastProgressAt = now
      this.clearAlertState()
      return null
    }

    // Current stage already ended with `[done]` and no new non-monitor posts arrived.
    if (this.lastDoneSeq > 0 && stagePosts.length === 0 && effectiveHeadSeq <= this.lastDoneSeq) {
      return null
    }

    const idleMs = Math.max(0, now - this.lastProgressAt)
    if (idleMs < this.stallThresholdMs) return null
    if (this.alertCount >= this.maxAlerts) return null
    if (this.alertCount > 0 && now - this.lastAlertAt < this.retryCooldownMs) return null

    const attempt = this.alertCount + 1
    const alert = this.diagnoseStall({
      snap,
      liveCoreMembers,
      liveWorkers,
      stagePosts,
      effectiveHeadSeq,
      idleMs,
      attempt,
    })

    this.alertCount = attempt
    this.lastAlertAt = now
    return alert
  }

  private diagnoseStall(input: {
    snap: SwarmSnapshot
    liveCoreMembers: readonly SwarmMemberSnapshot[]
    liveWorkers: readonly SwarmMemberSnapshot[]
    stagePosts: readonly SwarmBoardPost[]
    effectiveHeadSeq: number
    idleMs: number
    attempt: number
  }): SwarmStallAlert {
    const { snap, liveCoreMembers, liveWorkers, stagePosts, effectiveHeadSeq, idleMs, attempt } = input
    const idleMins = formatIdleMinutes(idleMs)
    const coordinator = liveCoreMembers.find((m) => m.role === 'coordinator')

    // 1. Failed worker needs coordinator intervention (never @ the failed worker itself).
    const failedWorker = liveWorkers.find((w) => w.failed === true)
    if (failedWorker) {
      const errSummary = clampInlineError(failedWorker.lastError)
      const cited = failedWorker.lastPostSeq ? [failedWorker.lastPostSeq] : []
      return {
        target: 'coordinator',
        channel: 'main',
        reason: 'member_failed',
        message: `@coordinator [stall] 成员 \`${failedWorker.name}\` 执行异常（${errSummary}），全员已静默 ${idleMins} 分钟，请检查是否需要重试、切换模型或回收。`,
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
          return {
            target: 'coordinator',
            channel: 'main',
            reason: 'unanswered_mention_escalated',
            message: `@coordinator [stall] 成员 \`${worker.name}\` 对 #${post.seq}（此前已催促）仍无响应，全员已静默 ${idleMins} 分钟，可能受限或异常，请排查、切换模型或改派。`,
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
      const authors = [...new Set(recent.map((p) => `\`${p.agent}\``))].join('、')
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
        return {
          target: 'coordinator',
          channel: 'main',
          reason: 'channel_stalled',
          message: `@coordinator [stall] 频道 #${latestStagePost.channel} 自 #${latestStagePost.seq} 后已静默 ${idleMins} 分钟且未通知协调者，请核查是否需要推进或收口。`,
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
