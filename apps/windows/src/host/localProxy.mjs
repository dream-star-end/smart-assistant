import http from 'node:http'
import https from 'node:https'
import { Transform } from 'node:stream'
import { createOutboundTlsOptions, parseHttpsOrigin } from '../tunnel/bootstrap.mjs'
import {
  checkBearerToken,
  LOCAL_BRIDGE_HEADER,
} from './tokens.mjs'
import {
  closeServers,
  isLoopbackAddress,
  listenLoopbackPair,
  remoteAddressOf,
} from './loopback.mjs'

export const EGRESS_PROXY_PORT = 18791
export const MASTER_PROXY_PORT = 18792
/** Design draft does not specify a body cap; 8 MiB fail-closed. */
export const MAX_PROXY_BODY_BYTES = 8 * 1024 * 1024

export const MASTER_PATH_ALLOWLIST = Object.freeze([
  { method: 'POST', path: '/v1/messages' },
  { method: 'POST', path: '/internal/v3/server-authored-message' },
  { method: 'GET', path: '/internal/v3/turn-tape-state' },
  { method: 'POST', path: '/internal/v3/turn-lease/renew' },
  { method: 'GET', path: '/internal/v3/model-catalog' },
  { method: 'GET', path: '/internal/v3/model-catalog-epoch' },
])

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  LOCAL_BRIDGE_HEADER,
])

function pathnameOf(url) {
  try {
    return new URL(url ?? '/', 'http://127.0.0.1').pathname
  } catch {
    return '/'
  }
}

function sendJson(res, status, body) {
  const raw = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(raw.length),
    connection: 'close',
  })
  res.end(raw)
}

function allowlisted(method, path, rules) {
  const m = String(method || '').toUpperCase()
  return rules.some((rule) => rule.method === m && rule.path === path)
}

function methodAllowedOnPath(method, path, rules) {
  return rules.some((rule) => rule.path === path && rule.method === String(method || '').toUpperCase())
}

function pathKnown(path, rules) {
  return rules.some((rule) => rule.path === path)
}

function copyHeaders(src) {
  const out = {}
  for (const [key, value] of Object.entries(src || {})) {
    if (HOP_BY_HOP.has(String(key).toLowerCase())) continue
    if (value == null) continue
    out[key] = value
  }
  return out
}

function createBodyLimiter(maxBytes, onTooLarge) {
  let size = 0
  let tooLarge = false
  return new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length
      if (size > maxBytes) {
        if (!tooLarge) {
          tooLarge = true
          onTooLarge()
        }
        cb()
        return
      }
      cb(null, chunk)
    },
  })
}

function proxyHttps({ origin, tls, req, res, identity, onOutbound, onUpstreamStatus, onUpstreamError, onTooLarge }) {
  let url
  try {
    url = parseHttpsOrigin(origin, 'proxyOrigin')
  } catch (err) {
    sendJson(res, 502, { error: { code: 'BAD_ORIGIN', message: err.message } })
    return
  }
  let token
  try {
    token = identity.getToken()
  } catch {
    sendJson(res, 503, { error: { code: 'NO_SESSION', message: 'oc-v3 not minted' } })
    return
  }
  const path = req.url || '/'
  onOutbound?.({ method: req.method, path, origin: url.origin })
  const headers = copyHeaders(req.headers)
  headers.host = url.host
  headers.authorization = `Bearer ${token}`
  let tooLarge = false
  const abortTooLarge = () => {
    tooLarge = true
    try { upstream.destroy() } catch { /* */ }
    onTooLarge?.()
    if (!res.headersSent) {
      sendJson(res, 413, { error: { code: 'BODY_TOO_LARGE', message: 'request body exceeds 8 MiB' } })
    } else {
      try { res.destroy() } catch { /* */ }
    }
  }
  const limiter = createBodyLimiter(MAX_PROXY_BODY_BYTES, abortTooLarge)
  const upstream = https.request({
    hostname: url.hostname,
    port: Number(url.port) || 443,
    path,
    method: req.method,
    headers,
    servername: /^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname) ? undefined : url.hostname,
    ca: tls.ca,
    cert: tls.cert,
    key: tls.key,
    minVersion: tls.minVersion ?? 'TLSv1.3',
    maxVersion: tls.maxVersion ?? 'TLSv1.3',
    rejectUnauthorized: true,
    checkServerIdentity: tls.checkServerIdentity,
  }, (up) => {
    if (tooLarge) {
      up.resume()
      return
    }
    const status = up.statusCode || 502
    onUpstreamStatus?.({ status, contentType: up.headers['content-type'] })
    const outHeaders = copyHeaders(up.headers)
    res.writeHead(status, outHeaders)
    if (typeof res.flushHeaders === 'function') res.flushHeaders()
    up.pipe(res)
  })
  upstream.on('error', () => {
    onUpstreamError?.()
    if (!res.headersSent) sendJson(res, 502, { error: { code: 'UPSTREAM', message: 'upstream failed' } })
    else try { res.destroy() } catch { /* */ }
  })
  req.pipe(limiter).pipe(upstream)
}

