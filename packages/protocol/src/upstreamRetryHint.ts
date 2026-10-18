/** Internal error-only protocol. Never include this marker in model input. */
const PREFIX = 'OC_RETRY_HINT_V1:'
export interface UpstreamRetryHint {
  readonly status: 429
  readonly retryNotBeforeMs: number
}

export function encodeUpstreamRetryHint(retryNotBeforeMs: number): string | undefined {
  if (!Number.isSafeInteger(retryNotBeforeMs) || retryNotBeforeMs < 0) return undefined
  return `${PREFIX}${btoa(JSON.stringify({ status: 429, retryNotBeforeMs }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
}

/** Call only with an error terminal's diagnostics, never assistant/user content. */
export function decodeUpstreamRetryHint(diagnostic: string): Readonly<UpstreamRetryHint> | undefined {
  const matches = [...diagnostic.matchAll(/OC_RETRY_HINT_V1:([A-Za-z0-9_-]{1,256})(?![A-Za-z0-9_-])/g)]
  const encoded = new Set(matches.map(match => match[1]!))
  if (encoded.size !== 1) return undefined
  try {
    const raw = [...encoded][0]!.replace(/-/g, '+').replace(/_/g, '/')
    const value: unknown = JSON.parse(atob(raw))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const hint = value as Record<string, unknown>
    if (Object.keys(hint).sort().join(',') !== 'retryNotBeforeMs,status' || hint.status !== 429 ||
        typeof hint.retryNotBeforeMs !== 'number' || !Number.isSafeInteger(hint.retryNotBeforeMs) || hint.retryNotBeforeMs < 0) return undefined
    return Object.freeze({ status: 429, retryNotBeforeMs: hint.retryNotBeforeMs })
  } catch {
    return undefined
  }
}
