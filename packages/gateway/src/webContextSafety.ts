import { randomBytes, timingSafeEqual } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns/promises'
import {
  Agent as HttpAgent,
  type ClientRequest,
  createServer as createHttpServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
  request as httpRequest,
} from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import * as net from 'node:net'
import { extname } from 'node:path'
import { type Duplex, Readable } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'

export type WebContextKind = 'html' | 'text' | 'pdf' | 'docx' | 'pptx' | 'xlsx'

export interface WebContextFetchOptions {
  timeoutMs?: number
  deadlineMs?: number
  maxRedirects?: number
  maxEncodedBytes?: number
  maxDecodedBytes?: number
  userAgent?: string
  lookup?: typeof dnsLookup
  connectSocket?: (opts: { host: string; port: number }) => net.Socket
}

export interface WebContextFetchResult {
  url: string
  finalUrl: string
  status: number
  headers: Record<string, string>
  body: Buffer
  encodedBytes: number
  decodedBytes: number
  contentType: string
  kind: WebContextKind
  redirects: string[]
}

export interface SniffResult {
  kind: WebContextKind | null
  reason: string
}

export const DEFAULT_WEB_CONTEXT_TIMEOUT_MS = 25_000
export const DEFAULT_WEB_CONTEXT_MAX_REDIRECTS = 5
export const DEFAULT_WEB_CONTEXT_MAX_ENCODED_BYTES = 12 * 1024 * 1024
export const DEFAULT_WEB_CONTEXT_MAX_DECODED_BYTES = 25 * 1024 * 1024
export const HARD_WEB_CONTEXT_MAX_ENCODED_BYTES = 50 * 1024 * 1024
export const HARD_WEB_CONTEXT_MAX_DECODED_BYTES = 100 * 1024 * 1024

const DEFAULT_UA = 'OpenClaude-WebContext/0.1 (+https://claudeai.chat)'
const BLOCKED_HOSTS = new Set(['localhost', 'localhost.localdomain'])
const UNSUPPORTED_BINARY_MIME_PREFIXES = ['image/', 'audio/', 'video/']
const UNSUPPORTED_BINARY_MIMES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/gzip',
  'application/x-gzip',
  'application/x-tar',
  'application/x-msdownload',
  'application/octet-stream',
])

const HTML_MIMES = new Set(['text/html', 'application/xhtml+xml'])
const TEXT_MIMES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/xml',
  'application/xml',
  'application/json',
])
const PDF_MIME = 'application/pdf'
const OOXML_MIME: Record<WebContextKind, string> = {
  html: '',
  text: '',
  pdf: '',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}
const ALLOWED_EXT_TO_KIND: Record<string, WebContextKind> = {
  '.html': 'html',
  '.htm': 'html',
  '.txt': 'text',
  '.md': 'text',
  '.markdown': 'text',
  '.json': 'text',
  '.csv': 'text',
  '.xml': 'text',
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.pptx': 'pptx',
  '.xlsx': 'xlsx',
}

export function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  hardMax: number,
): number {
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  const i = Math.floor(n)
  if (i < min) return fallback
  return Math.min(i, hardMax)
}

function normalizeHostname(hostname: string): string {
  const trimmed = hostname.trim().replace(/\.$/, '')
  if (!trimmed) throw new Error('URL host is empty')
  return trimmed.toLowerCase()
}

export function normalizeHttpUrl(raw: string): URL {
  if (typeof raw !== 'string' || raw.trim() === '') throw new Error('url is required')
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error('url must be a valid absolute URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('only http/https URLs are supported')
  }
  if (url.username || url.password) throw new Error('URL credentials are not allowed')
  const host = normalizeHostname(url.hostname)
  if (BLOCKED_HOSTS.has(host) || host.endsWith('.localhost')) {
    throw new Error('localhost URLs are not allowed')
  }
  url.hostname = host
  return url
}

function ipv4Parts(ip: string): number[] | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  const nums = parts.map((p) => Number(p))
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return nums
}

function parseHextet(part: string): number | null {
  if (!/^[0-9a-f]{1,4}$/i.test(part)) return null
  const n = Number.parseInt(part, 16)
  return Number.isInteger(n) && n >= 0 && n <= 0xffff ? n : null
}

