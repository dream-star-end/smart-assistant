export type DelegateTimeoutConfig = {
  idleTimeoutMs: number
  checkIntervalMs: number
}

export type DelegateTimeoutReason = {
  kind: 'idle'
  idleMs: number
  message: string
}

const DEFAULT_IDLE_TIMEOUT_MS = 300_000
const MAX_IDLE_TIMEOUT_MS = 45 * 60_000
const DEFAULT_CHECK_INTERVAL_MS = 5_000

function normalizeMs(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(max, Math.max(min, n))
}

export function resolveDelegateTimeoutConfig(
  env: NodeJS.ProcessEnv = process.env,
  idleTimeoutOverrideMs?: number,
): DelegateTimeoutConfig {
  const idleTimeoutMs = normalizeMs(
    idleTimeoutOverrideMs == null ? env.OPENCLAUDE_DELEGATE_IDLE_TIMEOUT_MS : String(idleTimeoutOverrideMs),
    DEFAULT_IDLE_TIMEOUT_MS,
    60_000,
    MAX_IDLE_TIMEOUT_MS,
  )
  const checkIntervalMs = normalizeMs(
    env.OPENCLAUDE_DELEGATE_CHECK_INTERVAL_MS,
    DEFAULT_CHECK_INTERVAL_MS,
    1_000,
    30_000,
  )
  return { idleTimeoutMs, checkIntervalMs }
}

export function getDelegateTimeoutReason(
  now: number,
  lastActivityAt: number,
  config: DelegateTimeoutConfig,
): DelegateTimeoutReason | null {
  const idleMs = Math.max(0, now - lastActivityAt)
  if (idleMs > config.idleTimeoutMs) {
    return {
      kind: 'idle',
      idleMs,
      message: `子 agent ${Math.round(idleMs / 1000)} 秒无输出,已中断。`,
    }
  }
  return null
}
