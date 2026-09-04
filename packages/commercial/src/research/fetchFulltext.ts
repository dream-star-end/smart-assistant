/**
 * fetchFulltext — OA 优先全文下载链(R5 文献流水线 Phase A,设计 §4.1)。
 *
 * 纯逻辑(deps 注入,同 sources.ts 风格):对每条含 doi/arxivId/题名的记录,
 * 依次尝试候选源,命中合法 PDF 即停;每次尝试产出结构化失败原因。
 *
 * 合规边界(写死,R5 设计 §5):
 *   - 只取 OA 定位器(unpaywall / arXiv / Europe PMC OA / publisher OA 直 PDF);
 *     landing page 非 PDF 不抓取、不代爬付费墙、不做 sci-hub/libgen。
 *   - 人机验证/验证码/挑战页 → blocked_robot 终态,如实记录,不重试不绕过。
 *   - 机构 proxy 仅在显式配置(research_config fetch.proxyUrl)时使用,且只
 *     重放直接链已解析出的同一批候选 URL(经用户自己的合法代理),不污染全局出站。
 *
 * 链序(设计 §4.1 表):
 *   1 known_oa      record.oa.url 已有(unpaywall/openalex/s2 富化产物;arXiv abs → pdf 改写)
 *   2 unpaywall_pdf 有 DOI → Unpaywall best_oa_location.url_for_pdf
 *   3 arxiv         arxivId 或 DOI 匹配 10.48550/arxiv.* → arxiv.org/pdf/<id>
 *   4 pmc_oa        DOI/题名 → Europe PMC REST OA 子集 pdf 链接
 *   5 publisher_oa  unpaywall best_oa_location.url(landing;仅当响应真为 PDF 才收)
 *   6 proxy pass    上述候选经显式机构 proxy 重放(source 加 ":proxy" 后缀)
 *
 * 内容校验:%PDF- magic、非零字节、≤25MiB(对齐 MAX_BLOB_BYTES)。
 * 外部端点形状 2026-09-04 实测:Unpaywall /v2/{doi}?email=(example.com 邮箱 422,
 * 需真实邮箱);Europe PMC search resultType=core → fullTextUrlList.fullTextUrl[]
 * (documentStyle=pdf + availabilityCode OA|F + site=Europe_PMC);arxiv.org/pdf/<id>。
 */

import type { FetchLike } from './sources.js'

// ─── 类型 ────────────────────────────────────────────────────────────

/** 失败原因枚举(进 attempts 表与 job result;设计 §4.1)。 */
export const FETCH_FAIL_REASONS = [
  'no_identifier',
  'no_oa_location',
  'paywalled',
  'fetch_error_4xx',
  'fetch_error_5xx',
  'timeout',
  'blocked_robot',
  'not_pdf',
  'too_large',
  'proxy_unavailable',
] as const
export type FetchFailReason = (typeof FETCH_FAIL_REASONS)[number]

export type FetchStrategy = 'known_oa' | 'unpaywall_pdf' | 'arxiv' | 'pmc_oa' | 'publisher_oa'

/** 单次下载尝试(source = strategy 或 "strategy:proxy")。 */
export interface FetchAttempt {
  source: string
  code: 'ok' | FetchFailReason
  httpStatus?: number
  detail?: string
  ms: number
}

/** 容器提交的紧凑记录(同步 ≤5 / 批量 ≤200;只带定位字段)。 */
export interface FetchRecordInput {
  id: string
  title?: string
  doi?: string
  arxivId?: string
  oa?: { isOA?: boolean; url?: string }
}

export interface DownloadOk {
  ok: true
  bytes: Buffer
  mime: string
  strategy: string
  attempts: FetchAttempt[]
}
export interface DownloadFail {
  ok: false
  reason: FetchFailReason
  attempts: FetchAttempt[]
}

export interface FetchFulltextConfig {
  /** Unpaywall polite email(必须真实邮箱;缺省回落 litSources.unpaywallEmail 由调用方决定)。 */
  unpaywallEmail?: string
  /** 显式机构 proxy URL(如 EZproxy/forward proxy);未配置绝不走 proxy。 */
  proxyUrl?: string
}

