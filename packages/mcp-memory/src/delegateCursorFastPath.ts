/**
 * Shared delegate fast path (originally introduced for Cursor): start the
 * gateway job asynchronously, wait up to ~45s, and if the child is still
 * running return a jobId plus Bash instructions for
 * `oc-memory delegate-wait`.
 *
 * Pure enough to unit-test with fake HTTP; index.ts only supplies POST/wait.
 * Every engine uses this path so Codex/CCB MCP call deadlines are never
 * mistaken for the lifetime of a healthy child job.
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

/**
 * 成员回传进队长工具结果的上限。数字与 gateway `teamMode.ts` 的审查证据对齐
 * (`REVIEW_EVIDENCE_ITEM_MAX_CHARS` / `REVIEW_EVIDENCE_TOTAL_MAX_CHARS`):
 * 单条正文最多 6000 字,多条按条数分摊后合计不超过 24000。
 * fan-out 最多 4 条,因此每条预算仍是 6000,四条正文合计正好顶到 24000。
 * 超出只截队长看到的工具文本(留开头和结尾,标出省略字数);
 * 成员会话、作业结果和产物文件里的原文不改、不删。
 */
export const DELEGATE_LEADER_RESULT_ITEM_MAX_CHARS = 6000
export const DELEGATE_LEADER_RESULT_TOTAL_MAX_CHARS = 24000
const DELEGATE_LEADER_RESULT_MIN_CHARS = 800

/**
 * 成员回传里的产物路径。成对引号、反引号、尖括号和书名号里的内容一直取到配对结束符,
 * 空格、中文和多个点都算文件名。裸路径在空白、行尾和句末标点处停下。点号后面是扩展名,或后面还有扩展名(report.最终版.md),点号留在文件名里。句末 ASCII 点不并进 Read 目标。
 */
const ARTIFACT_PREFIX = '/home/agent/.openclaude/generated/'

/** 开引号 → 闭引号。路径本身被包住时,中间任何合法文件名字符都保留。 */
const ARTIFACT_QUOTE_CLOSER: Readonly<Record<string, string>> = {
  '`': '`',
  '"': '"',
  "'": "'",
  '<': '>',
  '「': '」',
  '“': '”',
  '『': '』',
}

/** 裸路径在这些字符处结束。括号外的 ASCII 点另判:后面是扩展名,或后面还有扩展名,才继续。括号内的点属于文件名。 */
const BARE_PATH_STOP = /[\s`"'\]>,;:!?，。、；：！？…]/u

export function delegateLeaderResultBudget(itemCount: number): number {
  const n = Number.isFinite(itemCount) && itemCount >= 1 ? Math.floor(itemCount) : 1
  return Math.max(
    DELEGATE_LEADER_RESULT_MIN_CHARS,
    Math.min(
      DELEGATE_LEADER_RESULT_ITEM_MAX_CHARS,
      Math.floor(DELEGATE_LEADER_RESULT_TOTAL_MAX_CHARS / n),
    ),
  )
}

function quotedArtifactSpan(
  text: string,
  prefixAt: number,
): { path: string; next: number } | null {
  let i = prefixAt - 1
  while (i >= 0 && (text[i] === ' ' || text[i] === '\t')) i -= 1
  if (i < 0) return null
  const open = text[i] ?? ''
  const close = ARTIFACT_QUOTE_CLOSER[open]
  if (!close) return null
  // ``` 围栏或成对反引号不是「路径本身被引号包住」。
  if (open === '`' && i > 0 && text[i - 1] === '`') return null
  if (text.slice(i + 1, prefixAt).trim() !== '') return null
  const end = text.indexOf(close, prefixAt)
  if (end < 0) return null
  const newline = text.indexOf('\n', prefixAt)
  if (newline >= 0 && newline < end) return null
  const path = text.slice(prefixAt, end).trim()
  if (!path.startsWith(ARTIFACT_PREFIX) || path.length <= ARTIFACT_PREFIX.length) return null
  if (!text.startsWith(path, prefixAt)) return null
  return { path, next: end + close.length }
}

