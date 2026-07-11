/**
 * outboundPolicy — 连接器出站 SSRF 防御(设计终稿 §5,P0)。
 *
 * 两类 provider,两套纪律:
 *
 * 1. **固定域 provider(notion / github / feishu)**:目标域名是代码内静态常量白名单
 *    (assertFixedDomainUrl),可走全局 EnvHttpProxyAgent 出海代理或 direct
 *    (目标域可信常量,代理解析 DNS 安全);一律禁 redirect(3xx=报错)。
 *
 * 2. **自由域 provider(webdav / imap / smtp)**:用户可填任意 host → 必须 direct + 全量策略:
 *    - 协议/端口:webdav 仅 https;imap 993 隐式 TLS;smtp 465/587(587 由调用方
 *      requireTLS=true,TLS 升级前不发 AUTH);禁明文、禁 rejectUnauthorized:false。
 *    - URL 形状:禁 userinfo / fragment / IP 字面量;query 一律禁(基址不需要 query,
 *      顺带杜绝 query 里带凭据)。
 *    - DNS:自行解析,**校验全部 A/AAAA 记录只允许 global unicast**(拒 loopback /
 *      RFC1918 / CGN / 链路本地 / ULA / multicast / IPv4-mapped / 169.254 metadata /
 *      平台网段 172.30-31.0.0/16 / 文档段 / 保留段)→ **IP 钉死建连,hostname 只作
 *      SNI / 证书校验**(fetch=undici Agent 自定义 lookup;imapflow/nodemailer=
 *      host=IP + tls.servername —— 二者不走 undici dispatcher)。
 *      钉死 IP = DNS rebinding 免疫:校验与建连用同一个 IP。
 *    - 禁 redirect。明确不支持平台内网私有 WebDAV。
 *
 * 失败一律抛 ConnectorError('OUTBOUND_BLOCKED')/('BAD_REQUEST'),message 只进服务端
 * 日志,不透传给容器/用户。
 */

import { resolve4, resolve6 } from 'node:dns/promises'
import { isIP } from 'node:net'
import { Agent, type Dispatcher, fetch as undiciFetch } from 'undici'
import { ConnectorError } from './errors.js'

// ─── 固定域静态白名单 ─────────────────────────────────────────────────────

/** 固定域 provider 的允许主机(代码常量,不可配置 —— §5)。 */
export const FIXED_DOMAIN_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  notion: ['api.notion.com'],
  github: ['api.github.com'],
  // 飞书 API 域(设计 §9):server 侧只 fetch open.feishu.cn;authorize 页
  // (accounts.feishu.cn)是浏览器侧跳转,不经本策略。
  feishu: ['open.feishu.cn'],
}

/** 校验固定域 URL:https + 主机在该 provider 白名单内。失败抛 OUTBOUND_BLOCKED。 */
export function assertFixedDomainUrl(provider: string, rawUrl: string): URL {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    throw new ConnectorError('OUTBOUND_BLOCKED', `fixed-domain url unparsable (${provider})`)
  }
  if (u.protocol !== 'https:') {
    throw new ConnectorError('OUTBOUND_BLOCKED', `fixed-domain url must be https (${provider})`)
  }
  const allowed = FIXED_DOMAIN_ALLOWLIST[provider]
  if (!allowed || !allowed.includes(u.hostname.toLowerCase())) {
    throw new ConnectorError(
      'OUTBOUND_BLOCKED',
      `host not in static allowlist for provider ${provider}`,
    )
  }
  return u
}

// ─── IP 分类:global unicast 判定 ─────────────────────────────────────────

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const v = Number(p)
    if (v > 255) return null
    n = n * 256 + v
  }
  return n >>> 0
}

function inCidr4(ipInt: number, base: string, bits: number): boolean {
  const baseInt = ipv4ToInt(base)
  if (baseInt === null) return false
  if (bits === 0) return true
  const mask = bits === 32 ? 0xffffffff : ~((1 << (32 - bits)) - 1) >>> 0
  return (ipInt & mask) === (baseInt & mask)
}

