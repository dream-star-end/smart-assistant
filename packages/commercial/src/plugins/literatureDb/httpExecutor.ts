import crypto from 'node:crypto'
import http from 'node:http'
import { type DnsResolver, resolvePinnedAddress } from '../../connectors/outboundPolicy.js'
import { loadKmsKey, zeroBuffer } from '../../crypto/keys.js'
import { type JieyouAccountState, parseJieyouAccountState } from './accountState.js'
import {
  LITERATURE_ARTIFACT_MAX_BYTES,
  type LiteratureArtifactStore,
  type StagedLiteratureArtifact,
} from './artifactStore.js'
import { LiteratureError, abortable } from './errors.js'
import { JieyouHttpClient } from './jieyouHttpClient.js'
import { hasJieyouMemberAuthCookies } from './jieyouLoginSession.js'
import type { LiteratureCallTrace, LiteratureEgressHop } from './observability.js'
import { LiteratureHttpTransport } from './transport.js'
import {
  classifyMemberEntryResponse,
  classifyResponsePage,
  decodeUpstreamHtml,
  grpcStatusError,
  grpcWebStatus,
  isHtmlResponse,
  upstreamPageError,
  upstreamStatusError,
} from './upstreamClassify.js'

export interface LiteratureHttpReadExecutionInput {
  readonly actionId: 'search' | 'download'
  readonly params: Readonly<Record<string, unknown>>
  readonly userId?: number
  readonly ownerUserId?: string
  readonly accountInstanceId: string
  readonly storageState: JieyouAccountState
  readonly signal: AbortSignal
  /** Per-call observability recorder (OCV5-585); never receives query or ids. */
  readonly trace?: LiteratureCallTrace
}

export interface LiteratureHttpSearchItem {
  readonly documentId: string
  readonly title: string
  readonly authors?: readonly string[]
  readonly year?: number
  readonly source?: string
  readonly snippet?: string
}

export interface LiteratureHttpReadExecutionOutput {
  readonly data: Record<string, unknown>
  readonly storageState: JieyouAccountState
  readonly stagedArtifact?: StagedLiteratureArtifact
}

export type LiteratureHttpExecuteOutput = LiteratureHttpReadExecutionOutput

export interface LiteratureHttpReadExecutor {
  executeRead(input: LiteratureHttpReadExecutionInput): Promise<LiteratureHttpReadExecutionOutput>
}

export const WANFANG_WEBVPN_ORIGIN = 'http://webvpn.ustb.booktsg.com'

export const WANFANG_WEBVPN_GRPC_PATH =
  '/https/77726476706e69737468656265737421f4b9569d2936695e790c88b8991b203a7c11579c/Detail.DetailService/getRelatedPaper?vpn-12-o2-d.wanfangdata.com.cn'

export const WANFANG_WEBVPN_DOWNLOAD_PREFIX =
  '/https/77726476706e69737468656265737421ffe452d2303166567f068ea89941227b8b47969ef4a4/file/download/perio_'

export const WANFANG_WEBVPN_FULLTEXT_PREFIX =
  '/https/77726476706e69737468656265737421ffe452d2303166567f068ea89941227b8b47969ef4a4/NewFulltext'

export const WANFANG_SEED_PAPER_ID = 'dgjsxb202616022'

export const JIEYOU_WANFANG_ENTRY_PATH = '/e/action/ShowInfo.php?classid=79&id=2837'

export const JIEYOU_SPRINGER_WEBVPN_ENTRY_PATH = '/e/action/ShowInfo.php?classid=209&id=1781'

export const SPRINGER_WEBVPN_PREFIX =
  '/https/77726476706e69737468656265737421fcfe4f976923784277068ea98a1b203a54'
const ALLOWED_DOWNSTREAM_HOSTS = new Set(['webvpn.ustb.booktsg.com'])

export const DOWNSTREAM_HOP_TIMEOUT_MS = 30_000

export const DOWNSTREAM_PROXY_HEADER_TIMEOUT_MS = 15_000

export const DOWNSTREAM_MAX_TOTAL_TIMEOUT_MS = 105_000
const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
export const DOCUMENT_ID_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
export const DOCUMENT_ID_HKDF_INFO = 'openclaude:literature-db:document-id:v1'

export function deriveLiteratureDocumentIdSecret(env: NodeJS.ProcessEnv = process.env): Buffer {
  let kms: Buffer | undefined
  try {
    kms = loadKmsKey(env)
    return Buffer.from(crypto.hkdfSync('sha256', kms, Buffer.alloc(0), DOCUMENT_ID_HKDF_INFO, 32))
  } catch {
    throw new LiteratureError('SECRET_INVALID')
  } finally {
    if (kms) zeroBuffer(kms)
  }
}
function encodeVarint(val: number): Buffer {
  const bytes: number[] = []
  let v = val >>> 0
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  bytes.push(v)
  return Buffer.from(bytes)
}
function encodeStringField(fieldNo: number, str: string): Buffer {
  const b = Buffer.from(str, 'utf8')
  return Buffer.concat([encodeVarint((fieldNo << 3) | 2), encodeVarint(b.length), b])
}
function encodeVarintField(fieldNo: number, val: number): Buffer {
  return Buffer.concat([encodeVarint((fieldNo << 3) | 0), encodeVarint(val)])
}

export function buildWanfangRelatedPaperGrpcFrame(
  query: string,
  pageSize: number,
  page = 1,
  seedPaperId = WANFANG_SEED_PAPER_ID,
): Buffer {
  const payload = Buffer.concat([
    encodeStringField(1, 'Periodical'),
    encodeStringField(2, 'SimilarPaper'),
    encodeStringField(3, seedPaperId),
    encodeStringField(4, query),
    encodeVarintField(9, pageSize),
    encodeVarintField(10, page),
  ])
  const frame = Buffer.alloc(5 + payload.length)
  frame[0] = 0
  frame.writeUInt32BE(payload.length, 1)
  payload.copy(frame, 5)
  return frame
}
function readVarint(buf: Buffer, pos: number): [number, number] {
  let result = 0
  let shift = 0
  let p = pos
  while (p < buf.length) {
    const b = buf[p++]!
    result |= (b & 0x7f) << shift
    if (!(b & 0x80)) return [result >>> 0, p]
    shift += 7
    if (shift > 35) break
  }
  return [result >>> 0, p]
}

