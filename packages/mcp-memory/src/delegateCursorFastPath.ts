/**
 * Shared delegate fast path (originally introduced for Cursor): start the
 * gateway job asynchronously and keep polling inside the same tools/call.
 * Near the engine deadline the gateway takes callback ownership of this job.
 *
 * Pure enough to unit-test with fake HTTP; index.ts only supplies POST/wait.
 * A transport or tool deadline is never the lifetime of a healthy child job.
 */
import type { FanoutItemResult } from './delegateFanout.js'

export const DEFAULT_CURSOR_FAST_WAIT_MS = 45_000

/** Transport blip on one long-poll: keep waiting / hand back the job instead of failing.
 *  (Lives here — not in delegateWaitCli — so the CLI and the MCP fast path share one
 *  predicate without a circular import.) */
export function isTransientDelegateWaitError(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string }; message?: unknown }
  const code = e?.code || e?.cause?.code
  const msg = String(e?.message ?? err)
  return (
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'EPIPE' ||
    /delegate client timeout/i.test(msg) ||
    /socket hang up/i.test(msg)
  )
}
export const MIN_CURSOR_FAST_WAIT_MS = 5_000
export const MAX_CURSOR_FAST_WAIT_MS = 55_000

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

/** Fast-path wait. Default 45s; env `OPENCLAUDE_DELEGATE_CURSOR_FAST_WAIT_MS` clamped to 5s..55s. */
export function resolveCursorFastWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  return normalizeMs(
    env.OPENCLAUDE_DELEGATE_CURSOR_FAST_WAIT_MS,
    DEFAULT_CURSOR_FAST_WAIT_MS,
    MIN_CURSOR_FAST_WAIT_MS,
    MAX_CURSOR_FAST_WAIT_MS,
  )
}

/** Gateway projects the effective engine deadline, already minus transport margin. */
export function resolveDelegateMcpBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  return normalizeMs(env.OPENCLAUDE_DELEGATE_MCP_BUDGET_MS, 45_000, 1, 12 * 60 * 60_000)
}

export function formatDelegateSuccess(label: string, output: string, sessionKey?: string): string {
  const body = `✅ 委派完成 (agent: ${label})\n\n${output || '(无输出)'}`
  if (!sessionKey) return body
  return `${body}\n\nsessionKey=${sessionKey}\n下次同一成员续跑请传 resumeSessionKey。`
}

export function formatDelegateRunning(
  jobId: string,
  label: string,
  goal?: string,
  sessionKey?: string,
): string {
  const goalBit = goal ? `, goal: ${goal}` : ''
  const keyBit = sessionKey ? ` sessionKey=${sessionKey}` : ''
  return [
    `子任务仍在运行 (agent: ${label}${goalBit})。status=running jobId=${jobId}${keyBit}`,
    '前台工具等待窗口已结束，尚未确认自动回调。子任务会继续运行；不要重复委派或启动额外等待工具。',
  ].join('\n')
}

export function formatDelegateDeferred(jobId: string, label: string): string {
  return `status=deferred jobId=${jobId} (agent: ${label})。网关已接管等待，完成或失败后会自动把结果送回本会话。请结束当前回合，不要重新委派或启动等待工具。`
}

export type FanoutCursorItem = FanoutItemResult & {
  running?: boolean
  deferred?: boolean
  jobId?: string
}

export function formatDelegateFanoutRunning(items: FanoutCursorItem[]): string {
  const running = items.filter((it) => it.running && it.jobId)
  const done = items.filter((it) => !it.running)
  const header = `并行委派 ${items.length} 个子任务: ${done.length} 已完成 / ${running.length} 仍在运行。`
  const doneSections = done.map((it, i) => {
    const mark = it.isError ? '❌' : '✅'
    const goalPreview = it.goal.length > 60 ? `${it.goal.slice(0, 60)}…` : it.goal
    return [`### ${i + 1}. ${mark} ${it.label} — ${goalPreview}`, it.text].join('\n')
  })
  const runningLines = running.map((it) => {
    const goalPreview = it.goal.length > 60 ? `${it.goal.slice(0, 60)}…` : it.goal
    return `- ${it.jobId} (agent: ${it.label}, goal: ${goalPreview})`
  })
  const deferred = running.every((it) => it.deferred)
  const runningSection = [
    '### 仍在运行',
    deferred
      ? '网关已接管等待，终态会自动送回本会话。请结束当前回合，不要重新委派或启动等待工具。'
      : '前台等待窗口已结束，部分作业尚未确认自动回调。不要重复委派或启动额外等待工具。',
    ...runningLines,
  ].join('\n')
  const parts = [header, '']
  if (doneSections.length > 0) {
    parts.push('### 已完成', doneSections.join('\n\n'), '')
  }
  parts.push(runningSection)
  return parts.join('\n')
}

