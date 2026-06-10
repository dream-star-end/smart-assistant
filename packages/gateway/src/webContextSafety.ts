import { lookup as dnsLookup } from 'node:dns/promises'
import { Agent as HttpAgent, request as httpRequest } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import * as net from 'node:net'
import { extname } from 'node:path'
import { Readable } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'

export type WebContextKind = 'html' | 'text' | 'pdf' | 'docx' | 'pptx' | 'xlsx'

export interface WebContextFetchOptions {
  timeoutMs?: number
  maxRedirects?: number
  maxEncodedBytes?: number
  maxDecodedBytes?: number
  userAgent?: string
  lookup?: typeof dnsLookup
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
  if (net.isIP(host)) {
    const address = normalizeIp(host)
    if (!isPublicIpAddress(address)) throw new Error('URL resolves to a non-public IP address')
    return { address, family: net.isIP(address) as 4 | 6 }
  }
  const records = await lookup(host, { all: true, verbatim: false })
  for (const rec of records) {
    const address = normalizeIp(rec.address)
    if (isPublicIpAddress(address)) return { address, family: rec.family as 4 | 6 }
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

async function requestOnce(
  url: URL,
  opts: Required<
    Pick<WebContextFetchOptions, 'timeoutMs' | 'maxEncodedBytes' | 'maxDecodedBytes' | 'userAgent'>
  > & { lookup: typeof dnsLookup },
): Promise<{
  status: number
  headers: Record<string, string>
  body: Buffer
  encodedBytes: number
}> {
  const pinned = await resolvePublicIp(url.hostname, opts.lookup)
  const expectedHost = normalizeHostname(url.hostname)
  const agentLookup = (
    hostname: string,
    _options: unknown,
    cb: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
  ) => {
    try {
      if (normalizeHostname(hostname) !== expectedHost) {
        cb(new Error('unexpected hostname lookup') as NodeJS.ErrnoException, '', 0)
        return
      }
      cb(null, pinned.address, pinned.family)
    } catch (err) {
      cb(err as NodeJS.ErrnoException, '', 0)
    }
  }
  const agent: HttpAgent | HttpsAgent =
    url.protocol === 'https:'
      ? new HttpsAgent({ lookup: agentLookup as any })
      : new HttpAgent({ lookup: agentLookup as any })

  return await new Promise<{
    status: number
    headers: Record<string, string>
    body: Buffer
    encodedBytes: number
  }>((resolve, reject) => {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        agent,
        timeout: opts.timeoutMs,
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
    req.on('timeout', () => req.destroy(new Error('request timed out')))
    req.on('error', reject)
    req.end()
  }).finally(() => agent.destroy())
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
    maxEncodedBytes,
    maxDecodedBytes,
    userAgent: options.userAgent ?? DEFAULT_UA,
    lookup: options.lookup ?? dnsLookup,
  }
  const redirects: string[] = []
  let encodedBytes = 0
  for (let i = 0; i <= maxRedirects; i++) {
    const remainingEncodedBytes = maxEncodedBytes - encodedBytes
    if (remainingEncodedBytes <= 0) throw new Error('encoded response exceeds size limit')
    const res = await requestOnce(url, { ...common, maxEncodedBytes: remainingEncodedBytes })
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
