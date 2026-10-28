/**
 * JSON form of the previous-context block injected when a session switches
 * runner/provider or cannot be natively resumed. One format source for
 * sessionManager (which selects the suffix against the runner's
 * maxPromptBytes) and for engines whose launch envelope adds bytes that
 * selection cannot see: Antigravity wraps the prompt in its platform context
 * and a JSON-encoded stdin line, so a history block that fits 300 KiB on its
 * own reached 371964 bytes on the wire and the turn was refused outright.
 */

const OPEN = '<openclaude_previous_context_json>'
const NOTE =
  'The current OpenClaude session was previously served by a different runner/provider or cannot be natively resumed. The next line is JSON. Use it as prior conversation context and do not restate it unless needed.'
const CLOSE = '</openclaude_previous_context_json>'
const CURRENT_OPEN = '<current_user_message_json>'
const CURRENT_CLOSE = '</current_user_message_json>'

export interface HistoricalContextEntry {
  role: string
  text: string
}

const jsonLine = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c')

export function renderHistoricalContextJsonPrompt(
  transcript: readonly HistoricalContextEntry[],
  currentUserText: string,
): string {
  return [
    OPEN,
    NOTE,
    jsonLine(transcript),
    CLOSE,
    '',
    CURRENT_OPEN,
    jsonLine(currentUserText),
    CURRENT_CLOSE,
  ].join('\n')
}

export interface FittedHistoricalContext {
  prompt: string
  /** Oldest entries dropped to fit; 0 when the prompt already fit. */
  dropped: number
}

/**
 * Keeps the longest suffix of the history whose rendered prompt `fits`.
 * A prompt that is not a JSON history block comes back unchanged. When no
 * entry fits, the current message is sent alone (the same shape
 * sessionManager sends when it selects no history). Null when even that
 * does not fit.
 */
export function fitHistoricalContextJsonPrompt(
  prompt: string,
  fits: (candidate: string) => boolean,
): FittedHistoricalContext | null {
  if (fits(prompt)) return { prompt, dropped: 0 }
  const lines = prompt.split('\n')
  if (
    lines.length < 8 ||
    lines[0] !== OPEN ||
    lines[1] !== NOTE ||
    lines[3] !== CLOSE ||
    lines[4] !== '' ||
    lines[5] !== CURRENT_OPEN ||
    lines[7] !== CURRENT_CLOSE
  ) {
    return null
  }
  let transcript: HistoricalContextEntry[]
  let currentUserText: string
  try {
    transcript = JSON.parse(lines[2]!) as HistoricalContextEntry[]
    currentUserText = JSON.parse(lines[6]!) as string
  } catch {
    return null
  }
  if (!Array.isArray(transcript) || typeof currentUserText !== 'string') return null
  // Multimodal inputs prepend history as a text block. Text-only adapters
  // concatenate the remaining current blocks after it; keep that exact tail
  // while fitting history against their final transport envelope.
  const tail = prompt.slice(lines.slice(0, 8).join('\n').length)
  const render = (start: number): string =>
    (start >= transcript.length
      ? currentUserText
      : renderHistoricalContextJsonPrompt(transcript.slice(start), currentUserText)) + tail
  // Fewer entries never render larger, so the smallest fitting start is the
  // longest fitting suffix. start=0 is already known not to fit.
  let lo = 1
  let hi = transcript.length
  if (!fits(render(hi))) return null
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (fits(render(mid))) hi = mid
    else lo = mid + 1
  }
  return { prompt: render(lo), dropped: lo }
}
