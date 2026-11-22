/**
 * OCV5-22 R0/R1: build the engine-agnostic JobTerminal snapshot and the
 * stable Markdown/JSON body written on InlinePush / ResumeInject.
 */
import { join } from 'node:path'
import {
  classifyNotifyLane,
  delegateNotifyId,
  isDelegateParentEngine,
  isDelegateTerminalState,
  type DelegateParentEngine,
  type JobTerminal,
  type NotifyLane,
} from '@openclaude/protocol'
import { paths } from '@openclaude/storage'
import type { DelegateJobSnapshot } from './delegateJobs.js'
import { parseCronContinuation } from './cronOriginSession.js'
import { offloadPayloadIfOversized } from './payloadOffloadGate.js'

export const RESULT_REF_MAX = 4_000

export function parseParentEngine(raw: unknown): DelegateParentEngine | undefined {
  return isDelegateParentEngine(raw) ? raw : undefined
}

export function isHeartbeatSilentOutput(text: unknown): boolean {
  return typeof text === 'string' && text.trim() === 'HEARTBEAT_OK'
}

export function resultRefFromSnapshot(
  job: DelegateJobSnapshot,
  opts?: { sessionKey?: string },
): string | undefined {
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
  if (raw.length <= RESULT_REF_MAX) return raw
  const ownerSessionKey =
    opts?.sessionKey || job.callbackOriginSessionKey || job.parentSessionKey || job.sessionKey
  const gated = offloadPayloadIfOversized({
    workspaceDir: join(paths.home, 'workspace', 'delegate-artifacts'),
    sessionKey: ownerSessionKey,
    sessionId: job.id,
    category: 'delegate-callback',
    label: job.agentId || job.id,
    content: raw,
    inlineMaxChars: RESULT_REF_MAX,
  })
  return gated.text
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
  // Cron origin-session inject targets the webchat tape, not the parent
  // engine stdin. A CCB/Codex cron child and the origin session are
  // different process lifetimes — InlinePush would write the dead child.
  if (callback === 'cron-origin-inject') return 'resume-inject'
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
    resultRef: resultRefFromSnapshot(job, { sessionKey: parentSessionKey }),
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

function extractArtifactPath(text: string | undefined): string | undefined {
  if (!text) return undefined
  const m = /Full content offloaded to: `([^`]+)`/.exec(text)
  return m?.[1]
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
  // OCV5-840: never duplicate resultRef inside the metadata JSON block.
  // Keep metadata + artifactPath in <delegate-terminal>, and render the bounded
  // summary body once below.
  let bodyText = event.resultRef?.trim() ?? ''
  let artifactPath = extractArtifactPath(bodyText)
  if (bodyText.length > RESULT_REF_MAX) {
    const gated = offloadPayloadIfOversized({
      workspaceDir: join(paths.home, 'workspace', 'delegate-artifacts'),
      sessionKey: event.parentSessionKey || event.sessionKey,
      sessionId: event.jobId,
      category: 'delegate-callback',
      label: event.agentId || event.jobId,
      content: bodyText,
      inlineMaxChars: RESULT_REF_MAX,
    })
    bodyText = gated.text
    artifactPath = gated.artifactPath ?? artifactPath
  }
  const payload = {
    jobId: event.jobId,
    state: event.state,
    notifyId,
    failureClass: event.failureClass,
    sessionKey: event.sessionKey,
    parentEngine: event.parentEngine,
    ...(artifactPath ? { artifactPath } : {}),
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
  if (bodyText) {
    lines.push('', failed ? '错误：' : '结论：', bodyText)
  }
  lines.push('', '请综合这条结论继续回复用户。这是系统刚注入的完成回调，不要假装你早就看过。')
  return lines.join('\n')
}
