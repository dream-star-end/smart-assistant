// Origin-session cron resume: inject a new inbound turn into the conversation
// that created the job. Isolated cron execution (runJob getOrCreate/submit on
// agent:…:cron:dm:…) stays the default. This module is the stamp + text
// contract; Gateway performs persist + dispatchInbound.

import { createHash } from 'node:crypto'

import {
  delegateCallbackMessageId,
  parseSessionKey,
  type CronContinuationEnvelope,
  type JobTerminal,
} from '@openclaude/protocol'

export type CronResumeMode = 'isolated' | 'origin-session'

export type CronOriginFireResult =
  | { kind: 'fallback' }
  | { kind: 'injected' }
  | { kind: 'retryable_failure'; code: string }
  | { kind: 'terminal_failure'; code: string }

export type OriginWebchatSession = {
  sessionKey: string
  agentId: string
  channel: 'webchat'
  peerKind: 'dm'
  peerId: string
}

const CRON_ISOLATED_CHANNEL = 'cron'

export function isCronIsolatedSessionKey(sessionKey: string): boolean {
  const parts = sessionKey.split(':')
  return parts.length >= 5 && parts[0] === 'agent' && parts[2] === CRON_ISOLATED_CHANNEL
}

/**
 * Only a live webchat DM session key may be stamped as origin-session.
 * Rejects main/group/cron/malformed keys so a model cannot aim the job
 * at another conversation by passing a raw session id.
 */
export function parseOriginWebchatSessionKey(sessionKey: string): OriginWebchatSession | null {
  const trimmed = sessionKey.trim()
  if (!trimmed || isCronIsolatedSessionKey(trimmed)) return null
  let parsed
  try {
    parsed = parseSessionKey(trimmed)
  } catch {
    return null
  }
  if (parsed.scope !== 'dm' || parsed.channel !== 'webchat' || !parsed.peerId) return null
  if (!parsed.peerId.trim()) return null
  return {
    sessionKey: trimmed,
    agentId: parsed.agentId,
    channel: 'webchat',
    peerKind: 'dm',
    peerId: parsed.peerId,
  }
}

export function buildCronOriginResumeText(job: { label?: string; prompt: string }): string {
  const title = (job.label || '').trim()
  const heading = title ? `⏰ 定时续跑「${title}」` : '⏰ 定时续跑'
  return `${heading}\n\n${job.prompt}\n\n请带着本对话已有上下文继续执行上述任务。不要只播报，要真的做完。`
}

export function cronOriginIdempotencyKey(jobId: string, deliveryId: string): string {
  return `cron-origin:${jobId}:${deliveryId}`
}

/**
 * clientMessageId = 可读前缀 + 无碰撞摘要。纯剥离非法字符会产生歧义:
 * `cron.remind-a.123` 与 `cron.remind-a1.23` 剥点后同串,跨 job 互相幂等吞掉。
 * 摘要保证不同 deliveryId 必得不同 id;结果满足 ^[A-Za-z0-9_-]{1,128}$。
 */
export function cronOriginClientMessageId(deliveryId: string): string {
  const compact = deliveryId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60)
  const digest = createHash('sha256').update(deliveryId, 'utf8').digest('hex').slice(0, 12)
  return `cron-origin-${compact ? `${compact}-` : ''}${digest}`
}

/**
 * Flag-off Completer inject stamps this notify_lane so a later Notifier
 * generation can ACK the row instead of re-injecting with dlgcb.*.
 */
export const CRON_CALLBACK_LEGACY_LANE = 'legacy-completer'

export function isLegacyCronOriginLane(lane: string | undefined): boolean {
  return lane === CRON_CALLBACK_LEGACY_LANE
}

