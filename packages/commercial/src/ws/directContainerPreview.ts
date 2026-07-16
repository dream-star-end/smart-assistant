/**
 * Native browser iframe preview through one isolated public hostname.
 *
 * Production uses a random same-site hostname below claudeai.chat. A temporary
 * Cloudflare Quick Tunnel remains available when no hostname suffix is
 * configured. The public host is only transport/isolation: authorization stays
 * a one-use bootstrap plus a host-only Partitioned HttpOnly cookie, and every
 * browser request is re-authorized before it can reach the container gateway.
 */

import { type ChildProcessByStdio, spawn } from 'node:child_process'
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  accessSync,
  constants as fsConstants,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import type {
  ClientRequest,
  IncomingHttpHeaders,
  IncomingMessage,
  RequestOptions,
  ServerResponse,
} from 'node:http'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex, Readable } from 'node:stream'
import type { TLSSocket } from 'node:tls'

import {
  CONTAINER_PREVIEW_ASSERTION_HEADER,
  CONTAINER_PREVIEW_DIRECT_BOOTSTRAP_PATH,
  CONTAINER_PREVIEW_DIRECT_BRIDGE_PATH,
  CONTAINER_PREVIEW_DIRECT_COOKIE,
  CONTAINER_PREVIEW_DIRECT_PROXY_PATH,
  CONTAINER_PREVIEW_TARGET_HEADER,
  CONTAINER_PREVIEW_VIEWPORT_HEADER,
  type ContainerPreviewViewport,
  OPENCLAUDE_CONTAINER_GATEWAY_PORT,
  normalizeContainerPreviewUrl,
  normalizeContainerPreviewViewport,
} from '@openclaude/protocol'
import { containerPreviewTargetHash } from '@openclaude/protocol/containerPreviewAuth'

import { type NodeAgentTarget, dialNodeAgentVerifiedTls } from '../compute-pool/nodeAgentClient.js'
import type { Logger } from '../logging/logger.js'
import type { AuthoritySigner } from './authoritySigner.js'
import type { ResolveContainerEndpoint } from './userChatBridge.js'

const TRY_HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/
const SAME_SITE_HOST_LABEL_RE = /^ocp-[0-9a-f]{32}$/
const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const SESSION_ID_RE = /^[0-9a-f]{32}$/
const BOOTSTRAP_TICKET_RE = /^[A-Za-z0-9_-]{32}$/
const COOKIE_VALUE_RE = /^[A-Za-z0-9_-]{43}$/

const BOOTSTRAP_TTL_MS = 30_000
const HARD_TTL_MS = 30 * 60_000
const IDLE_TTL_MS = 10 * 60_000
const SWEEP_MS = 15_000
const CONNECT_TIMEOUT_MS = 5_000
const RESPONSE_IDLE_MS = 60_000
const MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024
const MAX_HTTP_REQUESTS_PER_SESSION = 32
const DEFAULT_MAX_WS_CONNECTIONS_PER_SESSION = 16
const DEFAULT_MAX_WS_CONNECTIONS_GLOBAL = 64
const MAX_TUNNEL_LOG_BYTES = 64 * 1024
const DEFAULT_GLOBAL_CAP = 4
const DEFAULT_WARM_COUNT = 2
const DEFAULT_TUNNEL_ACQUIRE_TIMEOUT_MS = 4_000
const TUNNEL_START_TIMEOUT_MS = 20_000

const PREVIEW_SECURITY_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
}

export interface DirectContainerPreviewIssue {
  readonly sessionId: string
  readonly url: string
  readonly expiresAt: number
}

export interface DirectContainerPreviewService {
  issue(
    uid: bigint,
    rawUrl: string,
    rawViewport: Partial<ContainerPreviewViewport> | null | undefined,
  ): Promise<DirectContainerPreviewIssue | null>
  heartbeat(uid: bigint, sessionId: string): boolean
  revoke(uid: bigint, sessionId: string): Promise<boolean>
  handleHttp(req: IncomingMessage, res: ServerResponse): Promise<boolean>
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean
  shutdown(): Promise<void>
  activeCount(): number
}

export interface QuickTunnelLease {
  readonly hostname: string
  readonly exited: Promise<void>
  close(): Promise<void>
}

export interface DirectContainerPreviewDeps {
  signer: AuthoritySigner
  resolveContainerEndpoint: ResolveContainerEndpoint
  parentOrigin: string
  /** Loopback origin of this exact master slot (A/B have different ports). */
  tunnelOrigin: string
  logger?: Logger
  cloudflaredBinary?: string
  /** Optional same-site suffix. When set, no cloudflared process is launched. */
  previewHostnameSuffix?: string
  launchTunnel?: (originUrl: string) => Promise<QuickTunnelLease>
  now?: () => number
  maxSessions?: number
  warmTunnels?: number
  tunnelAcquireTimeoutMs?: number
  maxWebSocketsPerSession?: number
  maxWebSocketsGlobal?: number
}

interface DirectSession {
  readonly id: string
  readonly uid: bigint
  readonly origin: string
  readonly initialPath: string
  readonly viewport: ContainerPreviewViewport
  readonly hostname: string
  readonly bootstrapHash: string
  readonly cookieHash: string
  readonly bootstrapExpiresAt: number
  readonly expiresAt: number
  readonly tunnel: QuickTunnelLease
  readonly aborters: Set<() => void>
  readonly sockets: Set<Duplex>
  endpointPromise: Promise<ResolvedEndpoint> | null
  bootstrapTimer: ReturnType<typeof setTimeout> | null
  activeHttpRequests: number
  lastHeartbeatAt: number
  bootstrapConsumed: boolean
  revoked: boolean
}

type ResolvedEndpoint = Awaited<ReturnType<ResolveContainerEndpoint>>

interface PreviewAuthorityPolicy {
  readonly kind: 'quick-tunnel' | 'same-site'
  readonly suffix: string
  readonly validHostname: RegExp
}

