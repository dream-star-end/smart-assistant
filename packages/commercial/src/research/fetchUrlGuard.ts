/**
 * fetchUrlGuard — 全文下载出站 URL 的 SSRF 边界(R5 auditor W3)。
 *
 * fetchFulltext 的候选 URL 来自容器提交的 record.oa.url 与上游查询结果(Unpaywall /
 * Europe PMC),二者都是**不可信输入**:容器侧用户可以直接给 `http://172.31.0.1:18892/...`
 * 或 `http://127.0.0.1:5432/`,上游 JSON 也可能被投毒;跟随 redirect 时每一跳同样可能
 * 指回内网。master 进程拿着平台凭据出站,任何一跳落到私网/回环/链路本地/平台容器网段
 * 都构成 SSRF。
 *
 * 规则(复用 connectors/outboundPolicy 的 global-unicast 判定,不另抄一份 CIDR 表):
 *   - 只允许 http(s);无 userinfo。
 *   - 主机名形状合法(非空、合法 DNS 字符);IP 字面量必须是 global unicast。
 *   - 解析 A/AAAA,**全部**记录必须 global unicast(混合应答 = rebinding 征兆,拒)。
 *   - 每一跳 redirect 的 Location 重新过同一套门(调用方负责手工跟随)。
 *
 * 与 connectors 的 pinnedHttpsFetch 不同:文献 OA 链接大量是 http 且需要跟随 redirect,
 * 这里不钉 IP 建连(fetchImpl 是注入的普通 fetch),接受 DNS 解析与建连之间的 TOCTOU
 * 窗口——对手需要控制目标域的权威 DNS 且精确卡时序;对本场景(下载公开 PDF)是可接受
 * 的剩余风险,并在 attempts 明细里把拒绝原因如实记录。
 */

import { resolve4, resolve6 } from 'node:dns/promises'
import { isIP } from 'node:net'

import { isGlobalUnicastIp } from '../connectors/outboundPolicy.js'

export interface FetchGuardResolver {
  resolve4(hostname: string): Promise<string[]>
  resolve6(hostname: string): Promise<string[]>
}

const defaultResolver: FetchGuardResolver = {
  resolve4: (h) => resolve4(h),
  resolve6: (h) => resolve6(h),
}

/**
 * transient=true 表示拒绝源于 DNS 基础设施抖动(超时/EAI_AGAIN/resolver 拒连/超出预算),
 * 不是策略性拒绝——调用方应归为瞬时错误走重试,不要记成 SSRF 拒绝。
 */
export type FetchGuardVerdict =
  | { ok: true; url: URL }
  | { ok: false; reason: string; transient?: boolean }

const HOSTNAME_RE =
  /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.?$/

function isTolerableDnsError(err: unknown): boolean {
  const code = (err as { code?: string })?.code
  return code === 'ENODATA' || code === 'ENOTFOUND' || code === 'ESERVFAIL'
}

/** resolver 自身不可用/抖动:与"解到私网"严格区分,归瞬时错误。 */
function isTransientDnsError(err: unknown): boolean {
  const code = (err as { code?: string })?.code
  return (
    code === 'ETIMEOUT' ||
    code === 'EAI_AGAIN' ||
    code === 'ECONNREFUSED' ||
    code === 'EREFUSED' ||
    code === 'ECANCELLED' ||
    code === 'ECANCELED'
  )
}

class DnsBudgetExceeded extends Error {
  code = 'EDNSBUDGET'
}

/** 给 resolve 套预算(默认 node dns 走 c-ares 自带超时,但可长达数秒×重试,需与下载 timeoutMs 对齐)。 */
function withBudget<T>(p: Promise<T>, ms: number | undefined): Promise<T> {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return p
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new DnsBudgetExceeded('dns lookup exceeded budget')), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

/**
 * 校验一个下载目标 URL 是否允许出站。纯判定,不发请求。
 * 返回 `{ ok:false, reason }` 时 reason 是给 attempts.detail 的短说明(不含敏感信息)。
 */
export async function vetFetchTarget(
  raw: string | URL,
  resolver: FetchGuardResolver = defaultResolver,
  opts: { dnsTimeoutMs?: number } = {},
): Promise<FetchGuardVerdict> {
  let url: URL
  try {
    url = raw instanceof URL ? raw : new URL(raw)
  } catch {
    return { ok: false, reason: 'malformed url' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: `scheme ${url.protocol} not allowed` }
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'userinfo not allowed' }
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!host) return { ok: false, reason: 'empty host' }

  const family = isIP(host)
  if (family !== 0) {
    return isGlobalUnicastIp(host)
      ? { ok: true, url }
      : {
          ok: false,
          reason: 'target address is not global unicast (private/loopback/link-local/reserved)',
        }
  }
  if (host.length > 253 || !HOSTNAME_RE.test(host)) {
    return { ok: false, reason: 'malformed hostname' }
  }
  // localhost 及 .localhost/.local 等不经 DNS 也拒(有些 resolver 会把它们解成 ::1/127.0.0.1)。
  const lower = host.toLowerCase().replace(/\.$/, '')
  if (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.local')) {
    return { ok: false, reason: 'local hostname not allowed' }
  }

  let v4: string[] = []
  let v6: string[] = []
  try {
    v4 = await withBudget(resolver.resolve4(lower), opts.dnsTimeoutMs)
  } catch (err) {
    if (err instanceof DnsBudgetExceeded || isTransientDnsError(err)) {
      return {
        ok: false,
        reason: 'dns lookup timed out / resolver unavailable (A)',
        transient: true,
      }
    }
    if (!isTolerableDnsError(err)) return { ok: false, reason: 'dns resolution failed (A)' }
  }
  try {
    v6 = await withBudget(resolver.resolve6(lower), opts.dnsTimeoutMs)
  } catch (err) {
    if (err instanceof DnsBudgetExceeded || isTransientDnsError(err)) {
      return {
        ok: false,
        reason: 'dns lookup timed out / resolver unavailable (AAAA)',
        transient: true,
      }
    }
    if (!isTolerableDnsError(err)) return { ok: false, reason: 'dns resolution failed (AAAA)' }
  }
  if (v4.length === 0 && v6.length === 0) {
    return { ok: false, reason: 'dns returned no records' }
  }
  for (const ip of [...v4, ...v6]) {
    if (!isGlobalUnicastIp(ip)) {
      return {
        ok: false,
        reason: 'dns resolved to a non-global address (private/loopback/link-local)',
      }
    }
  }
  return { ok: true, url }
}

/** redirect 跟随上限(浏览器惯例 20;下载链路收紧到 5 足够覆盖 DOI → 出版社 → CDN)。 */
export const FETCH_MAX_REDIRECTS = 5

export function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}
