import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'

export const SITE_EDGE_PREFIX = '/__oc_sites_edge/v1'
export const SITE_EDGE_V2_PREFIX = '/__oc_sites_edge/v2'
export const SITE_BUNDLE_MAGIC = Buffer.from('OCSB1\n', 'ascii')
export const SITE_BUNDLE_MAGIC_V2 = Buffer.from('OCSB2\n', 'ascii')
export const SITE_MAX_FILES = 500
export const SITE_MAX_SINGLE_FILE_BYTES = 10 * 1024 * 1024
export const DEFAULT_SITE_MAX_TOTAL_BYTES = 25 * 1024 * 1024
export const DEFAULT_SITE_MAX_PER_USER = 20
export const SITE_AUTH_COOKIE_NAME = 'oc_site_auth'
export const SITE_PREVIEW_COOKIE_NAME = '__oc_site_preview'
export const SITE_PREVIEW_BOOT_TTL_SEC = 60
export const SITE_PREVIEW_TTL_SEC = 30 * 60
export const SITE_EDGE_SIGNATURE_WINDOW_SEC = 300
export const SITE_SERVER_API_PATH = '__oc_server/api.mjs'
export const SITE_MAX_ENV_VARS = 64
export const SITE_MAX_ENV_VALUE_BYTES = 16 * 1024
export const SITE_MAX_ENV_TOTAL_BYTES = 256 * 1024
export const SITE_MAX_COLLABORATORS = 50
export const SITE_MAX_ACTIVE_INVITES = 20

export type SiteVisibility = 'public' | 'password' | 'disabled'
export type SiteAccessRole = 'owner' | 'editor' | 'viewer'
export type SiteCollaboratorRole = 'editor' | 'viewer'

export type SitesErrorCode =
  | 'SITES_DISABLED'
  | 'INVALID_SLUG'
  | 'RESERVED_SLUG'
  | 'SLUG_TAKEN'
  | 'SITE_NOT_FOUND'
  | 'FORBIDDEN'
  | 'INVITE_INVALID'
  | 'USER_NOT_FOUND'
  | 'QUOTA_EXCEEDED'
  | 'INVALID_BUNDLE'
  | 'PASSWORD_REQUIRED'
  | 'INVALID_INPUT'
  | 'EDGE_UNAVAILABLE'
  | 'STALE_REVISION'
  | 'SLUG_BUSY'
  | 'DOMAIN_TAKEN'
  | 'API_TIMEOUT'
  | 'INTERNAL'

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

const CUSTOM_DOMAIN_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
const IPV4_LITERAL_RE = /^\d+(?:\.\d+){3}$/
const DISALLOWED_CUSTOM_DOMAIN_TLDS = new Set(['local', 'localhost', 'internal', 'arpa', 'invalid', 'test'])
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const BLOCKED_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'NODE_OPTIONS',
  'NODE_PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'UV_THREADPOOL_SIZE',
  'OC_SITES_EDGE_SECRET',
  'DATABASE_URL',
])

export function validateCustomDomain(raw: string, baseDomain: string): string {
  if (typeof raw !== 'string') {
    throw new SitesError('INVALID_INPUT', '自定义域名必须是字符串', 400)
  }
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\.+$/, '')

  if (!normalized || normalized.length > 253 || !CUSTOM_DOMAIN_RE.test(normalized)) {
    throw new SitesError('INVALID_INPUT', '请输入合法的自定义域名，例如 app.example.com', 400)
  }
  if (IPV4_LITERAL_RE.test(normalized)) {
    throw new SitesError('INVALID_INPUT', '自定义域名不能是 IP 地址', 400)
  }
  const parts = normalized.split('.')
  const tld = parts[parts.length - 1] ?? ''
  if (DISALLOWED_CUSTOM_DOMAIN_TLDS.has(tld)) {
    throw new SitesError('INVALID_INPUT', `不支持使用 .${tld} 内网域名`, 400)
  }
  const base = baseDomain.trim().toLowerCase()
  if (normalized === base || normalized.endsWith(`.${base}`)) {
    throw new SitesError(
      'INVALID_INPUT',
      `请使用站外自定义域名，不要填写 *.${base} 平台子域名（改子域名请用「URL 更改」）`,
      400,
    )
  }
  return normalized
}