export function createDirectContainerPreviewService(
  deps: DirectContainerPreviewDeps,
): DirectContainerPreviewService {
  const now = deps.now ?? Date.now
  const parentOrigin = normalizeParentOrigin(deps.parentOrigin)
  const tunnelOrigin = normalizeLoopbackOrigin(deps.tunnelOrigin)
  const authorityPolicy = createPreviewAuthorityPolicy(parentOrigin, deps.previewHostnameSuffix)
  const logger = deps.logger
  const derivationKey = randomBytes(32)
  const maxSessions = clampInt(finiteOr(deps.maxSessions, DEFAULT_GLOBAL_CAP), 1, 16)
  const warmTunnels = clampInt(finiteOr(deps.warmTunnels, DEFAULT_WARM_COUNT), 0, maxSessions)
  const tunnelAcquireTimeoutMs = clampInt(
    finiteOr(deps.tunnelAcquireTimeoutMs, DEFAULT_TUNNEL_ACQUIRE_TIMEOUT_MS),
    1,
    TUNNEL_START_TIMEOUT_MS,
  )
  const maxWebSocketsPerSession = clampInt(
    finiteOr(deps.maxWebSocketsPerSession, DEFAULT_MAX_WS_CONNECTIONS_PER_SESSION),
    1,
    64,
  )
  const maxWebSocketsGlobal = clampInt(
    finiteOr(deps.maxWebSocketsGlobal, DEFAULT_MAX_WS_CONNECTIONS_GLOBAL),
    1,
    256,
  )
  const launchTunnel = (): Promise<QuickTunnelLease> => {
    if (authorityPolicy.kind === 'same-site') {
      return Promise.resolve(createSameSitePreviewHostLease(authorityPolicy.suffix))
    }
    return deps.launchTunnel
      ? deps.launchTunnel(tunnelOrigin)
      : launchCloudflaredQuickTunnel(deps.cloudflaredBinary, tunnelOrigin)
  }
  const pool = new QuickTunnelPool(launchTunnel, maxSessions, warmTunnels, logger)
  const byHost = new Map<string, DirectSession>()
  const byId = new Map<string, DirectSession>()
  const idByUid = new Map<string, string>()
  const pendingIssueByUid = new Map<string, symbol>()
  const webSockets = new Set<Duplex>()
  let shuttingDown = false
  const sweepTimer = setInterval(() => void sweep(), SWEEP_MS)
  sweepTimer.unref?.()
  pool.start()

  async function issue(
    uid: bigint,
    rawUrl: string,
    rawViewport: Partial<ContainerPreviewViewport> | null | undefined,
  ): Promise<DirectContainerPreviewIssue | null> {
    if (shuttingDown || uid <= 0n) return null
    const normalized = normalizeContainerPreviewUrl(rawUrl)
    const viewport = normalizeContainerPreviewViewport(rawViewport)
    const target = new URL(normalized.url)
    // The namespace is owned by bootstrap/bridge control resources on the
    // public preview host. Such an app URL remains available via legacy mode.
    if (target.pathname.startsWith('/__oc_preview_')) return null
    const uidKey = uid.toString()
    const issueGeneration = Symbol(uidKey)
    pendingIssueByUid.set(uidKey, issueGeneration)
    const priorId = idByUid.get(uidKey)
    if (priorId) {
      const prior = byId.get(priorId)
      if (prior) await revokeRecord(prior, 'replaced')
    }
    const sessionRef: { current?: DirectSession } = {}
    let tunnelExited = false
    const acquirePromise = pool.acquire(() => {
      if (sessionRef.current) void revokeRecord(sessionRef.current, 'tunnel_exit')
      else tunnelExited = true
    })
    let acquireTimedOut = false
    const tunnel = await Promise.race([
      acquirePromise,
      new Promise<null>((resolve) => {
        const timer = setTimeout(() => {
          acquireTimedOut = true
          resolve(null)
        }, tunnelAcquireTimeoutMs)
        void acquirePromise.then(
          () => clearTimeout(timer),
          () => clearTimeout(timer),
        )
      }),
    ])
    if (acquireTimedOut) {
      void acquirePromise.then((late) => (late ? pool.release(late) : undefined))
    }
    if (!tunnel || shuttingDown || pendingIssueByUid.get(uidKey) !== issueGeneration) {
      if (tunnel) void pool.release(tunnel)
      if (pendingIssueByUid.get(uidKey) === issueGeneration) pendingIssueByUid.delete(uidKey)
      return null
    }
    const issuedAt = now()
    const id = randomBytes(16).toString('hex')
    const bootstrap = randomBytes(24).toString('base64url')
    const cookie = deriveCookie(derivationKey, id, bootstrap)
    const record: DirectSession = {
      id,
      uid,
      origin: normalized.origin,
      initialPath: target.pathname + target.search,
      viewport,
      hostname: tunnel.hostname,
      bootstrapHash: tokenHash(bootstrap),
      cookieHash: tokenHash(cookie),
      bootstrapExpiresAt: issuedAt + BOOTSTRAP_TTL_MS,
      expiresAt: issuedAt + HARD_TTL_MS,
      tunnel,
      aborters: new Set(),
      sockets: new Set(),
      endpointPromise: null,
      bootstrapTimer: null,
      activeHttpRequests: 0,
      lastHeartbeatAt: issuedAt,
      bootstrapConsumed: false,
      revoked: false,
    }
    sessionRef.current = record
    if (tunnelExited) {
      await pool.release(tunnel)
      if (pendingIssueByUid.get(uidKey) === issueGeneration) pendingIssueByUid.delete(uidKey)
      return null
    }
    byHost.set(record.hostname, record)
    byId.set(record.id, record)
    idByUid.set(uidKey, record.id)
    pendingIssueByUid.delete(uidKey)
    record.bootstrapTimer = setTimeout(() => {
      if (!record.bootstrapConsumed) void revokeRecord(record, 'bootstrap_ttl')
    }, BOOTSTRAP_TTL_MS)
    record.bootstrapTimer.unref?.()
    return {
      sessionId: id,
      url: `https://${record.hostname}${CONTAINER_PREVIEW_DIRECT_BOOTSTRAP_PATH}?ticket=${bootstrap}`,
      expiresAt: record.expiresAt,
    }
  }

  function heartbeat(uid: bigint, sessionId: string): boolean {
    if (!SESSION_ID_RE.test(sessionId)) return false
    const record = byId.get(sessionId)
    if (!record || record.revoked || record.uid !== uid || isExpired(record, now())) return false
    record.lastHeartbeatAt = now()
    return true
  }

  async function revoke(uid: bigint, sessionId: string): Promise<boolean> {
    if (!SESSION_ID_RE.test(sessionId)) return false
    const record = byId.get(sessionId)
    if (!record || record.uid !== uid) return false
    await revokeRecord(record, 'parent_revoke')
    return true
  }

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const authority = readPreviewAuthority(req.headers.host, authorityPolicy)
    if (!authority.claimed) return false
    if (!authority.hostname) {
      sendPreviewText(res, 400, 'invalid preview authority', parentOrigin)
      return true
    }
    const hostname = authority.hostname
    const record = byHost.get(hostname)
    if (!record || record.revoked) {
      sendPreviewText(res, 404, 'preview not found', parentOrigin)
      return true
    }
    if (isExpired(record, now())) {
      await revokeRecord(record, 'expired')
      sendPreviewText(res, 410, 'preview expired', parentOrigin)
      return true
    }
    const url = new URL(req.url ?? '/', `https://${hostname}`)
    if (url.pathname === CONTAINER_PREVIEW_DIRECT_BOOTSTRAP_PATH) {
      if (req.method !== 'GET') {
        sendPreviewText(res, 405, 'method not allowed', parentOrigin)
        return true
      }
      handleBootstrap(record, url, res, derivationKey, now(), parentOrigin)
      return true
    }
    if (!authenticatePreviewCookie(req.headers.cookie, record.cookieHash)) {
      sendPreviewText(res, 401, 'preview authorization required', parentOrigin)
      return true
    }
    if (url.pathname === CONTAINER_PREVIEW_DIRECT_BRIDGE_PATH) {
      serveBridgeScript(res, parentOrigin)
      return true
    }
    if (url.pathname.startsWith('/__oc_preview_')) {
      sendPreviewText(res, 404, 'preview resource not found', parentOrigin)
      return true
    }
    if (isServiceWorkerRequest(req)) {
      sendPreviewText(res, 403, 'service workers are disabled in preview', parentOrigin)
      return true
    }
    try {
      await proxyHttp(record, req, res)
    } catch (err) {
      logger?.warn('container_preview.direct_http_proxy_failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      if (!res.headersSent) sendPreviewText(res, 502, 'preview unavailable', parentOrigin)
    }
    return true
  }

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const authority = readPreviewAuthority(req.headers.host, authorityPolicy)
    if (!authority.claimed) return false
    if (!authority.hostname) {
      rejectUpgrade(socket, 400, 'invalid preview authority')
      return true
    }
    const hostname = authority.hostname
    const record = byHost.get(hostname)
    const requestPath = safePreviewPath(req.url, hostname)
    if (
      !record ||
      record.revoked ||
      isExpired(record, now()) ||
      !authenticatePreviewCookie(req.headers.cookie, record.cookieHash) ||
      !requestPath ||
      requestPath.startsWith('/__oc_preview_')
    ) {
      rejectUpgrade(socket, 401, 'preview authorization required')
      if (record && isExpired(record, now())) void revokeRecord(record, 'expired')
      return true
    }
    if (record.sockets.size >= maxWebSocketsPerSession || webSockets.size >= maxWebSocketsGlobal) {
      rejectUpgrade(socket, 429, 'too many preview websocket connections')
      return true
    }
    record.sockets.add(socket)
    webSockets.add(socket)
    const releaseSocket = (): void => {
      record.sockets.delete(socket)
      webSockets.delete(socket)
    }
    socket.once('close', releaseSocket)
    socket.once('error', releaseSocket)
    void proxyUpgrade(record, req, socket, head)
    return true
  }

  async function proxyHttp(
    record: DirectSession,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const rawContentLength = req.headers['content-length']
    const declaredLength = Number(
      Array.isArray(rawContentLength) ? rawContentLength[0] : rawContentLength,
    )
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
      sendPreviewText(res, 413, 'request too large', parentOrigin)
      return
    }
    if (record.activeHttpRequests >= MAX_HTTP_REQUESTS_PER_SESSION) {
      sendPreviewText(res, 429, 'too many preview requests', parentOrigin)
      return
    }
    const targetUrl = targetUrlFor(record, req.url)
    record.activeHttpRequests++
    const abort = new AbortController()
    const stop = (): void => abort.abort()
    record.aborters.add(stop)
    res.once('close', stop)
    req.once('aborted', stop)
    req.once('error', stop)
    try {
      const endpoint = await resolveSessionEndpoint(record)
      if (record.revoked || abort.signal.aborted) return
      const upstream = await createGatewayRequest(
        endpoint,
        req.method ?? 'GET',
        previewRequestHeaders(req.headers),
        record,
        targetUrl,
        abort.signal,
      )
      await new Promise<void>((resolve) => {
        let settled = false
        let requestBytes = 0
        let requestTooLarge = false
        let responseStream: IncomingMessage | null = null
        const finish = (): void => {
          if (settled) return
          settled = true
          req.removeListener('data', onRequestData)
          req.removeListener('end', onRequestEnd)
          if (!req.complete && !req.destroyed) req.resume()
          resolve()
        }
        const abortUpstream = (): void => {
          upstream.destroy()
          responseStream?.destroy()
          finish()
        }
        const onRequestData = (chunk: Buffer): void => {
          if (requestTooLarge) return
          requestBytes += chunk.length
          if (requestBytes > MAX_REQUEST_BODY_BYTES) {
            requestTooLarge = true
            upstream.destroy(new Error('preview request too large'))
            if (!res.headersSent) sendPreviewText(res, 413, 'request too large', parentOrigin)
            finish()
            return
          }
          if (!upstream.destroyed && !upstream.write(chunk)) {
            req.pause()
            upstream.once('drain', () => {
              if (!requestTooLarge && !abort.signal.aborted) req.resume()
            })
          }
        }
        const onRequestEnd = (): void => {
          if (!upstream.destroyed) upstream.end()
        }
        abort.signal.addEventListener('abort', abortUpstream, { once: true })
        upstream.on('timeout', () => upstream.destroy(new Error('preview gateway timeout')))
        upstream.on('error', (err) => {
          if (requestTooLarge || abort.signal.aborted) {
            finish()
            return
          }
          logger?.warn('container_preview.direct_gateway_error', { error: err.message })
          if (!res.headersSent)
            sendPreviewText(res, 502, 'preview gateway unavailable', parentOrigin)
          else if (!res.writableEnded) {
            try {
              res.destroy()
            } catch {}
          }
          finish()
        })
        upstream.on('response', (response) => {
          responseStream = response
          response.setTimeout(RESPONSE_IDLE_MS, () => response.destroy())
          const responseHeaders = sanitizePreviewResponseHeaders(
            response.headers,
            targetUrl,
            parentOrigin,
          )
          if (responseHeaders === null) {
            response.destroy()
            sendPreviewText(res, 502, 'preview redirect blocked', parentOrigin)
            finish()
            return
          }
          res.writeHead(response.statusCode ?? 502, responseHeaders)
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
        })
        req.on('data', onRequestData)
        req.once('end', onRequestEnd)
        if (req.readableEnded) onRequestEnd()
      })
    } catch (err) {
      logger?.warn('container_preview.direct_http_proxy_failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      if (!res.headersSent) sendPreviewText(res, 502, 'preview unavailable', parentOrigin)
    } finally {
      res.removeListener('close', stop)
      req.removeListener('aborted', stop)
      req.removeListener('error', stop)
      record.aborters.delete(stop)
      record.activeHttpRequests--
    }
  }

  async function proxyUpgrade(
    record: DirectSession,
    req: IncomingMessage,
    browserSocket: Duplex,
    browserHead: Buffer,
  ): Promise<void> {
    const abort = new AbortController()
    const stop = (): void => abort.abort()
    record.aborters.add(stop)
    let upstream: ClientRequest | null = null
    let cleaned = false
    const cleanup = (): void => {
      if (cleaned) return
      cleaned = true
      record.aborters.delete(stop)
    }
    const abortPending = (): void => {
      abort.abort()
      try {
        upstream?.destroy()
      } catch {}
      cleanup()
    }
    browserSocket.once('close', abortPending)
    browserSocket.once('error', abortPending)
    try {
      const targetUrl = targetUrlFor(record, req.url)
      const endpoint = await resolveSessionEndpoint(record)
      if (record.revoked || abort.signal.aborted) {
        cleanup()
        return
      }
      const gatewayRequest = await createGatewayRequest(
        endpoint,
        'GET',
        previewRequestHeaders(req.headers, true),
        record,
        targetUrl,
        abort.signal,
      )
      upstream = gatewayRequest
      let upgraded = false
      const fail = (reason: string): void => {
        if (upgraded) return
        cleanup()
        logger?.warn('container_preview.direct_ws_proxy_failed', { reason })
        rejectUpgrade(browserSocket, 502, 'preview websocket unavailable')
        try {
          gatewayRequest.destroy()
        } catch {}
      }
      abort.signal.addEventListener('abort', () => gatewayRequest.destroy(), { once: true })
      gatewayRequest.on('timeout', () => fail('timeout'))
      gatewayRequest.on('error', (err) => fail(err.message))
      gatewayRequest.on('response', (response) => {
        response.resume()
        fail(`unexpected status ${response.statusCode ?? 0}`)
      })
      gatewayRequest.on('upgrade', (response, gatewaySocket, gatewayHead) => {
        if (response.statusCode !== 101) {
          gatewaySocket.destroy()
          fail(`unexpected upgrade status ${response.statusCode ?? 0}`)
          return
        }
        const headers = sanitizeUpgradeResponseHeaders(response.rawHeaders)
        if (!headers) {
          gatewaySocket.destroy()
          fail('bad upgrade headers')
          return
        }
        upgraded = true
        cleanup()
        try {
          browserSocket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers}\r\n`)
          if (gatewayHead.length > 0) browserSocket.write(gatewayHead)
          if (browserHead.length > 0) gatewaySocket.write(browserHead)
          browserSocket.pipe(gatewaySocket)
          gatewaySocket.pipe(browserSocket)
        } catch {
          browserSocket.destroy()
          gatewaySocket.destroy()
        }
        const closeBoth = (): void => {
          try {
            browserSocket.destroy()
          } catch {}
          try {
            gatewaySocket.destroy()
          } catch {}
        }
        browserSocket.once('close', closeBoth)
        browserSocket.once('error', closeBoth)
        gatewaySocket.once('close', closeBoth)
        gatewaySocket.once('error', closeBoth)
      })
      gatewayRequest.end()
    } catch (err) {
      cleanup()
      logger?.warn('container_preview.direct_ws_connect_failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      rejectUpgrade(browserSocket, 502, 'preview unavailable')
    }
  }

  function resolveSessionEndpoint(record: DirectSession): Promise<ResolvedEndpoint> {
    record.endpointPromise ??= deps.resolveContainerEndpoint(record.uid)
    return record.endpointPromise
  }

  async function createGatewayRequest(
    endpoint: ResolvedEndpoint,
    method: string,
    browserHeaders: Record<string, string | string[]>,
    record: DirectSession,
    targetUrl: string,
    signal: AbortSignal,
  ): Promise<ClientRequest> {
    if (
      !Number.isSafeInteger(endpoint.containerId) ||
      Number(endpoint.containerId) < 1 ||
      endpoint.port !== OPENCLAUDE_CONTAINER_GATEWAY_PORT
    ) {
      throw new Error('resolved preview gateway endpoint rejected')
    }
    const uid = Number(record.uid)
    if (!Number.isSafeInteger(uid) || uid < 1) throw new Error('preview uid out of range')
    const { envelope } = deps.signer.signContainerPreviewAssertion({
      uid,
      containerId: endpoint.containerId!,
      sessionId: randomBytes(16).toString('hex'),
      targetHash: containerPreviewTargetHash(targetUrl, record.viewport),
    })
    const headers: Record<string, string | string[]> = {
      ...browserHeaders,
      host: `${endpoint.host}:${endpoint.port}`,
      [CONTAINER_PREVIEW_ASSERTION_HEADER]: envelope,
      [CONTAINER_PREVIEW_TARGET_HEADER]: targetUrl,
      [CONTAINER_PREVIEW_VIEWPORT_HEADER]: JSON.stringify(record.viewport),
      'x-connection-trace-id': randomUUID(),
    }
    const options: RequestOptions = {
      method,
      path: CONTAINER_PREVIEW_DIRECT_PROXY_PATH,
      headers,
      timeout: CONNECT_TIMEOUT_MS,
    }
    if (!endpoint.tunnel) {
      return httpRequest({
        ...options,
        hostname: endpoint.host,
        port: endpoint.port,
        family: 4,
      })
    }
    if (signal.aborted) throw new DOMException('aborted', 'AbortError')
    const target = endpoint.tunnel.nodeAgent
    const socket = await dialNodeAgentVerifiedTls(target)
    if (signal.aborted) {
      socket.destroy()
      throw new DOMException('aborted', 'AbortError')
    }
    let pskHex: string | null = null
    if (target.psk) {
      pskHex = target.psk.toString('hex')
    }
    const tunnelPath =
      `/tunnel/containers/${encodeURIComponent(endpoint.tunnel.containerInternalId)}` +
      `${CONTAINER_PREVIEW_DIRECT_PROXY_PATH}?port=${endpoint.port}`
    const remoteHeaders: Record<string, string | string[]> = {
      ...headers,
      host: `${target.host}:${target.agentPort}`,
    }
    if (pskHex) remoteHeaders.authorization = `Bearer ${pskHex}`
    let consumed = false
    const createConnection = (): TLSSocket => {
      if (consumed) throw new Error('preview tunnel TLS socket already consumed')
      consumed = true
      return socket
    }
    try {
      return httpsRequest({
        ...options,
        hostname: target.host,
        port: target.agentPort,
        path: tunnelPath,
        headers: remoteHeaders,
        agent: false,
        createConnection,
      })
    } catch (err) {
      if (!consumed) socket.destroy()
      throw err
    }
  }

  async function revokeRecord(record: DirectSession, reason: string): Promise<void> {
    if (record.revoked) return
    record.revoked = true
    if (record.bootstrapTimer) clearTimeout(record.bootstrapTimer)
    record.bootstrapTimer = null
    byHost.delete(record.hostname)
    byId.delete(record.id)
    if (idByUid.get(record.uid.toString()) === record.id) idByUid.delete(record.uid.toString())
    for (const abort of [...record.aborters]) {
      try {
        abort()
      } catch {}
    }
    record.aborters.clear()
    for (const socket of [...record.sockets]) {
      webSockets.delete(socket)
      try {
        socket.destroy()
      } catch {}
    }
    record.sockets.clear()
    const endpointPromise = record.endpointPromise
    record.endpointPromise = null
    if (endpointPromise) {
      void endpointPromise.then(clearEndpointSecret, () => undefined)
    }
    logger?.info('container_preview.direct_revoked', {
      uid: record.uid.toString(),
      reason,
    })
    await pool.release(record.tunnel)
  }

  async function sweep(): Promise<void> {
    const at = now()
    await Promise.allSettled(
      [...byId.values()]
        .filter((record) => isExpired(record, at))
        .map((record) => revokeRecord(record, expirationReason(record, at))),
    )
  }

  return {
    issue,
    heartbeat,
    revoke,
    handleHttp,
    handleUpgrade,
    async shutdown(): Promise<void> {
      if (shuttingDown) return
      shuttingDown = true
      clearInterval(sweepTimer)
      await Promise.allSettled([...byId.values()].map((record) => revokeRecord(record, 'shutdown')))
      byHost.clear()
      byId.clear()
      idByUid.clear()
      pendingIssueByUid.clear()
      webSockets.clear()
      await pool.shutdown()
      derivationKey.fill(0)
    },
    activeCount(): number {
      return byId.size
    },
  }
}

class QuickTunnelPool {
  private readonly warm: QuickTunnelLease[] = []
  private readonly leases = new Map<QuickTunnelLease, 'warm' | 'leased' | 'closing'>()
  private readonly exitCallbacks = new Map<QuickTunnelLease, () => void>()
  private starting = 0
  private stopped = false

  constructor(
    private readonly launcher: () => Promise<QuickTunnelLease>,
    private readonly max: number,
    private readonly warmTarget: number,
    private readonly logger?: Logger,
  ) {}

  start(): void {
    this.ensureWarm()
  }

  async acquire(onExit: () => void): Promise<QuickTunnelLease | null> {
    if (this.stopped) return null
    const ready = this.warm.shift()
    if (ready) {
      this.exitCallbacks.set(ready, onExit)
      this.leases.set(ready, 'leased')
      this.ensureWarm()
      return ready
    }
    if (this.leases.size + this.starting >= this.max) return null
    const lease = await this.launchOne(onExit)
    if (!lease || this.stopped) {
      if (lease) await lease.close()
      return null
    }
    if (this.leases.get(lease) !== 'leased') return null
    this.ensureWarm()
    return lease
  }

  async release(lease: QuickTunnelLease): Promise<void> {
    const state = this.leases.get(lease)
    if (!state || state === 'closing') return
    this.leases.set(lease, 'closing')
    this.exitCallbacks.delete(lease)
    await lease.close()
  }

  async shutdown(): Promise<void> {
    this.stopped = true
    const leases = [...this.leases.keys()]
    this.warm.length = 0
    this.exitCallbacks.clear()
    await Promise.allSettled(leases.map((lease) => lease.close()))
    this.leases.clear()
  }

  private ensureWarm(): void {
    if (this.stopped) return
    while (
      this.warm.length + this.starting < this.warmTarget &&
      this.leases.size + this.starting < this.max
    ) {
      this.starting++
      void this.launcher()
        .then((lease) => {
          this.starting--
          if (this.stopped) {
            void lease.close()
            return
          }
          this.leases.set(lease, 'warm')
          this.registerExit(lease)
          this.warm.push(lease)
        })
        .catch((err) => {
          this.starting--
          this.logger?.warn('container_preview.quick_tunnel_warm_failed', {
            error: err instanceof Error ? err.message : String(err),
          })
        })
    }
  }

  private async launchOne(onExit: () => void): Promise<QuickTunnelLease | null> {
    this.starting++
    try {
      const lease = await this.launcher()
      this.leases.set(lease, 'leased')
      this.exitCallbacks.set(lease, onExit)
      this.registerExit(lease)
      return lease
    } catch (err) {
      this.logger?.warn('container_preview.quick_tunnel_launch_failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      return null
    } finally {
      this.starting--
    }
  }

  private registerExit(lease: QuickTunnelLease): void {
    void lease.exited.then(() => {
      const state = this.leases.get(lease)
      this.leases.delete(lease)
      const warmIndex = this.warm.indexOf(lease)
      if (warmIndex >= 0) this.warm.splice(warmIndex, 1)
      const callback = this.exitCallbacks.get(lease)
      this.exitCallbacks.delete(lease)
      if (state === 'leased' && callback) callback()
      this.ensureWarm()
    })
  }
}

export async function launchCloudflaredQuickTunnel(
  configuredBinary: string | undefined,
  originUrl: string,
): Promise<QuickTunnelLease> {
  const binary = resolveCloudflaredBinary(configuredBinary)
  const base = join(tmpdir(), 'oc-v5-preview-cloudflared-')
  const isolatedHome = mkdtempSync(base)
  mkdirSync(join(isolatedHome, '.cloudflared'), { mode: 0o700 })
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: isolatedHome,
    XDG_CONFIG_HOME: isolatedHome,
    SSL_CERT_FILE: process.env.SSL_CERT_FILE,
    SSL_CERT_DIR: process.env.SSL_CERT_DIR,
  }
  const child = spawn(
    binary,
    ['tunnel', '--no-autoupdate', '--url', originUrl, '--loglevel', 'info'],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  return await waitForQuickTunnel(child, isolatedHome)
}

export function createSameSitePreviewHostLease(suffix: string): QuickTunnelLease {
  const normalizedSuffix = normalizePreviewHostnameSuffix(suffix)
  let closed = false
  let resolveExit: () => void = () => {}
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve
  })
  return {
    hostname: `ocp-${randomBytes(16).toString('hex')}.${normalizedSuffix}`,
    exited,
    async close(): Promise<void> {
      if (closed) return
      closed = true
      resolveExit()
    },
  }
}

function waitForQuickTunnel(
  child: ChildProcessByStdio<null, Readable, Readable>,
  isolatedHome: string,
): Promise<QuickTunnelLease> {
  return new Promise((resolve, reject) => {
    let settled = false
    let logBytes = 0
    let logTail = ''
    let exitResolve: () => void = () => {}
    const exited = new Promise<void>((done) => {
      exitResolve = done
    })
    const cleanupStartup = (): void => {
      clearTimeout(timer)
      child.stdout.removeListener('data', onData)
      child.stderr.removeListener('data', onData)
      child.removeListener('error', onError)
    }
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      cleanupStartup()
      try {
        child.kill('SIGKILL')
      } catch {}
      rmSync(isolatedHome, { recursive: true, force: true })
      reject(err)
    }
    const onError = (err: Error): void => fail(err)
    const onData = (chunk: Buffer): void => {
      if (settled) return
      logBytes += chunk.length
      if (logBytes > MAX_TUNNEL_LOG_BYTES) {
        fail(new Error('cloudflared startup output exceeded limit'))
        return
      }
      logTail = `${logTail}${chunk.toString('utf8')}`.slice(-MAX_TUNNEL_LOG_BYTES)
      const match = /https:\/\/([a-z0-9-]+\.trycloudflare\.com)\b/.exec(logTail)
      if (!match) return
      const hostname = match[1]!
      if (!TRY_HOST_RE.test(hostname)) {
        fail(new Error('cloudflared returned an invalid quick tunnel hostname'))
        return
      }
      settled = true
      cleanupStartup()
      let closing: Promise<void> | null = null
      const close = (): Promise<void> => {
        closing ??= (async () => {
          if (child.exitCode === null && child.signalCode === null) {
            try {
              child.kill('SIGTERM')
            } catch {}
            await Promise.race([exited, new Promise<void>((done) => setTimeout(done, 2_000))])
            if (child.exitCode === null && child.signalCode === null) {
              try {
                child.kill('SIGKILL')
              } catch {}
              await exited
            }
          }
          rmSync(isolatedHome, { recursive: true, force: true })
        })()
        return closing
      }
      resolve({ hostname, exited, close })
    }
    child.once('error', onError)
    child.once('exit', () => {
      exitResolve()
      if (!settled) fail(new Error('cloudflared exited before assigning a hostname'))
    })
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    const timer = setTimeout(
      () => fail(new Error('cloudflared quick tunnel startup timed out')),
      TUNNEL_START_TIMEOUT_MS,
    )
  })
}

function resolveCloudflaredBinary(configured: string | undefined): string {
  const candidates = configured
    ? [configured]
    : ['/usr/local/bin/cloudflared', '/usr/bin/cloudflared']
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK)
      return realpathSync(candidate)
    } catch {}
  }
  throw new Error('cloudflared executable unavailable')
}

function normalizeParentOrigin(raw: string): string {
  const parsed = new URL(raw)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('preview parent origin must be HTTP(S)')
  }
  if (parsed.username || parsed.password) throw new Error('preview parent origin has credentials')
  return parsed.origin
}

function createPreviewAuthorityPolicy(
  parentOrigin: string,
  rawSuffix: string | undefined,
): PreviewAuthorityPolicy {
  if (rawSuffix === undefined) {
    return {
      kind: 'quick-tunnel',
      suffix: 'trycloudflare.com',
      validHostname: TRY_HOST_RE,
    }
  }
  const suffix = normalizePreviewHostnameSuffix(rawSuffix)
  const parent = new URL(parentOrigin)
  if (parent.protocol !== 'https:') {
    throw new Error('same-site preview parent origin must use HTTPS')
  }
  const parentHostname = parent.hostname.toLowerCase()
  if (parentHostname !== suffix && !parentHostname.endsWith(`.${suffix}`)) {
    throw new Error('preview hostname suffix must contain the parent hostname')
  }
  return {
    kind: 'same-site',
    suffix,
    validHostname: new RegExp(
      `^${SAME_SITE_HOST_LABEL_RE.source.slice(1, -1)}\\.${escapeRegExp(suffix)}$`,
    ),
  }
}

function normalizePreviewHostnameSuffix(raw: string): string {
  if (
    raw.length === 0 ||
    raw !== raw.trim() ||
    raw !== raw.toLowerCase() ||
    raw.endsWith('.') ||
    raw.includes('*') ||
    isIP(raw) !== 0
  ) {
    throw new Error('preview hostname suffix must be a lowercase DNS suffix')
  }
  const labels = raw.split('.')
  if (
    labels.length < 2 ||
    labels.some((label) => !DNS_LABEL_RE.test(label)) ||
    !/[a-z]/.test(labels.at(-1) ?? '') ||
    `ocp-${'0'.repeat(32)}.${raw}`.length > 253
  ) {
    throw new Error('preview hostname suffix must be a valid public DNS suffix')
  }
  return raw
}

function normalizeLoopbackOrigin(raw: string): string {
  const parsed = new URL(raw)
  const port = Number(parsed.port)
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== '127.0.0.1' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('preview tunnel origin must be an explicit loopback HTTP port')
  }
  return parsed.origin
}

function readPreviewAuthority(
  raw: string | undefined,
  policy: PreviewAuthorityPolicy,
): {
  claimed: boolean
  hostname: string | null
} {
  if (typeof raw !== 'string') return { claimed: false, hostname: null }
  const trimmed = raw.trim()
  const firstColon = trimmed.indexOf(':')
  const rawHostname = (firstColon >= 0 ? trimmed.slice(0, firstColon) : trimmed)
    .trim()
    .replace(/\.+$/, '')
  const lowerCandidate = rawHostname.toLowerCase()
  const claimed = isPreviewAuthorityClaimed(lowerCandidate, policy)
  if (!claimed) return { claimed: false, hostname: null }
  if (trimmed !== raw || raw.length > 320) return { claimed: true, hostname: null }

  const match = /^([^:]+)(?::([0-9]{1,5}))?$/.exec(raw)
  if (!match) return { claimed: true, hostname: null }
  const hostname = match[1]!.replace(/\.$/, '').toLowerCase()
  const port = match[2]
  if (port) {
    const numericPort = Number(port)
    if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65_535) {
      return { claimed: true, hostname: null }
    }
  }
  return {
    claimed: true,
    hostname: policy.validHostname.test(hostname) ? hostname : null,
  }
}

function isPreviewAuthorityClaimed(hostname: string, policy: PreviewAuthorityPolicy): boolean {
  if (policy.kind === 'quick-tunnel') {
    return hostname === policy.suffix || hostname.endsWith(`.${policy.suffix}`)
  }
  if (!hostname.endsWith(`.${policy.suffix}`)) return false
  const label = hostname.slice(0, -(policy.suffix.length + 1))
  return !label.includes('.') && label.startsWith('ocp-')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function safePreviewPath(raw: string | undefined, hostname: string): string | null {
  try {
    return new URL(raw ?? '/', `https://${hostname}`).pathname
  } catch {
    return null
  }
}

function clearEndpointSecret(endpoint: ResolvedEndpoint): void {
  try {
    endpoint.tunnel?.nodeAgent.psk?.fill(0)
  } catch {}
}

function deriveCookie(key: Buffer, sessionId: string, bootstrap: string): string {
  return createHmac('sha256', key)
    .update(`oc-direct-preview-cookie-v1\n${sessionId}\n${bootstrap}`, 'utf8')
    .digest('base64url')
}

function tokenHash(value: string): string {
  return createHash('sha256').update(value, 'ascii').digest('hex')
}

function equalHash(raw: string, expectedHex: string): boolean {
  const actual = Buffer.from(tokenHash(raw), 'hex')
  const expected = Buffer.from(expectedHex, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function authenticatePreviewCookie(raw: string | undefined, expectedHash: string): boolean {
  if (typeof raw !== 'string' || raw.length > 16 * 1024) return false
  const values: string[] = []
  for (const part of raw.split(';')) {
    const trimmed = part.trim()
    const equals = trimmed.indexOf('=')
    if (equals <= 0) continue
    if (trimmed.slice(0, equals) === CONTAINER_PREVIEW_DIRECT_COOKIE) {
      values.push(trimmed.slice(equals + 1))
    }
  }
  if (values.length !== 1 || !COOKIE_VALUE_RE.test(values[0]!)) return false
  return equalHash(values[0]!, expectedHash)
}

function handleBootstrap(
  record: DirectSession,
  url: URL,
  res: ServerResponse,
  derivationKey: Buffer,
  at: number,
  parentOrigin: string,
): void {
  const ticket = url.searchParams.get('ticket') ?? ''
  if (
    record.bootstrapConsumed ||
    record.bootstrapExpiresAt <= at ||
    !BOOTSTRAP_TICKET_RE.test(ticket) ||
    !equalHash(ticket, record.bootstrapHash)
  ) {
    sendPreviewText(res, 401, 'preview ticket invalid', parentOrigin)
    return
  }
  record.bootstrapConsumed = true
  if (record.bootstrapTimer) clearTimeout(record.bootstrapTimer)
  record.bootstrapTimer = null
  const cookie = deriveCookie(derivationKey, record.id, ticket)
  if (!equalHash(cookie, record.cookieHash)) {
    sendPreviewText(res, 500, 'preview bootstrap failed', parentOrigin)
    return
  }
  res.writeHead(302, {
    ...PREVIEW_SECURITY_HEADERS,
    'Content-Security-Policy': `frame-ancestors ${parentOrigin}`,
    Location: record.initialPath,
    'Set-Cookie': `${CONTAINER_PREVIEW_DIRECT_COOKIE}=${cookie}; Path=/; Secure; HttpOnly; SameSite=None; Partitioned`,
    'Content-Length': '0',
  })
  res.end()
}

function isExpired(record: DirectSession, at: number): boolean {
  return (
    at >= record.expiresAt ||
    (!record.bootstrapConsumed && at >= record.bootstrapExpiresAt) ||
    at - record.lastHeartbeatAt >= IDLE_TTL_MS
  )
}

function expirationReason(record: DirectSession, at: number): string {
  if (at >= record.expiresAt) return 'hard_ttl'
  if (!record.bootstrapConsumed && at >= record.bootstrapExpiresAt) return 'bootstrap_ttl'
  return 'idle_ttl'
}

function targetUrlFor(record: DirectSession, rawPath: string | undefined): string {
  const incoming = new URL(rawPath ?? '/', `https://${record.hostname}`)
  if (incoming.pathname.startsWith('/__oc_preview_')) {
    throw new Error('reserved preview path')
  }
  const target = new URL(record.origin)
  target.pathname = incoming.pathname
  target.search = incoming.search
  return normalizeContainerPreviewUrl(target.toString()).url
}

function previewRequestHeaders(
  incoming: IncomingHttpHeaders,
  websocket = false,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  const hop = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ])
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue
    const lower = name.toLowerCase()
    if (lower === 'host' || lower === 'authorization' || lower === 'proxy-authorization') continue
    if (lower.startsWith('cf-') || lower.startsWith('x-forwarded-')) continue
    if (lower.startsWith('x-openclaude-') || lower.startsWith('x-oc-')) continue
    if (hop.has(lower) && !websocket) continue
    if (lower === 'cookie') {
      const sanitized = stripReservedCookie(Array.isArray(value) ? value.join('; ') : value)
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
  out['accept-encoding'] = 'identity'
  if (websocket) {
    out.connection = 'Upgrade'
    out.upgrade = 'websocket'
  }
  return out
}

function stripReservedCookie(raw: string): string {
  return raw
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part && part.split('=', 1)[0] !== CONTAINER_PREVIEW_DIRECT_COOKIE)
    .join('; ')
}

function sanitizePreviewResponseHeaders(
  incoming: IncomingHttpHeaders,
  targetUrl: string,
  parentOrigin: string,
): Record<string, string | string[]> | null {
  const out: Record<string, string | string[]> = { ...PREVIEW_SECURITY_HEADERS }
  const blocked = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'content-security-policy',
    'content-security-policy-report-only',
    'x-frame-options',
    'cache-control',
    'x-content-type-options',
    'referrer-policy',
    'permissions-policy',
  ])
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue
    const lower = name.toLowerCase()
    if (blocked.has(lower) || lower.startsWith('x-openclaude-') || lower.startsWith('x-oc-')) {
      continue
    }
    if (lower === 'location') {
      const raw = Array.isArray(value) ? value[0] : value
      if (!raw) continue
      let location: URL
      try {
        location = new URL(raw, targetUrl)
      } catch {
        return null
      }
      if (location.origin !== new URL(targetUrl).origin) return null
      out.location = location.pathname + location.search + location.hash
      continue
    }
    if (lower === 'set-cookie') {
      const cookies = (Array.isArray(value) ? value : [value])
        .map(sanitizeAppSetCookie)
        .filter((cookie): cookie is string => cookie !== null)
      if (cookies.length > 0) out['set-cookie'] = cookies
      continue
    }
    out[name] = value
  }
  Object.assign(out, PREVIEW_SECURITY_HEADERS)
  out['Content-Security-Policy'] = `frame-ancestors ${parentOrigin}`
  return out
}

