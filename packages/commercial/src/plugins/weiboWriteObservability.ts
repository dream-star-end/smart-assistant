import { appendFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Stable, enumerable Weibo write-failure codes.
 * Status (`failed` vs `unknown`) is NOT derived from these codes — only from the
 * dispatch fence. `unknown` still means "side effect may have landed".
 */
export const WEIBO_WRITE_FAILURE_CODES = [
  'WEIBO_WRITE_MEDIA',
  'WEIBO_WRITE_MEDIA_CHOOSER',
  'WEIBO_WRITE_MEDIA_UPLOAD',
  'WEIBO_WRITE_MEDIA_PREVIEW',
  'WEIBO_WRITE_MEDIA_PREVIEW_TIMEOUT',
  'WEIBO_WRITE_COMPOSER',
  'WEIBO_WRITE_COMPOSER_EDITOR',
  'WEIBO_WRITE_COMPOSER_READBACK',
  'WEIBO_WRITE_COMPOSER_LONGTEXT',
  'WEIBO_WRITE_SEND',
  'WEIBO_WRITE_SEND_BUTTON',
  'WEIBO_WRITE_SEND_CLICK',
  'WEIBO_WRITE_SEND_UNCLEARED',
  'WEIBO_WRITE_RESULT',
  'WEIBO_WORKER_BUSY',
  'WEIBO_WORKER_DEADLINE',
  'WEIBO_WORKER_INCOMPLETE',
  'WEIBO_ACTION_FAILED',
  'UPSTREAM_FAILED',
] as const

export type WeiboWriteFailureCode = (typeof WEIBO_WRITE_FAILURE_CODES)[number]

export const WEIBO_WORKER_PROTOCOL_FAILURE_CODES = [
  'WORKER_FAILED',
  'LOGIN_EXPIRED',
  'UPSTREAM_FAILED',
  'WEIBO_WRITE_MEDIA',
  'WEIBO_WRITE_MEDIA_CHOOSER',
  'WEIBO_WRITE_MEDIA_UPLOAD',
  'WEIBO_WRITE_MEDIA_PREVIEW',
  'WEIBO_WRITE_MEDIA_PREVIEW_TIMEOUT',
  'WEIBO_WRITE_COMPOSER',
  'WEIBO_WRITE_COMPOSER_EDITOR',
  'WEIBO_WRITE_COMPOSER_READBACK',
  'WEIBO_WRITE_COMPOSER_LONGTEXT',
  'WEIBO_WRITE_SEND',
  'WEIBO_WRITE_SEND_BUTTON',
  'WEIBO_WRITE_SEND_CLICK',
  'WEIBO_WRITE_SEND_UNCLEARED',
  'WEIBO_WRITE_RESULT',
] as const

export type WeiboWorkerProtocolFailureCode =
  (typeof WEIBO_WORKER_PROTOCOL_FAILURE_CODES)[number]

const WORKER_STAGE_TO_CODE: Readonly<Record<string, WeiboWorkerProtocolFailureCode>> = {
  'composer-editor': 'WEIBO_WRITE_COMPOSER_EDITOR',
  'composer-readback': 'WEIBO_WRITE_COMPOSER_READBACK',
  'composer-longtext': 'WEIBO_WRITE_COMPOSER_LONGTEXT',
  composer: 'WEIBO_WRITE_COMPOSER',
  'media-chooser': 'WEIBO_WRITE_MEDIA_CHOOSER',
  'media-upload': 'WEIBO_WRITE_MEDIA_UPLOAD',
  'media-preview-timeout': 'WEIBO_WRITE_MEDIA_PREVIEW_TIMEOUT',
  'media-preview': 'WEIBO_WRITE_MEDIA_PREVIEW',
  media: 'WEIBO_WRITE_MEDIA',
  'send-button': 'WEIBO_WRITE_SEND_BUTTON',
  'send-click': 'WEIBO_WRITE_SEND_CLICK',
  'send-uncleared': 'WEIBO_WRITE_SEND_UNCLEARED',
  send: 'WEIBO_WRITE_SEND',
  result: 'WEIBO_WRITE_RESULT',
}

const PROTOCOL_FAILURE_SET = new Set<string>(WEIBO_WORKER_PROTOCOL_FAILURE_CODES)
const WRITE_FAILURE_SET = new Set<string>(WEIBO_WRITE_FAILURE_CODES)
const STABLE_CODE_RE = /^[A-Z0-9_]{1,64}$/

export const DEFAULT_WEIBO_WORKER_LOG_DIR = '/var/log/openclaude-v5-selfhost/weibo-workers'
export const WEIBO_WORKER_LOG_MAX_FILE_BYTES = 256 * 1024
export const WEIBO_WORKER_LOG_MAX_FILES = 40
export const WEIBO_WORKER_LOG_MAX_DIR_BYTES = 10 * 1024 * 1024

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
  'longText',
  'mediaCount',
  'code',
  'actionId',
  'kind',
  'sessionId',
  'event',
  'branch',
  'reason',
  'hasImage',
  'retried',
  'scopeInputs',
  'pageInputs',
  'scopeImageInputs',
  'pageImageInputs',
  'imageTitleHits',
  'imageIconHits',
  'imageTextHits',
  'imageControlHits',
  'selected',
  'freshSelected',
  'imgCount',
  'addedSrcs',
  'bgCount',
  'canvasCount',
  'frameCount',
  'deleteHits',
])

