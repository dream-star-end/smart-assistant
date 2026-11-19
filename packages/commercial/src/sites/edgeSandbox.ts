import { randomBytes } from 'node:crypto'
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  rmdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { spawn } from 'node:child_process'
import dns from 'node:dns'
import net from 'node:net'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { SitesError, type SiteDbInspectResponse, type SiteDbQueryResponse } from './types.js'

export const SANDBOX_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
export const SANDBOX_DEFAULT_API_TIMEOUT_MS = 8_000
export const SANDBOX_DEFAULT_DB_TIMEOUT_MS = 5_000
const SANDBOX_MAX_RSS_BYTES = 256 * 1024 * 1024
const SANDBOX_MAX_PIDS = 24
const SANDBOX_MAX_RESPONSE_HEADERS = 64
const SANDBOX_MAX_RESPONSE_HEADER_BYTES = 8 * 1024
const SANDBOX_MAX_IPC_EXTRA_BYTES = 128 * 1024
const SANDBOX_MAX_FETCHES_PER_INVOCATION = 8
const GLOBAL_MAX_ACTIVE_OUTBOUND_FETCHES = 16
const SANDBOX_MAX_FETCH_BODY_BYTES = 1024 * 1024
const SANDBOX_MAX_FETCH_RESPONSE_BYTES = 2 * 1024 * 1024
const SANDBOX_MAX_STDIO_LOG_BYTES = 16 * 1024

const VALID_HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const SENSITIVE_HEADER_NAME_RE = /(?:^x-|token|secret|auth|key|session|cookie|credential)/i
const CROSS_ORIGIN_SAFE_HEADERS = new Set(['accept', 'accept-language', 'user-agent'])

const GLOBAL_MAX_CONCURRENT = 8
const GLOBAL_MAX_QUEUE = 16
const PER_SITE_MAX_CONCURRENT = 2
const PER_SITE_MAX_QUEUE = 4
const ADMISSION_QUEUE_TIMEOUT_MS = 2_000

const ALLOWED_SITE_DATA_FILES = new Set(['site.db', 'site.db-wal', 'site.db-shm', 'site.db-journal'])

interface QueuedWaiter {
  slug: string
  signal?: AbortSignal
  resolve: (release: () => void) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
  onAbort?: () => void
}

export class EdgeSandboxAdmission {
  private globalActive = 0
  private readonly perSiteActive = new Map<string, number>()
  private readonly perSiteQueued = new Map<string, number>()
  private readonly queue: QueuedWaiter[] = []

  constructor(
    private readonly limits = {
      globalMaxConcurrent: GLOBAL_MAX_CONCURRENT,
      globalMaxQueue: GLOBAL_MAX_QUEUE,
      perSiteMaxConcurrent: PER_SITE_MAX_CONCURRENT,
      perSiteMaxQueue: PER_SITE_MAX_QUEUE,
      queueTimeoutMs: ADMISSION_QUEUE_TIMEOUT_MS,
    },
  ) {}

  private makeRelease(slug: string): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.globalActive = Math.max(0, this.globalActive - 1)
      const siteCur = this.perSiteActive.get(slug) ?? 0
      if (siteCur <= 1) this.perSiteActive.delete(slug)
      else this.perSiteActive.set(slug, siteCur - 1)
      this.drainQueue()
    }
  }

  private canStart(slug: string): boolean {
    if (this.globalActive >= this.limits.globalMaxConcurrent) return false
    const siteCur = this.perSiteActive.get(slug) ?? 0
    return siteCur < this.limits.perSiteMaxConcurrent
  }

  private grantSlot(slug: string): () => void {
    this.globalActive += 1
    this.perSiteActive.set(slug, (this.perSiteActive.get(slug) ?? 0) + 1)
    return this.makeRelease(slug)
  }

  private cleanupWaiter(waiter: QueuedWaiter): void {
    clearTimeout(waiter.timer)
    if (waiter.onAbort && waiter.signal) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
    }
    const q = this.perSiteQueued.get(waiter.slug) ?? 0
    if (q <= 1) this.perSiteQueued.delete(waiter.slug)
    else this.perSiteQueued.set(waiter.slug, q - 1)
  }

  private drainQueue(): void {
    for (let i = 0; i < this.queue.length; ) {
      const waiter = this.queue[i]!
      if (waiter.signal?.aborted) {
        this.queue.splice(i, 1)
        this.cleanupWaiter(waiter)
        waiter.reject(new SitesError('SLUG_BUSY', '请求已取消', 499, false))
        continue
      }
      if (!this.canStart(waiter.slug)) {
        i += 1
        continue
      }
      this.queue.splice(i, 1)
      this.cleanupWaiter(waiter)
      waiter.resolve(this.grantSlot(waiter.slug))
      if (this.globalActive >= this.limits.globalMaxConcurrent) break
    }
  }

  acquire(slug: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(new SitesError('SLUG_BUSY', '请求已取消', 499, false))
    }
    if (this.canStart(slug)) {
      return Promise.resolve(this.grantSlot(slug))
    }
    const siteQ = this.perSiteQueued.get(slug) ?? 0
    if (
      this.queue.length >= this.limits.globalMaxQueue ||
      siteQ >= this.limits.perSiteMaxQueue
    ) {
      return Promise.reject(
        new SitesError('SLUG_BUSY', '站点请求并发已满，请稍后重试', 429, true),
      )
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: QueuedWaiter = {
        slug,
        signal,
        resolve,
        reject,
        timer: setTimeout(() => {
          const idx = this.queue.indexOf(waiter)
          if (idx >= 0) this.queue.splice(idx, 1)
          this.cleanupWaiter(waiter)
          reject(new SitesError('SLUG_BUSY', '站点请求排队超时，请稍后重试', 429, true))
        }, this.limits.queueTimeoutMs),
      }
      if (signal) {
        waiter.onAbort = () => {
          const idx = this.queue.indexOf(waiter)
          if (idx >= 0) this.queue.splice(idx, 1)
          this.cleanupWaiter(waiter)
          reject(new SitesError('SLUG_BUSY', '请求已取消', 499, false))
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.perSiteQueued.set(slug, siteQ + 1)
      this.queue.push(waiter)
    })
  }
}

export const sharedSandboxAdmission = new EdgeSandboxAdmission()

let activeOutboundFetches = 0
let cachedBwrapBin: string | null | undefined
let cachedPrlimitBin: string | null | undefined
let cachedSqliteModPath: string | null | undefined

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function resolveBwrapBinary(): string {
  if (cachedBwrapBin !== undefined) {
    if (!cachedBwrapBin) throw new SitesError('EDGE_UNAVAILABLE', '边缘安全沙箱 bwrap 不可用', 503, true)
    return cachedBwrapBin
  }
  const envPath = (process.env.PATH ?? '').split(':').filter(Boolean).map((d) => join(d, 'bwrap'))
  for (const cand of ['/usr/bin/bwrap', '/bin/bwrap', ...envPath]) {
    if (existsSync(cand) && isExecutable(cand)) {
      cachedBwrapBin = cand
      return cand
    }
  }
  cachedBwrapBin = null
  throw new SitesError('EDGE_UNAVAILABLE', '边缘安全沙箱 bwrap 不可用', 503, true)
}

