/**
 * V5 in-container webpage preview.
 *
 * A commercial-master authenticated internal WebSocket owns one isolated
 * Chromium context. CDP screencast frames are sent as compact binary OCPF
 * packets; control and selection metadata remain bounded JSON.
 */

import { existsSync } from 'node:fs'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { get as httpGet, request as httpRequest } from 'node:http'
import { get as httpsGet, request as httpsRequest } from 'node:https'
import { createRequire } from 'node:module'
import { isIPv4 } from 'node:net'
import type { Duplex } from 'node:stream'

import {
  CONTAINER_PREVIEW_ASSERTION_HEADER,
  CONTAINER_PREVIEW_BINARY_HEADER_BYTES,
  CONTAINER_PREVIEW_DIRECT_BRIDGE_PATH,
  CONTAINER_PREVIEW_DIRECT_COOKIE,
  CONTAINER_PREVIEW_DIRECT_PROXY_PATH,
  CONTAINER_PREVIEW_INTERNAL_WS_PATH,
  CONTAINER_PREVIEW_MAX_BINARY_FRAME_BYTES,
  CONTAINER_PREVIEW_PROTOCOL_VERSION,
  CONTAINER_PREVIEW_TARGET_HEADER,
  CONTAINER_PREVIEW_VIEWPORT_HEADER,
  type ContainerPreviewClientMessage,
  type ContainerPreviewElementTarget,
  type ContainerPreviewOpenMessage,
  type ContainerPreviewServerMessage,
  type ContainerPreviewViewport,
  encodeContainerPreviewFrame,
  isAllowedContainerPreviewHttpRequest,
  isAllowedContainerPreviewNavigation,
  isAllowedContainerPreviewWebSocket,
  normalizeContainerPreviewUrl,
  normalizeContainerPreviewViewport,
  parseAuthorityKeyring,
} from '@openclaude/protocol'
import {
  containerPreviewTargetHash,
  verifyContainerPreviewAssertion,
} from '@openclaude/protocol/containerPreviewAuth'
import { type RawData, WebSocket, WebSocketServer } from 'ws'

const MAX_CONTROL_BYTES = 64 * 1024
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024
const OPEN_TIMEOUT_MS = 5_000
const INITIALIZATION_TIMEOUT_MS = 30_000
const HARD_TIMEOUT_MS = 15 * 60_000
const IDLE_TIMEOUT_MS = 3 * 60_000
const PROBE_TIMEOUT_MS = 8_000
const PROBE_MAX_REDIRECTS = 5
const PROBE_SNIFF_BYTES = 64 * 1024
const MOTION_FRAME_INTERVAL_MS = 84
const SETTLED_SCREENSHOT_MS = 190
const CLEANUP_TIMEOUT_MS = 2_000
const DIRECT_MAX_HTML_BYTES = 4 * 1024 * 1024
const DIRECT_MAX_REQUEST_BYTES = 16 * 1024 * 1024
const DIRECT_CONNECT_TIMEOUT_MS = 5_000
const DIRECT_IDLE_TIMEOUT_MS = 60_000
const DIRECT_ASSERTION_CACHE_CAP = 4_096

export interface ContainerPreviewLog {
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>, err?: unknown): void
}

const NOOP_LOG: ContainerPreviewLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

interface BrowserLike {
  newContext(options: Record<string, unknown>): Promise<BrowserContextLike>
  close(): Promise<void>
  /** Synchronous best-effort SIGKILL seam used only after graceful cleanup times out. */
  forceClose?(): void
  on(event: string, handler: (...args: any[]) => void): void
}

interface BrowserServerLike {
  close(): Promise<void>
  kill(): Promise<void>
  process(): { kill(signal?: NodeJS.Signals): boolean }
  wsEndpoint(): string
}

interface BrowserContextLike {
  route(pattern: string | RegExp, handler: (route: any) => void | Promise<void>): Promise<void>
  routeWebSocket?: (
    pattern: string | RegExp,
    handler: (route: any) => void | Promise<void>,
  ) => Promise<void>
  addInitScript(script: string | (() => void)): Promise<void>
  newPage(): Promise<PageLike>
  newCDPSession(page: PageLike): Promise<CdpSessionLike>
  close(): Promise<void>
  on(event: string, handler: (...args: any[]) => void): void
}

interface PageLike {
  mouse: {
    move(x: number, y: number): Promise<void>
    down(options?: Record<string, unknown>): Promise<void>
    up(options?: Record<string, unknown>): Promise<void>
    click(x: number, y: number, options?: Record<string, unknown>): Promise<void>
    wheel(deltaX: number, deltaY: number): Promise<void>
  }
  keyboard: {
    press(key: string): Promise<void>
    insertText(text: string): Promise<void>
  }
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>
  goBack(options?: Record<string, unknown>): Promise<unknown>
  goForward(options?: Record<string, unknown>): Promise<unknown>
  reload(options?: Record<string, unknown>): Promise<unknown>
  title(): Promise<string>
  url(): string
  evaluate<R>(fn: (arg: any) => R, arg: any): Promise<R>
  screenshot(options: Record<string, unknown>): Promise<Buffer>
  setViewportSize(viewport: { width: number; height: number }): Promise<void>
  close(): Promise<void>
  on(event: string, handler: (...args: any[]) => void): void
  isClosed(): boolean
  mainFrame(): unknown
}

interface CdpSessionLike {
  send(method: string, params?: Record<string, unknown>): Promise<any>
  on(event: string, handler: (params: any) => void): void
  detach(): Promise<void>
}

export interface ContainerPreviewBrowserLauncher {
  launch(): Promise<BrowserLike>
}

export function createPlaywrightContainerPreviewLauncher(
  packageJsonPath?: string,
): ContainerPreviewBrowserLauncher {
  return {
    async launch(): Promise<BrowserLike> {
      const requireFromMcp = createRequire(resolvePlaywrightMcpPackageJson(packageJsonPath))
      const playwright = requireFromMcp('playwright') as {
        chromium?: {
          launchServer(options: Record<string, unknown>): Promise<BrowserServerLike>
          connect(endpoint: string, options?: Record<string, unknown>): Promise<BrowserLike>
        }
      }
      if (!playwright.chromium?.launchServer || !playwright.chromium.connect)
        throw new Error('Playwright Chromium is unavailable')
      const server = await playwright.chromium.launchServer({
        headless: true,
        host: '127.0.0.1',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-background-networking',
          '--disable-component-update',
          '--disable-default-apps',
          '--disable-extensions',
          '--disable-features=Translate,MediaRouter,OptimizationHints',
          '--disable-sync',
          '--metrics-recording-only',
          '--no-first-run',
          '--password-store=basic',
          '--use-mock-keychain',
        ],
      })
      let browser: BrowserLike
      try {
        browser = await playwright.chromium.connect(server.wsEndpoint(), { timeout: 5_000 })
      } catch (err) {
        forceKillBrowserServer(server)
        throw err
      }
      let closePromise: Promise<void> | null = null
      return {
        newContext: (options) => browser.newContext(options),
        on: (event, handler) => browser.on(event, handler),
        close(): Promise<void> {
          closePromise ??= (async () => {
            try {
              await browser.close()
            } finally {
              await server.close()
            }
          })()
          return closePromise
        },
        forceClose: () => forceKillBrowserServer(server),
      }
    },
  }
}

