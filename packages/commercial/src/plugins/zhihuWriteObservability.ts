import { appendFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Stable, enumerable Zhihu write-failure codes.
 * Status (`failed` vs `unknown`) is NOT derived from these codes — only from the
 * dispatch fence. `unknown` still means "side effect may have landed".
 */
export const ZHIHU_WRITE_FAILURE_CODES = [
  'ZHIHU_WRITE_COMPOSER',
  'ZHIHU_WRITE_COMPOSER_EDITOR',
  'ZHIHU_WRITE_COMPOSER_READBACK',
  'ZHIHU_WRITE_SEND',
  'ZHIHU_WRITE_SEND_BUTTON',
  'ZHIHU_WRITE_SEND_CLICK',
  'ZHIHU_WRITE_RESULT',
  'ZHIHU_WRITE_UNSUPPORTED',
  'ZHIHU_WORKER_BUSY',
  'ZHIHU_WORKER_DEADLINE',
  'ZHIHU_WORKER_INCOMPLETE',
  'ZHIHU_ACTION_FAILED',
  'ZHIHU_UPSTREAM_CHALLENGE',
] as const

export type ZhihuWriteFailureCode = (typeof ZHIHU_WRITE_FAILURE_CODES)[number]

export const ZHIHU_WORKER_PROTOCOL_FAILURE_CODES = [
  'WORKER_FAILED',
  'LOGIN_EXPIRED',
  'ZHIHU_UPSTREAM_CHALLENGE',
  'ZHIHU_WRITE_COMPOSER',
  'ZHIHU_WRITE_COMPOSER_EDITOR',
  'ZHIHU_WRITE_COMPOSER_READBACK',
  'ZHIHU_WRITE_SEND',
  'ZHIHU_WRITE_SEND_BUTTON',
  'ZHIHU_WRITE_SEND_CLICK',
  'ZHIHU_WRITE_RESULT',
  'ZHIHU_WRITE_UNSUPPORTED',
] as const

export type ZhihuWorkerProtocolFailureCode =
  (typeof ZHIHU_WORKER_PROTOCOL_FAILURE_CODES)[number]

const WORKER_STAGE_TO_CODE: Readonly<Record<string, ZhihuWorkerProtocolFailureCode>> = {
  'composer-editor': 'ZHIHU_WRITE_COMPOSER_EDITOR',
  'composer-readback': 'ZHIHU_WRITE_COMPOSER_READBACK',
  composer: 'ZHIHU_WRITE_COMPOSER',
  'send-button': 'ZHIHU_WRITE_SEND_BUTTON',
  'send-click': 'ZHIHU_WRITE_SEND_CLICK',
  send: 'ZHIHU_WRITE_SEND',
  result: 'ZHIHU_WRITE_RESULT',
  unsupported: 'ZHIHU_WRITE_UNSUPPORTED',
}

const PROTOCOL_FAILURE_SET = new Set<string>(ZHIHU_WORKER_PROTOCOL_FAILURE_CODES)
const WRITE_FAILURE_SET = new Set<string>(ZHIHU_WRITE_FAILURE_CODES)
const STABLE_CODE_RE = /^[A-Z0-9_]{1,64}$/

export const DEFAULT_ZHIHU_WORKER_LOG_DIR = '/var/log/openclaude-v5-selfhost/zhihu-workers'
export const ZHIHU_WORKER_LOG_MAX_FILE_BYTES = 256 * 1024
export const ZHIHU_WORKER_LOG_MAX_FILES = 40
export const ZHIHU_WORKER_LOG_MAX_DIR_BYTES = 10 * 1024 * 1024

const LOG_ALLOW_KEYS = new Set([
  'src',
  't',
  'step',
  'ok',
  'ms',
  'hits',
  'timeoutMs',
  'textLen',
  'textHash8',
  'code',
  'actionId',
  'kind',
  'sessionId',
  'event',
  'branch',
  'reason',
  'selected',
])

/**
 * Docker json-file would persist stdout, and stdout carries storageState/cookies.
 * Keep the driver at `none`; sanitized step events go to a host JSONL file instead.
 */
export function zhihuWorkerDockerLogConfig(): { Type: 'none'; Config: Record<string, never> } {
  return { Type: 'none', Config: {} }
}

export function isZhihuWorkerProtocolFailureCode(
  code: string,
): code is ZhihuWorkerProtocolFailureCode {
  return PROTOCOL_FAILURE_SET.has(code)
}

export function mapZhihuWorkerStage(reason: unknown): ZhihuWorkerProtocolFailureCode {
  const message =
    reason && typeof reason === 'object' && 'message' in reason
      ? String((reason as { message: unknown }).message)
      : String(reason ?? '')
  return WORKER_STAGE_TO_CODE[message] ?? 'WORKER_FAILED'
}

export function mapZhihuWorkerProtocolFailure(
  code: string,
): ZhihuWriteFailureCode | 'LOGIN_EXPIRED_ACCOUNT' | 'EXECUTION_FAILED' {
  if (code === 'LOGIN_EXPIRED') return 'LOGIN_EXPIRED_ACCOUNT'
  if (code === 'WORKER_FAILED') return 'ZHIHU_ACTION_FAILED'
  if (WRITE_FAILURE_SET.has(code)) return code as ZhihuWriteFailureCode
  return 'EXECUTION_FAILED'
}

export function zhihuWriteErrorCodeFromUnknown(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && STABLE_CODE_RE.test(code)) return code
  const mapped = mapZhihuWorkerStage(error)
  return mapped === 'WORKER_FAILED' ? 'INTERNAL' : mapped
}