export interface ParsedWanfangPaper {
  readonly id: string
  readonly title: string
  readonly authors: readonly string[]
  readonly journal?: string
  readonly year?: number
  readonly snippet?: string
  readonly hasFulltext: boolean
}
function parseSinglePeriodicalProto(perio: Buffer): ParsedWanfangPaper | null {
  let q = 0
  let id = ''
  let title = ''
  const authors: string[] = []
  let snippet = ''
  let journal = ''
  let year: number | undefined
  let hasFulltext = false
  while (q < perio.length) {
    const [tag, nextQ] = readVarint(perio, q)
    const fn = tag >>> 3
    const wt = tag & 7
    q = nextQ
    if (wt === 0) {
      const [val, nq] = readVarint(perio, q)
      q = nq
      if (fn === 33 && val >= 1500 && val <= 2100) {
        year = val
      }
    } else if (wt === 2) {
      const [len, nq] = readVarint(perio, q)
      if (len < 0 || nq + len > perio.length) break
      const sub = perio.subarray(nq, nq + len)
      q = nq + len
      const str = sub.toString('utf8').replace(/\0/g, '').trim()
      if (fn === 1 && !id) id = str
      else if (fn === 2 && !title) title = str
      else if (fn === 3 && str) authors.push(str)
      else if (fn === 20 && !snippet) snippet = str.slice(0, 300)
      else if (fn === 23 && !journal) journal = str
      else if (fn === 74 && str === 'FULLTEXT') hasFulltext = true
    } else if (wt === 1) {
      q += 8
    } else if (wt === 5) {
      q += 4
    } else {
      break
    }
  }
  if (!id || !title) return null
  return {
    id,
    title,
    authors,
    ...(journal ? { journal } : {}),
    ...(year !== undefined ? { year } : {}),
    ...(snippet ? { snippet } : {}),
    hasFulltext,
  }
}
const PERIODICAL_MARKER = Buffer.from('\x0a\x0aPeriodical\xba\x06', 'latin1')