function forceKillBrowserServer(server: BrowserServerLike): void {
  try {
    server.process().kill('SIGKILL')
  } catch {}
  void server.kill().catch(() => {})
}

export function resolvePlaywrightMcpPackageJson(explicit?: string): string {
  const configured = explicit?.trim() || process.env.OPENCLAUDE_PLAYWRIGHT_MCP_PACKAGE_JSON?.trim()
  if (configured) {
    if (!existsSync(configured)) throw new Error('configured Playwright MCP package is unavailable')
    return configured
  }
  const candidates = [
    '/usr/lib/node_modules/@playwright/mcp/package.json',
    '/usr/local/lib/node_modules/@playwright/mcp/package.json',
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) throw new Error('Playwright MCP package is unavailable')
  return found
}

export interface ContainerPreviewHandlerOptions {
  env?: NodeJS.ProcessEnv
  launcher?: ContainerPreviewBrowserLauncher
  log?: ContainerPreviewLog
  now?: () => number
  hardTimeoutMs?: number
  idleTimeoutMs?: number
  cleanupTimeoutMs?: number
}

export interface AcceptedContainerPreviewAssertion {
  sessionId: string
  targetHash: string
  expiresAt: number
}

export function verifyContainerPreviewUpgrade(
  req: Pick<IncomingMessage, 'headers' | 'socket'>,
  env: NodeJS.ProcessEnv,
  now: number = Date.now(),
): AcceptedContainerPreviewAssertion {
  const trustIp = env.OPENCLAUDE_TRUST_BRIDGE_IP?.trim() ?? ''
  if (!isIPv4(trustIp)) throw new Error('trusted bridge IP unavailable')
  const remote = req.socket.remoteAddress ?? ''
  if (remote !== trustIp && remote !== `::ffff:${trustIp}`) throw new Error('wrong bridge source')

  const rawHeader = req.headers[CONTAINER_PREVIEW_ASSERTION_HEADER]
  if (typeof rawHeader !== 'string') throw new Error('missing assertion')
  const keyring = parseAuthorityKeyring(env.OC_MODEL_AUTHORITY_KEYRING)
  const payload = verifyContainerPreviewAssertion(rawHeader, keyring, now)

  const uid = parsePositiveSafeInteger(env.OC_USER_ID)
  const containerId = parsePositiveSafeInteger(env.OC_CONTAINER_ID)
  if (uid === null || containerId === null) throw new Error('container identity unavailable')
  if (payload.uid !== uid || payload.containerId !== containerId)
    throw new Error('assertion identity mismatch')
  return {
    sessionId: payload.sessionId,
    targetHash: payload.targetHash,
    expiresAt: payload.expiresAt,
  }
}

export class ContainerPreviewHandler {
  private readonly env: NodeJS.ProcessEnv
  private readonly launcher: ContainerPreviewBrowserLauncher
  private readonly log: ContainerPreviewLog
  private readonly now: () => number
  private readonly hardTimeoutMs: number
  private readonly idleTimeoutMs: number
  private readonly cleanupTimeoutMs: number
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_CONTROL_BYTES,
    perMessageDeflate: false,
  })
  private readonly consumedAssertions = new Map<string, number>()
  private active: PreviewSession | null = null
  private shuttingDown = false

  constructor(options: ContainerPreviewHandlerOptions = {}) {
    this.env = options.env ?? process.env
    this.launcher = options.launcher ?? createPlaywrightContainerPreviewLauncher()
    this.log = options.log ?? NOOP_LOG
    this.now = options.now ?? Date.now
    this.hardTimeoutMs = options.hardTimeoutMs ?? HARD_TIMEOUT_MS
    this.idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? CLEANUP_TIMEOUT_MS
  }

  /** Authenticated master-only direct HTTP proxy into the signed loopback target. */
  handleHttp(req: IncomingMessage, res: ServerResponse): boolean {
    if (safePathname(req.url) !== CONTAINER_PREVIEW_DIRECT_PROXY_PATH) return false
    if (this.shuttingDown || this.env.OC_CONTAINER_PREVIEW_ENABLED?.trim() !== '1') {
      sendDirectText(res, 503, 'preview unavailable')
      return true
    }
    let target: AcceptedDirectPreviewTarget
    try {
      target = this.authorizeDirect(req)
    } catch (err) {
      this.log.warn('container_preview.direct_auth_rejected', {
        reason: err instanceof Error ? err.message : String(err),
      })
      sendDirectText(res, 401, 'unauthorized')
      return true
    }
    void proxyDirectHttp(req, res, target.url, this.log).catch((err) => {
      this.log.warn('container_preview.direct_http_failed', {
        reason: err instanceof Error ? err.message : String(err),
      })
      if (!res.headersSent) sendDirectText(res, 502, 'preview upstream unavailable')
      else if (!res.writableEnded) {
        try {
          res.destroy()
        } catch {}
      }
    })
    return true
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const pathname = safePathname(req.url)
    if (pathname === CONTAINER_PREVIEW_DIRECT_PROXY_PATH) {
      if (this.shuttingDown || this.env.OC_CONTAINER_PREVIEW_ENABLED?.trim() !== '1') {
        rejectUpgrade(socket, 503, 'preview unavailable')
        return true
      }
      let target: AcceptedDirectPreviewTarget
      try {
        target = this.authorizeDirect(req)
      } catch (err) {
        this.log.warn('container_preview.direct_ws_auth_rejected', {
          reason: err instanceof Error ? err.message : String(err),
        })
        rejectUpgrade(socket, 401, 'unauthorized')
        return true
      }
      proxyDirectUpgrade(req, socket, head, target.url, this.log)
      return true
    }
    if (pathname !== CONTAINER_PREVIEW_INTERNAL_WS_PATH) return false
    if (this.shuttingDown || this.env.OC_CONTAINER_PREVIEW_ENABLED?.trim() !== '1') {
      rejectUpgrade(socket, 503, 'preview unavailable')
      return true
    }

    let assertion: AcceptedContainerPreviewAssertion
    try {
      assertion = this.authorize(req)
    } catch (err) {
      this.log.warn('container_preview.auth_rejected', {
        reason: err instanceof Error ? err.message : String(err),
      })
      rejectUpgrade(socket, 401, 'unauthorized')
      return true
    }
    const previous = this.active
    // A fresh master-signed assertion may replace the current session (for
    // example desktop → mobile). A same-tick handshake reservation has no
    // close method and remains a hard conflict so two upgrades cannot race.
    if (previous && typeof previous.close !== 'function') {
      rejectUpgrade(socket, 409, 'preview connection already pending')
      return true
    }
    if (previous) void previous.close(1000, 'preview replaced')

    // Reserve before handleUpgrade so two same-tick upgrades cannot both pass.
    const reservation = {} as PreviewSession
    this.active = reservation
    try {
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        const session = new PreviewSession({
          ws,
          assertion,
          launcher: this.launcher,
          log: this.log,
          hardTimeoutMs: this.hardTimeoutMs,
          idleTimeoutMs: this.idleTimeoutMs,
          cleanupTimeoutMs: this.cleanupTimeoutMs,
          onFinalize: () => {
            if (this.active === session) this.active = null
          },
        })
        this.active = session
        session.start()
      })
    } catch (err) {
      if (this.active === reservation) this.active = null
      this.log.error('container_preview.upgrade_failed', undefined, err)
      try {
        socket.destroy()
      } catch {}
    }
    return true
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    const active = this.active
    if (active && typeof active.close === 'function') await active.close(1001, 'shutting down')
    this.active = null
    await new Promise<void>((resolve) => {
      try {
        this.wss.close(() => resolve())
      } catch {
        resolve()
      }
    })
  }

  activeCount(): number {
    return this.active && typeof this.active.close === 'function' ? 1 : 0
  }

  private authorize(req: IncomingMessage): AcceptedContainerPreviewAssertion {
    const assertion = verifyContainerPreviewUpgrade(req, this.env, this.now())
    this.pruneConsumed(this.now())
    if (this.consumedAssertions.has(assertion.sessionId)) throw new Error('assertion replayed')
    if (this.consumedAssertions.size >= DIRECT_ASSERTION_CACHE_CAP) {
      throw new Error('assertion replay cache at capacity')
    }
    // JS event-loop check+set is atomic; insert before any asynchronous work.
    this.consumedAssertions.set(assertion.sessionId, assertion.expiresAt)
    return assertion
  }

  private authorizeDirect(req: IncomingMessage): AcceptedDirectPreviewTarget {
    const assertion = this.authorize(req)
    const rawTarget = singleHeader(req.headers[CONTAINER_PREVIEW_TARGET_HEADER])
    const rawViewport = singleHeader(req.headers[CONTAINER_PREVIEW_VIEWPORT_HEADER])
    if (!rawTarget || rawTarget.length > 2_048 || !rawViewport || rawViewport.length > 256) {
      throw new Error('direct preview target missing')
    }
    let viewportValue: unknown
    try {
      viewportValue = JSON.parse(rawViewport)
    } catch {
      throw new Error('direct preview viewport invalid')
    }
    if (!isRecord(viewportValue)) throw new Error('direct preview viewport invalid')
    const target = normalizeContainerPreviewUrl(rawTarget)
    const viewport = normalizeContainerPreviewViewport(
      viewportValue as Partial<ContainerPreviewViewport>,
    )
    if (containerPreviewTargetHash(target.url, viewport) !== assertion.targetHash) {
      throw new Error('direct preview target hash mismatch')
    }
    return { url: target.url, viewport, assertion }
  }

  private pruneConsumed(now: number): void {
    for (const [sessionId, expiresAt] of this.consumedAssertions) {
      if (expiresAt <= now) this.consumedAssertions.delete(sessionId)
    }
    // Never evict a still-valid ID: doing so would turn the memory bound into
    // a replay window. authorize() rejects new assertions at the hard cap.
  }
}

