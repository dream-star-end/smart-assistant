/**
 * Cursor MCP `delegate_wait` — one long-poll round against a durable job.
 *
 * Pure Wait: no enqueue, no capacity slot, no Completer/Notifier side effects.
 * A round is capped at 55s so it returns before Cursor's ~60s tools/call wall.
 * Timeout is a healthy `status=running` (not isError / not job failure).
 */
import {
  formatDelegateHttpResult,
  interpretDelegateWaitBody,
  type DelegateWaitView,
} from './delegateCursorFastPath.js'

/** Must stay equal to protocol `DELEGATE_CURSOR_MCP_WAIT_MS` (design v3 §N3). */
export const DEFAULT_MCP_DELEGATE_WAIT_MS = 55_000
export const MIN_MCP_DELEGATE_WAIT_MS = 250
export const MAX_MCP_DELEGATE_WAIT_MS = 55_000
/** A few seconds above the wait budget for RTT; still < 60s. */
export const MCP_DELEGATE_WAIT_HTTP_TIMEOUT_MS = 58_000

export type McpDelegateWaitOnce = (
  jobId: string,
  waitMs: number,
) => Promise<{ statusCode: number; body: string }>

export type McpDelegateWaitResult = {
  isError: boolean
  status: 'done' | 'failed' | 'running' | 'not_found' | 'error'
  text: string
  jobId?: string
}

export function resolveMcpDelegateWaitMs(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MCP_DELEGATE_WAIT_MS
  return Math.min(MAX_MCP_DELEGATE_WAIT_MS, Math.max(MIN_MCP_DELEGATE_WAIT_MS, Math.floor(n)))
}

export function mcpDelegateWaitHttpTimeoutMs(waitMs: number): number {
  return Math.min(MCP_DELEGATE_WAIT_HTTP_TIMEOUT_MS, Math.max(5_000, waitMs + 3_000))
}

export function formatMcpDelegateWaitRunning(jobId: string): string {
  return [
    `status=running jobId=${jobId}`,
    '本轮 MCP 等待已到点，作业仍在运行（不是失败）。请立刻再调 delegate_wait，或结束回合改走:',
    `  oc-memory delegate-wait ${jobId}`,
  ].join('\n')
}

export function formatMcpDelegateWaitNotFound(jobId: string, error: string): string {
  const id = jobId.trim() || '(missing)'
  return `status=not_found jobId=${id} error=${error}`
}

export function formatMcpDelegateWaitView(view: DelegateWaitView, jobId: string): McpDelegateWaitResult {
  if (view.kind === 'running') {
    return {
      isError: false,
      status: 'running',
      jobId: view.jobId,
      text: formatMcpDelegateWaitRunning(view.jobId),
    }
  }
  if (view.kind === 'expired') {
    const id = view.jobId || jobId
    return {
      isError: true,
      status: 'not_found',
      jobId: id,
      text: formatMcpDelegateWaitNotFound(id, view.error),
    }
  }
  if (view.kind === 'error') {
    return { isError: true, status: 'error', jobId, text: view.error }
  }
  const formatted = formatDelegateHttpResult(view.httpStatus, view.body, jobId)
  if (formatted.kind === 'error') {
    return { isError: true, status: 'failed', jobId, text: formatted.text }
  }
  return { isError: false, status: 'done', jobId, text: formatted.text }
}

/**
 * Single-round wait. `waitOnce` is the only I/O; callers must not also start
 * or enqueue a job (wait does not occupy delegate capacity).
 */
export async function runMcpDelegateWait(opts: {
  jobId: string
  waitMs?: unknown
  waitOnce: McpDelegateWaitOnce
}): Promise<McpDelegateWaitResult> {
  const jobId = typeof opts.jobId === 'string' ? opts.jobId.trim() : ''
  if (!jobId) {
    return {
      isError: true,
      status: 'not_found',
      text: formatMcpDelegateWaitNotFound('', 'jobId required'),
    }
  }
  const waitMs = resolveMcpDelegateWaitMs(opts.waitMs)
  const res = await opts.waitOnce(jobId, waitMs)
  return formatMcpDelegateWaitView(interpretDelegateWaitBody(res.statusCode, res.body), jobId)
}