/**
 * Ledger fields for a Zhihu write failure.
 * `status` is a function of the dispatch fence only — never of the error class.
 */
export function classifyZhihuWriteLedgerFields(input: {
  error: unknown
  dispatchArmed: boolean
  dispatchProvenNotStarted?: boolean
}): { errorCode: string; status: 'failed' | 'unknown' } {
  const errorCode = zhihuWriteErrorCodeFromUnknown(input.error)
  if (input.dispatchProvenNotStarted) return { errorCode, status: 'failed' }
  if (input.dispatchArmed) return { errorCode, status: 'unknown' }
  return { errorCode, status: 'failed' }
}

export function sanitizeZhihuWorkerLogEvent(
  value: unknown,
): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return null
  const raw = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(raw)) {
    if (!LOG_ALLOW_KEYS.has(key)) continue
    if (key === 'ok') {
      if (item === true || item === false) out[key] = item
      continue
    }
    if (
      key === 't' ||
      key === 'ms' ||
      key === 'hits' ||
      key === 'timeoutMs' ||
      key === 'textLen' ||
      key === 'selected'
    ) {
      if (typeof item === 'number' && Number.isFinite(item)) out[key] = Math.round(item)
      continue
    }
    if (typeof item !== 'string') continue
    if (key === 'textHash8') {
      out[key] = item.slice(0, 8)
      continue
    }
    out[key] = item.slice(0, 96)
  }
  if (typeof out.step !== 'string' && typeof out.event !== 'string') return null
  return out
}

export function sanitizeZhihuWorkerLogLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{') || trimmed.length > 2048) return null
  try {
    return sanitizeZhihuWorkerLogEvent(JSON.parse(trimmed) as unknown)
  } catch {
    return null
  }
}

function safeSessionFile(sessionId: string): string {
  const id = sessionId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 36)
  return id.length >= 8 ? id : 'unknown'
}

export async function persistZhihuWorkerLog(
  dir: string,
  sessionId: string,
  event: Record<string, unknown>,
): Promise<void> {
  const sanitized = sanitizeZhihuWorkerLogEvent({
    src: 'zhihu-host',
    t: Date.now(),
    sessionId: safeSessionFile(sessionId),
    ...event,
  })
  if (!sanitized) return
  try {
    await mkdir(dir, { mode: 0o750, recursive: true })
    const file = join(dir, `${safeSessionFile(sessionId)}.jsonl`)
    const line = `${JSON.stringify(sanitized)}\n`
    const existing = await stat(file).catch(() => null)
    if (existing && existing.size + line.length > ZHIHU_WORKER_LOG_MAX_FILE_BYTES) return
    await appendFile(file, line, { encoding: 'utf8', mode: 0o640 })
    await pruneZhihuWorkerLogs(dir)
  } catch {
    // Observability must never fail a write.
  }
}

export async function pruneZhihuWorkerLogs(dir: string): Promise<void> {
  const names = await readdir(dir).catch(() => [])
  const files: Array<{ name: string; path: string; mtimeMs: number; size: number }> = []
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const path = join(dir, name)
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) continue
    files.push({ name, path, mtimeMs: info.mtimeMs, size: info.size })
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  let total = 0
  for (const [index, file] of files.entries()) {
    total += file.size
    if (index < ZHIHU_WORKER_LOG_MAX_FILES && total <= ZHIHU_WORKER_LOG_MAX_DIR_BYTES) continue
    await rm(file.path, { force: true }).catch(() => {})
  }
}