/**
 * Docker json-file would persist stdout, and stdout carries storageState/cookies.
 * Keep the driver at `none`; sanitized step events go to a host JSONL file instead.
 */
export function weiboWorkerDockerLogConfig(): { Type: 'none'; Config: Record<string, never> } {
  return { Type: 'none', Config: {} }
}

export function isWeiboWorkerProtocolFailureCode(
  code: string,
): code is WeiboWorkerProtocolFailureCode {
  return PROTOCOL_FAILURE_SET.has(code)
}

export function mapWeiboWorkerStage(reason: unknown): WeiboWorkerProtocolFailureCode {
  const message =
    reason && typeof reason === 'object' && 'message' in reason
      ? String((reason as { message: unknown }).message)
      : String(reason ?? '')
  return WORKER_STAGE_TO_CODE[message] ?? 'WORKER_FAILED'
}

export function mapWeiboWorkerProtocolFailure(
  code: string,
): WeiboWriteFailureCode | 'LOGIN_EXPIRED_ACCOUNT' | 'EXECUTION_FAILED' {
  if (code === 'LOGIN_EXPIRED') return 'LOGIN_EXPIRED_ACCOUNT'
  if (code === 'WORKER_FAILED') return 'WEIBO_ACTION_FAILED'
  if (WRITE_FAILURE_SET.has(code)) return code as WeiboWriteFailureCode
  return 'EXECUTION_FAILED'
}

export function weiboWriteErrorCodeFromUnknown(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && STABLE_CODE_RE.test(code)) return code
  const mapped = mapWeiboWorkerStage(error)
  return mapped === 'WORKER_FAILED' ? 'INTERNAL' : mapped
}

/**
 * Ledger fields for a Weibo write failure.
 * `status` is a function of the dispatch fence only — never of the error class.
 */
export function classifyWeiboWriteLedgerFields(input: {
  error: unknown
  dispatchArmed: boolean
  dispatchProvenNotStarted?: boolean
}): { errorCode: string; status: 'failed' | 'unknown' } {
  const errorCode = weiboWriteErrorCodeFromUnknown(input.error)
  if (input.dispatchProvenNotStarted) return { errorCode, status: 'failed' }
  if (input.dispatchArmed) return { errorCode, status: 'unknown' }
  return { errorCode, status: 'failed' }
}

export function sanitizeWeiboWorkerLogEvent(
  value: unknown,
): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return null
  const raw = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(raw)) {
    if (!LOG_ALLOW_KEYS.has(key)) continue
    if (key === 'ok' || key === 'longText' || key === 'hasImage' || key === 'retried') {
      if (item === true || item === false) out[key] = item
      continue
    }
    if (
      key === 't' ||
      key === 'ms' ||
      key === 'hits' ||
      key === 'timeoutMs' ||
      key === 'textLen' ||
      key === 'mediaCount' ||
      key === 'scopeInputs' ||
      key === 'pageInputs' ||
      key === 'scopeImageInputs' ||
      key === 'pageImageInputs' ||
      key === 'imageTitleHits' ||
      key === 'imageIconHits' ||
      key === 'imageTextHits' ||
      key === 'imageControlHits' ||
      key === 'selected' ||
      key === 'freshSelected' ||
      key === 'imgCount' ||
      key === 'addedSrcs' ||
      key === 'bgCount' ||
      key === 'canvasCount' ||
      key === 'frameCount' ||
      key === 'deleteHits'
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

export function sanitizeWeiboWorkerLogLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{') || trimmed.length > 2048) return null
  try {
    return sanitizeWeiboWorkerLogEvent(JSON.parse(trimmed) as unknown)
  } catch {
    return null
  }
}

function safeSessionFile(sessionId: string): string {
  const id = sessionId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 36)
  return id.length >= 8 ? id : 'unknown'
}

export async function persistWeiboWorkerLog(
  dir: string,
  sessionId: string,
  event: Record<string, unknown>,
): Promise<void> {
  const sanitized = sanitizeWeiboWorkerLogEvent({
    src: 'weibo-host',
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
    if (existing && existing.size + line.length > WEIBO_WORKER_LOG_MAX_FILE_BYTES) return
    await appendFile(file, line, { encoding: 'utf8', mode: 0o640 })
    await pruneWeiboWorkerLogs(dir)
  } catch {
    // Observability must never fail a write.
  }
}

export async function pruneWeiboWorkerLogs(dir: string): Promise<void> {
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
    if (index < WEIBO_WORKER_LOG_MAX_FILES && total <= WEIBO_WORKER_LOG_MAX_DIR_BYTES) continue
    await rm(file.path, { force: true }).catch(() => {})
  }
}