export interface FetchFulltextHttpDeps {
  fetchImpl: FetchLike
  /** 经机构 proxy 的 fetch(默认用 undici ProxyAgent 惰性构建);仅 proxyUrl 配置时调用。 */
  proxyFetchImpl?: FetchLike
  timeoutMs?: number
  maxBytes?: number
}

// ─── 常量 ────────────────────────────────────────────────────────────

export const FETCH_DEFAULT_TIMEOUT_MS = 30_000
/** 对齐 researchProxy MAX_BLOB_BYTES(25 MiB ingest 输入上限)。 */
export const FETCH_MAX_BYTES = 25 * 1024 * 1024

const ROBOT_MARKERS_RE =
  /captcha|challenge|cloudflare|turnstile|are you a robot|verify you are human|access denied|robot check|ddos guard/i

// ─── URL 候选解析(纯函数 + 上游查询) ────────────────────────────────

/** arXiv DOI(10.48550/arxiv.<id>)→ arXiv id(snowball.ts seedToOpenAlexSelector 同款形态)。 */
export function arxivIdFromDoi(doi: string | undefined): string | undefined {
  if (!doi) return undefined
  const m = doi.match(/^10\.48550\/arxiv\.([0-9]{4}\.[0-9]{4,5}[a-z]?|[a-z-]+\/\d{7})$/i)
  return m ? m[1].toLowerCase() : undefined
}

interface Candidate {
  strategy: FetchStrategy
  url: string
}

/** known_oa 的 arXiv abs 链接改写为直 PDF(abs 页必为 HTML,省一次必败请求)。 */
function rewriteArxivAbsToPdf(url: string): string {
  return url.replace(
    /^(https:\/\/arxiv\.org\/abs\/.+)$/,
    (_all, p: string) => `https://arxiv.org/pdf/${p.slice('https://arxiv.org/abs/'.length)}`,
  )
}

/** https(s) 候选 URL 安全化:只接受 http(s) 绝对 URL,无 userinfo/fragment。 */
function safeCandidateUrl(raw: string): string | null {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    if (u.username || u.password || u.hash) return null
    return u.toString()
  } catch {
    return null
  }
}

/** Unpaywall 富化查询结果(lookupUnpaywallOA 的最小子集,独立于 litSearch 以便分类失败)。 */
interface UnpaywallLookup {
  isOA: boolean
  pdfUrl?: string
  landingUrl?: string
}

async function lookupUnpaywall(
  doi: string,
  email: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<UnpaywallLookup | null> {
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(
      `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`,
      { method: 'GET', headers: { Accept: 'application/json' }, signal: ctrl.signal },
    )
    if (!res.ok) return null
    const j = (await res.json()) as {
      is_oa?: boolean
      best_oa_location?: { url_for_pdf?: string | null; url?: string | null } | null
    }
    return {
      isOA: j.is_oa === true,
      pdfUrl: j.best_oa_location?.url_for_pdf ?? undefined,
      landingUrl: j.best_oa_location?.url ?? undefined,
    }
  } catch {
    return null
  } finally {
    clearTimeout(to)
  }
}

interface EpmcFullTextUrl {
  documentStyle?: string
  availabilityCode?: string
  site?: string
  url?: string
}

/** Europe PMC OA 子集查询(2026-09-04 实测形状)。返回 null=查询失败/无命中。 */
async function lookupEuropePmc(
  doi: string | undefined,
  title: string | undefined,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<{ pdfUrl: string } | null> {
  const term = doi
    ? `DOI:"${doi}"`
    : title && title.trim().length > 8
      ? `TITLE:"${title.replace(/"/g, ' ').trim()}"`
      : null
  if (!term) return null
  const params = new URLSearchParams({ query: term, format: 'json', resultType: 'core' })
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(
      `https://www.ebi.ac.uk/europepmc/webservices/rest/search?${params.toString()}`,
      { method: 'GET', headers: { Accept: 'application/json' }, signal: ctrl.signal },
    )
    if (!res.ok) return null
    const j = (await res.json()) as {
      resultList?: { result?: Array<{ fullTextUrlList?: { fullTextUrl?: EpmcFullTextUrl[] } }> }
    }
    const r0 = j.resultList?.result?.[0]
    if (!r0) return null
    // OA|F = Europe PMC 合法托管的开放/免费全文;只收 https 直 PDF 链接。
    const pdf = (r0.fullTextUrlList?.fullTextUrl ?? []).find(
      (u) =>
        u.documentStyle === 'pdf' &&
        (u.availabilityCode === 'OA' || u.availabilityCode === 'F') &&
        (!u.site || u.site === 'Europe_PMC') &&
        typeof u.url === 'string' &&
        u.url.startsWith('https://'),
    )
    return pdf?.url ? { pdfUrl: pdf.url } : null
  } catch {
    return null
  } finally {
    clearTimeout(to)
  }
}

