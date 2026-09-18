/**
 * Public hostname / port knobs for desktop bootstrap + origin SAN.
 * Master-facing env only (not injected into user containers).
 */

import net from 'node:net'

const DNS_HOST_RE = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$/

function parsePort(raw: string | undefined, fallback: number): number {
  const n = Number(raw ?? '')
  if (Number.isInteger(n) && n > 0 && n <= 65535) return n
  return fallback
}

/** Validated OC_DESKTOP_PUBLIC_HOST, or null if unset/invalid. Never returns localhost-as-default. */
export function readDesktopPublicHost(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.OC_DESKTOP_PUBLIC_HOST?.trim() ?? ''
  if (!raw) return null
  if (net.isIP(raw)) return raw
  if (raw.includes('/') || raw.includes(':') || raw.includes(' ')) return null
  if (!DNS_HOST_RE.test(raw)) return null
  return raw
}

export function isIpLiteral(host: string): boolean {
  return net.isIP(host) !== 0
}

export function formatDesktopHostForUrl(host: string): string {
  return net.isIP(host) === 6 ? `[${host}]` : host
}

/** Bind port (OC_DESKTOP_TLS_PORT, default 18445) unless OC_DESKTOP_PUBLIC_TLS_PORT overrides. */
export function readDesktopPublicTlsPort(env: NodeJS.ProcessEnv = process.env): number {
  return parsePort(env.OC_DESKTOP_PUBLIC_TLS_PORT, parsePort(env.OC_DESKTOP_TLS_PORT, 18445))
}

/** Bind port (OC_DESKTOP_EGRESS_TLS_PORT, default 18446) unless OC_DESKTOP_PUBLIC_EGRESS_PORT overrides. */
export function readDesktopPublicEgressPort(env: NodeJS.ProcessEnv = process.env): number {
  return parsePort(
    env.OC_DESKTOP_PUBLIC_EGRESS_PORT,
    parsePort(env.OC_DESKTOP_EGRESS_TLS_PORT, 18446),
  )
}

export function readDesktopMinAppVersion(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.OC_DESKTOP_MIN_APP_VERSION?.trim() ?? ''
  return v || '0.5.0'
}

export function readDesktopRuntimeManifestPath(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const p = env.OC_DESKTOP_RUNTIME_MANIFEST_PATH?.trim() ?? ''
  return p || null
}
