#!/usr/bin/env node
/**
 * OCV5-854: Lightweight zero-dependency local HTTP + WebSocket frontdoor for
 * V5 selfhost blue-green Master slots (A=18791 / B=18795 behind 127.0.0.1:18790).
 *
 * Design invariants:
 * - Zero external dependencies (pure Node ESM).
 * - Never buffers WebSocket frames or HTTP request bodies (pauses incoming req
 *   only during TCP connect/retry, then streams directly once connected).
 * - Atomic state persistence (tmp + fsync + rename) via OC_FRONTDOOR_STATE_FILE.
 * - Control Unix socket (0600): GET /status, POST /switch {"slot":"A"|"B"}.
 * - Bounded connect retry (ECONNREFUSED / ECONNRESET / EPIPE, default 2000ms,
 *   100->200->400ms) that re-reads the active slot on every attempt and aborts
 *   immediately on client disconnect.
 */
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const VALID_SLOTS = new Set(['A', 'B'])
const RETRYABLE_CONNECT_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE'])
const BACKOFF_STEPS_MS = [100, 200, 400]
const MAX_CONTROL_BODY_BYTES = 16 * 1024

/**
 * One-shot HTTP agent that hands an already-connected net.Socket directly to
 * Node's ClientRequest (prevents double-dialing and enforces single-use cleanup).
 */
class SingleSocketAgent extends http.Agent {
  constructor(socket) {
    super({ keepAlive: false, maxSockets: 1 })
    this._socket = socket
    this._used = false
  }
  createConnection(_options, cb) {
    if (this._used) {
      const err = Object.assign(new Error('SingleSocketAgent socket already consumed'), { code: 'SINGLE_SOCKET_REUSE' })
      if (typeof cb === 'function') { cb(err); return }
      throw err
    }
    this._used = true
    if (typeof cb === 'function') { cb(null, this._socket); return }
    return this._socket
  }
}

function parsePort(raw, fallback) {
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : fallback
}

function parsePositiveMs(raw, fallback) {
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

function readPersistedSlot(stateFile, log) {
  if (!stateFile) return 'A'
  try {
    const raw = fs.readFileSync(stateFile, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && VALID_SLOTS.has(parsed.slot)) return parsed.slot
    log.warn(`invalid state file slot in ${stateFile}; defaulting to A`)
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      log.warn(`failed reading ${stateFile}: ${err.message}; defaulting to A`)
    }
  }
  return 'A'
}

function writeStateAtomic(stateFile, payload) {
  if (!stateFile) return
  const dir = path.dirname(stateFile)
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 })
  const tmp = `${stateFile}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`
  const data = `${JSON.stringify(payload, null, 2)}\n`
  let fd = -1
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o644)
    fs.writeSync(fd, data, 0, 'utf8')
    fs.fsyncSync(fd)
  } finally {
    if (fd >= 0) fs.closeSync(fd)
  }
  try {
    fs.renameSync(tmp, stateFile)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    throw err
  }
  try {
    const dirFd = fs.openSync(dir, fs.constants.O_RDONLY)
    try { fs.fsyncSync(dirFd) } finally { fs.closeSync(dirFd) }
  } catch { /* best-effort dir fsync */ }
}

function buildUpgradeRequestHead(req) {
  const lines = [`${req.method || 'GET'} ${req.url || '/'} HTTP/${req.httpVersion || '1.1'}`]
  const raw = req.rawHeaders || []
  for (let i = 0; i < raw.length; i += 2) {
    lines.push(`${raw[i]}: ${raw[i + 1] ?? ''}`)
  }
  return `${lines.join('\r\n')}\r\n\r\n`
}

function readSmallJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_CONTROL_BODY_BYTES) {
        reject(Object.assign(new Error('body too large'), { statusCode: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (size === 0) return resolve({})
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {})
      } catch {
        reject(Object.assign(new Error('invalid json'), { statusCode: 400 }))
      }
    })
    req.on('error', reject)
  })
}

