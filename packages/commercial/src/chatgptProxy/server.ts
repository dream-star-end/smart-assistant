/**
 * ChatGPT direct-connect proxy: public TLS listener accepting authenticated
 * `CONNECT host:443` for allowlisted ChatGPT domains, chained into the platform
 * subscription egress (an HTTP CONNECT proxy on the host).
 *
 * Deliberately narrow:
 *   - CONNECT only, port 443 only, host allowlist from @openclaude/protocol.
 *   - Basic auth `u<uid>:<secret>` verified against chatgpt_proxy_credentials,
 *     then entitlement (settings switch + admin/allowlist) re-checked per tunnel.
 *   - Plain HTTP requests: only `GET /pac` (PAC script) and `GET /healthz`.
 *   - Never forwards non-CONNECT traffic, never logs payload bytes.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { connect as netConnect, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { readFileSync, statSync } from 'node:fs'

import {
  CHATGPT_PROXY_ALLOWED_PORT,
  CHATGPT_PROXY_PAC_PATH,
  buildChatGptPac,
  isChatGptProxyAllowedHost,
  parseChatGptProxyConnectTarget,
  parseChatGptProxyUsername,
} from '@openclaude/protocol/chatgptProxy'

import type { Logger } from '../logging/logger.js'

const MAX_TUNNELS_PER_USER = 64
const MAX_TUNNELS_GLOBAL = 2_048
const TUNNEL_IDLE_MS = 5 * 60_000
const UPSTREAM_CONNECT_TIMEOUT_MS = 10_000
const AUTH_FAIL_WINDOW_MS = 60_000
const AUTH_FAIL_LIMIT_PER_IP = 20
const AUTH_FAIL_MAP_CAP = 10_000
const CERT_RELOAD_INTERVAL_MS = 60 * 60_000
const HEADERS_TIMEOUT_MS = 15_000
const REALM = 'Basic realm="OpenClaude ChatGPT", charset="UTF-8"'

export interface ChatGptProxyEntitlement {
  /** settings switch on (env is checked before the server is even created). */
  assembled: boolean
  allowlist: readonly number[]
}

export interface ChatGptProxyServerDeps {
  publicHost: string
  port: number
  tlsCertPath: string
  tlsKeyPath: string
  /** Upstream HTTP CONNECT proxy, e.g. http://127.0.0.1:18991 */
  upstream: URL
  verifyCredential(uid: number, secret: string): Promise<boolean>
  /** Role lookup for the entitlement check; null → user unknown/inactive. */
  resolveUserRole(uid: number): Promise<'user' | 'admin' | null>
  getEntitlement(): Promise<ChatGptProxyEntitlement>
  onTunnelUsed?(uid: number): void
  logger?: Logger
  now?: () => number
  /** Test seam: override listen host (default 0.0.0.0). */
  listenHost?: string
}

export interface ChatGptProxyServer {
  listen(): Promise<{ port: number }>
  /**
   * Background listen that keeps retrying EADDRINUSE (deploy handoff: the
   * previous master may still hold the port). Never rejects; logs outcome.
   */
  listenWithRetry(opts?: { retryMs?: number; maxWaitMs?: number }): void
  close(): Promise<void>
  activeTunnels(): number
}

interface TlsMaterial {
  cert: Buffer
  key: Buffer
  mtimeMs: number
}

function readTls(certPath: string, keyPath: string): TlsMaterial {
  const cert = readFileSync(certPath)
  const key = readFileSync(keyPath)
  const mtimeMs = Math.max(statSync(certPath).mtimeMs, statSync(keyPath).mtimeMs)
  return { cert, key, mtimeMs }
}