interface AcceptedDirectPreviewTarget {
  url: string
  viewport: ContainerPreviewViewport
  assertion: AcceptedContainerPreviewAssertion
}

const DIRECT_HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const DIRECT_INTERNAL_HEADERS = new Set([
  CONTAINER_PREVIEW_ASSERTION_HEADER,
  CONTAINER_PREVIEW_TARGET_HEADER,
  CONTAINER_PREVIEW_VIEWPORT_HEADER,
  'authorization',
  'proxy-authorization',
  'x-oc-v5-secret',
])

function directTargetHeaders(
  incoming: IncomingHttpHeaders,
  target: URL,
  websocket: boolean,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(incoming)) {
    const lower = name.toLowerCase()
    if (value === undefined || DIRECT_INTERNAL_HEADERS.has(lower)) continue
    if (lower.startsWith('x-openclaude-') || lower.startsWith('x-oc-')) continue
    if (DIRECT_HOP_BY_HOP_HEADERS.has(lower) && !websocket) continue
    if (lower === 'host' || lower === 'origin' || lower === 'referer') continue
    if (lower === 'cookie') {
      const sanitized = stripReservedPreviewCookie(Array.isArray(value) ? value.join('; ') : value)
      if (sanitized) out.cookie = sanitized
      continue
    }
    if (Array.isArray(value)) {
      const safe = value.filter((entry) => !/[\r\n]/.test(entry))
      if (safe.length > 0) out[name] = safe
    } else if (!/[\r\n]/.test(value)) {
      out[name] = value
    }
  }
  out.host = target.host
  out['accept-encoding'] = 'identity'
  if (incoming.origin) out.origin = target.origin
  if (incoming.referer) out.referer = `${target.origin}/`
  if (websocket) {
    out.connection = 'Upgrade'
    out.upgrade = 'websocket'
  }
  return out
}

function stripReservedPreviewCookie(raw: string): string {
  return raw
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part && part.split('=', 1)[0] !== CONTAINER_PREVIEW_DIRECT_COOKIE)
    .join('; ')
}

function directResponseHeaders(
  incoming: IncomingHttpHeaders,
  injectedLength?: number,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue
    const lower = name.toLowerCase()
    if (DIRECT_HOP_BY_HOP_HEADERS.has(lower)) continue
    if (lower.startsWith('x-openclaude-') || lower.startsWith('x-oc-')) continue
    if (
      injectedLength !== undefined &&
      ['content-length', 'content-encoding', 'etag', 'content-md5', 'digest'].includes(lower)
    ) {
      continue
    }
    out[name] = value
  }
  if (injectedLength !== undefined) out['content-length'] = String(injectedLength)
  return out
}