/**
 * IPv4 拒绝表(命中任一 → 非 global unicast)。
 * 注:172.30.0.0/16、172.31.0.0/16(平台容器网段)已被 172.16.0.0/12 覆盖,
 * 仍显式列出 —— 平台网段是硬红线,不依赖 RFC1918 条目的存续。
 */
const V4_DENY: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC1918
  ['100.64.0.0', 10], // CGN
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local / cloud metadata
  ['172.16.0.0', 12], // RFC1918
  ['172.30.0.0', 16], // 平台容器网段(显式红线)
  ['172.31.0.0', 16], // 平台容器网段(显式红线)
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // RFC1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
]

export function isGlobalUnicastIpv4(ip: string): boolean {
  // 分类前强制 family(防 v6/垃圾串走 v4 路径)
  if (isIP(ip) !== 4) return false
  const n = ipv4ToInt(ip)
  if (n === null) return false
  for (const [base, bits] of V4_DENY) {
    if (inCidr4(n, base, bits)) return false
  }
  return true
}

function ipv6ToBigInt(ip: string): bigint | null {
  // IPv4 尾巴形式 `...::ffff:1.2.3.4`
  const v4tail = ip.match(/^(.*:)([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)$/)
  let normalized = ip
  if (v4tail) {
    const v4 = ipv4ToInt(v4tail[2] ?? '')
    if (v4 === null) return null
    const hex = v4.toString(16).padStart(8, '0')
    normalized = `${v4tail[1] ?? ''}${hex.slice(0, 4)}:${hex.slice(4)}`
  }
  let parts: string[]
  if (normalized.includes('::')) {
    const [l, r] = normalized.split('::', 2)
    const lp = l ? l.split(':') : []
    const rp = r ? r.split(':') : []
    const missing = 8 - lp.length - rp.length
    if (missing < 0) return null
    parts = [...lp, ...Array(missing).fill('0'), ...rp]
  } else {
    parts = normalized.split(':')
  }
  if (parts.length !== 8) return null
  let n = 0n
  for (const p of parts) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return null
    n = (n << 16n) | BigInt(Number.parseInt(p, 16))
  }
  return n
}

/**
 * IPv6 特殊/不可路由/可编码内网 的拒绝表(全部落在 2000::/3 内的特例;/3 之外的
 * loopback/unspecified/IPv4-mapped/NAT64/ULA/link-local/multicast 由 2000::/3 门天然拒)。
 * P1#10 收紧:6to4(可编码任意 IPv4 含 loopback/RFC1918)、文档段、2001::/23 IETF 协议块
 * (含 Teredo/benchmarking/ORCHID/AS112 等)一律拒绝。
 */
const V6_DENY_CIDR: ReadonlyArray<readonly [string, number]> = [
  ['2001:db8::', 32], // documentation(RFC 3849)
  ['2001::', 23], // IETF protocol assignments(Teredo 2001::/32 / benchmarking / ORCHID / AS112 …)
  ['2002::', 16], // 6to4——可把 loopback/RFC1918 IPv4 编码进 v6 地址
  ['3fff::', 20], // documentation(RFC 9637)
  ['0100::', 64], // discard-only(RFC 6666;也在 /3 之外,冗余显式)
] as const

/** n 是否落在 IPv6 CIDR(base/prefix)内。 */
function inV6Cidr(n: bigint, base: string, prefix: number): boolean {
  const baseInt = ipv6ToBigInt(base)
  if (baseInt === null) return false
  if (prefix <= 0) return true
  const shift = BigInt(128 - prefix)
  return n >> shift === baseInt >> shift
}