export function createChatGptProxyServer(deps: ChatGptProxyServerDeps): ChatGptProxyServer {
  const log = deps.logger
  const now = deps.now ?? Date.now
  let tls = readTls(deps.tlsCertPath, deps.tlsKeyPath)
  const server: HttpsServer = createHttpsServer({ cert: tls.cert, key: tls.key })
  server.headersTimeout = HEADERS_TIMEOUT_MS
  server.requestTimeout = HEADERS_TIMEOUT_MS
  // Tunnels are long-lived; idle handling is done per tunnel below.
  server.timeout = 0
  server.keepAliveTimeout = 5_000

  const tunnels = new Set<Duplex>()
  const perUser = new Map<number, number>()
  const authFails = new Map<string, { count: number; windowStart: number }>()
  let reloadTimer: ReturnType<typeof setInterval> | null = null
  let closing = false

  // Built after listen so an ephemeral port (tests) advertises the bound port.
  let pacBody = deps.port > 0 ? buildChatGptPac(deps.publicHost, deps.port) : ''

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const path = safePath(req.url)
    if (req.method === 'GET' && path === CHATGPT_PROXY_PAC_PATH) {
      res.writeHead(200, {
        'Content-Type': 'application/x-ns-proxy-autoconfig; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(pacBody),
      })
      res.end(pacBody)
      return
    }
    if (req.method === 'GET' && path === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
      res.end('ok')
      return
    }
    res.writeHead(404, { 'Content-Type': 'text/plain', Connection: 'close' })
    res.end('not found')
  })

  server.on('connect', (req: IncomingMessage, clientSocket: Duplex, head: Buffer) => {
    void handleConnect(req, clientSocket, head).catch((err) => {
      log?.warn('chatgpt_proxy.connect_failed', { error: (err as Error)?.message ?? String(err) })
      try {
        clientSocket.destroy()
      } catch {}
    })
  })

  server.on('tlsClientError', (err, socket) => {
    // Port scanners / browsers probing with wrong SNI. Debug-level only.
    log?.debug('chatgpt_proxy.tls_client_error', {
      error: err.message,
      remote: (socket as Socket).remoteAddress,
    })
  })

  async function handleConnect(
    req: IncomingMessage,
    clientSocket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const remote = (req.socket as Socket).remoteAddress ?? 'unknown'
    if (closing) {
      rejectConnect(clientSocket, 503, 'Service Unavailable')
      return
    }
    if (isIpThrottled(remote)) {
      rejectConnect(clientSocket, 429, 'Too Many Requests')
      return
    }

    const creds = parseBasicAuth(req.headers['proxy-authorization'])
    if (!creds) {
      rejectConnect(clientSocket, 407, 'Proxy Authentication Required', {
        'Proxy-Authenticate': REALM,
      })
      return
    }
    const uid = parseChatGptProxyUsername(creds.username)
    if (uid === null || !(await deps.verifyCredential(uid, creds.password))) {
      noteAuthFail(remote)
      rejectConnect(clientSocket, 407, 'Proxy Authentication Required', {
        'Proxy-Authenticate': REALM,
      })
      return
    }

    const [entitlement, role] = await Promise.all([
      deps.getEntitlement(),
      deps.resolveUserRole(uid),
    ])
    if (
      !entitlement.assembled ||
      role === null ||
      (role !== 'admin' && !entitlement.allowlist.includes(uid))
    ) {
      log?.info('chatgpt_proxy.forbidden', {
        uid,
        reason: role === null ? 'inactive' : 'not_entitled',
      })
      rejectConnect(clientSocket, 403, 'Forbidden')
      return
    }

    const target = parseChatGptProxyConnectTarget(req.url ?? '')
    if (
      !target ||
      target.port !== CHATGPT_PROXY_ALLOWED_PORT ||
      !isChatGptProxyAllowedHost(target.host)
    ) {
      log?.info('chatgpt_proxy.target_rejected', { uid, target: bounded(req.url, 128) })
      rejectConnect(clientSocket, 403, 'Forbidden')
      return
    }

    if (tunnels.size >= MAX_TUNNELS_GLOBAL || (perUser.get(uid) ?? 0) >= MAX_TUNNELS_PER_USER) {
      rejectConnect(clientSocket, 429, 'Too Many Requests')
      return
    }

    const startedAt = now()
    const upstream = await openUpstreamTunnel(deps.upstream, target.host, target.port)
    if (clientSocket.destroyed) {
      upstream.destroy()
      return
    }

    tunnels.add(clientSocket)
    perUser.set(uid, (perUser.get(uid) ?? 0) + 1)
    deps.onTunnelUsed?.(uid)

    let bytesIn = 0
    let bytesOut = 0
    let finished = false
    const finish = (reason: string) => {
      if (finished) return
      finished = true
      tunnels.delete(clientSocket)
      const remaining = (perUser.get(uid) ?? 1) - 1
      if (remaining <= 0) perUser.delete(uid)
      else perUser.set(uid, remaining)
      try {
        upstream.destroy()
      } catch {}
      try {
        clientSocket.destroy()
      } catch {}
      log?.info('chatgpt_proxy.tunnel_closed', {
        uid,
        host: target.host,
        bytesIn,
        bytesOut,
        durationMs: now() - startedAt,
        reason,
      })
    }

    const idle = { timer: null as ReturnType<typeof setTimeout> | null }
    const touch = () => {
      if (idle.timer) clearTimeout(idle.timer)
      idle.timer = setTimeout(() => finish('idle'), TUNNEL_IDLE_MS)
      idle.timer.unref?.()
    }
    touch()

    clientSocket.on('data', (chunk: Buffer) => {
      bytesIn += chunk.length
      touch()
    })
    upstream.on('data', (chunk: Buffer) => {
      bytesOut += chunk.length
      touch()
    })
    clientSocket.once('error', () => finish('client_error'))
    upstream.once('error', () => finish('upstream_error'))
    clientSocket.once('close', () => {
      if (idle.timer) clearTimeout(idle.timer)
      finish('client_close')
    })
    upstream.once('close', () => {
      if (idle.timer) clearTimeout(idle.timer)
      finish('upstream_close')
    })

    clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: OpenClaude\r\n\r\n')
    if (head.length > 0) upstream.write(head)
    clientSocket.pipe(upstream)
    upstream.pipe(clientSocket)
  }

  function noteAuthFail(ip: string): void {
    const t = now()
    const entry = authFails.get(ip)
    if (!entry || t - entry.windowStart > AUTH_FAIL_WINDOW_MS) {
      if (authFails.size >= AUTH_FAIL_MAP_CAP) authFails.clear()
      authFails.set(ip, { count: 1, windowStart: t })
      return
    }
    entry.count += 1
  }

  function isIpThrottled(ip: string): boolean {
    const entry = authFails.get(ip)
    if (!entry) return false
    if (now() - entry.windowStart > AUTH_FAIL_WINDOW_MS) {
      authFails.delete(ip)
      return false
    }
    return entry.count >= AUTH_FAIL_LIMIT_PER_IP
  }

  function maybeReloadCert(): void {
    try {
      const next = readTls(deps.tlsCertPath, deps.tlsKeyPath)
      if (next.mtimeMs === tls.mtimeMs) return
      server.setSecureContext({ cert: next.cert, key: next.key })
      tls = next
      log?.info('chatgpt_proxy.tls_reloaded', {})
    } catch (err) {
      log?.warn('chatgpt_proxy.tls_reload_failed', {
        error: (err as Error)?.message ?? String(err),
      })
    }
  }

  const api: ChatGptProxyServer = {
    listen(): Promise<{ port: number }> {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(deps.port, deps.listenHost ?? '0.0.0.0', () => {
          server.off('error', reject)
          const address = server.address()
          const port = typeof address === 'object' && address ? address.port : deps.port
          pacBody = buildChatGptPac(deps.publicHost, port)
          reloadTimer = setInterval(maybeReloadCert, CERT_RELOAD_INTERVAL_MS)
          reloadTimer.unref?.()
          log?.info('chatgpt_proxy.listening', { host: deps.publicHost, port })
          resolve({ port })
        })
      })
    },
    listenWithRetry(opts = {}): void {
      const retryMs = opts.retryMs ?? 2_000
      const deadline = now() + (opts.maxWaitMs ?? 10 * 60_000)
      const attempt = () => {
        if (closing) return
        api.listen().catch((err: NodeJS.ErrnoException) => {
          if (err?.code === 'EADDRINUSE' && now() < deadline) {
            log?.warn('chatgpt_proxy.port_busy_retry', { port: deps.port, retryMs })
            const t = setTimeout(attempt, retryMs)
            t.unref?.()
            return
          }
          log?.error('chatgpt_proxy.listen_failed', { error: err?.message ?? String(err) })
        })
      }
      attempt()
    },
    async close(): Promise<void> {
      closing = true
      if (reloadTimer) clearInterval(reloadTimer)
      reloadTimer = null
      for (const s of tunnels) {
        try {
          s.destroy()
        } catch {}
      }
      tunnels.clear()
      perUser.clear()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    },
    activeTunnels(): number {
      return tunnels.size
    },
  }
  return api
}