async function proxyDirectHttp(
  req: IncomingMessage,
  res: ServerResponse,
  canonicalTarget: string,
  log: ContainerPreviewLog,
): Promise<void> {
  const target = new URL(canonicalTarget)
  const contentLength = Number.parseInt(singleHeader(req.headers['content-length']) ?? '0', 10)
  if (Number.isFinite(contentLength) && contentLength > DIRECT_MAX_REQUEST_BYTES) {
    sendDirectText(res, 413, 'request too large')
    return
  }
  const requestImpl = target.protocol === 'https:' ? httpsRequest : httpRequest
  await new Promise<void>((resolve) => {
    let settled = false
    let requestBytes = 0
    let requestTooLarge = false
    const finish = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    const upstream = requestImpl({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      method: req.method ?? 'GET',
      path: target.pathname + target.search,
      headers: directTargetHeaders(req.headers, target, false),
      family: target.hostname === '::1' ? 6 : 4,
      rejectUnauthorized: false,
      timeout: DIRECT_CONNECT_TIMEOUT_MS,
    })
    let responseStream: IncomingMessage | null = null
    res.once('close', () => {
      upstream.destroy()
      responseStream?.destroy()
      finish()
    })
    upstream.on('timeout', () => upstream.destroy(new Error('direct preview connect timeout')))
    upstream.on('error', (err) => {
      if (requestTooLarge) {
        finish()
        return
      }
      log.warn('container_preview.direct_target_error', { reason: err.message })
      if (!res.headersSent) sendDirectText(res, 502, 'preview target unavailable')
      else if (!res.writableEnded) {
        try {
          res.destroy()
        } catch {}
      }
      finish()
    })
    upstream.on('response', (response) => {
      responseStream = response
      response.setTimeout(DIRECT_IDLE_TIMEOUT_MS, () => response.destroy())
      const contentType = String(response.headers['content-type'] ?? '').toLowerCase()
      const contentEncoding = String(
        response.headers['content-encoding'] ?? 'identity',
      ).toLowerCase()
      const html =
        contentType.includes('text/html') &&
        (contentEncoding === '' || contentEncoding === 'identity')
      if (!html || (req.method ?? 'GET') === 'HEAD') {
        res.writeHead(response.statusCode ?? 502, directResponseHeaders(response.headers))
        response.pipe(res)
        response.once('end', finish)
        response.once('close', () => {
          if (!response.complete && !res.writableEnded) {
            try {
              res.destroy()
            } catch {}
          }
          finish()
        })
        response.once('error', () => {
          if (!res.writableEnded) {
            try {
              res.destroy()
            } catch {}
          }
          finish()
        })
        return
      }
      const chunks: Buffer[] = []
      let total = 0
      let overflow = false
      response.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > DIRECT_MAX_HTML_BYTES) {
          overflow = true
          response.destroy()
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        if (overflow) return
        const body = injectDirectPreviewBridge(Buffer.concat(chunks, total))
        res.writeHead(
          response.statusCode ?? 502,
          directResponseHeaders(response.headers, body.length),
        )
        res.end(body)
        finish()
      })
      response.on('close', () => {
        if (overflow) {
          if (!res.headersSent) sendDirectText(res, 502, 'preview HTML is too large')
        } else if (!response.complete) {
          if (!res.headersSent) sendDirectText(res, 502, 'preview target response failed')
          else if (!res.writableEnded) {
            try {
              res.destroy()
            } catch {}
          }
        }
        finish()
      })
      response.on('error', () => {
        if (!res.headersSent) sendDirectText(res, 502, 'preview target response failed')
        finish()
      })
    })
    req.on('data', (chunk: Buffer) => {
      if (requestTooLarge) return
      requestBytes += chunk.length
      if (requestBytes > DIRECT_MAX_REQUEST_BYTES) {
        requestTooLarge = true
        upstream.destroy(new Error('direct preview request too large'))
        if (!res.headersSent) sendDirectText(res, 413, 'request too large')
        finish()
        return
      }
      if (!upstream.destroyed) upstream.write(chunk)
    })
    req.once('end', () => {
      if (!upstream.destroyed) upstream.end()
    })
    req.once('aborted', () => upstream.destroy())
    req.once('error', () => upstream.destroy())
  })
}

function injectDirectPreviewBridge(body: Buffer): Buffer {
  const html = body.toString('utf8')
  const tag = `<script src="${CONTAINER_PREVIEW_DIRECT_BRIDGE_PATH}" defer></script>`
  const headEnd = html.toLowerCase().indexOf('</head>')
  const injected =
    headEnd >= 0 ? `${html.slice(0, headEnd)}${tag}${html.slice(headEnd)}` : `${tag}${html}`
  return Buffer.from(injected, 'utf8')
}

function proxyDirectUpgrade(
  req: IncomingMessage,
  browserSocket: Duplex,
  browserHead: Buffer,
  canonicalTarget: string,
  log: ContainerPreviewLog,
): void {
  if ((req.method ?? 'GET') !== 'GET') {
    rejectUpgrade(browserSocket, 405, 'method not allowed')
    return
  }
  const target = new URL(canonicalTarget)
  const requestImpl = target.protocol === 'https:' ? httpsRequest : httpRequest
  let upgraded = false
  const upstream = requestImpl({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || undefined,
    method: 'GET',
    path: target.pathname + target.search,
    headers: directTargetHeaders(req.headers, target, true),
    family: target.hostname === '::1' ? 6 : 4,
    rejectUnauthorized: false,
    timeout: DIRECT_CONNECT_TIMEOUT_MS,
  })
  const fail = (reason: string): void => {
    if (upgraded) return
    log.warn('container_preview.direct_target_ws_failed', { reason })
    rejectUpgrade(browserSocket, 502, 'preview websocket unavailable')
    try {
      upstream.destroy()
    } catch {}
  }
  upstream.on('timeout', () => fail('timeout'))
  upstream.on('error', (err) => fail(err.message))
  upstream.on('response', (response) => {
    response.resume()
    fail(`unexpected status ${response.statusCode ?? 0}`)
  })
  upstream.on('upgrade', (response, targetSocket, targetHead) => {
    if (response.statusCode !== 101) {
      try {
        targetSocket.destroy()
      } catch {}
      fail(`unexpected upgrade status ${response.statusCode ?? 0}`)
      return
    }
    upgraded = true
    const lines = ['HTTP/1.1 101 Switching Protocols']
    for (let index = 0; index + 1 < response.rawHeaders.length; index += 2) {
      const name = response.rawHeaders[index]!
      const value = response.rawHeaders[index + 1]!
      if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) continue
      const lower = name.toLowerCase()
      if (lower.startsWith('x-openclaude-') || lower.startsWith('x-oc-')) continue
      lines.push(`${name}: ${value}`)
    }
    lines.push('', '')
    try {
      browserSocket.write(lines.join('\r\n'))
      if (targetHead.length > 0) browserSocket.write(targetHead)
      if (browserHead.length > 0) targetSocket.write(browserHead)
      browserSocket.pipe(targetSocket)
      targetSocket.pipe(browserSocket)
    } catch {
      try {
        browserSocket.destroy()
      } catch {}
      try {
        targetSocket.destroy()
      } catch {}
    }
    browserSocket.once('close', () => targetSocket.destroy())
    browserSocket.once('error', () => targetSocket.destroy())
    targetSocket.once('close', () => browserSocket.destroy())
    targetSocket.once('error', () => browserSocket.destroy())
  })
  browserSocket.once('close', () => upstream.destroy())
  browserSocket.once('error', () => upstream.destroy())
  upstream.end()
}

function sendDirectText(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent || res.writableEnded) return
  const body = Buffer.from(message, 'utf8')
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function singleHeader(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null
}

interface PreviewSessionOptions {
  ws: WebSocket
  assertion: AcceptedContainerPreviewAssertion
  launcher: ContainerPreviewBrowserLauncher
  log: ContainerPreviewLog
  hardTimeoutMs: number
  idleTimeoutMs: number
  cleanupTimeoutMs: number
  onFinalize(): void
}

class PreviewSession {
  private browser: BrowserLike | null = null
  private context: BrowserContextLike | null = null
  private page: PageLike | null = null
  private cdp: CdpSessionLike | null = null
  private viewport: ContainerPreviewViewport | null = null
  private pinnedOrigin = ''
  private pageRevision = 0
  private frameSequence = 0
  private finalized = false
  private finalizePromise: Promise<void> | null = null
  private opened = false
  private interactionChain: Promise<void> = Promise.resolve()
  private openTimer: ReturnType<typeof setTimeout> | null = null
  private initializationTimer: ReturnType<typeof setTimeout> | null = null
  private hardTimer: ReturnType<typeof setTimeout> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private settledTimer: ReturnType<typeof setTimeout> | null = null
  private motionTimer: ReturnType<typeof setTimeout> | null = null
  private drainTimer: ReturnType<typeof setTimeout> | null = null
  private lastMotionSentAt = 0
  private pendingMotion: Buffer | null = null
  private pendingBinary: { jpeg: Buffer; highQuality: boolean } | null = null
  private screenshotInFlight = false
  private screenshotAgain = false

