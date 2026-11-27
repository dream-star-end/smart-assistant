/**
 * Pure types, constants, and helper predicates for SwarmStallMonitor (OCV5-848 / OCV5-923).
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
export const DEFAULT_SWARM_STALL_EXHAUSTED_GRACE_MS = DEFAULT_SWARM_STALL_RETRY_COOLDOWN_MS
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
  | 'stall_exhausted'
  | 'suppressed_cooldown'
  | 'alert_emitted'

export interface SwarmStallExhaustion {
  readonly swarmId: string
  readonly generation: number
  readonly idleMs: number
  readonly alertCount: number
  readonly headSeq: number
  readonly waitingMembers: readonly string[]
  readonly reason: 'max_alerts_exhausted'
}

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
  /** Monotonic stage/budget generation (OCV5-887 P2-09) preventing stale rollbacks across progress resets. */
  readonly generation: number
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
  /** Quiet grace period after the final `maxAlerts`-th alert before emitting `onStallExhausted` (default `retryCooldownMs`, 9 min). */
  exhaustedGraceMs?: number
  /** Max consecutive alerts for the same stall before going silent (default 3). */
  maxAlerts?: number
  /** Optional structured diagnostic observer (throttled on repetitive checks, immediate on transitions/alerts). */
  onDiagnostic?: (event: SwarmStallDiagnosticEvent) => void
  /** Invoked at most once per generation when all core members stay parked for `exhaustedGraceMs` after the final alert. */
  onStallExhausted?: (event: SwarmStallExhaustion) => void
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

export function isMonitorPost(post: SwarmBoardPost): boolean {
  return isSwarmMonitorAgentName(post.agent)
}

export function isCoordinatorDonePost(post: SwarmBoardPost): boolean {
  return post.agent.trim().toLowerCase() === 'coordinator' && DONE_PREFIX_RE.test(post.text)
}

export function mentionMatchesWorker(mention: string, workerName: string): boolean {
  const m = mention.toLowerCase()
  const w = workerName.toLowerCase()
  if (!m || m === 'all' || m.startsWith('#')) return false
  if (m === w) return true
  return w.startsWith(`${m}-`) && /^\d+$/.test(w.slice(m.length + 1))
}

export function postHasLiveCoreRecipient(
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

export function formatIdleMinutes(idleMs: number): number {
  return Math.max(1, Math.round(idleMs / 60_000))
}

/**
 * Neutralize `@mention` tokens in quoted error/member strings so a single-target
 * stall alert can NEVER accidentally wake `@all`, `@#channel`, or other workers.
 */
export function sanitizeQuotedText(text: string | undefined, maxChars: number, fallback: string): string {
  const clean = (text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/@/g, '＠')
    .replace(/`/g, "'")
    .trim()
  if (!clean) return fallback
  return clean.length <= maxChars ? clean : `${clean.slice(0, Math.max(1, maxChars - 1))}…`
}
