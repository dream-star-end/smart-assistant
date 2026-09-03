/**
 * Cursor account-session credential helpers shared by the commercial PKCE
 * login flow (`/auth/poll`) and the gateway Sand relay.
 *
 * A Cursor *session* accessToken (from `loginDeepControl` PKCE, the same
 * flow the Grok Bot uses) is presented as a plain Bearer on the Sand
 * inference plane together with an `x-cursor-checksum` header. The checksum
 * is not a secret: it is a time bucket obfuscated with a rolling XOR and
 * suffixed with the persisted machine id. The machine id MUST be stable per
 * credential row; regenerating it per request trips Cursor's
 * "Too many computers" guard.
 */

/** Lowercase alphanumeric, 16–64 chars (the sand CLI generates 26). */
export const CURSOR_MACHINE_ID_PATTERN = /^[a-z0-9]{16,64}$/

/** Three base64url segments — the loose shape of a Cursor session JWT. */
export const CURSOR_SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/

/** Client version the sand CLI reports while polling; used for both
 * `/auth/poll` and InferenceService when a session credential is in play. */
export const CURSOR_SESSION_CLIENT_VERSION = '0.24.0'

export function isCursorMachineId(value: unknown): value is string {
  return typeof value === 'string' && CURSOR_MACHINE_ID_PATTERN.test(value)
}

/**
 * `x-cursor-checksum` for a given machine id.
 *
 * Algorithm (ported from the sand CLI):
 *   n = floor(nowMs / 1_000_000) → 6 bytes big-endian
 *   for i, b in bytes: b = ((b ^ rolling) + i) & 0xff; rolling = b   (rolling seed 165)
 *   base64url(bytes) without padding, then append machineId.
 */
export function cursorSessionChecksum(machineId: string, nowMs: number = Date.now()): string {
  if (!isCursorMachineId(machineId)) throw new RangeError('invalid_cursor_machine_id')
  if (!Number.isFinite(nowMs) || nowMs < 0) throw new RangeError('invalid_cursor_checksum_clock')
  const n = Math.floor(nowMs / 1_000_000)
  const raw = new Uint8Array(6)
  // Six bytes big-endian; n fits well within 2^48 for any realistic clock.
  let remaining = n
  for (let index = 5; index >= 0; index -= 1) {
    raw[index] = remaining % 256
    remaining = Math.floor(remaining / 256)
  }
  let rolling = 165
  for (let index = 0; index < raw.length; index += 1) {
    const value = (((raw[index] as number) ^ rolling) + index) & 255
    rolling = value
    raw[index] = value
  }
  const encoded = base64UrlNoPad(raw)
  return `${encoded}${machineId}`
}

function base64UrlNoPad(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number
    const b1 = i + 1 < bytes.length ? (bytes[i + 1] as number) : 0
    const b2 = i + 2 < bytes.length ? (bytes[i + 2] as number) : 0
    const triple = (b0 << 16) | (b1 << 8) | b2
    out += alphabet[(triple >> 18) & 63]
    out += alphabet[(triple >> 12) & 63]
    if (i + 1 < bytes.length) out += alphabet[(triple >> 6) & 63]
    if (i + 2 < bytes.length) out += alphabet[triple & 63]
  }
  return out
}

/** Decode the `exp` claim of a Cursor session JWT (ms epoch), or null. */
export function cursorSessionTokenExpiryMs(token: string): number | null {
  if (!CURSOR_SESSION_TOKEN_PATTERN.test(token)) return null
  const part = token.split('.')[1]
  if (!part) return null
  try {
    const json = JSON.parse(base64UrlDecodeUtf8(part)) as { exp?: unknown }
    if (typeof json.exp !== 'number' || !Number.isFinite(json.exp) || json.exp <= 0) return null
    return json.exp * 1000
  } catch {
    return null
  }
}

function base64UrlDecodeUtf8(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  if (typeof atob === 'function') {
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return new TextDecoder().decode(bytes)
  }
  // Node without global atob (very old runtimes) — Buffer is available there.
  return (globalThis as unknown as { Buffer: { from(s: string, e: string): { toString(e: string): string } } })
    .Buffer.from(padded, 'base64').toString('utf8')
}
