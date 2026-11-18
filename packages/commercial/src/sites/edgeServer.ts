import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import { extname, join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  DEFAULT_SITE_MAX_TOTAL_BYTES,
  type EdgeMetaEnvelope,
  SITE_AUTH_COOKIE_NAME,
  SITE_EDGE_PREFIX,
  SITE_EDGE_SIGNATURE_WINDOW_SEC,
  type SiteVisibility,
  SitesError,
  decodeSiteBundle,
  validateSiteSlug,
  verifyEdgeHeaders,
  verifySitePassword,
} from './types.js'

export interface SitesEdgeServerOptions {
  bind?: string
  port?: number
  dataRoot: string
  baseDomain: string
  secret: string
  maxSiteBytes?: number
  trustLoopbackOnlyForTlsAsk?: boolean
  unlockCookieTtlSec?: number
}

interface StoredSiteMeta {
  slug: string
  revision: number
  title: string
  visibility: SiteVisibility
  passwordSalt: string | null
  passwordHash: string | null
  spaMode: boolean
  fileCount: number
  sizeBytes: number
  contentSha256: string
  updatedAt: string
}

interface TombstoneMeta {
  revision: number
  deletedAt: string
}

const MAX_NONCE_CACHE = 10_000
const MAX_UNLOCK_FAIL_CACHE = 10_000
const UNLOCK_WINDOW_MS = 5 * 60_000
const UNLOCK_MAX_FAILS = 10
const DEFAULT_UNLOCK_COOKIE_TTL_SEC = 7 * 24 * 3600
const MAX_CONTROL_JSON_BYTES = 128 * 1024
const MAX_UNLOCK_BODY_BYTES = 8 * 1024

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.cjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
}

function isLoopbackIp(addr: string | undefined): boolean {
  if (!addr) return false
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

function sendJsonResponse(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(body)
}

function sendSiteHtml(res: ServerResponse, status: number, html: string, isPrivate = false): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', isPrivate ? 'private, no-store' : 'no-store')
  if (isPrivate) {
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Vary', 'Cookie')
  }
  setPublicSiteSecurityHeaders(res)
  res.end(html)
}

function setPublicSiteSecurityHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none')
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderUnlockHtml(args: {
  title: string
  redirectPath: string
  errorMsg?: string
}): string {
  const safeTitle = escapeHtml(args.title)
  const safeRedirect = escapeHtml(args.redirectPath)
  const safeErr = args.errorMsg ? `<p class="err">${escapeHtml(args.errorMsg)}</p>` : ''
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeTitle} — 访问验证</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; min-height: 100vh; display: grid; place-items: center; background: #0d100e; color: #f1f5f2; }
  .card { width: min(92vw, 380px); padding: 28px; border-radius: 16px; background: #161b18; border: 1px solid #28312b; box-shadow: 0 20px 50px rgba(0,0,0,.35); }
  h1 { margin: 0 0 8px; font-size: 18px; font-weight: 600; }
  p.hint { margin: 0 0 18px; font-size: 14px; color: #9aa79f; line-height: 1.5; }
  p.err { margin: 0 0 14px; padding: 10px 12px; border-radius: 10px; background: rgba(239,68,68,.15); color: #fca5a5; font-size: 13px; }
  input { width: 100%; box-sizing: border-box; padding: 11px 12px; border-radius: 10px; border: 1px solid #334038; background: #0f1311; color: inherit; font-size: 15px; margin-bottom: 14px; outline: none; }
  input:focus { border-color: #34d399; }
  button { width: 100%; padding: 11px 16px; border: 0; border-radius: 10px; background: #10b981; color: #052e1e; font-weight: 600; font-size: 15px; cursor: pointer; }
  button:hover { background: #34d399; }
</style>
</head>
<body>
  <form class="card" method="post" action="/__oc_site_unlock">
    <h1>${safeTitle}</h1>
    <p class="hint">该站点受口令保护，请输入访问口令继续。</p>
    ${safeErr}
    <input type="hidden" name="redirect" value="${safeRedirect}">
    <input type="password" name="password" placeholder="输入访问口令" autocomplete="current-password" required autofocus>
    <button type="submit">解锁访问</button>
  </form>
</body>
</html>`
}

function renderStatusHtml(title: string, desc: string): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,-apple-system,sans-serif;background:#0d100e;color:#e5e7eb}main{padding:24px;max-width:440px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#9ca3af;font-size:14px;line-height:1.6}</style>
</head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(desc)}</p></main></body></html>`
}

async function readBodyLimited(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > maxBytes) {
      throw new SitesError('INVALID_BUNDLE', `payload exceeds ${maxBytes} bytes`, 413)
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

function writeFileAtomic(targetPath: string, data: string): void {
  const tmp = `${targetPath}.tmp-${randomBytes(6).toString('hex')}`
  writeFileSync(tmp, data, 'utf8')
  renameSync(tmp, targetPath)
}

function readJsonIfExists<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const k = part.slice(0, eq).trim()
    const v = part.slice(eq + 1).trim()
    if (k) out[k] = v
  }
  return out
}

function sanitizeRedirectTarget(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/'
  return raw.slice(0, 512)
}

function extractSubdomainSlug(hostOrDomain: string, baseDomain: string): string | null {
  const host = hostOrDomain.trim().toLowerCase().replace(/:\d+$/, '')
  const suffix = `.${baseDomain.toLowerCase()}`
  if (!host.endsWith(suffix)) return null
  const label = host.slice(0, -suffix.length)
  if (!label || label.includes('.')) return null
  try {
    return validateSiteSlug(label)
  } catch {
    return null
  }
}

function hasImmutableAssetHint(relPath: string): boolean {
  if (relPath.startsWith('assets/') || relPath.startsWith('_next/static/')) return true
  return /(?:^|[._-])[a-f0-9]{8,}\.[a-z0-9]{1,8}$/i.test(relPath)
}

function resolveCandidateFile(currentReal: string, relPath: string): string | null {
  const candidates: string[] = []
  if (relPath === '') {
    candidates.push('index.html')
  } else {
    candidates.push(relPath)
    candidates.push(`${relPath}/index.html`)
    if (!extname(relPath)) {
      candidates.push(`${relPath}.html`)
    }
  }
  for (const cand of candidates) {
    const abs = join(currentReal, cand)
    if (!existsSync(abs)) continue
    let st: ReturnType<typeof lstatSync>
    try {
      st = lstatSync(abs)
    } catch {
      continue
    }
    if (!st.isFile() || st.isSymbolicLink()) continue
    const resolved = realpathSync(abs)
    if (resolved !== currentReal && !resolved.startsWith(currentReal + sep)) continue
    return resolved
  }
  return null
}

function serveStaticFile(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  relHint: string,
  status = 200,
  visibility: SiteVisibility = 'public',
): void {
  const st = statSync(filePath)
  const etag = `"${st.size.toString(16)}-${Math.trunc(st.mtimeMs).toString(16)}"`
  const ext = extname(filePath).toLowerCase()
  const mime = MIME_TYPES[ext]
  const contentType = mime ?? 'application/octet-stream'

  setPublicSiteSecurityHeaders(res)
  res.setHeader('Content-Type', contentType)
  if (!mime) {
    res.setHeader('Content-Disposition', 'attachment')
  }
  if (visibility !== 'public') {
    // Never allow shared/browser caching or conditional 304 revalidation for protected content (B4).
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Vary', 'Cookie')
  } else {
    if (ext === '.html' || ext === '.htm' || status >= 400) {
      res.setHeader('Cache-Control', 'no-cache')
    } else if (hasImmutableAssetHint(relHint)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    } else {
      res.setHeader('Cache-Control', 'public, max-age=300')
    }
    res.setHeader('ETag', etag)

    if (status === 200 && req.headers['if-none-match'] === etag) {
      res.statusCode = 304
      res.end()
      return
    }
  }

  res.statusCode = status
  res.setHeader('Content-Length', String(st.size))
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  const stream = createReadStream(filePath)
  stream.on('error', () => {
    if (!res.headersSent) res.statusCode = 500
    res.destroy()
  })
  stream.pipe(res)
}

export function createSitesEdgeServer(opts: SitesEdgeServerOptions): {
  server: Server
  listen(): Promise<{ port: number; address: string }>
  close(): Promise<void>
} {
  const dataRoot = opts.dataRoot
  const sitesDir = join(dataRoot, 'sites')
  mkdirSync(sitesDir, { recursive: true })
  const baseDomain = opts.baseDomain.toLowerCase()
  const maxSiteBytes = opts.maxSiteBytes ?? DEFAULT_SITE_MAX_TOTAL_BYTES
  const trustLoopback = opts.trustLoopbackOnlyForTlsAsk ?? true
  const cookieTtlSec = opts.unlockCookieTtlSec ?? DEFAULT_UNLOCK_COOKIE_TTL_SEC
  const cookieSecret = createHmac('sha256', opts.secret).update('oc-site-auth-cookie-v1').digest()

  const slugLocks = new Map<string, Promise<void>>()
  const usedNonces = new Map<string, number>()
  const unlockFailures = new Map<string, { count: number; inflight: number; resetAt: number }>()

  const sweepTimer = setInterval(() => {
    const nowMs = Date.now()
    for (const [k, exp] of usedNonces) {
      if (exp <= nowMs) usedNonces.delete(k)
    }
    for (const [k, v] of unlockFailures) {
      if (v.resetAt <= nowMs && v.inflight <= 0) unlockFailures.delete(k)
    }
  }, 60_000)
  sweepTimer.unref()

  async function withSlugLock<T>(slug: string, fn: () => Promise<T>): Promise<T> {
    const prev = slugLocks.get(slug) ?? Promise.resolve()
    let release!: () => void
    const cur = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = prev.then(
      () => cur,
      () => cur,
    )
    slugLocks.set(slug, tail)
    await prev.catch(() => {})
    try {
      return await fn()
    } finally {
      release()
      if (slugLocks.get(slug) === tail) {
        slugLocks.delete(slug)
      }
    }
  }

  function recordNonce(nonce: string): void {
    const nowMs = Date.now()
    const existingExp = usedNonces.get(nonce)
    if (existingExp && existingExp > nowMs) {
      throw new SitesError('INVALID_INPUT', 'edge nonce replay rejected', 401)
    }
    if (usedNonces.size >= MAX_NONCE_CACHE) {
      for (const [k, exp] of usedNonces) {
        if (exp <= nowMs || usedNonces.size >= MAX_NONCE_CACHE) usedNonces.delete(k)
        if (usedNonces.size < MAX_NONCE_CACHE * 0.8) break
      }
    }
    usedNonces.set(nonce, nowMs + (SITE_EDGE_SIGNATURE_WINDOW_SEC + 60) * 1000)
  }

  function signSiteCookie(slug: string, passwordHash: string, expSec: number): string {
    const expHex = expSec.toString(16)
    const sig = createHmac('sha256', cookieSecret)
      .update(`${slug}:${passwordHash}:${expHex}`)
      .digest('hex')
    return `${expHex}.${sig}`
  }

  function verifySiteCookie(slug: string, passwordHash: string, rawVal: string | undefined): boolean {
    if (!rawVal) return false
    const parts = rawVal.split('.')
    if (parts.length !== 2) return false
    const [expHex, sig] = parts as [string, string]
    if (!/^[a-f0-9]{1,12}$/.test(expHex) || !/^[a-f0-9]{64}$/.test(sig)) return false
    const expSec = Number.parseInt(expHex, 16)
    if (!Number.isSafeInteger(expSec) || expSec <= Math.floor(Date.now() / 1000)) return false
    const expected = createHmac('sha256', cookieSecret)
      .update(`${slug}:${passwordHash}:${expHex}`)
      .digest('hex')
    const a = Buffer.from(sig, 'hex')
    const b = Buffer.from(expected, 'hex')
    return a.length === b.length && timingSafeEqual(a, b)
  }

  function siteDirOf(slug: string): string {
    return join(sitesDir, slug)
  }

  function readMetaAndTombstone(slug: string): {
    meta: StoredSiteMeta | null
    tombstone: TombstoneMeta | null
    currentLink: string
  } {
    const dir = siteDirOf(slug)
    return {
      meta: readJsonIfExists<StoredSiteMeta>(join(dir, 'meta.json')),
      tombstone: readJsonIfExists<TombstoneMeta>(join(dir, 'tombstone.json')),
      currentLink: join(dir, 'current'),
    }
  }

  function isSiteServable(slug: string): { meta: StoredSiteMeta; currentReal: string } | null {
    const { meta, tombstone, currentLink } = readMetaAndTombstone(slug)
    if (!meta || meta.visibility === 'disabled') return null
    if (tombstone && tombstone.revision >= meta.revision) return null
    if (!existsSync(currentLink)) return null
    try {
      const currentReal = realpathSync(currentLink)
      const siteRoot = realpathSync(siteDirOf(slug))
      if (!currentReal.startsWith(siteRoot + sep)) return null
      return { meta, currentReal }
    } catch {
      return null
    }
  }

  async function handleControlApi(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<void> {
    const method = req.method ?? 'GET'
    if (method === 'GET' && pathname === `${SITE_EDGE_PREFIX}/healthz`) {
      sendJsonResponse(res, 200, { ok: true, baseDomain })
      return
    }

    const putOrDeleteMatch = new RegExp(`^${SITE_EDGE_PREFIX}/sites/([^/]+)$`).exec(pathname)
    const patchMatch = new RegExp(`^${SITE_EDGE_PREFIX}/sites/([^/]+)/meta$`).exec(pathname)
    let rawSlug = ''
    try {
      rawSlug = decodeURIComponent(putOrDeleteMatch?.[1] ?? patchMatch?.[1] ?? '')
    } catch {
      throw new SitesError('INVALID_SLUG', 'invalid slug encoding', 400)
    }

    if (!rawSlug) {
      sendJsonResponse(res, 404, { error: { code: 'NOT_FOUND', message: 'not found' } })
      return
    }

    const slug = validateSiteSlug(rawSlug)
    const body = await readBodyLimited(
      req,
      method === 'PUT' ? maxSiteBytes + 4 * 1024 * 1024 : MAX_CONTROL_JSON_BYTES,
    )
    const verified = verifyEdgeHeaders({
      secret: opts.secret,
      method,
      pathname,
      headers: req.headers,
      body,
    })
    recordNonce(verified.nonce)

    if (method === 'GET' && putOrDeleteMatch) {
      await withSlugLock(slug, async () => {
        const { meta: curMeta, tombstone } = readMetaAndTombstone(slug)
        const liveRevision =
          curMeta && (!tombstone || tombstone.revision < curMeta.revision) ? curMeta.revision : 0
        sendJsonResponse(res, 200, {
          exists: liveRevision > 0,
          revision: liveRevision,
          tombstoneRevision: tombstone?.revision ?? 0,
          ...(liveRevision > 0 && curMeta
            ? {
                meta: {
                  title: curMeta.title,
                  visibility: curMeta.visibility,
                  passwordSalt: curMeta.passwordSalt,
                  passwordHash: curMeta.passwordHash,
                  spaMode: curMeta.spaMode,
                  fileCount: curMeta.fileCount,
                  sizeBytes: curMeta.sizeBytes,
                  contentSha256: curMeta.contentSha256,
                },
              }
            : {}),
        })
      })
      return
    }

    if (method === 'PUT' && putOrDeleteMatch) {
      const decoded = decodeSiteBundle(body, maxSiteBytes)
      const envelope: EdgeMetaEnvelope = verified.meta ?? {
        title: slug,
        visibility: 'public',
        passwordSalt: null,
        passwordHash: null,
        spaMode: true,
      }
      await withSlugLock(slug, async () => {
        const dir = siteDirOf(slug)
        mkdirSync(join(dir, 'releases'), { recursive: true })
        const { meta: curMeta, tombstone } = readMetaAndTombstone(slug)
        const currentMax = Math.max(curMeta?.revision ?? 0, tombstone?.revision ?? 0)
        const liveRev =
          curMeta && (!tombstone || tombstone.revision < curMeta.revision) ? curMeta.revision : 0
        if (verified.revision <= currentMax) {
          if (
            curMeta &&
            verified.revision === curMeta.revision &&
            curMeta.contentSha256 === decoded.contentSha256 &&
            (!tombstone || tombstone.revision < curMeta.revision)
          ) {
            sendJsonResponse(res, 200, { ok: true, idempotent: true, revision: curMeta.revision })
            return
          }
          throw new SitesError('STALE_REVISION', 'stale edge revision', 409)
        }
        if (
          envelope.expectedBaseRevision !== undefined &&
          liveRev !== envelope.expectedBaseRevision
        ) {
          throw new SitesError('STALE_REVISION', 'edge base revision mismatch', 409)
        }

        const revName = `rev-${verified.revision}`
        const tmpRelease = join(dir, 'releases', `.tmp-${revName}-${randomBytes(6).toString('hex')}`)
        const finalRelease = join(dir, 'releases', revName)
        mkdirSync(tmpRelease, { recursive: true })
        try {
          for (const f of decoded.files) {
            const targetFile = join(tmpRelease, f.path)
            mkdirSync(join(targetFile, '..'), { recursive: true })
            writeFileSync(targetFile, f.content)
          }
          rmSync(finalRelease, { recursive: true, force: true })
          renameSync(tmpRelease, finalRelease)

          const nextMeta: StoredSiteMeta = {
            slug,
            revision: verified.revision,
            title: envelope.title || slug,
            visibility: envelope.visibility,
            passwordSalt: envelope.passwordSalt,
            passwordHash: envelope.passwordHash,
            spaMode: envelope.spaMode,
            fileCount: decoded.fileCount,
            sizeBytes: decoded.sizeBytes,
            contentSha256: decoded.contentSha256,
            updatedAt: new Date().toISOString(),
          }
          writeFileAtomic(join(dir, 'meta.json'), JSON.stringify(nextMeta))

          const tmpLink = join(dir, `.tmp-current-${randomBytes(6).toString('hex')}`)
          symlinkSync(join('releases', revName), tmpLink)
          renameSync(tmpLink, join(dir, 'current'))
          rmSync(join(dir, 'tombstone.json'), { force: true })

          for (const entry of readdirSync(join(dir, 'releases'))) {
            if (entry !== revName) {
              rmSync(join(dir, 'releases', entry), { recursive: true, force: true })
            }
          }
        } catch (err) {
          rmSync(tmpRelease, { recursive: true, force: true })
          throw err
        }
        sendJsonResponse(res, 200, { ok: true, revision: verified.revision })
      })
      return
    }

    if (method === 'PATCH' && patchMatch) {
      let envelope = verified.meta
      if (!envelope) {
        try {
          envelope = JSON.parse(body.toString('utf8')) as EdgeMetaEnvelope
        } catch {
          throw new SitesError('INVALID_INPUT', 'invalid meta json', 400)
        }
      }
      await withSlugLock(slug, async () => {
        const dir = siteDirOf(slug)
        const { meta: curMeta, tombstone } = readMetaAndTombstone(slug)
        const currentMax = Math.max(curMeta?.revision ?? 0, tombstone?.revision ?? 0)
        if (!curMeta || (tombstone && tombstone.revision >= curMeta.revision)) {
          if (verified.revision <= currentMax) {
            throw new SitesError('STALE_REVISION', 'stale edge revision', 409)
          }
          throw new SitesError('SITE_NOT_FOUND', 'site missing on edge', 404)
        }
        if (verified.revision <= currentMax) {
          if (
            verified.revision === curMeta.revision &&
            curMeta.title === envelope!.title &&
            curMeta.visibility === envelope!.visibility &&
            curMeta.passwordHash === envelope!.passwordHash &&
            curMeta.spaMode === envelope!.spaMode
          ) {
            sendJsonResponse(res, 200, { ok: true, idempotent: true, revision: curMeta.revision })
            return
          }
          throw new SitesError('STALE_REVISION', 'stale edge revision', 409)
        }
        if (
          envelope!.expectedBaseRevision !== undefined &&
          curMeta.revision !== envelope!.expectedBaseRevision
        ) {
          throw new SitesError('STALE_REVISION', 'edge base revision mismatch', 409)
        }
        const nextMeta: StoredSiteMeta = {
          ...curMeta,
          revision: verified.revision,
          title: envelope!.title || curMeta.slug,
          visibility: envelope!.visibility,
          passwordSalt: envelope!.passwordSalt,
          passwordHash: envelope!.passwordHash,
          spaMode: envelope!.spaMode,
          updatedAt: new Date().toISOString(),
        }
        writeFileAtomic(join(dir, 'meta.json'), JSON.stringify(nextMeta))
        sendJsonResponse(res, 200, { ok: true, revision: verified.revision })
      })
      return
    }

    if (method === 'DELETE' && putOrDeleteMatch) {
      await withSlugLock(slug, async () => {
        const dir = siteDirOf(slug)
        mkdirSync(dir, { recursive: true })
        const { meta: curMeta, tombstone } = readMetaAndTombstone(slug)
        const currentMax = Math.max(curMeta?.revision ?? 0, tombstone?.revision ?? 0)
        if (verified.revision <= currentMax) {
          if (tombstone && verified.revision <= tombstone.revision) {
            sendJsonResponse(res, 200, { ok: true, idempotent: true, revision: tombstone.revision })
            return
          }
          throw new SitesError('STALE_REVISION', 'stale edge revision', 409)
        }
        writeFileAtomic(
          join(dir, 'tombstone.json'),
          JSON.stringify({ revision: verified.revision, deletedAt: new Date().toISOString() }),
        )
        rmSync(join(dir, 'current'), { force: true })
        rmSync(join(dir, 'meta.json'), { force: true })
        rmSync(join(dir, 'releases'), { recursive: true, force: true })
        sendJsonResponse(res, 200, { ok: true, revision: verified.revision })
      })
      return
    }

    sendJsonResponse(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'method not allowed' } })
  }

  async function handlePublicSite(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const hostHeader = typeof req.headers.host === 'string' ? req.headers.host : ''
    const slug = extractSubdomainSlug(hostHeader, baseDomain)
    if (!slug) {
      sendSiteHtml(res, 404, renderStatusHtml('站点不存在', '未找到对应的托管站点域名。'))
      return
    }

    const active = isSiteServable(slug)
    if (!active) {
      sendSiteHtml(res, 404, renderStatusHtml('站点暂不可访问', '该站点尚未发布、已下线或已被删除。'))
      return
    }
    const { meta, currentReal } = active
    const method = req.method ?? 'GET'
    const isHttps =
      req.headers['x-forwarded-proto'] === 'https' ||
      (req.socket as { encrypted?: boolean }).encrypted === true

    const isProtected = meta.visibility !== 'public'
    if (meta.visibility === 'password') {
      if (method === 'POST' && url.pathname === '/__oc_site_unlock') {
        const remoteIp = req.socket.remoteAddress
        const forwardedRealIp =
          isLoopbackIp(remoteIp) && typeof req.headers['x-real-ip'] === 'string'
            ? req.headers['x-real-ip'].trim()
            : ''
        const clientIp = forwardedRealIp || remoteIp || 'unknown'
        const limitKey = `${clientIp}:${slug}`
        const nowMs = Date.now()
        let rec = unlockFailures.get(limitKey)
        if (!rec || rec.resetAt <= nowMs) {
          rec = { count: 0, inflight: 0, resetAt: nowMs + UNLOCK_WINDOW_MS }
          if (unlockFailures.size >= MAX_UNLOCK_FAIL_CACHE) {
            for (const [k, v] of unlockFailures) {
              if (
                (v.resetAt <= nowMs && v.inflight <= 0) ||
                (v.inflight <= 0 && unlockFailures.size >= MAX_UNLOCK_FAIL_CACHE)
              ) {
                unlockFailures.delete(k)
              }
              if (unlockFailures.size < MAX_UNLOCK_FAIL_CACHE * 0.8) break
            }
          }
          unlockFailures.set(limitKey, rec)
        }
        if (rec.count + rec.inflight >= UNLOCK_MAX_FAILS) {
          sendSiteHtml(
            res,
            429,
            renderUnlockHtml({
              title: meta.title,
              redirectPath: '/',
              errorMsg: '尝试次数过多，请 5 分钟后再试',
            }),
            true,
          )
          return
        }

        // Reserve failure slot synchronously before awaiting request body to prevent concurrent burst bypass (B6).
        rec.inflight += 1
        let unlockedOk = false
        let redirectPath = '/'
        try {
          const rawForm = (await readBodyLimited(req, MAX_UNLOCK_BODY_BYTES)).toString('utf8')
          const form = new URLSearchParams(rawForm)
          const password = form.get('password') ?? ''
          redirectPath = sanitizeRedirectTarget(form.get('redirect'))

          if (
            meta.passwordSalt &&
            meta.passwordHash &&
            verifySitePassword(password, meta.passwordSalt, meta.passwordHash)
          ) {
            unlockedOk = true
            unlockFailures.delete(limitKey)
            const expSec = Math.floor(Date.now() / 1000) + cookieTtlSec
            const token = signSiteCookie(slug, meta.passwordHash, expSec)
            const cookieParts = [
              `${SITE_AUTH_COOKIE_NAME}=${token}`,
              'Path=/',
              'HttpOnly',
              'SameSite=Lax',
              `Max-Age=${cookieTtlSec}`,
            ]
            if (isHttps) cookieParts.push('Secure')
            res.statusCode = 303
            res.setHeader('Set-Cookie', cookieParts.join('; '))
            res.setHeader('Location', redirectPath)
            res.setHeader('Cache-Control', 'no-store')
            res.setHeader('Vary', 'Cookie')
            res.end()
            return
          }
        } finally {
          rec.inflight = Math.max(0, rec.inflight - 1)
          if (!unlockedOk && unlockFailures.has(limitKey)) {
            rec.count += 1
          }
        }

        sendSiteHtml(
          res,
          401,
          renderUnlockHtml({
            title: meta.title,
            redirectPath,
            errorMsg: '口令不正确，请重试',
          }),
          true,
        )
        return
      }

      const cookies = parseCookies(req.headers.cookie)
      const authed =
        meta.passwordHash !== null &&
        verifySiteCookie(slug, meta.passwordHash, cookies[SITE_AUTH_COOKIE_NAME])
      if (!authed) {
        sendSiteHtml(
          res,
          401,
          renderUnlockHtml({
            title: meta.title,
            redirectPath: sanitizeRedirectTarget(url.pathname + url.search),
          }),
          true,
        )
        return
      }
    }

    if (method !== 'GET' && method !== 'HEAD') {
      res.statusCode = 405
      res.setHeader('Allow', 'GET, HEAD')
      setPublicSiteSecurityHeaders(res)
      res.end('Method Not Allowed')
      return
    }

    let decodedPath: string
    try {
      decodedPath = decodeURIComponent(url.pathname)
    } catch {
      sendSiteHtml(res, 400, renderStatusHtml('请求路径无效', 'URL 编码不合法。'), isProtected)
      return
    }
    if (decodedPath.includes('\0') || decodedPath.includes('\\')) {
      sendSiteHtml(res, 400, renderStatusHtml('请求路径无效', '包含非法路径字符。'), isProtected)
      return
    }
    const cleanRel = decodedPath.replace(/^\/+/, '').replace(/\/+$/, '')
    const segs = cleanRel ? cleanRel.split('/') : []
    if (segs.some((s) => !s || s === '.' || s === '..')) {
      sendSiteHtml(res, 400, renderStatusHtml('请求路径无效', '不允许包含相对跳转路径。'), isProtected)
      return
    }

    const hit = resolveCandidateFile(currentReal, cleanRel)
    if (hit) {
      serveStaticFile(req, res, hit, cleanRel, 200, meta.visibility)
      return
    }

    const lastSeg = segs[segs.length - 1] ?? ''
    const looksLikeRoute = !lastSeg.includes('.')
    if (meta.spaMode && looksLikeRoute) {
      const spaIndex = resolveCandidateFile(currentReal, '')
      if (spaIndex) {
        serveStaticFile(req, res, spaIndex, 'index.html', 200, meta.visibility)
        return
      }
    }

    const custom404 = resolveCandidateFile(currentReal, '404.html')
    if (custom404) {
      serveStaticFile(req, res, custom404, '404.html', 404, meta.visibility)
      return
    }
    sendSiteHtml(
      res,
      404,
      renderStatusHtml('页面不存在 (404)', '当前站点中没有找到请求的页面或文件。'),
      isProtected,
    )
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const pathname = url.pathname

      if (pathname === `${SITE_EDGE_PREFIX}/healthz` || pathname.startsWith(`${SITE_EDGE_PREFIX}/`)) {
        await handleControlApi(req, res, pathname)
        return
      }

      if (pathname === '/internal/tls-ask') {
        if (trustLoopback && !isLoopbackIp(req.socket.remoteAddress)) {
          res.statusCode = 403
          res.end('forbidden')
          return
        }
        const domain = url.searchParams.get('domain') ?? ''
        const slug = extractSubdomainSlug(domain, baseDomain)
        if (!slug || !isSiteServable(slug)) {
          res.statusCode = 404
          res.end('denied')
          return
        }
        res.statusCode = 200
        res.end('ok')
        return
      }

      await handlePublicSite(req, res, url)
    })().catch((err) => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      if (err instanceof SitesError) {
        sendJsonResponse(res, err.status, {
          error: { code: err.code, message: err.message, retryable: err.retryable },
        })
        return
      }
      sendJsonResponse(res, 500, { error: { code: 'INTERNAL', message: 'internal error' } })
    })
  })

  return {
    server,
    listen() {
      const bind = opts.bind ?? '127.0.0.1'
      const port = opts.port ?? 18980
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, bind, () => {
          server.removeListener('error', reject)
          const addr = server.address()
          if (!addr || typeof addr === 'string') {
            resolve({ port, address: bind })
            return
          }
          resolve({ port: addr.port, address: addr.address })
        })
      })
    },
    async close() {
      clearInterval(sweepTimer)
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
    },
  }
}