function resolvePrlimitBinary(): string {
  if (cachedPrlimitBin !== undefined) {
    if (!cachedPrlimitBin) {
      throw new SitesError('EDGE_UNAVAILABLE', '边缘安全沙箱 prlimit 资源限制器不可用', 503, true)
    }
    return cachedPrlimitBin
  }
  for (const cand of ['/usr/bin/prlimit', '/bin/prlimit']) {
    if (existsSync(cand) && isExecutable(cand)) {
      cachedPrlimitBin = cand
      return cand
    }
  }
  cachedPrlimitBin = null
  throw new SitesError('EDGE_UNAVAILABLE', '边缘安全沙箱 prlimit 资源限制器不可用', 503, true)
}

export function resolveBetterSqliteModulePath(): string | null {
  if (cachedSqliteModPath !== undefined) return cachedSqliteModPath
  const req = createRequire(import.meta.url)
  const candidates = [
    process.env.OC_SITES_SQLITE_MODULE_PATH?.trim(),
    'better-sqlite3',
    '/opt/openclaude/openclaude-v5/node_modules/better-sqlite3',
    '/opt/openclaude/openclaude-v5-selfhost/node_modules/better-sqlite3',
  ].filter((x): x is string => Boolean(x))

  for (const cand of candidates) {
    try {
      const resolved = req.resolve(cand)
      cachedSqliteModPath = resolved
      return resolved
    } catch {
      /* try next */
    }
  }
  cachedSqliteModPath = null
  return null
}

function findPackageRoot(entryFile: string): string {
  let cur = dirname(realpathSync(entryFile))
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(cur, 'package.json'))) return cur
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return dirname(realpathSync(entryFile))
}

function resolveSqliteSandboxMounts(): Array<{ hostDir: string; containerDir: string }> {
  const sqliteEntry = resolveBetterSqliteModulePath()
  if (!sqliteEntry) return []
  const reqSqlite = createRequire(sqliteEntry)
  const sqliteRoot = findPackageRoot(sqliteEntry)
  const mounts: Array<{ hostDir: string; containerDir: string }> = [
    { hostDir: sqliteRoot, containerDir: '/sandbox/node_modules/better-sqlite3' },
  ]
  try {
    const bindingsEntry = reqSqlite.resolve('bindings')
    mounts.push({
      hostDir: findPackageRoot(bindingsEntry),
      containerDir: '/sandbox/node_modules/bindings',
    })
    const reqBindings = createRequire(bindingsEntry)
    const fileUriEntry = reqBindings.resolve('file-uri-to-path')
    mounts.push({
      hostDir: findPackageRoot(fileUriEntry),
      containerDir: '/sandbox/node_modules/file-uri-to-path',
    })
  } catch {
    /* ignore if optional helper resolution differs */
  }
  return mounts
}

export function cleanupSiteDataExtras(siteDataDir: string): void {
  if (!existsSync(siteDataDir)) return
  try {
    for (const name of readdirSync(siteDataDir)) {
      if (!ALLOWED_SITE_DATA_FILES.has(name)) {
        rmSync(join(siteDataDir, name), { recursive: true, force: true })
      }
    }
  } catch {
    /* best effort sweep */
  }
}

export function assertSafeSiteSql(sql: string): void {
  if (typeof sql !== 'string' || !sql.trim()) {
    throw new SitesError('INVALID_INPUT', 'SQL 语句不能为空', 400)
  }
  if (sql.length > 64 * 1024) {
    throw new SitesError('INVALID_INPUT', '单次 SQL 长度超过 64 KiB 上限', 400)
  }
  let stripped = ''
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]!
    const next = sql[i + 1]
    if (ch === '-' && next === '-') {
      i += 2
      while (i < sql.length && sql[i] !== '\n') i += 1
      stripped += ' '
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < sql.length - 1 && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1
      i += 2
      stripped += ' '
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch
      i += 1
      while (i < sql.length) {
        if (sql[i] === q) {
          if (sql[i + 1] === q) {
            i += 2
            continue
          }
          i += 1
          break
        }
        i += 1
      }
      stripped += ' '
      continue
    }
    stripped += ch
    i += 1
  }

  if (/\b(?:ATTACH|DETACH|LOAD_EXTENSION)\b/i.test(stripped) || /\bVACUUM\b[\s\S]*\bINTO\b/i.test(stripped)) {
    throw new SitesError('INVALID_INPUT', '站点 SQL 禁止使用 ATTACH / DETACH / LOAD_EXTENSION / VACUUM INTO', 400)
  }
  const pragmaMatch = stripped.match(/\bPRAGMA\s+([A-Za-z0-9_.]+)/gi)
  if (pragmaMatch) {
    const allowed = new Set(['table_info', 'foreign_keys', 'journal_mode', 'busy_timeout', 'page_count', 'query_only'])
    for (const m of pragmaMatch) {
      const name = m.replace(/^PRAGMA\s+/i, '').split('.').pop()?.toLowerCase() ?? ''
      if (!allowed.has(name)) {
        throw new SitesError('INVALID_INPUT', `站点 SQL 禁止执行 PRAGMA ${name}`, 400)
      }
    }
  }
}

function setupSandboxCgroup(): string | null {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
  const cgBase = '/sys/fs/cgroup'
  if (!existsSync(cgBase)) {
    if (isRoot) throw new SitesError('EDGE_UNAVAILABLE', '边缘安全沙箱 cgroup2 不可用', 503, true)
    return null
  }
  const cgDir = `${cgBase}/oc-site-${randomBytes(8).toString('hex')}`
  try {
    mkdirSync(cgDir)
    writeFileSync(`${cgDir}/memory.max`, String(SANDBOX_MAX_RSS_BYTES))
    if (existsSync(`${cgDir}/memory.swap.max`)) {
      writeFileSync(`${cgDir}/memory.swap.max`, '0')
    }
    writeFileSync(`${cgDir}/pids.max`, String(SANDBOX_MAX_PIDS))
    return cgDir
  } catch {
    try { rmdirSync(cgDir) } catch {}
    if (isRoot) {
      throw new SitesError('EDGE_UNAVAILABLE', '无法创建沙箱 cgroup2 资源隔离组', 503, true)
    }
    return null
  }
}

function teardownSandboxCgroup(cgDir: string | null): void {
  if (!cgDir) return
  try {
    if (existsSync(`${cgDir}/cgroup.kill`)) {
      writeFileSync(`${cgDir}/cgroup.kill`, '1')
    }
  } catch {}
  try {
    rmdirSync(cgDir)
  } catch {
    const retryTimer = setTimeout(() => {
      try {
        if (existsSync(`${cgDir}/cgroup.kill`)) writeFileSync(`${cgDir}/cgroup.kill`, '1')
      } catch {}
      try { rmdirSync(cgDir) } catch {}
    }, 80)
    retryTimer.unref()
  }
}

