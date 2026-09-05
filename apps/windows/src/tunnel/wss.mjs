/**
 * Minimal RFC6455 WebSocket client over Node https/tls.
 * Used so apps/windows does not take a `ws` dependency. Client frames are masked.
 */

import { EventEmitter } from 'node:events'
import { createHash, randomBytes } from 'node:crypto'
import https from 'node:https'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export class WssClientError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'WssClientError'
    this.code = code
    Object.assign(this, extra)
  }
}

function maskPayload(payload, key) {
  const out = Buffer.allocUnsafe(payload.length)
  for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ key[i & 3]
  return out
}

export function encodeWsFrame(opcode, payload, { masked = true, fin = true } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const len = body.length
  let headerLen = 2
  if (len >= 126 && len <= 0xffff) headerLen += 2
  else if (len > 0xffff) headerLen += 8
  if (masked) headerLen += 4
  const buf = Buffer.allocUnsafe(headerLen + len)
  buf[0] = (fin ? 0x80 : 0) | (opcode & 0x0f)
  let offset = 2
  if (len < 126) {
    buf[1] = (masked ? 0x80 : 0) | len
  } else if (len <= 0xffff) {
    buf[1] = (masked ? 0x80 : 0) | 126
    buf.writeUInt16BE(len, 2)
    offset = 4
  } else {
    buf[1] = (masked ? 0x80 : 0) | 127
    buf.writeBigUInt64BE(BigInt(len), 2)
    offset = 10
  }
  let data = body
  if (masked) {
    const key = randomBytes(4)
    key.copy(buf, offset)
    offset += 4
    data = maskPayload(body, key)
  }
  data.copy(buf, offset)
  return buf
}

export function decodeWsFrames(buf) {
  const frames = []
  let offset = 0
  while (offset + 2 <= buf.length) {
    const b0 = buf[offset]
    const b1 = buf[offset + 1]
    const fin = (b0 & 0x80) !== 0
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    let len = b1 & 0x7f
    let cursor = offset + 2
    if (len === 126) {
      if (cursor + 2 > buf.length) break
      len = buf.readUInt16BE(cursor)
      cursor += 2
    } else if (len === 127) {
      if (cursor + 8 > buf.length) break
      const big = buf.readBigUInt64BE(cursor)
      if (big > 0xffffffffn) {
        throw new WssClientError('WS_FRAME', 'ws payload too large')
      }
      len = Number(big)
      cursor += 8
    }
    let maskKey = null
    if (masked) {
      if (cursor + 4 > buf.length) break
      maskKey = buf.subarray(cursor, cursor + 4)
      cursor += 4
    }
    if (cursor + len > buf.length) break
    let payload = Buffer.from(buf.subarray(cursor, cursor + len))
    if (maskKey) payload = maskPayload(payload, maskKey)
    frames.push({ fin, opcode, payload })
    offset = cursor + len
  }
  return { frames, rest: offset === 0 ? buf : Buffer.from(buf.subarray(offset)) }
}

function acceptFromKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64')
}

export class WssSocket extends EventEmitter {
  constructor(socket, leftover = Buffer.alloc(0)) {
    super()
    this._socket = socket
    this._buf = leftover && leftover.length ? Buffer.from(leftover) : Buffer.alloc(0)
    this._closed = false
    this.readyState = 1
    socket.on('data', (chunk) => this._onData(chunk))
    socket.on('error', (err) => {
      if (this._closed) return
      this.emit('error', err)
    })
    socket.on('close', () => this._onPeerClose(1006, 'socket_close'))
    socket.on('end', () => this._onPeerClose(1006, 'socket_end'))
  }

  sendText(text) {
    this._send(1, Buffer.from(String(text), 'utf8'))
  }

  sendBinary(buf) {
    this._send(2, Buffer.isBuffer(buf) ? buf : Buffer.from(buf))
  }

  send(data, opts = {}) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    if (opts.binary === false) this._send(1, buf)
    else this._send(2, buf)
  }

  ping(payload = Buffer.alloc(0)) {
    this._send(9, Buffer.isBuffer(payload) ? payload : Buffer.from(payload))
  }

  close(code = 1000, reason = '') {
    if (this._closed) return
    const why = Buffer.from(String(reason), 'utf8').subarray(0, 120)
    const payload = Buffer.allocUnsafe(2 + why.length)
    payload.writeUInt16BE(code >>> 0, 0)
    why.copy(payload, 2)
    try { this._send(8, payload) } catch { /* already dead */ }
    this._finish(code, reason)
  }

  terminate() {
    if (this._closed) return
    this._finish(1006, 'terminated')
    try { this._socket.destroy() } catch { /* */ }
  }

  _send(opcode, payload) {
    if (this._closed || this._socket.destroyed) {
      throw new WssClientError('CLOSED', 'wss socket closed')
    }
    this._socket.write(encodeWsFrame(opcode, payload, { masked: true, fin: true }))
  }

  _onData(chunk) {
    if (this._closed) return
    this._buf = this._buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this._buf, chunk])
    let decoded
    try {
      decoded = decodeWsFrames(this._buf)
    } catch (err) {
      this.emit('error', err)
      this.terminate()
      return
    }
    this._buf = Buffer.from(decoded.rest)
    for (const f of decoded.frames) this._onFrame(f)
  }

  _onFrame(frame) {
    if (frame.opcode === 8) {
      let code = 1005
      let reason = ''
      if (frame.payload.length >= 2) {
        code = frame.payload.readUInt16BE(0)
        reason = frame.payload.subarray(2).toString('utf8')
      }
      this._finish(code, reason)
      try { this._socket.end() } catch { /* */ }
      return
    }
    if (frame.opcode === 9) {
      try { this._send(10, frame.payload) } catch { /* */ }
      return
    }
    if (frame.opcode === 10) return
    if (frame.opcode === 1) {
      this.emit('message', frame.payload, false)
      return
    }
    if (frame.opcode === 2) {
      this.emit('message', frame.payload, true)
      return
    }
  }

  _onPeerClose(code, reason) {
    if (this._closed) return
    this._finish(code, reason)
  }

  _finish(code, reason) {
    if (this._closed) return
    this._closed = true
    this.readyState = 3
    try { this._socket.destroy() } catch { /* */ }
    this.emit('close', code, Buffer.from(String(reason ?? ''), 'utf8'))
  }
}

