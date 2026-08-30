/**
 * OCV5-22 委派 `failure_class` + 显式状态机契约（phase 0 schema owner）。
 *
 * 名字与 version 由本文件冻结；OCV5-17 只做遥测映射/脱敏，不得另起 class 字符串。
 * 存储落地（SQLite/PG）是阶段 1；阶段 0 先把枚举、合法转移和 DelegationService
 * 命令形状固化，gateway 内存实现按此表驱动。
 */

export const DELEGATE_FAILURE_CLASS_VERSION = 1 as const

export const DELEGATE_JOB_STATES = [
  'queued',
  'running',
  'paused_for_cutover',
  'completed',
  'failed',
  'cancelled',
  'killed_by_cutover',
] as const

export type DelegateJobState = (typeof DELEGATE_JOB_STATES)[number]

export const DELEGATE_TERMINAL_STATES: readonly DelegateJobState[] = [
  'completed',
  'failed',
  'cancelled',
  'killed_by_cutover',
]

export function isDelegateTerminalState(state: string): boolean {
  return (DELEGATE_TERMINAL_STATES as readonly string[]).includes(state)
}

export const DELEGATE_FAILURE_CLASSES = [
  'invalid_model',
  'unknown_agent',
  'self_delegate_forbidden',
  'depth_exceeded',
  'per_turn_limit',
  'capacity_timeout',
  'capacity_queue_full',
  'idle_timeout',
  'grok_route_denied',
  'grok_relay_path',
  'grok_route_expired',
  'cutover',
  'cancelled',
  'child_error',
  'transport',
  'unknown_job',
  'job_ttl_elapsed',
  'unsafe_replay',
  'internal',
  'invalid_wait_channel',
] as const

export type DelegateFailureClass = (typeof DELEGATE_FAILURE_CLASSES)[number]

export const DELEGATE_JOB_KINDS = [
  'delegate',
  'review',
  'send_to_agent',
  'cron',
  'taskboard',
  'ccb_local',
] as const

export type DelegateJobKind = (typeof DELEGATE_JOB_KINDS)[number]

export const DELEGATE_CALLBACKS = [
  'none',
  'origin-inject',
  'stdout-wait',
  'cron-origin-inject',
] as const

export type DelegateCallback = (typeof DELEGATE_CALLBACKS)[number]

export const DELEGATE_CALLBACK_STATES = [
  'none',
  'pending',
  'injecting',
  'delivered',
  'abandoned',
  'skipped_silent',
] as const

export type DelegateCallbackState = (typeof DELEGATE_CALLBACK_STATES)[number]

export const DELEGATE_CHECKPOINT_KINDS = ['none', 'runner_quiesced'] as const
export type DelegateCheckpointKind = (typeof DELEGATE_CHECKPOINT_KINDS)[number]

export const DELEGATE_CALLBACK_OWNERS = ['job', 'intent'] as const
export type DelegateCallbackOwner = (typeof DELEGATE_CALLBACK_OWNERS)[number]

/** Legal state transitions from design v2 §2.2. Lease adoption is NOT a transition. */
export const DELEGATE_LEGAL_TRANSITIONS: ReadonlyArray<readonly [DelegateJobState, DelegateJobState]> = [
  ['queued', 'running'],
  ['queued', 'failed'],
  ['queued', 'killed_by_cutover'],
  ['queued', 'paused_for_cutover'],
  ['queued', 'cancelled'],
  ['running', 'paused_for_cutover'],
  ['running', 'killed_by_cutover'],
  ['running', 'completed'],
  ['running', 'failed'],
  ['running', 'cancelled'],
  ['paused_for_cutover', 'running'],
  ['paused_for_cutover', 'killed_by_cutover'],
  ['paused_for_cutover', 'cancelled'],
]

const LEGAL_SET = new Set(DELEGATE_LEGAL_TRANSITIONS.map(([from, to]) => `${from}->${to}`))

export function isLegalDelegateTransition(from: DelegateJobState, to: DelegateJobState): boolean {
  if (from === to) return false
  return LEGAL_SET.has(`${from}->${to}`)
}

export type DelegateTransitionReject = {
  ok: false
  from: DelegateJobState
  to: DelegateJobState
  reason: 'illegal_transition' | 'already_terminal'
}

export function assertDelegateTransition(
  from: DelegateJobState,
  to: DelegateJobState,
): { ok: true } | DelegateTransitionReject {
  if (isDelegateTerminalState(from)) {
    return { ok: false, from, to, reason: 'already_terminal' }
  }
  if (!isLegalDelegateTransition(from, to)) {
    return { ok: false, from, to, reason: 'illegal_transition' }
  }
  return { ok: true }
}

export function cronDelegateIdempotencyKey(cronJobId: string, dueMinuteKey: number | string): string {
  return `cron:${cronJobId}:${dueMinuteKey}`
}

export function delegateCallbackMessageId(jobId: string, callbackEpoch: number): string {
  return `dlgcb.${jobId}.${callbackEpoch}`
}