// ─── 下载单候选(内容校验 + 瞬时错误有界重试) ────────────────────────

interface AttemptOk {
  ok: true
  bytes: Buffer
  mime: string
}
type AttemptFailCode = FetchFailReason

function isTransientCode(c: AttemptFailCode): boolean {
  return c === 'timeout' || c === 'fetch_error_5xx'
}

async function readBodyCapped(
  res: Response,
  cap: number,
  abort: () => void,
): Promise<{ bytes: Buffer } | { tooLarge: true } | { error: string }> {
  const lenHeader = res.headers.get('content-length')
  if (lenHeader && Number(lenHeader) > cap) {
    abort()
    return { tooLarge: true }
  }
  const body = res.body
  if (!body) {
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > cap) return { tooLarge: true }
    return { bytes: buf }
  }
  const reader = body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > cap) {
        abort()
        try {
          await reader.cancel()
        } catch {
          /* cancel 失败无所谓,已 abort */
        }
        return { tooLarge: true }
      }
      chunks.push(Buffer.from(value))
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
  return { bytes: Buffer.concat(chunks) }
}

async function attemptDownloadOnce(
  url: string,
  fetchImpl: FetchLike,
  opts: { timeoutMs: number; maxBytes: number; ua?: string },
): Promise<AttemptOk | { code: AttemptFailCode; httpStatus?: number; detail?: string }> {
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), opts.timeoutMs)
  try {
    const headers: Record<string, string> = { Accept: 'application/pdf,*/*' }
    if (opts.ua) headers['User-Agent'] = opts.ua
    const res = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: ctrl.signal,
      redirect: 'follow',
    })
    if (!res.ok) {
      const code = res.status >= 500 ? 'fetch_error_5xx' : 'fetch_error_4xx'
      return { code, httpStatus: res.status }
    }
    const body = await readBodyCapped(res, opts.maxBytes, () => ctrl.abort())
    if ('tooLarge' in body) return { code: 'too_large', httpStatus: res.status }
    if ('error' in body) {
      return { code: 'fetch_error_5xx', httpStatus: res.status, detail: body.error.slice(0, 300) }
    }
    const bytes = body.bytes
    if (bytes.length === 0) return { code: 'not_pdf', httpStatus: res.status, detail: 'empty body' }
    if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
      const contentType = res.headers.get('content-type') ?? ''
      const head = bytes.subarray(0, 2048).toString('utf8')
      if (ROBOT_MARKERS_RE.test(head) || ROBOT_MARKERS_RE.test(contentType)) {
        return { code: 'blocked_robot', httpStatus: res.status, detail: 'captcha/challenge page' }
      }
      return {
        code: 'not_pdf',
        httpStatus: res.status,
        detail: `content-type=${contentType.split(';')[0] || 'unknown'}; not a PDF (landing pages are not crawled)`,
      }
    }
    return { ok: true, bytes, mime: contentTypeHeaderMime(res.headers.get('content-type')) }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const aborted = /abort/i.test(msg) || (err as { name?: string })?.name === 'AbortError'
    return aborted
      ? { code: 'timeout' }
      : { code: 'fetch_error_5xx', detail: `network error: ${msg.slice(0, 200)}` }
  } finally {
    clearTimeout(to)
  }
}

function contentTypeHeaderMime(raw: string | null): string {
  const mime = (raw ?? '').split(';')[0].trim().toLowerCase()
  return mime || 'application/pdf'
}

