/**
 * create_reminder 的 origin-session 解析。
 * 模型只许传 resume=origin-session|isolated；会话键从 OPENCLAUDE_SESSION_KEY 盖章。
 */

export const CLIENT_FORBIDDEN_RESUME_KEYS = [
  'originSessionKey',
  'sourceSessionId',
  'sourceUserId',
  'sessionId',
  'sessionKey',
] as const

export type ReminderResumeResolution =
  | { ok: true; resume?: 'origin-session'; originSessionKey?: string }
  | { ok: false; error: string }

export function rejectClientAssignedResumeIds(args: object): string | null {
  const raw = args as Record<string, unknown>
  const hit = CLIENT_FORBIDDEN_RESUME_KEYS.filter((key) => key in raw)
  if (hit.length === 0) return null
  return `会话由网关从当前对话盖章,不接受客户端指定 ${hit.join(' / ')}`
}

export function resolveReminderResume(
  args: { resume?: unknown },
  env: NodeJS.ProcessEnv = process.env,
): ReminderResumeResolution {
  if (args.resume === undefined || args.resume === null || args.resume === 'isolated') {
    return { ok: true }
  }
  if (args.resume !== 'origin-session') {
    return { ok: false, error: 'resume 只接受 origin-session 或 isolated' }
  }
  const originSessionKey = (env.OPENCLAUDE_SESSION_KEY ?? '').trim()
  if (!originSessionKey) {
    return {
      ok: false,
      error: '当前不在对话会话中,无法续跑本对话。请省略 resume,改用隔离定时任务。',
    }
  }
  return { ok: true, resume: 'origin-session', originSessionKey }
}
