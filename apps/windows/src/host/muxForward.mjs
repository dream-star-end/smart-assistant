import http from 'node:http'
import { EventEmitter } from 'node:events'
import { createHash, randomBytes } from 'node:crypto'
import { LOCAL_BRIDGE_HEADER_CANON } from './tokens.mjs'
import { encodeWsFrame, decodeWsFrames } from '../tunnel/wss.mjs'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'x-openclaude-local-bridge',
  'x-openclaude-bridge-nonce',
])

const FORWARD_HTTP = new Set([
  'GET /healthz',
  'POST /internal/v3/turn-reject-if-absent',
  'GET /internal/v3/turn-dispatch-state',
])

const NOT_IMPLEMENTED_PREFIXES = [
  '/api/file',
  '/api/media/',
  '/internal/v3/runtime-recycle-drain',
  '/internal/v3/engine-preheat',
  '/internal/v3/wechat-inbound',
  '/internal/v3/qq-inbound',
]

export function classifyMuxHttp(method, path) {
  const pathname = String(path || '/').split('?')[0]
  const key = `${String(method || 'GET').toUpperCase()} ${pathname}`
  if (FORWARD_HTTP.has(key)) return 'forward'
  for (const prefix of NOT_IMPLEMENTED_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(prefix)) return 'not_implemented'
  }
  if (pathname.startsWith('/internal/')) return 'not_implemented'
  return 'forward'
}

function headersToNode(headers) {
  const out = {}
  if (!headers) return out
  if (Array.isArray(headers)) {
    for (const item of headers) {
      const k = String(item.k ?? item[0] ?? '').toLowerCase()
      const v = item.v ?? item[1]
      if (!k || HOP.has(k)) continue
      out[k] = v
    }
    return out
  }
  for (const [key, value] of Object.entries(headers)) {
    const k = String(key).toLowerCase()
    if (HOP.has(k) || value == null) continue
    out[k] = value
  }
  return out
}

function notImplemented() {
  return {
    status: 501,
    headers: [{ k: 'content-type', v: 'application/json' }],
    body: Buffer.from(JSON.stringify({ error: { code: 'NOT_IMPLEMENTED' } }), 'utf8'),
  }
}

export function createMuxHttpForwarder({
  gatewayPort,
  localBridgeToken,
  timeoutMs = 15_000,
}) {
  async function handler(req) {
    const decision = classifyMuxHttp(req.method, req.path)
    if (decision === 'not_implemented') return notImplemented()
    const path = req.path || '/'
    const headers = headersToNode(req.headers)
    headers[LOCAL_BRIDGE_HEADER_CANON] = localBridgeToken
    headers.host = `127.0.0.1:${gatewayPort}`
    const body = req.body && req.body.length ? req.body : null
    if (body) headers['content-length'] = String(body.length)
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({ status: 504, headers: [], body: Buffer.from('{"error":{"code":"TIMEOUT"}}') })
      }, timeoutMs)
      timer.unref?.()
      const upstream = http.request({
        host: '127.0.0.1',
        port: gatewayPort,
        path,
        method: req.method || 'GET',
        headers,
      }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          clearTimeout(timer)
          const outHeaders = []
          for (const [k, v] of Object.entries(res.headers)) {
            if (v == null) continue
            outHeaders.push({ k, v: Array.isArray(v) ? v.join(', ') : String(v) })
          }
          resolve({
            status: res.statusCode || 502,
            headers: outHeaders,
            body: Buffer.concat(chunks),
          })
        })
      })
      upstream.on('error', () => {
        clearTimeout(timer)
        resolve({
          status: 502,
          headers: [{ k: 'content-type', v: 'application/json' }],
          body: Buffer.from(JSON.stringify({ error: { code: 'GATEWAY_UNREACHABLE' } })),
        })
      })
      if (body) upstream.end(body)
      else upstream.end()
    })
  }

  function onOpenWs({ streamId, path, session }) {
    const pathname = String(path || '/ws').split('?')[0]
    if (pathname !== '/ws') {
      throw new Error('OPEN_WS path not implemented')
    }
    const ws = connectLoopbackWs({
      port: gatewayPort,
      path: path || '/ws',
      localBridgeToken,
    })
    ws.on('open', () => {})
    ws.on('message', (data, isBinary) => {
      session.sendData(isBinary ? 2 : 1, data)
    })
    ws.on('close', (code, reason) => {
      session.sendClose(code || 1000, reason || '')
    })
    ws.on('error', () => {
      session.sendClose(1011, 'gateway_ws_error')
    })
    return {
      onMuxData(obj) {
        const opcode = Number(obj.opcode) === 2 ? 2 : 1
        const buf = Buffer.from(String(obj.data || ''), 'base64')
        ws.send(opcode, buf)
      },
      onMuxClose(obj) {
        ws.close(Number(obj.code) || 1000, obj.reason || '')
      },
      destroy() {
        ws.terminate()
      },
    }
  }

  return { handler, onOpenWs }
}

