/**
 * providers/webdav — 坚果云 / Nextcloud / 通用 WebDAV(自由域 provider)。
 *
 * 出站纪律(outboundPolicy §5):每次请求 validateWebdavBaseUrl(https/无 userinfo/
 * 无 query/非 IP 字面量)→ DNS 全记录 global-unicast 校验 → IP 钉死建连
 * (pinnedHttpsFetch,hostname 只作 SNI)→ 禁 redirect。Basic 凭据只进 Authorization
 * 头,绝不进 URL。
 *
 * actions:list_dir / get_file / put_file★。
 * PROPFIND multistatus 用轻量正则解析(非安全边界:结果侧字段仍过 allowlist schema
 * + enforceResultLimits;不引第三方 XML 依赖)。
 */

import { createHash } from 'node:crypto'
import { ConnectorError } from '../errors.js'
import { type DnsResolver, pinnedHttpsFetch, validateWebdavBaseUrl } from '../outboundPolicy.js'
import type { WebdavSecret } from '../store.js'
import {
  MAX_FILE_RAW_BYTES,
  mapFetchFailure,
  mapUpstreamStatus,
  readBoundedBody,
} from './shared.js'

export interface WebdavDeps {
  resolver?: DnsResolver
  fetchImpl?: (input: string, init: Record<string, unknown>) => Promise<Response>
}

function basicAuthHeader(secret: WebdavSecret): string {
  return `Basic ${Buffer.from(`${secret.username}:${secret.password}`, 'utf8').toString('base64')}`
}

/** 归一化远端路径:必须以 / 开头,禁 ..、禁反斜杠、禁控制字符。 */
export function normalizeRemotePath(p: string): string {
  const raw = p.startsWith('/') ? p : `/${p}`
  // 禁反斜杠与控制字符(0x00-0x1f, 0x7f)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 有意拦截路径中的控制字符(安全校验)
  if (raw.includes('\\') || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new ConnectorError('BAD_REQUEST', 'invalid characters in path')
  }
  const segs = raw.split('/')
  if (segs.some((s) => s === '..')) {
    throw new ConnectorError('BAD_REQUEST', 'path traversal not allowed')
  }
  return raw.replace(/\/{2,}/g, '/')
}

function buildUrl(secret: WebdavSecret, remotePath: string): URL {
  const base = validateWebdavBaseUrl(secret.serverUrl)
  const encoded = remotePath
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/')
  return new URL(`${base.origin}${base.basePath}${encoded}`)
}

async function davFetch(
  secret: WebdavSecret,
  remotePath: string,
  init: { method: string; headers?: Record<string, string>; body?: string | Buffer },
  deps: WebdavDeps,
): Promise<Response> {
  const url = buildUrl(secret, remotePath)
  const headers: Record<string, string> = {
    Authorization: basicAuthHeader(secret),
    'User-Agent': 'OpenClaude-Connector/1',
    ...init.headers,
  }
  try {
    return await pinnedHttpsFetch(url, { ...init, headers }, deps)
  } catch (err) {
    throw mapFetchFailure(err, 'webdav')
  }
}

// ─── 绑定期验证 ───────────────────────────────────────────────────────────

