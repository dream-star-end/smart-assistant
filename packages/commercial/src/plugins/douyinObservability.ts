/**
 * Douyin worker failure codes and sanitized host logs (OCV5-553).
 *
 * Same rules as the Bilibili account / Weibo worker logs (weiboWriteObservability.ts): Docker's log driver stays
 * `none` because stdout carries storage state (cookies); the host keeps only allow-listed step
 * fields in a bounded JSONL file per session. No cookie, token, URL query or upstream text
 * ever reaches the log.
 */
import { appendFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Codes the worker may put in a `failed` frame. Anything else is a protocol error. */
export const DOUYIN_WORKER_PROTOCOL_FAILURE_CODES = [
  'WORKER_FAILED',
  'LOGIN_EXPIRED',
  'UPSTREAM_CHALLENGE',
  'LOGIN_STATE_UNSUPPORTED',
  'VERIFICATION_REQUIRED',
] as const
export type DouyinWorkerProtocolFailureCode = (typeof DOUYIN_WORKER_PROTOCOL_FAILURE_CODES)[number]

/** Stable runtime codes surfaced to the RPC layer (pluginErrorGuidance passthrough). */
export const DOUYIN_FAILURE_CODES = [
  'DOUYIN_ACTION_FAILED',
  'DOUYIN_UPSTREAM_CHALLENGE',
  'DOUYIN_LOGIN_UNSUPPORTED',
  'DOUYIN_VERIFICATION_REQUIRED',
  'DOUYIN_WORKER_BUSY',
  'DOUYIN_WORKER_DEADLINE',
  'DOUYIN_WORKER_INCOMPLETE',
] as const
export type DouyinFailureCode = (typeof DOUYIN_FAILURE_CODES)[number]

const PROTOCOL_FAILURE_SET = new Set<string>(DOUYIN_WORKER_PROTOCOL_FAILURE_CODES)

export function isDouyinWorkerProtocolFailureCode(
  code: string,
): code is DouyinWorkerProtocolFailureCode {
  return PROTOCOL_FAILURE_SET.has(code)
}

export function mapDouyinWorkerProtocolFailure(
  code: DouyinWorkerProtocolFailureCode,
): DouyinFailureCode | 'LOGIN_EXPIRED_ACCOUNT' {
  switch (code) {
    case 'LOGIN_EXPIRED':
      return 'LOGIN_EXPIRED_ACCOUNT'
    case 'UPSTREAM_CHALLENGE':
      return 'DOUYIN_UPSTREAM_CHALLENGE'
    case 'LOGIN_STATE_UNSUPPORTED':
      return 'DOUYIN_LOGIN_UNSUPPORTED'
    case 'VERIFICATION_REQUIRED':
      return 'DOUYIN_VERIFICATION_REQUIRED'
    default:
      return 'DOUYIN_ACTION_FAILED'
  }
}

/** 商业版路径（微博 / 知乎 / B 站账号沿用了个人版路径，是已知缺陷，本插件不跟）。 */
export const DEFAULT_DOUYIN_WORKER_LOG_DIR = '/var/log/openclaude-v5/douyin-workers'
const LOG_MAX_FILE_BYTES = 64 * 1024
const LOG_MAX_FILES = 40
const LOG_MAX_DIR_BYTES = 4 * 1024 * 1024

const LOG_BOOL_KEYS = new Set(['ok'])
const LOG_NUMBER_KEYS = new Set(['t', 'ms'])
// host：被拦下的来源域名（net.blocked），只有域名，没有路径和参数。
const LOG_STRING_KEYS = new Set([
  'src',
  'step',
  'code',
  'actionId',
  'kind',
  'sessionId',
  'event',
  'host',
])

export function douyinWorkerDockerLogConfig(): {
  Type: 'none'
  Config: Record<string, never>
} {
  return { Type: 'none', Config: {} }
}

export function sanitizeDouyinWorkerLogEvent(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return null
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (LOG_BOOL_KEYS.has(key)) {
      if (item === true || item === false) out[key] = item
    } else if (LOG_NUMBER_KEYS.has(key)) {
      if (typeof item === 'number' && Number.isFinite(item)) out[key] = Math.round(item)
    } else if (LOG_STRING_KEYS.has(key)) {
      if (typeof item === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(item)) out[key] = item
    }
  }
  if (typeof out.step !== 'string' && typeof out.event !== 'string') return null
  return out
}

export function sanitizeDouyinWorkerLogLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{') || trimmed.length > 2048) return null
  try {
    return sanitizeDouyinWorkerLogEvent(JSON.parse(trimmed) as unknown)
  } catch {
    return null
  }
}

function safeSessionFile(sessionId: string): string {
  const id = sessionId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 36)
  return id.length >= 8 ? id : 'unknown'
}

export async function persistDouyinWorkerLog(
  dir: string,
  sessionId: string,
  event: Record<string, unknown>,
): Promise<void> {
  const sanitized = sanitizeDouyinWorkerLogEvent({
    src: 'douyin-host',
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
    if (existing && existing.size + line.length > LOG_MAX_FILE_BYTES) return
    await appendFile(file, line, { encoding: 'utf8', mode: 0o640 })
    await pruneLogs(dir)
  } catch {
    // Observability must never fail a call.
  }
}

async function pruneLogs(dir: string): Promise<void> {
  const names = await readdir(dir).catch(() => [])
  const files: Array<{ path: string; mtimeMs: number; size: number }> = []
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const path = join(dir, name)
    const info = await stat(path).catch(() => null)
    if (info?.isFile()) files.push({ path, mtimeMs: info.mtimeMs, size: info.size })
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  let total = 0
  for (const [index, file] of files.entries()) {
    total += file.size
    if (index < LOG_MAX_FILES && total <= LOG_MAX_DIR_BYTES) continue
    await rm(file.path, { force: true }).catch(() => {})
  }
}