  constructor(private readonly options: PreviewSessionOptions) {}

  start(): void {
    const { ws } = this.options
    this.openTimer = setTimeout(() => {
      this.sendError('OPEN_TIMEOUT', '预览连接初始化超时，请重试', true)
      void this.close(1008, 'open timeout')
    }, OPEN_TIMEOUT_MS)
    this.hardTimer = setTimeout(() => {
      this.sendError('SESSION_EXPIRED', '预览已运行 15 分钟，请重新打开', true)
      void this.close(1000, 'session expired')
    }, this.options.hardTimeoutMs)
    this.touchIdle()

    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        this.sendError('BAD_MESSAGE', '不支持的二进制控制消息', false)
        void this.close(1008, 'bad message')
        return
      }
      this.onText(raw)
    })
    ws.once('close', () => void this.finalize())
    ws.once('error', (err) => {
      this.options.log.warn('container_preview.client_socket_error', { error: err.message })
      void this.finalize()
    })
    this.send({ type: 'preview.status', status: 'connecting' })
  }

  async close(code = 1000, reason = 'closed'): Promise<void> {
    if (this.options.ws.readyState === WebSocket.OPEN) {
      try {
        this.options.ws.close(code, reason)
      } catch {}
    }
    await this.finalize()
  }

  private onText(raw: RawData): void {
    const text = raw.toString()
    if (Buffer.byteLength(text, 'utf8') > MAX_CONTROL_BYTES) {
      this.sendError('BAD_MESSAGE', '控制消息过大', false)
      void this.close(1009, 'message too large')
      return
    }
    let message: unknown
    try {
      message = JSON.parse(text)
    } catch {
      this.sendError('BAD_MESSAGE', '控制消息格式错误', false)
      return
    }

    if (!this.opened) {
      this.opened = true
      if (this.openTimer) clearTimeout(this.openTimer)
      this.openTimer = null
      this.initializationTimer = setTimeout(() => {
        this.sendError('INITIALIZATION_TIMEOUT', '网页预览启动超时，请重试', true)
        void this.close(1011, 'initialization timeout')
      }, INITIALIZATION_TIMEOUT_MS)
      void this.open(message).catch((err) => {
        if (this.finalized) return
        this.options.log.warn('container_preview.open_failed', {
          error: err instanceof Error ? err.message : String(err),
        })
        this.sendError('OPEN_FAILED', userSafeOpenError(err), true)
        void this.close(1011, 'open failed')
      })
      return
    }

    this.touchIdle()
    this.interactionChain = this.interactionChain
      .then(() => this.handleControl(message))
      .catch((err) => {
        this.options.log.warn('container_preview.control_failed', {
          error: err instanceof Error ? err.message : String(err),
        })
        this.sendError('INTERACTION_FAILED', '网页操作失败，请重试', true)
      })
  }

  private async open(value: unknown): Promise<void> {
    const message = parseOpenMessage(value)
    const normalized = normalizeContainerPreviewUrl(message.url)
    const viewport = normalizeContainerPreviewViewport(message.viewport)
    if (
      containerPreviewTargetHash(normalized.url, viewport) !== this.options.assertion.targetHash
    ) {
      throw new Error('signed preview target mismatch')
    }
    this.viewport = viewport
    this.pinnedOrigin = normalized.origin

    this.send({ type: 'preview.status', status: 'probing' })
    await probeHtmlApplication(normalized.url, normalized.origin)
    if (this.finalized) return

    this.send({ type: 'preview.status', status: 'launching' })
    const browser = await this.options.launcher.launch()
    if (this.finalized) {
      await disposePreviewResources({ browser }, this.options.cleanupTimeoutMs, this.options.log)
      return
    }
    this.browser = browser
    this.browser.on('disconnected', () => {
      if (!this.finalized) {
        this.sendError('BROWSER_CRASHED', '预览浏览器已退出，请重试', true)
        void this.close(1011, 'browser disconnected')
      }
    })
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.deviceScaleFactor,
      isMobile: viewport.isMobile,
      hasTouch: viewport.isMobile,
      ignoreHTTPSErrors: true,
      acceptDownloads: false,
      serviceWorkers: 'block',
      locale: 'zh-CN',
    })
    if (this.finalized) {
      await disposePreviewResources(
        { browser, context },
        this.options.cleanupTimeoutMs,
        this.options.log,
      )
      return
    }
    this.context = context

    await this.installNetworkBoundary(context)
    await context.addInitScript(`Object.defineProperty(window, 'open', { value: () => null })`)
    const page = await context.newPage()
    if (this.finalized) {
      await disposePreviewResources(
        { browser, context, page },
        this.options.cleanupTimeoutMs,
        this.options.log,
      )
      return
    }
    this.page = page
    page.on('close', () => {
      if (!this.finalized) void this.close(1000, 'page closed')
    })
    context.on('page', (candidate: PageLike) => {
      if (candidate !== page) void candidate.close().catch(() => {})
    })
    page.on('framenavigated', (frame: unknown) => {
      if (frame === page.mainFrame()) {
        this.pageRevision = (this.pageRevision + 1) >>> 0
        void this.sendNavigation()
      }
    })

    const cdp = await context.newCDPSession(page)
    if (this.finalized) {
      await disposePreviewResources(
        { browser, context, page, cdp },
        this.options.cleanupTimeoutMs,
        this.options.log,
      )
      return
    }
    this.cdp = cdp
    cdp.on('Page.screencastFrame', (event) => this.onScreencastFrame(event))
    cdp.on('Inspector.detached', () => {
      if (!this.finalized) {
        this.sendError('BROWSER_CRASHED', '预览画面连接已中断，请重试', true)
        void this.close(1011, 'CDP detached')
      }
    })
    await cdp.send('Page.enable')
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 70,
      maxWidth: viewport.width,
      maxHeight: viewport.height,
      // Chromium's compositor can emit 40-60 JPEGs/s. Sampling every third
      // frame keeps motion near 12-15 fps before our latest-only transport
      // limiter, avoiding needless CPU burn inside the user's 1-vCPU cgroup.
      everyNthFrame: 3,
    })

    this.send({ type: 'preview.status', status: 'loading' })
    await page.goto(normalized.url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
    if (this.finalized) return
    const title = bounded(await page.title(), 256)
    if (this.finalized) return
    if (this.initializationTimer) clearTimeout(this.initializationTimer)
    this.initializationTimer = null
    this.send({
      type: 'preview.ready',
      protocolVersion: CONTAINER_PREVIEW_PROTOCOL_VERSION,
      url: page.url(),
      title,
      viewport,
    })
    this.scheduleSettledScreenshot()
  }

  private async installNetworkBoundary(context: BrowserContextLike): Promise<void> {
    await context.route('**/*', async (route: any) => {
      const request = route.request()
      const url = String(request.url())
      const navigationAllowed =
        typeof request.isNavigationRequest !== 'function' ||
        !request.isNavigationRequest() ||
        isAllowedContainerPreviewNavigation(url, this.pinnedOrigin)
      if (!navigationAllowed || !isAllowedContainerPreviewHttpRequest(url, this.pinnedOrigin)) {
        await route.abort('blockedbyclient')
        return
      }
      await route.continue()
    })
    if (typeof context.routeWebSocket !== 'function') {
      throw new Error('runtime does not support fail-closed WebSocket routing')
    }
    await context.routeWebSocket(/.*/, async (route: any) => {
      const url = String(route.url())
      if (!isAllowedContainerPreviewWebSocket(url, this.pinnedOrigin)) {
        await route.close({ code: 1008, reason: 'local origin blocked' })
        return
      }
      route.connectToServer()
    })
  }

  private onScreencastFrame(event: { data?: unknown; sessionId?: unknown }): void {
    const cdp = this.cdp
    const sessionId = typeof event.sessionId === 'number' ? event.sessionId : null
    // ACK first. Frame decoding/rate limiting must never stall Chromium's CDP producer.
    if (cdp && sessionId !== null)
      void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
    if (typeof event.data !== 'string' || this.finalized) return
    const jpeg = Buffer.from(event.data, 'base64')
    const now = Date.now()
    const wait = MOTION_FRAME_INTERVAL_MS - (now - this.lastMotionSentAt)
    if (wait <= 0) {
      this.lastMotionSentAt = now
      this.queueBinary(jpeg, false)
      return
    }
    this.pendingMotion = jpeg
    if (this.motionTimer) return
    this.motionTimer = setTimeout(() => {
      this.motionTimer = null
      const pending = this.pendingMotion
      this.pendingMotion = null
      if (!pending || this.finalized) return
      this.lastMotionSentAt = Date.now()
      this.queueBinary(pending, false)
    }, wait)
  }

  private async handleControl(value: unknown): Promise<void> {
    const message = parseControlMessage(value)
    const page = this.page
    const viewport = this.viewport
    if (!page || !viewport || page.isClosed()) throw new Error('page is not ready')

    switch (message.type) {
      case 'preview.pointer': {
        const x = clampCoordinate(message.x, viewport.width)
        const y = clampCoordinate(message.y, viewport.height)
        const button = message.button ?? 'left'
        if (message.action === 'move') await page.mouse.move(x, y)
        else if (message.action === 'down') {
          await page.mouse.move(x, y)
          await page.mouse.down({ button })
        } else if (message.action === 'up') {
          await page.mouse.move(x, y)
          await page.mouse.up({ button })
        } else await page.mouse.click(x, y, { button })
        this.scheduleSettledScreenshot()
        return
      }
      case 'preview.wheel':
        await page.mouse.wheel(clampDelta(message.deltaX), clampDelta(message.deltaY))
        this.scheduleSettledScreenshot()
        return
      case 'preview.key':
        await page.keyboard.press(message.key)
        this.scheduleSettledScreenshot()
        return
      case 'preview.text':
        await page.keyboard.insertText(message.text)
        this.scheduleSettledScreenshot()
        return
      case 'preview.navigate':
        if (message.action === 'back')
          await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10_000 })
        else if (message.action === 'forward')
          await page.goForward({ waitUntil: 'domcontentloaded', timeout: 10_000 })
        else await page.reload({ waitUntil: 'domcontentloaded', timeout: 10_000 })
        this.scheduleSettledScreenshot()
        return
      case 'preview.select': {
        const target = await inspectElementAtPoint(
          page,
          clampCoordinate(message.x, viewport.width),
          clampCoordinate(message.y, viewport.height),
        )
        this.send({ type: 'preview.selection', target })
        return
      }
      case 'preview.resolve': {
        const target = await resolveElement(page, message.selector)
        this.send({ type: 'preview.resolved', selector: message.selector, target })
        return
      }
      case 'preview.resize': {
        const next = normalizeContainerPreviewViewport(message.viewport)
        if (
          next.deviceScaleFactor !== viewport.deviceScaleFactor ||
          next.isMobile !== viewport.isMobile
        ) {
          this.sendError('RECONNECT_REQUIRED', '切换设备模式需要重新载入预览', true)
          return
        }
        this.viewport = next
        await page.setViewportSize({ width: next.width, height: next.height })
        this.scheduleSettledScreenshot()
        return
      }
      case 'preview.close':
        await this.close(1000, 'client close')
        return
    }
  }

  private scheduleSettledScreenshot(): void {
    if (this.settledTimer) clearTimeout(this.settledTimer)
    this.settledTimer = setTimeout(() => {
      this.settledTimer = null
      void this.captureSettledScreenshot()
    }, SETTLED_SCREENSHOT_MS)
  }

  private async captureSettledScreenshot(): Promise<void> {
    if (this.screenshotInFlight) {
      this.screenshotAgain = true
      return
    }
    const page = this.page
    if (!page || page.isClosed() || this.finalized) return
    this.screenshotInFlight = true
    try {
      const jpeg = await page.screenshot({
        type: 'jpeg',
        quality: 82,
        scale: 'device',
        animations: 'allow',
      })
      this.queueBinary(Buffer.from(jpeg), true)
    } catch (err) {
      if (!this.finalized)
        this.options.log.warn('container_preview.screenshot_failed', {
          error: err instanceof Error ? err.message : String(err),
        })
    } finally {
      this.screenshotInFlight = false
      if (this.screenshotAgain && !this.finalized) {
        this.screenshotAgain = false
        this.scheduleSettledScreenshot()
      }
    }
  }

  private queueBinary(jpeg: Buffer, highQuality: boolean): void {
    if (this.finalized || this.options.ws.readyState !== WebSocket.OPEN) return
    if (this.options.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.pendingBinary = { jpeg, highQuality }
      this.scheduleDrain()
      return
    }
    this.sendBinaryNow(jpeg, highQuality)
  }

  private sendBinaryNow(jpeg: Buffer, highQuality: boolean): void {
    if (
      jpeg.byteLength + CONTAINER_PREVIEW_BINARY_HEADER_BYTES >
      CONTAINER_PREVIEW_MAX_BINARY_FRAME_BYTES
    ) {
      this.sendError('FRAME_TOO_LARGE', '网页画面超过安全上限，请缩小页面尺寸后重试', true)
      void this.close(1009, 'frame too large')
      return
    }
    const dimensions = readJpegDimensions(jpeg)
    const viewport = this.viewport
    if (!dimensions && !viewport) return
    const packet = encodeContainerPreviewFrame(
      {
        highQuality,
        pageRevision: this.pageRevision >>> 0,
        frameSequence: (this.frameSequence = (this.frameSequence + 1) >>> 0),
        pixelWidth: dimensions?.width ?? viewport!.width,
        pixelHeight: dimensions?.height ?? viewport!.height,
      },
      jpeg,
    )
    try {
      this.options.ws.send(packet, { binary: true })
    } catch {}
  }

  private scheduleDrain(): void {
    if (this.drainTimer || this.finalized) return
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null
      if (this.options.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        this.scheduleDrain()
        return
      }
      const pending = this.pendingBinary
      this.pendingBinary = null
      if (pending) this.sendBinaryNow(pending.jpeg, pending.highQuality)
    }, 25)
  }

  private async sendNavigation(): Promise<void> {
    const page = this.page
    if (!page || page.isClosed()) return
    try {
      this.send({
        type: 'preview.navigation',
        url: bounded(page.url(), 2_048),
        title: bounded(await page.title(), 256),
        pageRevision: this.pageRevision,
      })
      this.scheduleSettledScreenshot()
    } catch {}
  }

  private send(message: ContainerPreviewServerMessage): void {
    if (this.options.ws.readyState !== WebSocket.OPEN) return
    try {
      this.options.ws.send(JSON.stringify(message))
    } catch {}
  }

  private sendError(code: string, message: string, retryable: boolean): void {
    this.send({ type: 'preview.error', code, message, retryable })
  }

  private touchIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.sendError('IDLE_TIMEOUT', '预览长时间未操作，已自动关闭', true)
      void this.close(1000, 'idle timeout')
    }, this.options.idleTimeoutMs)
  }

  private finalize(): Promise<void> {
    if (this.finalizePromise) return this.finalizePromise
    this.finalized = true
    for (const timer of [
      this.openTimer,
      this.initializationTimer,
      this.hardTimer,
      this.idleTimer,
      this.settledTimer,
      this.motionTimer,
      this.drainTimer,
    ])
      if (timer) clearTimeout(timer)
    this.pendingMotion = null
    this.pendingBinary = null
    const resources: PreviewResources = {
      cdp: this.cdp,
      page: this.page,
      context: this.context,
      browser: this.browser,
    }
    this.cdp = null
    this.page = null
    this.context = null
    this.browser = null
    this.finalizePromise = (async () => {
      try {
        await disposePreviewResources(resources, this.options.cleanupTimeoutMs, this.options.log)
      } finally {
        this.options.onFinalize()
      }
    })()
    return this.finalizePromise
  }
}