function ipv6ToBytes(ip: string): number[] | null {
  let raw = ip.trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  const zoneIdx = raw.indexOf('%')
  if (zoneIdx >= 0) raw = raw.slice(0, zoneIdx)
  if (!raw || net.isIP(raw) !== 6) return null

  if (raw.includes('.')) {
    const idx = raw.lastIndexOf(':')
    if (idx < 0) return null
    const v4 = ipv4Parts(raw.slice(idx + 1))
    if (!v4) return null
    raw = `${raw.slice(0, idx)}:${((v4[0]! << 8) | v4[1]!).toString(16)}:${(
      (v4[2]! << 8) | v4[3]!
    ).toString(16)}`
  }

  const halves = raw.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const explicit = [...left, ...right]
  const missing = halves.length === 2 ? 8 - explicit.length : 0
  if (missing < 0 || (halves.length === 1 && explicit.length !== 8)) return null

  const hextets: number[] = []
  for (const part of left) {
    const n = parseHextet(part)
    if (n === null) return null
    hextets.push(n)
  }
  for (let i = 0; i < missing; i++) hextets.push(0)
  for (const part of right) {
    const n = parseHextet(part)
    if (n === null) return null
    hextets.push(n)
  }
  if (hextets.length !== 8) return null
  return hextets.flatMap((n) => [n >> 8, n & 0xff])
}

function ipv4FromMappedIpv6(ip: string): string | null {
  const bytes = ipv6ToBytes(ip)
  if (!bytes) return null
  const mapped =
    bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff
  if (!mapped) return null
  return bytes.slice(12, 16).join('.')
}

function isIpv4CompatibleIpv6(bytes: number[]): boolean {
  return bytes.slice(0, 12).every((b) => b === 0)
}

function hasPrefix(bytes: number[], prefix: number[], bits: number): boolean {
  const fullBytes = Math.floor(bits / 8)
  for (let i = 0; i < fullBytes; i++) {
    if (bytes[i] !== (prefix[i] ?? 0)) return false
  }
  const remaining = bits % 8
  if (remaining === 0) return true
  const mask = 0xff << (8 - remaining)
  return ((bytes[fullBytes] ?? 0) & mask) === ((prefix[fullBytes] ?? 0) & mask)
}

function normalizeIp(ip: string): string {
  const raw = ip.trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  const mapped = ipv4FromMappedIpv6(raw)
  if (mapped) return mapped
  return raw
}

export function isPublicIpAddress(rawIp: string): boolean {
  const ip = normalizeIp(rawIp)
  const family = net.isIP(ip)
  if (family === 4) {
    const p = ipv4Parts(ip)
    if (!p) return false
    const [a, b] = p
    if (a === 0 || a === 10 || a === 127) return false
    if (a === 100 && b >= 64 && b <= 127) return false
    if (a === 169 && b === 254) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a === 192 && b === 0) return false
    if (a === 192 && b === 0 && p[2] === 2) return false
    if (a === 198 && (b === 18 || b === 19)) return false
    if (a === 198 && b === 51 && p[2] === 100) return false
    if (a === 203 && b === 0 && p[2] === 113) return false
    if (a >= 224) return false
    return true
  }
  if (family === 6) {
    const bytes = ipv6ToBytes(ip)
    if (!bytes) return false
    if (bytes.every((b) => b === 0)) return false
    if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return false
    if (isIpv4CompatibleIpv6(bytes)) return false
    if ((bytes[0]! & 0xfe) === 0xfc) return false // fc00::/7 unique local
    if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return false // fe80::/10 link local
    if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0xc0) return false // fec0::/10 site local
    if (bytes[0] === 0xff) return false // ff00::/8 multicast
    if (hasPrefix(bytes, [0x00, 0x64, 0xff, 0x9b], 96)) return false // 64:ff9b::/96 NAT64
    if (hasPrefix(bytes, [0x01, 0x00], 64)) return false // 100::/64 discard-only
    if (hasPrefix(bytes, [0x20, 0x01, 0x00, 0x00], 32)) return false // 2001::/32 Teredo
    if (hasPrefix(bytes, [0x20, 0x01, 0x0d, 0xb8], 32)) return false // 2001:db8::/32 docs
    if (hasPrefix(bytes, [0x20, 0x02], 16)) return false // 2002::/16 6to4
    return true
  }
  return false
}

export async function resolvePublicIp(
  hostname: string,
  lookup: typeof dnsLookup = dnsLookup,
): Promise<{ address: string; family: 4 | 6 }> {
  const host = normalizeHostname(hostname)
  const bareHost = host.replace(/^\[/, '').replace(/\]$/, '')
  if (net.isIP(bareHost)) {
    const address = normalizeIp(bareHost)
    if (!isPublicIpAddress(address)) throw new Error('URL resolves to a non-public IP address')
    return { address, family: net.isIP(address) as 4 | 6 }
  }
  const records = await lookup(host, { all: true, verbatim: false })
  for (const rec of records) {
    const address = normalizeIp(rec.address)
    if (isPublicIpAddress(address)) {
      return { address, family: (net.isIP(address) as 4 | 6) || (rec.family as 4 | 6) }
    }
  }
  throw new Error('URL host does not resolve to a public IP address')
}