export function validateEnvVarKey(raw: string): string {
  if (typeof raw !== 'string') {
    throw new SitesError('INVALID_INPUT', '环境变量名必须是字符串', 400)
  }
  const key = raw.trim()
  if (!ENV_KEY_RE.test(key)) {
    throw new SitesError(
      'INVALID_INPUT',
      '环境变量名只能包含字母、数字和下划线，且不能以数字开头',
      400,
    )
  }
  if (BLOCKED_ENV_KEYS.has(key.toUpperCase())) {
    throw new SitesError('INVALID_INPUT', `环境变量名 ${key} 为系统保留键`, 400)
  }
  return key
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ASCII control-char path sanitization
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/
const IGNORED_SEGMENT_NAMES = new Set(['.git', 'node_modules', '__pycache__', '.DS_Store', '.oc-site-state.json'])
export const RESERVED_SERVER_API_ALIAS_PATHS: ReadonlySet<string> = new Set([
  'server/api.mjs',
  'api/index.mjs',
])

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
  const normalized = segments.join('/')
  const lower = normalized.toLowerCase()
  if ((lower === '__oc_server' || lower.startsWith('__oc_server/')) && normalized !== SITE_SERVER_API_PATH) {
    throw new SitesError('INVALID_BUNDLE', `保留服务端目录路径不合法: ${relPath}`, 400)
  }
  if (RESERVED_SERVER_API_ALIAS_PATHS.has(lower)) {
    throw new SitesError(
      'INVALID_BUNDLE',
      `保留服务端入口路径禁止作为静态文件上传 (${relPath})；服务端代码请打包为 ${SITE_SERVER_API_PATH}`,
      400,
    )
  }
  return normalized
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
  hasServerApi: boolean
  serverApiSha256: string
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

  const hasServerApi = seen.has(SITE_SERVER_API_PATH)
  const magic = hasServerApi ? SITE_BUNDLE_MAGIC_V2 : SITE_BUNDLE_MAGIC
  const header = Buffer.allocUnsafe(magic.length + 4)
  magic.copy(header, 0)
  header.writeUInt32BE(manifestBuf.length, magic.length)

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

  const magicLen = SITE_BUNDLE_MAGIC.length
  const minHeaderLen = magicLen + 4
  const headMagic = raw.subarray(0, magicLen)
  const isV1 = raw.length >= minHeaderLen && headMagic.equals(SITE_BUNDLE_MAGIC)
  const isV2 = raw.length >= minHeaderLen && headMagic.equals(SITE_BUNDLE_MAGIC_V2)
  if (!isV1 && !isV2) {
    throw new SitesError('INVALID_BUNDLE', '无效的站点包格式标识', 400)
  }

  const manifestLen = raw.readUInt32BE(magicLen)
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

  const serverApiFile = files.find((f) => f.path === SITE_SERVER_API_PATH)
  const hasServerApi = Boolean(serverApiFile)
  if (isV1 && hasServerApi) {
    throw new SitesError('INVALID_BUNDLE', '包含服务端 API 的站点包必须使用 OCSB2 格式', 400)
  }

  return {
    files,
    fileCount: files.length,
    sizeBytes: totalBytes,
    contentSha256,
    hasServerApi,
    serverApiSha256: serverApiFile?.sha256 ?? '',
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

export function parseSiteCollaboratorRole(
  raw: unknown,
  fallback: SiteCollaboratorRole = 'editor',
): SiteCollaboratorRole {
  if (raw === undefined || raw === null) return fallback
  if (raw === 'editor' || raw === 'viewer') return raw
  throw new SitesError('INVALID_INPUT', '协作者角色仅支持 editor / viewer', 400)
}

export function normalizePreviewParentOrigin(raw: string): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new SitesError('INVALID_INPUT', '无效的预览父页面来源', 400)
  }
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    throw new SitesError('INVALID_INPUT', '无效的预览父页面来源', 400)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SitesError('INVALID_INPUT', '预览父页面来源必须是 http 或 https', 400)
  }
  return parsed.origin
}

export type SitePreviewTokenKind = 'boot' | 'sess'

export interface SitePreviewTokenPayload {
  v: 2
  kind: SitePreviewTokenKind
  siteId: string
  slug: string
  parentOrigin: string
  aclVersion: number
  nonce?: string
  expSec: number
}

function derivePreviewTokenKey(secret: string): Buffer {
  return createHmac('sha256', secret).update('oc-site-preview-token-v2').digest()
}

