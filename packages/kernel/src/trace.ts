/**
 * Trace context (phase 3 plan v3.6 §3.6 `trace`, §7.1): the ids that tie one user turn (or job, or
 * train) together. This file is the shape and the log projection only; carrying it through async
 * calls (AsyncLocalStorage) lives in `kernel/node`, and header/frame/env injection arrives with P2.
 */

export interface TraceContext {
  /** canonical trace id of the turn / job (master is the authority, §7.1) */
  traceId: string
  requestId?: string
  dispatchId?: string
  attempt?: number
  parentTraceId?: string
  connectionId?: string
  jobRunId?: string
  sessionKey?: string
  userId?: string | number
}

const KEYS = [
  'traceId',
  'requestId',
  'dispatchId',
  'attempt',
  'parentTraceId',
  'connectionId',
  'jobRunId',
  'sessionKey',
  'userId',
] as const satisfies readonly (keyof TraceContext)[]

/** The defined ids of a context as log fields (fixed key names, nothing else). */
export function traceFields(ctx: TraceContext | undefined): Record<string, unknown> | undefined {
  if (!ctx) return undefined
  const out: Record<string, unknown> = {}
  for (const k of KEYS) if (ctx[k] !== undefined && ctx[k] !== '') out[k] = ctx[k]
  return out
}
