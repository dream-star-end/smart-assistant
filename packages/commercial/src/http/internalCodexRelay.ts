/**
 * V3 commercial Codex API relay (master side).
 *
 * Platform-managed Codex traffic is forced through:
 *   Codex CLI → container gateway loopback relay → master internal relay →
 *   codex account egress proxy → upstream OpenAI-compatible endpoint.
 *
 * This keeps proxy credentials out of user containers and makes egress
 * account-bound and fail-closed. Unknown/misconfigured proxy state never falls
 * back to master direct egress or process-global HTTP_PROXY.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Dispatcher } from 'undici'
import sharp from 'sharp'
import { compositeImageEdit, compositeImageOutpaint, isOutpaintAspect, type OutpaintAspect, prepareImageEdit, prepareImageOutpaint, type ImageEditJob } from '@openclaude/gateway'
import type { Pool } from 'pg'

import { rootLogger, type Logger } from '../logging/logger.js'
import { getRuntimeChannel } from '../runtimeChannel.js'
import {
  REQUEST_ID_HEADER,
  ensureRequestId,
  setSecurityHeaders,
} from './util.js'
import {
  ContainerIdentityError,
  verifyContainerIdentity,
  type ContainerIdentityRepo,
} from '../auth/containerIdentity.js'
import {
  CodexEgressError,
  resolveCodexAccountEgressDispatcher,
} from '../account-pool/codexEgress.js'
import { query } from '../db/queries.js'
import {
  markRelayCredentialFailure,
  markRelayCredentialSuccess,
  resolveCodexRouteContext,
  type ResolvedCodexRouteContext,
} from '../account-pool/groups.js'
import { getCodexTokenSnapshot } from '../account-pool/store.js'
import { zeroBuffer } from '../crypto/keys.js'
import type { PreCheckRedis, ReservationHandle } from '../billing/preCheck.js'
import { preCheckExactCost, releasePreCheck, InsufficientCreditsError as PreCheckInsufficientCreditsError } from '../billing/preCheck.js'
import { IMAGE2_UNIT_COST, ImageDailyLimitError, bindImageInputHash, getCompletedImageUsage, markImageUsage, reserveImageUsage, settleImageCharge } from '../billing/imageBilling.js'
import { InsufficientCreditsError as LedgerInsufficientCreditsError } from '../billing/ledger.js'

export const CODEX_RELAY_PREFIX = '/internal/v3/codex-relay'
export const CODEX_UPSTREAM_AUTH_HEADER = 'x-openclaude-upstream-authorization'

/** official_oauth 数据面的专用上游常量(方案 A3d/B5):代码内固定,不依赖
 *  OC_CODEX_UPSTREAM_BASE_URL env(那是 api_relay 遗产键,v5 部署已删)。
 *  对应容器 loopback base path = `${CODEX_RELAY_PREFIX}/backend-api/codex`
 *  (codexRelayBasePathForUpstream 既有拼法),与 gateway 侧
 *  CODEX_OFFICIAL_RELAY_BASE_PATH 常量成对 —— parity 由单测锁定。 */
export const CODEX_OFFICIAL_UPSTREAM_BASE_URL = 'https://chatgpt.com/backend-api/codex'

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const SAFE_UPSTREAM_REQUEST_HEADERS = new Set([
  'accept',
  'accept-language',
  'content-type',
  'openai-beta',
  'openai-organization',
  'openai-project',
  'user-agent',
  // chatgpt.com/backend-api/codex(official_oauth 数据面)必需的非敏感请求元数据:
  // codex CLI 在 ChatGPT auth 模式下随请求发送 chatgpt-account-id(选择 workspace)、
  // originator / session_id / conversation_id(客户端指纹与会话关联)。均非凭证。
  'chatgpt-account-id',
  'originator',
  'session_id',
  'conversation_id',
  // Codex 0.144+ uses these headers for within-turn sticky routing and the
  // Responses Lite request path. They contain routing state/capability only;
  // broader client-correlation headers intentionally remain blocked.
  'x-codex-turn-state',
  'x-openai-internal-codex-responses-lite',
])

export interface CodexRelayCtx {
  hostUuid: string
  boundIp: string
}

export type CodexRelayHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: CodexRelayCtx,
) => Promise<void>

export interface CodexRelayBindingRow {
  codexAccountId: bigint | null
  userId: bigint
  state: string
  provider: string | null
  accountStatus: string | null
}

export interface CodexRelayDb {
  readContainerBinding(containerId: number): Promise<CodexRelayBindingRow | null>
}

export interface CodexRelayDispatcherInfo {
  accountId: bigint
  proxyId: bigint
  dispatcher: Dispatcher
}

export interface CodexRelayDeps {
  identityRepo: ContainerIdentityRepo
  db: CodexRelayDb
  upstreamBaseUrl?: string
  resolveDispatcher?: (accountId: bigint) => Promise<CodexRelayDispatcherInfo>
  resolveRouteContext?: typeof resolveCodexRouteContext
  markCredentialFailure?: typeof markRelayCredentialFailure
  markCredentialSuccess?: typeof markRelayCredentialSuccess
  /** 非 route 路径的 fallback 代注(方案 B5/3b):仅当容器没带上游 Authorization
   *  时,按绑定账号读当前 access token 代注。返回 Buffer 由 handler 用后清零。
   *  返回 null / 抛错 → 503 fail-closed(不静默直连、不裸转发)。 */
  readBoundAccountAccessToken?: (accountId: bigint) => Promise<Buffer | null>
  fetchImpl?: typeof fetch
  logger?: Logger
  pgPool?: Pool
  preCheckRedis?: PreCheckRedis
  onImageCharge?: (userId: bigint, payload: { costCredits: string; balanceAfter: string | null }) => void
  image2Enabled?: boolean
}

function sendJsonError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  requestId: string,
): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify({ error: { code, message }, requestId }))
}

function normalizeBasePath(upstreamBaseUrl: string): string {
  const u = new URL(upstreamBaseUrl)
  const p = u.pathname.replace(/\/+$/, '')
  return p === '/' ? '' : p
}

export function codexRelayBasePathForUpstream(upstreamBaseUrl: string): string {
  return `${CODEX_RELAY_PREFIX}${normalizeBasePath(upstreamBaseUrl)}`
}

export function readCodexUpstreamBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const fromDedicated = env.OC_CODEX_UPSTREAM_BASE_URL?.trim()
  if (fromDedicated) return fromDedicated
  const fromLegacy = env.OC_CODEX_BASE_URL?.trim()
  if (fromLegacy) return fromLegacy
  return 'https://api.openai.com/v1'
}