interface PreviewResources {
  browser?: BrowserLike | null
  context?: BrowserContextLike | null
  page?: PageLike | null
  cdp?: CdpSessionLike | null
}

async function disposePreviewResources(
  resources: PreviewResources,
  timeoutMs: number,
  log: ContainerPreviewLog,
): Promise<void> {
  const cleanup = (async () => {
    try {
      if (resources.cdp) await resources.cdp.send('Page.stopScreencast')
    } catch {}
    try {
      if (resources.cdp) await resources.cdp.detach()
    } catch {}
    try {
      if (resources.page && !resources.page.isClosed()) await resources.page.close()
    } catch {}
    try {
      if (resources.context) await resources.context.close()
    } catch {}
    try {
      if (resources.browser) await resources.browser.close()
    } catch {}
  })()
  let timeout: ReturnType<typeof setTimeout> | null = null
  const completed = await Promise.race([
    cleanup.then(() => true),
    new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), Math.max(1, timeoutMs))
    }),
  ])
  if (timeout) clearTimeout(timeout)
  if (!completed) {
    log.warn('container_preview.cleanup_timeout', { timeoutMs })
    try {
      resources.browser?.forceClose?.()
    } catch {}
  }
}

function parseOpenMessage(value: unknown): ContainerPreviewOpenMessage {
  if (
    !isRecord(value) ||
    value.type !== 'preview.open' ||
    value.protocolVersion !== CONTAINER_PREVIEW_PROTOCOL_VERSION
  ) {
    throw new Error('first message must be preview.open v1')
  }
  if (typeof value.url !== 'string' || !isRecord(value.viewport))
    throw new Error('preview target missing')
  return {
    type: 'preview.open',
    protocolVersion: CONTAINER_PREVIEW_PROTOCOL_VERSION,
    url: value.url,
    viewport: normalizeContainerPreviewViewport(
      value.viewport as Partial<ContainerPreviewViewport>,
    ),
  }
}

