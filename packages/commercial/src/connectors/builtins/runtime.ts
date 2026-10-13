/**
 * 连接器平台 · builtin 实现(元数据与信任边界见 `./registry.ts`,OCV5-402)。
 *
 * B 站部分改写自 dream-star-end/agent-plugins `bili/bili.py`(MIT,Copyright (c) 2026
 * ths-plugin contributors;许可全文见 `../official/THIRD_PARTY_NOTICES.md`):WBI mixin 表与
 * 签名步骤、buvid 指纹的获取方式、弹幕 raw deflate 的处理。
 *
 * 不变量:
 *   - 这里**没有任何用户凭据**。WBI 密钥与 buvid 是平台以匿名身份从同一 origin 公开接口拿的设备指纹,
 *     按 origin 缓存在进程内,不进日志、不进结果。
 *   - 所有出网都走 `pinnedHttpsFetch`(同一套 DNS/IP pin、禁 redirect、超时),而且只打到契约已
 *     审签、且属于该 builtin 允许范围的那个 origin。
 *   - 解压与解析都有字节上限;解析只用正则取固定结构,不引 XML 解析器。
 */

import { createHash } from 'node:crypto'
import { gunzipSync, inflateRawSync, inflateSync } from 'node:zlib'
import type { CanonicalRequestPlan } from '../engine/requestPlan.js'
import { ConnectorError } from '../errors.js'
import { type DnsResolver, pinnedHttpsFetch } from '../outboundPolicy.js'
import { readBoundedBody, readBoundedJson } from '../providers/shared.js'
import { BILIBILI_API_ORIGIN } from './registry.js'

export interface BuiltinDeps {
  resolver?: DnsResolver
  fetchImpl?: (input: string, init: Record<string, unknown>) => Promise<Response>
  /** 测试注入时钟(毫秒)。 */
  now?: () => number
}

export interface RequestBuiltinImpl {
  /** 返回改写后的 plan(只追加 query / 设置 Cookie 头;不改 method/origin/path)。 */
  prepare(plan: CanonicalRequestPlan, deps: BuiltinDeps): Promise<CanonicalRequestPlan>
  /** 2xx 响应体是否表示被上游风控拦截(调用方作废缓存后最多重试一次)。 */
  isRiskBlocked(raw: unknown): boolean
  /** 非 2xx 状态是否是风控(如 412)。 */
  isRiskStatus(status: number): boolean
  /** 作废该 origin 的缓存(密钥、指纹)。 */
  invalidate(origin: string): void
}

export interface ResultBuiltinImpl {
  /** 读取并解析 2xx 响应体(替代默认的 readBoundedJson)。 */
  read(res: Response, providerTag: string): Promise<unknown>
}

// ─── bilibili-wbi ──────────────────────────────────────────────────────────

const MIXIN_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
  14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54,
  21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
] as const

/** WBI 密钥最长缓存时间(B 站按天轮换;6 小时内重取一次足够)。 */
export const WBI_KEY_TTL_MS = 6 * 60 * 60 * 1000
/** 匿名设备指纹最长缓存时间。 */
export const BUVID_TTL_MS = 24 * 60 * 60 * 1000
/** nav / spi 响应体上限(实测 <1KB)。 */
const AUX_JSON_MAX_BYTES = 64 * 1024
const KEY_RE = /^[0-9a-f]{32}$/
const BUVID_RE = /^[A-Za-z0-9%=._-]{8,200}$/
/** B 站风控相关业务码:-352 风控校验失败、-412 请求被拦截、-799 请求过于频繁。 */
const RISK_CODES: ReadonlySet<number> = new Set([-352, -412, -799])

/** img_key + sub_key → 32 位 mixin key。 */
export function wbiMixinKey(imgKey: string, subKey: string): string {
  const raw = imgKey + subKey
  return MIXIN_TABLE.map((i) => raw[i] ?? '')
    .join('')
    .slice(0, 32)
}

/** 与 B 站前端一致的 component 编码(encodeURIComponent,空格为 %20)。 */
function encodeComponent(s: string): string {
  return encodeURIComponent(s)
}

/**
 * 对 query 做 WBI 签名,返回完整 query 字符串(含 wts 与 w_rid)。
 * 步骤:加 wts → 按键名排序 → 值里去掉 `!'()*` → 编码拼接 → md5(query + mixinKey)。
 */
