import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
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
  SITE_EDGE_V2_PREFIX,
  SITE_EDGE_SIGNATURE_WINDOW_SEC,
  SITE_MAX_FILES,
  SITE_MAX_SINGLE_FILE_BYTES,
  SITE_PREVIEW_COOKIE_NAME,
  SITE_PREVIEW_TTL_SEC,
  SITE_SERVER_API_PATH,
  type SitePreviewTokenPayload,
  type SiteVisibility,
  SitesError,
  decodeSiteBundle,
  encodeSiteBundle,
  signSitePreviewToken,
  validateSiteSlug,
  verifyEdgeHeaders,
  verifySitePassword,
  verifySitePreviewToken,
} from './types.js'
import { EdgeAnalyticsStore } from './edgeAnalytics.js'
import { runSiteApiWorker } from './edgeApiRunner.js'
import { sharedSandboxAdmission } from './edgeSandbox.js'
import { executeSiteSql, inspectSiteDatabase } from './edgeSqlite.js'
import { computeEnvMapDigest, sealEdgeEnvMap, unsealEdgeEnvMap } from './envCrypto.js'

export interface SitesEdgeServerOptions {
  bind?: string
  port?: number
  dataRoot: string
  baseDomain: string
  secret: string
  maxSiteBytes?: number
  trustLoopbackOnlyForTlsAsk?: boolean
  unlockCookieTtlSec?: number
  allowPrivateFetchForTest?: boolean
}

interface StoredSiteMeta {
  siteId?: string | null
  slug: string
  revision: number
  title: string
  visibility: SiteVisibility
  passwordSalt: string | null
  passwordHash: string | null
  spaMode: boolean
  customDomain?: string | null
  hasServerApi?: boolean
  envDigest?: string
  previewAclVersion?: number
  fileCount: number
  sizeBytes: number
  contentSha256: string
  updatedAt: string
}

interface TombstoneMeta {
  revision: number
  deletedAt: string
  siteId?: string | null
  op?: 'delete' | 'rename'
  renamedTo?: string | null
}

interface RetiredSiteRecord {
  revision: number
  op: 'delete' | 'rename'
  renamedTo: string | null
  retiredAt: string
}

interface RetiredSitesMeta {
  bySiteId: Record<string, RetiredSiteRecord | number>
}

const MAX_RETIRED_SITE_IDS_PER_SLUG = 64

const MAX_NONCE_CACHE = 10_000
const MAX_UNLOCK_FAIL_CACHE = 10_000
const UNLOCK_WINDOW_MS = 5 * 60_000
const UNLOCK_MAX_FAILS = 10
const DEFAULT_UNLOCK_COOKIE_TTL_SEC = 7 * 24 * 3600
const MAX_CONTROL_JSON_BYTES = 1024 * 1024
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

function stripPlatformCookies(rawCookieHeader: string): string {
  const kept: string[] = []
  for (const part of rawCookieHeader.split(';')) {
    const eq = part.indexOf('=')
    const name = (eq >= 0 ? part.slice(0, eq) : part).trim()
    if (!name || name === SITE_AUTH_COOKIE_NAME || name === SITE_PREVIEW_COOKIE_NAME) {
      continue
    }
    kept.push(part.trim())
  }
  return kept.join('; ')
}

function sitePreviewBridgeScript(parentOrigin: string): string {
  return `(()=>{'use strict';const P=${JSON.stringify(parentOrigin)},S='oc-site-preview-v1';let rev=0;
const post=(m)=>{try{parent.postMessage({source:S,...m},P)}catch{}};
const text=(e)=>String((e&&((e.getAttribute&&e.getAttribute('aria-label'))||e.innerText||e.textContent))||'').trim().replace(/\\s+/g,' ').slice(0,160);
const esc=(v)=>globalThis.CSS&&CSS.escape?CSS.escape(v):String(v).replace(/[^a-zA-Z0-9_-]/g,c=>'\\\\'+c);
const selector=(e)=>{if(e.id)return '#'+esc(e.id);const a=['data-testid','data-test','name','aria-label'];for(const k of a){const v=e.getAttribute&&e.getAttribute(k);if(v)return e.tagName.toLowerCase()+'['+k+'="'+String(v).replace(/["\\\\]/g,'\\\\$&')+'"]'}let n=e,p=[];for(let d=0;n&&n.nodeType===1&&d<6;d++,n=n.parentElement){let q=n.tagName.toLowerCase();const par=n.parentElement;if(par){const same=[...par.children].filter(x=>x.tagName===n.tagName);if(same.length>1)q+=':nth-of-type('+(same.indexOf(n)+1)+')'}p.unshift(q)}return p.join(' > ')};
const describe=(e)=>{if(!e||e===document.documentElement||e===document.body)return null;const r=e.getBoundingClientRect();return{selector:selector(e),tag:e.tagName.toLowerCase(),...(e.getAttribute('role')?{role:e.getAttribute('role')}:{}),...(e.getAttribute('aria-label')?{ariaLabel:e.getAttribute('aria-label')}:{}),...(text(e)?{text:text(e)}:{}),bounds:{x:r.x,y:r.y,width:r.width,height:r.height}}};
const navigation=()=>post({type:'preview.navigation',url:location.href,title:document.title,pageRevision:++rev});
for(const k of ['pushState','replaceState']){const f=history[k];history[k]=function(...a){const r=f.apply(this,a);queueMicrotask(navigation);return r}}
addEventListener('popstate',navigation);addEventListener('hashchange',navigation);
let rafScroll=0;const notifyScroll=()=>{if(rafScroll)return;rafScroll=requestAnimationFrame(()=>{rafScroll=0;post({type:'preview.scroll'})})};
addEventListener('scroll',notifyScroll,{passive:true,capture:true});addEventListener('resize',notifyScroll,{passive:true});
addEventListener('message',(e)=>{if(e.origin!==P||e.source!==parent)return;const w=e.data;if(!w||w.source!==S||!w.message||typeof w.message.type!=='string')return;const m=w.message;try{switch(m.type){case'preview.navigate':if(m.action==='back')history.back();else if(m.action==='forward')history.forward();else if(m.action==='reload')location.reload();break;case'preview.select':if(Number.isFinite(m.x)&&Number.isFinite(m.y))post({type:'preview.selection',target:describe(document.elementFromPoint(m.x,m.y))});break;case'preview.hover':if(Number.isFinite(m.x)&&Number.isFinite(m.y))post({type:'preview.hover',target:describe(document.elementFromPoint(m.x,m.y))});else post({type:'preview.hover',target:null});break;case'preview.resolve':if(typeof m.selector==='string'&&m.selector.length<=512){let el=null;try{el=document.querySelector(m.selector)}catch{}post({type:'preview.resolved',selector:m.selector,target:describe(el)})}break;case'preview.wheel':if(Number.isFinite(m.deltaX)&&Number.isFinite(m.deltaY))scrollBy({left:m.deltaX,top:m.deltaY,behavior:'auto'});break;case'preview.text':if(typeof m.text==='string'&&m.text.length<=2000){const el=document.activeElement;if(el&&('value'in el)){const v=String(el.value||''),s=Number.isInteger(el.selectionStart)?el.selectionStart:v.length,t=Number.isInteger(el.selectionEnd)?el.selectionEnd:s;el.value=v.slice(0,s)+m.text+v.slice(t);el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:m.text}))}else if(el&&el.isContentEditable){document.execCommand('insertText',false,m.text)}}break;}}catch{}});
const ready=()=>post({type:'preview.ready',protocolVersion:1,url:location.href,title:document.title,viewport:{width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio,isMobile:innerWidth<600}});
if(document.readyState==='loading')addEventListener('DOMContentLoaded',ready,{once:true});else queueMicrotask(ready);
})();`
}

function injectPreviewBridgeIntoHtml(html: string, bridgeSrc: string): string {
  const tag = `<script src="${escapeHtml(bridgeSrc)}" defer></script>`
  const bodyIdx = html.search(/<\/body\s*>/i)
  if (bodyIdx >= 0) {
    return html.slice(0, bodyIdx) + tag + html.slice(bodyIdx)
  }
  const headIdx = html.search(/<\/head\s*>/i)
  if (headIdx >= 0) {
    return html.slice(0, headIdx) + tag + html.slice(headIdx)
  }
  return `${html}\n${tag}`
}