/**
 * Open a WSS connection. `tls` must already include rejectUnauthorized:true
 * and a real checkServerIdentity (see bootstrap.createOutboundTlsOptions).
 */
export function connectWss({ url, tls, headers = {}, timeoutMs = 15_000 }) {
  const target = typeof url === 'string' ? new URL(url) : url
  if (target.protocol !== 'wss:' && target.protocol !== 'https:') {
    return Promise.reject(new WssClientError('TLS_REQUIRED', 'WSS URL required'))
  }
  if (!tls || tls.rejectUnauthorized !== true) {
    return Promise.reject(new WssClientError('TLS_REQUIRED', 'rejectUnauthorized must be true'))
  }
  if (typeof tls.checkServerIdentity !== 'function') {
    return Promise.reject(new WssClientError('TLS_REQUIRED', 'checkServerIdentity required'))
  }
  const key = randomBytes(16).toString('base64')
  const expectedAccept = acceptFromKey(key)
  const port = Number(target.port) || 443
  const reqHeaders = {
    Host: target.host,
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Key': key,
    ...headers,
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (err, sock) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve(sock)
    }
    const timer = setTimeout(() => {
      req.destroy()
      done(new WssClientError('TIMEOUT', 'wss connect timeout'))
    }, timeoutMs)
    timer.unref?.()
    const req = https.request({
      hostname: target.hostname,
      port,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: reqHeaders,
      servername: /^\d{1,3}(\.\d{1,3}){3}$/.test(target.hostname) ? undefined : target.hostname,
      ca: tls.ca,
      cert: tls.cert,
      key: tls.key,
      minVersion: tls.minVersion ?? 'TLSv1.3',
      maxVersion: tls.maxVersion ?? 'TLSv1.3',
      rejectUnauthorized: true,
      checkServerIdentity: tls.checkServerIdentity,
    })
    req.on('upgrade', (res, socket, head) => {
      const accept = res.headers['sec-websocket-accept']
      if (accept !== expectedAccept) {
        socket.destroy()
        done(new WssClientError('BAD_ACCEPT', 'sec-websocket-accept mismatch'))
        return
      }
      const leftover = head && head.length ? Buffer.from(head) : Buffer.alloc(0)
      const ws = new WssSocket(socket, leftover)
      done(null, ws)
    })
    req.on('response', (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8').slice(0, 500)
        done(new WssClientError('HTTP_STATUS', `register upgrade HTTP ${res.statusCode}`, {
          status: res.statusCode,
          body,
        }))
      })
    })
    req.on('error', (err) => done(err))
    req.end()
  })
}

/** Tiny WSS server for tests (unmasked server frames, masked client frames). */
export function attachWssUpgrade(req, socket, head, { onOpen }) {
  const key = req.headers['sec-websocket-key']
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  const accept = acceptFromKey(String(key))
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n`
    + '\r\n',
  )
  const leftover = head && head.length ? Buffer.from(head) : Buffer.alloc(0)
  const conn = new TestWssConnection(socket, leftover)
  onOpen(conn, req)
}

export class TestWssConnection extends EventEmitter {
  constructor(socket, leftover = Buffer.alloc(0)) {
    super()
    this._socket = socket
    this._buf = leftover.length ? leftover : Buffer.alloc(0)
    this._closed = false
    socket.on('data', (chunk) => this._onData(chunk))
    socket.on('error', (err) => this.emit('error', err))
    socket.on('close', () => this._finish(1006, 'socket_close'))
  }

  sendText(text) {
    this._send(1, Buffer.from(String(text), 'utf8'))
  }

  sendBinary(buf) {
    this._send(2, Buffer.isBuffer(buf) ? buf : Buffer.from(buf))
  }

  close(code = 1000, reason = '') {
    if (this._closed) return
    const why = Buffer.from(String(reason), 'utf8').subarray(0, 120)
    const payload = Buffer.allocUnsafe(2 + why.length)
    payload.writeUInt16BE(code >>> 0, 0)
    why.copy(payload, 2)
    try { this._send(8, payload) } catch { /* */ }
    this._finish(code, reason)
    try { this._socket.end() } catch { /* */ }
  }

  terminate() {
    this._finish(1006, 'terminated')
    try { this._socket.destroy() } catch { /* */ }
  }

  _send(opcode, payload) {
    if (this._closed || this._socket.destroyed) return
    this._socket.write(encodeWsFrame(opcode, payload, { masked: false, fin: true }))
  }

  _onData(chunk) {
    if (this._closed) return
    this._buf = this._buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this._buf, chunk])
    let decoded
    try {
      decoded = decodeWsFrames(this._buf)
    } catch (err) {
      this.emit('error', err)
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
        try { this._send(10, f.payload) } catch { /* */ }
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
    this.emit('close', code, Buffer.from(String(reason ?? ''), 'utf8'))
  }
}

