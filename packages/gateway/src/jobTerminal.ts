/**
 * OCV5-22 R0/R1: build the engine-agnostic JobTerminal snapshot and the
 * stable Markdown/JSON body written on InlinePush / ResumeInject.
 */
import {
  classifyNotifyLane,
  delegateNotifyId,
  isDelegateParentEngine,
  isDelegateTerminalState,
  type DelegateParentEngine,
  type JobTerminal,
  type NotifyLane,
} from '@openclaude/protocol'
import type { DelegateJobSnapshot } from './delegateJobs.js'
import { parseCronContinuation } from './cronOriginSession.js'

const RESULT_REF_MAX = 8_000

export function parseParentEngine(raw: unknown): DelegateParentEngine | undefined {
  return isDelegateParentEngine(raw) ? raw : undefined
}

export function isHeartbeatSilentOutput(text: unknown): boolean {
  return typeof text === 'string' && text.trim() === 'HEARTBEAT_OK'
}

export function resultRefFromSnapshot(job: DelegateJobSnapshot): string | undefined {
  const body = job.result?.body ?? {}
  const output = typeof body.output === 'string' ? body.output : undefined
  const error = typeof body.error === 'string' ? body.error : undefined
  const failed =
    job.state !== 'completed' ||
    job.failureClass != null ||
    body.ok === false ||
    Boolean(error && !output)
  const raw = failed ? job.failureDetail || error || output : output || error
  if (!raw) return undefined
  return raw.slice(0, RESULT_REF_MAX)
}

export function resultOkFromSnapshot(job: DelegateJobSnapshot): boolean | undefined {
  const ok = job.result?.body?.ok
  if (ok === false) return false
  if (ok === true) return true
  return undefined
}

export function isJobTerminalFailure(event: JobTerminal): boolean {
  if (event.state !== 'completed') return true
  if (event.failureClass) return true
  if (event.resultOk === false) return true
  return false
}

export function injectPayloadFromJobTerminal(event: JobTerminal): { output?: string; error?: string } {
  if (isJobTerminalFailure(event)) {
    return { error: event.failureDetail || event.resultRef || 'delegate failed' }
  }
  return { output: event.resultRef }
}

export function laneForCallback(
  callback: DelegateJobSnapshot['callback'],
  engine: DelegateParentEngine | undefined,
): NotifyLane {
  if (callback === 'none') return 'skipped_silent'
  if (callback === 'stdout-wait') return 'stdout-wait'
  if (!engine) return 'resume-inject'
  return classifyNotifyLane(engine)
}

export function buildJobTerminalFromSnapshot(
  job: DelegateJobSnapshot,
  extras: {
    parentEngine?: DelegateParentEngine
    parentNativeId?: string
    goal?: string
    parallelPolicy?: 'each' | 'all'
    callbackOriginSessionKey?: string
  } = {},
): JobTerminal | undefined {
  if (!isDelegateTerminalState(job.state)) return undefined
  const parentEngine = extras.parentEngine ?? parseParentEngine(job.parentEngine)
  if (!parentEngine) return undefined
  const parentSessionKey =
    extras.callbackOriginSessionKey ??
    job.callbackOriginSessionKey ??
    job.parentSessionKey
  if (!parentSessionKey) return undefined
  const callbackEpoch = job.callbackEpoch > 0 ? job.callbackEpoch : 1
  const cronContinuation =
    job.callback === 'cron-origin-inject' ? parseCronContinuation(job.result?.body) : undefined
  return {
    jobId: job.id,
    state: job.state as JobTerminal['state'],
    failureClass: job.failureClass,
    failureDetail: job.failureDetail,
    sessionKey: job.sessionKey,
    resultRef: resultRefFromSnapshot(job),
    parentSessionKey,
    parentEngine,
    parentNativeId: extras.parentNativeId,
    callback: job.callback,
    callbackEpoch,
    parallelPolicy: extras.parallelPolicy ?? 'all',
    agentId: job.agentId,
    goal: extras.goal,
    resultOk: resultOkFromSnapshot(job),
    terminalCommittedAt: job.terminalCommittedAt,
    callbackOriginUserId: job.callbackOriginUserId,
    cronContinuation,
  }
}

export function formatJobTerminalMarkdown(event: JobTerminal): string {
  const notifyId = delegateNotifyId(event.jobId, event.callbackEpoch)
  const failed = isJobTerminalFailure(event)
  const heading =
    event.state === 'cancelled'
      ? '🔄 子任务已取消'
      : event.state === 'killed_by_cutover'
        ? '🔄 子任务被切流中止'
        : failed
          ? '🔄 子任务失败'
          : '🔄 子任务已完成'
  const payload = {
    jobId: event.jobId,
    state: event.state,
    notifyId,
    failureClass: event.failureClass,
    sessionKey: event.sessionKey,
    resultRef: event.resultRef,
    parentEngine: event.parentEngine,
  }
  const lines = [
    heading,
    '',
    `<delegate-terminal jobId=${event.jobId} notifyId=${notifyId}>`,
    JSON.stringify(payload),
    '</delegate-terminal>',
  ]
  if (event.goal?.trim()) {
    lines.push('', `任务：${event.goal.trim()}`)
  }
  if (event.resultRef?.trim()) {
    lines.push('', failed ? '错误：' : '结论：', event.resultRef.trim())
  }
  lines.push('', '请综合这条结论继续回复用户。这是系统刚注入的完成回调，不要假装你早就看过。')
  return lines.join('\n')
}
