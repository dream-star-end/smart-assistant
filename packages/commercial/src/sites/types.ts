import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'

export const SITE_EDGE_PREFIX = '/__oc_sites_edge/v1'
export const SITE_BUNDLE_MAGIC = Buffer.from('OCSB1\n', 'ascii')
export const SITE_MAX_FILES = 500
export const SITE_MAX_SINGLE_FILE_BYTES = 10 * 1024 * 1024
export const DEFAULT_SITE_MAX_TOTAL_BYTES = 25 * 1024 * 1024
export const DEFAULT_SITE_MAX_PER_USER = 20
export const SITE_AUTH_COOKIE_NAME = 'oc_site_auth'
export const SITE_EDGE_SIGNATURE_WINDOW_SEC = 300

export type SiteVisibility = 'public' | 'password' | 'disabled'

export type SitesErrorCode =
  | 'SITES_DISABLED'
  | 'INVALID_SLUG'
  | 'RESERVED_SLUG'
  | 'SLUG_TAKEN'
  | 'SITE_NOT_FOUND'
  | 'QUOTA_EXCEEDED'
  | 'INVALID_BUNDLE'
  | 'PASSWORD_REQUIRED'
  | 'INVALID_INPUT'
  | 'EDGE_UNAVAILABLE'
  | 'STALE_REVISION'
  | 'SLUG_BUSY'

export class SitesError extends Error {
  constructor(
    readonly code: SitesErrorCode,
    message: string,
    readonly status: number,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'SitesError'
  }
}

export const RESERVED_SITE_SLUGS: ReadonlySet<string> = new Set([
  'www', 'api', 'app', 'admin', 'auth', 'account', 'accounts', 'assets',
  'billing', 'blog', 'cdn', 'chat', 'console', 'dashboard', 'dev', 'docs',
  'download', 'downloads', 'edge', 'files', 'ftp', 'git', 'gateway',
  'health', 'healthz', 'help', 'imap', 'internal', 'login', 'm', 'mail',
  'manage', 'market', 'marketplace', 'media', 'mcp', 'monitor', 'mx',
  'ns', 'ns1', 'ns2', 'oauth', 'openclaude', 'ops', 'org', 'panel',
  'pay', 'payment', 'platform', 'pop', 'portal', 'preview', 'prod',
  'public', 'relay', 'remote', 'root', 's', 'sandbox', 'sec', 'security',
  'site', 'sites', 'smtp', 'sso', 'stage', 'staging', 'static', 'status',
  'store', 'studio', 'supabase', 'support', 'system', 'team', 'test',
  'tls', 'tunnel', 'upload', 'uploads', 'user', 'users', 'v1', 'v2',
  'v3', 'v4', 'v5', 'vpn', 'web', 'webhooks', 'ws', 'wss',
])

const SLUG_FORMAT_RE = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/
const ALL_DIGITS_RE = /^\d+$/

export function validateSiteSlug(raw: string): string {
  if (typeof raw !== 'string') {
    throw new SitesError('INVALID_SLUG', '站点标识必须是字符串', 400)
  }
  const slug = raw.trim().toLowerCase()
  if (!SLUG_FORMAT_RE.test(slug) || slug.startsWith('xn--') || ALL_DIGITS_RE.test(slug)) {
    throw new SitesError(
      'INVALID_SLUG',
      '站点子域名只能包含 3–48 位小写字母、数字和连字符（不能以连字符开头/结尾、纯数字或 xn-- 开头）',
      400,
    )
  }
  if (RESERVED_SITE_SLUGS.has(slug)) {
    throw new SitesError('RESERVED_SLUG', `子域名 "${slug}" 为平台保留名，请换一个名称`, 400)
  }
  return slug
}

export function generateRandomSiteSlug(): string {
  return `site-${randomBytes(4).toString('hex')}`
}

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/
const IGNORED_SEGMENT_NAMES = new Set(['.git', 'node_modules', '__pycache__', '.DS_Store'])

