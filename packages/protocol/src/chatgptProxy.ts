/**
 * ChatGPT direct-connect proxy: shared host allowlist + PAC generation.
 *
 * The commercial master exposes an authenticated TLS CONNECT proxy that only
 * relays to the hosts below, chained into the platform subscription egress.
 * This module is browser-safe (web-react renders the same domain list in the
 * setup guide) and has no Node dependencies.
 */

/** Root domains (exact or any subdomain) the proxy is allowed to CONNECT to. */
export const CHATGPT_PROXY_DOMAIN_ROOTS: readonly string[] = [
  // ChatGPT itself
  'chatgpt.com',
  'openai.com',
  'oaistatic.com',
  'oaiusercontent.com',
  // Login providers and bot challenges the ChatGPT sign-in flow depends on
  'auth0.com',
  'accounts.google.com',
  'apis.google.com',
  'gstatic.com',
  'appleid.apple.com',
  'login.microsoftonline.com',
  'login.live.com',
  'challenges.cloudflare.com',
]

export const CHATGPT_PROXY_PAC_PATH = '/pac'
export const CHATGPT_PROXY_HOME_URL = 'https://chatgpt.com/'
export const CHATGPT_PROXY_USERNAME_PREFIX = 'u'
/** Only HTTPS origins may be tunneled; plain HTTP would leak session cookies. */
export const CHATGPT_PROXY_ALLOWED_PORT = 443

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/

/** Lower-case, strip trailing dot and IPv6 brackets. Returns null for garbage. */
export function canonicalizeChatGptProxyHost(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 253) return null
  let host = raw.trim().toLowerCase()
  if (host.endsWith('.')) host = host.slice(0, -1)
  if (!HOSTNAME_RE.test(host)) return null
  return host
}

export function isChatGptProxyAllowedHost(raw: string): boolean {
  const host = canonicalizeChatGptProxyHost(raw)
  if (!host) return false
  return CHATGPT_PROXY_DOMAIN_ROOTS.some((root) => host === root || host.endsWith(`.${root}`))
}

/** Parse the `host:port` authority of a CONNECT request line. */
export function parseChatGptProxyConnectTarget(
  authority: string,
): { host: string; port: number } | null {
  if (typeof authority !== 'string' || authority.length > 300) return null
  const idx = authority.lastIndexOf(':')
  if (idx <= 0) return null
  const host = canonicalizeChatGptProxyHost(authority.slice(0, idx))
  const port = Number(authority.slice(idx + 1))
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) return null
  return { host, port }
}

export function chatGptProxyUsername(uid: number | string | bigint): string {
  return `${CHATGPT_PROXY_USERNAME_PREFIX}${String(uid)}`
}

/** Inverse of chatGptProxyUsername; null unless `u<positive integer>`. */
export function parseChatGptProxyUsername(username: string): number | null {
  if (typeof username !== 'string' || username.length < 2 || username.length > 24) return null
  if (!username.startsWith(CHATGPT_PROXY_USERNAME_PREFIX)) return null
  const digits = username.slice(CHATGPT_PROXY_USERNAME_PREFIX.length)
  if (!/^[1-9][0-9]{0,18}$/.test(digits)) return null
  const uid = Number(digits)
  return Number.isSafeInteger(uid) ? uid : null
}

function assertPacHost(host: string): void {
  if (!canonicalizeChatGptProxyHost(host)) throw new Error('invalid PAC proxy host')
}

/**
 * Build a PAC script routing only the allowlisted domains through the
 * authenticated proxy; everything else stays DIRECT so the user's normal
 * browsing never touches the platform.
 */
export function buildChatGptPac(proxyHost: string, proxyPort: number): string {
  assertPacHost(proxyHost)
  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65_535)
    throw new Error('invalid PAC proxy port')
  const checks = CHATGPT_PROXY_DOMAIN_ROOTS.map(
    (root) => `    dnsDomainIs(h, ".${root}") || h === "${root}"`,
  ).join(' ||\n')
  return [
    '// OpenClaude ChatGPT direct-connect PAC',
    'function FindProxyForURL(url, host) {',
    '  var h = host.toLowerCase();',
    '  if (',
    checks,
    '  ) {',
    `    return "HTTPS ${proxyHost}:${proxyPort}";`,
    '  }',
    '  return "DIRECT";',
    '}',
    '',
  ].join('\n')
}
