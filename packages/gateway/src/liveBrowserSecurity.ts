/**
 * Security & takeover-lease primitives for the container-local live cloud browser (OCV5-857).
 *
 * Responsibilities:
 * 1. SSRF URL validation (`validateLiveBrowserUrl` + async DNS check `assertLiveBrowserUrlPublic`):
 *    blocks loopback, link-local / cloud metadata, RFC1918, ULA, and DNS records resolving to
 *    non-public IPs. Local container web servers belong strictly to `containerPreview`.
 * 2. Explicit human takeover lease (`$stateDir/human-takeover.json`): atomic file lease with TTL
 *    and token ownership checks so `oc-browser.sh` blocks concurrent agent commands while a human
 *    is interacting, and stale sockets can never release a newer session's lease.
 */
import { randomBytes } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns/promises'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const LIVE_BROWSER_MAX_URL_CHARS = 2048
export const DEFAULT_HUMAN_TAKEOVER_TTL_MS = 90_000
const DNS_CHECK_TIMEOUT_MS = 2_500

export class LiveBrowserError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'LiveBrowserError'
    this.status = status
    this.code = code
  }
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'host.docker.internal',
  'gateway.docker.internal',
])

const BLOCKED_HOSTNAME_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa']

function stripBracketsAndDot(hostname: string): string {
  let host = hostname.trim().toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1)
  }
  while (host.endsWith('.')) {
    host = host.slice(0, -1)
  }
  return host
}

function parseIpv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  const nums: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (!Number.isInteger(n) || n < 0 || n > 255) return null
    nums.push(n)
  }
  return [nums[0]!, nums[1]!, nums[2]!, nums[3]!]
}

function isPrivateIpv4Tuple(a: number, b: number, c: number, _d: number): boolean {
  if (a === 0) return true // 0.0.0.0/8 unspecified
  if (a === 10) return true // 10.0.0.0/8 RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT
  if (a === 127) return true // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true // 169.254.0.0/16 link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12 RFC1918 / Docker bridge
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true // IETF protocol / TEST-NET-1
  if (a === 192 && b === 168) return true // 192.168.0.0/16 RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true // 198.18.0.0/15 benchmark
  if (a === 198 && b === 51 && c === 100) return true // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true // TEST-NET-3
  if (a >= 224) return true // multicast + reserved + broadcast
  return false
}

function parseIpv6Bytes(ip: string): number[] | null {
  let raw = stripBracketsAndDot(ip)
  const zoneIdx = raw.indexOf('%')
  if (zoneIdx >= 0) raw = raw.slice(0, zoneIdx)
  if (!raw || !raw.includes(':')) return null

  if (raw.includes('.')) {
    const lastColon = raw.lastIndexOf(':')
    if (lastColon < 0) return null
    const v4 = parseIpv4(raw.slice(lastColon + 1))
    if (!v4) return null
    const hi = ((v4[0] << 8) | v4[1]).toString(16)
    const lo = ((v4[2] << 8) | v4[3]).toString(16)
    raw = `${raw.slice(0, lastColon)}:${hi}:${lo}`
  }

  const halves = raw.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const explicitCount = left.length + right.length
  const missing = halves.length === 2 ? 8 - explicitCount : 0
  if (missing < 0 || (halves.length === 1 && explicitCount !== 8)) return null

  const hextets: number[] = []
  const pushPart = (part: string): boolean => {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return false
    hextets.push(Number.parseInt(part, 16))
    return true
  }
  for (const part of left) {
    if (!pushPart(part)) return null
  }
  for (let i = 0; i < missing; i += 1) hextets.push(0)
  for (const part of right) {
    if (!pushPart(part)) return null
  }
  if (hextets.length !== 8) return null

  const bytes: number[] = []
  for (const h of hextets) {
    bytes.push((h >> 8) & 0xff, h & 0xff)
  }
  return bytes
}

export function isIpLiteral(hostname: string): boolean {
  const clean = stripBracketsAndDot(hostname)
  return parseIpv4(clean) !== null || parseIpv6Bytes(clean) !== null
}

