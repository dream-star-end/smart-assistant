// Origin-session cron resume: inject a new inbound turn into the conversation
// that created the job. Isolated cron execution (runJob getOrCreate/submit on
// agent:…:cron:dm:…) stays the default. This module is the stamp + text
// contract; Gateway performs persist + dispatchInbound.

import { parseSessionKey } from '@openclaude/protocol'

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

export function cronOriginClientMessageId(deliveryId: string): string {
  const compact = deliveryId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80)
  return `cron-origin-${compact || 'job'}`
}