export function signSitePreviewToken(args: {
  secret: string
  kind: SitePreviewTokenKind
  siteId: string
  slug: string
  parentOrigin: string
  aclVersion: number
  nonce?: string
  expSec: number
}): string {
  const aclVersion = Math.max(1, Math.trunc(args.aclVersion))
  const payload: SitePreviewTokenPayload = {
    v: 2,
    kind: args.kind,
    siteId: args.siteId,
    slug: validateSiteSlug(args.slug),
    parentOrigin: normalizePreviewParentOrigin(args.parentOrigin),
    aclVersion,
    ...(args.nonce ? { nonce: args.nonce } : {}),
    expSec: Math.trunc(args.expSec),
  }
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const sig = createHmac('sha256', derivePreviewTokenKey(args.secret))
    .update(payloadB64)
    .digest('hex')
  return `${payloadB64}.${sig}`
}

export function verifySitePreviewToken(args: {
  secret: string
  token: string | undefined
  expectedSlug: string
  expectedKind: SitePreviewTokenKind
  nowSec?: number
}): SitePreviewTokenPayload | null {
  if (!args.token || typeof args.token !== 'string') return null
  const dot = args.token.indexOf('.')
  if (dot <= 0 || dot !== args.token.lastIndexOf('.')) return null
  const payloadB64 = args.token.slice(0, dot)
  const sig = args.token.slice(dot + 1)
  if (!/^[A-Za-z0-9_-]{16,1024}$/.test(payloadB64) || !/^[a-f0-9]{64}$/.test(sig)) {
    return null
  }
  const expectedSig = createHmac('sha256', derivePreviewTokenKey(args.secret))
    .update(payloadB64)
    .digest('hex')
  const a = Buffer.from(sig, 'hex')
  const b = Buffer.from(expectedSig, 'hex')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >
    if (
      !parsed ||
      parsed.v !== 2 ||
      parsed.kind !== args.expectedKind ||
      typeof parsed.siteId !== 'string' ||
      !parsed.siteId ||
      typeof parsed.slug !== 'string' ||
      parsed.slug !== args.expectedSlug ||
      typeof parsed.parentOrigin !== 'string' ||
      typeof parsed.aclVersion !== 'number' ||
      !Number.isSafeInteger(parsed.aclVersion) ||
      parsed.aclVersion < 1 ||
      typeof parsed.expSec !== 'number' ||
      !Number.isSafeInteger(parsed.expSec)
    ) {
      return null
    }
    if (args.expectedKind === 'boot') {
      if (typeof parsed.nonce !== 'string' || !/^[a-f0-9]{16,64}$/.test(parsed.nonce)) {
        return null
      }
    }
    const nowSec = args.nowSec ?? Math.floor(Date.now() / 1000)
    if (parsed.expSec <= nowSec) return null
    const parentOrigin = normalizePreviewParentOrigin(parsed.parentOrigin)
    return {
      v: 2,
      kind: args.expectedKind,
      siteId: parsed.siteId,
      slug: parsed.slug,
      parentOrigin,
      aclVersion: parsed.aclVersion,
      ...(typeof parsed.nonce === 'string' ? { nonce: parsed.nonce } : {}),
      expSec: parsed.expSec,
    }
  } catch {
    return null
  }
}

export function hashSiteInviteToken(token: string): string {
  return createHash('sha256').update(`oc-site-invite-v1:${token}`, 'utf8').digest('hex')
}