export function buildCronContinuationEnvelope(
  job: {
    id: string
    prompt: string
    label?: string
    sourceUserId?: string
    sourceSessionKey?: string
    projectMode?: 'follow_session' | 'fixed' | string
    boardProjectId?: string | null
  },
  project?: { mode?: string; boardProjectId?: string | null },
): CronContinuationEnvelope {
  const mode = project?.mode ?? job.projectMode ?? 'follow_session'
  const board =
    mode === 'fixed' ? (project?.boardProjectId ?? job.boardProjectId ?? null) : null
  return {
    resumeText: buildCronOriginResumeText(job),
    sourceUserId: job.sourceUserId,
    projectMode: mode,
    boardProjectId: board,
    cronJobId: job.id,
    sourceSessionKey: job.sourceSessionKey,
    label: job.label,
  }
}

export function parseCronContinuation(
  body: Record<string, unknown> | undefined,
): CronContinuationEnvelope | undefined {
  if (!body) return undefined
  const raw = body.cronContinuation
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const row = raw as Record<string, unknown>
    const resumeText =
      typeof row.resumeText === 'string' && row.resumeText
        ? row.resumeText
        : typeof body.output === 'string'
          ? body.output
          : ''
    if (!resumeText) return undefined
    return {
      resumeText,
      sourceUserId: typeof row.sourceUserId === 'string' ? row.sourceUserId : undefined,
      projectMode: typeof row.projectMode === 'string' ? row.projectMode : undefined,
      boardProjectId:
        typeof row.boardProjectId === 'string'
          ? row.boardProjectId
          : row.boardProjectId === null
            ? null
            : undefined,
      cronJobId: typeof row.cronJobId === 'string' ? row.cronJobId : undefined,
      sourceSessionKey: typeof row.sourceSessionKey === 'string' ? row.sourceSessionKey : undefined,
      label: typeof row.label === 'string' ? row.label : undefined,
    }
  }
  if (typeof body.output === 'string' && body.output) {
    return { resumeText: body.output }
  }
  return undefined
}

export type CronOriginInjectPayload = {
  job: {
    id: string
    schedule: string
    agent: string
    prompt: string
    resume: 'origin-session'
    sourceSessionKey: string
    sourceUserId?: string
    label?: string
    projectMode?: 'follow_session' | 'fixed'
    boardProjectId?: string | null
  }
  delivery: { dueMinuteKey: number; deliveryId: string }
  override: { text: string; clientMessageId: string; idempotencyKey: string }
}

/**
 * Rebuild the Completer origin-session inject arguments from a JobTerminal.
 * Text prefers the untruncated continuation envelope over 8K resultRef.
 * clientMessageId stays dlgcb.{jobId}.{epoch} so flag-off drain matches
 * the Notifier generation (review blocker 1 on→off).
 */
export function resolveCronOriginInjectPayload(
  event: JobTerminal,
  fallbackText?: string,
): CronOriginInjectPayload | null {
  const envelope = event.cronContinuation
  const originKey = envelope?.sourceSessionKey || event.parentSessionKey
  const origin = parseOriginWebchatSessionKey(originKey)
  if (!origin) return null
  const text = envelope?.resumeText?.trim()
    ? envelope.resumeText
    : fallbackText?.trim()
      ? fallbackText
      : ''
  if (!text) return null
  const projectMode =
    envelope?.projectMode === 'fixed' || envelope?.projectMode === 'follow_session'
      ? envelope.projectMode
      : undefined
  return {
    job: {
      id: envelope?.cronJobId || event.jobId,
      schedule: '* * * * *',
      agent: event.agentId || origin.agentId,
      prompt: text,
      resume: 'origin-session',
      sourceSessionKey: originKey,
      sourceUserId: envelope?.sourceUserId || event.callbackOriginUserId,
      label: envelope?.label || event.goal,
      projectMode,
      boardProjectId: projectMode === 'fixed' ? (envelope?.boardProjectId ?? null) : null,
    },
    delivery: { dueMinuteKey: 0, deliveryId: event.jobId },
    override: {
      text,
      clientMessageId: delegateCallbackMessageId(event.jobId, event.callbackEpoch),
      idempotencyKey: `cron-origin-notify:${event.jobId}:${event.callbackEpoch}`,
    },
  }
}