export function createLocalProxy({
  kind,
  port,
  expectedToken,
  identity,
  outboundOrigin,
  spkiPin,
  deviceCaPem,
  allowlist,
  bindAllForTest = false,
  inspectRemote = remoteAddressOf,
  onUnauth,
  onOutbound,
  maxBodyBytes = MAX_PROXY_BODY_BYTES,
}) {
  const stats = {
    unauth: 0,
    rejected: 0,
    allowed: 0,
    outbound: 0,
    success: 0,
    upstreamError: 0,
    tooLarge: 0,
  }
  let servers = []
  let boundPort = port
  let closed = true

  const tlsFor = () => createOutboundTlsOptions({
    spkiPin,
    deviceCaPem,
    certPem: identity.getCertPem(),
    keyPem: identity.getKeyPem(),
  })

  function onRequest(req, res) {
    const remote = inspectRemote(req)
    if (!isLoopbackAddress(remote)) {
      stats.rejected += 1
      sendJson(res, 403, { error: { code: 'FORBIDDEN', message: 'loopback only' } })
      return
    }
    if (!checkBearerToken(req.headers.authorization, expectedToken)) {
      stats.unauth += 1
      onUnauth?.({ kind, path: req.url, remote })
      sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: 'invalid proxy token' } })
      return
    }
    const path = pathnameOf(req.url)
    const method = String(req.method || 'GET').toUpperCase()
    if (pathKnown(path, allowlist) && !methodAllowedOnPath(method, path, allowlist)) {
      stats.rejected += 1
      sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'method not allowed' } })
      return
    }
    if (!allowlisted(method, path, allowlist)) {
      stats.rejected += 1
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'path not allowed' } })
      return
    }
    const declared = Number(req.headers['content-length'] || 0)
    if (Number.isFinite(declared) && declared > maxBodyBytes) {
      stats.tooLarge += 1
      sendJson(res, 413, { error: { code: 'BODY_TOO_LARGE', message: 'request body exceeds 8 MiB' } })
      req.resume()
      return
    }
    stats.allowed += 1
    proxyHttps({
      origin: outboundOrigin,
      tls: tlsFor(),
      req,
      res,
      identity,
      onOutbound: (info) => {
        stats.outbound += 1
        onOutbound?.(info)
      },
      onUpstreamStatus: ({ status }) => {
        if (status >= 400) stats.upstreamError += 1
        else stats.success += 1
      },
      onUpstreamError: () => {
        stats.upstreamError += 1
      },
      onTooLarge: () => {
        stats.tooLarge += 1
      },
      maxBodyBytes,
    })
  }

  return {
    kind,
    get port() {
      return boundPort
    },
    get stats() {
      return { ...stats }
    },
    async start() {
      if (!closed) return boundPort
      if (bindAllForTest) {
        const server = http.createServer(onRequest)
        await new Promise((resolve, reject) => {
          server.once('error', reject)
          server.listen({ host: '0.0.0.0', port, exclusive: true }, () => {
            boundPort = server.address().port
            resolve()
          })
        })
        servers = [server]
      } else {
        const pair = await listenLoopbackPair(() => http.createServer(onRequest), port)
        servers = [pair.v4, pair.v6]
        boundPort = pair.port
      }
      closed = false
      return boundPort
    },
    async stop() {
      closed = true
      await closeServers(servers)
      servers = []
    },
  }
}

export function createEgressProxy(opts) {
  return createLocalProxy({
    kind: 'egress',
    port: opts.port ?? EGRESS_PROXY_PORT,
    expectedToken: opts.lahToken,
    allowlist: [{ method: 'POST', path: '/v1/messages' }],
    outboundOrigin: opts.egressOrigin,
    ...opts,
  })
}

export function createMasterProxy(opts) {
  return createLocalProxy({
    kind: 'master',
    port: opts.port ?? MASTER_PROXY_PORT,
    expectedToken: opts.lahGwToken,
    allowlist: MASTER_PATH_ALLOWLIST,
    outboundOrigin: opts.registerOrigin,
    ...opts,
  })
}