function laterFileExtension(text: string, from: number): boolean {
  let i = from
  let depth = 0
  while (i < text.length) {
    const ch = text[i] ?? ''
    if (ch === '(' || ch === '（') {
      depth += 1
      i += 1
      continue
    }
    if (ch === ')' || ch === '）') {
      if (depth === 0) return false
      depth -= 1
      i += 1
      continue
    }
    if (depth === 0 && BARE_PATH_STOP.test(ch)) return false
    if (depth === 0 && (ch === '.' || ch === '．') && /[A-Za-z0-9]/.test(text[i + 1] ?? '')) return true
    i += 1
  }
  return false
}

function bareArtifactSpan(text: string, prefixAt: number): { path: string; next: number } {
  let i = prefixAt + ARTIFACT_PREFIX.length
  let depth = 0
  let rewindTo = -1
  while (i < text.length) {
    const ch = text[i] ?? ''
    if (ch === '(' || ch === '（') {
      if (depth === 0) rewindTo = i
      depth += 1
      i += 1
      continue
    }
    if (ch === ')' || ch === '）') {
      if (depth === 0) break
      depth -= 1
      if (depth === 0) rewindTo = -1
      i += 1
      continue
    }
    if (ch === '.' || ch === '．') {
      // 已经进入平衡括号时,点号属于文件名(report(v1.最终版).md)。
      // 句末点只在括号外判断,避免 depth 回退把整段截成左括号之前。
      if (depth === 0) {
        const next = text[i + 1] ?? ''
        if (!/[A-Za-z0-9]/.test(next) && !laterFileExtension(text, i + 1)) break
      }
      i += 1
      continue
    }
    if (BARE_PATH_STOP.test(ch)) break
    i += 1
  }
  // 左括号没配上时,括号后面的句子不属于文件名。
  if (depth > 0 && rewindTo >= 0) i = rewindTo
  let end = i
  while (end > prefixAt && /[.．…,;:!?，。、；：！？]/u.test(text[end - 1] ?? '')) end -= 1
  const path = text.slice(prefixAt, end)
  return { path, next: Math.max(i, prefixAt + ARTIFACT_PREFIX.length) }
}

function extractGeneratedArtifactPaths(text: string): string[] {
  if (!text) return []
  const found = new Set<string>()
  let i = 0
  while (i < text.length) {
    const at = text.indexOf(ARTIFACT_PREFIX, i)
    if (at < 0) break
    const quoted = quotedArtifactSpan(text, at)
    if (quoted) {
      if (quoted.path.length > ARTIFACT_PREFIX.length) found.add(quoted.path)
      i = Math.max(quoted.next, at + ARTIFACT_PREFIX.length)
      continue
    }
    const bare = bareArtifactSpan(text, at)
    if (bare.path.length > ARTIFACT_PREFIX.length) found.add(bare.path)
    i = Math.max(bare.next, at + ARTIFACT_PREFIX.length)
  }
  return [...found]
}

function resolveLeaderResultMax(maxChars?: number): number {
  if (typeof maxChars !== 'number' || !Number.isFinite(maxChars) || maxChars < 2) {
    return DELEGATE_LEADER_RESULT_ITEM_MAX_CHARS
  }
  return Math.floor(maxChars)
}

function clipHead(text: string, len: number): string {
  let end = Math.min(Math.max(len, 0), text.length)
  if (end > 0 && end < text.length) {
    const cu = text.charCodeAt(end - 1)
    if (cu >= 0xd800 && cu <= 0xdbff) end -= 1
  }
  return text.slice(0, end)
}

function clipTail(text: string, len: number): string {
  let start = Math.max(0, text.length - Math.max(len, 0))
  if (start > 0 && start < text.length) {
    const cu = text.charCodeAt(start)
    if (cu >= 0xdc00 && cu <= 0xdfff) start += 1
  }
  return text.slice(start)
}

/**
 * 队长上下文里的成员正文。不超过 max 字的原文对半留开头和结尾,中间写明省略字数。
 * 落在省略段里的产物路径仍逐条列出。短文本原样返回。
 */
export function truncateDelegateLeaderResult(
  text: string,
  maxChars: number = DELEGATE_LEADER_RESULT_ITEM_MAX_CHARS,
): string {
  const max = resolveLeaderResultMax(maxChars)
  if (text.length <= max) return text
  const paths = extractGeneratedArtifactPaths(text)
  const headLen = Math.ceil(max / 2)
  const tailLen = max - headLen
  const head = clipHead(text, headLen)
  const tail = clipTail(text, tailLen)
  const omitted = text.length - head.length - tail.length
  const pathBlock =
    paths.length > 0
      ? `\n产物路径(完整文件仍在,请用 Read 打开):\n${paths.map((p) => `- ${p}`).join('\n')}`
      : ''
  const note = `\n…(中间省略 ${omitted} 字;完整结果仍在该成员会话与产物文件,未删除)${pathBlock}\n`
  return `${head}${note}${tail}`
}