function headerValue(headers: Record<string, string>, name: string): string {
  return headers[name.toLowerCase()] ?? ''
}

function lowerMime(contentType: string): string {
  return contentType.split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

function looksHtml(buf: Buffer): boolean {
  const prefix = buf.subarray(0, 4096).toString('utf8').trimStart().toLowerCase()
  return (
    prefix.startsWith('<!doctype html') || prefix.startsWith('<html') || prefix.includes('<html')
  )
}

function looksPdf(buf: Buffer): boolean {
  return buf.length >= 5 && buf.subarray(0, 5).toString('ascii') === '%PDF-'
}

function looksZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50
}

function hasBinaryMagic(buf: Buffer): boolean {
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return true
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true
  if (buf.length >= 6) {
    const sig = buf.subarray(0, 6).toString('ascii')
    if (sig === 'GIF87a' || sig === 'GIF89a') return true
  }
  if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === 'RIFF') return true
  return false
}

function isUtf8Textish(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8192))
  if (sample.includes(0)) return false
  const decoded = sample.toString('utf8')
  if (decoded.includes('\uFFFD')) return false
  return true
}

function ooxmlKindFromExt(ext: string): WebContextKind | null {
  if (ext === '.docx') return 'docx'
  if (ext === '.pptx') return 'pptx'
  if (ext === '.xlsx') return 'xlsx'
  return null
}

export function looksOoxml(buf: Buffer, kind: WebContextKind): boolean {
  if (!looksZip(buf)) return false
  const hay = buf.subarray(0, Math.min(buf.length, 1024 * 1024)).toString('latin1')
  if (!hay.includes('[Content_Types].xml')) return false
  if (kind === 'docx') return hay.includes('word/')
  if (kind === 'pptx') return hay.includes('ppt/')
  if (kind === 'xlsx') return hay.includes('xl/')
  return false
}

export function sniffWebContextContent(
  body: Buffer,
  contentType: string,
  sourceUrl: string,
): SniffResult {
  const url = normalizeHttpUrl(sourceUrl)
  const ext = extname(url.pathname).toLowerCase()
  const mime = lowerMime(contentType)
  const extKind = ALLOWED_EXT_TO_KIND[ext]
  const ooxmlExtKind = ooxmlKindFromExt(ext)
  const binaryMime = UNSUPPORTED_BINARY_MIME_PREFIXES.some((p) => mime.startsWith(p))
  const unsupportedMime = binaryMime || UNSUPPORTED_BINARY_MIMES.has(mime)

  if (looksPdf(body)) return { kind: 'pdf', reason: 'pdf_magic' }

  if (ooxmlExtKind && looksOoxml(body, ooxmlExtKind)) {
    return { kind: ooxmlExtKind, reason: 'ooxml_magic' }
  }
  for (const kind of ['docx', 'pptx', 'xlsx'] as const) {
    if (mime === OOXML_MIME[kind]) {
      if (looksOoxml(body, kind)) return { kind, reason: 'ooxml_mime_magic' }
      return { kind: null, reason: 'ooxml_mime_without_ooxml_markers' }
    }
  }

  if (hasBinaryMagic(body)) return { kind: null, reason: 'unsupported_binary_magic' }
  if (looksZip(body)) return { kind: null, reason: 'unsupported_zip' }

  if (HTML_MIMES.has(mime) || (!unsupportedMime && looksHtml(body))) {
    if (extKind && extKind !== 'html' && extKind !== 'text') {
      return { kind: null, reason: 'extension_mime_mismatch' }
    }
    return { kind: 'html', reason: HTML_MIMES.has(mime) ? 'html_mime' : 'html_magic' }
  }

  if (TEXT_MIMES.has(mime) || (extKind === 'text' && isUtf8Textish(body))) {
    if (!isUtf8Textish(body)) return { kind: null, reason: 'text_mime_binary_body' }
    return { kind: 'text', reason: TEXT_MIMES.has(mime) ? 'text_mime' : 'text_extension' }
  }

  if (mime === PDF_MIME || extKind === 'pdf') return { kind: null, reason: 'pdf_without_pdf_magic' }
  if (ooxmlExtKind) return { kind: null, reason: 'ooxml_extension_without_ooxml_markers' }
  if (unsupportedMime) return { kind: null, reason: `unsupported_mime:${mime}` }
  if (!mime && looksHtml(body)) return { kind: 'html', reason: 'html_magic_no_mime' }
  if (!mime && isUtf8Textish(body)) return { kind: 'text', reason: 'textish_no_mime' }
  return { kind: null, reason: mime ? `unsupported_mime:${mime}` : 'unsupported_unknown_content' }
}