/** Open a CONNECT tunnel through the upstream HTTP proxy; resolves once it answers 200. */
function openUpstreamTunnel(upstream: URL, host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({
      host: upstream.hostname,
      port: Number(upstream.port || 80),
    })
    let buffer = Buffer.alloc(0)
    let settled = false
    const timer = setTimeout(
      () => fail(new Error('upstream connect timeout')),
      UPSTREAM_CONNECT_TIMEOUT_MS,
    )
    const fail = (err: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      reject(err)
    }
    socket.once('error', fail)
    socket.once('connect', () => {
      const auth =
        upstream.username || upstream.password
          ? `Proxy-Authorization: Basic ${Buffer.from(
              `${decodeURIComponent(upstream.username)}:${decodeURIComponent(upstream.password)}`,
            ).toString('base64')}\r\n`
          : ''
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`)
    })
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      const end = buffer.indexOf('\r\n\r\n')
      if (end === -1) {
        if (buffer.length > 16 * 1024) fail(new Error('upstream response too large'))
        return
      }
      socket.off('data', onData)
      const statusLine = buffer.subarray(0, buffer.indexOf('\r\n')).toString('latin1')
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine)
      if (!m || m[1] !== '200') {
        fail(new Error(`upstream refused CONNECT: ${bounded(statusLine, 64)}`))
        return
      }
      settled = true
      clearTimeout(timer)
      socket.off('error', fail)
      const rest = buffer.subarray(end + 4)
      if (rest.length > 0) socket.unshift(rest)
      resolve(socket)
    }
    socket.on('data', onData)
  })
}

function parseBasicAuth(
  header: string | string[] | undefined,
): { username: string; password: string } | null {
  if (typeof header !== 'string' || header.length > 512) return null
  const m = /^Basic\s+([A-Za-z0-9+/=_-]+)$/i.exec(header.trim())
  if (!m) return null
  let decoded: string
  try {
    decoded = Buffer.from(m[1]!, 'base64').toString('utf8')
  } catch {
    return null
  }
  const idx = decoded.indexOf(':')
  if (idx <= 0) return null
  return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) }
}

function rejectConnect(
  socket: Duplex,
  status: number,
  reason: string,
  extraHeaders: Record<string, string> = {},
): void {
  const headers = Object.entries({
    ...extraHeaders,
    'Content-Length': '0',
    Connection: 'close',
  })
    .map(([k, v]) => `${k}: ${v}`)
    .join('\r\n')
  try {
    socket.end(`HTTP/1.1 ${status} ${reason}\r\n${headers}\r\n\r\n`)
  } catch {
    try {
      socket.destroy()
    } catch {}
  }
}

function safePath(raw: string | undefined): string {
  try {
    return new URL(raw ?? '/', 'https://proxy.invalid').pathname
  } catch {
    return raw ?? '/'
  }
}

function bounded(value: string | undefined, max: number): string {
  return (value ?? '').slice(0, max)
}