function parseControlMessage(value: unknown): ContainerPreviewClientMessage {
  if (!isRecord(value) || typeof value.type !== 'string') throw new Error('bad control message')
  switch (value.type) {
    case 'preview.pointer': {
      if (!['move', 'down', 'up', 'click'].includes(String(value.action)))
        throw new Error('bad pointer action')
      if (!finite(value.x) || !finite(value.y)) throw new Error('bad pointer coordinates')
      const button = value.button === undefined ? undefined : String(value.button)
      if (button !== undefined && !['left', 'middle', 'right'].includes(button))
        throw new Error('bad pointer button')
      return {
        type: value.type,
        action: value.action as any,
        x: value.x,
        y: value.y,
        ...(button ? { button: button as any } : {}),
      }
    }
    case 'preview.wheel':
      if (!finite(value.deltaX) || !finite(value.deltaY)) throw new Error('bad wheel delta')
      return { type: value.type, deltaX: value.deltaX, deltaY: value.deltaY }
    case 'preview.key':
      if (
        typeof value.key !== 'string' ||
        value.key.length < 1 ||
        value.key.length > 64 ||
        /[\r\n]/.test(value.key)
      ) {
        throw new Error('bad key')
      }
      return { type: value.type, key: value.key }
    case 'preview.text':
      if (typeof value.text !== 'string' || value.text.length > 2_000) throw new Error('bad text')
      return { type: value.type, text: value.text }
    case 'preview.select':
      if (!finite(value.x) || !finite(value.y)) throw new Error('bad select coordinates')
      return { type: value.type, x: value.x, y: value.y }
    case 'preview.resolve':
      if (
        typeof value.selector !== 'string' ||
        value.selector.length < 1 ||
        value.selector.length > 512
      ) {
        throw new Error('bad selector')
      }
      return { type: value.type, selector: value.selector }
    case 'preview.navigate':
      if (!['back', 'forward', 'reload'].includes(String(value.action)))
        throw new Error('bad navigation action')
      return { type: value.type, action: value.action as any }
    case 'preview.resize':
      if (!isRecord(value.viewport)) throw new Error('bad viewport')
      return {
        type: value.type,
        viewport: normalizeContainerPreviewViewport(
          value.viewport as Partial<ContainerPreviewViewport>,
        ),
      }
    case 'preview.close':
      return { type: value.type }
    default:
      throw new Error('unknown control message')
  }
}

async function inspectElementAtPoint(
  page: PageLike,
  x: number,
  y: number,
): Promise<ContainerPreviewElementTarget | null> {
  return page.evaluate(
    ({ x, y }) => {
      const element = document.elementFromPoint(x, y) as HTMLElement | null
      if (!element) return null
      // Keep this page-context body free of locally declared helper functions.
      // The gateway runs through tsx/esbuild, whose keep-names transform can
      // otherwise serialize an injected `__name(...)` reference that does not
      // exist inside Chromium's isolated evaluation world.
      let selector = ''
      if (element === document.documentElement) selector = 'html'
      const css = (globalThis as any).CSS
      if (!selector && element.id && typeof css?.escape === 'function') {
        const candidate = `#${css.escape(element.id)}`
        try {
          if (document.querySelectorAll(candidate).length === 1) selector = candidate
        } catch {}
      }
      if (!selector && typeof css?.escape === 'function') {
        for (const name of ['data-testid', 'data-test', 'data-cy']) {
          const value = element.getAttribute(name)
          if (!value) continue
          const candidate = `[${name}=${css.escape(value)}]`
          try {
            if (document.querySelectorAll(candidate).length === 1) {
              selector = candidate
              break
            }
          } catch {}
        }
      }
      if (!selector) {
        const parts: string[] = []
        let current: Element | null = element
        while (current && current !== document.documentElement && parts.length < 8) {
          let part = current.tagName.toLowerCase()
          const parent: Element | null = current.parentElement
          if (parent) {
            let sameTagCount = 0
            let sameTagIndex = 0
            for (const child of Array.from(parent.children)) {
              if (child.tagName !== current.tagName) continue
              sameTagCount++
              if (child === current) sameTagIndex = sameTagCount
            }
            if (sameTagCount > 1) part += `:nth-of-type(${sameTagIndex})`
          }
          parts.unshift(part)
          const candidate = parts.join(' > ')
          try {
            if (document.querySelectorAll(candidate).length === 1) {
              selector = candidate
              break
            }
          } catch {}
          current = parent
        }
        if (!selector) selector = parts.join(' > ')
      }
      const rect = element.getBoundingClientRect()
      const role = element.getAttribute('role') || undefined
      const ariaLabel = element.getAttribute('aria-label')?.trim().slice(0, 160) || undefined
      const text = element.innerText?.replace(/\s+/g, ' ').trim().slice(0, 160) || undefined
      return {
        selector: selector.slice(0, 512),
        tag: element.tagName.toLowerCase().slice(0, 32),
        ...(role ? { role: role.slice(0, 64) } : {}),
        ...(ariaLabel ? { ariaLabel } : {}),
        ...(text ? { text } : {}),
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      }
    },
    { x, y },
  )
}