export function detectBlockedContent(status: number, body: Buffer): string | null {
  if (status === 403) return 'http_403'
  if (status === 429) return 'http_429'
  if (status === 503) return 'http_503'
  const sample = body
    .subarray(0, Math.min(body.length, 16 * 1024))
    .toString('utf8')
    .toLowerCase()
  const phrases = [
    'captcha',
    'cloudflare',
    'checking your browser',
    'access denied',
    'bot detection',
    'are you a human',
    'will be right back',
    'temporarily unavailable',
  ]
  for (const p of phrases) {
    if (sample.includes(p)) return `blocked_phrase:${p}`
  }
  return null
}

function collectWithCap(stream: Readable, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    stream.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        stream.destroy(new Error('decoded response exceeds size limit'))
        return
      }
      chunks.push(chunk)
    })
    stream.on('error', reject)
    stream.on('end', () => resolve(Buffer.concat(chunks, total)))
  })
}

async function decodeBody(
  encoded: Buffer,
  contentEncoding: string,
  maxDecodedBytes: number,
): Promise<Buffer> {
  const enc = contentEncoding.trim().toLowerCase()
  if (!enc || enc === 'identity')
    return encoded.length <= maxDecodedBytes
      ? encoded
      : Promise.reject(new Error('decoded response exceeds size limit'))
  if (enc.includes(',')) throw new Error(`unsupported content-encoding: ${contentEncoding}`)
  let decoder: NodeJS.ReadWriteStream
  if (enc === 'gzip' || enc === 'x-gzip') decoder = createGunzip()
  else if (enc === 'deflate') decoder = createInflate()
  else if (enc === 'br') decoder = createBrotliDecompress()
  else throw new Error(`unsupported content-encoding: ${contentEncoding}`)
  Readable.from(encoded).pipe(decoder)
  return await collectWithCap(decoder as unknown as Readable, maxDecodedBytes)
}

/** Node dns.lookup-compatible callback (the subset we drive). */
type PinnedLookupCb = (
  err: NodeJS.ErrnoException | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number,
) => void

/**
 * Build a DNS `lookup` hook for HttpAgent that always resolves `expectedHost` to
 * a pre-vetted public IP — the SSRF guard, so the socket can't connect to an IP
 * we never checked. Honours BOTH callback contracts: the legacy
 * `(address, family)` triplet and Node ≥18.13's autoSelectFamily `{ all: true }`
 * array form. Returning the triplet under `{ all: true }` made Node index
 * `addresses[0]` off a bare string → `ERR_INVALID_IP_ADDRESS: Invalid IP address:
 * undefined`, which broke every oc-web extract on Node 20.
 */
export function _buildPinnedLookup(
  pinned: { address: string; family: 4 | 6 },
  expectedHost: string,
) {
  return (hostname: string, options: { all?: boolean } | undefined, cb: PinnedLookupCb) => {
    try {
      if (normalizeHostname(hostname) !== expectedHost) {
        cb(new Error('unexpected hostname lookup') as NodeJS.ErrnoException, '', 0)
        return
      }
      if (options?.all) {
        cb(null, [{ address: pinned.address, family: pinned.family }])
      } else {
        cb(null, pinned.address, pinned.family)
      }
    } catch (err) {
      cb(err as NodeJS.ErrnoException, '', 0)
    }
  }
}

