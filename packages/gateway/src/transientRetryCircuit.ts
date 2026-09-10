import type { AutomaticRetryState } from './engine/engineAdapter.js'

/** Consecutive same-class transient failures before the in-process retry circuit opens. */
export const TRANSIENT_SAME_CLASS_BREAKER = 3

/** Marker classifyRunError maps to model_capacity (retry_or_switch). */
export const TRANSIENT_CIRCUIT_OPEN_MARKER = 'TRANSIENT_CIRCUIT_OPEN'

export function resolveTransientBreakerThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = parseInt(String(env.OPENCLAUDE_TRANSIENT_BREAKER ?? ''), 10)
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : TRANSIENT_SAME_CLASS_BREAKER
}

/** In-process consecutive same-class counter. Mutates `state`; not persisted. */
export function advanceTransientBreaker(
  state: AutomaticRetryState,
  errorClass: string,
  threshold: number,
): { open: boolean; consecutive: number } {
  if (state.lastErrorClass === errorClass) {
    state.consecutiveSameClass = (state.consecutiveSameClass ?? 0) + 1
  } else {
    state.consecutiveSameClass = 1
    state.lastErrorClass = errorClass
  }
  const consecutive = state.consecutiveSameClass
  return { open: consecutive >= threshold, consecutive }
}

export function formatTransientCircuitOpenError(errorClass: string, consecutive: number): string {
  return `${TRANSIENT_CIRCUIT_OPEN_MARKER}: 连续 ${consecutive} 次同类上游失败（${errorClass}），已停止自动重试。请切换引擎后再试。`
}