function sanitizeAppSetCookie(raw: string): string | null {
  if (/[\r\n]/.test(raw)) return null
  const first = raw.split(';', 1)[0] ?? ''
  if (first.slice(0, first.indexOf('=')).trim() === CONTAINER_PREVIEW_DIRECT_COOKIE) return null
  const parts = raw
    .split(';')
    .map((part) => part.trim())
    .filter(
      (part, index) =>
        index === 0 || !/^(?:domain\s*=|samesite\s*=|secure$|partitioned$)/i.test(part),
    )
  if (!parts[0]?.includes('=')) return null
  // The app is rendered in a cross-site iframe. Re-scope its cookies to the
  // one-off preview partition so ordinary local auth/session flows still work
  // without ever becoming unpartitioned third-party state.
  return `${parts.join('; ')}; Secure; SameSite=None; Partitioned`
}

function sanitizeUpgradeResponseHeaders(rawHeaders: string[]): string | null {
  const lines: string[] = []
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]!
    const value = rawHeaders[index + 1]!
    if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) return null
    const lower = name.toLowerCase()
    if (lower.startsWith('x-openclaude-') || lower.startsWith('x-oc-')) continue
    if (lower === 'set-cookie') {
      const cookie = sanitizeAppSetCookie(value)
      if (cookie) lines.push(`${name}: ${cookie}`)
      continue
    }
    lines.push(`${name}: ${value}`)
  }
  return `${lines.join('\r\n')}\r\n`
}