class LoopbackWs extends EventEmitter {
  constructor(socket, leftover) {
    super()
    this._socket = socket
    this._buf = leftover && leftover.length ? Buffer.from(leftover) : Buffer.alloc(0)
    this._closed = false
    socket.on('data', (chunk) => this._onData(chunk))
    socket.on('error', () => this.terminate())
    socket.on('close', () => this._finish(1006, 'socket_close'))
  }

  send(opcode, payload) {
    if (this._closed || this._socket.destroyed) return
    this._socket.write(encodeWsFrame(opcode, payload, { masked: true, fin: true }))
  }

  close(code = 1000, reason = '') {
    if (this._closed) return
    const why = Buffer.from(String(reason), 'utf8').subarray(0, 120)
    const payload = Buffer.allocUnsafe(2 + why.length)
    payload.writeUInt16BE(code >>> 0, 0)
    why.copy(payload, 2)
    try { this.send(8, payload) } catch { /* */ }
    this._finish(code, reason)
    try { this._socket.end() } catch { /* */ }
  }

  terminate() {
    this._finish(1006, 'terminated')
    try { this._socket.destroy() } catch { /* */ }
  }

  _onData(chunk) {
    if (this._closed) return
    this._buf = this._buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this._buf, chunk])
    let decoded
    try {
      decoded = decodeWsFrames(this._buf)
    } catch {
      this.terminate()
      return
    }
    this._buf = Buffer.from(decoded.rest)
    for (const f of decoded.frames) {
      if (f.opcode === 8) {
        let code = 1005
        let reason = ''
        if (f.payload.length >= 2) {
          code = f.payload.readUInt16BE(0)
          reason = f.payload.subarray(2).toString('utf8')
        }
        this._finish(code, reason)
        try { this._socket.end() } catch { /* */ }
        return
      }
      if (f.opcode === 9) {
        try { this.send(10, f.payload) } catch { /* */ }
        continue
      }
      if (f.opcode === 10) continue
      if (f.opcode === 1) this.emit('message', f.payload, false)
      else if (f.opcode === 2) this.emit('message', f.payload, true)
    }
  }

  _finish(code, reason) {
    if (this._closed) return
    this._closed = true
    this.emit('close', code, reason)
  }
}

export function connectLoopbackWs({ port, path, localBridgeToken, timeoutMs = 5_000 }) {
  const key = randomBytes(16).toString('base64')
  const expectedAccept = createHash('sha1').update(key + GUID).digest('base64')
  const emitter = new EventEmitter()
  const req = http.request({
    host: '127.0.0.1',
    port,
    path,
    method: 'GET',
    headers: {
      host: `127.0.0.1:${port}`,
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-version': '13',
      'sec-websocket-key': key,
      [LOCAL_BRIDGE_HEADER_CANON]: localBridgeToken,
    },
  })
  const timer = setTimeout(() => {
    req.destroy()
    emitter.emit('error', new Error('ws connect timeout'))
  }, timeoutMs)
  timer.unref?.()
  req.on('upgrade', (res, socket, head) => {
    clearTimeout(timer)
    if (res.headers['sec-websocket-accept'] !== expectedAccept) {
      socket.destroy()
      emitter.emit('error', new Error('sec-websocket-accept mismatch'))
      return
    }
    const ws = new LoopbackWs(socket, head)
    emitter.send = (opcode, payload) => ws.send(opcode, payload)
    emitter.close = (code, reason) => ws.close(code, reason)
    emitter.terminate = () => ws.terminate()
    ws.on('message', (d, b) => emitter.emit('message', d, b))
    ws.on('close', (c, r) => emitter.emit('close', c, r))
    emitter.emit('open')
  })
  req.on('response', (res) => {
    clearTimeout(timer)
    res.resume()
    emitter.emit('error', new Error(`ws upgrade HTTP ${res.statusCode}`))
  })
  req.on('error', (err) => {
    clearTimeout(timer)
    emitter.emit('error', err)
  })
  req.end()
  emitter.send = () => {}
  emitter.close = () => { try { req.destroy() } catch { /* */ } }
  emitter.terminate = () => { try { req.destroy() } catch { /* */ } }
  return emitter
}