/** 单候选下载(瞬时错误 timeout/5xx 有界重试 2 次;4xx/blocked/not_pdf 不重试)。 */
async function attemptDownload(
  url: string,
  fetchImpl: FetchLike,
  opts: { timeoutMs: number; maxBytes: number; ua?: string; retryDelayMs?: number },
): Promise<
  AttemptOk | { code: AttemptFailCode; httpStatus?: number; detail?: string; attempts: number }
> {
  let last: { code: AttemptFailCode; httpStatus?: number; detail?: string } = {
    code: 'fetch_error_5xx',
  }
  const maxTries = 2
  for (let i = 0; i < maxTries; i++) {
    const r = await attemptDownloadOnce(url, fetchImpl, opts)
    if ('ok' in r) return { ...r, attempts: i + 1 }
    last = r
    if (!isTransientCode(r.code) || i === maxTries - 1) break
    await new Promise((resolve) => setTimeout(resolve, opts.retryDelayMs ?? 400))
  }
  return { ...last, attempts: maxTries }
}

// ─── 主链 ────────────────────────────────────────────────────────────

/**
 * 下载一条记录的 OA 全文。返回结构化成功(bytes)或失败(reason)+ 全部尝试明细。
 * 不碰 DB;落 blob/ingest/membership 由 researchHandlers.fetchRecordIntoLibrary 编排。
 */