export async function startFrontdoor(options = {}) {
  const env = options.env || process.env
  const log = options.logger || {
    info: (m) => console.log(`${new Date().toISOString()} [frontdoor] ${m}`),
    warn: (m) => console.warn(`${new Date().toISOString()} [frontdoor] WARN ${m}`),
    error: (m) => console.error(`${new Date().toISOString()} [frontdoor] ERROR ${m}`),
  }

  const listenHost = options.host ?? (env.OC_FRONTDOOR_HOST || '127.0.0.1')
  const listenPort = options.port ?? parsePort(env.OC_FRONTDOOR_PORT, 18790)
  const controlSocket = options.controlSocket ?? (env.OC_FRONTDOOR_CONTROL_SOCKET || '/run/openclaude-v5-selfhost/frontdoor.sock')
  const stateFile = options.stateFile ?? (env.OC_FRONTDOOR_STATE_FILE || '/var/lib/openclaude-v5-selfhost/frontdoor-state.json')
  const retryBudgetMs = options.retryBudgetMs ?? parsePositiveMs(env.OC_FRONTDOOR_RETRY_BUDGET_MS, 2000)

  const upstreams = {
    A: {
      host: options.slotAHost ?? (env.OC_FRONTDOOR_SLOT_A_HOST || '127.0.0.1'),
      port: options.slotAPort ?? parsePort(env.OC_FRONTDOOR_SLOT_A_PORT, 18791),
    },
    B: {
      host: options.slotBHost ?? (env.OC_FRONTDOOR_SLOT_B_HOST || '127.0.0.1'),
      port: options.slotBPort ?? parsePort(env.OC_FRONTDOOR_SLOT_B_PORT, 18795),
    },
  }

  let activeSlot = options.initialSlot && VALID_SLOTS.has(options.initialSlot)
    ? options.initialSlot
    : readPersistedSlot(stateFile, log)
  let generation = 1
  let switchedAt = new Date().toISOString()
  let closing = false
  let activeHttpRequests = 0
  let activeUpgrades = 0
  const pendingCleanups = new Set()
  const liveSockets = new Set()

  function trackSocket(sock) {
    liveSockets.add(sock)
    sock.once('close', () => liveSockets.delete(sock))
  }

  function connectUpstreamWithRetry(onClientAbortRegister) {
    return new Promise((resolve, reject) => {
      const deadlineMs = Date.now() + retryBudgetMs
      let attempt = 0
      let settled = false
      let retryTimer = null
      let hardTimer = null
      let curSock = null

      const clearTimers = () => {
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
        if (hardTimer) { clearTimeout(hardTimer); hardTimer = null }
      }

      const abort = (reason) => {
        if (settled) return
        settled = true
        pendingCleanups.delete(cleanup)
        clearTimers()
        if (curSock && !curSock.destroyed) curSock.destroy()
        curSock = null
        reject(reason || Object.assign(new Error('client aborted'), { code: 'CLIENT_ABORTED' }))
      }

      const cleanup = () => abort(Object.assign(new Error('frontdoor closing'), { code: 'FRONTDOOR_CLOSING' }))
      pendingCleanups.add(cleanup)
      const unregisterAbort = onClientAbortRegister(abort)

      const finish = (fn, val) => {
        if (settled) return
        settled = true
        pendingCleanups.delete(cleanup)
        unregisterAbort()
        clearTimers()
        fn(val)
      }

      // Hard monotonic deadline covering both pending TCP dial and retry backoff (N02).
      hardTimer = setTimeout(() => {
        hardTimer = null
        if (curSock && !curSock.destroyed) curSock.destroy()
        curSock = null
        finish(reject, Object.assign(new Error('upstream connect deadline exceeded'), { code: 'ETIMEDOUT' }))
      }, Math.max(1, retryBudgetMs))

      const dial = () => {
        if (settled || closing) return cleanup()
        const remaining = deadlineMs - Date.now()
        if (remaining <= 0) {
          return finish(reject, Object.assign(new Error('upstream connect deadline exceeded'), { code: 'ETIMEDOUT' }))
        }
        const slot = activeSlot
        const target = upstreams[slot]
        const sock = typeof options.dialUpstream === 'function'
          ? options.dialUpstream(target)
          : net.connect({ host: target.host, port: target.port })
        if (typeof sock.setNoDelay === 'function') sock.setNoDelay(true)
        curSock = sock

        const onConnect = () => {
          sock.off('error', onError)
          if (typeof sock.setTimeout === 'function') sock.setTimeout(0)
          curSock = null
          finish(resolve, { socket: sock, slot, target })
        }

        const onError = (err) => {
          sock.off('connect', onConnect)
          curSock = null
          try { sock.destroy() } catch { /* ignore */ }
          const remAfterErr = deadlineMs - Date.now()
          const retryable = err && RETRYABLE_CONNECT_CODES.has(err.code)
          if (retryable && !closing && remAfterErr > 0) {
            const stepDelay = BACKOFF_STEPS_MS[Math.min(attempt, BACKOFF_STEPS_MS.length - 1)]
            const waitMs = Math.min(stepDelay, remAfterErr)
            attempt += 1
            if (waitMs > 0) {
              retryTimer = setTimeout(() => { retryTimer = null; dial() }, waitMs)
              return
            }
          }
          finish(reject, err)
        }

        if (typeof sock.setTimeout === 'function') {
          sock.setTimeout(Math.max(1, remaining), () => {
            sock.destroy(Object.assign(new Error('upstream dial timeout'), { code: 'ETIMEDOUT' }))
          })
        }
        sock.once('connect', onConnect)
        sock.once('error', onError)
      }

      dial()
    })
  }

  const proxyServer = http.createServer((req, res) => {
    activeHttpRequests += 1
    let done = false
    const dec = () => {
      if (done) return
      done = true
      activeHttpRequests -= 1
    }
    res.once('finish', dec)
    res.once('close', dec)

    // Pause incoming request while establishing upstream TCP so body is never buffered in RAM.
    req.pause()

    connectUpstreamWithRetry((abort) => {
      const onClose = () => { if (!res.writableEnded) abort() }
      req.once('aborted', onClose)
      res.once('close', onClose)
      return () => {
        req.off('aborted', onClose)
        res.off('close', onClose)
      }
    }).then(({ socket: upstreamSock, target }) => {
      if (req.destroyed || res.destroyed || res.writableEnded) {
        upstreamSock.destroy()
        return
      }
      trackSocket(upstreamSock)
      const singleAgent = new SingleSocketAgent(upstreamSock)
      const upstreamHeaders = { ...req.headers, connection: 'close' }

      const proxyReq = http.request({
        host: target.host,
        port: target.port,
        method: req.method,
        path: req.url,
        headers: upstreamHeaders,
        agent: singleAgent,
      }, (proxyRes) => {
        if (res.destroyed || res.writableEnded) {
          proxyRes.resume()
          if (!upstreamSock.destroyed) upstreamSock.destroy()
          return
        }
        res.writeHead(proxyRes.statusCode || 502, proxyRes.statusMessage, proxyRes.rawHeaders)
        proxyRes.pipe(res)
        proxyRes.once('end', () => {
          if (!upstreamSock.destroyed) upstreamSock.end()
        })
        proxyRes.once('error', () => {
          if (!res.destroyed) res.destroy()
          if (!upstreamSock.destroyed) upstreamSock.destroy()
        })
      })

      proxyReq.once('error', (err) => {
        if (!upstreamSock.destroyed) upstreamSock.destroy()
        if (!res.headersSent && !res.destroyed) {
          res.writeHead(502, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'FRONTDOOR_UPSTREAM_ERROR', code: err?.code || 'UPSTREAM_ERROR' }))
        } else if (!res.destroyed) {
          res.destroy()
        }
      })

      const onClientAbort = () => {
        if (!proxyReq.destroyed) proxyReq.destroy()
        if (!upstreamSock.destroyed) upstreamSock.destroy()
      }
      req.once('aborted', onClientAbort)
      res.once('close', () => {
        if (!res.writableEnded) {
          if (!proxyReq.destroyed) proxyReq.destroy()
          if (!upstreamSock.destroyed) upstreamSock.destroy()
        }
      })

      if (req.readableEnded) {
        proxyReq.end()
      } else {
        req.pipe(proxyReq)
        req.resume()
      }
    }).catch((err) => {
      if (err && (err.code === 'CLIENT_ABORTED' || err.code === 'FRONTDOOR_CLOSING')) return
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'FRONTDOOR_UPSTREAM_UNAVAILABLE', code: err?.code || 'CONNECT_FAILED' }))
      }
    })
  })

  proxyServer.on('connection', (sock) => {
    sock.setNoDelay(true)
    trackSocket(sock)
  })

  proxyServer.on('upgrade', (req, clientSocket, head) => {
    activeUpgrades += 1
    let decDone = false
    const dec = () => {
      if (decDone) return
      decDone = true
      activeUpgrades -= 1
    }
    clientSocket.once('close', dec)
    clientSocket.pause()

    connectUpstreamWithRetry((abort) => {
      const onClose = () => abort()
      clientSocket.once('close', onClose)
      clientSocket.once('error', onClose)
      return () => {
        clientSocket.off('close', onClose)
        clientSocket.off('error', onClose)
      }
    }).then(({ socket: upstreamSock }) => {
      if (clientSocket.destroyed) {
        upstreamSock.destroy()
        return
      }
      trackSocket(upstreamSock)

      const teardown = () => {
        if (!clientSocket.destroyed) clientSocket.destroy()
        if (!upstreamSock.destroyed) upstreamSock.destroy()
      }
      clientSocket.once('error', teardown)
      upstreamSock.once('error', teardown)
      clientSocket.once('close', () => { if (!upstreamSock.destroyed) upstreamSock.destroy() })
      upstreamSock.once('close', () => { if (!clientSocket.destroyed) clientSocket.destroy() })

      upstreamSock.write(buildUpgradeRequestHead(req))
      if (head && head.length > 0) upstreamSock.write(head)
      clientSocket.pipe(upstreamSock)
      upstreamSock.pipe(clientSocket)
      clientSocket.resume()
    }).catch((err) => {
      if (err && err.code === 'CLIENT_ABORTED') return
      if (!clientSocket.destroyed) {
        try {
          clientSocket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        } catch { /* ignore */ }
        clientSocket.destroy()
      }
    })
  })

  const controlServer = http.createServer((req, res) => {
    const urlPath = (req.url || '/').split('?')[0]
    const sendJson = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    if (req.method === 'GET' && urlPath === '/status') {
      const addr = proxyServer.address()
      return sendJson(200, {
        ok: true,
        slot: activeSlot,
        generation,
        switchedAt,
        listen: typeof addr === 'object' && addr ? { host: addr.address, port: addr.port } : { host: listenHost, port: listenPort },
        upstreams,
        activeHttpRequests,
        activeUpgrades,
      })
    }

    if (req.method === 'POST' && urlPath === '/switch') {
      void readSmallJson(req).then((body) => {
        const nextSlot = typeof body.slot === 'string' ? body.slot.trim().toUpperCase() : ''
        if (!VALID_SLOTS.has(nextSlot)) {
          return sendJson(400, { ok: false, error: 'INVALID_SLOT', allowed: ['A', 'B'] })
        }
        const previousSlot = activeSlot
        const nextGen = generation + 1
        const nowIso = new Date().toISOString()
        try {
          writeStateAtomic(stateFile, {
            slot: nextSlot,
            previousSlot,
            generation: nextGen,
            switchedAt: nowIso,
          })
        } catch (err) {
          log.error(`state persist failed: ${err.message}`)
          return sendJson(500, { ok: false, error: 'STATE_PERSIST_FAILED', message: err.message })
        }
        activeSlot = nextSlot
        generation = nextGen
        switchedAt = nowIso
        log.info(`switched active slot ${previousSlot} -> ${activeSlot} (gen=${generation})`)
        return sendJson(200, {
          ok: true,
          slot: activeSlot,
          previousSlot,
          generation,
          switchedAt,
          upstream: upstreams[activeSlot],
        })
      }).catch((err) => {
        sendJson(err?.statusCode || 400, { ok: false, error: err?.message || 'BAD_REQUEST' })
      })
      return
    }

    sendJson(404, { ok: false, error: 'NOT_FOUND' })
  })

  await new Promise((resolve, reject) => {
    proxyServer.once('error', reject)
    proxyServer.listen(listenPort, listenHost, () => {
      proxyServer.off('error', reject)
      resolve()
    })
  })

  if (controlSocket) {
    fs.mkdirSync(path.dirname(controlSocket), { recursive: true, mode: 0o750 })
    try { fs.rmSync(controlSocket, { force: true }) } catch { /* ignore */ }
    await new Promise((resolve, reject) => {
      controlServer.once('error', reject)
      controlServer.listen(controlSocket, () => {
        controlServer.off('error', reject)
        try { fs.chmodSync(controlSocket, 0o600) } catch { /* ignore */ }
        resolve()
      })
    })
  }

  const bound = proxyServer.address()
  const actualPort = typeof bound === 'object' && bound ? bound.port : listenPort
  log.info(`listening on ${listenHost}:${actualPort} control=${controlSocket} slot=${activeSlot} A=${upstreams.A.port} B=${upstreams.B.port}`)

  async function close() {
    if (closing) return
    closing = true
    for (const fn of [...pendingCleanups]) fn()
    const closers = [
      new Promise((resolve) => proxyServer.close(() => resolve())),
      new Promise((resolve) => controlServer.close(() => resolve())),
    ]
    if (typeof proxyServer.closeIdleConnections === 'function') proxyServer.closeIdleConnections()
    if (typeof controlServer.closeAllConnections === 'function') controlServer.closeAllConnections()
    for (const s of liveSockets) {
      try { s.destroy() } catch { /* ignore */ }
    }
    await Promise.all(closers)
    if (controlSocket) {
      try { fs.rmSync(controlSocket, { force: true }) } catch { /* ignore */ }
    }
  }

  return {
    port: actualPort,
    host: listenHost,
    controlSocket,
    stateFile,
    getSlot: () => activeSlot,
    close,
  }
}

function isMainEntry() {
  if (!process.argv[1]) return false
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(process.argv[1]))
  } catch {
    return false
  }
}

if (isMainEntry()) {
  startFrontdoor().then((fd) => {
    let shuttingDown = false
    const onSignal = (sig) => {
      if (shuttingDown) return
      shuttingDown = true
      console.log(`${new Date().toISOString()} [frontdoor] received ${sig}, shutting down`)
      const forceTimer = setTimeout(() => process.exit(0), 5000)
      forceTimer.unref()
      fd.close().finally(() => process.exit(0))
    }
    process.on('SIGTERM', () => onSignal('SIGTERM'))
    process.on('SIGINT', () => onSignal('SIGINT'))
  }).catch((err) => {
    console.error(`[frontdoor] fatal startup error: ${err?.stack || err}`)
    process.exit(1)
  })
}