/**
 * IPv6 global unicast 判定:**只接受 2000::/3**(当前全球单播分配段),并在其内进一步
 * 剔除 IANA special-purpose / 可编码内网的子段(见 V6_DENY_CIDR)。其余(loopback /
 * unspecified / IPv4-mapped / NAT64 64:ff9b::/96 / ULA fc00::/7 / link-local fe80::/10 /
 * multicast ff00::/8)全部落在 2000::/3 之外,天然被拒。IPv4-mapped/transition 按设计
 * **直接拒绝**(合法目标应发布真 AAAA 或 A 记录)。
 */
export function isGlobalUnicastIpv6(ip: string): boolean {
  // 分类前强制 family(防 v4/垃圾串走 v6 路径)
  if (isIP(ip) !== 6) return false
  const n = ipv6ToBigInt(ip)
  if (n === null) return false
  // 2000::/3 → 最高 3 bit == 001
  if (n >> 125n !== 0b001n) return false
  for (const [base, prefix] of V6_DENY_CIDR) {
    if (inV6Cidr(n, base, prefix)) return false
  }
  return true
}

/** 任意 IP 字符串的 global unicast 判定(非 IP → false)。 */
export function isGlobalUnicastIp(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) return isGlobalUnicastIpv4(ip)
  if (v === 6) return isGlobalUnicastIpv6(ip)
  return false
}

// ─── 自由域 URL / 端口形状校验 ────────────────────────────────────────────

/** 主机名形状:非 IP 字面量、无空白、合法 DNS 字符。 */
export function assertHostnameShape(hostname: string): void {
  const h = hostname.replace(/^\[|\]$/g, '')
  if (isIP(h) !== 0) {
    throw new ConnectorError('OUTBOUND_BLOCKED', 'IP literal host not allowed')
  }
  if (
    !/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(h)
  ) {
    throw new ConnectorError('OUTBOUND_BLOCKED', 'malformed hostname')
  }
  if (h.length > 253) {
    throw new ConnectorError('OUTBOUND_BLOCKED', 'hostname too long')
  }
}

/**
 * 规范化 https origin → `https://host:port`（**单一权威**:编译器 audience 归一化与 driver
 * 目标 origin 归一化共用本函数,保证逐字节一致——否则 audience 精确匹配会漏判/误判,是凭据
 * 流向不变量的安全前提）。https-only、禁 userinfo/path/query/fragment、host 小写、禁尾点/`..`/`*`、
 * 非 IP 字面量(经 assertHostnameShape)。失败抛 ConnectorError('OUTBOUND_BLOCKED');编译器可 catch
 * 后转成自己的 spec 错误类型。
 */
export function normalizeHttpsOrigin(raw: string): string {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new ConnectorError('OUTBOUND_BLOCKED', 'unparsable origin')
  }
  if (u.protocol !== 'https:') throw new ConnectorError('OUTBOUND_BLOCKED', 'origin must be https')
  if (u.username !== '' || u.password !== '')
    throw new ConnectorError('OUTBOUND_BLOCKED', 'userinfo not allowed in origin')
  if ((u.pathname !== '' && u.pathname !== '/') || u.search !== '' || u.hash !== '')
    throw new ConnectorError('OUTBOUND_BLOCKED', 'origin must have no path/query/fragment')
  const host = u.hostname
  if (host !== host.toLowerCase())
    throw new ConnectorError('OUTBOUND_BLOCKED', 'origin host must be lowercase')
  if (host.endsWith('.') || host.includes('..') || host.includes('*'))
    throw new ConnectorError('OUTBOUND_BLOCKED', 'malformed origin host')
  assertHostnameShape(host) // 非 IP 字面量 + DNS 形状
  const port = u.port || '443'
  return `https://${host}:${port}`
}

export interface ValidatedWebdavBase {
  /** 规范化 origin(https://host[:port],默认端口省略)。 */
  origin: string
  hostname: string
  port: number
  /** 已归一化的基路径(以 / 开头,无尾 /,可为 ""=根)。 */
  basePath: string
}

