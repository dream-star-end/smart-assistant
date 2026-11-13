/**
 * User-facing text for a failed Codex imageGeneration item.
 * Codex 0.163 often sets status=failed with failure=null and puts the HTTP
 * body only on stderr. The user sees a whitelist Chinese sentence. Internal
 * codes and upstream text stay in the log, with secrets stripped.
 */

import { createLogger } from '../logger.js'

const log = createLogger({ module: 'imageGenerationFailure' })

const CONTINUE = '点「继续」，助手会改用其他方式做完。'

const CODE_GLOSS: Record<string, string> = {
  IMAGE2_DISABLED: 'Image 2 还没打开',
  IMAGE_BILLING_UNAVAILABLE: '计费还没准备好',
  IMAGE_DAILY_LIMIT: '今天的次数已到上限',
  IMAGE_ATTEMPT_LIMIT: '太频繁，请稍后再试',
  ERR_INSUFFICIENT_CREDITS: '积分不够',
  IMAGE_BILLING_INSUFFICIENT: '积分不够',
}

const GENERIC = `图片生成没有完成。${CONTINUE}`

const CODE_RE = /^[A-Z][A-Z0-9_]{0,48}$/

/** Strip token, key, secret, bearer, and cookie values before any log line. */
export function redactImageUpstream(raw: string): string {
  const assignment =
    /\b(?:access_token|refresh_token|id_token|api[_-]?key|client_secret|secret|password|bearer|cookie|authorization|token)\s*[=:]\s*(?:"[^"]*"|'[^']*'|\S+)/gi
  return raw
    .replace(assignment, (match) => {
      const sep = match.search(/[=:]/)
      return `${match.slice(0, sep + 1)}[redacted]`
    })
    .replace(/\bbearer\s+\S+/gi, 'bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, '[redacted]')
}

/**
 * User copy is a known reason-code gloss, or one generic sentence.
 * Free text, HTTP status, and unknown codes are never interpolated.
 */
export function formatImageGenerationFailure(input: {
  code?: string
  httpStatus?: string
  detail?: string
}): string {
  const code = input.code && CODE_RE.test(input.code) ? input.code : undefined
  if (code || input.httpStatus || input.detail) {
    log.warn('image generation failure', {
      ...(code ? { code } : {}),
      ...(input.httpStatus && /^\d{3}$/.test(input.httpStatus)
        ? { httpStatus: input.httpStatus }
        : {}),
      ...(input.detail ? { upstream: redactImageUpstream(input.detail) } : {}),
    })
  }
  const gloss = code ? CODE_GLOSS[code] : undefined
  if (gloss) return `图片生成没有完成：${gloss}。${CONTINUE}`
  return GENERIC
}

function messageOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return undefined
  const message = (value as { message?: unknown }).message
  return typeof message === 'string' ? message : undefined
}

/** Pull a short, non-secret reason off the completed item. Secrets stay in the log. */
export function imageFailureDetail(item: Record<string, unknown>): string | undefined {
  for (const candidate of [item.error, item.failure]) {
    const raw = messageOf(candidate)
    if (raw === undefined) continue
    const text = raw.replace(/\s+/g, ' ').trim()
    if (text.length < 1 || text.length > 120) continue
    const redacted = redactImageUpstream(text)
    log.warn('image generation upstream detail', { upstream: redacted })
    if (redacted !== text) continue
    return text
  }
  return undefined
}

const imageFailureNotes = new WeakMap<object, string>()

/** `line === null` clears the note for this runner. A matching stderr line replaces it. */
export function rememberImageStderr(host: object, line: string | null): void {
  if (!line) {
    imageFailureNotes.delete(host)
    return
  }
  const note = noteFromImageGenerationStderr(line)
  if (note) imageFailureNotes.set(host, note)
}

export function takeImageFailureNote(host: object): string | null {
  const note = imageFailureNotes.get(host) ?? null
  imageFailureNotes.delete(host)
  return note
}

export function noteFromImageGenerationStderr(line: string): string | null {
  const plain = line.split(String.fromCharCode(0x1b)).join('')
  if (!/image generation failed/i.test(plain)) return null
  const http = /image generation failed:\s*http\s+(\d{3})\b/i.exec(plain)
  const code = /\\?"code\\?"\s*:\s*\\?"([A-Z][A-Z0-9_]{0,48})\\?"/.exec(plain)
  return formatImageGenerationFailure({
    httpStatus: http?.[1],
    code: code?.[1],
  })
}