function measureProcessTreeUsage(rootPid: number): { rssBytes: number; procCount: number } {
  const parentToChildren = new Map<number, number[]>()
  try {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue
      const pid = Number(entry)
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
        const rparen = stat.lastIndexOf(')')
        if (rparen < 0) continue
        const rest = stat.slice(rparen + 2).split(' ')
        const ppid = Number.parseInt(rest[1] ?? '', 10)
        if (!Number.isFinite(ppid)) continue
        let arr = parentToChildren.get(ppid)
        if (!arr) {
          arr = []
          parentToChildren.set(ppid, arr)
        }
        arr.push(pid)
      } catch {}
    }
  } catch {
    return { rssBytes: 0, procCount: 0 }
  }

  const queue = [rootPid]
  const seen = new Set<number>()
  let rssBytes = 0
  let procCount = 0
  while (queue.length > 0) {
    const pid = queue.shift()!
    if (seen.has(pid)) continue
    seen.add(pid)
    procCount += 1
    try {
      const statm = readFileSync(`/proc/${pid}/statm`, 'utf8').trim().split(/\s+/)
      const pages = Number.parseInt(statm[1] ?? '', 10)
      if (Number.isFinite(pages) && pages > 0) rssBytes += pages * 4096
    } catch {}
    const kids = parentToChildren.get(pid)
    if (kids) queue.push(...kids)
  }
  return { rssBytes, procCount }
}

function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10))
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true
  const [a, b, c] = parts as [number, number, number, number]
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true
  if (a === 192 && b === 168) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a >= 224) return true
  return false
}

function isPrivateOrReservedIp(ip: string): boolean {
  const clean = String(ip || '').toLowerCase().split('%')[0] ?? ''
  if (!clean) return true
  if (net.isIPv4(clean)) return isPrivateOrReservedIpv4(clean)
  if (net.isIPv6(clean)) {
    if (clean === '::' || clean === '::1') return true
    if (clean.startsWith('::ffff:')) return isPrivateOrReservedIpv4(clean.slice(7))
    if (clean.startsWith('fc') || clean.startsWith('fd')) return true
    if (clean.startsWith('fe8') || clean.startsWith('fe9') || clean.startsWith('fea') || clean.startsWith('feb')) {
      return true
    }
    if (clean.startsWith('ff')) return true
    return false
  }
  return true
}

async function resolveAndValidateHost(
  hostname: string,
  allowPrivate: boolean,
): Promise<Array<{ address: string; family: 4 | 6 }>> {
  const bare = hostname.replace(/^\[|\]$/g, '')
  if (net.isIP(bare)) {
    if (!allowPrivate && isPrivateOrReservedIp(bare)) {
      throw new Error('SSRF_BLOCKED: destination IP is not allowed')
    }
    return [{ address: bare, family: net.isIPv6(bare) ? 6 : 4 }]
  }
  const addrs = await dns.promises.lookup(bare, { all: true, verbatim: true })
  if (!addrs || addrs.length === 0) throw new Error('FETCH_DNS_EMPTY')
  const normalized: Array<{ address: string; family: 4 | 6 }> = []
  for (const item of addrs) {
    if (!allowPrivate && isPrivateOrReservedIp(item.address)) {
      throw new Error('SSRF_BLOCKED: destination resolves to private/internal IP')
    }
    normalized.push({ address: item.address, family: item.family === 6 ? 6 : 4 })
  }
  return normalized
}