/** 绑定探活:PROPFIND Depth 0 根;401/403 → UPSTREAM_AUTH_FAILED。 */
export async function verifyWebdavCredentials(
  secret: WebdavSecret,
  deps: WebdavDeps = {},
): Promise<void> {
  const res = await davFetch(
    secret,
    '/',
    {
      method: 'PROPFIND',
      headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
      body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>`,
    },
    deps,
  )
  if (res.status === 207 || res.ok) {
    await res.body?.cancel().catch(() => {})
    return
  }
  await res.body?.cancel().catch(() => {})
  throw mapUpstreamStatus(res.status, 'webdav')
}

// ─── PROPFIND 解析(轻量) ────────────────────────────────────────────────

interface DavEntry {
  name: string
  path: string
  isDir: boolean
  size?: number
  mtime?: string
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
}

/** 从 multistatus XML 提取条目(容忍任意命名空间前缀)。 */
export function parseMultistatus(xml: string, basePath: string): DavEntry[] {
  const entries: DavEntry[] = []
  const responses =
    xml.match(/<[a-zA-Z0-9]*:?response[\s>][\s\S]*?<\/[a-zA-Z0-9]*:?response>/g) ?? []
  for (const block of responses) {
    const hrefM = block.match(/<[a-zA-Z0-9]*:?href[^>]*>([\s\S]*?)<\/[a-zA-Z0-9]*:?href>/)
    if (!hrefM) continue
    let href = decodeXmlEntities(hrefM[1]!.trim())
    try {
      // href 可能是绝对 URL 或绝对路径
      if (/^https?:\/\//i.test(href)) href = new URL(href).pathname
    } catch {
      continue
    }
    let decoded: string
    try {
      decoded = href
        .split('/')
        .map((s) => decodeURIComponent(s))
        .join('/')
    } catch {
      decoded = href
    }
    // 去掉 dav 基路径前缀,得到用户视角路径
    let rel = decoded
    if (basePath && rel.startsWith(basePath)) rel = rel.slice(basePath.length)
    if (!rel.startsWith('/')) rel = `/${rel}`
    const isDir = /<[a-zA-Z0-9]*:?collection\s*\/?>/.test(block) || rel.endsWith('/')
    const normalized = rel.replace(/\/+$/, '') || '/'
    const name = normalized.split('/').filter(Boolean).pop() ?? '/'
    const sizeM = block.match(
      /<[a-zA-Z0-9]*:?getcontentlength[^>]*>(\d+)<\/[a-zA-Z0-9]*:?getcontentlength>/,
    )
    const mtimeM = block.match(
      /<[a-zA-Z0-9]*:?getlastmodified[^>]*>([\s\S]*?)<\/[a-zA-Z0-9]*:?getlastmodified>/,
    )
    entries.push({
      name,
      path: normalized,
      isDir,
      ...(sizeM ? { size: Number(sizeM[1]) } : {}),
      ...(mtimeM ? { mtime: decodeXmlEntities(mtimeM[1]!.trim()) } : {}),
    })
  }
  return entries
}

// ─── actions ─────────────────────────────────────────────────────────────

export async function webdavListDir(
  secret: WebdavSecret,
  params: { path?: string },
  deps: WebdavDeps = {},
): Promise<unknown> {
  const remotePath = normalizeRemotePath(params.path ?? '/')
  const res = await davFetch(
    secret,
    remotePath.endsWith('/') ? remotePath : `${remotePath}/`,
    {
      method: 'PROPFIND',
      headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
      body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>`,
    },
    deps,
  )
  if (res.status !== 207 && !res.ok) {
    await res.body?.cancel().catch(() => {})
    throw mapUpstreamStatus(res.status, 'webdav')
  }
  const xml = (await readBoundedBody(res, 2 * 1024 * 1024, 'webdav')).toString('utf8')
  const base = validateWebdavBaseUrl(secret.serverUrl)
  const all = parseMultistatus(xml, base.basePath)
  // 第一条通常是目录自身 → 滤掉;硬截 200
  const self = remotePath.replace(/\/+$/, '') || '/'
  const entries = all.filter((e) => e.path !== self).slice(0, 200)
  return { path: self, entries }
}

export async function webdavGetFile(
  secret: WebdavSecret,
  params: { path: string },
  deps: WebdavDeps = {},
): Promise<unknown> {
  const remotePath = normalizeRemotePath(params.path)
  const res = await davFetch(secret, remotePath, { method: 'GET' }, deps)
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    throw mapUpstreamStatus(res.status, 'webdav')
  }
  let bytes: Buffer
  try {
    bytes = await readBoundedBody(res, MAX_FILE_RAW_BYTES, 'webdav')
  } catch (err) {
    if (err instanceof ConnectorError && err.code === 'RESULT_TOO_LARGE') {
      throw new ConnectorError('FILE_TOO_LARGE', 'file exceeds 6MB(base64) cap')
    }
    throw err
  }
  return {
    path: remotePath,
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    contentBase64: bytes.toString('base64'),
  }
}

export async function webdavPutFile(
  secret: WebdavSecret,
  params: { path: string; contentBase64: string },
  deps: WebdavDeps = {},
): Promise<unknown> {
  const remotePath = normalizeRemotePath(params.path)
  const bytes = Buffer.from(params.contentBase64, 'base64')
  if (bytes.length > MAX_FILE_RAW_BYTES) {
    throw new ConnectorError('FILE_TOO_LARGE', 'file exceeds 6MB(base64) cap')
  }
  const res = await davFetch(
    secret,
    remotePath,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    },
    deps,
  )
  await res.body?.cancel().catch(() => {})
  if (!res.ok) throw mapUpstreamStatus(res.status, 'webdav')
  return {
    path: remotePath,
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

export async function executeWebdav(
  secret: WebdavSecret,
  action: string,
  params: Record<string, unknown>,
  deps: WebdavDeps = {},
): Promise<unknown> {
  switch (action) {
    case 'list_dir':
      return webdavListDir(secret, params as { path?: string }, deps)
    case 'get_file':
      return webdavGetFile(secret, params as { path: string }, deps)
    case 'put_file':
      return webdavPutFile(secret, params as { path: string; contentBase64: string }, deps)
    default:
      throw new ConnectorError('ACTION_UNKNOWN', `webdav has no action ${action}`)
  }
}