/**
 * WebDAV 服务器基址校验(绑定与每次调用都过):
 * https-only、禁 userinfo、禁 fragment、禁 query、禁 IP 字面量。
 */
export function validateWebdavBaseUrl(raw: string): ValidatedWebdavBase {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new ConnectorError('BAD_REQUEST', 'webdav url unparsable')
  }
  if (u.protocol !== 'https:') {
    throw new ConnectorError('OUTBOUND_BLOCKED', 'webdav requires https')
  }
  if (u.username !== '' || u.password !== '') {
    throw new ConnectorError('OUTBOUND_BLOCKED', 'userinfo in url not allowed')
  }
  if (u.hash !== '') {
    throw new ConnectorError('OUTBOUND_BLOCKED', 'fragment in url not allowed')
  }
  if (u.search !== '') {
    throw new ConnectorError('OUTBOUND_BLOCKED', 'query in base url not allowed')
  }
  assertHostnameShape(u.hostname)
  const port = u.port === '' ? 443 : Number(u.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConnectorError('OUTBOUND_BLOCKED', 'invalid port')
  }
  const hostname = u.hostname.toLowerCase()
  const origin = port === 443 ? `https://${hostname}` : `https://${hostname}:${port}`
  let basePath = u.pathname.replace(/\/+$/, '')
  if (basePath === '/') basePath = ''
  return { origin, hostname, port, basePath }
}

/** IMAP:仅 993 隐式 TLS。 */
export function assertImapPort(port: number): void {
  if (port !== 993) {
    throw new ConnectorError('OUTBOUND_BLOCKED', 'imap only allows port 993 (implicit TLS)')
  }
}

/** SMTP:465(隐式 TLS)或 587(STARTTLS,调用方必须 requireTLS=true)。 */
export function assertSmtpPort(port: number): void {
  if (port !== 465 && port !== 587) {
    throw new ConnectorError('OUTBOUND_BLOCKED', 'smtp only allows ports 465/587')
  }
}

// ─── DNS 解析 + 全记录校验 + IP 钉死 ─────────────────────────────────────

/** DNS 解析器注入点(测试注入假解析器做 rebinding / 私网表驱动)。 */
export interface DnsResolver {
  resolve4(hostname: string): Promise<string[]>
  resolve6(hostname: string): Promise<string[]>
}

const defaultResolver: DnsResolver = {
  resolve4: (h) => resolve4(h),
  resolve6: (h) => resolve6(h),
}

export interface PinnedAddress {
  ip: string
  family: 4 | 6
}

function isTolerableDnsError(err: unknown): boolean {
  const code = (err as { code?: string })?.code
  return code === 'ENODATA' || code === 'ENOTFOUND' || code === 'ESERVFAIL'
}

/**
 * 解析 hostname 的全部 A/AAAA 记录,**每一条**都必须是 global unicast,
 * 任一违规 → OUTBOUND_BLOCKED(不允许"挑好的用" —— 混合应答=rebinding/切换攻击征兆)。
 * 通过后返回钉死地址(优先 IPv4 首条)。后续建连**只用**该 IP,hostname 仅作 SNI。
 */
