/**
 * Shared helpers for the global / per-agent egress proxy plumbing introduced
 * with the front-end proxy configuration feature.
 *
 * Why this module exists:
 *   - `sessionManager` computes the effective proxy URL when it spawns a new
 *     runner (per-agent override → global config fallback).
 *   - `server` validates `PUT /api/config` and `PUT /api/agents/:id` bodies
 *     before they hit disk — rejecting redacted/masked values that would
 *     otherwise overwrite real credentials.
 *   - `subprocessRunner` (CCB) and `terminalBackend` (Docker passthrough)
 *     share the same env-key list so the env-injection invariants stay
 *     identical across runners.
 *
 * The four PROXY env keys are the cross-runtime intersection of what Node
 * (undici / fetch), Rust (reqwest), and miscellaneous CLI tools honour. ALL_PROXY
 * and NO_PROXY are deliberately left untouched for CCB — historical CCB
 * behaviour inherits whatever the gateway process env carries, including any
 * carve-outs the operator wants to keep.
 */

/**
 * Normalize a configured proxy URL coming from disk (yaml/json) or HTTP body.
 *
 * Empty string, whitespace-only string, and undefined all collapse to
 * `undefined`. Non-empty strings are returned trimmed. This makes the
 * fallback chain `agent.proxyUrl ?? config.proxyUrl` work intuitively even
 * when one layer was "cleared" by the UI (empty string instead of removed
 * key).
 */
export function normalizeProxyUrl(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim()
  return trimmed ? trimmed : undefined
}

/** Env keys we explicitly set when a proxy is configured. Both cases for
 *  cross-runtime compatibility (Rust reqwest honours lowercase, Node honours
 *  either). Lower/upper kept as siblings rather than aliased so any code that
 *  enumerates env can see both. */
export const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'] as const

/**
 * Mask `user:pass@` in a proxy URL for display / API GET responses. Keeps
 * scheme + host + port + path visible so the operator can verify which proxy
 * is configured without exposing the credential.
 *
 * Returns the original string when it doesn't carry credentials (so plain
 * `http://proxy:8080` URLs pass through unchanged), and a generic `***`
 * sentinel when the URL is malformed (we can't safely classify what's
 * sensitive in garbage input).
 */
export function maskProxyUrl(url: string | undefined): string | undefined {
  if (!url) return url
  try {
    const u = new URL(url)
    if (!u.username && !u.password) return url
    u.username = '***'
    if (u.password) u.password = '***'
    return u.toString()
  } catch {
    return '***'
  }
}

/**
 * Detect whether a value submitted via API was actually a redacted display
 * string — defends against the round-trip GET → render → PUT pattern
 * accidentally overwriting real credentials with `***`.
 *
 * Conservative rule: any `*` in the value flags it. Side effect: a real
 * password containing `*` would be rejected too. Acceptable trade-off since
 * the user can always pick a star-free password (and this matches the
 * "explicit safety over convenience" stance of the redaction logic above).
 */
export function looksRedactedProxyUrl(value: string): boolean {
  return value.includes('*')
}