function isServiceWorkerRequest(req: IncomingMessage): boolean {
  return (
    req.headers['service-worker'] === 'script' || req.headers['sec-fetch-dest'] === 'serviceworker'
  )
}

function serveBridgeScript(res: ServerResponse, parentOrigin: string): void {
  const body = Buffer.from(directBridgeScript(parentOrigin), 'utf8')
  res.writeHead(200, {
    ...PREVIEW_SECURITY_HEADERS,
    'Content-Security-Policy': `frame-ancestors ${parentOrigin}`,
    'Content-Type': 'application/javascript; charset=utf-8',
    'Content-Length': String(body.length),
  })
  res.end(body)
}

function directBridgeScript(parentOrigin: string): string {
  return `(()=>{'use strict';const P=${JSON.stringify(parentOrigin)},S='oc-direct-preview-v1';let rev=0;
const post=(m)=>{try{parent.postMessage({source:S,...m},P)}catch{}};
const text=(e)=>String((e&&((e.getAttribute&&e.getAttribute('aria-label'))||e.innerText||e.textContent))||'').trim().replace(/\\s+/g,' ').slice(0,160);
const esc=(v)=>globalThis.CSS&&CSS.escape?CSS.escape(v):String(v).replace(/[^a-zA-Z0-9_-]/g,c=>'\\\\'+c);
const selector=(e)=>{if(e.id)return '#'+esc(e.id);const a=['data-testid','data-test','name','aria-label'];for(const k of a){const v=e.getAttribute&&e.getAttribute(k);if(v)return e.tagName.toLowerCase()+'['+k+'="'+String(v).replace(/["\\\\]/g,'\\\\$&')+'"]'}let n=e,p=[];for(let d=0;n&&n.nodeType===1&&d<6;d++,n=n.parentElement){let q=n.tagName.toLowerCase();const par=n.parentElement;if(par){const same=[...par.children].filter(x=>x.tagName===n.tagName);if(same.length>1)q+=':nth-of-type('+(same.indexOf(n)+1)+')'}p.unshift(q)}return p.join(' > ')};
const describe=(e)=>{if(!e||e===document.documentElement||e===document.body)return null;const r=e.getBoundingClientRect();return{selector:selector(e),tag:e.tagName.toLowerCase(),...(e.getAttribute('role')?{role:e.getAttribute('role')} :{}),...(e.getAttribute('aria-label')?{ariaLabel:e.getAttribute('aria-label')} :{}),...(text(e)?{text:text(e)}:{}),bounds:{x:r.x,y:r.y,width:r.width,height:r.height}}};
const navigation=()=>post({type:'preview.navigation',url:location.href,title:document.title,pageRevision:++rev});
for(const k of ['pushState','replaceState']){const f=history[k];history[k]=function(...a){const r=f.apply(this,a);queueMicrotask(navigation);return r}}
addEventListener('popstate',navigation);addEventListener('hashchange',navigation);
addEventListener('message',(e)=>{if(e.origin!==P||e.source!==parent)return;const w=e.data;if(!w||w.source!==S||!w.message||typeof w.message.type!=='string')return;const m=w.message;try{switch(m.type){case'preview.navigate':if(m.action==='back')history.back();else if(m.action==='forward')history.forward();else if(m.action==='reload')location.reload();break;case'preview.select':if(Number.isFinite(m.x)&&Number.isFinite(m.y))post({type:'preview.selection',target:describe(document.elementFromPoint(m.x,m.y))});break;case'preview.resolve':if(typeof m.selector==='string'&&m.selector.length<=512){let el=null;try{el=document.querySelector(m.selector)}catch{}post({type:'preview.resolved',selector:m.selector,target:describe(el)})}break;case'preview.wheel':if(Number.isFinite(m.deltaX)&&Number.isFinite(m.deltaY))scrollBy({left:m.deltaX,top:m.deltaY,behavior:'auto'});break;case'preview.text':if(typeof m.text==='string'&&m.text.length<=2000){const el=document.activeElement;if(el&&('value'in el)){const v=String(el.value||''),s=Number.isInteger(el.selectionStart)?el.selectionStart:v.length,t=Number.isInteger(el.selectionEnd)?el.selectionEnd:s;el.value=v.slice(0,s)+m.text+v.slice(t);el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:m.text}))}else if(el&&el.isContentEditable){document.execCommand('insertText',false,m.text)}}break;}}catch{}});
const ready=()=>post({type:'preview.ready',protocolVersion:1,url:location.href,title:document.title,viewport:{width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio,isMobile:innerWidth<600}});
if(document.readyState==='loading')addEventListener('DOMContentLoaded',ready,{once:true});else queueMicrotask(ready);
})();`
}

function sendPreviewText(
  res: ServerResponse,
  status: number,
  message: string,
  parentOrigin: string,
): void {
  if (res.headersSent || res.writableEnded) return
  const body = Buffer.from(message, 'utf8')
  res.writeHead(status, {
    ...PREVIEW_SECURITY_HEADERS,
    'Content-Security-Policy': `frame-ancestors ${parentOrigin}`,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(body.length),
  })
  res.end(body)
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  const phrase =
    status === 400
      ? 'Bad Request'
      : status === 401
        ? 'Unauthorized'
        : status === 404
          ? 'Not Found'
          : status === 405
            ? 'Method Not Allowed'
            : status === 429
              ? 'Too Many Requests'
              : 'Bad Gateway'
  const body = Buffer.from(message, 'utf8')
  try {
    socket.write(
      `HTTP/1.1 ${status} ${phrase}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${body.length}\r\n\r\n`,
    )
    socket.write(body)
  } finally {
    socket.destroy()
  }
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)))
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
