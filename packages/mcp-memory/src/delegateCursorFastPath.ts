/**
 * Cursor-engine delegate fast path: start the gateway job asynchronously, wait
 * up to ~45s (under the CLI's 60s MCP tools/call hard timeout), and if the
 * child is still running return a jobId plus Bash instructions for
 * `oc-memory delegate-wait`.
 *
 * Pure enough to unit-test with fake HTTP; index.ts only supplies POST/wait.
 * Non-cursor engines never import this path (gated in index.ts on
 * OPENCLAUDE_ENGINE === 'cursor').
 */
import type { FanoutItemResult } from './delegateFanout.js'

export const DEFAULT_CURSOR_FAST_WAIT_MS = 45_000
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

export function formatDelegateSuccess(label: string, output: string): string {
  return `✅ 委派完成 (agent: ${label})\n\n${output || '(无输出)'}`
}

export function formatDelegateRunning(jobId: string, label: string, goal?: string): string {
  const goalBit = goal ? `, goal: ${goal}` : ''
  return [
    `子任务仍在运行 (agent: ${label}${goalBit})。status=running jobId=${jobId}`,
    'Cursor MCP 通道有 60 秒硬超时,不能在本工具里继续等。请立刻用 Bash 阻塞等待结果,不要重复调用 delegate_task,也不要轮询 MCP:',
    `  oc-memory delegate-wait ${jobId}`,
    '该命令会阻塞直到子任务完成或超过平台硬上限,然后把结果打印到 stdout。',
  ].join('\n')
}

export type FanoutCursorItem = FanoutItemResult & {
  running?: boolean
  jobId?: string
}

export function formatDelegateFanoutRunning(items: FanoutCursorItem[]): string {
  const running = items.filter((it) => it.running && it.jobId)
  const done = items.filter((it) => !it.running)
  const jobIds = running.map((it) => it.jobId).filter((id): id is string => Boolean(id))
  const header = `并行委派 ${items.length} 个子任务: ${done.length} 已完成 / ${running.length} 仍在运行(Cursor MCP 60 秒硬超时,不能在本工具里继续等)。`
  const doneSections = done.map((it, i) => {
    const mark = it.isError ? '❌' : '✅'
    const goalPreview = it.goal.length > 60 ? `${it.goal.slice(0, 60)}…` : it.goal
    return [`### ${i + 1}. ${mark} ${it.label} — ${goalPreview}`, it.text].join('\n')
  })
  const runningLines = running.map((it) => {
    const goalPreview = it.goal.length > 60 ? `${it.goal.slice(0, 60)}…` : it.goal
    return `- ${it.jobId} (agent: ${it.label}, goal: ${goalPreview})`
  })
  const waitCmd = `  oc-memory delegate-wait ${jobIds.join(' ')}`
  const runningSection = [
    '### 仍在运行',
    '请立刻用 Bash 一条命令阻塞等待全部未完成子任务,不要重复调用 delegate_tasks,也不要轮询 MCP:',
    waitCmd,
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
  | { kind: 'running'; jobId: string }
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

export function interpretDelegateStartBody(
  statusCode: number,
  raw: string,
): { jobId: string } | { error: string } {
  if (statusCode < 200 || statusCode >= 300) {
    return { error: `委派失败: ${raw}` }
  }
  const data = parseJsonObject(raw)
  if (!data) return { error: `委派失败: 无效 JSON: ${raw.slice(0, 200)}` }
  const jobId = typeof data.jobId === 'string' ? data.jobId.trim() : ''
  if (data.status === 'running' && jobId) return { jobId }
  return { error: `委派失败: 异步作业未返回 jobId: ${raw.slice(0, 200)}` }
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
  if (statusCode < 200 || statusCode >= 300) {
    return {
      kind: 'error',
      error: `等待委派结果失败: ${raw}`,
    }
  }
  if (data.status === 'running') {
    const jobId = typeof data.jobId === 'string' ? data.jobId.trim() : ''
    if (!jobId) return { kind: 'error', error: '等待委派结果失败: running 响应缺少 jobId' }
    return { kind: 'running', jobId }
  }
  if (data.status === 'done') {
    const httpStatus =
      typeof data.httpStatus === 'number' && Number.isFinite(data.httpStatus)
        ? data.httpStatus
        : 200
    return { kind: 'result', httpStatus, body: data }
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
  return { kind: 'ok', text: formatDelegateSuccess(label, output) }
}

export type CursorDelegateTransport = {
  start: () => Promise<{ statusCode: number; body: string }>
  wait: (jobId: string, waitMs: number) => Promise<{ statusCode: number; body: string }>
}

/**
 * Start an async delegate job and wait up to `fastWaitMs`. Completes with the
 * same success/error text as today's sync path; otherwise returns a running
 * handle instructing the model to use `oc-memory delegate-wait`.
 */
export async function runCursorDelegateFastPath(
  opts: {
    transport: CursorDelegateTransport
    fastWaitMs: number
    label: string
    goal?: string
  },
): Promise<FormattedDelegateResult> {
  const started = await opts.transport.start()
  const start = interpretDelegateStartBody(started.statusCode, started.body)
  if ('error' in start) return { kind: 'error', text: start.error }
  const waited = await opts.transport.wait(start.jobId, opts.fastWaitMs)
  const view = interpretDelegateWaitBody(waited.statusCode, waited.body)
  if (view.kind === 'running') {
    return {
      kind: 'running',
      jobId: view.jobId,
      text: formatDelegateRunning(view.jobId, opts.label, opts.goal),
    }
  }
  if (view.kind === 'expired') {
    return { kind: 'error', text: `委派失败: ${view.error}` }
  }
  if (view.kind === 'error') return { kind: 'error', text: view.error }
  return formatDelegateHttpResult(view.httpStatus, view.body, opts.label)
}