export async function downloadFulltext(
  record: FetchRecordInput,
  cfg: FetchFulltextConfig,
  deps: FetchFulltextHttpDeps,
): Promise<DownloadOk | DownloadFail> {
  const timeoutMs = deps.timeoutMs ?? FETCH_DEFAULT_TIMEOUT_MS
  const maxBytes = deps.maxBytes ?? FETCH_MAX_BYTES
  const ua = cfg.unpaywallEmail
    ? `OpenClaude-research/1.0 (mailto:${cfg.unpaywallEmail})`
    : 'OpenClaude-research/1.0'

  const doi = record.doi?.trim().toLowerCase() || undefined
  const arxivId = record.arxivId?.trim().toLowerCase() || arxivIdFromDoi(doi)
  const oaUrl = record.oa?.url?.trim() || undefined

  if (!doi && !arxivId && !oaUrl && !record.title?.trim()) {
    return { ok: false, reason: 'no_identifier', attempts: [] }
  }

  // 候选解析(链序固定)。上游查询失败 → 该策略跳过(不产生下载 attempt);
  // Unpaywall 明确 is_oa=false 是"付费墙证据",进最终 reason 判定。
  const candidates: Candidate[] = []
  let paywallEvidence = false
  let lookupFailed = false

  if (oaUrl) {
    const u = safeCandidateUrl(rewriteArxivAbsToPdf(oaUrl))
    if (u) candidates.push({ strategy: 'known_oa', url: u })
  }

  if (doi && cfg.unpaywallEmail) {
    const upw = await lookupUnpaywall(doi, cfg.unpaywallEmail, deps.fetchImpl, timeoutMs)
    if (upw) {
      if (upw.pdfUrl) {
        const u = safeCandidateUrl(upw.pdfUrl)
        if (u) candidates.push({ strategy: 'unpaywall_pdf', url: u })
      }
      if (!upw.isOA) paywallEvidence = true
      // publisher_oa 候选(landing page;仅当响应真为 PDF 才收,attemptDownload 校验):
      if (upw.landingUrl && upw.landingUrl !== upw.pdfUrl) {
        const u = safeCandidateUrl(upw.landingUrl)
        if (u) candidates.push({ strategy: 'publisher_oa', url: u })
      }
    } else {
      lookupFailed = true
    }
  }

  if (arxivId) {
    candidates.push({ strategy: 'arxiv', url: `https://arxiv.org/pdf/${arxivId}` })
  }

  const epmc = await lookupEuropePmc(doi, record.title, deps.fetchImpl, timeoutMs)
  if (epmc) {
    const u = safeCandidateUrl(epmc.pdfUrl)
    if (u) candidates.push({ strategy: 'pmc_oa', url: u })
  }

  // 按链序执行(known_oa → unpaywall_pdf → arxiv → pmc_oa → publisher_oa);
  // 同 URL 已试过不重放(known_oa 与 unpaywall_pdf 可能同址)。
  const order: FetchStrategy[] = ['known_oa', 'unpaywall_pdf', 'arxiv', 'pmc_oa', 'publisher_oa']
  candidates.sort((a, b) => order.indexOf(a.strategy) - order.indexOf(b.strategy))

  const attempts: FetchAttempt[] = []
  const tried = new Set<string>()

  for (const c of candidates) {
    if (tried.has(c.url)) continue
    tried.add(c.url)
    const t0 = Date.now()
    const r = await attemptDownload(c.url, deps.fetchImpl, { timeoutMs, maxBytes, ua })
    const ms = Date.now() - t0
    if ('ok' in r) {
      attempts.push({ source: c.strategy, code: 'ok', httpStatus: 200, ms })
      return { ok: true, bytes: r.bytes, mime: r.mime, strategy: c.strategy, attempts }
    }
    attempts.push({
      source: c.strategy,
      code: r.code,
      httpStatus: r.httpStatus,
      detail: r.detail,
      ms,
    })
  }

  // proxy pass:仅在显式配置 proxyUrl、直接链未命中、且无 blocked_robot(合规:验证码
  // 页不可绕)时,把同批候选经用户机构 proxy 重放一次。
  if (cfg.proxyUrl && candidates.length > 0 && !attempts.some((a) => a.code === 'blocked_robot')) {
    const proxyFetch = deps.proxyFetchImpl ?? (await buildProxyFetch(cfg.proxyUrl))
    if (proxyFetch) {
      for (const c of candidates) {
        const t0 = Date.now()
        const r = await attemptDownload(c.url, proxyFetch, { timeoutMs, maxBytes, ua })
        const ms = Date.now() - t0
        if ('ok' in r) {
          attempts.push({ source: `${c.strategy}:proxy`, code: 'ok', httpStatus: 200, ms })
          return {
            ok: true,
            bytes: r.bytes,
            mime: r.mime,
            strategy: `${c.strategy}:proxy`,
            attempts,
          }
        }
        attempts.push({
          source: `${c.strategy}:proxy`,
          code: r.code,
          httpStatus: r.httpStatus,
          detail: r.detail,
          ms,
        })
      }
    } else {
      attempts.push({
        source: 'proxy',
        code: 'proxy_unavailable',
        detail: `proxy fetch unavailable for ${cfg.proxyUrl.slice(0, 120)}`,
        ms: 0,
      })
    }
  }

  // 最终 reason:验证码 > 付费墙证据 > 无候选 > 最后一次失败码。
  if (attempts.some((a) => a.code === 'blocked_robot')) {
    return { ok: false, reason: 'blocked_robot', attempts }
  }
  if (paywallEvidence && !lookupFailed) {
    return { ok: false, reason: 'paywalled', attempts }
  }
  if (attempts.length === 0) {
    return { ok: false, reason: 'no_oa_location', attempts }
  }
  const lastFail = attempts[attempts.length - 1]
  return { ok: false, reason: lastFail.code as FetchFailReason, attempts }
}

// ─── 机构 proxy fetch(默认 undici ProxyAgent,惰性构建) ─────────────

let cachedProxy: { url: string; impl: FetchLike } | null = null

async function buildProxyFetch(proxyUrl: string): Promise<FetchLike | null> {
  if (cachedProxy && cachedProxy.url === proxyUrl) return cachedProxy.impl
  const u = safeCandidateUrl(proxyUrl)
  if (!u) return null
  try {
    const { ProxyAgent, fetch: undiciFetch } = await import('undici')
    const agent = new ProxyAgent(u)
    const impl = ((input: string | URL | Request, init?: RequestInit) =>
      undiciFetch(input as any, { ...(init as any), dispatcher: agent })) as unknown as FetchLike
    cachedProxy = { url: proxyUrl, impl }
    return impl
  } catch {
    return null
  }
}

/** 测试专用:清掉 proxy agent 缓存。 */
export function _resetProxyCache(): void {
  cachedProxy = null
}