function collectBundleFromRelease(
  currentReal: string,
  serverEntryReal: string | null,
  maxTotalBytes: number,
): Buffer {
  const items: Array<{ path: string; content: Buffer }> = []
  let totalBytes = 0

  function walk(dir: string, relPrefix: string): void {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const full = join(dir, entry.name)
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
      if (rel === '__oc_server' || rel.startsWith('__oc_server/')) continue
      if (entry.isDirectory()) {
        walk(full, rel)
      } else if (entry.isFile()) {
        const resolved = realpathSync(full)
        if (resolved !== currentReal && !resolved.startsWith(currentReal + sep)) continue
        const data = readFileSync(resolved)
        if (data.length > SITE_MAX_SINGLE_FILE_BYTES) {
          throw new SitesError('INVALID_BUNDLE', `单文件超过上限: ${rel}`, 413)
        }
        totalBytes += data.length
        if (totalBytes > maxTotalBytes) {
          throw new SitesError('INVALID_BUNDLE', '站点总大小超过上限', 413)
        }
        items.push({ path: rel, content: data })
        if (items.length > SITE_MAX_FILES) {
          throw new SitesError('INVALID_BUNDLE', '站点文件数量超过上限', 400)
        }
      }
    }
  }

  walk(currentReal, '')
  if (serverEntryReal && existsSync(serverEntryReal)) {
    const serverBytes = readFileSync(serverEntryReal)
    totalBytes += serverBytes.length
    if (totalBytes > maxTotalBytes) {
      throw new SitesError('INVALID_BUNDLE', '站点总大小超过上限', 413)
    }
    items.push({ path: SITE_SERVER_API_PATH, content: serverBytes })
  }
  return encodeSiteBundle(items, maxTotalBytes).gzipped
}

