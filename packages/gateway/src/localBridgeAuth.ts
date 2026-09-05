import { timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import { isIPv4 } from 'node:net'

/** Header mux injects on loopback HTTP/WS. Node lower-cases incoming names. */
export const LOCAL_BRIDGE_HEADER = 'x-openclaude-local-bridge'

/** Env the desktop Host sets for this gateway process. Unset on cloud containers. */
export const LOCAL_BRIDGE_TOKEN_ENV = 'OPENCLAUDE_LOCAL_BRIDGE_TOKEN'

const TOKEN_RE = /^[0-9a-f]{64}$/i
const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

export type LocalBridgeRequest = {
  socket?: { remoteAddress?: string | null }
  headers: IncomingHttpHeaders
}

export function isLoopbackRemoteAddress(addr: string | undefined | null): boolean {
  if (!addr) return false
  const trimmed = addr.trim()
  if (LOOPBACK_ADDRS.has(trimmed)) return true
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return LOOPBACK_ADDRS.has(trimmed.slice(1, -1))
  }
  return false
}

function headerValue(headers: IncomingHttpHeaders, name: string): string {
  const raw = headers[name]
  if (Array.isArray(raw)) return String(raw[0] ?? '').trim()
  return String(raw ?? '').trim()
}

/**
 * New desktop local-bridge branch. Independent of TRUST_BRIDGE / checkBridgeBypass.
 *
 * Allow only when ALL hold:
 *   1. OPENCLAUDE_LOCAL_BRIDGE_TOKEN is set and is 64 hex
 *   2. source address is loopback
 *   3. X-OpenClaude-Local-Bridge matches the env token (timing-safe)
 *
 * Env unset or any check failing → false (caller continues the original auth chain).
 * Never reads OPENCLAUDE_TRUST_BRIDGE_IP.
 */
export function checkLocalBridge(
  req: LocalBridgeRequest,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const expected = (env[LOCAL_BRIDGE_TOKEN_ENV] ?? '').trim()
  if (!expected) return false
  if (!TOKEN_RE.test(expected)) return false
  if (!isLoopbackRemoteAddress(req.socket?.remoteAddress || '')) return false
  const hdr = headerValue(req.headers, LOCAL_BRIDGE_HEADER)
  if (!TOKEN_RE.test(hdr)) return false
  if (hdr.length !== expected.length) return false
  try {
    return timingSafeEqual(Buffer.from(hdr, 'hex'), Buffer.from(expected, 'hex'))
  } catch {
    return false
  }
}

/**
 * Existing healthz file-proxy-v1 predicate, extracted so tests can pin W4:
 * local-bridge token must not advertise file-proxy-v1. Unchanged from the
 * TRUST_BRIDGE_IP + OC_CONTAINER_ID + OC_BRIDGE_NONCE three-pack check.
 */
export function isHealthzFileProxyReady(env: NodeJS.ProcessEnv = process.env): boolean {
  const trustBridgeIp = env.OPENCLAUDE_TRUST_BRIDGE_IP || ''
  const containerId = env.OC_CONTAINER_ID || ''
  const bridgeNonce = env.OC_BRIDGE_NONCE || ''
  return (
    isIPv4(trustBridgeIp) &&
    /^[1-9][0-9]{0,18}$/.test(containerId) &&
    /^[0-9a-f]{64}$/i.test(bridgeNonce)
  )
}