async function withTimeoutDeadline<T>(
  promise: Promise<T>,
  deadlineMs: number,
  message: string,
): Promise<T> {
  const rem = deadlineMs - Date.now()
  if (rem <= 0) throw new Error(message)
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), rem)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function requestOnce(
  url: URL,
  opts: Required<
    Pick<WebContextFetchOptions, 'timeoutMs' | 'maxEncodedBytes' | 'maxDecodedBytes' | 'userAgent'>
  > & {
    deadlineMs: number
    lookup: typeof dnsLookup
    connectSocket?: (opts: { host: string; port: number }) => net.Socket
  },
): Promise<{
  status: number
  headers: Record<string, string>
  body: Buffer
  encodedBytes: number
}> {
  const pinned = await withTimeoutDeadline(
    resolvePublicIp(url.hostname, opts.lookup),
    opts.deadlineMs,
    'request timed out',
  )
  const expectedHost = normalizeHostname(url.hostname)
  const agentLookup = _buildPinnedLookup(pinned, expectedHost)
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
  const agent: HttpAgent | HttpsAgent =
    url.protocol === 'https:'
      ? new HttpsAgent({ lookup: agentLookup as any })
      : new HttpAgent({ lookup: agentLookup as any })
  if (opts.connectSocket && url.protocol === 'http:' && agent instanceof HttpAgent) {
    const customConnect = opts.connectSocket
    agent.createConnection = () => customConnect({ host: pinned.address, port })
  }

  return await new Promise<{
    status: number
    headers: Record<string, string>
    body: Buffer
    encodedBytes: number
  }>((resolve, reject) => {
    const wallRemaining = opts.deadlineMs - Date.now()
    if (wallRemaining <= 0) {
      reject(new Error('request timed out'))
      return
    }
    const perHopTimeout = Math.max(1, Math.min(opts.timeoutMs, wallRemaining))
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        agent,
        timeout: perHopTimeout,
        headers: {
          'User-Agent': opts.userAgent,
          Accept: [
            'text/html',
            'text/plain',
            'text/markdown',
            'application/xhtml+xml',
            'application/xml',
            'text/xml',
            'application/json',
            'text/csv',
            'application/pdf',
            OOXML_MIME.docx,
            OOXML_MIME.pptx,
            OOXML_MIME.xlsx,
          ].join(','),
          'Accept-Encoding': 'gzip,br,deflate,identity',
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        let total = 0
        res.on('data', (chunk: Buffer) => {
          total += chunk.length
          if (total > opts.maxEncodedBytes) {
            req.destroy(new Error('encoded response exceeds size limit'))
            return
          }
          chunks.push(chunk)
        })
        res.on('error', reject)
        res.on('end', () => {
          const headers: Record<string, string> = {}
          for (const [key, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) headers[key.toLowerCase()] = value.join(',')
            else if (value !== undefined) headers[key.toLowerCase()] = String(value)
          }
          resolve({
            status: res.statusCode ?? 0,
            headers,
            body: Buffer.concat(chunks, total),
            encodedBytes: total,
          })
        })
      },
    )
    const wallTimer = setTimeout(() => {
      req.destroy(new Error('request timed out'))
    }, wallRemaining)
    req.on('close', () => clearTimeout(wallTimer))
    req.on('timeout', () => req.destroy(new Error('request timed out')))
    req.on('error', reject)
    req.end()
  }).finally(() => agent?.destroy())
}

function redirectTarget(current: URL, headers: Record<string, string>): URL | null {
  const loc = headerValue(headers, 'location')
  if (!loc) return null
  return normalizeHttpUrl(new URL(loc, current).toString())
}

export async function fetchWebContextUrl(
  rawUrl: string,
  options: WebContextFetchOptions = {},
): Promise<WebContextFetchResult> {
  let url = normalizeHttpUrl(rawUrl)
  const timeoutMs = parseBoundedInt(
    String(options.timeoutMs ?? ''),
    DEFAULT_WEB_CONTEXT_TIMEOUT_MS,
    1000,
    120_000,
  )
  const deadlineMs =
    typeof options.deadlineMs === 'number' && Number.isFinite(options.deadlineMs)
      ? options.deadlineMs
      : Date.now() + timeoutMs
  const maxRedirects = parseBoundedInt(
    String(options.maxRedirects ?? ''),
    DEFAULT_WEB_CONTEXT_MAX_REDIRECTS,
    0,
    10,
  )
  const maxEncodedBytes = Math.min(
    options.maxEncodedBytes ?? DEFAULT_WEB_CONTEXT_MAX_ENCODED_BYTES,
    HARD_WEB_CONTEXT_MAX_ENCODED_BYTES,
  )
  const maxDecodedBytes = Math.min(
    options.maxDecodedBytes ?? DEFAULT_WEB_CONTEXT_MAX_DECODED_BYTES,
    HARD_WEB_CONTEXT_MAX_DECODED_BYTES,
  )
  const common = {
    timeoutMs,
    deadlineMs,
    maxEncodedBytes,
    maxDecodedBytes,
    userAgent: options.userAgent ?? DEFAULT_UA,
    lookup: options.lookup ?? dnsLookup,
    connectSocket: options.connectSocket,
  }
  const redirects: string[] = []
  let encodedBytes = 0
  for (let i = 0; i <= maxRedirects; i++) {
    const remainingEncodedBytes = maxEncodedBytes - encodedBytes
    if (remainingEncodedBytes <= 0) throw new Error('encoded response exceeds size limit')
    const remainingTimeMs = deadlineMs - Date.now()
    if (remainingTimeMs <= 0) throw new Error('request timed out')
    const res = await requestOnce(url, {
      ...common,
      timeoutMs: Math.min(timeoutMs, remainingTimeMs),
      maxEncodedBytes: remainingEncodedBytes,
    })
    encodedBytes += res.encodedBytes
    const status = res.status
    if (status >= 300 && status < 400 && headerValue(res.headers, 'location')) {
      const next = redirectTarget(url, res.headers)
      if (!next) throw new Error('invalid redirect location')
      redirects.push(next.toString())
      url = next
      continue
    }
    const body = await decodeBody(
      res.body,
      headerValue(res.headers, 'content-encoding'),
      maxDecodedBytes,
    )
    const contentType = headerValue(res.headers, 'content-type')
    const sniff = sniffWebContextContent(body, contentType, url.toString())
    if (!sniff.kind) throw new Error(`unsupported_or_mismatched_content:${sniff.reason}`)
    return {
      url: rawUrl,
      finalUrl: url.toString(),
      status,
      headers: res.headers,
      body,
      encodedBytes,
      decodedBytes: body.length,
      contentType,
      kind: sniff.kind,
      redirects,
    }
  }
  throw new Error('too many redirects')
}