export function buildCodexRelayLocalBaseUrl(
  localOrigin: string,
  upstreamBaseUrl: string,
): string {
  return `${localOrigin.replace(/\/+$/, '')}${codexRelayBasePathForUpstream(upstreamBaseUrl)}`
}

function validateRelaySuffix(method: string, suffixRaw: string): { ok: true } | { ok: false; status: number; code: string; message: string } {
  const suffix = suffixRaw.length === 0 ? '/' : suffixRaw
  let decoded: string
  try {
    decoded = decodeURIComponent(suffix)
  } catch {
    return { ok: false, status: 400, code: 'BAD_PATH', message: 'malformed relay path encoding' }
  }
  if (
    decoded.includes('..')
    || decoded.includes('\\')
    || decoded.startsWith('//')
    || decoded.includes('\u0000')
  ) {
    return { ok: false, status: 400, code: 'BAD_PATH', message: 'unsafe relay path' }
  }

  if (method === 'POST' && decoded === '/responses') return { ok: true }
  if ((method === 'GET' || method === 'POST' || method === 'DELETE') && /^\/responses\/[A-Za-z0-9_.:-]+(?:\/[A-Za-z0-9_.:-]+)?$/.test(decoded)) {
    return { ok: true }
  }
  if (method === 'POST' && decoded === '/chat/completions') return { ok: true }
  if (method === 'GET' && /^\/models(?:\/[A-Za-z0-9_.:-]+)?$/.test(decoded)) return { ok: true }
  // GPT Image 2 requests are server-metered and fixed to one output. The
  // annotated endpoint is platform-internal and never forwarded as-is.
  if (method === 'POST' && (decoded === '/images/generations' || decoded === '/images/edits' || decoded === '/images/annotated-edits')) {
    return { ok: true }
  }

  return { ok: false, status: 404, code: 'PATH_NOT_ALLOWED', message: 'codex relay path not allowed' }
}

export function mapCodexRelayUrl(
  reqUrl: string,
  method: string,
  upstreamBaseUrl: string,
): { url: string; upstreamHost: string; upstreamPath: string; suffix: string } | { error: { status: number; code: string; message: string } } {
  let parsed: URL
  try {
    parsed = new URL(reqUrl, 'http://internal')
  } catch {
    return { error: { status: 400, code: 'BAD_URL', message: 'malformed request url' } }
  }
  if (parsed.pathname.includes('://')) {
    return { error: { status: 400, code: 'BAD_URL', message: 'absolute url proxying is not allowed' } }
  }
  const basePath = codexRelayBasePathForUpstream(upstreamBaseUrl)
  if (parsed.pathname !== basePath && !parsed.pathname.startsWith(`${basePath}/`)) {
    return { error: { status: 404, code: 'NOT_FOUND', message: 'unknown codex relay path' } }
  }
  const suffix = parsed.pathname.slice(basePath.length)
  const allowed = validateRelaySuffix(method, suffix)
  if (allowed.ok === false) {
    return {
      error: {
        status: allowed.status,
        code: allowed.code,
        message: allowed.message,
      },
    }
  }

  const upstream = new URL(upstreamBaseUrl)
  const upstreamBasePath = normalizeBasePath(upstreamBaseUrl)
  upstream.pathname = `${upstreamBasePath}${suffix || ''}` || '/'
  upstream.search = parsed.search
  return {
    url: upstream.toString(),
    upstreamHost: upstream.host,
    upstreamPath: upstream.pathname,
    suffix,
  }
}

/**
 * 非 route 路径可用的上游 base 集合(方案 B5):official 常量恒在;env base
 * (api_relay 遗产,v3 兼容)仅在 relay base path 与 official 不撞时保留。
 * 撞了 official 赢 —— env 不允许把 `/backend-api/codex` 前缀劫持到别的 host。
 * 返回按 base path 从长到短排序,供最长前缀优先匹配。
 */
export function resolveCodexRelayUpstreamBases(envUpstreamBaseUrl: string): string[] {
  const officialBasePath = normalizeBasePath(CODEX_OFFICIAL_UPSTREAM_BASE_URL)
  const bases = [CODEX_OFFICIAL_UPSTREAM_BASE_URL]
  if (normalizeBasePath(envUpstreamBaseUrl) !== officialBasePath) {
    bases.push(envUpstreamBaseUrl)
  }
  return bases.sort((a, b) => normalizeBasePath(b).length - normalizeBasePath(a).length)
}

/**
 * 多上游 base 的路径映射:最长 base path 优先。base path 不匹配(NOT_FOUND)
 * 才尝试下一个;base path 匹配但 suffix 不在 allowlist(PATH_NOT_ALLOWED /
 * BAD_PATH / BAD_URL)立即返回该错,不给短前缀 base "接盘" 的机会。
 */
export function mapCodexRelayUrlMulti(
  reqUrl: string,
  method: string,
  upstreamBaseUrls: string[],
): ReturnType<typeof mapCodexRelayUrl> {
  let notFound: ReturnType<typeof mapCodexRelayUrl> | null = null
  for (const base of upstreamBaseUrls) {
    const mapped = mapCodexRelayUrl(reqUrl, method, base)
    if (!('error' in mapped)) return mapped
    if (mapped.error.code !== 'NOT_FOUND') return mapped
    notFound ??= mapped
  }
  return notFound ?? { error: { status: 404, code: 'NOT_FOUND', message: 'unknown codex relay path' } }
}


function parseRouteRelayUrl(
  reqUrl: string,
  method: string,
):
  | { route: true; token: string; suffix: string; search: string }
  | { route: false }
  | { error: { status: number; code: string; message: string } } {
  let parsed: URL
  try {
    parsed = new URL(reqUrl, 'http://internal')
  } catch {
    return { error: { status: 400, code: 'BAD_URL', message: 'malformed request url' } }
  }
  const prefix = `${CODEX_RELAY_PREFIX}/route/`
  if (!parsed.pathname.startsWith(prefix)) return { route: false }
  const rest = parsed.pathname.slice(prefix.length)
  const slash = rest.indexOf('/')
  const token = slash >= 0 ? rest.slice(0, slash) : rest
  if (!/^[0-9a-f]{64}$/.test(token)) {
    return { error: { status: 400, code: 'BAD_ROUTE_TOKEN', message: 'invalid route token' } }
  }
  const suffix = slash >= 0 ? rest.slice(slash) : ''
  const allowed = validateRelaySuffix(method, suffix)
  if (allowed.ok === false) {
    return { error: { status: allowed.status, code: allowed.code, message: allowed.message } }
  }
  return { route: true, token, suffix, search: parsed.search }
}