export function wbiSignQuery(
  query: ReadonlyArray<readonly [string, string]>,
  mixinKey: string,
  wts: number,
): string {
  const map = new Map<string, string>()
  for (const [k, v] of query) {
    if (k === 'wts' || k === 'w_rid') continue
    map.set(k, v)
  }
  map.set('wts', String(wts))
  const keys = [...map.keys()].sort()
  const qs = keys
    .map(
      (k) => `${encodeComponent(k)}=${encodeComponent((map.get(k) ?? '').replace(/[!'()*]/g, ''))}`,
    )
    .join('&')
  const wRid = createHash('md5')
    .update(qs + mixinKey)
    .digest('hex')
  return `${qs}&w_rid=${wRid}`
}

interface WbiCacheEntry {
  mixinKey?: string
  keysAt?: number
  buvid3?: string
  buvid4?: string
  buvidAt?: number
  inflight?: Promise<void>
}

const wbiCache = new Map<string, WbiCacheEntry>()

/** 测试用:清空进程内缓存。 */
export function __resetBilibiliWbiCacheForTests(): void {
  wbiCache.clear()
}

function auxHeaders(plan: CanonicalRequestPlan): Record<string, string> {
  // nav / spi 用与主请求相同的 UA / Referer(审签过的 staticHeaders),不额外发明头。
  const out: Record<string, string> = { Accept: 'application/json' }
  for (const [k, v] of Object.entries(plan.headers)) {
    const lower = k.toLowerCase()
    if (lower === 'user-agent' || lower === 'referer') out[k] = v
  }
  return out
}

async function fetchAuxJson(
  origin: string,
  path: string,
  headers: Record<string, string>,
  deps: BuiltinDeps,
): Promise<Record<string, unknown>> {
  let res: Response
  try {
    res = await pinnedHttpsFetch(
      new URL(`${origin}${path}`),
      { method: 'GET', headers },
      { resolver: deps.resolver, fetchImpl: deps.fetchImpl },
    )
  } catch {
    throw new ConnectorError('UPSTREAM_ERROR', 'bilibili-wbi: auxiliary request failed')
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    if (res.status === 412)
      throw new ConnectorError('UPSTREAM_RATE_LIMITED', 'B 站风控拦截(412),请稍后再试')
    throw new ConnectorError('UPSTREAM_ERROR', `bilibili-wbi: auxiliary HTTP ${res.status}`)
  }
  const raw = await readBoundedJson(res, AUX_JSON_MAX_BYTES, 'bilibili-wbi')
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new ConnectorError('UPSTREAM_ERROR', 'bilibili-wbi: auxiliary response is not an object')
  return raw as Record<string, unknown>
}

/** `https://i0.hdslb.com/bfs/wbi/<key>.png` → `<key>`。 */
function keyFromUrl(u: unknown): string | null {
  if (typeof u !== 'string') return null
  const base = u.slice(u.lastIndexOf('/') + 1)
  const dot = base.indexOf('.')
  const key = dot >= 0 ? base.slice(0, dot) : base
  return KEY_RE.test(key) ? key : null
}

async function refreshEntry(
  origin: string,
  entry: WbiCacheEntry,
  plan: CanonicalRequestPlan,
  deps: BuiltinDeps,
): Promise<void> {
  const now = (deps.now ?? Date.now)()
  const headers = auxHeaders(plan)
  if (!entry.mixinKey || entry.keysAt === undefined || now - entry.keysAt > WBI_KEY_TTL_MS) {
    const nav = await fetchAuxJson(origin, '/x/web-interface/nav', headers, deps)
    // 未登录时 code=-101,但 data.wbi_img 照样返回 —— 这里只要密钥。
    const data = nav.data as { wbi_img?: { img_url?: unknown; sub_url?: unknown } } | undefined
    const img = keyFromUrl(data?.wbi_img?.img_url)
    const sub = keyFromUrl(data?.wbi_img?.sub_url)
    if (img === null || sub === null)
      throw new ConnectorError('UPSTREAM_ERROR', 'bilibili-wbi: wbi keys missing in nav response')
    entry.mixinKey = wbiMixinKey(img, sub)
    entry.keysAt = now
  }
  if (!entry.buvid3 || entry.buvidAt === undefined || now - entry.buvidAt > BUVID_TTL_MS) {
    const spi = await fetchAuxJson(origin, '/x/frontend/finger/spi', headers, deps)
    const data = spi.data as { b_3?: unknown; b_4?: unknown } | undefined
    const b3 = typeof data?.b_3 === 'string' && BUVID_RE.test(data.b_3) ? data.b_3 : null
    const b4 = typeof data?.b_4 === 'string' && BUVID_RE.test(data.b_4) ? data.b_4 : null
    if (b3 === null)
      throw new ConnectorError('UPSTREAM_ERROR', 'bilibili-wbi: buvid missing in spi response')
    entry.buvid3 = b3
    entry.buvid4 = b4 ?? undefined
    entry.buvidAt = now
  }
}

