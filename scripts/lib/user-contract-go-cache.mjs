// OCV5-432: pure policy for the selfhost release's OpenCode Go prompt-cache check.
// Importing this module never opens a socket or reads secrets.
export const GO_CACHE_MODEL = 'opencode-gpt-6-luna'
export const GO_CACHE_TURNS = 3
// Each later turn re-sends the earlier prompt, so with a working cache roughly (n-1)/n of the
// prompt tokens are cache reads (3 turns ≈ 0.67). The OCV5-432 defect read exactly 0. 0.3
// still passes when the upstream evicts one entry, never when the prefix is unstable.
export const GO_CACHE_MIN_RATIO = 0.3

export function parseGoCacheModel(value = GO_CACHE_MODEL) {
  if (!/^[a-z0-9][a-z0-9._-]{1,80}$/.test(value)) throw new Error('Invalid go-cache contract model')
  return value
}

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