export type DelegateWaitView =
  | { kind: 'running'; jobId: string; sessionKey?: string }
  | { kind: 'deferred'; jobId: string }
  | { kind: 'expired'; jobId?: string; error: string }
  | { kind: 'result'; httpStatus: number; body: Record<string, unknown> }
  | { kind: 'error'; error: string }

export function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw) as unknown
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
    return null
  } catch {
    return null
  }
}

function startHandleFromBody(data: Record<string, unknown>): {
  jobId: string
  sessionKey?: string
  parentSessionKey?: string
  parentTurnKey?: string
} | null {
  const jobId = typeof data.jobId === 'string' ? data.jobId.trim() : ''
  const live = data.status === 'running' || data.status === 'queued'
  if (!jobId || !live) return null
  const sessionKey =
    typeof data.sessionKey === 'string' && data.sessionKey.trim()
      ? data.sessionKey.trim()
      : undefined
  const parentSessionKey =
    typeof data.parentSessionKey === 'string' && data.parentSessionKey.trim()
      ? data.parentSessionKey.trim()
      : undefined
  const parentTurnKey =
    typeof data.parentTurnKey === 'string' && data.parentTurnKey.trim()
      ? data.parentTurnKey.trim()
      : undefined
  return {
    jobId,
    ...(sessionKey ? { sessionKey } : {}),
    ...(parentSessionKey ? { parentSessionKey } : {}),
    ...(parentTurnKey ? { parentTurnKey } : {}),
  }
}

export function interpretDelegateStartBody(
  statusCode: number,
  raw: string,
): { jobId: string; sessionKey?: string; parentSessionKey?: string; parentTurnKey?: string } | { error: string } {
  const data = parseJsonObject(raw)
  if (data) {
    const handle = startHandleFromBody(data)
    if (handle) return handle
  }
  if (statusCode < 200 || statusCode >= 300) {
    const err =
      typeof data?.error === 'string' && data.error.trim() ? data.error.trim() : raw
    return { error: `委派失败: ${err}` }
  }
  if (!data) return { error: `委派失败: 无效 JSON: ${raw.slice(0, 200)}` }
  return { error: `委派失败: 异步作业未返回 jobId: ${raw.slice(0, 200)}` }
}

function waitRunningView(data: Record<string, unknown>): DelegateWaitView | null {
  if (data.status !== 'running' && data.status !== 'queued') return null
  const jobId = typeof data.jobId === 'string' ? data.jobId.trim() : ''
  if (!jobId) return { kind: 'error', error: '等待委派结果失败: running 响应缺少 jobId' }
  const sessionKey =
    typeof data.sessionKey === 'string' && data.sessionKey.trim()
      ? data.sessionKey.trim()
      : undefined
  return sessionKey ? { kind: 'running', jobId, sessionKey } : { kind: 'running', jobId }
}

export function interpretDelegateWaitBody(
  statusCode: number,
  raw: string,
): DelegateWaitView {
  const data = parseJsonObject(raw)
  if (statusCode === 404 || data?.status === 'expired') {
    const jobId = typeof data?.jobId === 'string' ? data.jobId : undefined
    const error =
      typeof data?.error === 'string'
        ? data.error
        : 'delegate job not found or expired'
    return { kind: 'expired', jobId, error }
  }
  if (!data) return { kind: 'error', error: `等待委派结果失败: 无效 JSON: ${raw.slice(0, 200)}` }
  if (statusCode >= 200 && statusCode < 300 && data.status === 'deferred' && typeof data.jobId === 'string' && data.jobId.trim()) {
    return { kind: 'deferred', jobId: data.jobId.trim() }
  }
  const live = waitRunningView(data)
  if (live) return live
  if (data.status === 'done' || data.status === 'failed') {
    const httpStatus =
      typeof data.httpStatus === 'number' && Number.isFinite(data.httpStatus)
        ? data.httpStatus
        : statusCode >= 400
          ? statusCode
          : 200
    return { kind: 'result', httpStatus, body: data }
  }
  if (statusCode < 200 || statusCode >= 300) {
    const err =
      typeof data.error === 'string' && data.error.trim() ? data.error.trim() : raw
    return {
      kind: 'error',
      error: `等待委派结果失败: ${err}`,
    }
  }
  return { kind: 'error', error: `等待委派结果失败: 未知响应 ${raw.slice(0, 200)}` }
}