async function executeTrustedOutboundFetch(
  reqPayload: {
    url: string
    method: string
    headers: Record<string, string>
    bodyBase64: string
    redirect: 'follow' | 'manual' | 'error'
  },
  opts: {
    allowPrivate: boolean
    signal: AbortSignal
    deadlineMs: number
  },
): Promise<{
  ok: boolean
  status: number
  statusText: string
  url: string
  redirected: boolean
  headers: Record<string, string>
  bodyBase64: string
}> {
  if (activeOutboundFetches >= GLOBAL_MAX_ACTIVE_OUTBOUND_FETCHES) {
    throw new Error('FETCH_BUSY: global outbound fetch concurrency reached')
  }
  activeOutboundFetches += 1
  try {
    let currentUrl = new URL(reqPayload.url)
    let method = reqPayload.method.toUpperCase()
    let headers: Record<string, string> = { ...reqPayload.headers }
    let bodyBuf: Buffer | null = reqPayload.bodyBase64
      ? Buffer.from(reqPayload.bodyBase64, 'base64')
      : null
    if (bodyBuf && bodyBuf.length > SANDBOX_MAX_FETCH_BODY_BYTES) {
      throw new Error('FETCH_REQUEST_TOO_LARGE')
    }

    for (let hop = 0; hop <= 5; hop += 1) {
      if (opts.signal.aborted) throw new Error('FETCH_ABORTED')
      const remainingMs = opts.deadlineMs - Date.now()
      if (remainingMs <= 20) throw new Error('FETCH_DEADLINE_EXCEEDED')
      if (currentUrl.protocol !== 'http:' && currentUrl.protocol !== 'https:') {
        throw new Error('SSRF_BLOCKED: only http/https allowed')
      }
      const pinned = await resolveAndValidateHost(currentUrl.hostname, opts.allowPrivate)
      const mod = currentUrl.protocol === 'https:' ? httpsRequest : httpRequest
      const hopTimeoutMs = Math.min(6_000, remainingMs)

      const out = await new Promise<{
        status: number
        statusText: string
        headers: Record<string, string>
        location?: string
        body: Buffer
      }>((resolvePromise, rejectPromise) => {
        let done = false
        let resRef: NodeJS.ReadableStream | null = null
        const finish = (fn: () => void) => {
          if (done) return
          done = true
          clearTimeout(absTimer)
          opts.signal.removeEventListener('abort', onParentAbort)
          fn()
        }
        const onParentAbort = () => {
          req.destroy(new Error('FETCH_ABORTED'))
          if (resRef) {
            const sock = (resRef as { destroy?: (e?: Error) => void }).destroy
            if (typeof sock === 'function') sock.call(resRef)
          }
          finish(() => rejectPromise(new Error('FETCH_ABORTED')))
        }
        const absTimer = setTimeout(() => {
          req.destroy(new Error('FETCH_TIMEOUT'))
        }, hopTimeoutMs)
        opts.signal.addEventListener('abort', onParentAbort, { once: true })

        const req = mod(
          {
            protocol: currentUrl.protocol,
            hostname: currentUrl.hostname,
            port: currentUrl.port || (currentUrl.protocol === 'https:' ? 443 : 80),
            method,
            path: currentUrl.pathname + currentUrl.search,
            headers,
            signal: opts.signal,
            lookup(_host, lookupOpts, cb) {
              if (typeof lookupOpts === 'function') {
                return (lookupOpts as (err: null, addr: string, fam: number) => void)(
                  null,
                  pinned[0]!.address,
                  pinned[0]!.family,
                )
              }
              if (lookupOpts && typeof lookupOpts === 'object' && lookupOpts.all) {
                return (cb as (err: null, addrs: Array<{ address: string; family: 4 | 6 }>) => void)(
                  null,
                  pinned,
                )
              }
              return (cb as (err: null, addr: string, fam: number) => void)(
                null,
                pinned[0]!.address,
                pinned[0]!.family,
              )
            },
          },
          (res) => {
            resRef = res
            const status = res.statusCode ?? 502
            const respHeaders: Record<string, string> = {}
            for (const [k, v] of Object.entries(res.headers)) {
              respHeaders[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v ?? '')
            }
            const location = typeof res.headers.location === 'string' ? res.headers.location : undefined
            if ([301, 302, 303, 307, 308].includes(status) && location) {
              res.destroy()
              finish(() =>
                resolvePromise({
                  status,
                  statusText: res.statusMessage ?? '',
                  headers: respHeaders,
                  location,
                  body: Buffer.alloc(0),
                }),
              )
              return
            }
            const chunks: Buffer[] = []
            let total = 0
            res.on('data', (chunk: Buffer) => {
              total += chunk.length
              if (total > SANDBOX_MAX_FETCH_RESPONSE_BYTES) {
                req.destroy(new Error('FETCH_RESPONSE_TOO_LARGE'))
                res.destroy()
                return
              }
              chunks.push(chunk)
            })
            res.on('end', () => {
              finish(() =>
                resolvePromise({
                  status,
                  statusText: res.statusMessage ?? '',
                  headers: respHeaders,
                  body: Buffer.concat(chunks),
                }),
              )
            })
            res.on('error', (err) => finish(() => rejectPromise(err)))
          },
        )
        req.on('error', (err) => finish(() => rejectPromise(err)))
        if (bodyBuf && bodyBuf.length > 0) req.write(bodyBuf)
        req.end()
      })

      if (out.location) {
        if (reqPayload.redirect === 'manual') {
          return {
            ok: false,
            status: out.status,
            statusText: out.statusText,
            url: currentUrl.toString(),
            redirected: hop > 0,
            headers: out.headers,
            bodyBase64: '',
          }
        }
        if (reqPayload.redirect === 'error') {
          throw new Error('REDIRECT_BLOCKED')
        }
        if (hop >= 5) throw new Error('TOO_MANY_REDIRECTS')
        const nextUrl = new URL(out.location, currentUrl)
        if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
          throw new Error('SSRF_BLOCKED: redirect to non-http protocol')
        }
        const sameOrigin = nextUrl.origin === currentUrl.origin
        if (!sameOrigin) {
          const hasSensitive = Object.keys(headers).some((k) => SENSITIVE_HEADER_NAME_RE.test(k))
          if (hasSensitive) {
            throw new Error('CROSS_ORIGIN_REDIRECT_BLOCKED: refusing to forward sensitive or custom headers across origins')
          }
          if ((out.status === 307 || out.status === 308) && (method !== 'GET' && method !== 'HEAD')) {
            throw new Error('CROSS_ORIGIN_REDIRECT_BLOCKED: non-idempotent 307/308 cross-origin redirect forbidden')
          }
          const safeAllowlistHeaders: Record<string, string> = {}
          for (const [k, v] of Object.entries(headers)) {
            if (CROSS_ORIGIN_SAFE_HEADERS.has(k.toLowerCase())) {
              safeAllowlistHeaders[k.toLowerCase()] = v
            }
          }
          headers = safeAllowlistHeaders
          if (method !== 'HEAD') method = 'GET'
          bodyBuf = null
        } else if (out.status === 303 || ((out.status === 301 || out.status === 302) && method === 'POST')) {
          method = 'GET'
          bodyBuf = null
          headers = Object.fromEntries(
            Object.entries(headers).filter(([k]) => {
              const lk = k.toLowerCase()
              return lk !== 'content-length' && lk !== 'content-type'
            }),
          )
        }
        currentUrl = nextUrl
        continue
      }

      return {
        ok: out.status >= 200 && out.status < 300,
        status: out.status,
        statusText: out.statusText,
        url: currentUrl.toString(),
        redirected: hop > 0,
        headers: out.headers,
        bodyBase64: out.body.toString('base64'),
      }
    }
    throw new Error('TOO_MANY_REDIRECTS')
  } finally {
    activeOutboundFetches = Math.max(0, activeOutboundFetches - 1)
  }
}

const SANDBOX_CHILD_SCRIPT = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function writeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const hdr = Buffer.allocUnsafe(4);
  hdr.writeUInt32BE(body.length, 0);
  const frame = Buffer.concat([hdr, body]);
  let offset = 0;
  while (offset < frame.length) {
    try {
      const n = fs.writeSync(3, frame, offset, frame.length - offset);
      if (n <= 0) throw new Error('short write on IPC fd 3');
      offset += n;
    } catch (err) {
      if (err && (err.code === 'EAGAIN' || err.code === 'EINTR')) continue;
      throw err;
    }
  }
}

const MAX_DB_CELL_BYTES = 4096;
const MAX_DB_RESULT_BYTES = 256 * 1024;
const MAX_INSPECT_LIMIT = 200;
const MAX_SQL_ROWS = 500;

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

function assertSafeSqlChild(sql) {
  if (typeof sql !== 'string' || !sql.trim()) throw new Error('SQL cannot be empty');
  if (sql.length > 64 * 1024) throw new Error('SQL exceeds 64 KiB');
  let stripped = '', i = 0;
  while (i < sql.length) {
    const ch = sql[i], next = sql[i + 1];
    if (ch === '-' && next === '-') { i += 2; while (i < sql.length && sql[i] !== '\\n') i++; stripped += ' '; continue; }
    if (ch === '/' && next === '*') { i += 2; while (i < sql.length - 1 && !(sql[i] === '*' && sql[i + 1] === '/')) i++; i += 2; stripped += ' '; continue; }
    if (ch === "'" || ch === '"' || ch === '\`') {
      const q = ch; i++;
      while (i < sql.length) {
        if (sql[i] === q) { if (sql[i + 1] === q) { i += 2; continue; } i++; break; }
        i++;
      }
      stripped += ' '; continue;
    }
    stripped += ch; i++;
  }
  if (/\\b(?:ATTACH|DETACH|LOAD_EXTENSION)\\b/i.test(stripped) || /\\bVACUUM\\b[\\s\\S]*\\bINTO\\b/i.test(stripped)) {
    throw new Error('SQL_FORBIDDEN: ATTACH/DETACH/LOAD_EXTENSION/VACUUM INTO is not allowed');
  }
  const pragmaMatch = stripped.match(/\\bPRAGMA\\s+([A-Za-z0-9_.]+)/gi);
  if (pragmaMatch) {
    const allowed = new Set(['table_info', 'foreign_keys', 'journal_mode', 'busy_timeout', 'page_count', 'query_only']);
    for (const m of pragmaMatch) {
      const name = m.replace(/^PRAGMA\\s+/i, '').split('.').pop().toLowerCase();
      if (!allowed.has(name)) throw new Error('SQL_FORBIDDEN: PRAGMA ' + name);
    }
  }
}