async function resolveElement(
  page: PageLike,
  selector: string,
): Promise<ContainerPreviewElementTarget | null> {
  return page.evaluate((selector) => {
    let element: HTMLElement | null = null
    try {
      element = document.querySelector(selector) as HTMLElement | null
    } catch {
      return null
    }
    if (!element) return null
    const rect = element.getBoundingClientRect()
    const role = element.getAttribute('role') || undefined
    const ariaLabel = element.getAttribute('aria-label')?.trim().slice(0, 160) || undefined
    const text = element.innerText?.replace(/\s+/g, ' ').trim().slice(0, 160) || undefined
    return {
      selector: selector.slice(0, 512),
      tag: element.tagName.toLowerCase().slice(0, 32),
      ...(role ? { role: role.slice(0, 64) } : {}),
      ...(ariaLabel ? { ariaLabel } : {}),
      ...(text ? { text } : {}),
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    }
  }, selector)
}

export async function probeHtmlApplication(
  rawUrl: string,
  pinnedOrigin: string,
  options: { timeoutMs?: number; maxRedirects?: number } = {},
): Promise<{ finalUrl: string; status: number }> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS
  const maxRedirects = options.maxRedirects ?? PROBE_MAX_REDIRECTS
  const deadline = Date.now() + timeoutMs
  let current = normalizeContainerPreviewUrl(rawUrl).url

  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    if (Date.now() >= deadline) throw new Error('preview probe timed out')
    const result = await probeOnce(current, Math.max(1, deadline - Date.now()))
    if (result.status >= 300 && result.status < 400 && result.location) {
      if (redirects === maxRedirects) throw new Error('preview probe redirect limit exceeded')
      const next = new URL(result.location, current).toString()
      const normalized = normalizeContainerPreviewUrl(next)
      if (normalized.origin !== pinnedOrigin)
        throw new Error('preview probe redirect left pinned origin')
      current = normalized.url
      continue
    }
    if (result.status < 200 || result.status >= 300)
      throw new Error(`preview probe returned HTTP ${result.status}`)
    const type = result.contentType.toLowerCase()
    const sniff = result.body.toString('utf8').trimStart().toLowerCase()
    if (
      !type.includes('text/html') &&
      !sniff.startsWith('<!doctype html') &&
      !sniff.startsWith('<html')
    ) {
      throw new Error('preview target is not an HTML application')
    }
    return { finalUrl: current, status: result.status }
  }
  throw new Error('preview probe failed')
}

function probeOnce(
  url: string,
  timeoutMs: number,
): Promise<{
  status: number
  location: string | null
  contentType: string
  body: Buffer
}> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const get = parsed.protocol === 'https:' ? httpsGet : httpGet
    let settled = false
    let totalTimer: ReturnType<typeof setTimeout> | null = null
    const finish = (value: {
      status: number
      location: string | null
      contentType: string
      body: Buffer
    }): void => {
      if (settled) return
      settled = true
      if (totalTimer) clearTimeout(totalTimer)
      resolve(value)
    }
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      if (totalTimer) clearTimeout(totalTimer)
      reject(err)
    }
    const req = get(
      parsed,
      {
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': 'OpenClaude-Preview-Probe/1',
        },
        ...(parsed.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks: Buffer[] = []
        let total = 0
        const result = () => ({
          status: res.statusCode ?? 0,
          location: typeof res.headers.location === 'string' ? res.headers.location : null,
          contentType:
            typeof res.headers['content-type'] === 'string' ? res.headers['content-type'] : '',
          body: Buffer.concat(chunks),
        })
        res.on('data', (raw: Buffer | string) => {
          if (total >= PROBE_SNIFF_BYTES) return
          const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
          const remaining = PROBE_SNIFF_BYTES - total
          const kept = chunk.subarray(0, remaining)
          chunks.push(kept)
          total += kept.byteLength
          if (total >= PROBE_SNIFF_BYTES) {
            finish(result())
            res.destroy()
          }
        })
        res.on('end', () => finish(result()))
        res.once('error', fail)
      },
    )
    // ClientRequest#setTimeout is inactivity-only. Keep a true wall-clock
    // deadline as well so an endless trickle response cannot pin a preview
    // slot indefinitely.
    totalTimer = setTimeout(() => req.destroy(new Error('preview probe timed out')), timeoutMs)
    req.setTimeout(timeoutMs, () => req.destroy(new Error('preview probe timed out')))
    req.once('error', fail)
  })
}

function readJpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let offset = 2
  while (offset + 8 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      offset++
      continue
    }
    const marker = bytes[offset + 1]!
    offset += 2
    if (marker === 0xd8 || marker === 0xd9) continue
    if (offset + 2 > bytes.byteLength) return null
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!
    if (length < 2 || offset + length > bytes.byteLength) return null
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      const height = (bytes[offset + 3]! << 8) | bytes[offset + 4]!
      const width = (bytes[offset + 5]! << 8) | bytes[offset + 6]!
      return width > 0 && height > 0 ? { width, height } : null
    }
    offset += length
  }
  return null
}

function safePathname(raw: string | undefined): string {
  try {
    return new URL(raw ?? '/', 'http://container.invalid').pathname
  } catch {
    return raw ?? '/'
  }
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  const reason =
    status === 401 ? 'Unauthorized' : status === 409 ? 'Conflict' : 'Service Unavailable'
  try {
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
    )
  } catch {}
  try {
    socket.destroy()
  } catch {}
}

function parsePositiveSafeInteger(value: string | undefined): number | null {
  if (!value || !/^[1-9][0-9]{0,15}$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function clampCoordinate(value: number, limit: number): number {
  return Math.min(limit, Math.max(0, value))
}

function clampDelta(value: number): number {
  return Math.min(4_000, Math.max(-4_000, value))
}

function bounded(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max)
}

function userSafeOpenError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (/HTML application|HTTP \d+|redirect|timed out|ECONNREFUSED|connect/i.test(message)) {
    return '容器内网页暂时无法访问，请确认开发服务器正在运行并重试'
  }
  if (/WebSocket routing|Playwright|Chromium/i.test(message)) {
    return '当前运行环境版本不支持网页预览，请稍后重试'
  }
  return '网页预览启动失败，请重试'
}
