/**
 * oc-desktop-mux/1 client codec. Byte-compatible with
 * packages/commercial/src/ws/desktopMux.ts encodeFrame/decodeFrames.
 *
 * Unknown type and decode failures are the session's job: fail-closed
 * (GOAWAY + close). This module only throws MuxProtocolError.
 */

export const MUX_VERSION = 1
export const MUX_PROTOCOL_NAME = 'oc-desktop-mux/1'
export const FRAME_HEADER_SIZE = 10
export const MAX_FRAME_PAYLOAD = 64 * 1024
export const MAX_HTTP_BODY = 64 * 1024
export const MAX_STREAMS_PER_TUNNEL = 32
export const FLAG_FIN = 0x01
export const HEARTBEAT_INTERVAL_MS = 15_000
export const HEARTBEAT_TIMEOUT_MS = 45_000
export const HEARTBEAT_MIN_INTERVAL_MS = 5_000
export const HEARTBEAT_OVERSPEED_LIMIT = 8
export const REGISTER_TIMEOUT_MS = 10_000

export const MuxType = Object.freeze({
  OPEN_HTTP: 0x01,
  HTTP_RESPONSE_START: 0x02,
  HTTP_DATA: 0x03,
  HTTP_END: 0x04,
  RESET_STREAM: 0x05,
  OPEN_WS: 0x11,
  WS_DATA: 0x12,
  WS_CLOSE: 0x13,
  HEARTBEAT: 0x20,
  HEARTBEAT_ACK: 0x21,
  GOAWAY: 0x30,
})

export const KNOWN_TYPES = new Set(Object.values(MuxType))

export class MuxProtocolError extends Error {
  constructor(code, message, streamId = 0) {
    super(message)
    this.name = 'MuxProtocolError'
    this.code = code
    this.streamId = streamId
  }
}

export function isKnownMuxType(type) {
  return KNOWN_TYPES.has(type)
}

export function encodeFrame(type, flags, streamId, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  if (body.length > MAX_FRAME_PAYLOAD) {
    throw new MuxProtocolError('BODY_TOO_LARGE', `payload ${body.length} > ${MAX_FRAME_PAYLOAD}`, streamId)
  }
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > 0xffffffff) {
    throw new MuxProtocolError('PROTOCOL', `bad streamId ${streamId}`, streamId)
  }
  if (!Number.isInteger(type) || type < 0 || type > 0xff) {
    throw new MuxProtocolError('PROTOCOL', `bad type ${type}`, streamId)
  }
  if (!Number.isInteger(flags) || flags < 0 || flags > 0xff) {
    throw new MuxProtocolError('PROTOCOL', `bad flags ${flags}`, streamId)
  }
  const buf = Buffer.allocUnsafe(FRAME_HEADER_SIZE + body.length)
  buf.writeUInt8(type & 0xff, 0)
  buf.writeUInt8(flags & 0xff, 1)
  buf.writeUInt32BE(streamId >>> 0, 2)
  buf.writeUInt32BE(body.length, 6)
  body.copy(buf, FRAME_HEADER_SIZE)
  return buf
}

export function encodeJsonFrame(type, streamId, obj, flags = 0) {
  return encodeFrame(type, flags, streamId, Buffer.from(JSON.stringify(obj), 'utf8'))
}

export function decodeFrames(buf) {
  if (!Buffer.isBuffer(buf)) {
    throw new MuxProtocolError('PROTOCOL', 'decodeFrames requires Buffer')
  }
  const frames = []
  let offset = 0
  while (offset + FRAME_HEADER_SIZE <= buf.length) {
    const type = buf.readUInt8(offset)
    const flags = buf.readUInt8(offset + 1)
    const streamId = buf.readUInt32BE(offset + 2)
    const payloadLen = buf.readUInt32BE(offset + 6)
    if (payloadLen > MAX_FRAME_PAYLOAD) {
      throw new MuxProtocolError('BODY_TOO_LARGE', `declared payloadLen ${payloadLen}`, streamId)
    }
    if (offset + FRAME_HEADER_SIZE + payloadLen > buf.length) break
    const payload = Buffer.from(buf.subarray(offset + FRAME_HEADER_SIZE, offset + FRAME_HEADER_SIZE + payloadLen))
    frames.push({ type, flags, streamId, payload })
    offset += FRAME_HEADER_SIZE + payloadLen
  }
  return { frames, rest: offset === 0 ? buf : Buffer.from(buf.subarray(offset)) }
}

export function parseJsonPayload(payload) {
  const text = payload.toString('utf8')
  let v
  try {
    v = JSON.parse(text)
  } catch (err) {
    throw new MuxProtocolError('PROTOCOL', `JSON payload parse failed: ${err.message}`)
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new MuxProtocolError('PROTOCOL', 'JSON payload must be an object')
  }
  return v
}

export function headersFrom(raw) {
  const out = {}
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue
      if (typeof item.k === 'string' && typeof item.v === 'string') out[item.k.toLowerCase()] = item.v
    }
    return out
  }
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string') out[k.toLowerCase()] = v
    }
  }
  return out
}

export function headersToList(headers) {
  if (Array.isArray(headers)) return headers.filter((h) => h && typeof h.k === 'string' && typeof h.v === 'string')
  const list = []
  if (headers && typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers)) {
      if (typeof v === 'string') list.push({ k, v })
    }
  }
  return list
}

/**
 * Incremental decoder. Throws on cap overflow; caller must fail-closed.
 */
export function createMuxDecoder() {
  let buf = Buffer.alloc(0)
  return {
    push(chunk) {
      const raw = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      buf = buf.length === 0 ? Buffer.from(raw) : Buffer.concat([buf, raw])
      const { frames, rest } = decodeFrames(buf)
      buf = Buffer.from(rest)
      return frames
    },
    reset() {
      buf = Buffer.alloc(0)
    },
    pending() {
      return buf.length
    },
  }
}

/** Test helper: two MuxTransports that echo to each other (same contract as server). */
export function createMuxLoopbackPair() {
  const masterListeners = { message: [], close: [], error: [] }
  const deskListeners = { message: [], close: [], error: [] }
  let closed = false
  const make = (self, peer) => ({
    send(data) {
      if (closed) return
      queueMicrotask(() => {
        for (const cb of peer.message) cb(Buffer.from(data))
      })
    },
    close() {
      if (closed) return
      closed = true
      queueMicrotask(() => {
        for (const cb of peer.close) cb()
        for (const cb of self.close) cb()
      })
    },
    terminate() {
      this.close()
    },
    on(event, cb) {
      if (self[event]) self[event].push(cb)
    },
    off(event, cb) {
      if (!self[event]) return
      self[event] = self[event].filter((x) => x !== cb)
    },
  })
  return { master: make(masterListeners, deskListeners), desktop: make(deskListeners, masterListeners) }
}