export interface EdgeMetaEnvelope {
  siteId?: string
  title: string
  visibility: SiteVisibility
  passwordSalt: string | null
  passwordHash: string | null
  spaMode: boolean
  customDomain?: string | null
  hasServerApi?: boolean
  envDigest?: string
  contentSha256?: string
  previewAclVersion?: number
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
        ...(typeof parsed.siteId === 'string' && parsed.siteId ? { siteId: parsed.siteId } : {}),
        title: typeof parsed.title === 'string' ? parsed.title : '',
        visibility,
        passwordSalt: typeof parsed.passwordSalt === 'string' ? parsed.passwordSalt : null,
        passwordHash: typeof parsed.passwordHash === 'string' ? parsed.passwordHash : null,
        spaMode: parsed.spaMode !== false,
        ...(parsed.customDomain === null
          ? { customDomain: null }
          : typeof parsed.customDomain === 'string'
            ? { customDomain: parsed.customDomain }
            : {}),
        ...(typeof parsed.hasServerApi === 'boolean' ? { hasServerApi: parsed.hasServerApi } : {}),
        ...(typeof parsed.envDigest === 'string' ? { envDigest: parsed.envDigest } : {}),
        ...(typeof parsed.contentSha256 === 'string' ? { contentSha256: parsed.contentSha256 } : {}),
        ...(typeof parsed.previewAclVersion === 'number' &&
        Number.isSafeInteger(parsed.previewAclVersion) &&
        parsed.previewAclVersion >= 1
          ? { previewAclVersion: parsed.previewAclVersion }
          : {}),
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

export type CustomDomainStatus = 'none' | 'pending' | 'verified'
export type SiteOpKind = 'publish' | 'meta' | 'env' | 'rename' | 'delete'

export interface UserSiteRow {
  id: string
  slug: string
  userId: number
  accessRole?: SiteAccessRole
  ownerEmail?: string | null
  ownerDisplayName?: string | null
  collaboratorCount?: number
  title: string
  visibility: SiteVisibility
  passwordSalt: string | null
  passwordHash: string | null
  spaMode: boolean
  customDomain: string | null
  customDomainVerified: boolean
  customDomainToken: string | null
  originSessionId: string | null
  hasServerApi: boolean
  serverApiSha256?: string
  opServerApiSha256?: string | null
  previewAclVersion?: number
  previewAclTargetVersion?: number
  envDigest: string
  opKind?: SiteOpKind | null
  opRenameToSlug?: string | null
  opEnvDigest?: string | null
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
  accessRole: SiteAccessRole
  ownerEmail: string | null
  ownerDisplayName: string | null
  collaboratorCount: number
  customDomain: string | null
  customDomainStatus: CustomDomainStatus
  customDomainTxtName: string | null
  customDomainTxtValue: string | null
  originSessionId: string | null
  hasServerApi: boolean
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

export interface SiteCollaboratorDto {
  userId: number
  email: string
  displayName: string | null
  role: SiteCollaboratorRole
  createdAt: string
  updatedAt: string
}

export interface SiteInviteDto {
  id: string
  role: SiteCollaboratorRole
  maxUses: number | null
  useCount: number
  expiresAt: string | null
  createdAt: string
}

export interface SiteInvitePreviewDto {
  valid: boolean
  site: {
    id: string
    slug: string
    title: string
    url: string
  }
  role: SiteCollaboratorRole
  ownerEmail: string | null
  ownerDisplayName: string | null
  expiresAt: string | null
  alreadyRole: SiteAccessRole | null
}

export interface SitePreviewSessionDto {
  bootstrapUrl: string
  siteOrigin: string
  siteUrl: string
  expiresAt: string
}

export interface SiteEnvVarDto {
  key: string
  value: string | null
  isSecret: boolean
  hasValue: boolean
  updatedAt: string
}

export interface SiteAnalyticsPoint {
  date: string
  uniqueVisitors: number
  requests: number
  pageViews: number
}

export interface SiteAnalyticsResponse {
  days: number
  totals: {
    uniqueVisitors: number
    requests: number
    pageViews: number
  }
  series: SiteAnalyticsPoint[]
}

export interface SiteDbTableSummary {
  name: string
  rowCount: number
}

export interface SiteDbColumnInfo {
  name: string
  type: string
  pk: boolean
  notnull: boolean
}

export interface SiteDbInspectResponse {
  connected: boolean
  hasDatabaseFile: boolean
  sizeBytes: number
  tables: SiteDbTableSummary[]
  selectedTable: string | null
  columns: SiteDbColumnInfo[]
  rows: Array<Record<string, unknown>>
  truncated?: boolean
}

export interface SiteDbQueryResponse {
  columns: string[]
  rows: Array<Record<string, unknown>>
  changes: number
  lastInsertRowid: number | string | null
  truncated?: boolean
}

export function customDomainTxtValueFor(siteId: string, token: string): string {
  return `oc-site-verify=${siteId}.${token}`
}

export function toUserSiteDto(row: UserSiteRow, baseDomain: string): UserSiteDto {
  const accessRole: SiteAccessRole = row.accessRole ?? 'owner'
  const isOwner = accessRole === 'owner'
  const customDomainStatus: CustomDomainStatus = !row.customDomain
    ? 'none'
    : row.customDomainVerified
      ? 'verified'
      : 'pending'
  const txtName = isOwner && row.customDomain ? `_oc-site-verify.${row.customDomain}` : null
  const txtVal =
    isOwner && row.customDomain && row.customDomainToken
      ? customDomainTxtValueFor(row.id, row.customDomainToken)
      : null
  return {
    id: row.id,
    slug: row.slug,
    url: `https://${row.slug}.${baseDomain}`,
    accessRole,
    ownerEmail: row.ownerEmail ?? null,
    ownerDisplayName: row.ownerDisplayName ?? null,
    collaboratorCount: row.collaboratorCount ?? 0,
    customDomain: row.customDomain,
    customDomainStatus,
    customDomainTxtName: txtName,
    customDomainTxtValue: txtVal,
    originSessionId: isOwner ? row.originSessionId : null,
    hasServerApi: row.hasServerApi,
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