export function normalizeRelativeAssetPath(relPath: string): string {
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.length > 512) {
    throw new SitesError('INVALID_BUNDLE', '文件路径为空或过长', 400)
  }
  if (relPath.includes('\\') || CONTROL_CHAR_RE.test(relPath)) {
    throw new SitesError('INVALID_BUNDLE', `非法文件路径: ${relPath}`, 400)
  }
  const stripped = relPath.replace(/^(?:\.\/)+/, '')
  if (stripped.length === 0 || stripped.startsWith('/') || stripped.endsWith('/')) {
    throw new SitesError('INVALID_BUNDLE', `非法文件路径: ${relPath}`, 400)
  }
  const segments = stripped.split('/')
  if (segments.length > 16) {
    throw new SitesError('INVALID_BUNDLE', `目录层级过深: ${relPath}`, 400)
  }
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') {
      throw new SitesError('INVALID_BUNDLE', `不允许相对跳转路径: ${relPath}`, 400)
    }
    if (IGNORED_SEGMENT_NAMES.has(seg)) {
      throw new SitesError('INVALID_BUNDLE', `不允许包含敏感或依赖目录 (${seg}): ${relPath}`, 400)
    }
    if (seg === '.env' || seg.startsWith('.env.')) {
      throw new SitesError('INVALID_BUNDLE', `安全拦截：禁止上传环境变量文件 ${relPath}`, 400)
    }
  }
  return segments.join('/')
}

export interface SiteBundleManifestEntry {
  path: string
  size: number
  sha256: string
}

export interface DecodedSiteFile {
  path: string
  content: Buffer
  sha256: string
}

export interface DecodedSiteBundle {
  files: DecodedSiteFile[]
  fileCount: number
  sizeBytes: number
  contentSha256: string
}

export function encodeSiteBundle(
  inputFiles: ReadonlyArray<{ path: string; content: Buffer }>,
  maxTotalBytes = DEFAULT_SITE_MAX_TOTAL_BYTES,
): { gzipped: Buffer; fileCount: number; sizeBytes: number; contentSha256: string } {
  if (inputFiles.length === 0) {
    throw new SitesError('INVALID_BUNDLE', '站点内容不能为空', 400)
  }
  if (inputFiles.length > SITE_MAX_FILES) {
    throw new SitesError('INVALID_BUNDLE', `文件数量超过上限（最多 ${SITE_MAX_FILES} 个）`, 400)
  }

  const seen = new Set<string>()
  const normalized: Array<{ path: string; content: Buffer; sha256: string }> = []
  let totalBytes = 0

  for (const item of inputFiles) {
    const cleanPath = normalizeRelativeAssetPath(item.path)
    if (seen.has(cleanPath)) {
      throw new SitesError('INVALID_BUNDLE', `重复的文件路径: ${cleanPath}`, 400)
    }
    seen.add(cleanPath)
    if (item.content.length > SITE_MAX_SINGLE_FILE_BYTES) {
      throw new SitesError(
        'INVALID_BUNDLE',
        `单文件超过 10 MiB 上限: ${cleanPath}`,
        413,
      )
    }
    totalBytes += item.content.length
    if (totalBytes > maxTotalBytes) {
      throw new SitesError('INVALID_BUNDLE', '站点总大小超过配额上限', 413)
    }
    const sha256 = createHash('sha256').update(item.content).digest('hex')
    normalized.push({ path: cleanPath, content: item.content, sha256 })
  }

  if (!seen.has('index.html')) {
    throw new SitesError('INVALID_BUNDLE', '站点根目录必须包含 index.html', 400)
  }

  normalized.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const manifest: SiteBundleManifestEntry[] = normalized.map((f) => ({
    path: f.path,
    size: f.content.length,
    sha256: f.sha256,
  }))
  const manifestBuf = Buffer.from(JSON.stringify(manifest), 'utf8')
  const contentSha256 = createHash('sha256').update(manifestBuf).digest('hex')

  const header = Buffer.allocUnsafe(SITE_BUNDLE_MAGIC.length + 4)
  SITE_BUNDLE_MAGIC.copy(header, 0)
  header.writeUInt32BE(manifestBuf.length, SITE_BUNDLE_MAGIC.length)

  const rawBundle = Buffer.concat([header, manifestBuf, ...normalized.map((f) => f.content)])
  return {
    gzipped: gzipSync(rawBundle, { level: 6 }),
    fileCount: normalized.length,
    sizeBytes: totalBytes,
    contentSha256,
  }
}