function entryIsFresh(entry: WbiCacheEntry, now: number): boolean {
  return (
    entry.mixinKey !== undefined &&
    entry.keysAt !== undefined &&
    now - entry.keysAt <= WBI_KEY_TTL_MS &&
    entry.buvid3 !== undefined &&
    entry.buvidAt !== undefined &&
    now - entry.buvidAt <= BUVID_TTL_MS
  )
}

const bilibiliWbi: RequestBuiltinImpl = {
  async prepare(plan, deps) {
    if (plan.origin !== BILIBILI_API_ORIGIN)
      throw new ConnectorError(
        'OUTBOUND_BLOCKED',
        'bilibili-wbi only runs against api.bilibili.com',
      )
    let entry = wbiCache.get(plan.origin)
    if (entry === undefined) {
      entry = {}
      wbiCache.set(plan.origin, entry)
    }
    const now = (deps.now ?? Date.now)()
    if (!entryIsFresh(entry, now)) {
      // 单飞:同一 origin 的并发请求共用一次刷新。
      if (entry.inflight === undefined) {
        const e = entry
        e.inflight = refreshEntry(plan.origin, e, plan, deps).finally(() => {
          e.inflight = undefined
        })
      }
      await entry.inflight
    }
    const mixinKey = entry.mixinKey
    const buvid3 = entry.buvid3
    if (mixinKey === undefined || buvid3 === undefined)
      throw new ConnectorError('UPSTREAM_ERROR', 'bilibili-wbi: signing material unavailable')
    const wts = Math.floor((deps.now ?? Date.now)() / 1000)
    const qs = wbiSignQuery(plan.query, mixinKey, wts)
    const cookie = entry.buvid4 ? `buvid3=${buvid3}; buvid4=${entry.buvid4}` : `buvid3=${buvid3}`
    const headers = { ...plan.headers }
    for (const k of Object.keys(headers)) if (k.toLowerCase() === 'cookie') delete headers[k]
    headers.Cookie = cookie
    const query = qs.split('&').map((pair) => {
      const i = pair.indexOf('=')
      return [decodeURIComponent(pair.slice(0, i)), decodeURIComponent(pair.slice(i + 1))] as [
        string,
        string,
      ]
    })
    return { ...plan, query, targetUrl: `${plan.origin}${plan.path}?${qs}`, headers }
  },
  isRiskBlocked(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false
    const code = (raw as { code?: unknown }).code
    return typeof code === 'number' && RISK_CODES.has(code)
  },
  isRiskStatus(status) {
    return status === 412
  },
  invalidate(origin) {
    wbiCache.delete(origin)
  },
}

// ─── bilibili-dm-xml ───────────────────────────────────────────────────────

/** 压缩体上限(实测单视频弹幕 <200KB)。 */
const DM_COMPRESSED_MAX_BYTES = 4 * 1024 * 1024
/** 解压后上限(防压缩炸弹)。 */
export const DM_INFLATED_MAX_BYTES = 8 * 1024 * 1024
/** 结果条目上限(与引擎结果硬限 RESULT_MAX_ARRAY 一致)。 */
export const DM_MAX_ITEMS = 200
const DM_TEXT_MAX = 100
const DM_DENSITY_BUCKETS = 60

function inflateDm(buf: Buffer): Buffer {
  const opts = { maxOutputLength: DM_INFLATED_MAX_BYTES }
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return gunzipSync(buf, opts)
  const head = buf.subarray(0, 64).toString('utf8').trimStart()
  if (head.startsWith('<')) {
    if (buf.length > DM_INFLATED_MAX_BYTES)
      throw new ConnectorError('RESULT_TOO_LARGE', 'danmaku xml exceeds cap')
    return buf
  }
  try {
    return inflateRawSync(buf, opts)
  } catch (e) {
    if ((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw e
    return inflateSync(buf, opts)
  }
}

const XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

function decodeXmlText(s: string): string {
  return (
    s
      .replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-z]{2,4});/g, (m, ent: string) => {
        if (ent.startsWith('#x') || ent.startsWith('#')) {
          const cp = ent.startsWith('#x') ? Number.parseInt(ent.slice(2), 16) : Number(ent.slice(1))
          if (!Number.isInteger(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff))
            return ''
          return String.fromCodePoint(cp)
        }
        return XML_ENTITIES[ent] ?? m
      })
      // biome-ignore lint/suspicious/noControlCharactersInRegex: strip control chars from upstream text
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
  )
}