export function isPrivateOrReservedIp(ip: string): boolean {
  const clean = stripBracketsAndDot(ip)
  const v4 = parseIpv4(clean)
  if (v4) return isPrivateIpv4Tuple(v4[0], v4[1], v4[2], v4[3])

  const bytes = parseIpv6Bytes(clean)
  if (!bytes) return false

  // :: (unspecified) and ::1 (loopback)
  const first12Zero = bytes.slice(0, 12).every((b) => b === 0)
  if (first12Zero) {
    const tail = bytes.slice(12)
    if (tail[0] === 0 && tail[1] === 0 && tail[2] === 0 && (tail[3] === 0 || tail[3] === 1)) {
      return true
    }
    // Deprecated IPv4-compatible IPv6 ::a.b.c.d
    return isPrivateIpv4Tuple(tail[0]!, tail[1]!, tail[2]!, tail[3]!)
  }

  // IPv4-mapped IPv6 ::ffff:0:0/96
  const isV4Mapped =
    bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff
  if (isV4Mapped) {
    return isPrivateIpv4Tuple(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!)
  }

  // NAT64 well-known prefix 64:ff9b::/96
  const isNat64 =
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((b) => b === 0)
  if (isNat64) {
    return isPrivateIpv4Tuple(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!)
  }

  // Unique local fc00::/7
  if ((bytes[0]! & 0xfe) === 0xfc) return true
  // Link-local fe80::/10
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true
  // Site-local deprecated fec0::/10
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0xc0) return true
  // Multicast ff00::/8
  if (bytes[0] === 0xff) return true
  // Documentation 2001:db8::/32
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) {
    return true
  }

  return false
}

export interface LiveBrowserUrlValidationOptions {
  allowHosts?: readonly string[]
  lookup?: typeof dnsLookup
}

function isExplicitlyAllowedHost(host: string, allowHosts?: readonly string[]): boolean {
  if (!allowHosts?.length) return false
  return allowHosts.some((entry) => stripBracketsAndDot(entry) === host)
}

/**
 * Synchronous URL validation for the live cloud browser.
 * Only permits public `http:` / `https:` targets; rejects localhost, link-local,
 * RFC1918, ULA, and embedded credentials with structured error code `UNSAFE_URL`.
 */
export function validateLiveBrowserUrl(
  raw: unknown,
  opts?: Pick<LiveBrowserUrlValidationOptions, 'allowHosts'>,
): string {
  if (typeof raw !== 'string') {
    throw new LiveBrowserError(400, 'INVALID_URL', '请输入有效的 http 或 https 网址')
  }
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > LIVE_BROWSER_MAX_URL_CHARS || /[\r\n\0]/.test(trimmed)) {
    throw new LiveBrowserError(400, 'INVALID_URL', '网址格式无效或长度超限')
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new LiveBrowserError(400, 'INVALID_URL', '无法解析该网址，请包含 http:// 或 https://')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new LiveBrowserError(
      400,
      'UNSAFE_URL_PROTOCOL',
      `不支持 ${parsed.protocol} 协议，仅允许 http/https`,
    )
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new LiveBrowserError(400, 'UNSAFE_URL', '网址不允许包含用户名或密码凭据')
  }

  const host = stripBracketsAndDot(parsed.hostname)
  if (!host) {
    throw new LiveBrowserError(400, 'INVALID_URL', '网址缺少有效主机名')
  }

  if (!isExplicitlyAllowedHost(host, opts?.allowHosts)) {
    if (
      BLOCKED_HOSTNAMES.has(host) ||
      BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => host.endsWith(suffix))
    ) {
      throw new LiveBrowserError(
        400,
        'UNSAFE_URL',
        '云端浏览器禁止访问本机或内网域名；访问容器内本地服务请使用「本地预览」',
      )
    }
    if (isIpLiteral(host) && isPrivateOrReservedIp(host)) {
      throw new LiveBrowserError(
        400,
        'UNSAFE_URL',
        '云端浏览器禁止访问本机或内网 IP；访问容器内本地服务请使用「本地预览」',
      )
    }
  }

  return parsed.toString()
}

/**
 * Full async SSRF validation including DNS resolution check to prevent
 * DNS-rebinding / split-horizon hostnames from resolving to private IPs.
 *
 * Strictly fail-closed (P1 #3): ANY DNS failure, timeout, empty record set,
 * or private/reserved IP match rejects with `UNSAFE_URL`.
 */
export async function assertLiveBrowserUrlPublic(
  raw: unknown,
  opts?: LiveBrowserUrlValidationOptions,
): Promise<string> {
  const canonical = validateLiveBrowserUrl(raw, opts)
  const parsed = new URL(canonical)
  const host = stripBracketsAndDot(parsed.hostname)
  if (isExplicitlyAllowedHost(host, opts?.allowHosts) || isIpLiteral(host)) {
    return canonical
  }

  // R2 #3: always perform fresh DNS verification (no positive host cache window).
  const resolver = opts?.lookup ?? dnsLookup
  let records: Array<{ address: string }>
  try {
    records = await new Promise<Array<{ address: string }>>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(Object.assign(new Error('dns timeout'), { code: 'ETIMEDOUT' }))
      }, DNS_CHECK_TIMEOUT_MS)
      resolver(host, { all: true, verbatim: true }).then(
        (res) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(Array.isArray(res) ? res : [res])
        },
        (err) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(err)
        },
      )
    })
  } catch {
    throw new LiveBrowserError(400, 'UNSAFE_URL', '无法安全解析目标域名或 DNS 校验超时，已拦截访问')
  }

  if (!Array.isArray(records) || records.length === 0) {
    throw new LiveBrowserError(400, 'UNSAFE_URL', '目标域名无有效公网解析记录，已拦截访问')
  }
  for (const record of records) {
    if (!record?.address || isPrivateOrReservedIp(record.address)) {
      throw new LiveBrowserError(
        400,
        'UNSAFE_URL',
        '目标域名解析到本机或内网地址，已拦截访问',
      )
    }
  }

  return canonical
}