function mapRouteContextUrl(
  route: ResolvedCodexRouteContext,
  suffix: string,
  search: string,
): { url: string; upstreamHost: string; upstreamPath: string } {
  const upstream = new URL(route.credential.base_url)
  const upstreamBasePath = normalizeBasePath(route.credential.base_url)
  upstream.pathname = `${upstreamBasePath}${suffix || ''}` || '/'
  upstream.search = search
  return { url: upstream.toString(), upstreamHost: upstream.host, upstreamPath: upstream.pathname }
}

function appendHeader(headers: Headers, key: string, value: string | string[] | undefined): void {
  if (value === undefined) return
  if (Array.isArray(value)) {
    for (const v of value) headers.append(key, v)
    return
  }
  headers.set(key, value)
}

function buildUpstreamHeaders(req: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [rawKey, rawValue] of Object.entries(req.headers)) {
    const key = rawKey.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(key)) continue
    if (key === 'host' || key === 'content-length') continue
    if (key === 'authorization' || key === CODEX_UPSTREAM_AUTH_HEADER) continue
    if (key.startsWith('x-openclaude-')) continue
    if (!SAFE_UPSTREAM_REQUEST_HEADERS.has(key)) continue
    appendHeader(headers, rawKey, rawValue)
  }
  const upstreamAuth = req.headers[CODEX_UPSTREAM_AUTH_HEADER]
  if (typeof upstreamAuth === 'string' && upstreamAuth.trim().length > 0) {
    headers.set('authorization', upstreamAuth)
  }
  // Avoid response decompression/header mismatch surprises in the relay. SSE
  // and JSON streaming work fine with identity encoding.
  headers.set('accept-encoding', 'identity')
  return headers
}

function copyResponseHeaders(from: Headers, res: ServerResponse): void {
  from.forEach((value, rawKey) => {
    const key = rawKey.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(key)) return
    if (key === 'content-length') return
    res.setHeader(rawKey, value)
  })
}

export function isRelayCredentialFailureStatus(status: number): boolean {
  return status >= 500 || status === 401 || status === 403 || status === 429
}

function closeIfHeadersAlreadySent(res: ServerResponse, err: unknown): boolean {
  if (res.writableEnded) return true
  if (!res.headersSent) return false
  res.destroy(err instanceof Error ? err : undefined)
  return true
}

class ImageUpstreamError extends Error {
  constructor(readonly status: number) {
    super(`Image 2 upstream failed (${status})`)
    this.name = 'ImageUpstreamError'
  }
}

/** 上游图片端点非 2xx 时,把响应体前 N 字符投进结构化日志(此前 err 空对象、排查无从下手)。
 * 响应体是上游返回的 error JSON,本不含我方请求的 Authorization;仍防御性脱敏任何形似
 * bearer / sk- 密钥的串,并折叠空白、截断到 500 字符(避免把整个 body 灌进日志)。 */
function sanitizeUpstreamErrorBody(bytes: Buffer, max = 500): string {
  let text: string
  try {
    text = bytes.toString('utf8')
  } catch {
    return '<non-utf8 body>'
  }
  const redacted = text
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, 'Bearer <redacted>')
    .replace(/\bsk-[A-Za-z0-9._-]{6,}/g, 'sk-<redacted>')
    .replace(/\s+/g, ' ')
    .trim()
  return redacted.length > max ? `${redacted.slice(0, max)}…(+${redacted.length - max})` : redacted
}

async function readBoundedBody(req: IncomingMessage, maxBytes = 40 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > maxBytes) throw new Error('image request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

async function readBoundedResponseBody(response: Response, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
  const length = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(length) && length > maxBytes) throw new Error('image response body too large')
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new Error('image response body too large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
}

function jpegDimensions(data: Buffer): { width: number; height: number } | null {
  let offset = 2
  while (offset + 8 < data.length) {
    if (data[offset] !== 0xff) return null
    const marker = data[offset + 1]!
    offset += 2
    if (marker === 0xd8 || marker === 0xd9) continue
    const length = data.readUInt16BE(offset)
    if (length < 2 || offset + length > data.length) return null
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return { height: data.readUInt16BE(offset + 3), width: data.readUInt16BE(offset + 5) }
    }
    offset += length
  }
  return null
}

export async function decodeValidatedImageBase64(encoded: string): Promise<Buffer | null> {
  if (encoded.length < 128 || encoded.length > 36_000_000 || encoded.length % 4 !== 0) return null
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null
  const data = Buffer.from(encoded, 'base64')
  let dimensions: { width: number; height: number } | null = null
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && data.length >= 24) {
    dimensions = { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
  } else if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    dimensions = jpegDimensions(data)
  } else if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') {
    const kind = data.subarray(12, 16).toString('ascii')
    if (kind === 'VP8X' && data.length >= 30) {
      dimensions = {
        width: 1 + data.readUIntLE(24, 3),
        height: 1 + data.readUIntLE(27, 3),
      }
    } else if (kind === 'VP8 ' && data.length >= 30 && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
      dimensions = { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff }
    } else if (kind === 'VP8L' && data.length >= 25 && data[20] === 0x2f) {
      const bits = data.readUInt32LE(21)
      dimensions = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
    }
  }
  if (!dimensions || dimensions.width < 1 || dimensions.height < 1 || dimensions.width > 8192 || dimensions.height > 8192) return null
  try {
    const metadata = await sharp(data, { failOn: 'error' }).metadata()
    if (!metadata.width || !metadata.height || !['png', 'jpeg', 'webp'].includes(metadata.format ?? '')) return null
    if (metadata.width !== dimensions.width || metadata.height !== dimensions.height) return null
    return data
  } catch {
    return null
  }
}

async function normalizeSingleImageRequest(
  body: Buffer,
  contentType: string | undefined,
): Promise<{ body: BodyInit; contentType: string | null }> {
  if ((contentType ?? '').toLowerCase().includes('application/json')) {
    const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>
    if (parsed.model !== 'gpt-image-2' || (parsed.n !== undefined && parsed.n !== 1)) {
      throw new Error('only model=gpt-image-2 and n=1 are supported')
    }
    parsed.model = 'gpt-image-2'
    parsed.n = 1
    return { body: JSON.stringify(parsed), contentType: 'application/json' }
  }
  const form = await new Response(new Uint8Array(body), { headers: { 'content-type': contentType ?? '' } }).formData()
  const models = form.getAll('model')
  const counts = form.getAll('n')
  if (models.length !== 1 || models[0] !== 'gpt-image-2' || counts.length > 1 || (counts.length === 1 && counts[0] !== '1')) {
    throw new Error('only model=gpt-image-2 and n=1 are supported')
  }
  form.set('model', 'gpt-image-2')
  form.set('n', '1')
  return { body: form, contentType: null }
}