function serveStaticFile(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  relHint: string,
  status = 200,
  visibility: SiteVisibility = 'public',
  preview?: { parentOrigin: string } | null,
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
  if (preview) {
    res.setHeader('Content-Security-Policy', `frame-ancestors ${preview.parentOrigin}`)
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Vary', 'Cookie')
    if (ext === '.html' || ext === '.htm') {
      const rawHtml = readFileSync(filePath, 'utf8')
      const injected = injectPreviewBridgeIntoHtml(rawHtml, '/__oc_site_preview_bridge.js')
      const buf = Buffer.from(injected, 'utf8')
      res.statusCode = status
      res.setHeader('Content-Length', String(buf.length))
      res.end(req.method === 'HEAD' ? undefined : buf)
      return
    }
  } else if (visibility !== 'public') {
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
  const usedPreviewNonces = new Map<string, number>()
  const unlockFailures = new Map<string, { count: number; inflight: number; resetAt: number }>()
  const customDomainMap = new Map<string, string>()
  const analytics = new EdgeAnalyticsStore(sitesDir, opts.secret)

  function rebuildCustomDomainMap(): void {
    customDomainMap.clear()
    try {
      for (const entry of readdirSync(sitesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const slug = entry.name
        const meta = readJsonIfExists<StoredSiteMeta>(join(sitesDir, slug, 'meta.json'))
        const tomb = readJsonIfExists<TombstoneMeta>(join(sitesDir, slug, 'tombstone.json'))
        if (!meta || (tomb && tomb.revision >= meta.revision)) continue
        const domain = typeof meta.customDomain === 'string' ? meta.customDomain.trim().toLowerCase() : ''
        if (domain) customDomainMap.set(domain, slug)
      }
    } catch {
      /* ignore scan error on empty root */
    }
  }
  rebuildCustomDomainMap()

  function updateCustomDomainMapping(slug: string, nextDomain: string | null): void {
    for (const [dom, owner] of customDomainMap) {
      if (owner === slug) customDomainMap.delete(dom)
    }
    if (nextDomain) {
      customDomainMap.set(nextDomain.toLowerCase(), slug)
    }
    const obj: Record<string, string> = {}
    for (const [dom, owner] of customDomainMap) obj[dom] = owner
    writeFileAtomic(join(dataRoot, 'custom-domains.json'), JSON.stringify(obj))
  }

  function resolveSlugByHost(hostOrDomain: string): string | null {
    const sub = extractSubdomainSlug(hostOrDomain, baseDomain)
    if (sub) return sub
    const clean = hostOrDomain.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.+$/, '')
    if (!clean) return null
    return customDomainMap.get(clean) ?? null
  }

  function readDecryptedSiteEnvStrict(slug: string): Record<string, string> {
    const envPath = join(siteDirOf(slug), 'env.enc')
    if (!existsSync(envPath)) return {}
    const sealed = readFileSync(envPath, 'utf8').trim()
    return unsealEdgeEnvMap(opts.secret, slug, sealed)
  }

  async function withMultiSlugLock<T>(slugs: string[], fn: () => Promise<T>): Promise<T> {
    const sorted = [...new Set(slugs)].sort()
    const runAt = (idx: number): Promise<T> => {
      if (idx >= sorted.length) return fn()
      return withSlugLock(sorted[idx]!, () => runAt(idx + 1))
    }
    return runAt(0)
  }

  const sweepTimer = setInterval(() => {
    const nowMs = Date.now()
    for (const [k, exp] of usedNonces) {
      if (exp <= nowMs) usedNonces.delete(k)
    }
    for (const [k, exp] of usedPreviewNonces) {
      if (exp <= nowMs) usedPreviewNonces.delete(k)
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

  function retiredFileOf(slug: string): string {
    return join(dataRoot, 'retired', `${slug}.json`)
  }

  function purgeSiteRuntimeArtifacts(dir: string): void {
    rmSync(join(dir, 'current'), { force: true })
    rmSync(join(dir, 'current-server'), { force: true })
    rmSync(join(dir, 'env.enc'), { force: true })
    rmSync(join(dir, 'analytics.json'), { force: true })
    rmSync(join(dir, 'data'), { recursive: true, force: true })
    rmSync(join(dir, 'releases'), { recursive: true, force: true })
    rmSync(join(dir, 'meta.json'), { force: true })
  }

  function normalizeRetiredRecord(raw: RetiredSiteRecord | number): RetiredSiteRecord | null {
    if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) {
      return { revision: raw, op: 'delete', renamedTo: null, retiredAt: '' }
    }
    if (
      raw &&
      typeof raw === 'object' &&
      typeof raw.revision === 'number' &&
      Number.isSafeInteger(raw.revision) &&
      raw.revision > 0
    ) {
      return {
        revision: raw.revision,
        op: raw.op === 'rename' ? 'rename' : 'delete',
        renamedTo: typeof raw.renamedTo === 'string' ? raw.renamedTo : null,
        retiredAt: typeof raw.retiredAt === 'string' ? raw.retiredAt : '',
      }
    }
    return null
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

  function readRetiredSiteRecords(slug: string): Record<string, RetiredSiteRecord> {
    const out: Record<string, RetiredSiteRecord> = {}
    for (const file of [join(siteDirOf(slug), 'retired.json'), retiredFileOf(slug)]) {
      const parsed = readJsonIfExists<RetiredSitesMeta>(file)
      if (!parsed || typeof parsed.bySiteId !== 'object' || parsed.bySiteId === null) continue
      for (const [id, raw] of Object.entries(parsed.bySiteId)) {
        const rec = normalizeRetiredRecord(raw)
        if (!rec) continue
        const prev = out[id]
        if (!prev || rec.revision > prev.revision || (rec.revision === prev.revision && rec.retiredAt > prev.retiredAt)) {
          out[id] = rec
        }
      }
    }
    return out
  }

  function recordRetiredSiteRevision(
    slug: string,
    siteId: string | null | undefined,
    revision: number,
    op: 'delete' | 'rename' = 'delete',
    renamedTo: string | null = null,
  ): void {
    if (!siteId || !Number.isSafeInteger(revision) || revision <= 0) return
    const retiredDir = join(dataRoot, 'retired')
    mkdirSync(retiredDir, { recursive: true })
    const prev = readRetiredSiteRecords(slug)
    const cur = prev[siteId]
    const retiredAt = new Date().toISOString()
    const nextRec: RetiredSiteRecord =
      cur && cur.revision > revision
        ? cur
        : {
            revision: Math.max(cur?.revision ?? 0, revision),
            op: cur && cur.revision === revision ? cur.op : op,
            renamedTo: cur && cur.revision === revision ? cur.renamedTo : op === 'rename' ? renamedTo : null,
            retiredAt:
              cur?.retiredAt && cur.retiredAt > retiredAt ? cur.retiredAt : retiredAt,
          }
    const next: Record<string, RetiredSiteRecord> = {
      ...prev,
      [siteId]: nextRec,
    }
    const entries = Object.entries(next)
    if (entries.length > MAX_RETIRED_SITE_IDS_PER_SLUG) {
      entries.sort((a, b) => b[1].retiredAt.localeCompare(a[1].retiredAt) || b[1].revision - a[1].revision)
      entries.length = MAX_RETIRED_SITE_IDS_PER_SLUG
    }
    writeFileAtomic(retiredFileOf(slug), JSON.stringify({ bySiteId: Object.fromEntries(entries) }))
  }

  /**
   * High-water revision for a specific siteId UUID so independent writer instances
   * sharing one edge storage cannot block a vacant slug via another instance's high tombstone.
   */
  function maxSeenRevisionForSite(
    slug: string,
    curMeta: StoredSiteMeta | null,
    tombstone: TombstoneMeta | null,
    reqSiteId: string | null | undefined,
  ): number {
    if (!reqSiteId) {
      return Math.max(curMeta?.revision ?? 0, tombstone?.revision ?? 0)
    }
    const curLive = Boolean(curMeta && (!tombstone || tombstone.revision < curMeta.revision))
    const curRev =
      curMeta && curMeta.siteId === reqSiteId && (curLive || !tombstone) ? curMeta.revision : 0
    const tombRev = tombstone && tombstone.siteId === reqSiteId ? tombstone.revision : 0
    const retiredRev = readRetiredSiteRecords(slug)[reqSiteId]?.revision ?? 0
    return Math.max(curRev, tombRev, retiredRev)
  }

  function assertIdentityMatches(
    curMeta: StoredSiteMeta,
    reqSiteId: string | undefined,
    expectedRev?: number,
  ): void {
    if (curMeta.siteId && reqSiteId !== curMeta.siteId) {
      throw new SitesError('STALE_REVISION', 'siteId mismatch on edge', 409)
    }
    if (expectedRev !== undefined && curMeta.revision !== expectedRev) {
      throw new SitesError('STALE_REVISION', 'edge revision mismatch', 409)
    }
  }

  function resolveSiteFiles(
    slug: string,
    allowDisabled: boolean,
  ): { meta: StoredSiteMeta; currentReal: string; serverEntryReal: string | null } | null {
    const { meta, tombstone, currentLink } = readMetaAndTombstone(slug)
    if (!meta || (!allowDisabled && meta.visibility === 'disabled')) return null
    if (tombstone && tombstone.revision >= meta.revision) return null
    if (!existsSync(currentLink)) return null
    try {
      const currentReal = realpathSync(currentLink)
      const siteRoot = realpathSync(siteDirOf(slug))
      if (!currentReal.startsWith(siteRoot + sep)) return null
      let serverEntryReal: string | null = null
      const serverEntry = join(siteDirOf(slug), 'current-server', 'api.mjs')
      if (meta.hasServerApi && existsSync(serverEntry)) {
        const candidate = realpathSync(serverEntry)
        if (candidate.startsWith(siteRoot + sep)) {
          serverEntryReal = candidate
        }
      }
      return { meta, currentReal, serverEntryReal }
    } catch {
      return null
    }
  }

  function isSiteServable(
    slug: string,
  ): { meta: StoredSiteMeta; currentReal: string; serverEntryReal: string | null } | null {
    return resolveSiteFiles(slug, false)
  }

  function consumePreviewBootNonce(nonce: string, expSec: number): boolean {
    const nowMs = Date.now()
    const existing = usedPreviewNonces.get(nonce)
    if (existing && existing > nowMs) return false
    if (usedPreviewNonces.size >= MAX_NONCE_CACHE) {
      for (const [k, exp] of usedPreviewNonces) {
        if (exp <= nowMs || usedPreviewNonces.size >= MAX_NONCE_CACHE) usedPreviewNonces.delete(k)
        if (usedPreviewNonces.size < MAX_NONCE_CACHE * 0.8) break
      }
    }
    usedPreviewNonces.set(nonce, Math.max(nowMs + 120_000, (expSec + 60) * 1000))
    return true
  }

  function resolvePreviewSession(
    req: IncomingMessage,
    slug: string,
    meta: StoredSiteMeta,
  ): SitePreviewTokenPayload | null {
    const cookies = parseCookies(req.headers.cookie)
    const token = cookies[SITE_PREVIEW_COOKIE_NAME]
    if (!token) return null
    const payload = verifySitePreviewToken({
      secret: opts.secret,
      token,
      expectedSlug: slug,
      expectedKind: 'sess',
    })
    if (!payload) return null
    if (meta.siteId && payload.siteId !== meta.siteId) return null
    const minAcl = meta.previewAclVersion ?? 1
    if (payload.aclVersion < minAcl) return null
    return payload
  }

  async function handleControlApi(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const pathname = url.pathname
    const method = req.method ?? 'GET'
    if (
      method === 'GET' &&
      (pathname === `${SITE_EDGE_PREFIX}/healthz` || pathname === `${SITE_EDGE_V2_PREFIX}/healthz`)
    ) {
      sendJsonResponse(res, 200, { ok: true, baseDomain })
      return
    }

    let activePrefix = SITE_EDGE_PREFIX
    let apiVersion: 1 | 2 = 1
    if (pathname.startsWith(`${SITE_EDGE_V2_PREFIX}/`)) {
      activePrefix = SITE_EDGE_V2_PREFIX
      apiVersion = 2
    }

    const putOrDeleteMatch = new RegExp(`^${activePrefix}/sites/([^/]+)$`).exec(pathname)
    const bundleMatch = new RegExp(`^${activePrefix}/sites/([^/]+)/bundle$`).exec(pathname)
    const patchMatch = new RegExp(`^${activePrefix}/sites/([^/]+)/meta$`).exec(pathname)
    const envPutMatch = new RegExp(`^${activePrefix}/sites/([^/]+)/env$`).exec(pathname)
    const renameMatch = new RegExp(`^${activePrefix}/sites/([^/]+)/rename$`).exec(pathname)
    const analyticsMatch = new RegExp(`^${activePrefix}/sites/([^/]+)/analytics$`).exec(pathname)
    const dbInspectMatch = new RegExp(`^${activePrefix}/sites/([^/]+)/db$`).exec(pathname)
    const dbSqlMatch = new RegExp(`^${activePrefix}/sites/([^/]+)/db/sql$`).exec(pathname)
    let rawSlug = ''
    try {
      rawSlug = decodeURIComponent(
        putOrDeleteMatch?.[1] ??
          bundleMatch?.[1] ??
          patchMatch?.[1] ??
          envPutMatch?.[1] ??
          renameMatch?.[1] ??
          analyticsMatch?.[1] ??
          dbInspectMatch?.[1] ??
          dbSqlMatch?.[1] ??
          '',
      )
    } catch {
      throw new SitesError('INVALID_SLUG', 'invalid slug encoding', 400)
    }

    if (!rawSlug) {
      sendJsonResponse(res, 404, { error: { code: 'NOT_FOUND', message: 'not found' } })
      return
    }

    const slug = validateSiteSlug(rawSlug)
    const isBundlePut = Boolean(method === 'PUT' && putOrDeleteMatch)
    const body = await readBodyLimited(
      req,
      isBundlePut ? maxSiteBytes + 4 * 1024 * 1024 : MAX_CONTROL_JSON_BYTES,
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
      const requestedSiteId = verified.meta?.siteId || url.searchParams.get('siteId')?.trim() || ''
      await withSlugLock(slug, async () => {
        const { meta: curMeta, tombstone } = readMetaAndTombstone(slug)
        const liveRevision =
          curMeta && (!tombstone || tombstone.revision < curMeta.revision) ? curMeta.revision : 0
        const retiredRec = requestedSiteId ? readRetiredSiteRecords(slug)[requestedSiteId] : undefined
        sendJsonResponse(res, 200, {
          exists: liveRevision > 0,
          revision: liveRevision,
          tombstoneRevision: tombstone?.revision ?? 0,
          ...(tombstone
            ? {
                tombstone: {
                  revision: tombstone.revision,
                  siteId: tombstone.siteId ?? null,
                  op: tombstone.op ?? 'delete',
                  renamedTo: tombstone.renamedTo ?? null,
                },
              }
            : {}),
          ...(retiredRec
            ? {
                retired: {
                  siteId: requestedSiteId,
                  revision: retiredRec.revision,
                  op: retiredRec.op,
                  renamedTo: retiredRec.renamedTo,
                },
              }
            : {}),
          ...(liveRevision > 0 && curMeta
            ? {
                meta: {
                  siteId: curMeta.siteId ?? null,
                  title: curMeta.title,
                  visibility: curMeta.visibility,
                  passwordSalt: curMeta.passwordSalt,
                  passwordHash: curMeta.passwordHash,
                  spaMode: curMeta.spaMode,
                  customDomain: curMeta.customDomain ?? null,
                  hasServerApi: Boolean(curMeta.hasServerApi),
                  envDigest: curMeta.envDigest ?? '',
                  previewAclVersion: curMeta.previewAclVersion ?? 1,
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

    if (method === 'GET' && bundleMatch) {
      const gzipped = await withSlugLock(slug, async () => {
        const { meta: curMeta, tombstone } = readMetaAndTombstone(slug)
        if (!curMeta || (tombstone && tombstone.revision >= curMeta.revision)) {
          throw new SitesError('SITE_NOT_FOUND', 'site missing on edge', 404)
        }
        assertIdentityMatches(curMeta, verified.meta?.siteId, verified.meta?.expectedBaseRevision)
        const files = resolveSiteFiles(slug, true)
        if (!files) {
          throw new SitesError('SITE_NOT_FOUND', 'site release files missing on edge', 404)
        }
        return collectBundleFromRelease(files.currentReal, files.serverEntryReal, maxSiteBytes)
      })
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/x-oc-site-bundle')
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Content-Length', String(gzipped.length))
      res.end(gzipped)
      return
    }

    if (method === 'GET' && analyticsMatch) {
      await withSlugLock(slug, async () => {
        const { meta: curMeta, tombstone } = readMetaAndTombstone(slug)
        if (!curMeta || (tombstone && tombstone.revision >= curMeta.revision)) {
          throw new SitesError('SITE_NOT_FOUND', 'site missing on edge', 404)
        }
        assertIdentityMatches(curMeta, verified.meta?.siteId, verified.meta?.expectedBaseRevision)
        const days = Number.parseInt(url.searchParams.get('days') ?? '30', 10)
        sendJsonResponse(res, 200, analytics.getSummary(slug, Number.isFinite(days) ? days : 30))
      })
      return
    }

    if (method === 'GET' && dbInspectMatch) {
      const table = url.searchParams.get('table') ?? undefined
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '100', 10)
      const siteData = await withSlugLock(slug, async () => {
        const { meta: curMeta, tombstone } = readMetaAndTombstone(slug)
        if (!curMeta || (tombstone && tombstone.revision >= curMeta.revision)) {
          throw new SitesError('SITE_NOT_FOUND', 'site missing on edge', 404)
        }
        assertIdentityMatches(curMeta, verified.meta?.siteId, verified.meta?.expectedBaseRevision)
        return inspectSiteDatabase(siteDirOf(slug), table, Number.isFinite(limit) ? limit : 100, slug)
      })
      sendJsonResponse(res, 200, siteData)
      return
    }

    if (method === 'POST' && dbSqlMatch) {
      let payload: { siteId?: unknown; expectedRevision?: unknown; sql?: unknown; params?: unknown }
      try {
        payload = JSON.parse(body.toString('utf8')) as {
          siteId?: unknown
          expectedRevision?: unknown
          sql?: unknown
          params?: unknown
        }
      } catch {
        throw new SitesError('INVALID_INPUT', 'invalid sql json', 400)
      }
      if (typeof payload.sql !== 'string') {
        throw new SitesError('INVALID_INPUT', 'sql must be string', 400)
      }
      const reqSiteId =
        verified.meta?.siteId ?? (typeof payload.siteId === 'string' ? payload.siteId : undefined)
      const reqExpRev =
        verified.meta?.expectedBaseRevision ??
        (typeof payload.expectedRevision === 'number' ? payload.expectedRevision : undefined)
      const params = Array.isArray(payload.params) ? payload.params : []
      const result = await withSlugLock(slug, async () => {
        const { meta: curMeta, tombstone } = readMetaAndTombstone(slug)
        if (!curMeta || (tombstone && tombstone.revision >= curMeta.revision)) {
          throw new SitesError('SITE_NOT_FOUND', 'site missing on edge', 404)
        }
        assertIdentityMatches(curMeta, reqSiteId, reqExpRev)
        return executeSiteSql(siteDirOf(slug), payload.sql as string, params, slug)
      })
      sendJsonResponse(res, 200, result)
      return
    }

    if (method === 'PUT' && envPutMatch) {
      let payload: {
        siteId?: unknown
        expectedBaseRevision?: unknown
        envDigest?: unknown
        encryptedEnvB64?: unknown
      }
      try {
        payload = JSON.parse(body.toString('utf8')) as typeof payload
      } catch {
        throw new SitesError('INVALID_INPUT', 'invalid env json', 400)
      }
      const reqSiteId =
        verified.meta?.siteId ?? (typeof payload.siteId === 'string' ? payload.siteId : undefined)
      const reqBaseRev =
        typeof payload.expectedBaseRevision === 'number'
          ? payload.expectedBaseRevision
          : verified.meta?.expectedBaseRevision
      const envDigest = typeof payload.envDigest === 'string' ? payload.envDigest : ''
      const encryptedEnvB64 = typeof payload.encryptedEnvB64 === 'string' ? payload.encryptedEnvB64 : ''
      if (encryptedEnvB64) {
        unsealEdgeEnvMap(opts.secret, slug, encryptedEnvB64)
      }

      await withSlugLock(slug, async () => {
        const dir = siteDirOf(slug)
        const { meta: curMeta, tombstone } = readMetaAndTombstone(slug)
        if (!curMeta || (tombstone && tombstone.revision >= curMeta.revision)) {
          throw new SitesError('SITE_NOT_FOUND', 'site missing on edge', 404)
        }
        if (curMeta.siteId && reqSiteId !== curMeta.siteId) {
          throw new SitesError('STALE_REVISION', 'siteId mismatch on edge', 409)
        }
        if (reqBaseRev !== undefined && curMeta.revision !== reqBaseRev) {
          throw new SitesError('STALE_REVISION', 'edge base revision mismatch', 409)
        }
        if (verified.revision < curMeta.revision) {
          if (curMeta.envDigest === envDigest) {
            sendJsonResponse(res, 200, { ok: true, idempotent: true, revision: curMeta.revision })
            return
          }
          throw new SitesError('STALE_REVISION', 'stale edge revision', 409)
        }
        if (encryptedEnvB64) {
          writeFileAtomic(join(dir, 'env.enc'), encryptedEnvB64)
        } else {
          rmSync(join(dir, 'env.enc'), { force: true })
        }
        const nextMeta: StoredSiteMeta = {
          ...curMeta,
          siteId: curMeta.siteId ?? reqSiteId ?? null,
          revision: verified.revision,
          envDigest,
          updatedAt: new Date().toISOString(),
        }
        writeFileAtomic(join(dir, 'meta.json'), JSON.stringify(nextMeta))
        sendJsonResponse(res, 200, { ok: true, revision: verified.revision })
      })
      return
    }

    if (method === 'POST' && renameMatch) {
      let payload: { siteId?: unknown; newSlug?: unknown; expectedBaseRevision?: unknown }
      try {
        payload = JSON.parse(body.toString('utf8')) as {
          siteId?: unknown
          newSlug?: unknown
          expectedBaseRevision?: unknown
        }
      } catch {
        throw new SitesError('INVALID_INPUT', 'invalid rename json', 400)
      }
      const newSlug = validateSiteSlug(String(payload.newSlug ?? ''))
      const expectedBaseRevision =
        typeof payload.expectedBaseRevision === 'number'
          ? payload.expectedBaseRevision
          : verified.meta?.expectedBaseRevision
      const reqSiteId =
        verified.meta?.siteId ?? (typeof payload.siteId === 'string' ? payload.siteId : undefined)

      if (newSlug === slug) {
        sendJsonResponse(res, 200, { ok: true, slug })
        return
      }
      await withMultiSlugLock([slug, newSlug], async () => {
        const { meta: oldMeta, tombstone: oldTomb } = readMetaAndTombstone(slug)
        const { meta: dstMeta, tombstone: dstTomb } = readMetaAndTombstone(newSlug)

        if (
          oldTomb?.op === 'rename' &&
          oldTomb.revision === verified.revision &&
          oldTomb.renamedTo === newSlug &&
          (!oldTomb.siteId || !reqSiteId || oldTomb.siteId === reqSiteId) &&
          dstMeta?.revision === verified.revision &&
          (!dstMeta.siteId || !reqSiteId || dstMeta.siteId === reqSiteId)
        ) {
          sendJsonResponse(res, 200, { ok: true, idempotent: true, slug: newSlug, revision: verified.revision })
          return
        }

        const oldLiveRev =
          oldMeta && (!oldTomb || oldTomb.revision < oldMeta.revision) ? oldMeta.revision : 0
        if (!oldMeta || oldLiveRev <= 0) {
          throw new SitesError('SITE_NOT_FOUND', 'source site missing on edge', 404)
        }
        if (oldMeta.siteId && reqSiteId !== oldMeta.siteId) {
          throw new SitesError('STALE_REVISION', 'siteId mismatch on edge', 409)
        }
        if (expectedBaseRevision !== undefined && oldLiveRev !== expectedBaseRevision) {
          throw new SitesError('STALE_REVISION', 'edge base revision mismatch', 409)
        }
        const dstLive = Boolean(dstMeta && (!dstTomb || dstTomb.revision < dstMeta.revision))
        if (dstLive) {
          throw new SitesError('SLUG_TAKEN', `子域名 "${newSlug}" 已被占用`, 409)
        }
        const effectiveCheckId = reqSiteId ?? oldMeta.siteId ?? undefined
        if (effectiveCheckId && verified.revision <= maxSeenRevisionForSite(newSlug, dstMeta, dstTomb, effectiveCheckId)) {
          throw new SitesError('STALE_REVISION', 'stale edge revision', 409)
        }
        const maxSeen = reqSiteId
          ? Math.max(
              oldMeta.revision,
              maxSeenRevisionForSite(slug, oldMeta, oldTomb, reqSiteId),
              maxSeenRevisionForSite(newSlug, dstMeta, dstTomb, reqSiteId),
            )
          : Math.max(
              oldMeta.revision,
              oldTomb?.revision ?? 0,
              dstMeta?.revision ?? 0,
              dstTomb?.revision ?? 0,
            )
        if (verified.revision <= maxSeen) {
          throw new SitesError('STALE_REVISION', 'stale edge revision', 409)
        }

        // Unseal & validate env BEFORE moving any files on disk (P1 #9).
        const oldDir = siteDirOf(slug)
        const newDir = siteDirOf(newSlug)
        const oldEnvPath = join(oldDir, 'env.enc')
        const oldEnvRaw = existsSync(oldEnvPath) ? readFileSync(oldEnvPath) : null
        const oldMetaRaw = readFileSync(join(oldDir, 'meta.json'))
        const effectiveSiteId = oldMeta.siteId ?? reqSiteId ?? null
        const oldEnv = readDecryptedSiteEnvStrict(slug)
        const resealedEnv =
          Object.keys(oldEnv).length > 0 ? sealEdgeEnvMap(opts.secret, newSlug, oldEnv) : null
        const resolvedEnvDigest =
          oldMeta.envDigest ??
          computeEnvMapDigest(oldEnv, effectiveSiteId ?? slug, opts.secret)

        rmSync(newDir, { recursive: true, force: true })
        renameSync(oldDir, newDir)

        try {
          const movedMeta: StoredSiteMeta = {
            ...oldMeta,
            siteId: effectiveSiteId,
            slug: newSlug,
            revision: verified.revision,
            envDigest: resolvedEnvDigest,
            updatedAt: new Date().toISOString(),
          }
          writeFileAtomic(join(newDir, 'meta.json'), JSON.stringify(movedMeta))

          if (resealedEnv !== null) {
            writeFileAtomic(join(newDir, 'env.enc'), resealedEnv)
          } else {
            rmSync(join(newDir, 'env.enc'), { force: true })
          }

          analytics.renameSlug(slug, newSlug)
          updateCustomDomainMapping(slug, null)
          if (movedMeta.customDomain) {
            updateCustomDomainMapping(newSlug, movedMeta.customDomain)
          }
        } catch (err) {
          // Restore directory, original meta/ciphertext, domain mapping, and analytics on post-move error.
          try {
            if (!existsSync(oldDir) && existsSync(newDir)) {
              renameSync(newDir, oldDir)
            }
            if (existsSync(oldDir)) {
              writeFileSync(join(oldDir, 'meta.json'), oldMetaRaw)
              if (oldEnvRaw !== null) {
                writeFileSync(join(oldDir, 'env.enc'), oldEnvRaw)
              } else {
                rmSync(join(oldDir, 'env.enc'), { force: true })
              }
            }
            analytics.renameSlug(newSlug, slug)
            updateCustomDomainMapping(newSlug, null)
            if (oldMeta.customDomain) {
              updateCustomDomainMapping(slug, oldMeta.customDomain)
            }
          } catch {
            /* best effort rollback */
          }
          throw err
        }

        mkdirSync(oldDir, { recursive: true })
        const retiredRenameSiteId = oldMeta.siteId ?? reqSiteId ?? null
        writeFileAtomic(
          join(oldDir, 'tombstone.json'),
          JSON.stringify({
            revision: verified.revision,
            deletedAt: new Date().toISOString(),
            siteId: retiredRenameSiteId,
            op: 'rename',
            renamedTo: newSlug,
          }),
        )
        recordRetiredSiteRevision(slug, retiredRenameSiteId, verified.revision, 'rename', newSlug)
        sendJsonResponse(res, 200, { ok: true, slug: newSlug, revision: verified.revision })
      })
      return
    }

    if (method === 'PUT' && putOrDeleteMatch) {
      const decoded = decodeSiteBundle(body, maxSiteBytes)
      if (apiVersion === 1 && decoded.hasServerApi) {
        throw new SitesError('INVALID_BUNDLE', '包含服务端 API 的包必须通过 /v2 端点上传', 400)
      }
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
        const liveRev =
          curMeta && (!tombstone || tombstone.revision < curMeta.revision) ? curMeta.revision : 0

        if (liveRev > 0 && curMeta) {
          if (
            (curMeta.siteId && envelope.siteId && curMeta.siteId !== envelope.siteId) ||
            (envelope.expectedBaseRevision === 0 && Boolean(curMeta.siteId) !== Boolean(envelope.siteId))
          ) {
            if (envelope.expectedBaseRevision === 0) {
              throw new SitesError('SLUG_TAKEN', `子域名 "${slug}" 已被占用`, 409)
            }
            throw new SitesError('STALE_REVISION', 'siteId mismatch on edge', 409)
          }
        }

        const siteMax = maxSeenRevisionForSite(slug, curMeta, tombstone, envelope.siteId)
        if (verified.revision <= siteMax) {
          if (
            curMeta &&
            verified.revision === curMeta.revision &&
            curMeta.contentSha256 === decoded.contentSha256 &&
            (!tombstone || tombstone.revision < curMeta.revision) &&
            (!curMeta.siteId || !envelope.siteId || curMeta.siteId === envelope.siteId)
          ) {
            const effectiveId = curMeta.siteId ?? envelope.siteId ?? slug
            const diskDigest =
              curMeta.envDigest ??
              computeEnvMapDigest(readDecryptedSiteEnvStrict(slug), effectiveId, opts.secret)
            const needsEnvSync =
              envelope.envDigest !== undefined && envelope.envDigest !== diskDigest
            sendJsonResponse(res, 200, {
              ok: true,
              idempotent: true,
              revision: curMeta.revision,
              envDigest: diskDigest,
              ...(needsEnvSync ? { needsEnvSync: true } : {}),
            })
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
        const nextDomain =
          envelope.customDomain !== undefined ? envelope.customDomain : (curMeta?.customDomain ?? null)
        if (nextDomain) {
          const holder = customDomainMap.get(nextDomain.toLowerCase())
          if (holder && holder !== slug) {
            throw new SitesError('DOMAIN_TAKEN', `自定义域名 "${nextDomain}" 已被占用`, 409)
          }
        }

        const diskEnvPath = join(dir, 'env.enc')
        const effectiveSiteId = envelope.siteId ?? curMeta?.siteId ?? slug
        const isSameLiveOwner = Boolean(
          liveRev > 0 && curMeta && (!envelope.siteId || !curMeta.siteId || curMeta.siteId === envelope.siteId),
        )
        let existingEnvDigest = ''
        if (!isSameLiveOwner) {
          // Switching ownership (or reusing a deleted/vacant slug) must never inherit stale DB, env, or analytics.
          rmSync(join(dir, 'data'), { recursive: true, force: true })
          rmSync(diskEnvPath, { force: true })
          rmSync(join(dir, 'analytics.json'), { force: true })
          analytics.deleteSlug(slug)
        } else if (existsSync(diskEnvPath)) {
          existingEnvDigest =
            curMeta?.envDigest !== undefined
              ? curMeta.envDigest
              : computeEnvMapDigest(readDecryptedSiteEnvStrict(slug), effectiveSiteId, opts.secret)
        }

        const revName = `rev-${verified.revision}`
        const serverRevName = `${revName}-server`
        const tmpRelease = join(dir, 'releases', `.tmp-${revName}-${randomBytes(6).toString('hex')}`)
        const finalRelease = join(dir, 'releases', revName)
        const tmpServerDir = join(
          dir,
          'releases',
          `.tmp-${serverRevName}-${randomBytes(6).toString('hex')}`,
        )
        const finalServerDir = join(dir, 'releases', serverRevName)
        let serverFile: Buffer | null = null
        mkdirSync(tmpRelease, { recursive: true })
        try {
          for (const f of decoded.files) {
            if (f.path === SITE_SERVER_API_PATH) {
              serverFile = f.content
              continue
            }
            const targetFile = join(tmpRelease, f.path)
            mkdirSync(join(targetFile, '..'), { recursive: true })
            writeFileSync(targetFile, f.content)
          }
          rmSync(finalRelease, { recursive: true, force: true })
          renameSync(tmpRelease, finalRelease)

          if (serverFile) {
            mkdirSync(tmpServerDir, { recursive: true })
            writeFileSync(join(tmpServerDir, 'api.mjs'), serverFile)
            rmSync(finalServerDir, { recursive: true, force: true })
            renameSync(tmpServerDir, finalServerDir)
            const tmpSrvLink = join(dir, `.tmp-current-server-${randomBytes(6).toString('hex')}`)
            symlinkSync(join('releases', serverRevName), tmpSrvLink)
            renameSync(tmpSrvLink, join(dir, 'current-server'))
          } else {
            rmSync(join(dir, 'current-server'), { force: true })
          }

          if (envelope.envDigest === '' && existsSync(diskEnvPath)) {
            rmSync(diskEnvPath, { force: true })
            existingEnvDigest = ''
          }

          const nextMeta: StoredSiteMeta = {
            siteId: envelope.siteId ?? curMeta?.siteId ?? null,
            slug,
            revision: verified.revision,
            title: envelope.title || slug,
            visibility: envelope.visibility,
            passwordSalt: envelope.passwordSalt,
            passwordHash: envelope.passwordHash,
            spaMode: envelope.spaMode,
            customDomain: nextDomain,
            hasServerApi: Boolean(serverFile),
            envDigest: existingEnvDigest,
            previewAclVersion: Math.max(
              curMeta?.previewAclVersion ?? 1,
              envelope.previewAclVersion ?? 1,
            ),
            fileCount: decoded.fileCount,
            sizeBytes: decoded.sizeBytes,
            contentSha256: decoded.contentSha256,
            updatedAt: new Date().toISOString(),
          }
          writeFileAtomic(join(dir, 'meta.json'), JSON.stringify(nextMeta))
          updateCustomDomainMapping(slug, nextDomain)

          const tmpLink = join(dir, `.tmp-current-${randomBytes(6).toString('hex')}`)
          symlinkSync(join('releases', revName), tmpLink)
          renameSync(tmpLink, join(dir, 'current'))
          rmSync(join(dir, 'tombstone.json'), { force: true })

          for (const entry of readdirSync(join(dir, 'releases'))) {
            if (entry !== revName && entry !== serverRevName) {
              rmSync(join(dir, 'releases', entry), { recursive: true, force: true })
            }
          }
        } catch (err) {
          rmSync(tmpRelease, { recursive: true, force: true })
          rmSync(tmpServerDir, { recursive: true, force: true })
          throw err
        }
        const needsEnvSync =
          envelope.envDigest !== undefined && envelope.envDigest !== existingEnvDigest
        sendJsonResponse(res, 200, {
          ok: true,
          revision: verified.revision,
          envDigest: existingEnvDigest,
          ...(needsEnvSync ? { needsEnvSync: true } : {}),
        })
      })
      return
    }

    if (method === 'PATCH' && patchMatch) {
      let bodyPayload: (EdgeMetaEnvelope & { encryptedEnvB64?: unknown }) | null = null
      if (body.length > 0) {
        try {
          bodyPayload = JSON.parse(body.toString('utf8')) as EdgeMetaEnvelope & { encryptedEnvB64?: unknown }
        } catch {
          throw new SitesError('INVALID_INPUT', 'invalid meta json', 400)
        }
      }
      const envelope = verified.meta ?? bodyPayload
      if (!envelope) {
        throw new SitesError('INVALID_INPUT', 'missing meta envelope', 400)
      }
      const bodyEncryptedEnvB64 =
        typeof bodyPayload?.encryptedEnvB64 === 'string' ? bodyPayload.encryptedEnvB64 : undefined
      if (bodyEncryptedEnvB64) {
        unsealEdgeEnvMap(opts.secret, slug, bodyEncryptedEnvB64)
      }

      await withSlugLock(slug, async () => {
        const dir = siteDirOf(slug)
        const { meta: curMeta, tombstone } = readMetaAndTombstone(slug)
        const siteMax = maxSeenRevisionForSite(slug, curMeta, tombstone, envelope.siteId)
        if (!curMeta || (tombstone && tombstone.revision >= curMeta.revision)) {
          if (verified.revision <= siteMax) {
            throw new SitesError('STALE_REVISION', 'stale edge revision', 409)
          }
          throw new SitesError('SITE_NOT_FOUND', 'site missing on edge', 404)
        }
        if (curMeta.siteId && envelope.siteId && curMeta.siteId !== envelope.siteId) {
          throw new SitesError('STALE_REVISION', 'siteId mismatch on edge', 409)
        }
        if (verified.revision <= siteMax) {
          if (
            verified.revision === curMeta.revision &&
            (!curMeta.siteId || !envelope.siteId || curMeta.siteId === envelope.siteId) &&
            curMeta.title === envelope.title &&
            curMeta.visibility === envelope.visibility &&
            curMeta.passwordHash === envelope.passwordHash &&
            curMeta.spaMode === envelope.spaMode &&
            (envelope.customDomain === undefined ||
              (curMeta.customDomain ?? null) === envelope.customDomain) &&
            (envelope.envDigest === undefined ||
              (curMeta.envDigest ?? '') === envelope.envDigest) &&
            (envelope.previewAclVersion === undefined ||
              (curMeta.previewAclVersion ?? 1) >= envelope.previewAclVersion)
          ) {
            sendJsonResponse(res, 200, { ok: true, idempotent: true, revision: curMeta.revision })
            return
          }
          throw new SitesError('STALE_REVISION', 'stale edge revision', 409)
        }
        if (
          envelope.expectedBaseRevision !== undefined &&
          curMeta.revision !== envelope.expectedBaseRevision
        ) {
          throw new SitesError('STALE_REVISION', 'edge base revision mismatch', 409)
        }
        const nextDomain =
          envelope.customDomain !== undefined
            ? envelope.customDomain
            : (curMeta.customDomain ?? null)
        if (nextDomain) {
          const holder = customDomainMap.get(nextDomain.toLowerCase())
          if (holder && holder !== slug) {
            throw new SitesError('DOMAIN_TAKEN', `自定义域名 "${nextDomain}" 已被占用`, 409)
          }
        }
        if (bodyEncryptedEnvB64 !== undefined) {
          if (bodyEncryptedEnvB64 === '') {
            rmSync(join(dir, 'env.enc'), { force: true })
          } else {
            writeFileAtomic(join(dir, 'env.enc'), bodyEncryptedEnvB64)
          }
        }
        const nextMeta: StoredSiteMeta = {
          ...curMeta,
          siteId: curMeta.siteId ?? envelope.siteId ?? null,
          revision: verified.revision,
          title: envelope.title || curMeta.slug,
          visibility: envelope.visibility,
          passwordSalt: envelope.passwordSalt,
          passwordHash: envelope.passwordHash,
          spaMode: envelope.spaMode,
          customDomain: nextDomain,
          hasServerApi:
            envelope.hasServerApi !== undefined
              ? envelope.hasServerApi
              : Boolean(curMeta.hasServerApi),
          envDigest:
            envelope.envDigest !== undefined
              ? envelope.envDigest
              : (curMeta.envDigest ?? ''),
          previewAclVersion: Math.max(
            curMeta.previewAclVersion ?? 1,
            envelope.previewAclVersion ?? 1,
          ),
          updatedAt: new Date().toISOString(),
        }
        writeFileAtomic(join(dir, 'meta.json'), JSON.stringify(nextMeta))
        updateCustomDomainMapping(slug, nextDomain)
        sendJsonResponse(res, 200, { ok: true, revision: verified.revision })
      })
      return
    }

    if (method === 'DELETE' && putOrDeleteMatch) {
      await withSlugLock(slug, async () => {
        const dir = siteDirOf(slug)
        mkdirSync(dir, { recursive: true })
        const { meta: curMeta, tombstone } = readMetaAndTombstone(slug)
        const reqSiteId = verified.meta?.siteId
        const liveRev =
          curMeta && (!tombstone || tombstone.revision < curMeta.revision) ? curMeta.revision : 0
        if (liveRev > 0 && curMeta) {
          if (curMeta.siteId && reqSiteId && curMeta.siteId !== reqSiteId) {
            throw new SitesError('STALE_REVISION', 'siteId mismatch on edge', 409)
          }
        }
        const siteMax = maxSeenRevisionForSite(slug, curMeta, tombstone, reqSiteId)
        if (liveRev === 0 && tombstone) {
          if (tombstone.siteId && reqSiteId && tombstone.siteId !== reqSiteId) {
            throw new SitesError('STALE_REVISION', 'siteId mismatch on edge', 409)
          }
          if (verified.revision <= siteMax) {
            updateCustomDomainMapping(slug, null)
            analytics.deleteSlug(slug)
            purgeSiteRuntimeArtifacts(dir)
            recordRetiredSiteRevision(
              slug,
              tombstone.siteId ?? reqSiteId ?? null,
              tombstone.revision,
              tombstone.op ?? 'delete',
              tombstone.renamedTo ?? null,
            )
            sendJsonResponse(res, 200, { ok: true, idempotent: true, revision: siteMax })
            return
          }
        }
        if (verified.revision <= siteMax) {
          throw new SitesError('STALE_REVISION', 'stale edge revision', 409)
        }
        updateCustomDomainMapping(slug, null)
        analytics.deleteSlug(slug)
        const retiredDeleteSiteId = curMeta?.siteId ?? reqSiteId ?? null
        purgeSiteRuntimeArtifacts(dir)
        recordRetiredSiteRevision(slug, retiredDeleteSiteId, verified.revision, 'delete', null)
        writeFileAtomic(
          join(dir, 'tombstone.json'),
          JSON.stringify({
            revision: verified.revision,
            deletedAt: new Date().toISOString(),
            siteId: retiredDeleteSiteId,
            op: 'delete',
          }),
        )
        sendJsonResponse(res, 200, { ok: true, revision: verified.revision })
      })
      return
    }

    sendJsonResponse(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'method not allowed' } })
  }

  function resolveClientIp(req: IncomingMessage): string {
    const remoteIp = req.socket.remoteAddress
    const forwardedRealIp =
      isLoopbackIp(remoteIp) && typeof req.headers['x-real-ip'] === 'string'
        ? req.headers['x-real-ip'].trim()
        : ''
    return forwardedRealIp || remoteIp || 'unknown'
  }

  async function handlePublicSite(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const hostHeader = typeof req.headers.host === 'string' ? req.headers.host : ''
    const slug = resolveSlugByHost(hostHeader)
    if (!slug) {
      sendSiteHtml(res, 404, renderStatusHtml('站点不存在', '未找到对应的托管站点域名。'))
      return
    }

    const method = req.method ?? 'GET'
    const isHttps =
      req.headers['x-forwarded-proto'] === 'https' ||
      (req.socket as { encrypted?: boolean }).encrypted === true

    if (method === 'GET' && url.pathname === '/__oc_site_preview_bootstrap') {
      const rawCode = url.searchParams.get('code') ?? undefined
      const previewFiles = resolveSiteFiles(slug, true)
      const payload = previewFiles
        ? verifySitePreviewToken({
            secret: opts.secret,
            token: rawCode,
            expectedSlug: slug,
            expectedKind: 'boot',
          })
        : null
      const minAcl = previewFiles?.meta.previewAclVersion ?? 1
      if (
        !previewFiles ||
        !payload ||
        !payload.nonce ||
        (previewFiles.meta.siteId && payload.siteId !== previewFiles.meta.siteId) ||
        payload.aclVersion < minAcl ||
        !consumePreviewBootNonce(payload.nonce, payload.expSec)
      ) {
        sendSiteHtml(res, 401, renderStatusHtml('预览授权无效', '预览令牌已失效或已使用，请回到站点页面重新打开实时编辑。'), true)
        return
      }
      const sessExpSec = Math.floor(Date.now() / 1000) + SITE_PREVIEW_TTL_SEC
      const sessionCookieToken = signSitePreviewToken({
        secret: opts.secret,
        kind: 'sess',
        siteId: payload.siteId,
        slug,
        parentOrigin: payload.parentOrigin,
        aclVersion: payload.aclVersion,
        expSec: sessExpSec,
      })
      const cookieParts = [
        `${SITE_PREVIEW_COOKIE_NAME}=${sessionCookieToken}`,
        'Path=/',
        'HttpOnly',
        `Max-Age=${SITE_PREVIEW_TTL_SEC}`,
      ]
      if (isHttps) {
        cookieParts.push('Secure', 'SameSite=None', 'Partitioned')
      } else {
        cookieParts.push('SameSite=Lax')
      }
      const targetPath = sanitizeRedirectTarget(url.searchParams.get('path'))
      res.statusCode = 302
      res.setHeader('Set-Cookie', cookieParts.join('; '))
      res.setHeader('Location', targetPath)
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Referrer-Policy', 'no-referrer')
      res.setHeader('Content-Security-Policy', `frame-ancestors ${payload.parentOrigin}`)
      res.end()
      return
    }

    if (method === 'GET' && url.pathname === '/__oc_site_preview_bridge.js') {
      const previewFiles = resolveSiteFiles(slug, true)
      const session = previewFiles ? resolvePreviewSession(req, slug, previewFiles.meta) : null
      if (!session) {
        res.statusCode = 404
        res.setHeader('Cache-Control', 'no-store')
        res.end('not found')
        return
      }
      const script = Buffer.from(sitePreviewBridgeScript(session.parentOrigin), 'utf8')
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Referrer-Policy', 'no-referrer')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Content-Security-Policy', `frame-ancestors ${session.parentOrigin}`)
      res.setHeader('Content-Length', String(script.length))
      res.end(script)
      return
    }

    const previewCandidate = resolveSiteFiles(slug, true)
    const previewSession = previewCandidate
      ? resolvePreviewSession(req, slug, previewCandidate.meta)
      : null
    const active = previewSession ? previewCandidate : isSiteServable(slug)
    if (!active) {
      sendSiteHtml(res, 404, renderStatusHtml('站点暂不可访问', '该站点尚未发布、已下线或已被删除。'))
      return
    }
    const { meta, currentReal, serverEntryReal } = active
    const visitorIp = resolveClientIp(req)
    const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : ''
    const isApiRequest = url.pathname === '/api' || url.pathname.startsWith('/api/')

    const isProtected = meta.visibility !== 'public' || Boolean(previewSession)
    if (meta.visibility === 'password' && !previewSession) {
      if (method === 'POST' && url.pathname === '/__oc_site_unlock') {
        const clientIp = resolveClientIp(req)
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
        if (isApiRequest) {
          res.statusCode = 401
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.setHeader('Cache-Control', 'private, no-store')
          res.setHeader('Vary', 'Cookie')
          setPublicSiteSecurityHeaders(res)
          res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: '该站点受口令保护' } }))
          return
        }
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

    if (isApiRequest && serverEntryReal) {
      let decryptedEnv: Record<string, string>
      try {
        decryptedEnv = readDecryptedSiteEnvStrict(slug)
      } catch {
        sendJsonResponse(res, 500, { error: { code: 'INTERNAL', message: 'site env decryption failed' } })
        return
      }

      const abortController = new AbortController()
      const onClose = () => {
        if (!res.writableEnded) abortController.abort()
      }
      res.once('close', onClose)

      let releaseAdmission!: () => void
      try {
        releaseAdmission = await sharedSandboxAdmission.acquire(slug, abortController.signal)
      } catch (err) {
        res.removeListener('close', onClose)
        if (err instanceof SitesError) {
          sendJsonResponse(res, err.status, {
            error: { code: err.code, message: err.message, retryable: err.retryable },
          })
          return
        }
        sendJsonResponse(res, 429, { error: { code: 'SLUG_BUSY', message: 'too many requests' } })
        return
      }

      let out: Awaited<ReturnType<typeof runSiteApiWorker>>
      try {
        const uploadTimer = setTimeout(() => {
          abortController.abort()
          req.destroy(new Error('REQUEST_BODY_TIMEOUT'))
        }, 10_000)
        let apiBody: Buffer
        try {
          apiBody = await readBodyLimited(req, 2 * 1024 * 1024)
        } finally {
          clearTimeout(uploadTimer)
        }
        const forwardHeaders: Record<string, string> = {}
        for (const [k, v] of Object.entries(req.headers)) {
          if (k === 'cookie') {
            if (v !== undefined) {
              const sanitized = stripPlatformCookies(Array.isArray(v) ? v.join('; ') : v)
              if (sanitized) forwardHeaders[k] = sanitized
            }
          } else if (k === 'authorization') {
            if (v !== undefined) forwardHeaders[k] = Array.isArray(v) ? v.join('; ') : v
          } else if (typeof v === 'string' && k !== 'x-oc-sites-signature') {
            forwardHeaders[k] = v
          }
        }
        const queryObj: Record<string, string> = {}
        for (const [k, v] of url.searchParams.entries()) queryObj[k] = v

        out = await runSiteApiWorker({
          slug,
          siteDir: siteDirOf(slug),
          entryFilePath: serverEntryReal,
          revision: meta.revision,
          method,
          url: req.url ?? url.pathname,
          pathname: url.pathname,
          query: queryObj,
          headers: forwardHeaders,
          body: apiBody,
          env: decryptedEnv,
          allowPrivateFetchForTest: Boolean(opts.allowPrivateFetchForTest),
          signal: abortController.signal,
          preAdmitted: true,
        })
      } finally {
        res.removeListener('close', onClose)
        releaseAdmission()
      }

      if (res.writableEnded || res.destroyed) return
      if (!previewSession) {
        analytics.recordHit({ slug, clientIp: visitorIp, userAgent, isPageView: false })
      }

      const blockedOutHeaders = new Set([
        'set-cookie',
        'content-length',
        'transfer-encoding',
        'connection',
        'strict-transport-security',
        'cache-control',
        'x-content-type-options',
        'cross-origin-opener-policy',
      ])
      for (const [k, v] of Object.entries(out.headers)) {
        const lower = k.toLowerCase()
        if (!blockedOutHeaders.has(lower) && typeof v === 'string') {
          res.setHeader(lower, v)
        }
      }
      setPublicSiteSecurityHeaders(res)
      res.setHeader('Cache-Control', isProtected ? 'private, no-store' : 'no-store')
      if (isProtected) res.setHeader('Vary', 'Cookie')
      if (!res.hasHeader('content-type')) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
      }
      res.statusCode = out.status
      res.setHeader('Content-Length', String(out.body.length))
      res.end(method === 'HEAD' ? undefined : out.body)
      return
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
    if (cleanRel === '__oc_server' || cleanRel.startsWith('__oc_server/')) {
      sendSiteHtml(res, 404, renderStatusHtml('页面不存在', '未找到请求的资源。'), isProtected)
      return
    }
    const segs = cleanRel ? cleanRel.split('/') : []
    if (segs.some((s) => !s || s === '.' || s === '..')) {
      sendSiteHtml(res, 400, renderStatusHtml('请求路径无效', '不允许包含相对跳转路径。'), isProtected)
      return
    }

    const previewCtx = previewSession ? { parentOrigin: previewSession.parentOrigin } : null

    const hit = resolveCandidateFile(currentReal, cleanRel)
    if (hit) {
      const ext = extname(hit).toLowerCase()
      if (!previewSession) {
        analytics.recordHit({
          slug,
          clientIp: visitorIp,
          userAgent,
          isPageView: method === 'GET' && (ext === '.html' || ext === '.htm'),
        })
      }
      serveStaticFile(req, res, hit, cleanRel, 200, meta.visibility, previewCtx)
      return
    }

    const lastSeg = segs[segs.length - 1] ?? ''
    const looksLikeRoute = !lastSeg.includes('.')
    if (meta.spaMode && looksLikeRoute) {
      const spaIndex = resolveCandidateFile(currentReal, '')
      if (spaIndex) {
        if (!previewSession) {
          analytics.recordHit({
            slug,
            clientIp: visitorIp,
            userAgent,
            isPageView: method === 'GET',
          })
        }
        serveStaticFile(req, res, spaIndex, 'index.html', 200, meta.visibility, previewCtx)
        return
      }
    }

    if (!previewSession) {
      analytics.recordHit({ slug, clientIp: visitorIp, userAgent, isPageView: false })
    }
    const custom404 = resolveCandidateFile(currentReal, '404.html')
    if (custom404) {
      serveStaticFile(req, res, custom404, '404.html', 404, meta.visibility, previewCtx)
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

      if (
        pathname === `${SITE_EDGE_PREFIX}/healthz` ||
        pathname.startsWith(`${SITE_EDGE_PREFIX}/`) ||
        pathname === `${SITE_EDGE_V2_PREFIX}/healthz` ||
        pathname.startsWith(`${SITE_EDGE_V2_PREFIX}/`)
      ) {
        await handleControlApi(req, res, url)
        return
      }

      if (pathname === '/internal/tls-ask') {
        if (trustLoopback && !isLoopbackIp(req.socket.remoteAddress)) {
          res.statusCode = 403
          res.end('forbidden')
          return
        }
        const domain = url.searchParams.get('domain') ?? ''
        const slug = resolveSlugByHost(domain)
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
      if (res.headersSent || res.writableEnded) {
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
      analytics.close()
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