// ---------------------------------------------------------------------------
// Explicit Human Takeover Lease (`$stateDir/human-takeover.json`)
// ---------------------------------------------------------------------------

export interface HumanTakeoverLease {
  readonly token: string
  readonly acquiredAt: number
  readonly expiresAt: number
  readonly updatedAt: number
}

export function humanTakeoverLeasePath(stateDir: string): string {
  return join(stateDir, 'human-takeover.json')
}

export function readActiveHumanTakeoverLease(
  stateDir: string,
  now: number = Date.now(),
): HumanTakeoverLease | null {
  const leasePath = humanTakeoverLeasePath(stateDir)
  if (!existsSync(leasePath)) return null
  try {
    const raw = JSON.parse(readFileSync(leasePath, 'utf8')) as Partial<HumanTakeoverLease>
    if (
      typeof raw.token !== 'string' ||
      raw.token.length < 1 ||
      typeof raw.acquiredAt !== 'number' ||
      typeof raw.expiresAt !== 'number' ||
      typeof raw.updatedAt !== 'number' ||
      !Number.isFinite(raw.expiresAt)
    ) {
      return null
    }
    if (raw.expiresAt <= now) return null
    return {
      token: raw.token,
      acquiredAt: raw.acquiredAt,
      expiresAt: raw.expiresAt,
      updatedAt: raw.updatedAt,
    }
  } catch {
    return null
  }
}

function writeLeaseAtomic(stateDir: string, lease: HumanTakeoverLease): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const leasePath = humanTakeoverLeasePath(stateDir)
  const tmpPath = join(
    stateDir,
    `.human-takeover.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  )
  writeFileSync(tmpPath, `${JSON.stringify(lease)}\n`, { mode: 0o600 })
  renameSync(tmpPath, leasePath)
}

export function acquireHumanTakeoverLease(
  stateDir: string,
  opts?: { token?: string; ttlMs?: number; now?: number },
): HumanTakeoverLease {
  const now = opts?.now ?? Date.now()
  const ttlMs = Math.max(5_000, Math.min(300_000, opts?.ttlMs ?? DEFAULT_HUMAN_TAKEOVER_TTL_MS))
  const existing = readActiveHumanTakeoverLease(stateDir, now)
  // R2 #5: strictly mutually exclusive — never overwrite another holder's active lease.
  if (existing && (!opts?.token || existing.token !== opts.token)) {
    throw new LiveBrowserError(
      409,
      'TAKEOVER_ALREADY_HELD',
      '当前已由其他连接独占接管，请先结束其他标签页的接管',
    )
  }
  const token = opts?.token || randomBytes(16).toString('hex')
  const acquiredAt = existing && existing.token === token ? existing.acquiredAt : now
  const lease: HumanTakeoverLease = {
    token,
    acquiredAt,
    updatedAt: now,
    expiresAt: now + ttlMs,
  }
  writeLeaseAtomic(stateDir, lease)
  return lease
}

export function renewHumanTakeoverLease(
  stateDir: string,
  token: string,
  opts?: { ttlMs?: number; now?: number },
): HumanTakeoverLease | null {
  if (!token) return null
  const now = opts?.now ?? Date.now()
  const ttlMs = Math.max(5_000, Math.min(300_000, opts?.ttlMs ?? DEFAULT_HUMAN_TAKEOVER_TTL_MS))
  const existing = readActiveHumanTakeoverLease(stateDir, now)
  if (existing && existing.token !== token) {
    return null
  }
  const lease: HumanTakeoverLease = {
    token,
    acquiredAt: existing?.acquiredAt ?? now,
    updatedAt: now,
    expiresAt: now + ttlMs,
  }
  writeLeaseAtomic(stateDir, lease)
  return lease
}

export function releaseHumanTakeoverLease(
  stateDir: string,
  token?: string,
  now: number = Date.now(),
): boolean {
  const leasePath = humanTakeoverLeasePath(stateDir)
  if (!existsSync(leasePath)) return false
  const existing = readActiveHumanTakeoverLease(stateDir, now)
  // P1 #5: an active lease can ONLY be released by its owning token; missing or mismatched
  // token must never clobber another live connection's lease.
  if (existing && (!token || existing.token !== token)) {
    return false
  }
  try {
    unlinkSync(leasePath)
    return true
  } catch {
    return false
  }
}