export function decodeSiteBundle(
  gzipped: Buffer,
  maxTotalBytes = DEFAULT_SITE_MAX_TOTAL_BYTES,
): DecodedSiteBundle {
  if (!Buffer.isBuffer(gzipped) || gzipped.length === 0) {
    throw new SitesError('INVALID_BUNDLE', '缺少站点压缩包内容', 400)
  }
  const maxRawBytes = maxTotalBytes + 4 * 1024 * 1024
  let raw: Buffer
  try {
    raw = gunzipSync(gzipped, { maxOutputLength: maxRawBytes })
  } catch {
    throw new SitesError('INVALID_BUNDLE', '站点包解压失败或超出大小上限', 400)
  }

  const minHeaderLen = SITE_BUNDLE_MAGIC.length + 4
  if (raw.length < minHeaderLen || !raw.subarray(0, SITE_BUNDLE_MAGIC.length).equals(SITE_BUNDLE_MAGIC)) {
    throw new SitesError('INVALID_BUNDLE', '无效的站点包格式标识', 400)
  }

  const manifestLen = raw.readUInt32BE(SITE_BUNDLE_MAGIC.length)
  if (manifestLen === 0 || manifestLen > 4 * 1024 * 1024 || minHeaderLen + manifestLen > raw.length) {
    throw new SitesError('INVALID_BUNDLE', '站点包清单长度异常', 400)
  }

  const manifestBuf = raw.subarray(minHeaderLen, minHeaderLen + manifestLen)
  let manifest: unknown
  try {
    manifest = JSON.parse(manifestBuf.toString('utf8'))
  } catch {
    throw new SitesError('INVALID_BUNDLE', '站点包清单 JSON 解析失败', 400)
  }
  if (!Array.isArray(manifest) || manifest.length === 0 || manifest.length > SITE_MAX_FILES) {
    throw new SitesError('INVALID_BUNDLE', '站点包文件条目数不合法', 400)
  }

  let cursor = minHeaderLen + manifestLen
  let totalBytes = 0
  let hasIndex = false
  const seen = new Set<string>()
  const files: DecodedSiteFile[] = []

  for (const item of manifest) {
    if (!item || typeof item !== 'object') {
      throw new SitesError('INVALID_BUNDLE', '站点包条目结构不合法', 400)
    }
    const entry = item as Record<string, unknown>
    if (
      typeof entry.path !== 'string' ||
      typeof entry.size !== 'number' ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.size > SITE_MAX_SINGLE_FILE_BYTES ||
      typeof entry.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      throw new SitesError('INVALID_BUNDLE', '站点包清单字段校验失败', 400)
    }
    const cleanPath = normalizeRelativeAssetPath(entry.path)
    if (seen.has(cleanPath)) {
      throw new SitesError('INVALID_BUNDLE', `站点包存在重复路径: ${cleanPath}`, 400)
    }
    seen.add(cleanPath)
    if (cleanPath === 'index.html') hasIndex = true

    totalBytes += entry.size
    if (totalBytes > maxTotalBytes) {
      throw new SitesError('INVALID_BUNDLE', '站点总大小超过上限', 413)
    }
    if (cursor + entry.size > raw.length) {
      throw new SitesError('INVALID_BUNDLE', '站点包内容被截断', 400)
    }

    const content = raw.subarray(cursor, cursor + entry.size)
    cursor += entry.size
    const actualSha = createHash('sha256').update(content).digest('hex')
    if (actualSha !== entry.sha256) {
      throw new SitesError('INVALID_BUNDLE', `文件校验和不匹配: ${cleanPath}`, 400)
    }
    files.push({ path: cleanPath, content, sha256: actualSha })
  }

  if (cursor !== raw.length) {
    throw new SitesError('INVALID_BUNDLE', '站点包尾部存在多余字节', 400)
  }
  if (!hasIndex) {
    throw new SitesError('INVALID_BUNDLE', '站点根目录必须包含 index.html', 400)
  }

  const canonicalManifestBuf = Buffer.from(
    JSON.stringify(
      [...files]
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .map((f) => ({ path: f.path, size: f.content.length, sha256: f.sha256 })),
    ),
    'utf8',
  )
  const contentSha256 = createHash('sha256').update(canonicalManifestBuf).digest('hex')

  return {
    files,
    fileCount: files.length,
    sizeBytes: totalBytes,
    contentSha256,
  }
}