export interface WebContextSsrfProxyOptions {
  lookup?: typeof dnsLookup
  allowedHttpPorts?: ReadonlySet<number>
  allowedConnectPorts?: ReadonlySet<number>
  maxBytesPerRequest?: number
  socketTimeoutMs?: number
  connectSocket?: (opts: { host: string; port: number }) => net.Socket
}

export interface WebContextSsrfProxyStats {
  allowedCount: number
  blockedCount: number
  lastBlockedReason: string | null
}

export interface WebContextSsrfProxy {
  host: string
  port: number
  serverUrl: string
  username: string
  password: string
  getStats: () => WebContextSsrfProxyStats
  close: () => Promise<void>
}

const DEFAULT_ALLOWED_HTTP_PORTS = new Set([80, 443])
const DEFAULT_ALLOWED_CONNECT_PORTS = new Set([443])
const PROXY_HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function isAuthorizedProxyAuth(
  header: string | string[] | undefined,
  expectedBase64Buf: Buffer,
): boolean {
  const raw = Array.isArray(header) ? header[0] : header
  if (!raw || typeof raw !== 'string') return false
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(raw.trim())
  if (!match) return false
  const provided = Buffer.from(match[1], 'utf8')
  if (provided.length !== expectedBase64Buf.length) return false
  return timingSafeEqual(provided, expectedBase64Buf)
}

function copyHeadersWithoutHopByHop(
  src: IncomingHttpHeaders,
  extra?: Record<string, string>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue
    const lower = k.toLowerCase()
    if (PROXY_HOP_BY_HOP_HEADERS.has(lower) || lower === 'host') continue
    out[lower] = v
  }
  if (extra) Object.assign(out, extra)
  return out
}

function sendProxyHttpBlocked(res: ServerResponse, reason: string): void {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(403, {
    Connection: 'close',
    'Content-Type': 'text/plain; charset=utf-8',
    'X-OpenClaude-SSRF-Blocked': '1',
    'X-OpenClaude-SSRF-Reason': reason.replace(/[\r\n]+/g, ' ').slice(0, 200),
  })
  res.end(`SSRF guard blocked proxy request: ${reason}`)
}

function sendProxyConnectStatus(socket: Duplex, statusLine: string, extraHeaders = ''): void {
  if (socket.destroyed) return
  try {
    socket.write(`${statusLine}\r\n${extraHeaders}Connection: close\r\n\r\n`)
  } catch {
    /* ignore write error on closing socket */
  }
  socket.destroy()
}

function parseConnectTarget(
  rawAuthority: string | undefined,
  allowedPorts: ReadonlySet<number>,
): { hostname: string; port: number } {
  const raw = (rawAuthority ?? '').trim()
  if (!raw || /[\s/@?#]/.test(raw) || !/:\d+$/.test(raw)) {
    throw new Error('CONNECT target must be host:port')
  }
  const url = normalizeHttpUrl(`https://${raw}`)
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('CONNECT target contains unexpected URL components')
  }
  const port = url.port ? Number(url.port) : 443
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !allowedPorts.has(port)) {
    throw new Error(`CONNECT port ${port} is not allowed`)
  }
  return { hostname: url.hostname, port }
}

/**
 * Start a short-lived loopback HTTP + CONNECT proxy bound to 127.0.0.1:0 that
 * authenticates every request with a per-invocation secret and enforces the
 * same URL/port/public-IP SSRF guard (with IP pinning to prevent DNS rebinding)
 * on every navigation, redirect, and subresource request from headless Chromium.
 */
