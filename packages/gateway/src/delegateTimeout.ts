export type DelegateTimeoutConfig = {
  idleTimeoutMs: number
  hardTimeoutMs: number
  checkIntervalMs: number
}

export type DelegateTimeoutReason = {
  kind: 'idle' | 'hard'
  idleMs: number
  elapsedMs: number
  message: string
}

const DEFAULT_IDLE_TIMEOUT_MS = 300_000
const DEFAULT_HARD_TIMEOUT_MS = 15 * 60_000
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
): DelegateTimeoutConfig {
  const idleTimeoutMs = normalizeMs(
    env.OPENCLAUDE_DELEGATE_IDLE_TIMEOUT_MS,
    DEFAULT_IDLE_TIMEOUT_MS,
    60_000,
    30 * 60_000,
  )
  const hardTimeoutMs = Math.max(
    idleTimeoutMs,
    normalizeMs(
      env.OPENCLAUDE_DELEGATE_HARD_TIMEOUT_MS,
      DEFAULT_HARD_TIMEOUT_MS,
      5 * 60_000,
      2 * 60 * 60_000,
    ),
  )
  const checkIntervalMs = normalizeMs(
    env.OPENCLAUDE_DELEGATE_CHECK_INTERVAL_MS,
    DEFAULT_CHECK_INTERVAL_MS,
    1_000,
    30_000,
  )
  return { idleTimeoutMs, hardTimeoutMs, checkIntervalMs }
}

export function getDelegateTimeoutReason(
  now: number,
  startedAt: number,
  lastActivityAt: number,
  config: DelegateTimeoutConfig,
): DelegateTimeoutReason | null {
  const elapsedMs = Math.max(0, now - startedAt)
  const idleMs = Math.max(0, now - lastActivityAt)
  if (elapsedMs > config.hardTimeoutMs) {
    return {
      kind: 'hard',
      idleMs,
      elapsedMs,
      message: `子 agent 委派超过 ${Math.round(config.hardTimeoutMs / 1000)} 秒上限,已中断。`,
    }
  }
  if (idleMs > config.idleTimeoutMs) {
    return {
      kind: 'idle',
      idleMs,
      elapsedMs,
      message: `子 agent ${Math.round(idleMs / 1000)} 秒无输出,已中断。`,
    }
  }
  return null
}