export interface DanmakuItem {
  t: number
  text: string
  sentAt: number | null
}

/** 解析弹幕 XML(只认 `<d p="…">文本</d>`)。导出供单测。 */
export function parseDanmakuXml(xml: string): {
  cid: number | null
  total: number
  sampled: boolean
  maxT: number
  density: number[]
  items: DanmakuItem[]
} {
  const chat = /<chatid>(\d{1,20})<\/chatid>/.exec(xml)
  const all: DanmakuItem[] = []
  for (const m of xml.matchAll(/<d p="([^"]{1,256})">([^<]{0,2000})<\/d>/g)) {
    const fields = (m[1] ?? '').split(',')
    const t = Number(fields[0])
    if (!Number.isFinite(t) || t < 0) continue
    const sent = Number(fields[4])
    const text = decodeXmlText(m[2] ?? '').slice(0, DM_TEXT_MAX)
    if (text.length === 0) continue
    all.push({
      t: Math.round(t * 10) / 10,
      text,
      sentAt: Number.isInteger(sent) && sent > 0 ? sent : null,
    })
  }
  all.sort((a, b) => a.t - b.t)
  const maxT = all.length > 0 ? (all[all.length - 1]?.t ?? 0) : 0
  const density = new Array<number>(all.length > 0 ? DM_DENSITY_BUCKETS : 0).fill(0)
  if (all.length > 0) {
    const span = Math.max(maxT, 1)
    for (const it of all) {
      const b = Math.min(DM_DENSITY_BUCKETS - 1, Math.floor((it.t / span) * DM_DENSITY_BUCKETS))
      density[b] = (density[b] ?? 0) + 1
    }
  }
  let items = all
  let sampled = false
  if (all.length > DM_MAX_ITEMS) {
    sampled = true
    items = []
    for (let i = 0; i < DM_MAX_ITEMS; i += 1) {
      const it = all[Math.floor((i * all.length) / DM_MAX_ITEMS)]
      if (it) items.push(it)
    }
  }
  const cidNum = chat ? Number(chat[1]) : Number.NaN
  return {
    cid: Number.isSafeInteger(cidNum) ? cidNum : null,
    total: all.length,
    sampled,
    maxT,
    density,
    items,
  }
}

const bilibiliDmXml: ResultBuiltinImpl = {
  async read(res, providerTag) {
    const buf = await readBoundedBody(res, DM_COMPRESSED_MAX_BYTES, providerTag)
    let xmlBuf: Buffer
    try {
      xmlBuf = inflateDm(buf)
    } catch (e) {
      if ((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' || e instanceof ConnectorError)
        throw new ConnectorError('RESULT_TOO_LARGE', 'danmaku payload exceeds cap')
      throw new ConnectorError('UPSTREAM_ERROR', `${providerTag} danmaku payload undecodable`)
    }
    return { code: 0, ...parseDanmakuXml(xmlBuf.toString('utf8')) }
  },
}

// ─── 分派 ─────────────────────────────────────────────────────────────────

const REQUEST_IMPLS: ReadonlyMap<string, RequestBuiltinImpl> = new Map([
  ['bilibili-wbi', bilibiliWbi],
])
const RESULT_IMPLS: ReadonlyMap<string, ResultBuiltinImpl> = new Map([
  ['bilibili-dm-xml', bilibiliDmXml],
])

export function requestBuiltin(id: string): RequestBuiltinImpl {
  const impl = REQUEST_IMPLS.get(id)
  if (impl === undefined)
    throw new ConnectorError('BAD_REQUEST', `request builtin ${id} is not implemented`)
  return impl
}

export function resultBuiltin(id: string): ResultBuiltinImpl {
  const impl = RESULT_IMPLS.get(id)
  if (impl === undefined)
    throw new ConnectorError('BAD_REQUEST', `result builtin ${id} is not implemented`)
  return impl
}

/** 测试用:实现表与白名单一一对应。 */
export function implementedBuiltinIds(): string[] {
  return [...REQUEST_IMPLS.keys(), ...RESULT_IMPLS.keys()]
}
