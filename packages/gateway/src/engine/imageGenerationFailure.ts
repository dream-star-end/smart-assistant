/**
 * User-facing text for a failed Codex imageGeneration item.
 * Codex 0.163 often sets status=failed with failure=null and puts the HTTP
 * body only on stderr. Keep the upstream code, drop bytes, tokens, and raw JSON.
 */

const CONTINUE = '点「继续」，助手会改用其他方式做完。'

const CODE_GLOSS: Record<string, string> = {
  IMAGE2_DISABLED: 'Image 2 还没打开',
  IMAGE_BILLING_UNAVAILABLE: '计费还没准备好',
  IMAGE_DAILY_LIMIT: '今天的次数已到上限',
  IMAGE_ATTEMPT_LIMIT: '太频繁，请稍后再试',
  ERR_INSUFFICIENT_CREDITS: '积分不够',
  IMAGE_BILLING_INSUFFICIENT: '积分不够',
}

export function formatImageGenerationFailure(input: {
  code?: string
  httpStatus?: string
  detail?: string
}): string {
  const code = input.code
  if (code && /^[A-Z][A-Z0-9_]{0,48}$/.test(code)) {
    const gloss = CODE_GLOSS[code]
    const reason = gloss ? `${code}（${gloss}）` : code
    return `图片生成没有完成：${reason}。${CONTINUE}`
  }
  if (input.detail) return `图片生成没有完成：${input.detail}。${CONTINUE}`
  if (input.httpStatus && /^\d{3}$/.test(input.httpStatus)) {
    return `图片生成失败（HTTP ${input.httpStatus}）。${CONTINUE}`
  }
  return `图片生成没有完成。${CONTINUE}`
}

/** Pull a short, non-secret reason off the completed item. */
export function imageFailureDetail(item: Record<string, unknown>): string | undefined {
  for (const candidate of [item.error, item.failure]) {
    const text = detailText(candidate)
    if (text) return text
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

function detailText(value: unknown): string | undefined {
  if (typeof value === 'string') return safeDetail(value)
  if (value && typeof value === 'object') {
    const message = (value as { message?: unknown }).message
    if (typeof message === 'string') return safeDetail(message)
  }
  return undefined
}

function safeDetail(raw: string): string | undefined {
  const text = raw.replace(/\s+/g, ' ').trim()
  if (text.length < 1 || text.length > 120) return undefined
  if (/bearer\s+|sk-[a-z0-9]|api[_-]?key|eyJ[a-z0-9]/i.test(text)) return undefined
  if (/[A-Za-z0-9+/]{40,}={0,2}/.test(text)) return undefined
  return text
}