function normalizeCell(val) {
  if (val === null || val === undefined) return { val: null, clipped: false };
  if (typeof val === 'bigint') return { val: val.toString(), clipped: false };
  if (Buffer.isBuffer(val)) return { val: '<binary ' + val.length + 'B>', clipped: false };
  if (val instanceof Uint8Array) return { val: '<binary ' + val.byteLength + 'B>', clipped: false };
  if (typeof val === 'string') {
    const b = Buffer.byteLength(val, 'utf8');
    if (b > MAX_DB_CELL_BYTES) {
      let cut = Buffer.from(val, 'utf8').subarray(0, MAX_DB_CELL_BYTES - 24).toString('utf8');
      if (cut.endsWith('\\ufffd')) cut = cut.slice(0, -1);
      return { val: cut + '...(truncated)', clipped: true };
    }
  }
  return { val, clipped: false };
}

function iterateBoundedRows(stmt, params, maxRows) {
  const rows = [];
  let byteBudget = 0;
  let truncated = false;
  for (const rawRow of stmt.iterate(...params)) {
    if (rows.length >= maxRows) { truncated = true; break; }
    const outRow = {};
    for (const [k, v] of Object.entries(rawRow)) {
      const norm = normalizeCell(v);
      if (norm.clipped) truncated = true;
      outRow[k] = norm.val;
    }
    const rowJsonLen = Buffer.byteLength(JSON.stringify(outRow), 'utf8') + 2;
    if (rows.length > 0 && byteBudget + rowJsonLen > MAX_DB_RESULT_BYTES) {
      truncated = true;
      break;
    }
    if (rows.length === 0 && rowJsonLen > MAX_DB_RESULT_BYTES) {
      truncated = true;
      rows.push({ _notice: 'single row exceeds 256 KiB preview budget' });
      break;
    }
    byteBudget += rowJsonLen;
    rows.push(outRow);
  }
  return { rows, truncated };
}

let fetchSeq = 0;
const pendingFetches = new Map();
let inBuf = Buffer.alloc(0);
let initHandled = false;

process.stdin.on('data', (chunk) => {
  inBuf = Buffer.concat([inBuf, chunk]);
  while (inBuf.length >= 4) {
    const len = inBuf.readUInt32BE(0);
    if (inBuf.length < 4 + len) break;
    const msg = JSON.parse(inBuf.subarray(4, 4 + len).toString('utf8'));
    inBuf = inBuf.subarray(4 + len);
    if (!initHandled) {
      initHandled = true;
      void runTask(msg);
    } else if (msg && msg.type === 'fetch_res') {
      const waiter = pendingFetches.get(msg.id);
      if (waiter) {
        pendingFetches.delete(msg.id);
        if (msg.error) waiter.reject(new Error(msg.error));
        else waiter.resolve(msg);
      }
    }
  }
});
process.stdin.resume();

function sandboxFetch(input, init) {
  return new Promise((resolve, reject) => {
    const id = ++fetchSeq;
    const urlStr = typeof input === 'string' ? input : (input && input.url ? String(input.url) : String(input));
    const method = (init && init.method ? String(init.method) : (input && input.method ? String(input.method) : 'GET')).toUpperCase();
    const outHeaders = {};
    const rawH = (init && init.headers) || (input && input.headers);
    if (rawH) {
      if (typeof rawH.forEach === 'function') rawH.forEach((v, k) => { outHeaders[String(k)] = String(v); });
      else for (const [k, v] of Object.entries(rawH)) if (v !== undefined) outHeaders[String(k)] = String(v);
    }
    let bodyBase64 = '';
    const rawBody = (init && init.body !== undefined) ? init.body : (input && input.body !== undefined ? input.body : null);
    if (rawBody !== null && rawBody !== undefined) {
      if (Buffer.isBuffer(rawBody)) bodyBase64 = rawBody.toString('base64');
      else if (ArrayBuffer.isView(rawBody)) bodyBase64 = Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength).toString('base64');
      else if (rawBody instanceof ArrayBuffer) bodyBase64 = Buffer.from(rawBody).toString('base64');
      else bodyBase64 = Buffer.from(String(rawBody), 'utf8').toString('base64');
    }
    const redirect = (init && (init.redirect === 'manual' || init.redirect === 'error')) ? init.redirect : 'follow';
    pendingFetches.set(id, {
      resolve(res) {
        const hdrMap = new Map(Object.entries(res.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
        const buf = Buffer.from(res.bodyBase64 || '', 'base64');
        resolve({
          ok: Boolean(res.ok),
          status: Number(res.status || 500),
          statusText: String(res.statusText || ''),
          url: String(res.url || urlStr),
          redirected: Boolean(res.redirected),
          headers: {
            get: (n) => hdrMap.get(String(n).toLowerCase()) ?? null,
            has: (n) => hdrMap.has(String(n).toLowerCase()),
            forEach: (cb) => hdrMap.forEach((v, k) => cb(v, k)),
            entries: () => hdrMap.entries(),
          },
          async text() { return buf.toString('utf8'); },
          async json() { return JSON.parse(buf.toString('utf8')); },
          async arrayBuffer() { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); },
          async bytes() { return new Uint8Array(buf); },
        });
      },
      reject,
    });
    writeFrame({ type: 'fetch_req', id, url: urlStr, method, headers: outHeaders, bodyBase64, redirect });
  });
}