export function looksLikeDelegateApiError(raw: unknown): boolean {
  const s = String(raw ?? '').trim()
  if (!s) return false
  return /^API Error:\s*(?:\d{3}\b|\{)/i.test(s)
}

export type FormattedDelegateResult =
  | { kind: 'ok'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'running'; text: string; jobId: string }
  | { kind: 'deferred'; text: string; jobId: string }

/** Apply the historical sync `/delegate` result mapping (success text / toolError). */
export function formatDelegateHttpResult(
  httpStatus: number,
  data: Record<string, unknown>,
  label: string,
): FormattedDelegateResult {
  if (httpStatus < 200 || httpStatus >= 300) {
    const err =
      typeof data.error === 'string' ? data.error : JSON.stringify(data)
    return { kind: 'error', text: `委派失败: ${err}` }
  }
  if (data.error || data.ok === false) {
    const err = String(data.error || data.output || 'unknown error')
    return { kind: 'error', text: `子 agent 执行出错: ${err}` }
  }
  const output = typeof data.output === 'string' ? data.output : ''
  if (looksLikeDelegateApiError(output)) {
    return { kind: 'error', text: `子 agent 执行出错: ${output}` }
  }
  const sessionKey =
    typeof data.sessionKey === 'string' && data.sessionKey.trim()
      ? data.sessionKey.trim()
      : undefined
  return { kind: 'ok', text: formatDelegateSuccess(label, output, sessionKey) }
}

export type CursorDelegateTransport = {
  start: () => Promise<{ statusCode: number; body: string }>
  wait: (jobId: string, waitMs: number, handoffOnRunning?: boolean) => Promise<{ statusCode: number; body: string }>
}

/**
 * `fastWaitMs` bounds each HTTP poll, not the tool invocation. Fan-out callers
 * share deadlineAtMs so starting another member never resets the tools/call budget.
 */
export async function runCursorDelegateFastPath(
  opts: {
    transport: CursorDelegateTransport
    fastWaitMs: number
    deadlineAtMs?: number
    now?: () => number
    sleep?: (ms: number) => Promise<void>
    label: string
    goal?: string
  },
): Promise<FormattedDelegateResult> {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const deadline = opts.deadlineAtMs ?? now() + resolveDelegateMcpBudgetMs()
  const started = await opts.transport.start()
  const start = interpretDelegateStartBody(started.statusCode, started.body)
  if ('error' in start) return { kind: 'error', text: start.error }
  let polled = false
  while (now() < deadline || !polled) {
    polled = true
    const roundStarted = now()
    const remaining = deadline - roundStarted
    const waitMs = Math.max(250, Math.min(opts.fastWaitMs, remaining - 3_000))
    const handoff = remaining <= opts.fastWaitMs + 3_000
    try {
      const waited = await opts.transport.wait(start.jobId, waitMs, handoff)
      const view = interpretDelegateWaitBody(waited.statusCode, waited.body)
      if (view.kind === 'deferred') {
        return { kind: 'deferred', jobId: view.jobId, text: formatDelegateDeferred(view.jobId, opts.label) }
      }
      if (view.kind === 'expired') return { kind: 'error', text: `委派失败: ${view.error}` }
      if (view.kind === 'error' && waited.statusCode < 500) return { kind: 'error', text: view.error }
      if (view.kind === 'result') return formatDelegateHttpResult(view.httpStatus, view.body, opts.label)
      // A running/queued round is healthy. Keep the model out of the wait loop.
    } catch (err) {
      if (!isTransientDelegateWaitError(err)) throw err
    }
    // Broken transports/mocks can answer immediately. Do not spin a CPU core.
    if (now() - roundStarted < 200) await sleep(Math.min(1_000, Math.max(0, deadline - now())))
  }
  return {
    kind: 'running',
    jobId: start.jobId,
    text: formatDelegateRunning(start.jobId, opts.label, opts.goal, start.sessionKey),
  }
}