export async function startWebContextSsrfProxy(
  options: WebContextSsrfProxyOptions = {},
): Promise<WebContextSsrfProxy> {
  const lookup = options.lookup ?? dnsLookup
  const allowedHttpPorts = options.allowedHttpPorts ?? DEFAULT_ALLOWED_HTTP_PORTS
  const allowedConnectPorts = options.allowedConnectPorts ?? DEFAULT_ALLOWED_CONNECT_PORTS
  const maxBytesPerRequest = Math.min(
    Math.max(1024, Math.floor(options.maxBytesPerRequest ?? DEFAULT_WEB_CONTEXT_MAX_ENCODED_BYTES)),
    HARD_WEB_CONTEXT_MAX_ENCODED_BYTES,
  )
  const socketTimeoutMs = parseBoundedInt(
    String(options.socketTimeoutMs ?? ''),
    DEFAULT_WEB_CONTEXT_TIMEOUT_MS,
    1_000,
    120_000,
  )
  const connectSocket =
    options.connectSocket ??
    (({ host, port }) => {
      const family = net.isIP(host)
      return net.connect({ host, port, ...(family ? { family } : {}) })
    })

  const username = 'ocweb'
  const password = randomBytes(24).toString('hex')
  const expectedAuthBuf = Buffer.from(
    Buffer.from(`${username}:${password}`, 'utf8').toString('base64'),
    'utf8',
  )

  let allowedCount = 0
  let blockedCount = 0
  let lastBlockedReason: string | null = null
  let closed = false
  let closePromise: Promise<void> | null = null

  const activeSockets = new Set<Duplex>()
  const activeUpstreamReqs = new Set<ClientRequest>()

  const trackSocket = (sock: Duplex) => {
    activeSockets.add(sock)
    sock.on('error', () => {})
    sock.once('close', () => {
      activeSockets.delete(sock)
    })
  }

  const recordBlock = (reason: string) => {
    blockedCount += 1
    lastBlockedReason = reason
  }

  const server: HttpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (closed) {
      res.destroy()
      return
    }
    if (!isAuthorizedProxyAuth(req.headers['proxy-authorization'], expectedAuthBuf)) {
      res.writeHead(407, {
        'Proxy-Authenticate': 'Basic realm="oc-web-context"',
        Connection: 'close',
        'Content-Type': 'text/plain',
      })
      res.end('Proxy Authentication Required')
      return
    }

    let targetUrl: URL
    let port: number
    let pinned: { address: string; family: 4 | 6 }
    try {
      targetUrl = normalizeHttpUrl(req.url ?? '')
      if (targetUrl.protocol !== 'http:') {
        throw new Error('only http:// targets are valid on plain proxy requests; use CONNECT for https')
      }
      port = targetUrl.port ? Number(targetUrl.port) : 80
      if (!Number.isInteger(port) || port < 1 || port > 65535 || !allowedHttpPorts.has(port)) {
        throw new Error(`HTTP proxy port ${port} is not allowed`)
      }
      pinned = await resolvePublicIp(targetUrl.hostname, lookup)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      recordBlock(reason)
      sendProxyHttpBlocked(res, reason)
      return
    }

    if (closed || req.destroyed || res.destroyed) return
    allowedCount += 1

    const expectedHost = normalizeHostname(targetUrl.hostname)
    const agent = new HttpAgent({ lookup: _buildPinnedLookup(pinned, expectedHost) as any })
    if (options.connectSocket) {
      agent.createConnection = () => {
        const sock = connectSocket({ host: pinned.address, port })
        trackSocket(sock)
        return sock
      }
    }

    const cleanupAgent = () => {
      agent.destroy()
    }

    const upstreamReq = httpRequest(
      targetUrl,
      {
        method: req.method ?? 'GET',
        headers: copyHeadersWithoutHopByHop(req.headers, { host: targetUrl.host }),
        timeout: socketTimeoutMs,
        agent,
      },
      (upstreamRes) => {
        if (closed) {
          upstreamRes.destroy()
          return
        }
        let receivedBytes = 0
        res.writeHead(
          upstreamRes.statusCode ?? 502,
          copyHeadersWithoutHopByHop(upstreamRes.headers),
        )
        upstreamRes.on('data', (chunk: Buffer) => {
          receivedBytes += chunk.length
          if (receivedBytes > maxBytesPerRequest) {
            upstreamReq.destroy(new Error('proxy response exceeds size limit'))
            res.destroy()
            return
          }
          if (!res.write(chunk)) upstreamRes.pause()
        })
        res.on('drain', () => upstreamRes.resume())
        upstreamRes.on('end', () => {
          if (!res.writableEnded) res.end()
        })
        upstreamRes.on('error', () => {
          if (!res.destroyed) res.destroy()
        })
      },
    )

    activeUpstreamReqs.add(upstreamReq)
    upstreamReq.once('close', () => {
      activeUpstreamReqs.delete(upstreamReq)
      cleanupAgent()
    })
    upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('proxy upstream timed out')))
    upstreamReq.on('error', (err) => {
      if (!res.headersSent && !res.writableEnded && !res.destroyed) {
        res.writeHead(502, { Connection: 'close', 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(`Proxy upstream failed: ${err.message}`)
      } else if (!res.destroyed) {
        res.destroy()
      }
    })

    let sentBytes = 0
    req.on('data', (chunk: Buffer) => {
      sentBytes += chunk.length
      if (sentBytes > maxBytesPerRequest) {
        upstreamReq.destroy(new Error('proxy request body exceeds size limit'))
        req.destroy()
        return
      }
      if (!upstreamReq.write(chunk)) req.pause()
    })
    upstreamReq.on('drain', () => req.resume())
    req.on('end', () => upstreamReq.end())
    req.on('error', () => upstreamReq.destroy())
    req.on('aborted', () => upstreamReq.destroy())
    res.on('close', () => {
      if (!res.writableEnded) upstreamReq.destroy()
    })
  })

  server.on('connect', async (req: IncomingMessage, clientSocket: Duplex, head: Buffer) => {
    trackSocket(clientSocket)
    if (closed) {
      clientSocket.destroy()
      return
    }
    if (!isAuthorizedProxyAuth(req.headers['proxy-authorization'], expectedAuthBuf)) {
      sendProxyConnectStatus(
        clientSocket,
        'HTTP/1.1 407 Proxy Authentication Required',
        'Proxy-Authenticate: Basic realm="oc-web-context"\r\n',
      )
      return
    }

    let port: number
    let pinned: { address: string; family: 4 | 6 }
    try {
      const target = parseConnectTarget(req.url, allowedConnectPorts)
      port = target.port
      pinned = await resolvePublicIp(target.hostname, lookup)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      recordBlock(reason)
      sendProxyConnectStatus(clientSocket, 'HTTP/1.1 403 Forbidden')
      return
    }

    if (closed || clientSocket.destroyed) {
      clientSocket.destroy()
      return
    }
    allowedCount += 1

    const upstreamSocket = connectSocket({ host: pinned.address, port })
    trackSocket(upstreamSocket)
    ;(clientSocket as net.Socket).setTimeout?.(socketTimeoutMs, () => {
      clientSocket.destroy()
      upstreamSocket.destroy()
    })
    upstreamSocket.setTimeout(socketTimeoutMs, () => {
      upstreamSocket.destroy()
      clientSocket.destroy()
    })

    let connected = false
    const closeBoth = () => {
      if (!clientSocket.destroyed) clientSocket.destroy()
      if (!upstreamSocket.destroyed) upstreamSocket.destroy()
    }
    clientSocket.once('close', closeBoth)
    upstreamSocket.once('close', closeBoth)
    clientSocket.once('error', closeBoth)
    upstreamSocket.once('error', () => {
      if (!connected && !clientSocket.destroyed) {
        sendProxyConnectStatus(clientSocket, 'HTTP/1.1 502 Bad Gateway')
      }
      closeBoth()
    })

    upstreamSocket.once('connect', () => {
      connected = true
      if (closed || clientSocket.destroyed) {
        closeBoth()
        return
      }
      try {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      } catch {
        closeBoth()
        return
      }
      let tunnelBytes = head.length
      if (tunnelBytes > maxBytesPerRequest) {
        closeBoth()
        return
      }
      if (head.length > 0) upstreamSocket.write(head)
      clientSocket.on('data', (chunk: Buffer) => {
        tunnelBytes += chunk.length
        if (tunnelBytes > maxBytesPerRequest) closeBoth()
      })
      upstreamSocket.on('data', (chunk: Buffer) => {
        tunnelBytes += chunk.length
        if (tunnelBytes > maxBytesPerRequest) closeBoth()
      })
      clientSocket.pipe(upstreamSocket)
      upstreamSocket.pipe(clientSocket)
    })
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening)
      reject(err)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0, '127.0.0.1')
  })

  const addr = server.address()
  if (!addr || typeof addr === 'string') {
    server.close()
    throw new Error('failed to bind web-context SSRF proxy')
  }

  return {
    host: '127.0.0.1',
    port: addr.port,
    serverUrl: `http://127.0.0.1:${addr.port}`,
    username,
    password,
    getStats: () => ({ allowedCount, blockedCount, lastBlockedReason }),
    close: () => {
      if (closePromise) return closePromise
      closed = true
      closePromise = (async () => {
        for (const req of activeUpstreamReqs) req.destroy()
        activeUpstreamReqs.clear()
        for (const sock of activeSockets) sock.destroy()
        activeSockets.clear()
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections()
        }
        await new Promise<void>((resolve) => {
          server.close(() => resolve())
        })
      })()
      return closePromise
    },
  }
}