let isEntrypoint = false
if (typeof process.argv[1] === 'string') {
  try {
    isEntrypoint = import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    isEntrypoint = import.meta.url === pathToFileURL(process.argv[1]).href
  }
}

if (isEntrypoint) {
  const secret = (process.env.OC_SITES_EDGE_SECRET ?? '').trim()
  if (secret.length < 32) {
    console.error('[sites-edge] OC_SITES_EDGE_SECRET must be at least 32 characters')
    process.exit(1)
  }
  const bind = process.env.OC_SITES_EDGE_BIND?.trim() || '127.0.0.1'
  const port = Number.parseInt(process.env.OC_SITES_EDGE_PORT?.trim() || '18980', 10)
  const dataRoot = process.env.OC_SITES_EDGE_DATA_ROOT?.trim() || '/var/lib/openclaude-sites'
  const baseDomain = process.env.OC_SITES_BASE_DOMAIN?.trim() || 'congjianai.com'
  const maxSiteBytes = Number.parseInt(
    process.env.OC_SITES_MAX_SITE_BYTES?.trim() || String(DEFAULT_SITE_MAX_TOTAL_BYTES),
    10,
  )

  const edge = createSitesEdgeServer({
    bind,
    port,
    dataRoot,
    baseDomain,
    secret,
    maxSiteBytes,
  })
  const addr = await edge.listen()
  console.log(
    `[sites-edge] listening on http://${addr.address}:${addr.port} baseDomain=${baseDomain} dataRoot=${dataRoot}`,
  )
  const shutdown = () => {
    void edge.close().finally(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