export function validateSitePasswordInput(password: unknown): string {
  if (typeof password !== 'string' || password.length < 4 || password.length > 128) {
    throw new SitesError('PASSWORD_REQUIRED', '口令保护模式需要设置 4–128 位访问口令', 400)
  }
  return password
}

export function hashSitePassword(password: string): { salt: string; hash: string } {
  const valid = validateSitePasswordInput(password)
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(valid, salt, 64).toString('hex')
  return { salt, hash }
}

export function verifySitePassword(password: string, salt: string, expectedHash: string): boolean {
  if (!password || !salt || !/^[a-f0-9]{128}$/.test(expectedHash)) return false
  const actual = scryptSync(password, salt, 64)
  const expected = Buffer.from(expectedHash, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function normalizeSiteTitle(raw: unknown, fallbackSlug: string): string {
  if (typeof raw !== 'string') return fallbackSlug
  const trimmed = raw.trim().slice(0, 80)
  return trimmed || fallbackSlug
}

export function parseSiteVisibility(raw: unknown, fallback: SiteVisibility = 'public'): SiteVisibility {
  if (raw === undefined || raw === null) return fallback
  if (raw === 'public' || raw === 'password' || raw === 'disabled') return raw
  throw new SitesError('INVALID_INPUT', 'visibility 仅支持 public / password / disabled', 400)
}

export interface EdgeMetaEnvelope {
  title: string
  visibility: SiteVisibility
  passwordSalt: string | null
  passwordHash: string | null
  spaMode: boolean
  contentSha256?: string
  expectedBaseRevision?: number
}

export interface SignedEdgeHeaders {
  'x-oc-sites-timestamp': string
  'x-oc-sites-nonce': string
  'x-oc-sites-revision': string
  'x-oc-sites-sha256': string
  'x-oc-sites-meta': string
  'x-oc-sites-signature': string
}

export function signEdgeHeaders(args: {
  secret: string
  method: string
  pathname: string
  revision: number | string
  body: Buffer
  meta?: EdgeMetaEnvelope
  timestampSec?: number
  nonce?: string
}): SignedEdgeHeaders {
  const timestamp = String(args.timestampSec ?? Math.floor(Date.now() / 1000))
  const nonce = args.nonce ?? randomBytes(16).toString('hex')
  const revision = String(args.revision)
  const bodySha256 = createHash('sha256').update(args.body).digest('hex')
  const metaB64 = args.meta ? Buffer.from(JSON.stringify(args.meta), 'utf8').toString('base64url') : ''
  const canonical = `${args.method.toUpperCase()}\n${args.pathname}\n${timestamp}\n${nonce}\n${revision}\n${metaB64}\n${bodySha256}`
  const signature = createHmac('sha256', args.secret).update(canonical).digest('hex')
  return {
    'x-oc-sites-timestamp': timestamp,
    'x-oc-sites-nonce': nonce,
    'x-oc-sites-revision': revision,
    'x-oc-sites-sha256': bodySha256,
    'x-oc-sites-meta': metaB64,
    'x-oc-sites-signature': signature,
  }
}

export function verifyEdgeHeaders(args: {
  secret: string
  method: string
  pathname: string
  headers: Record<string, string | string[] | undefined>
  body: Buffer
  nowSec?: number
}): { revision: number; nonce: string; bodySha256: string; meta: EdgeMetaEnvelope | null } {
  const get = (name: string): string => {
    const v = args.headers[name]
    return typeof v === 'string' ? v : Array.isArray(v) ? (v[0] ?? '') : ''
  }
  const timestampStr = get('x-oc-sites-timestamp')
  const nonce = get('x-oc-sites-nonce')
  const revisionStr = get('x-oc-sites-revision')
  const bodyShaHeader = get('x-oc-sites-sha256')
  const metaB64 = get('x-oc-sites-meta')
  const sig = get('x-oc-sites-signature')

  if (!/^\d{9,15}$/.test(timestampStr) || !/^[a-f0-9]{16,64}$/.test(nonce) || !/^\d+$/.test(revisionStr) || !/^[a-f0-9]{64}$/.test(sig)) {
    throw new SitesError('INVALID_INPUT', 'invalid edge signature headers', 401)
  }
  const nowSec = args.nowSec ?? Math.floor(Date.now() / 1000)
  const ts = Number(timestampStr)
  if (Math.abs(nowSec - ts) > SITE_EDGE_SIGNATURE_WINDOW_SEC) {
    throw new SitesError('INVALID_INPUT', 'edge request timestamp expired', 401)
  }
  const revision = Number(revisionStr)
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw new SitesError('INVALID_INPUT', 'invalid edge revision', 400)
  }
  const actualSha = createHash('sha256').update(args.body).digest('hex')
  if (actualSha !== bodyShaHeader) {
    throw new SitesError('INVALID_INPUT', 'edge payload sha256 mismatch', 400)
  }

  const canonical = `${args.method.toUpperCase()}\n${args.pathname}\n${timestampStr}\n${nonce}\n${revisionStr}\n${metaB64}\n${actualSha}`
  const expected = createHmac('sha256', args.secret).update(canonical).digest('hex')
  const a = Buffer.from(sig, 'hex')
  const b = Buffer.from(expected, 'hex')
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new SitesError('INVALID_INPUT', 'edge signature mismatch', 401)
  }

  let meta: EdgeMetaEnvelope | null = null
  if (metaB64.length > 0) {
    try {
      const parsed = JSON.parse(Buffer.from(metaB64, 'base64url').toString('utf8')) as Record<string, unknown>
      const visibility = parseSiteVisibility(parsed.visibility, 'public')
      meta = {
        title: typeof parsed.title === 'string' ? parsed.title : '',
        visibility,
        passwordSalt: typeof parsed.passwordSalt === 'string' ? parsed.passwordSalt : null,
        passwordHash: typeof parsed.passwordHash === 'string' ? parsed.passwordHash : null,
        spaMode: parsed.spaMode !== false,
        ...(typeof parsed.contentSha256 === 'string' ? { contentSha256: parsed.contentSha256 } : {}),
        ...(typeof parsed.expectedBaseRevision === 'number' &&
        Number.isSafeInteger(parsed.expectedBaseRevision) &&
        parsed.expectedBaseRevision >= 0
          ? { expectedBaseRevision: parsed.expectedBaseRevision }
          : {}),
      }
      if (meta.visibility === 'password' && (!meta.passwordSalt || !meta.passwordHash)) {
        throw new Error('missing password hash')
      }
    } catch {
      throw new SitesError('INVALID_INPUT', 'invalid edge meta envelope', 400)
    }
  }
  return { revision, nonce, bodySha256: actualSha, meta }
}

export interface UserSiteRow {
  id: string
  slug: string
  userId: number
  title: string
  visibility: SiteVisibility
  passwordSalt: string | null
  passwordHash: string | null
  spaMode: boolean
  fileCount: number
  sizeBytes: number
  contentSha256: string
  edgeRevision: number
  createdAt: Date
  updatedAt: Date
  lastPublishedAt: Date
}

export interface UserSiteDto {
  id: string
  slug: string
  url: string
  title: string
  visibility: SiteVisibility
  spaMode: boolean
  fileCount: number
  sizeBytes: number
  contentSha256: string
  edgeRevision: number
  createdAt: string
  updatedAt: string
  lastPublishedAt: string
}

export function toUserSiteDto(row: UserSiteRow, baseDomain: string): UserSiteDto {
  return {
    id: row.id,
    slug: row.slug,
    url: `https://${row.slug}.${baseDomain}`,
    title: row.title,
    visibility: row.visibility,
    spaMode: row.spaMode,
    fileCount: row.fileCount,
    sizeBytes: row.sizeBytes,
    contentSha256: row.contentSha256,
    edgeRevision: row.edgeRevision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastPublishedAt: row.lastPublishedAt.toISOString(),
  }
}