export function formatDelegateSuccess(
  label: string,
  output: string,
  sessionKey?: string,
  maxChars?: number,
): string {
  const shown = output
    ? truncateDelegateLeaderResult(output, resolveLeaderResultMax(maxChars))
    : '(无输出)'
  const body = `✅ 委派完成 (agent: ${label})\n\n${shown}`
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
    '本次 MCP 调用只负责启动并短等；子任务会继续运行。请立刻用 Bash 阻塞等待结果,不要重复调用 delegate_task,也不要轮询 MCP:',
    `  oc-memory delegate-wait ${jobId}`,
    '该命令会阻塞直到子任务完成、无活动超时或网关重启导致句柄失效,然后把结果打印到 stdout。',
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
  const header = `并行委派 ${items.length} 个子任务: ${done.length} 已完成 / ${running.length} 仍在运行(本次 MCP 调用已返回作业句柄)。`
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
  | { kind: 'running'; jobId: string; sessionKey?: string }
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

/** Apply the historical sync `/delegate` result mapping (success text / toolError). */
export function formatDelegateHttpResult(
  httpStatus: number,
  data: Record<string, unknown>,
  label: string,
  maxChars?: number,
): FormattedDelegateResult {
  const max = resolveLeaderResultMax(maxChars)
  if (httpStatus < 200 || httpStatus >= 300) {
    const err = typeof data.error === 'string' ? data.error : JSON.stringify(data)
    return { kind: 'error', text: `委派失败: ${truncateDelegateLeaderResult(err, max)}` }
  }
  if (data.error || data.ok === false) {
    const err = String(data.error || data.output || 'unknown error')
    return { kind: 'error', text: `子 agent 执行出错: ${truncateDelegateLeaderResult(err, max)}` }
  }
  const output = typeof data.output === 'string' ? data.output : ''
  if (looksLikeDelegateApiError(output)) {
    return {
      kind: 'error',
      text: `子 agent 执行出错: ${truncateDelegateLeaderResult(output, max)}`,
    }
  }
  const sessionKey =
    typeof data.sessionKey === 'string' && data.sessionKey.trim()
      ? data.sessionKey.trim()
      : undefined
  return { kind: 'ok', text: formatDelegateSuccess(label, output, sessionKey, max) }
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
  let waited: { statusCode: number; body: string }
  try {
    waited = await opts.transport.wait(start.jobId, opts.fastWaitMs)
  } catch (err) {
    // 2026-09-06 L2 矩阵实测:网关重载时 /api/delegate/wait 长轮询要 52–80s 才返回,
    // MCP 客户端 (fastWaitMs+15s) 先超时 → 以前整段报「委派失败: delegate client timeout」,
    // 而子任务其实已经/仍在正常跑(DB 里 completed)。作业句柄已在 start 阶段拿到,传输层
    // 抖动(ETIMEDOUT/ECONNRESET/socket hang up)只说明"这一轮没等到",不是失败:
    // 退化为 running 句柄,让父走 `oc-memory delegate-wait <jobId>` 阻塞取回。
    if (isTransientDelegateWaitError(err)) {
      return {
        kind: 'running',
        jobId: start.jobId,
        text: formatDelegateRunning(start.jobId, opts.label, opts.goal, start.sessionKey),
      }
    }
    throw err
  }
  const view = interpretDelegateWaitBody(waited.statusCode, waited.body)
  if (view.kind === 'running') {
    const sessionKey = start.sessionKey || view.sessionKey
    return {
      kind: 'running',
      jobId: view.jobId,
      text: formatDelegateRunning(view.jobId, opts.label, opts.goal, sessionKey),
    }
  }
  if (view.kind === 'expired') {
    return { kind: 'error', text: `委派失败: ${view.error}` }
  }
  if (view.kind === 'error') return { kind: 'error', text: view.error }
  return formatDelegateHttpResult(view.httpStatus, view.body, opts.label)
}