export async function resolvePinnedAddress(
  hostname: string,
  resolver: DnsResolver = defaultResolver,
): Promise<PinnedAddress> {
  assertHostnameShape(hostname)
  let v4: string[] = []
  let v6: string[] = []
  try {
    v4 = await resolver.resolve4(hostname)
  } catch (err) {
    if (!isTolerableDnsError(err)) {
      throw new ConnectorError('OUTBOUND_BLOCKED', 'dns resolution failed (A)')
    }
  }
  try {
    v6 = await resolver.resolve6(hostname)
  } catch (err) {
    if (!isTolerableDnsError(err)) {
      throw new ConnectorError('OUTBOUND_BLOCKED', 'dns resolution failed (AAAA)')
    }
  }
  if (v4.length === 0 && v6.length === 0) {
    throw new ConnectorError('OUTBOUND_BLOCKED', 'dns returned no records')
  }
  for (const ip of v4) {
    if (!isGlobalUnicastIpv4(ip)) {
      throw new ConnectorError('OUTBOUND_BLOCKED', 'dns A record not global unicast')
    }
  }
  for (const ip of v6) {
    if (!isGlobalUnicastIpv6(ip)) {
      throw new ConnectorError('OUTBOUND_BLOCKED', 'dns AAAA record not global unicast')
    }
  }
  if (v4.length > 0) return { ip: v4[0]!, family: 4 }
  return { ip: v6[0]!, family: 6 }
}

// ─── 钉死 IP 的 fetch dispatcher ─────────────────────────────────────────

export const CONNECT_TIMEOUT_MS = 10_000
export const TOTAL_TIMEOUT_MS = 60_000

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number,
) => void

/**
 * 生成 net/tls `lookup` 覆盖:任何主机名都返回钉死 IP。
 * imapflow / nodemailer 不走 undici,直接 host=IP + tls.servername,不用本函数。
 */
export function makePinnedLookup(pin: PinnedAddress) {
  return (
    _hostname: string,
    options: { all?: boolean } | LookupCallback,
    callback?: LookupCallback,
  ): void => {
    const cb = (typeof options === 'function' ? options : callback) as LookupCallback
    const all = typeof options === 'object' && options !== null && options.all === true
    if (all) cb(null, [{ address: pin.ip, family: pin.family }])
    else cb(null, pin.ip, pin.family)
  }
}

/**
 * 建一个"钉死 IP"的 undici Agent:TCP 连到 pin.ip,TLS SNI / 证书校验仍用请求
 * URL 里的 hostname(undici 从 URL host 推导 servername;lookup 只改建连地址)。
 * **一次性使用**:调用方用完必须 close()(防 FD 泄漏)。
 */
export function makePinnedDispatcher(pin: PinnedAddress): Dispatcher {
  return new Agent({
    connect: {
      lookup: makePinnedLookup(pin) as never,
      timeout: CONNECT_TIMEOUT_MS,
    },
  })
}

/**
 * 自由域 https fetch 收口:解析→全记录校验→钉死建连→禁 redirect→总超时 60s。
 * 只用于 webdav(imap/smtp 走 imapflow/nodemailer 的 host=IP+servername 路径)。
 *
 * fetchImpl 必须是 undici fetch(支持 RequestInit.dispatcher);测试注入 mock。
 */
export interface PinnedFetchDeps {
  resolver?: DnsResolver
  fetchImpl?: (input: string, init: Record<string, unknown>) => Promise<Response>
}

export async function pinnedHttpsFetch(
  url: URL,
  init: { method: string; headers?: Record<string, string>; body?: string | Buffer },
  deps: PinnedFetchDeps = {},
): Promise<Response> {
  if (url.protocol !== 'https:') {
    throw new ConnectorError('OUTBOUND_BLOCKED', 'pinned fetch requires https')
  }
  const pin = await resolvePinnedAddress(url.hostname, deps.resolver)
  const dispatcher = makePinnedDispatcher(pin)
  const doFetch =
    deps.fetchImpl ??
    ((input: string, i: Record<string, unknown>) =>
      undiciFetch(input, i as never) as unknown as Promise<Response>)
  try {
    return await doFetch(url.toString(), {
      method: init.method,
      headers: init.headers,
      body: init.body,
      redirect: 'error', // 禁 redirect(3xx=失败)
      dispatcher,
      signal: AbortSignal.timeout(TOTAL_TIMEOUT_MS),
    })
  } finally {
    // fire-and-forget close:等 in-flight body 读完由 undici 引用计数处理
    void (dispatcher as Agent).close().catch(() => {})
  }
}