async function runTask(initMsg) {
  let dbInstance = null;
  function loadSqliteCtor() {
    const loaded = require('/sandbox/node_modules/better-sqlite3/lib/index.js');
    return typeof loaded === 'function' ? loaded : loaded.default;
  }
  function getRwDb() {
    if (dbInstance) return dbInstance;
    const Ctor = loadSqliteCtor();
    dbInstance = new Ctor('/site/data/site.db', { timeout: 3000 });
    dbInstance.unsafeMode(false);
    dbInstance.pragma('journal_mode = WAL');
    dbInstance.pragma('foreign_keys = ON');
    dbInstance.pragma('busy_timeout = 3000');
    dbInstance.pragma('max_page_count = 13107');
    return dbInstance;
  }

  try {
    if (initMsg.mode === 'db-inspect') {
      const Ctor = loadSqliteCtor();
      dbInstance = new Ctor('/site/data/site.db', { readonly: true, fileMustExist: true, timeout: 3000 });
      dbInstance.pragma('query_only = ON');
      const limit = Math.max(1, Math.min(MAX_INSPECT_LIMIT, Math.trunc(initMsg.limit || 100)));
      const rawTables = dbInstance.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC").all();
      const tables = rawTables.map((t) => {
        const cnt = dbInstance.prepare('SELECT COUNT(*) AS cnt FROM ' + quoteIdent(t.name)).get();
        return { name: t.name, rowCount: Number((cnt && cnt.cnt) || 0) };
      });
      const selectedTable = initMsg.table && tables.some((t) => t.name === initMsg.table) ? initMsg.table : (tables[0] ? tables[0].name : null);
      if (!selectedTable) {
        writeFrame({ type: 'result', payload: { connected: true, hasDatabaseFile: true, sizeBytes: initMsg.sizeBytes, tables, selectedTable: null, columns: [], rows: [], truncated: false } });
        process.exit(0);
      }
      const rawCols = dbInstance.prepare('PRAGMA table_info(' + quoteIdent(selectedTable) + ')').all();
      const columns = rawCols.map((c) => ({ name: c.name, type: c.type || 'TEXT', pk: Number(c.pk || 0) > 0, notnull: Number(c.notnull || 0) > 0 }));
      let stmt;
      try { stmt = dbInstance.prepare('SELECT * FROM ' + quoteIdent(selectedTable) + ' ORDER BY rowid DESC LIMIT ?'); }
      catch { stmt = dbInstance.prepare('SELECT * FROM ' + quoteIdent(selectedTable) + ' LIMIT ?'); }
      const { rows, truncated } = iterateBoundedRows(stmt, [limit], limit);
      writeFrame({ type: 'result', payload: { connected: true, hasDatabaseFile: true, sizeBytes: initMsg.sizeBytes, tables, selectedTable, columns, rows, truncated } });
      process.exit(0);
    }

    if (initMsg.mode === 'db-sql') {
      assertSafeSqlChild(initMsg.sql);
      const db = getRwDb();
      const trimmed = initMsg.sql.trim();
      const params = Array.isArray(initMsg.params) ? initMsg.params : [];
      if (params.length > 0 || /^\\s*(?:SELECT|WITH|PRAGMA|EXPLAIN)\\b/i.test(trimmed)) {
        const stmt = db.prepare(trimmed);
        if (stmt.reader) {
          const columns = stmt.columns().map((c) => c.name);
          const { rows, truncated } = iterateBoundedRows(stmt, params, MAX_SQL_ROWS);
          writeFrame({ type: 'result', payload: { columns, rows, changes: 0, lastInsertRowid: null, truncated } });
          process.exit(0);
        }
        const info = stmt.run(...params);
        writeFrame({ type: 'result', payload: { columns: [], rows: [], changes: info.changes, lastInsertRowid: typeof info.lastInsertRowid === 'bigint' ? info.lastInsertRowid.toString() : info.lastInsertRowid, truncated: false } });
        process.exit(0);
      }
      db.exec(trimmed);
      writeFrame({ type: 'result', payload: { columns: [], rows: [], changes: 0, lastInsertRowid: null, truncated: false } });
      process.exit(0);
    }

    globalThis.fetch = sandboxFetch;
    const unwrapParams = (p) => (p.length === 1 && Array.isArray(p[0]) ? p[0] : p);
    const dbHelper = {
      exec(sql) { assertSafeSqlChild(sql); getRwDb().exec(sql); },
      query(sql, ...params) { assertSafeSqlChild(sql); return getRwDb().prepare(sql).all(...unwrapParams(params)); },
      all(sql, ...params) { assertSafeSqlChild(sql); return getRwDb().prepare(sql).all(...unwrapParams(params)); },
      get(sql, ...params) { assertSafeSqlChild(sql); return getRwDb().prepare(sql).get(...unwrapParams(params)); },
      run(sql, ...params) {
        assertSafeSqlChild(sql);
        const info = getRwDb().prepare(sql).run(...unwrapParams(params));
        return { changes: info.changes, lastInsertRowid: typeof info.lastInsertRowid === 'bigint' ? info.lastInsertRowid.toString() : info.lastInsertRowid };
      },
    };

    const rawBody = Buffer.from(initMsg.bodyBase64 || '', 'base64');
    const modUrl = pathToFileURL('/site/server/' + path.basename(initMsg.entryBasename)).href + '?v=' + String(initMsg.revision);
    const mod = await import(modUrl);
    const fn = typeof mod.default === 'function' ? mod.default : typeof mod.handler === 'function' ? mod.handler : null;
    if (!fn) {
      writeFrame({ type: 'result', status: 500, headers: { 'content-type': 'application/json; charset=utf-8' }, bodyBase64: Buffer.from(JSON.stringify({ error: 'API entrypoint must export default function(ctx)' })).toString('base64') });
      process.exit(0);
    }
    const ctx = {
      req: {
        method: initMsg.method,
        url: initMsg.url,
        pathname: initMsg.pathname,
        query: initMsg.query,
        headers: initMsg.headers,
        body: rawBody,
        text() { return rawBody.toString('utf8'); },
        json() { return rawBody.length ? JSON.parse(rawBody.toString('utf8')) : null; },
      },
      site: Object.freeze({ slug: initMsg.slug || '', revision: initMsg.revision }),
      env: Object.freeze({ ...(initMsg.env || {}) }),
      db: dbHelper,
      json(data, status = 200, headers = {}) {
        return { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers }, body: JSON.stringify(data) };
      },
      text(str, status = 200, headers = {}) {
        return { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...headers }, body: String(str ?? '') };
      },
    };
    const result = fn.length >= 2 ? await fn(ctx.req, ctx) : await fn(ctx);
    let outStatus = 200;
    let outHeaders = { 'content-type': 'application/json; charset=utf-8' };
    let outBuf = Buffer.alloc(0);
    if (result && typeof result === 'object' && typeof result.arrayBuffer === 'function' && typeof result.status === 'number') {
      outStatus = result.status;
      outHeaders = {};
      if (result.headers && typeof result.headers.forEach === 'function') result.headers.forEach((v, k) => { outHeaders[String(k).toLowerCase()] = String(v); });
      outBuf = Buffer.from(await result.arrayBuffer());
    } else if (result && typeof result === 'object' && ('status' in result || 'body' in result || 'headers' in result)) {
      outStatus = typeof result.status === 'number' ? result.status : 200;
      outHeaders = result.headers && typeof result.headers === 'object' ? { ...result.headers } : outHeaders;
      if (Buffer.isBuffer(result.body)) outBuf = result.body;
      else if (typeof result.body === 'string') outBuf = Buffer.from(result.body, 'utf8');
      else if (result.body !== undefined) outBuf = Buffer.from(JSON.stringify(result.body), 'utf8');
    } else if (result !== undefined) {
      outBuf = Buffer.from(JSON.stringify(result), 'utf8');
    }
    if (outBuf.length > initMsg.maxResponseBytes) {
      writeFrame({ type: 'result', status: 502, headers: { 'content-type': 'application/json; charset=utf-8' }, bodyBase64: Buffer.from(JSON.stringify({ error: 'API response exceeded size limit' })).toString('base64') });
      process.exit(0);
    }
    writeFrame({ type: 'result', status: outStatus, headers: outHeaders, bodyBase64: outBuf.toString('base64') });
    process.exit(0);
  } catch (err) {
    try { writeFrame({ type: 'error', message: (err && err.message) || 'Sandbox task failed' }); } catch {}
    process.exit(1);
  } finally {
    if (dbInstance) { try { dbInstance.close(); } catch {} }
  }
}
`;

function buildBwrapArgs(opts: {
  nodeReal: string
  sqliteMounts: Array<{ hostDir: string; containerDir: string }>
  serverDir?: string
  siteDataDir?: string
}): string[] {
  const args: string[] = [
    '--unshare-all',
    '--uid', '65534',
    '--gid', '65534',
    '--die-with-parent',
    '--new-session',
    '--clearenv',
    '--setenv', 'PATH', '/usr/bin:/bin',
    '--setenv', 'HOME', '/tmp',
    '--setenv', 'NODE_PATH', '/sandbox/node_modules',
  ]

  if (existsSync('/usr')) args.push('--ro-bind', '/usr', '/usr')
  for (const sysPath of ['/bin', '/lib', '/lib64']) {
    try {
      const st = lstatSync(sysPath)
      if (st.isSymbolicLink()) {
        args.push('--symlink', readlinkSync(sysPath), sysPath)
      } else if (st.isDirectory()) {
        args.push('--ro-bind', sysPath, sysPath)
      }
    } catch {
      /* absent */
    }
  }
  if (existsSync('/etc/ld.so.cache')) {
    args.push('--ro-bind', '/etc/ld.so.cache', '/etc/ld.so.cache')
  }
  if (!opts.nodeReal.startsWith('/usr/')) {
    const nodePrefix = resolve(dirname(opts.nodeReal), '..')
    args.push('--ro-bind', nodePrefix, nodePrefix)
  }

  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp')
  args.push('--dir', '/site', '--dir', '/sandbox', '--dir', '/sandbox/node_modules')

  for (const m of opts.sqliteMounts) {
    args.push('--ro-bind', m.hostDir, m.containerDir)
  }
  if (opts.serverDir) {
    args.push('--ro-bind', opts.serverDir, '/site/server')
  }
  if (opts.siteDataDir) {
    args.push('--bind', opts.siteDataDir, '/site/data')
  }

  args.push(opts.nodeReal, '--max-old-space-size=128', '-e', SANDBOX_CHILD_SCRIPT)
  return args
}

function writeLengthFrame(stream: NodeJS.WritableStream, obj: unknown): void {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8')
  const hdr = Buffer.allocUnsafe(4)
  hdr.writeUInt32BE(payload.length, 0)
  stream.write(hdr)
  stream.write(payload)
}

function validateApiResultFrame(
  raw: Record<string, unknown>,
  maxResponseBytes: number,
): { status: number; headers: Record<string, string>; body: Buffer } {
  const status = raw.status
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error('INVALID_IPC_STATUS')
  }
  const rawHeaders = raw.headers
  if (rawHeaders !== undefined && (typeof rawHeaders !== 'object' || rawHeaders === null || Array.isArray(rawHeaders))) {
    throw new Error('INVALID_IPC_HEADERS')
  }
  const headers: Record<string, string> = {}
  let headerBytes = 0
  if (rawHeaders) {
    const entries = Object.entries(rawHeaders as Record<string, unknown>)
    if (entries.length > SANDBOX_MAX_RESPONSE_HEADERS) {
      throw new Error('TOO_MANY_IPC_HEADERS')
    }
    for (const [k, v] of entries) {
      if (typeof v !== 'string' || !VALID_HEADER_NAME_RE.test(k) || /[\r\n\0]/.test(v)) {
        throw new Error('INVALID_IPC_HEADER_ENTRY')
      }
      headerBytes += k.length + Buffer.byteLength(v, 'utf8')
      if (headerBytes > SANDBOX_MAX_RESPONSE_HEADER_BYTES) {
        throw new Error('IPC_HEADERS_TOO_LARGE')
      }
      headers[k.toLowerCase()] = v
    }
  }
  const bodyBase64 = typeof raw.bodyBase64 === 'string' ? raw.bodyBase64 : ''
  const approxDecoded = Math.floor((bodyBase64.length * 3) / 4)
  if (approxDecoded > maxResponseBytes + 16) {
    throw new Error('IPC_BODY_TOO_LARGE')
  }
  const body = Buffer.from(bodyBase64, 'base64')
  if (body.length > maxResponseBytes) {
    throw new Error('IPC_BODY_TOO_LARGE')
  }
  return { status, headers, body }
}

export async function runInSiteSandbox(opts: {
  slug: string
  mode: 'api' | 'db-inspect' | 'db-sql'
  initPayload: Record<string, unknown>
  serverDir?: string
  siteDataDir?: string
  timeoutMs: number
  maxResponseBytes: number
  allowPrivateFetch?: boolean
  signal?: AbortSignal
  preAdmitted?: boolean
}): Promise<
  | { status: number; headers: Record<string, string>; body: Buffer }
  | SiteDbInspectResponse
  | SiteDbQueryResponse
> {
  const bwrapBin = resolveBwrapBinary()
  const prlimitBin = resolvePrlimitBinary()
  const sqliteMounts = resolveSqliteSandboxMounts()
  if (opts.mode !== 'api' && sqliteMounts.length === 0) {
    throw new SitesError('INTERNAL', '内置站点数据库驱动 better-sqlite3 未就绪', 503)
  }

  const release = opts.preAdmitted
    ? () => {}
    : await sharedSandboxAdmission.acquire(opts.slug, opts.signal)

  let cgDir: string | null = null
  try {
    if (opts.mode !== 'db-inspect' && opts.siteDataDir) {
      mkdirSync(opts.siteDataDir, { recursive: true })
    }
    const nodeReal = realpathSync(process.execPath)
    const bwrapArgs = buildBwrapArgs({
      nodeReal,
      sqliteMounts,
      serverDir: opts.serverDir,
      siteDataDir: opts.siteDataDir,
    })

    cgDir = setupSandboxCgroup()
    const prlimitArgs = ['--cpu=10', '--fsize=67108864', '--nofile=256', '--', bwrapBin, ...bwrapArgs]
    const spawnCmd = cgDir ? '/bin/sh' : prlimitBin
    const spawnArgs = cgDir
      ? ['-c', 'echo "$$" > "$1/cgroup.procs" && shift && exec "$@"', '_', cgDir, prlimitBin, ...prlimitArgs]
      : prlimitArgs

    const child = spawn(spawnCmd, spawnArgs, {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      env: {},
      detached: true,
    })

    const maxFrameBytes =
      opts.mode === 'api'
        ? Math.ceil(opts.maxResponseBytes / 3) * 4 + SANDBOX_MAX_IPC_EXTRA_BYTES
        : opts.maxResponseBytes + SANDBOX_MAX_IPC_EXTRA_BYTES
    const deadlineMs = Date.now() + opts.timeoutMs
    const runFetchAbort = new AbortController()
    let fetchCount = 0
    let stderrText = ''

    child.stdout?.on('data', () => {
      /* discard user console.log so stdout pipe never stalls */
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrText.length < SANDBOX_MAX_STDIO_LOG_BYTES) {
        stderrText += chunk.toString('utf8', 0, Math.min(chunk.length, SANDBOX_MAX_STDIO_LOG_BYTES))
      }
    })
    child.stdin?.on('error', () => {
      /* ignore EPIPE when child exits */
    })

    const killTree = () => {
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL') } catch {}
      }
      try { child.kill('SIGKILL') } catch {}
      if (cgDir && existsSync(`${cgDir}/cgroup.kill`)) {
        try { writeFileSync(`${cgDir}/cgroup.kill`, '1') } catch {}
      }
    }

    const ipcStream = child.stdio[3] as NodeJS.ReadableStream | undefined
    if (!ipcStream) {
      killTree()
      throw new Error('SANDBOX_IPC_MISSING')
    }

    return await new Promise((resolvePromise, rejectPromise) => {
      let settled = false
      let acc = Buffer.alloc(0)
      let rssTimer: ReturnType<typeof setInterval> | null = null
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null

      const cleanupRun = () => {
        if (timeoutTimer) clearTimeout(timeoutTimer)
        if (rssTimer) clearInterval(rssTimer)
        if (opts.signal && onAbort) opts.signal.removeEventListener('abort', onAbort)
        runFetchAbort.abort()
        killTree()
      }

      const finishReject = (err: Error) => {
        if (settled) return
        settled = true
        cleanupRun()
        rejectPromise(err)
      }

      const finishResolve = (val: unknown) => {
        if (settled) return
        settled = true
        cleanupRun()
        resolvePromise(val as never)
      }

      const onAbort = () => finishReject(new Error('API_ABORTED'))
      if (opts.signal) {
        if (opts.signal.aborted) {
          onAbort()
          return
        }
        opts.signal.addEventListener('abort', onAbort, { once: true })
      }

      timeoutTimer = setTimeout(() => {
        finishReject(new Error(opts.mode === 'api' ? 'API_TIMEOUT' : 'DB_TIMEOUT'))
      }, opts.timeoutMs)

      if (child.pid) {
        const rootPid = child.pid
        rssTimer = setInterval(() => {
          if (settled) return
          const { rssBytes, procCount } = measureProcessTreeUsage(rootPid)
          if (rssBytes > SANDBOX_MAX_RSS_BYTES || procCount > SANDBOX_MAX_PIDS) {
            finishReject(new Error('SANDBOX_OOM'))
          }
        }, 120)
        rssTimer.unref()
      }

      ipcStream.on('data', (chunk: Buffer) => {
        try {
          if (settled) return
          if (acc.length + chunk.length > maxFrameBytes + 4) {
            finishReject(new Error('IPC_FRAME_TOO_LARGE'))
            return
          }
          acc = Buffer.concat([acc, chunk])
          while (acc.length >= 4 && !settled) {
            const len = acc.readUInt32BE(0)
            if (len === 0 || len > maxFrameBytes) {
              finishReject(new Error('IPC_FRAME_TOO_LARGE'))
              return
            }
            if (acc.length < 4 + len) break
            const rawStr = acc.subarray(4, 4 + len).toString('utf8')
            acc = acc.subarray(4 + len)
            const msg = JSON.parse(rawStr) as unknown
            if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
              finishReject(new Error('INVALID_IPC_MESSAGE'))
              return
            }
            const rec = msg as Record<string, unknown>
            if (rec.type === 'fetch_req') {
              if (opts.mode !== 'api') {
                finishReject(new Error('FETCH_FORBIDDEN_IN_DB_MODE'))
                return
              }
              const reqId = rec.id
              if (typeof reqId !== 'number' || !Number.isSafeInteger(reqId)) {
                finishReject(new Error('INVALID_FETCH_ID'))
                return
              }
              fetchCount += 1
              if (fetchCount > SANDBOX_MAX_FETCHES_PER_INVOCATION) {
                writeLengthFrame(child.stdin!, {
                  type: 'fetch_res',
                  id: reqId,
                  error: 'FETCH_QUOTA_EXCEEDED: max 8 outbound requests per API call',
                })
                continue
              }
              const fetchUrl = typeof rec.url === 'string' ? rec.url.slice(0, 4096) : ''
              const fetchMethod = typeof rec.method === 'string' ? rec.method : 'GET'
              const fetchHdrs: Record<string, string> = {}
              if (rec.headers && typeof rec.headers === 'object' && !Array.isArray(rec.headers)) {
                for (const [k, v] of Object.entries(rec.headers as Record<string, unknown>)) {
                  if (typeof v === 'string' && VALID_HEADER_NAME_RE.test(k) && !/[\r\n\0]/.test(v)) {
                    fetchHdrs[k] = v
                  }
                }
              }
              const fetchBodyB64 = typeof rec.bodyBase64 === 'string' ? rec.bodyBase64 : ''
              const fetchRedirect =
                rec.redirect === 'manual' || rec.redirect === 'error' ? rec.redirect : 'follow'
              void executeTrustedOutboundFetch(
                {
                  url: fetchUrl,
                  method: fetchMethod,
                  headers: fetchHdrs,
                  bodyBase64: fetchBodyB64,
                  redirect: fetchRedirect,
                },
                {
                  allowPrivate: Boolean(opts.allowPrivateFetch),
                  signal: runFetchAbort.signal,
                  deadlineMs,
                },
              )
                .then((res) => {
                  if (!settled && !runFetchAbort.signal.aborted && child.stdin && !child.stdin.destroyed) {
                    writeLengthFrame(child.stdin, { type: 'fetch_res', id: reqId, ...res })
                  }
                })
                .catch((err) => {
                  if (!settled && !runFetchAbort.signal.aborted && child.stdin && !child.stdin.destroyed) {
                    writeLengthFrame(child.stdin, {
                      type: 'fetch_res',
                      id: reqId,
                      error: (err as Error)?.message || 'fetch failed',
                    })
                  }
                })
              continue
            }

            if (rec.type === 'error') {
              const msgText = typeof rec.message === 'string' ? rec.message : 'Sandbox execution error'
              if (opts.mode === 'api') {
                finishResolve({
                  status: 500,
                  headers: { 'content-type': 'application/json; charset=utf-8' },
                  body: Buffer.from(JSON.stringify({ error: msgText }), 'utf8'),
                })
              } else {
                finishReject(new SitesError('INVALID_INPUT', msgText, 400))
              }
              return
            }

            if (rec.type === 'result') {
              if (opts.mode === 'api') {
                finishResolve(validateApiResultFrame(rec, opts.maxResponseBytes))
              } else {
                if (!rec.payload || typeof rec.payload !== 'object' || Array.isArray(rec.payload)) {
                  finishReject(new Error('INVALID_DB_IPC_PAYLOAD'))
                  return
                }
                finishResolve(rec.payload)
              }
              return
            }

            finishReject(new Error('UNKNOWN_IPC_FRAME_TYPE'))
            return
          }
        } catch (err) {
          finishReject(err instanceof Error ? err : new Error(String(err)))
        }
      })

      ipcStream.on('error', (err) => finishReject(err instanceof Error ? err : new Error(String(err))))
      child.once('error', (err) => finishReject(err instanceof Error ? err : new Error(String(err))))
      child.once('close', (code) => {
        if (!settled) {
          finishReject(new Error(`Sandbox exited unexpectedly (${code}): ${stderrText.slice(0, 200)}`))
        }
      })

      try {
        writeLengthFrame(child.stdin!, { mode: opts.mode, ...opts.initPayload })
      } catch (err) {
        finishReject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  } finally {
    teardownSandboxCgroup(cgDir)
    if (opts.mode !== 'db-inspect' && opts.siteDataDir) {
      cleanupSiteDataExtras(opts.siteDataDir)
    }
    release()
  }
}