export const DELEGATE_PARENT_ENGINES = ['ccb', 'codex', 'cursor', 'grok', 'zcode'] as const
export type DelegateParentEngine = (typeof DELEGATE_PARENT_ENGINES)[number]

export function isDelegateParentEngine(value: unknown): value is DelegateParentEngine {
  return typeof value === 'string' && (DELEGATE_PARENT_ENGINES as readonly string[]).includes(value)
}

export const NOTIFY_LANES = [
  'inline-push',
  'resume-inject',
  'mcp-wait',
  'stdout-wait',
  'skipped_silent',
] as const
export type NotifyLane = (typeof NOTIFY_LANES)[number]

/** CCB + Codex can write the parent stdin. Cursor/Grok/zcode spawn with stdin=ignore. */
export const INLINE_PUSH_ENGINES: readonly DelegateParentEngine[] = ['ccb', 'codex']
export const RESUME_INJECT_ENGINES: readonly DelegateParentEngine[] = ['cursor', 'grok', 'zcode']

export function classifyNotifyLane(engine: DelegateParentEngine): NotifyLane {
  return INLINE_PUSH_ENGINES.includes(engine) ? 'inline-push' : 'resume-inject'
}

/** Same inputs as dlgcb; Notifier must not mint a timestamp/uuid. */
export function delegateNotifyId(jobId: string, callbackEpoch: number): string {
  return `dlgnfy.${jobId}.${callbackEpoch}`
}

/**
 * Immutable cron ResumeInject envelope. Must not ride the 8K display
 * `resultRef` — that slice is for JobTerminal markdown, not task input.
 */
export type CronContinuationEnvelope = {
  resumeText: string
  sourceUserId?: string
  projectMode?: string
  boardProjectId?: string | null
  cronJobId?: string
  sourceSessionKey?: string
  label?: string
}

/**
 * Engine-agnostic terminal snapshot (design v3 §N1.1). Completer owns
 * callback_state; EngineNotifier only chooses the delivery lane.
 */
export type JobTerminal = {
  jobId: string
  state: Extract<DelegateJobState, 'completed' | 'failed' | 'cancelled' | 'killed_by_cutover'>
  failureClass?: DelegateFailureClass
  failureDetail?: string
  sessionKey?: string
  resultRef?: string
  parentSessionKey: string
  parentEngine: DelegateParentEngine
  parentNativeId?: string
  callback: DelegateCallback
  callbackEpoch: number
  parallelPolicy: 'each' | 'all'
  agentId?: string
  goal?: string
  /** Explicit child outcome. HTTP 200 + `{ok:false}` is a failure. */
  resultOk?: boolean
  /** t1: durable terminal commit time (ms). Latency is t1→t2. */
  terminalCommittedAt?: number
  /** Origin webchat user; cron ResumeInject must not fall back to OC_USER_ID. */
  callbackOriginUserId?: string
  /** Full cron continuation. Absent for non-cron callbacks. */
  cronContinuation?: CronContinuationEnvelope
}

export type NotifyResult =
  | { ok: true; lane: NotifyLane; notifyId: string }
  | { ok: false; failureClass: DelegateFailureClass; degradedTo?: 'resume-inject' }

export interface EngineNotifier {
  /** Idempotent: a second call with the same notifyId must no-op success. */
  notify(event: JobTerminal): Promise<NotifyResult>
}

/** Map OCV5-17 / local-execution reject codes onto this schema's class names. */
export function failureClassFromLocalExecutionCode(code: string | undefined): DelegateFailureClass {
  switch (code) {
    case 'DELEGATE_MODEL_UNKNOWN':
      return 'invalid_model'
    case 'DELEGATE_CODEX_UNSUPPORTED':
      return 'invalid_model'
    case 'MODEL_NOT_AVAILABLE':
      return 'invalid_model'
    case 'MODEL_CATALOG_UNAVAILABLE':
      return 'internal'
    default:
      return 'internal'
  }
}

export type DelegationEnqueueInput = {
  kind: DelegateJobKind
  callback: DelegateCallback
  targetAgentId: string
  goal: string
  parentSessionKey?: string
  sourceAgentId?: string
  sessionKey?: string
  idempotencyKey?: string
  model?: string
  generation?: number
}

export type DelegationWaitView = {
  jobId: string
  state: DelegateJobState
  sessionKey?: string
  failureClass?: DelegateFailureClass
  failureDetail?: string
  callbackState?: DelegateCallbackState
}

/**
 * Unique authority for Enqueue / Wait / Cancel / Resume.
 * Phase 0 is in-memory; stage 1 persists the same shape.
 */
export interface DelegationService {
  enqueue(input: DelegationEnqueueInput): { jobId: string } | { error: 'capacity_queue_full' }
  wait(jobId: string, waitMs: number): Promise<DelegationWaitView>
  cancel(jobId: string, claimToken: string, fencingEpoch: number): boolean
  get(jobId: string): DelegationWaitView | { state: 'unknown'; failureClass: 'unknown_job' }
}