export function parseWanfangRelatedPaperGrpcResponse(raw: Buffer): ParsedWanfangPaper[] {
  if (raw.length < 5) return []
  const papers: ParsedWanfangPaper[] = []
  const seenIds = new Set<string>()
  let searchPos = 0
  while (searchPos < raw.length) {
    const idx = raw.indexOf(PERIODICAL_MARKER, searchPos)
    if (idx < 0) break
    const lenPos = idx + PERIODICAL_MARKER.length
    const [perioLen, dataStart] = readVarint(raw, lenPos)
    searchPos = lenPos + 1
    if (perioLen <= 0 || dataStart >= raw.length) continue
    const dataEnd = Math.min(raw.length, dataStart + perioLen)
    const parsed = parseSinglePeriodicalProto(raw.subarray(dataStart, dataEnd))
    if (parsed && !seenIds.has(parsed.id)) {
      seenIds.add(parsed.id)
      papers.push(parsed)
      searchPos = dataEnd
    }
  }
  return papers
}
function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function isSafePaperId(paperId: string): boolean {
  if (paperId.length < 3 || paperId.length > 40) return false
  if (paperId.includes('..') || paperId.includes('/') || paperId.includes('\\')) return false
  return /^[^\s\p{Cc}?#]+$/u.test(paperId)
}

export function normalizeSpringerDoi(rawDoi: string): string | null {
  const decoded = rawDoi.trim().replace(/%2F/gi, '/')
  if (decoded.includes('..') || decoded.includes('\\')) return null
  const match = /^(?:10\.)?(\d{4,9})\/([^\s/\\?#\p{Cc}]+)$/u.exec(decoded)
  if (!match?.[1] || !match[2]) return null
  return `10.${match[1]}/${match[2]}`
}

export function normalizeSpringerPaperId(paperId: string): string {
  const trimmed = paperId.trim()
  if (trimmed.includes('..') || trimmed.includes('\\')) return paperId
  const match = /^sp[._](?:10\.)?(\d{4,9})_([^\s/\\?#\p{Cc}]+)$/u.exec(trimmed)
  if (!match?.[1] || !match[2]) return paperId
  return `sp_10.${match[1]}_${match[2]}`
}

export function parseSpringerSearchHtml(html: string, limit: number): ParsedWanfangPaper[] {
  const fullAccessPapers: ParsedWanfangPaper[] = []
  const otherPapers: ParsedWanfangPaper[] = []
  const seenIds = new Set<string>()
  const cardRe = /<li\b[^>]*class="[^"]*app-card-open[^"]*"[\s\S]*?<\/li>/gi
  let m: RegExpExecArray | null
  while ((m = cardRe.exec(html)) !== null) {
    const card = m[0]
    const linkMatch =
      /<h3[^>]*data-test="title"[^>]*>[\s\S]*?<a[^>]*href="[^"]*\/(?:articles?|chapter)\/((?:10\.)?\d{4,9}(?:\/|%2F)[^"'\s?#<>]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(
        card,
      )
    if (!linkMatch?.[1] || !linkMatch[2]) continue
    const doi = normalizeSpringerDoi(linkMatch[1])
    if (!doi) continue
    const paperId = normalizeSpringerPaperId(`sp_${doi.replace(/\//g, '_')}`)
    if (!isSafePaperId(paperId) || seenIds.has(paperId)) {
      continue
    }
    const title = decodeHtmlEntities(
      linkMatch[2]
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    if (!title) continue
    seenIds.add(paperId)
    const entitlementMatch = /<div[^>]*data-test="entitlements"[^>]*>([\s\S]*?)<\/div>/i.exec(card)
    const entitlement = entitlementMatch?.[1]
      ? decodeHtmlEntities(entitlementMatch[1].replace(/<[^>]+>/g, '').trim()).toLowerCase()
      : ''
    const authorsMatch = /<span[^>]*data-test="authors"[^>]*>([\s\S]*?)<\/span>/i.exec(card)
    const authors = authorsMatch?.[1]
      ? decodeHtmlEntities(authorsMatch[1].replace(/<[^>]+>/g, '').trim())
          .split(',')
          .map((a) => a.replace(/\.{2,}/g, '').trim())
          .filter(Boolean)
      : []
    const journalMatch = /<a[^>]*data-test="parent"[^>]*>([\s\S]*?)<\/a>/i.exec(card)
    const journal = journalMatch?.[1]
      ? decodeHtmlEntities(
          journalMatch[1]
            .replace(/<[^>]+>/g, '')
            .replace(/\s+/g, ' ')
            .trim(),
        )
      : 'Springer Nature'
    const pubMatch = /<span[^>]*data-test="published"[^>]*>([\s\S]*?)<\/span>/i.exec(card)
    const yearMatch = pubMatch?.[1] ? /\b(19\d\d|20\d\d)\b/.exec(pubMatch[1]) : null
    const parsedYear = yearMatch?.[1] ? Number(yearMatch[1]) : undefined
    const year =
      parsedYear !== undefined && parsedYear >= 1500 && parsedYear <= 2100 ? parsedYear : undefined
    const descMatch = /<div[^>]*data-test="description"[^>]*>([\s\S]*?)<\/div>/i.exec(card)
    const snippet = descMatch?.[1]
      ? decodeHtmlEntities(
          descMatch[1]
            .replace(/<[^>]+>/g, '')
            .replace(/\s+/g, ' ')
            .trim(),
        ).slice(0, 300)
      : undefined
    const item: ParsedWanfangPaper = {
      id: paperId,
      title,
      authors,
      journal,
      ...(year !== undefined ? { year } : {}),
      ...(snippet ? { snippet } : {}),
      hasFulltext: entitlement.includes('full access') || entitlement.includes('open access'),
    }
    if (entitlement.includes('full access')) {
      fullAccessPapers.push(item)
    } else {
      otherPapers.push(item)
    }
  }
  return [...fullAccessPapers, ...otherPapers].slice(0, limit)
}

/** Springer search page markers (2026-10-22 samples, ocv5-308/g585-upstream-samples.md). */
const SPRINGER_NO_RESULTS_RE = /data-test=["']no-results["']/
const SPRINGER_RESULTS_SHELL_RE = /data-test=["']results-data["']|class="[^"]*app-card-open/

export function isChineseLiteratureQuery(query: string): boolean {
  return /\p{Script=Han}/u.test(query)
}
/**
 * Mints a documentId matching `^[A-Za-z0-9-]{16,128}$` (builtinArtifact opaqueId constraint)
 * bound via HMAC-SHA256 to ownerUserId + accountInstanceId + expiration + paperId.
 */

export function mintScopedDocumentId(
  secret: Buffer,
  input: {
    readonly ownerUserId: string
    readonly accountInstanceId: string
    readonly paperId: string
    readonly title?: string
    readonly nowMs?: number
  },
): string {
  const expMs = (input.nowMs ?? Date.now()) + DOCUMENT_ID_TTL_MS
  const expB36 = Math.floor(expMs).toString(36)
  const canonicalPaperId = normalizeSpringerPaperId(input.paperId)
  const pidHex = Buffer.from(canonicalPaperId, 'utf8').toString('hex')
  const macInput = `v1\0${String(input.ownerUserId ?? 1)}\0${input.accountInstanceId}\0${expB36}\0${pidHex}`
  const macHex = crypto.createHmac('sha256', secret).update(macInput).digest('hex').slice(0, 32)
  return `wfp1-${expB36}-${pidHex}-${macHex}`
}

function verifyDocumentIdHmac(
  secret: Buffer,
  ownerUserId: string,
  accountInstanceId: string,
  expB36: string,
  candidatePidHex: string,
  providedBuf: Buffer,
): boolean {
  const macInput = `v1\0${ownerUserId}\0${accountInstanceId}\0${expB36}\0${candidatePidHex}`
  const expectedMacHex = crypto
    .createHmac('sha256', secret)
    .update(macInput)
    .digest('hex')
    .slice(0, 32)
  const expectedBuf = Buffer.from(expectedMacHex, 'hex')
  return (
    providedBuf.length === expectedBuf.length && crypto.timingSafeEqual(providedBuf, expectedBuf)
  )
}

export function verifyScopedDocumentId(
  secret: Buffer,
  token: string,
  expected: {
    readonly ownerUserId: string
    readonly accountInstanceId: string
    readonly nowMs?: number
  },
): { readonly paperId: string } {
  const parts = token.split('-')
  if (parts.length !== 4 || parts[0] !== 'wfp1') {
    throw new LiteratureError('DOCUMENT_EXPIRED')
  }
  const [, expB36, pidHex, macHex] = parts as [string, string, string, string]
  if (
    !/^[0-9a-z]{1,16}$/.test(expB36) ||
    !/^[0-9a-f]{2,80}$/.test(pidHex) ||
    pidHex.length % 2 !== 0 ||
    !/^[0-9a-f]{32}$/.test(macHex)
  ) {
    throw new LiteratureError('DOCUMENT_EXPIRED')
  }
  const rawPaperId = Buffer.from(pidHex, 'hex').toString('utf8')
  const canonicalPaperId = normalizeSpringerPaperId(rawPaperId)
  const canonicalPidHex =
    canonicalPaperId !== rawPaperId ? Buffer.from(canonicalPaperId, 'utf8').toString('hex') : pidHex
  const providedBuf = Buffer.from(macHex, 'hex')
  const matchesRaw = verifyDocumentIdHmac(
    secret,
    expected.ownerUserId,
    expected.accountInstanceId,
    expB36,
    pidHex,
    providedBuf,
  )
  const matchesCanonical =
    canonicalPidHex !== pidHex &&
    verifyDocumentIdHmac(
      secret,
      expected.ownerUserId,
      expected.accountInstanceId,
      expB36,
      canonicalPidHex,
      providedBuf,
    )
  if (!matchesRaw && !matchesCanonical) {
    throw new LiteratureError('DOCUMENT_EXPIRED')
  }
  const expMs = Number.parseInt(expB36, 36)
  const nowMs = expected.nowMs ?? Date.now()
  if (!Number.isFinite(expMs) || expMs <= nowMs) {
    throw new LiteratureError('DOCUMENT_EXPIRED')
  }
  if (!isSafePaperId(canonicalPaperId)) {
    throw new LiteratureError('DOCUMENT_EXPIRED')
  }
  return { paperId: canonicalPaperId }
}

export interface RawDownstreamResponse {
  readonly statusCode: number
  readonly headers: http.IncomingHttpHeaders
  readonly body: Buffer
}

export type DownstreamHttpRequester = (input: {
  readonly url: URL
  readonly method: 'GET' | 'POST'
  readonly headers: Readonly<Record<string, string>>
  readonly body?: Buffer
  readonly maxBytes: number
  readonly signal: AbortSignal
  /** Reports each egress attempt: proxy (with the fallback reason when abandoned) or direct. */
  readonly onRoute?: (hop: LiteratureEgressHop) => void
}) => Promise<RawDownstreamResponse>
function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      void work.catch(() => {})
      reject(new LiteratureError('TIMEOUT'))
    }, timeoutMs)
    work.then(
      (val) => {
        clearTimeout(timer)
        resolve(val)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}
function parseLoopbackProxyUrl(raw?: string): { hostname: string; port: number } | null {
  const trimmed = raw?.trim()
  if (!trimmed) return null
  try {
    const u = new URL(trimmed)
    if (
      u.protocol !== 'http:' ||
      u.username ||
      u.password ||
      u.hash ||
      (u.pathname && u.pathname !== '/')
    )
      return null
    const host = u.hostname.toLowerCase()
    if (host !== '127.0.0.1' && host !== 'localhost') return null
    const port = Number(u.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null
    return { hostname: host === 'localhost' ? '127.0.0.1' : host, port }
  } catch {
    return null
  }
}

export function createPinnedDownstreamRequester(
  resolver?: DnsResolver,
  hopTimeoutMs = DOWNSTREAM_HOP_TIMEOUT_MS,
  maxTotalTimeoutMs = DOWNSTREAM_MAX_TOTAL_TIMEOUT_MS,
  requestImpl: typeof http.request = http.request,
  proxyUrl = process.env.LITERATURE_DOWNSTREAM_PROXY_URL,
  proxyHeaderTimeoutMs = Math.min(hopTimeoutMs, DOWNSTREAM_PROXY_HEADER_TIMEOUT_MS),
): DownstreamHttpRequester {
  const proxy = parseLoopbackProxyUrl(proxyUrl)
  return async ({ url, method, headers, body, maxBytes, signal, onRoute }) => {
    if (signal.aborted) throw new LiteratureError('CANCELLED')
    const hostname = url.hostname.toLowerCase()
    if (
      url.origin !== WANFANG_WEBVPN_ORIGIN ||
      !ALLOWED_DOWNSTREAM_HOSTS.has(hostname) ||
      url.username ||
      url.password ||
      url.hash ||
      url.protocol !== 'http:'
    ) {
      throw new LiteratureError('OUTBOUND_BLOCKED')
    }
    let pin: Awaited<ReturnType<typeof resolvePinnedAddress>>
    try {
      pin = await abortable(
        withDeadline(resolvePinnedAddress(hostname, resolver), hopTimeoutMs),
        signal,
      )
    } catch (err) {
      if (signal.aborted || (err instanceof LiteratureError && err.code === 'CANCELLED')) {
        throw new LiteratureError('CANCELLED')
      }
      if (err instanceof LiteratureError && err.code === 'TIMEOUT') throw err
      throw new LiteratureError('OUTBOUND_BLOCKED')
    }
    if (signal.aborted) throw new LiteratureError('CANCELLED')
    const port = url.port ? Number(url.port) : 80
    const pinnedLookup = (
      _hostname: string,
      options: unknown,
      cb: (
        err: NodeJS.ErrnoException | null,
        address: string | Array<{ address: string; family: number }>,
        family?: number,
      ) => void,
    ) => {
      if (typeof options === 'object' && options !== null && (options as { all?: boolean }).all) {
        cb(null, [{ address: pin.ip, family: pin.family }])
        return
      }
      cb(null, pin.ip, pin.family)
    }
    const runAttempt = (viaProxy: { hostname: string; port: number } | null) =>
      new Promise<RawDownstreamResponse>((resolve, reject) => {
        let settled = false
        let idleTimer: ReturnType<typeof setTimeout> | undefined
        const finish = (err?: unknown, res?: RawDownstreamResponse) => {
          if (settled) return
          settled = true
          clearTimeout(idleTimer)
          clearTimeout(totalTimer)
          signal.removeEventListener('abort', onAbort)
          if (err) reject(err)
          else resolve(res!)
        }
        const onTimeout = () => {
          req.destroy()
          finish(new LiteratureError('TIMEOUT'))
        }
        const armIdleTimer = (ms = hopTimeoutMs) => {
          clearTimeout(idleTimer)
          idleTimer = setTimeout(onTimeout, ms)
        }
        const onAbort = () => {
          req.destroy()
          finish(new LiteratureError('CANCELLED'))
        }
        armIdleTimer(viaProxy ? Math.min(hopTimeoutMs, proxyHeaderTimeoutMs) : hopTimeoutMs)
        const totalTimer = setTimeout(onTimeout, Math.max(hopTimeoutMs, maxTotalTimeoutMs))
        const req = requestImpl(
          {
            protocol: 'http:',
            hostname: viaProxy ? viaProxy.hostname : url.hostname,
            port: viaProxy ? viaProxy.port : port,
            method,
            path: viaProxy ? url.toString() : `${url.pathname}${url.search}`,
            headers: {
              Host: url.host,
              ...headers,
              ...(body ? { 'Content-Length': String(body.length) } : {}),
            },
            ...(viaProxy ? {} : { lookup: pinnedLookup as never }),
          },
          (res) => {
            armIdleTimer()
            const chunks: Buffer[] = []
            let total = 0
            res.on('data', (chunk: Buffer) => {
              if (chunk.length > 0) armIdleTimer()
              total += chunk.length
              if (total > maxBytes) {
                req.destroy()
                finish(new LiteratureError('RESPONSE_TOO_LARGE'))
                return
              }
              chunks.push(chunk)
            })
            res.on('end', () => {
              finish(undefined, {
                statusCode: res.statusCode ?? 0,
                headers: res.headers,
                body: Buffer.concat(chunks),
              })
            })
            res.on('close', () => {
              if (!settled && !res.complete) {
                finish(
                  signal.aborted
                    ? new LiteratureError('CANCELLED')
                    : new LiteratureError('RESPONSE_INVALID'),
                )
              }
            })
            res.on('error', (err) => finish(err))
          },
        )
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) {
          onAbort()
          return
        }
        req.on('error', () => {
          finish(
            signal.aborted
              ? new LiteratureError('CANCELLED')
              : new LiteratureError('RESPONSE_INVALID'),
          )
        })
        if (body) req.write(body)
        req.end()
      })
    if (proxy) {
      let fallback: LiteratureEgressHop['fallback']
      try {
        const proxyRes = await runAttempt(proxy)
        if (![502, 503, 504].includes(proxyRes.statusCode)) {
          onRoute?.({ via: 'proxy' })
          return proxyRes
        }
        fallback = 'status_5xx'
      } catch (err) {
        if (
          signal.aborted ||
          (err instanceof LiteratureError &&
            (err.code === 'CANCELLED' || err.code === 'RESPONSE_TOO_LARGE'))
        ) {
          onRoute?.({ via: 'proxy' })
          throw err
        }
        fallback = err instanceof LiteratureError && err.code === 'TIMEOUT' ? 'timeout' : 'error'
      }
      onRoute?.({ via: 'proxy', fallback })
    }
    onRoute?.({ via: 'direct' })
    return await runAttempt(null)
  }
}

export interface WanfangLiteratureHttpExecutorOptions {
  readonly artifactStore: LiteratureArtifactStore
  readonly resolver?: DnsResolver
  readonly requester?: DownstreamHttpRequester
  readonly verifyMemberSession?: (
    initialState: JieyouAccountState,
    entryPath: string,
    signal: AbortSignal,
  ) => Promise<JieyouAccountState>
  readonly tokenSecret?: Buffer
  readonly env?: NodeJS.ProcessEnv
  readonly now?: () => number
}

export class WanfangLiteratureHttpExecutor implements LiteratureHttpReadExecutor {
  private readonly artifactStore: LiteratureArtifactStore
  private readonly resolver: DnsResolver | undefined
  private readonly requester: DownstreamHttpRequester
  private readonly verifyMemberSessionOverride?:
    | ((
        initialState: JieyouAccountState,
        entryPath: string,
        signal: AbortSignal,
      ) => Promise<JieyouAccountState>)
    | undefined
  private tokenSecret: Buffer | undefined
  private readonly env: NodeJS.ProcessEnv | undefined
  private readonly now: () => number
  private readonly titleCache = new Map<string, string>()
  constructor(options: WanfangLiteratureHttpExecutorOptions) {
    this.artifactStore = options.artifactStore
    this.resolver = options.resolver
    this.requester = options.requester ?? createPinnedDownstreamRequester(options.resolver)
    this.verifyMemberSessionOverride = options.verifyMemberSession
    this.env = options.env
    this.tokenSecret =
      options.tokenSecret ??
      ((options.env ?? process.env).OPENCLAUDE_KMS_KEY
        ? deriveLiteratureDocumentIdSecret(options.env ?? process.env)
        : undefined)
    this.now = options.now ?? (() => Date.now())
  }
  private resolveTokenSecret(): Buffer {
    if (!this.tokenSecret) {
      this.tokenSecret = deriveLiteratureDocumentIdSecret(this.env ?? process.env)
    }
    return this.tokenSecret
  }
  private buildSearchOutput(
    parsed: ParsedWanfangPaper[],
    pageSize: number,
    page: number,
    input: LiteratureHttpReadExecutionInput,
    storageState: JieyouAccountState,
  ): LiteratureHttpReadExecutionOutput {
    const items: LiteratureHttpSearchItem[] = parsed.slice(0, pageSize).map((item) => {
      this.rememberTitle(item.id, item.title)
      return {
        documentId: mintScopedDocumentId(this.resolveTokenSecret(), {
          ownerUserId: String(input.ownerUserId ?? 1),
          accountInstanceId: input.accountInstanceId,
          paperId: item.id,
          title: item.title,
          nowMs: this.now(),
        }),
        title: item.title.slice(0, 512),
        ...(item.authors.length > 0
          ? { authors: item.authors.slice(0, 20).map((a) => a.slice(0, 128)) }
          : {}),
        ...(item.year !== undefined ? { year: item.year } : {}),
        ...(item.journal ? { source: item.journal.slice(0, 128) } : {}),
        ...(item.snippet ? { snippet: item.snippet.slice(0, 2048) } : {}),
      }
    })
    if (input.trace) {
      input.trace.items = items.length
      input.trace.zeroResult = items.length === 0
    }
    return {
      storageState,
      data: { items, nextPage: items.length >= pageSize && page < 10000 ? page + 1 : 0 },
    }
  }
  private routeRecorder(input: LiteratureHttpReadExecutionInput) {
    const trace = input.trace
    return trace ? (hop: LiteratureEgressHop) => trace.recordHop(hop) : undefined
  }
  private reuseKey(input: LiteratureHttpReadExecutionInput, paperId: string): string {
    return crypto
      .createHash('sha256')
      .update(`${String(input.ownerUserId ?? 1)}\0${input.accountInstanceId}\0${paperId}`)
      .digest('hex')
  }
  private numericUserId(input: LiteratureHttpReadExecutionInput): number {
    return typeof input.userId === 'number' &&
      Number.isSafeInteger(input.userId) &&
      input.userId > 0
      ? input.userId
      : Number(input.ownerUserId) > 0
        ? Number(input.ownerUserId)
        : 1
  }
  private rememberTitle(paperId: string, title: string): void {
    if (this.titleCache.size >= 500) {
      const oldest = this.titleCache.keys().next().value
      if (oldest !== undefined) this.titleCache.delete(oldest)
    }
    this.titleCache.set(paperId, title)
  }
  async executeRead(
    input: LiteratureHttpReadExecutionInput,
  ): Promise<LiteratureHttpReadExecutionOutput> {
    if (input.signal.aborted) throw new LiteratureError('CANCELLED')
    const validState = parseJieyouAccountState(input.storageState)
    if (!hasJieyouMemberAuthCookies(validState)) {
      throw new LiteratureError('SESSION_EXPIRED')
    }
    if (input.actionId === 'search') {
      return await this.executeSearch(input, validState)
    }
    if (input.actionId === 'download') {
      return await this.executeDownload(input, validState)
    }
    throw new LiteratureError('INVALID_INPUT')
  }
  private async verifyMemberSessionOnEntry(
    initialState: JieyouAccountState,
    entryPath: string,
    signal: AbortSignal,
  ): Promise<JieyouAccountState> {
    if (this.verifyMemberSessionOverride) {
      return await this.verifyMemberSessionOverride(initialState, entryPath, signal)
    }
    const client = new JieyouHttpClient(
      new LiteratureHttpTransport(this.resolver ? { resolver: this.resolver } : {}),
      { initialState },
    )
    try {
      const { url, response } = await client.getMemberPage(entryPath, signal)
      const failure = classifyMemberEntryResponse({
        status: response.status,
        url,
        contentType: String(response.headers['content-type'] ?? ''),
        body: response.body,
      })
      if (failure) throw failure
      return client.exportPrivateCookies()
    } finally {
      await client.close()
    }
  }
  private async executeSearch(
    input: LiteratureHttpReadExecutionInput,
    initialState: JieyouAccountState,
  ): Promise<LiteratureHttpReadExecutionOutput> {
    const query = typeof input.params.query === 'string' ? input.params.query.trim() : ''
    if (!query) throw new LiteratureError('INVALID_INPUT')
    const rawPageSize =
      typeof input.params.pageSize === 'number'
        ? input.params.pageSize
        : typeof input.params.limit === 'number'
          ? input.params.limit
          : 10
    const pageSize = Math.max(1, Math.min(20, Math.trunc(rawPageSize)))
    const rawPage = typeof input.params.page === 'number' ? input.params.page : 1
    const page = Math.max(1, Math.min(10000, Math.trunc(rawPage)))
    if (!isChineseLiteratureQuery(query)) {
      return await this.executeEnglishSearch(input, initialState, query, pageSize, page)
    }
    if (input.trace) input.trace.route = 'zh'
    const updatedState = await this.verifyMemberSessionOnEntry(
      initialState,
      JIEYOU_WANFANG_ENTRY_PATH,
      input.signal,
    )
    input.trace?.phase('session')
    const grpcUrl = new URL(WANFANG_WEBVPN_GRPC_PATH, WANFANG_WEBVPN_ORIGIN)
    const grpcFrame = buildWanfangRelatedPaperGrpcFrame(query, pageSize, page)
    const res = await this.requester({
      url: grpcUrl,
      method: 'POST',
      headers: {
        'User-Agent': BROWSER_UA,
        Referer: 'http://www.jieyoutsg.com/',
        Origin: WANFANG_WEBVPN_ORIGIN,
        'Content-Type': 'application/grpc-web+proto',
        'X-Grpc-Web': '1',
        Accept: 'application/grpc-web+proto, */*',
        Cookie: 'authdomain=123123',
      },
      body: grpcFrame,
      maxBytes: 2 * 1024 * 1024,
      signal: input.signal,
      onRoute: this.routeRecorder(input),
    })
    input.trace?.phase('upstream')
    const statusError = upstreamStatusError(res)
    if (statusError) throw statusError
    if (res.statusCode !== 200) {
      throw new LiteratureError('RESPONSE_INVALID')
    }
    // A login/permission/challenge page is not an empty gRPC answer.
    if (isHtmlResponse(res))
      throw upstreamPageError(classifyResponsePage(res), 'LITERATURE_UPSTREAM_CHANGED')
    // Errors arrive as HTTP 200 with a non-zero grpc-status (observed: trailers-only, empty body).
    const grpcError = grpcStatusError(grpcWebStatus(res))
    if (grpcError) throw grpcError
    const parsed = parseWanfangRelatedPaperGrpcResponse(res.body)
    return this.buildSearchOutput(parsed, pageSize, page, input, updatedState)
  }
  private async executeEnglishSearch(
    input: LiteratureHttpReadExecutionInput,
    initialState: JieyouAccountState,
    query: string,
    pageSize: number,
    page: number,
  ): Promise<LiteratureHttpReadExecutionOutput> {
    if (input.trace) input.trace.route = 'en'
    const updatedState = await this.verifyMemberSessionOnEntry(
      initialState,
      JIEYOU_SPRINGER_WEBVPN_ENTRY_PATH,
      input.signal,
    )
    input.trace?.phase('session')
    const searchUrl = new URL(`${SPRINGER_WEBVPN_PREFIX}/search`, WANFANG_WEBVPN_ORIGIN)
    searchUrl.searchParams.set('new-search', 'true')
    searchUrl.searchParams.set('query', query)
    searchUrl.searchParams.set('content-type', 'Article')
    if (page > 1) {
      searchUrl.searchParams.set('page', String(page))
    }
    const res = await this.followUstbWebvpnRedirects(
      searchUrl,
      input.signal,
      2 * 1024 * 1024,
      this.routeRecorder(input),
    )
    input.trace?.phase('upstream')
    const statusError = upstreamStatusError(res)
    if (statusError) throw statusError
    if (res.statusCode !== 200) {
      throw new LiteratureError('RESPONSE_INVALID')
    }
    const html = decodeUpstreamHtml(res.body, String(res.headers['content-type'] ?? ''))
    const parsed = parseSpringerSearchHtml(html, pageSize)
    if (parsed.length === 0) {
      // Only Springer's explicit "no results" block is a real zero; a results shell whose cards no
      // longer parse, or any other page, is reported instead of being shown as zero results.
      if (!SPRINGER_NO_RESULTS_RE.test(html)) {
        if (SPRINGER_RESULTS_SHELL_RE.test(html))
          throw new LiteratureError('LITERATURE_UPSTREAM_CHANGED')
        throw upstreamPageError(classifyResponsePage(res), 'LITERATURE_UPSTREAM_CHANGED')
      }
    }
    return this.buildSearchOutput(parsed, pageSize, page, input, updatedState)
  }
  private async executeDownload(
    input: LiteratureHttpReadExecutionInput,
    initialState: JieyouAccountState,
  ): Promise<LiteratureHttpReadExecutionOutput> {
    const rawDocId =
      typeof input.params.documentId === 'string' ? input.params.documentId.trim() : ''
    if (!rawDocId) throw new LiteratureError('INVALID_INPUT')
    const { paperId } = verifyScopedDocumentId(this.resolveTokenSecret(), rawDocId, {
      ownerUserId: String(input.ownerUserId ?? 1),
      accountInstanceId: input.accountInstanceId,
      nowMs: this.now(),
    })
    const title = this.titleCache.get(paperId) ?? paperId
    if (input.trace) input.trace.route = paperId.startsWith('sp_') ? 'en' : 'zh'
    // Same owner, same account instance, same paper: hand out the verified file again instead of
    // downloading it upstream and taking more of the artifact budget.
    const reused = this.artifactStore.reuse(
      this.numericUserId(input),
      this.reuseKey(input, paperId),
    )
    if (reused) {
      if (input.trace) input.trace.download = { bytes: reused.result.bytes, reused: true }
      return {
        storageState: initialState,
        stagedArtifact: reused,
        data: {
          artifactId: reused.result.artifactId,
          filename: reused.result.filename,
          mimeType: reused.result.mimeType,
          bytes: reused.result.bytes,
        },
      }
    }
    if (paperId.startsWith('sp_')) {
      return await this.executeEnglishSpringerDownload(input, initialState, paperId, title)
    }
    const updatedState = await this.verifyMemberSessionOnEntry(
      initialState,
      JIEYOU_WANFANG_ENTRY_PATH,
      input.signal,
    )
    input.trace?.phase('session')
    const hop1Url = new URL(
      `${WANFANG_WEBVPN_DOWNLOAD_PREFIX}${encodeURIComponent(paperId)}.aspx`,
      WANFANG_WEBVPN_ORIGIN,
    )
    const getVpn = (url: URL, maxBytes: number, ref = `${WANFANG_WEBVPN_ORIGIN}/`) =>
      this.requester({
        url,
        method: 'GET',
        headers: { 'User-Agent': BROWSER_UA, Referer: ref, Cookie: 'authdomain=123123' },
        maxBytes,
        signal: input.signal,
        onRoute: this.routeRecorder(input),
      })
    // Every hop without a Location is classified the same way (401/403/429 and recognised pages);
    // an unrecognised page keeps the historical "no usable PDF" meaning below.
    const nextHop = (res: RawDownstreamResponse): string => {
      const location = typeof res.headers.location === 'string' ? res.headers.location : ''
      if (location) return location
      const statusError = upstreamStatusError(res)
      if (statusError) throw statusError
      if (isHtmlResponse(res)) {
        const kind = classifyResponsePage(res)
        if (kind !== 'unknown') throw upstreamPageError(kind, 'RESPONSE_INVALID')
      }
      return ''
    }
    const hop1Res = await getVpn(hop1Url, 256 * 1024, 'http://www.jieyoutsg.com/')
    let transactionId = ''
    let nextLocation = nextHop(hop1Res)
    for (let hop = 0; hop < 4 && nextLocation; hop++) {
      const nextUrl = new URL(nextLocation, WANFANG_WEBVPN_ORIGIN)
      if (nextUrl.origin !== WANFANG_WEBVPN_ORIGIN) {
        throw new LiteratureError('OUTBOUND_BLOCKED')
      }
      const txParam = nextUrl.searchParams.get('transaction')
      if (txParam) {
        transactionId = txParam
        break
      }
      const hopRes = await getVpn(nextUrl, 256 * 1024)
      nextLocation = nextHop(hopRes)
    }
    if (!transactionId) {
      throw new LiteratureError('RESPONSE_INVALID')
    }
    const fulltextUrl = new URL(WANFANG_WEBVPN_FULLTEXT_PREFIX, WANFANG_WEBVPN_ORIGIN)
    fulltextUrl.searchParams.set('type', 'perio')
    fulltextUrl.searchParams.set('resourceId', paperId)
    fulltextUrl.searchParams.set('transaction', transactionId)
    const pdfRes = await getVpn(fulltextUrl, LITERATURE_ARTIFACT_MAX_BYTES)
    input.trace?.phase('upstream')
    return await this.stagePdfResponse(input, updatedState, pdfRes, title, paperId)
  }
  private async followUstbWebvpnRedirects(
    initialUrl: URL,
    signal: AbortSignal,
    maxBytes: number,
    onRoute?: (hop: LiteratureEgressHop) => void,
  ): Promise<RawDownstreamResponse> {
    let currentUrl = initialUrl
    for (let hop = 0; hop < 6; hop++) {
      const res = await this.requester({
        url: currentUrl,
        method: 'GET',
        headers: {
          'User-Agent': BROWSER_UA,
          Referer: `${WANFANG_WEBVPN_ORIGIN}/`,
          Cookie: 'authdomain=123123',
        },
        maxBytes,
        signal,
        ...(onRoute ? { onRoute } : {}),
      })
      if (res.statusCode >= 300 && res.statusCode < 400) {
        const loc = typeof res.headers.location === 'string' ? res.headers.location : ''
        if (!loc) throw new LiteratureError('RESPONSE_INVALID')
        const nextUrl = new URL(loc, currentUrl)
        if (nextUrl.origin !== WANFANG_WEBVPN_ORIGIN) {
          throw new LiteratureError('OUTBOUND_BLOCKED')
        }
        currentUrl = nextUrl
        continue
      }
      return res
    }
    throw new LiteratureError('OUTBOUND_BLOCKED')
  }
  private async executeEnglishSpringerDownload(
    input: LiteratureHttpReadExecutionInput,
    initialState: JieyouAccountState,
    paperId: string,
    title: string,
  ): Promise<LiteratureHttpReadExecutionOutput> {
    const normalizedPaperId = normalizeSpringerPaperId(paperId)
    const rawDoi = normalizedPaperId.slice(3)
    const slashIdx = rawDoi.indexOf('_')
    if (slashIdx <= 0 || slashIdx === rawDoi.length - 1) {
      throw new LiteratureError('INVALID_INPUT')
    }
    const doi = normalizeSpringerDoi(`${rawDoi.slice(0, slashIdx)}/${rawDoi.slice(slashIdx + 1)}`)
    if (!doi) {
      throw new LiteratureError('INVALID_INPUT')
    }
    const updatedState = await this.verifyMemberSessionOnEntry(
      initialState,
      JIEYOU_SPRINGER_WEBVPN_ENTRY_PATH,
      input.signal,
    )
    input.trace?.phase('session')
    const onRoute = this.routeRecorder(input)
    const pdfUrl = new URL(
      `${SPRINGER_WEBVPN_PREFIX}/content/pdf/${doi}.pdf`,
      WANFANG_WEBVPN_ORIGIN,
    )
    let pdfRes = await this.requester({
      url: pdfUrl,
      method: 'GET',
      headers: {
        'User-Agent': BROWSER_UA,
        Referer: `${WANFANG_WEBVPN_ORIGIN}${SPRINGER_WEBVPN_PREFIX}/article/${doi}`,
        Cookie: 'authdomain=123123',
      },
      maxBytes: LITERATURE_ARTIFACT_MAX_BYTES,
      signal: input.signal,
      ...(onRoute ? { onRoute } : {}),
    })
    if (pdfRes.statusCode >= 300 && pdfRes.statusCode < 400) {
      const warmSearchUrl = new URL(`${SPRINGER_WEBVPN_PREFIX}/search`, WANFANG_WEBVPN_ORIGIN)
      warmSearchUrl.searchParams.set('new-search', 'true')
      warmSearchUrl.searchParams.set('query', doi)
      warmSearchUrl.searchParams.set('content-type', 'Article')
      await this.followUstbWebvpnRedirects(warmSearchUrl, input.signal, 2 * 1024 * 1024, onRoute)
      pdfRes = await this.followUstbWebvpnRedirects(
        pdfUrl,
        input.signal,
        LITERATURE_ARTIFACT_MAX_BYTES,
        onRoute,
      )
    }
    input.trace?.phase('upstream')
    return await this.stagePdfResponse(input, updatedState, pdfRes, title, paperId)
  }
  private async stagePdfResponse(
    input: LiteratureHttpReadExecutionInput,
    updatedState: JieyouAccountState,
    pdfRes: RawDownstreamResponse,
    title: string,
    fallbackId: string,
  ): Promise<LiteratureHttpReadExecutionOutput> {
    const statusError = upstreamStatusError(pdfRes)
    if (statusError) throw statusError
    if (pdfRes.statusCode !== 200) {
      throw new LiteratureError('RESPONSE_INVALID')
    }
    // An HTML answer is only a login problem when it is a login page; an unsubscribed article's
    // landing page is LITERATURE_NO_ACCESS and must not re-login or mark the account for relink.
    if (isHtmlResponse(pdfRes))
      throw upstreamPageError(classifyResponsePage(pdfRes), 'RESPONSE_INVALID')
    const safeTitle =
      title
        .replace(/[\\/:*?"<>|\r\n]+/g, '_')
        .trim()
        .slice(0, 200) || fallbackId
    const filename = safeTitle.toLowerCase().endsWith('.pdf') ? safeTitle : `${safeTitle}.pdf`
    let staged: StagedLiteratureArtifact
    try {
      staged = await this.artifactStore.stagePdf({
        userId: this.numericUserId(input),
        filename,
        data: pdfRes.body,
        signal: input.signal,
        reuseKey: this.reuseKey(input, fallbackId),
      })
    } catch (error) {
      if (input.trace && error instanceof LiteratureError && error.code === 'RESPONSE_INVALID')
        input.trace.download = { bytes: pdfRes.body.length, pdfValid: false, reused: false }
      throw error
    } finally {
      input.trace?.phase('stage')
    }
    if (input.trace)
      input.trace.download = { bytes: staged.result.bytes, pdfValid: true, reused: false }
    return {
      storageState: updatedState,
      stagedArtifact: staged,
      data: {
        artifactId: staged.result.artifactId,
        filename: staged.result.filename,
        mimeType: staged.result.mimeType,
        bytes: staged.result.bytes,
      },
    }
  }
}