type AnnotatedImageRequest = {
  jobId: string
  prompt: string
  width: number
  height: number
  sourceBase64: string
  // annotated 携带用户 mask;outpaint 无 mask,改带 outpaint.aspect(relay 合成)。
  maskBase64?: string
  outpaint?: { aspect: OutpaintAspect }
}

export function parseAnnotatedImageRequest(body: Buffer): AnnotatedImageRequest {
  const value = JSON.parse(body.toString('utf8')) as Partial<AnnotatedImageRequest>
  const isOutpaint = value.outpaint !== undefined
  if (
    typeof value.jobId !== 'string' || !/^[0-9a-f]{32}$/.test(value.jobId)
    || typeof value.prompt !== 'string' || value.prompt.trim().length < 1 || value.prompt.length > 8_000
    || !Number.isInteger(value.width) || !Number.isInteger(value.height)
    || (value.width ?? 0) < 1 || (value.height ?? 0) < 1
    || (value.width ?? 0) * (value.height ?? 0) > 16_777_216
    || typeof value.sourceBase64 !== 'string'
  ) {
    throw new Error('invalid annotated image request')
  }
  if (isOutpaint) {
    // outpaint 分支:aspect 必须是五枚举之一;有无 mask 都忽略(不需要用户 mask)。
    if (!value.outpaint || typeof value.outpaint !== 'object' || !isOutpaintAspect(value.outpaint.aspect)) {
      throw new Error('invalid outpaint aspect')
    }
  } else if (typeof value.maskBase64 !== 'string') {
    throw new Error('invalid annotated image request')
  }
  return value as AnnotatedImageRequest
}

export function makeDefaultCodexRelayDb(): CodexRelayDb {
  return {
    async readContainerBinding(containerId) {
      const r = await query<{
        codex_account_id: string | null
        user_id: string
        state: string
        provider: string | null
        account_status: string | null
      }>(
        `SELECT ac.codex_account_id::text AS codex_account_id,
                ac.user_id::text AS user_id,
                ac.state,
                ca.provider,
                ca.status AS account_status
           FROM agent_containers ac -- state selected above; handler rejects non-active
           LEFT JOIN claude_accounts ca ON ca.id = ac.codex_account_id
          WHERE ac.id = $1 AND ac.runtime_channel = $2`,
        [containerId, getRuntimeChannel()],
      )
      if (!r.rows[0]) return null
      const row = r.rows[0]
      return {
        codexAccountId: row.codex_account_id === null ? null : BigInt(row.codex_account_id),
        userId: BigInt(row.user_id),
        state: row.state,
        provider: row.provider,
        accountStatus: row.account_status,
      }
    },
  }
}

