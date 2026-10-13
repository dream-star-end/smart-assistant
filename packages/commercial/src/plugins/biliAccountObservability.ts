/**
 * Bilibili account worker failure codes and sanitized host logs (OCV5-402).
 *
 * Same rules as the Weibo worker logs (weiboWriteObservability.ts): Docker's log driver stays
 * `none` because stdout carries storage state (cookies); the host keeps only allow-listed step
 * fields in a bounded JSONL file per session. No cookie, token, URL query or upstream text
 * ever reaches the log.
 */
import { appendFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Codes the worker may put in a `failed` frame. Anything else is a protocol error. */
export const BILI_ACCOUNT_WORKER_PROTOCOL_FAILURE_CODES = [
  'WORKER_FAILED',
  'LOGIN_EXPIRED',
  'UPSTREAM_CHALLENGE',
  'LOGIN_STATE_UNSUPPORTED',
] as const
export type BiliAccountWorkerProtocolFailureCode =
  (typeof BILI_ACCOUNT_WORKER_PROTOCOL_FAILURE_CODES)[number]

/** Stable runtime codes surfaced to the RPC layer (pluginErrorGuidance passthrough). */
export const BILI_ACCOUNT_FAILURE_CODES = [
  'BILI_ACCOUNT_ACTION_FAILED',
  'BILI_ACCOUNT_UPSTREAM_CHALLENGE',
  'BILI_ACCOUNT_LOGIN_UNSUPPORTED',
  'BILI_ACCOUNT_WORKER_BUSY',
  'BILI_ACCOUNT_WORKER_DEADLINE',
  'BILI_ACCOUNT_WORKER_INCOMPLETE',
] as const
export type BiliAccountFailureCode = (typeof BILI_ACCOUNT_FAILURE_CODES)[number]

const PROTOCOL_FAILURE_SET = new Set<string>(BILI_ACCOUNT_WORKER_PROTOCOL_FAILURE_CODES)

export function isBiliAccountWorkerProtocolFailureCode(
  code: string,
): code is BiliAccountWorkerProtocolFailureCode {
  return PROTOCOL_FAILURE_SET.has(code)
}

export function mapBiliAccountWorkerProtocolFailure(
  code: BiliAccountWorkerProtocolFailureCode,
): BiliAccountFailureCode | 'LOGIN_EXPIRED_ACCOUNT' {
  switch (code) {
    case 'LOGIN_EXPIRED':
      return 'LOGIN_EXPIRED_ACCOUNT'
    case 'UPSTREAM_CHALLENGE':
      return 'BILI_ACCOUNT_UPSTREAM_CHALLENGE'
    case 'LOGIN_STATE_UNSUPPORTED':
      return 'BILI_ACCOUNT_LOGIN_UNSUPPORTED'
    default:
      return 'BILI_ACCOUNT_ACTION_FAILED'
  }
}

export const DEFAULT_BILI_ACCOUNT_WORKER_LOG_DIR =
  '/var/log/openclaude-v5-selfhost/bili-account-workers'
const LOG_MAX_FILE_BYTES = 64 * 1024
const LOG_MAX_FILES = 40
const LOG_MAX_DIR_BYTES = 4 * 1024 * 1024

const LOG_BOOL_KEYS = new Set(['ok'])
const LOG_NUMBER_KEYS = new Set(['t', 'ms'])
const LOG_STRING_KEYS = new Set(['src', 'step', 'code', 'actionId', 'kind', 'sessionId', 'event'])

export function biliAccountWorkerDockerLogConfig(): {
  Type: 'none'
  Config: Record<string, never>
} {
  return { Type: 'none', Config: {} }
}

export function sanitizeBiliAccountWorkerLogEvent(value: unknown): Record<string, unknown> | null {
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

export function sanitizeBiliAccountWorkerLogLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{') || trimmed.length > 2048) return null
  try {
    return sanitizeBiliAccountWorkerLogEvent(JSON.parse(trimmed) as unknown)
  } catch {
    return null
  }
}

function safeSessionFile(sessionId: string): string {
  const id = sessionId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 36)
  return id.length >= 8 ? id : 'unknown'
}

export async function persistBiliAccountWorkerLog(
  dir: string,
  sessionId: string,
  event: Record<string, unknown>,
): Promise<void> {
  const sanitized = sanitizeBiliAccountWorkerLogEvent({
    src: 'bili-account-host',
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
