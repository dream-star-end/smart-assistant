// OCV5-432: pure policy for the selfhost release's OpenCode Go prompt-cache check.
// Importing this module never opens a socket or reads secrets.
// OCV5-527: Go Luna is retired as a duplicate of Codex Luna. Keep the proof on a retained
// model using the same Responses bridge. Fixed on purpose; no model override.
export const GO_CACHE_MODEL = 'muse-spark-1.3-go'
export const GO_CACHE_TURNS = 3
// Each later turn re-sends the earlier prompt, so with a working cache roughly (n-1)/n of the
// prompt tokens are cache reads (3 turns ≈ 0.67). Before OCV5-432, Muse read only part
// of the unstable prefix (0.319 in real usage), so the former Luna threshold 0.3 would
// wrongly pass. Require 0.5 for Muse; one full cache eviction now fails this check.
export const GO_CACHE_MIN_RATIO = 0.5

export function goCachePrompts(nonce) {
  if (!/^[a-f0-9]{8,32}$/.test(nonce)) throw new Error('Invalid go-cache nonce')
  return Array.from(
    { length: GO_CACHE_TURNS },
    (_, i) => `G432-${nonce}-${i + 1} 不要使用任何工具，只回答数字 ${i + 1}。`,
  )
}

/** Verdict on the session's usage row from GET /api/me/usage (sessions.items[]). */
export function assessGoCache(row, { turns = GO_CACHE_TURNS, minRatio = GO_CACHE_MIN_RATIO } = {}) {
  if (!row) return { ok: false, reason: 'no usage row for the contract session' }
  const n = (v) => Number(v ?? 0)
  const requests = n(row.requests)
  const input = n(row.input_tokens)
  const read = n(row.cache_read_tokens)
  const write = n(row.cache_write_tokens)
  const prompt = input + read + write
  const ratio = prompt > 0 ? read / prompt : 0
  const facts = { requests, input, read, write, prompt, ratio: Math.round(ratio * 1000) / 1000 }
  if (![requests, input, read, write].every(Number.isFinite))
    return { ok: false, reason: 'usage row is not numeric', ...facts }
  if (requests < turns)
    return { ok: false, reason: `expected ≥${turns} billed requests, got ${requests}`, ...facts }
  if (ratio < minRatio)
    return { ok: false, reason: `cache read ratio ${facts.ratio} < ${minRatio}`, ...facts }
  return { ok: true, reason: 'cache hit', ...facts }
}
