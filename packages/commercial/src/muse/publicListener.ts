// Muse media bridge — direct public HTTPS listener (OCV5-561 follow-up).
//
// The Muse VM's egress IP is blocked by Cloudflare's edge in front of the Quick Tunnel ("Your
// request was blocked."), so the bridge needs an entrance that does not go through Cloudflare.
// This listener serves only `/api/muse-bridge/*` (same handler, same token auth and lockout as
// the main router) on its own port with an existing certificate; every other path answers 404.
// It never touches the ChatGPT proxy listener: it only reads the same certificate files, and
// re-reads them when their mtime changes (certbot renewal).
//
// Off unless OC_MUSE_PUBLIC_PORT is set (and the bridge itself is enabled). A bad config or a
// failed listen is logged and leaves the listener off; master boot never fails because of it.

import { readFileSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { type Server as HttpsServer, createServer as createHttpsServer } from 'node:https'
import type { Socket } from 'node:net'

import type { CommercialConfig } from '../config.js'
import { sendJson, setSecurityHeaders } from '../http/util.js'
import { type Logger, rootLogger } from '../logging/logger.js'
import type { MuseBridgeHttpHandler } from './bridgeHttp.js'
import { POLL_HOLD_SEC } from './protocol.js'

const BRIDGE_PREFIX = '/api/muse-bridge/'
const HEADERS_TIMEOUT_MS = 15_000
// Long-poll holds POLL_HOLD_SEC; a 4 MiB chunk PUT from a slow VM link gets the rest.
const REQUEST_TIMEOUT_MS = Math.max(120_000, (POLL_HOLD_SEC + 30) * 1000)
const CERT_RELOAD_MS = 60 * 60_000

export interface MusePublicConfig {
  port: number
  bind: string
  certPath: string
  keyPath: string
}

/** null = off; { error } = set but unusable (logged by the caller, listener stays off). */
export function readMusePublicConfig(
  cfg: Pick<
    CommercialConfig,
    'OC_MUSE_PUBLIC_PORT' | 'OC_MUSE_PUBLIC_TLS_CERT' | 'OC_MUSE_PUBLIC_TLS_KEY'
  >,
): MusePublicConfig | { error: string } | null {
  if (cfg.OC_MUSE_PUBLIC_PORT === undefined) return null
  if (!cfg.OC_MUSE_PUBLIC_TLS_CERT || !cfg.OC_MUSE_PUBLIC_TLS_KEY) {
    return {
      error:
        'OC_MUSE_PUBLIC_TLS_CERT and OC_MUSE_PUBLIC_TLS_KEY are required with OC_MUSE_PUBLIC_PORT',
    }
  }
  return {
    port: cfg.OC_MUSE_PUBLIC_PORT,
    bind: '0.0.0.0',
    certPath: cfg.OC_MUSE_PUBLIC_TLS_CERT,
    keyPath: cfg.OC_MUSE_PUBLIC_TLS_KEY,
  }
}

export interface MusePublicListenerDeps extends MusePublicConfig {
  handler: MuseBridgeHttpHandler
  logger?: Logger
  /** Tests: shorter cert re-read and EADDRINUSE retry intervals. */
  certReloadMs?: number
  retryMs?: number
  maxWaitMs?: number
}

export interface MusePublicListener {
  /** Resolves with the bound port once listening, or null when it gave up (logged). */
  readonly ready: Promise<number | null>
  close(): Promise<void>
}

interface TlsMaterial {
  cert: Buffer
  key: Buffer
  mtimeMs: number
}

function readTls(certPath: string, keyPath: string): TlsMaterial {
  return {
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
    mtimeMs: Math.max(statSync(certPath).mtimeMs, statSync(keyPath).mtimeMs),
  }
}

/** Direct listener: the TCP peer is the client. X-Forwarded-For is never trusted here. */
function peerIp(req: IncomingMessage): string {
  return (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '')
}

function notFound(res: ServerResponse): void {
  sendJson(
    res,
    404,
    { error: { code: 'NOT_FOUND', message: 'not found' } },
    { Connection: 'close' },
  )
}

/** Throws only when the certificate cannot be read at start. */
export function startMusePublicListener(deps: MusePublicListenerDeps): MusePublicListener {
  const log = (deps.logger ?? rootLogger).child({ subsys: 'musePublicListener' })
  let tls = readTls(deps.certPath, deps.keyPath)
  const server: HttpsServer = createHttpsServer({ cert: tls.cert, key: tls.key })
  server.headersTimeout = HEADERS_TIMEOUT_MS
  server.requestTimeout = REQUEST_TIMEOUT_MS
  server.keepAliveTimeout = 5_000

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    let path: string
    try {
      path = new URL(req.url ?? '/', 'http://x.invalid').pathname
    } catch {
      path = ''
    }
    if (!path.startsWith(BRIDGE_PREFIX)) {
      setSecurityHeaders(res)
      notFound(res)
      return
    }
    deps.handler(req, res, { clientIp: peerIp(req) }).catch((err: unknown) => {
      log.error('muse_public_handler_failed', { err: (err as Error)?.message ?? String(err) })
      if (!res.headersSent) {
        sendJson(res, 500, { error: { code: 'INTERNAL', message: 'internal error' } })
      } else {
        res.destroy()
      }
    })
  })
  server.on('clientError', (_err, socket) => socket.destroy())
  // Every raw TCP socket, including ones still before or inside the TLS handshake, which
  // closeAllConnections() does not see: close() must not wait on them past systemd's stop timeout.
  const sockets = new Set<Socket>()
  server.on('connection', (socket: Socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  // An unhandled 'error' on a server would take the whole master down.
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (server.listening)
      log.error('muse_public_server_error', { err: err?.message ?? String(err) })
  })

  let reloadTimer: ReturnType<typeof setInterval> | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let closing = false

  function maybeReloadCert(): void {
    try {
      const next = readTls(deps.certPath, deps.keyPath)
      if (next.mtimeMs === tls.mtimeMs) return
      server.setSecureContext({ cert: next.cert, key: next.key })
      tls = next
      log.info('muse_public_tls_reloaded', {})
    } catch (err) {
      // Keep serving the certificate already loaded.
      log.warn('muse_public_tls_reload_failed', { err: (err as Error)?.message ?? String(err) })
    }
  }

  const retryMs = deps.retryMs ?? 2_000
  const deadline = Date.now() + (deps.maxWaitMs ?? 10 * 60_000)
  const ready = new Promise<number | null>((resolve) => {
    const attempt = () => {
      retryTimer = null
      if (closing) return resolve(null)
      const onError = (err: NodeJS.ErrnoException) => {
        // The previous master may still hold the port during a restart.
        if (err?.code === 'EADDRINUSE' && !closing && Date.now() < deadline) {
          log.warn('muse_public_port_busy_retry', { port: deps.port, retryMs })
          retryTimer = setTimeout(attempt, retryMs)
          return
        }
        log.error('muse_public_listen_failed', {
          port: deps.port,
          err: err?.message ?? String(err),
        })
        resolve(null)
      }
      server.once('error', onError)
      server.listen(deps.port, deps.bind, () => {
        server.off('error', onError)
        const address = server.address()
        const port = typeof address === 'object' && address ? address.port : deps.port
        reloadTimer = setInterval(maybeReloadCert, deps.certReloadMs ?? CERT_RELOAD_MS)
        reloadTimer.unref?.()
        log.info('muse_public_listening', { bind: deps.bind, port })
        resolve(port)
      })
    }
    attempt()
  })

  return {
    ready,
    close(): Promise<void> {
      closing = true
      if (reloadTimer) clearInterval(reloadTimer)
      if (retryTimer) clearTimeout(retryTimer)
      reloadTimer = retryTimer = null
      if (!server.listening) return Promise.resolve()
      return new Promise((resolve) => {
        server.close(() => resolve())
        // Held long-polls and half-open TLS handshakes would otherwise keep close() waiting.
        server.closeAllConnections()
        for (const socket of sockets) socket.destroy()
        sockets.clear()
      })
    },
  }
}

/** Assemble-time wrapper: never throws; returns a closer or undefined when off/failed. */
export function startMusePublicFromConfig(
  cfg: Parameters<typeof readMusePublicConfig>[0],
  handler: MuseBridgeHttpHandler,
): (() => Promise<void>) | undefined {
  const conf = readMusePublicConfig(cfg)
  if (conf === null) return undefined
  if ('error' in conf) {
    rootLogger.error('muse_public_disabled', { err: conf.error })
    return undefined
  }
  try {
    const listener = startMusePublicListener({ ...conf, handler })
    return () => listener.close()
  } catch (err) {
    rootLogger.error('muse_public_disabled', { err: (err as Error)?.message ?? String(err) })
    return undefined
  }
}