export function makeCodexRelayHandler(deps: CodexRelayDeps): CodexRelayHandler {
  const log = (deps.logger ?? rootLogger).child({ subsys: 'internalCodexRelay' })
  const envUpstreamBaseUrl = deps.upstreamBaseUrl ?? readCodexUpstreamBaseUrl()
  // Validate once at construction; invalid env should fail loudly during boot
  // rather than at first user request.
  new URL(envUpstreamBaseUrl)
  // 非 route 路径支持的上游集合:official 常量 + env base(v3 api_relay 兼容)。
  const upstreamBaseUrls = resolveCodexRelayUpstreamBases(envUpstreamBaseUrl)
  const resolveDispatcher = deps.resolveDispatcher ?? (async (accountId: bigint) => {
    const r = await resolveCodexAccountEgressDispatcher(accountId)
    return { accountId: r.accountId, proxyId: r.proxyId, dispatcher: r.dispatcher }
  })
  const resolveRoute = deps.resolveRouteContext ?? resolveCodexRouteContext
  const markCredentialFailure = deps.markCredentialFailure ?? markRelayCredentialFailure
  const markCredentialSuccess = deps.markCredentialSuccess ?? markRelayCredentialSuccess
  const readBoundAccountAccessToken = deps.readBoundAccountAccessToken ?? (async (accountId: bigint) => {
    const snap = await getCodexTokenSnapshot(accountId)
    if (!snap) return null
    // 代注只需要 access token;refresh 材料立即清零,不出本闭包。
    if (snap.refresh) zeroBuffer(snap.refresh)
    return snap.token
  })
  const fetchImpl = deps.fetchImpl ?? fetch
  const image2Enabled = deps.image2Enabled ?? process.env.OC_IMAGE2_ENABLED === 'true'
  const imageAttempts = new Map<string, number[]>()
  let activeImageHeavyWork = 0

  return async function handle(req, res, ctx) {
    setSecurityHeaders(res)
    const requestId = ensureRequestId(req)
    res.setHeader(REQUEST_ID_HEADER, requestId)

    const method = req.method ?? 'GET'
    const reqLog = log.child({ requestId, hostUuid: ctx.hostUuid, boundIp: ctx.boundIp, method })

    const routeReq = parseRouteRelayUrl(req.url ?? '/', method)
    if ('error' in routeReq) {
      sendJsonError(res, routeReq.error.status, routeReq.error.code, routeReq.error.message, requestId)
      return
    }
    let mapped: ReturnType<typeof mapCodexRelayUrl> | null = null
    if (routeReq.route === false) {
      mapped = mapCodexRelayUrlMulti(req.url ?? '/', method, upstreamBaseUrls)
      if ('error' in mapped) {
        sendJsonError(res, mapped.error.status, mapped.error.code, mapped.error.message, requestId)
        return
      }
    }

    let identity: Awaited<ReturnType<typeof verifyContainerIdentity>>
    try {
      identity = await verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization)
    } catch (err) {
      if (err instanceof ContainerIdentityError) {
        reqLog.warn('identity_failed', { errcode: err.code })
        sendJsonError(res, 401, 'UNAUTHORIZED', 'container identity verification failed', requestId)
        return
      }
      throw err
    }

    const userLog = reqLog.child({ uid: identity.userId, containerId: identity.containerId })

    let binding: CodexRelayBindingRow | null
    try {
      binding = await deps.db.readContainerBinding(identity.containerId)
    } catch (err) {
      userLog.error('binding_read_failed', { err: err as Error })
      sendJsonError(res, 500, 'INTERNAL', 'container binding read failed', requestId)
      return
    }
    if (!binding) {
      userLog.warn('binding_missing_after_identity')
      sendJsonError(res, 409, 'CONTAINER_BINDING_CHANGED', 'container row vanished', requestId)
      return
    }
    if (binding.userId !== BigInt(identity.userId)) {
      userLog.error('identity_userid_mismatch', { rowUid: String(binding.userId) })
      sendJsonError(res, 401, 'UNAUTHORIZED', 'container identity verification failed', requestId)
      return
    }
    if (binding.state !== 'active') {
      userLog.warn('container_not_active', { state: binding.state })
      sendJsonError(res, 409, 'CONTAINER_BINDING_CHANGED', 'container is not active', requestId)
      return
    }

    const mappedSuffix = routeReq.route === false && mapped && !('error' in mapped) ? mapped.suffix : routeReq.route === true ? routeReq.suffix : ''
    const preflightAnnotated = method === 'POST' && mappedSuffix === '/images/annotated-edits'
    const preflightImage = method === 'POST' && (
      mappedSuffix === '/images/generations' || mappedSuffix === '/images/edits' || preflightAnnotated
    )
    const annotatedJobHeader = req.headers['x-openclaude-image-job']
    const preflightJobId = preflightAnnotated && typeof annotatedJobHeader === 'string' && /^[0-9a-f]{32}$/.test(annotatedJobHeader)
      ? annotatedJobHeader
      : null
    const preflightImageRequestId = preflightImage
      ? preflightAnnotated ? (preflightJobId ? `image-job:${preflightJobId}` : null) : `image:${requestId}`
      : null
    const preflightOperation: 'generation' | 'edit' | 'annotated_edit' | null = !preflightImage
      ? null
      : preflightAnnotated ? 'annotated_edit' : mappedSuffix === '/images/edits' ? 'edit' : 'generation'
    let imageReservation: ReservationHandle | null = null
    let didInsertImageReservation = false
    if (preflightImage) {
      if (!deps.pgPool || !deps.preCheckRedis) {
        sendJsonError(res, 503, 'IMAGE_BILLING_UNAVAILABLE', 'image billing unavailable', requestId)
        return
      }
      if (!preflightImageRequestId || !preflightOperation) {
        sendJsonError(res, 400, 'INVALID_IMAGE_REQUEST', 'missing stable image job id', requestId)
        return
      }
      const cached = await getCompletedImageUsage(deps.pgPool, {
        userId: BigInt(identity.userId), requestId: preflightImageRequestId,
      }).catch(() => null)
      if (cached) {
        await releasePreCheck(deps.preCheckRedis, {
          userId: String(identity.userId), requestId: preflightImageRequestId,
        }).catch(() => {})
        res.statusCode = 200
        res.setHeader('Content-Type', cached.contentType)
        res.end(cached.responseBody)
        return
      }
      if (!image2Enabled) {
        sendJsonError(res, 503, 'IMAGE2_DISABLED', 'Image 2 is temporarily unavailable', requestId)
        return
      }
      const now = Date.now()
      if (imageAttempts.size > 10_000) {
        for (const [uid, attempts] of imageAttempts) {
          const live = attempts.filter((at) => now - at < 10 * 60_000)
          if (live.length === 0) imageAttempts.delete(uid)
          else imageAttempts.set(uid, live)
        }
      }
      const attemptKey = String(identity.userId)
      const recentAttempts = (imageAttempts.get(attemptKey) ?? []).filter((at) => now - at < 10 * 60_000)
      if (recentAttempts.length >= 20) {
        sendJsonError(res, 429, 'IMAGE_ATTEMPT_LIMIT', 'too many Image 2 attempts; try again later', requestId)
        return
      }
      recentAttempts.push(now)
      imageAttempts.set(attemptKey, recentAttempts)
      try {
        const imageUsage = await reserveImageUsage(deps.pgPool, {
          userId: BigInt(identity.userId), containerId: identity.containerId,
          requestId: preflightImageRequestId, jobId: preflightJobId,
          operation: preflightOperation,
        })
        didInsertImageReservation = true
        if (!imageUsage.alreadyCharged) {
          imageReservation = (await preCheckExactCost(deps.preCheckRedis, {
            userId: identity.userId, requestId: preflightImageRequestId, maxCost: IMAGE2_UNIT_COST,
          })).reservation
        }
      } catch (err) {
        if (didInsertImageReservation) {
          await markImageUsage(deps.pgPool, {
            userId: BigInt(identity.userId), containerId: identity.containerId,
            requestId: preflightImageRequestId, jobId: preflightJobId,
            operation: preflightOperation, status: 'failed', errorCode: 'precheck_failed',
          }).catch(() => {})
        }
        if (imageReservation) await releasePreCheck(deps.preCheckRedis, imageReservation).catch(() => {})
        if (err instanceof PreCheckInsufficientCreditsError) {
          sendJsonError(res, 402, 'ERR_INSUFFICIENT_CREDITS', err.message, requestId)
        } else if (err instanceof ImageDailyLimitError) {
          sendJsonError(res, 429, 'IMAGE_DAILY_LIMIT', err.message, requestId)
        } else if ((err as { code?: string }).code === '23505') {
          const racedCache = await getCompletedImageUsage(deps.pgPool, {
            userId: BigInt(identity.userId), requestId: preflightImageRequestId,
          }).catch(() => null)
          if (racedCache) {
            res.statusCode = 200
            res.setHeader('Content-Type', racedCache.contentType)
            res.end(racedCache.responseBody)
          } else {
            sendJsonError(res, 409, 'IMAGE_REQUEST_IN_PROGRESS', 'another Image 2 request is already running', requestId)
          }
        } else {
          userLog.error('image_preflight_failed', { err: err as Error })
          sendJsonError(res, 500, 'IMAGE_BILLING_FAILED', 'image billing preflight failed', requestId)
        }
        return
      }
    }
    const cancelReservedImage = async (errorCode: string): Promise<void> => {
      if (didInsertImageReservation && preflightImageRequestId && preflightOperation && deps.pgPool) {
        await markImageUsage(deps.pgPool, {
          userId: BigInt(identity.userId), containerId: identity.containerId,
          requestId: preflightImageRequestId, jobId: preflightJobId,
          operation: preflightOperation, status: 'failed', errorCode,
        }).catch(() => {})
      }
      if (imageReservation && deps.preCheckRedis) {
        await releasePreCheck(deps.preCheckRedis, imageReservation).catch(() => {})
        imageReservation = null
      }
    }

    let egress: CodexRelayDispatcherInfo | null = null
    let routeContext: ResolvedCodexRouteContext | null = null
    let mappedUrl: { url: string; upstreamHost: string; upstreamPath: string }
    // 非 route 路径的上游 Authorization 来源(B5/3b):
    //   container         — 容器带了 x-openclaude-upstream-authorization,原样转发;
    //                        上游 401 → 记日志 + 401 透传 fail-closed,绝不改用
    //                        DB token 静默重试(防掩盖 codex auth 行为漂移)。
    //   account_fallback  — 容器没带 → 按绑定账号 DB 读 access token 代注;
    //                        读不到 / 解密失败 → 503 fail-closed。
    let hadContainerUpstreamAuth = false
    let fallbackAccessToken: Buffer | null = null
    if (routeReq.route === true) {
      try {
        routeContext = await resolveRoute({
          token: routeReq.token,
          containerId: identity.containerId,
          userId: BigInt(identity.userId),
        })
      } catch (err) {
        await cancelReservedImage('route_unavailable')
        userLog.warn('route_context_read_failed', { err: err instanceof Error ? err.message : String(err) })
        sendJsonError(res, 503, 'CODEX_ROUTE_UNAVAILABLE', 'codex route unavailable', requestId)
        return
      }
      if (!routeContext) {
        await cancelReservedImage('route_unavailable')
        userLog.warn('route_context_unavailable')
        sendJsonError(res, 503, 'CODEX_ROUTE_UNAVAILABLE', 'codex route unavailable', requestId)
        return
      }
      mappedUrl = mapRouteContextUrl(routeContext, routeReq.suffix, routeReq.search)
    } else {
      if (binding.codexAccountId === null) {
        await cancelReservedImage('account_unavailable')
        userLog.warn('no_bound_account')
        sendJsonError(res, 503, 'NO_BOUND_CODEX_ACCOUNT', 'container has no codex account bound', requestId)
        return
      }
      if (binding.provider !== 'codex' || binding.accountStatus !== 'active') {
        await cancelReservedImage('account_unavailable')
        userLog.warn('bound_account_not_active', {
          codexAccountId: String(binding.codexAccountId),
          provider: binding.provider,
          accountStatus: binding.accountStatus,
        })
        sendJsonError(res, 503, 'CODEX_ACCOUNT_NOT_ACTIVE', 'bound codex account is not active', requestId)
        return
      }

      try {
        egress = await resolveDispatcher(binding.codexAccountId)
      } catch (err) {
        await cancelReservedImage('egress_unavailable')
        const fields = err instanceof CodexEgressError
          ? { code: err.code, proxyId: err.details.proxyId ?? null }
          : { code: 'unknown', proxyId: null }
        userLog.warn('egress_unavailable', {
          codexAccountId: String(binding.codexAccountId),
          ...fields,
        })
        sendJsonError(res, 503, 'CODEX_EGRESS_UNAVAILABLE', 'codex account egress unavailable', requestId)
        return
      }
      mappedUrl = mapped as Exclude<typeof mapped, null | { error: unknown }>

      const upstreamAuthRaw = req.headers[CODEX_UPSTREAM_AUTH_HEADER]
      hadContainerUpstreamAuth =
        typeof upstreamAuthRaw === 'string' && upstreamAuthRaw.trim().length > 0
      if (!hadContainerUpstreamAuth) {
        try {
          fallbackAccessToken = await readBoundAccountAccessToken(binding.codexAccountId)
        } catch (err) {
          await cancelReservedImage('token_unavailable')
          userLog.warn('auth_fallback_token_read_failed', {
            codexAccountId: String(binding.codexAccountId),
            err: err instanceof Error ? err.message : String(err),
          })
          sendJsonError(res, 503, 'CODEX_ACCOUNT_TOKEN_UNAVAILABLE', 'codex account token unavailable', requestId)
          return
        }
        if (fallbackAccessToken === null || fallbackAccessToken.length === 0) {
          await cancelReservedImage('token_unavailable')
          userLog.warn('auth_fallback_token_missing', {
            codexAccountId: String(binding.codexAccountId),
          })
          sendJsonError(res, 503, 'CODEX_ACCOUNT_TOKEN_UNAVAILABLE', 'codex account token unavailable', requestId)
          return
        }
        userLog.info('auth_fallback_injected', {
          codexAccountId: String(binding.codexAccountId),
        })
      }
    }

    const controller = new AbortController()
    const abort = () => controller.abort()
    req.once('aborted', abort)
    res.once('close', abort)

    const relayLog = userLog.child({
      codexAccountId: egress ? String(egress.accountId) : null,
      relayCredentialId: routeContext ? String(routeContext.credential.id) : null,
      proxyId: egress ? String(egress.proxyId) : null,
      upstreamHost: mappedUrl.upstreamHost,
      upstreamPath: mappedUrl.upstreamPath,
    })

    const isAnnotatedImageRequest = method === 'POST' && mappedSuffix === '/images/annotated-edits'
    const isImageRequest = method === 'POST' && (
      mappedSuffix === '/images/generations'
      || mappedSuffix === '/images/edits'
      || isAnnotatedImageRequest
    )
    let imageRequestBody: BodyInit | null = null
    let imageRequestContentType: string | null = null
    let imageRequestId: string | null = null
    let imageOperation: 'generation' | 'edit' | 'annotated_edit' | null = null
    let annotatedJob: ImageEditJob | null = null
    let annotatedPrepared: Awaited<ReturnType<typeof prepareImageEdit>> | null = null
    let outpaintPrepared: Awaited<ReturnType<typeof prepareImageOutpaint>> | null = null
    let annotatedTempDir: string | null = null
    let imageHeavySlot = false

    if (isImageRequest) {
      if (activeImageHeavyWork >= 4) {
        await cancelReservedImage('server_busy')
        if (fallbackAccessToken) zeroBuffer(fallbackAccessToken)
        sendJsonError(res, 429, 'IMAGE_SERVER_BUSY', 'Image 2 is busy; try again shortly', requestId)
        return
      }
      activeImageHeavyWork++
      imageHeavySlot = true
      imageRequestId = preflightImageRequestId
      imageOperation = preflightOperation
      try {
        if (isAnnotatedImageRequest) {
          const input = parseAnnotatedImageRequest(await readBoundedBody(req, 80 * 1024 * 1024))
          if (input.jobId !== preflightJobId) throw new Error('annotated image job id mismatch')
          const source = await decodeValidatedImageBase64(input.sourceBase64)
          if (!source) throw new Error('source is not a valid image')
          const normalizedSource = await sharp(source).rotate().png().toBuffer({ resolveWithObject: true })
          if (normalizedSource.info.width !== input.width || normalizedSource.info.height !== input.height) {
            throw new Error('source dimensions differ')
          }
          annotatedTempDir = await mkdtemp(join(tmpdir(), 'oc-image2-'))
          const sourcePath = join(annotatedTempDir, 'source.png')
          const outputPath = join(annotatedTempDir, 'output.png')
          await writeFile(sourcePath, normalizedSource.data, { mode: 0o600 })
          // Both shapes bill as annotated_edit(50 credits;reserve/settle 不变);
          // only the prepare geometry differs — outpaint synthesises its own mask
          // from the source footprint, annotated uses the user's drawn mask.
          let preparedImage: Buffer
          let preparedMask: Buffer
          let preparedApi: string
          if (input.outpaint) {
            const inputHash = createHash('sha256')
              .update('gpt-image-2\0outpaint\0', 'utf8')
              .update(`${input.outpaint.aspect}\0`, 'utf8')
              .update(`${input.width}x${input.height}\0`, 'utf8')
              .update(input.prompt.trim(), 'utf8')
              .update('\0', 'utf8')
              .update(normalizedSource.data)
              .digest()
            await bindImageInputHash(deps.pgPool!, {
              userId: BigInt(identity.userId),
              requestId: imageRequestId!,
              inputHash,
            })
            annotatedJob = {
              version: 1, jobId: input.jobId, sourcePath, maskPath: '', guidePath: '', outputPath,
              width: input.width, height: input.height, createdAt: new Date().toISOString(),
            }
            outpaintPrepared = await prepareImageOutpaint(annotatedJob, input.outpaint.aspect)
            preparedImage = outpaintPrepared.image
            preparedMask = outpaintPrepared.mask
            preparedApi = outpaintPrepared.target.api
          } else {
            const mask = await decodeValidatedImageBase64(input.maskBase64!)
            if (!mask) throw new Error('source or mask is not a valid image')
            const maskMeta = await sharp(mask).metadata()
            if (
              maskMeta.width !== input.width || maskMeta.height !== input.height
              || maskMeta.format !== 'png'
            ) throw new Error('source and mask dimensions differ')
            const inputHash = createHash('sha256')
              .update('gpt-image-2\0annotated_edit\0', 'utf8')
              .update(`${input.width}x${input.height}\0`, 'utf8')
              .update(input.prompt.trim(), 'utf8')
              .update('\0', 'utf8')
              .update(normalizedSource.data)
              .update(mask)
              .digest()
            await bindImageInputHash(deps.pgPool!, {
              userId: BigInt(identity.userId),
              requestId: imageRequestId!,
              inputHash,
            })
            const maskPath = join(annotatedTempDir, 'mask.png')
            await writeFile(maskPath, mask, { mode: 0o600 })
            annotatedJob = {
              version: 1, jobId: input.jobId, sourcePath, maskPath, guidePath: '', outputPath,
              width: input.width, height: input.height, createdAt: new Date().toISOString(),
            }
            annotatedPrepared = await prepareImageEdit(annotatedJob)
            preparedImage = annotatedPrepared.image
            preparedMask = annotatedPrepared.mask
            preparedApi = annotatedPrepared.target.api
          }
          const form = new FormData()
          form.set('model', 'gpt-image-2')
          form.set('prompt', input.prompt.trim())
          form.set('n', '1')
          form.set('size', preparedApi)
          form.set('image', new Blob([new Uint8Array(preparedImage)], { type: 'image/png' }), 'source.png')
          form.set('mask', new Blob([new Uint8Array(preparedMask)], { type: 'image/png' }), 'mask.png')
          imageRequestBody = form
          const upstreamUrl = new URL(mappedUrl.url)
          upstreamUrl.pathname = upstreamUrl.pathname.replace(/\/images\/annotated-edits$/, '/images/edits')
          mappedUrl = { ...mappedUrl, url: upstreamUrl.toString(), upstreamPath: upstreamUrl.pathname }
        } else {
          const normalized = await normalizeSingleImageRequest(
            await readBoundedBody(req),
            typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : undefined,
          )
          imageRequestBody = normalized.body
          imageRequestContentType = normalized.contentType
        }
      } catch (err) {
        if (didInsertImageReservation && imageRequestId && imageOperation) {
          await markImageUsage(deps.pgPool!, {
            userId: BigInt(identity.userId), containerId: identity.containerId,
            requestId: imageRequestId, jobId: annotatedJob?.jobId ?? preflightJobId,
            operation: imageOperation, status: 'failed', errorCode: 'invalid_request',
          }).catch(() => {})
        }
        if (imageReservation) await releasePreCheck(deps.preCheckRedis!, imageReservation).catch(() => {})
        if (annotatedTempDir) await rm(annotatedTempDir, { recursive: true, force: true }).catch(() => {})
        if (imageHeavySlot) {
          activeImageHeavyWork--
          imageHeavySlot = false
        }
        if (fallbackAccessToken) zeroBuffer(fallbackAccessToken)
        sendJsonError(res, 400, 'INVALID_IMAGE_REQUEST', err instanceof Error ? err.message : 'invalid image request', requestId)
        return
      }
    }

    try {
      const headers = buildUpstreamHeaders(req)
      if (imageRequestContentType) headers.set('content-type', imageRequestContentType)
      if (isAnnotatedImageRequest || imageRequestBody instanceof FormData) headers.delete('content-type')
      const init: RequestInit & { dispatcher?: unknown; duplex?: 'half' } = {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD'
          ? undefined
          : imageRequestBody ?? (req as unknown as BodyInit),
        dispatcher: egress?.dispatcher,
        duplex: 'half',
        signal: controller.signal,
      }
      if (routeContext) {
        const apiKey = routeContext.apiKey
        try {
          init.headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers as HeadersInit)
          ;(init.headers as Headers).set('authorization', `Bearer ${apiKey.toString('utf8')}`)
        } finally {
          zeroBuffer(apiKey)
        }
      }
      if (fallbackAccessToken !== null) {
        try {
          init.headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers as HeadersInit)
          ;(init.headers as Headers).set('authorization', `Bearer ${fallbackAccessToken.toString('utf8')}`)
        } finally {
          zeroBuffer(fallbackAccessToken)
          fallbackAccessToken = null
        }
      }
      const outgoingHeaders = init.headers instanceof Headers
        ? init.headers
        : new Headers(init.headers as HeadersInit)
      init.headers = outgoingHeaders
      const upstream = await fetchImpl(mappedUrl.url, init)
      relayLog.info('relay_upstream_response', {
        status: upstream.status,
        forwardedCodexTurnState: outgoingHeaders.has('x-codex-turn-state'),
        forwardedResponsesLite: outgoingHeaders.has('x-openai-internal-codex-responses-lite'),
      })
      if (routeContext) {
        if (isRelayCredentialFailureStatus(upstream.status)) {
          void markCredentialFailure(routeContext.credential.id, `http_${upstream.status}`).catch(() => {})
        } else {
          void markCredentialSuccess(routeContext.credential.id).catch(() => {})
        }
      }
      if (isImageRequest) {
        const bytes = await readBoundedResponseBody(upstream)
        let generated: Buffer | null = null
        if (upstream.ok) {
          try {
            const parsed = JSON.parse(bytes.toString('utf8')) as { data?: Array<{ b64_json?: string }> }
            const encoded = parsed.data?.[0]?.b64_json
            if (parsed.data?.length === 1 && typeof encoded === 'string') {
              generated = await decodeValidatedImageBase64(encoded)
            }
          } catch {}
        } else {
          // 诊断盲区根治(Task 2):上游非 2xx 把响应体前缀 + 我方送出的关键几何(size)
          // 落结构化日志。requestedSize 命中 annotated/outpaint 的 API 画布串——若 400
          // 由 size/几何触发,这里一眼可见。
          relayLog.warn('image_upstream_non_2xx', {
            status: upstream.status,
            operation: imageOperation,
            annotated: isAnnotatedImageRequest,
            requestedSize: annotatedPrepared?.target.api ?? outpaintPrepared?.target.api ?? null,
            imageJobId: annotatedJob?.jobId ?? null,
            bodyPrefix: sanitizeUpstreamErrorBody(bytes),
          })
        }
        if (!generated) {
          if (!upstream.ok) throw new ImageUpstreamError(upstream.status)
          throw new Error('Image 2 returned an invalid image')
        }

        let responseBody = bytes
        if (isAnnotatedImageRequest) {
          if (!annotatedJob || (!annotatedPrepared && !outpaintPrepared)) throw new Error('annotated edit preparation missing')
          if (controller.signal.aborted) throw new DOMException('image request aborted', 'AbortError')
          if (outpaintPrepared) {
            await compositeImageOutpaint(annotatedJob, generated, outpaintPrepared)
          } else {
            await compositeImageEdit(annotatedJob, generated, annotatedPrepared!)
          }
          const finalImage = await readFile(annotatedJob.outputPath)
          responseBody = Buffer.from(JSON.stringify({
            created: Math.floor(Date.now() / 1000),
            data: [{ b64_json: finalImage.toString('base64') }],
          }))
        }
        if (controller.signal.aborted) throw new DOMException('image request aborted', 'AbortError')
        const settled = await settleImageCharge(deps.pgPool!, {
          userId: BigInt(identity.userId),
          containerId: identity.containerId,
          requestId: imageRequestId!,
          jobId: annotatedJob?.jobId ?? null,
          operation: imageOperation!,
          responseBody,
        })
        if (imageReservation) {
          await releasePreCheck(deps.preCheckRedis!, imageReservation).catch(() => {})
          imageReservation = null
        }
        if (!settled.duplicate && deps.onImageCharge) {
          try {
            deps.onImageCharge(BigInt(identity.userId), {
              costCredits: IMAGE2_UNIT_COST.toString(),
              balanceAfter: settled.balanceAfter?.toString() ?? null,
            })
          } catch (err) {
            relayLog.warn('image_charge_callback_failed', { err: err as Error })
          }
        }
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(responseBody)
        return
      }
      res.statusCode = upstream.status
      copyResponseHeaders(upstream.headers, res)
      if (egress !== null && upstream.status === 401 && hadContainerUpstreamAuth) {
        // fail-closed:容器自带的上游 Authorization 被上游拒 → 只记日志、401 原样
        // 透传。不允许在这里换 DB token 重试 —— 那会静默掩盖 codex CLI auth 行为
        // 漂移 / 容器 auth.json 与账号池的失同步。
        relayLog.warn('upstream_401_container_auth_fail_closed', {
          codexAccountId: String(egress.accountId),
        })
      }
      if (!upstream.body) {
        res.end()
        return
      }
      await new Promise<void>((resolve, reject) => {
        const body = Readable.fromWeb(upstream.body as any)
        body.on('error', reject)
        res.on('error', reject)
        res.on('finish', resolve)
        body.pipe(res)
      })
    } catch (err) {
      if (deps.preCheckRedis && imageReservation) await releasePreCheck(deps.preCheckRedis, imageReservation).catch(() => {})
      if (deps.pgPool && imageRequestId && imageOperation) {
        await markImageUsage(deps.pgPool, {
          userId: BigInt(identity.userId), containerId: identity.containerId,
          requestId: imageRequestId, jobId: annotatedJob?.jobId ?? null, operation: imageOperation,
          status: 'failed', errorCode: 'relay_failed',
        }).catch(() => {})
      }
      if (controller.signal.aborted) return
      relayLog.warn('relay_fetch_failed', { err: err as Error })
      if (routeContext) {
        void markCredentialFailure(routeContext.credential.id, err instanceof Error ? err.message : String(err)).catch(() => {})
      }
      if (closeIfHeadersAlreadySent(res, err)) return
      if (err instanceof LedgerInsufficientCreditsError) {
        sendJsonError(res, 402, 'ERR_INSUFFICIENT_CREDITS', err.message, requestId)
      } else if (err instanceof ImageUpstreamError) {
        const status = err.status === 429 ? 429 : err.status >= 500 ? 503 : 502
        sendJsonError(res, status, 'IMAGE_UPSTREAM_FAILED', 'Image 2 service is temporarily unavailable', requestId)
      } else {
        sendJsonError(res, 502, 'CODEX_RELAY_UPSTREAM_FAILED', 'codex upstream request failed', requestId)
      }
    } finally {
      if (imageHeavySlot) activeImageHeavyWork--
      if (annotatedTempDir) await rm(annotatedTempDir, { recursive: true, force: true }).catch(() => {})
      req.off('aborted', abort)
      res.off('close', abort)
    }
  }
}
