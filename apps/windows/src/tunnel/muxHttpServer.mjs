/**
 * Desktop HTTP-over-mux origin: OPEN_HTTP → handler → RESPONSE_START / DATA+FIN / END.
 *
 * Differences from desktopMuxResponder.ts:
 *   - unknown type / decode failure fail-closed (GOAWAY + close)
 *   - 32-stream cap rejects with RESET STREAM_LIMIT
 *   - empty success body still sends HTTP_DATA + FLAG_FIN
 *   - HTTP_RESPONSE_START is required and sent before any DATA
 */

import {
  FLAG_FIN,
  MAX_HTTP_BODY,
  MAX_STREAMS_PER_TUNNEL,
  MuxProtocolError,
  MuxType,
  createMuxDecoder,
  encodeFrame,
  encodeJsonFrame,
  headersToList,
  isKnownMuxType,
  parseJsonPayload,
} from './mux.mjs'

export function notImplementedHandler() {
  return {
    status: 501,
    headers: [{ k: 'content-type', v: 'application/json' }],
    body: Buffer.from(JSON.stringify({ error: { code: 'NOT_IMPLEMENTED' } }), 'utf8'),
  }
}

export function attachMuxHttpServer({
  transport,
  handler,
  onFailClosed,
  onOpenWs,
  onHeartbeatAck,
  onGoaway,
  maxStreams = MAX_STREAMS_PER_TUNNEL,
}) {
  if (typeof handler !== 'function') {
    throw new Error('muxHttpServer requires handler(req) => res')
  }
  const decoder = createMuxDecoder()
  const streams = new Map()
  let closed = false
  let failReason = null

  const send = (buf) => {
    if (closed) return
    try { transport.send(buf) } catch { /* */ }
  }

  const failClosed = (err) => {
    if (closed) return
    closed = true
    failReason = err instanceof Error ? err : new MuxProtocolError('PROTOCOL', String(err))
    try {
      send(encodeJsonFrame(MuxType.GOAWAY, 0, { message: failReason.message.slice(0, 120) }))
    } catch { /* */ }
    for (const s of streams.values()) {
      if (s.timer) clearTimeout(s.timer)
    }
    streams.clear()
    try { transport.close(4001, failReason.message.slice(0, 120)) } catch { /* */ }
    onFailClosed?.(failReason)
  }

  const reset = (streamId, code, message) => {
    send(encodeJsonFrame(MuxType.RESET_STREAM, streamId, { code, message }))
    const s = streams.get(streamId)
    if (s?.timer) clearTimeout(s.timer)
    streams.delete(streamId)
  }

  const dropStream = (streamId) => {
    const s = streams.get(streamId)
    if (s?.timer) clearTimeout(s.timer)
    streams.delete(streamId)
  }

  async function finishHttp(streamId, pending) {
    if (pending.timer) {
      clearTimeout(pending.timer)
      pending.timer = null
    }
    pending.busy = true
    const body = Buffer.concat(pending.chunks)
    if (body.length > MAX_HTTP_BODY) {
      reset(streamId, 'BODY_TOO_LARGE', 'request body too large')
      return
    }
    let res
    try {
      res = await handler({
        method: pending.method,
        path: pending.path,
        headers: pending.headers,
        body,
        streamId,
        deadlineMs: pending.deadlineMs,
      })
    } catch {
      send(encodeJsonFrame(MuxType.HTTP_RESPONSE_START, streamId, {
        status: 502,
        headers: [],
      }))
      send(encodeFrame(MuxType.HTTP_END, 0, streamId, Buffer.alloc(0)))
      dropStream(streamId)
      return
    }
    const status = Number(res?.status)
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      reset(streamId, 'PROTOCOL', 'handler status required')
      return
    }
    send(encodeJsonFrame(MuxType.HTTP_RESPONSE_START, streamId, {
      status,
      headers: headersToList(res.headers ?? []),
    }))
    const outBody = res.body == null
      ? Buffer.alloc(0)
      : Buffer.isBuffer(res.body) ? res.body : Buffer.from(String(res.body), 'utf8')
    if (outBody.length > MAX_HTTP_BODY) {
      reset(streamId, 'BODY_TOO_LARGE', 'response body too large')
      return
    }
    send(encodeFrame(MuxType.HTTP_DATA, FLAG_FIN, streamId, outBody))
    send(encodeFrame(MuxType.HTTP_END, 0, streamId, Buffer.alloc(0)))
    dropStream(streamId)
  }

  function onFrame(frame) {
    if (closed) return
    if (!isKnownMuxType(frame.type)) {
      reset(frame.streamId, 'PROTOCOL', `unknown type 0x${frame.type.toString(16)}`)
      failClosed(new MuxProtocolError('PROTOCOL', `unknown type ${frame.type}`, frame.streamId))
      return
    }
    if (frame.type === MuxType.GOAWAY) {
      onGoaway?.(frame)
      failClosed(new MuxProtocolError('GOAWAY', 'peer goaway', 0))
      return
    }
    if (frame.type === MuxType.HEARTBEAT_ACK) {
      onHeartbeatAck?.(frame)
      return
    }
    if (frame.type === MuxType.HEARTBEAT) {
      let payload = {}
      try {
        if (frame.payload.length) payload = parseJsonPayload(frame.payload)
      } catch (err) {
        failClosed(err)
        return
      }
      send(encodeJsonFrame(MuxType.HEARTBEAT_ACK, 0, { ts: payload.ts ?? Date.now(), serverNow: Date.now() }))
      return
    }
    if (frame.streamId === 0) {
      failClosed(new MuxProtocolError('PROTOCOL', 'streamId 0 reserved', 0))
      return
    }
    if (frame.type === MuxType.OPEN_HTTP) {
      if (frame.streamId % 2 === 0) {
        reset(frame.streamId, 'PROTOCOL', 'OPEN_HTTP streamId must be odd')
        return
      }
      if (streams.size >= maxStreams) {
        reset(frame.streamId, 'STREAM_LIMIT', 'max 32 streams')
        return
      }
      if (streams.has(frame.streamId)) {
        reset(frame.streamId, 'PROTOCOL', 'duplicate OPEN_HTTP')
        return
      }
      let obj
      try {
        obj = parseJsonPayload(frame.payload)
      } catch (err) {
        failClosed(err)
        return
      }
      const deadlineMs = typeof obj.deadlineMs === 'number' ? obj.deadlineMs : Date.now() + 30_000
      const waitMs = Math.max(1, deadlineMs - Date.now())
      const pending = {
        kind: 'http',
        method: String(obj.method ?? 'GET'),
        path: String(obj.path ?? '/'),
        headers: (obj.headers && typeof obj.headers === 'object' && !Array.isArray(obj.headers))
          ? obj.headers
          : {},
        chunks: [],
        bytes: 0,
        deadlineMs,
        timer: null,
      }
      pending.timer = setTimeout(() => {
        reset(frame.streamId, 'TIMEOUT', 'OPEN_HTTP deadline')
      }, waitMs)
      pending.timer.unref?.()
      streams.set(frame.streamId, pending)
      return
    }
    if (frame.type === MuxType.HTTP_DATA) {
      const pending = streams.get(frame.streamId)
      if (!pending || pending.kind !== 'http') {
        reset(frame.streamId, 'PROTOCOL', 'DATA for unknown stream')
        return
      }
      pending.bytes += frame.payload.length
      if (pending.bytes > MAX_HTTP_BODY) {
        reset(frame.streamId, 'BODY_TOO_LARGE', 'request body too large')
        return
      }
      pending.chunks.push(frame.payload)
      if (frame.flags & FLAG_FIN) {
        void finishHttp(frame.streamId, pending)
      }
      return
    }
    if (frame.type === MuxType.RESET_STREAM) {
      dropStream(frame.streamId)
      return
    }
    if (frame.type === MuxType.OPEN_WS) {
      if (streams.size >= maxStreams) {
        reset(frame.streamId, 'STREAM_LIMIT', 'max 32 streams')
        return
      }
      let obj
      try {
        obj = parseJsonPayload(frame.payload)
      } catch (err) {
        failClosed(err)
        return
      }
      if (typeof onOpenWs === 'function') {
        streams.set(frame.streamId, { kind: 'ws' })
        try {
          onOpenWs({ streamId: frame.streamId, path: String(obj.path ?? '/ws'), transport })
        } catch (err) {
          reset(frame.streamId, 'PROTOCOL', err.message)
        }
        return
      }
      reset(frame.streamId, 'NOT_IMPLEMENTED', 'OPEN_WS handler not attached')
      return
    }
    if (frame.type === MuxType.WS_DATA || frame.type === MuxType.WS_CLOSE) {
      if (!streams.has(frame.streamId)) {
        reset(frame.streamId, 'PROTOCOL', 'WS frame for unknown stream')
      }
      return
    }
    reset(frame.streamId, 'PROTOCOL', `unexpected type ${frame.type}`)
  }

  const onMessage = (data, isBinary) => {
    if (closed) return
    if (isBinary === false) return
    let frames
    try {
      frames = decoder.push(data)
    } catch (err) {
      failClosed(err)
      return
    }
    for (const f of frames) onFrame(f)
  }
  const onClose = () => {
    if (closed) return
    closed = true
    for (const s of streams.values()) {
      if (s.timer) clearTimeout(s.timer)
    }
    streams.clear()
  }

  transport.on('message', onMessage)
  transport.on('close', onClose)

  return {
    get size() {
      return streams.size
    },
    get closed() {
      return closed
    },
    get failReason() {
      return failReason
    },
    sendHeartbeat(ts = Date.now()) {
      send(encodeJsonFrame(MuxType.HEARTBEAT, 0, { ts }))
    },
    goaway(message = 'goaway') {
      failClosed(new MuxProtocolError('GOAWAY', message, 0))
    },
    close() {
      if (closed) return
      closed = true
      for (const s of streams.values()) {
        if (s.timer) clearTimeout(s.timer)
      }
      streams.clear()
      try { transport.off?.('message', onMessage) } catch { /* */ }
      try { transport.off?.('close', onClose) } catch { /* */ }
    },
    pushBytes(buf) {
      onMessage(buf)
    },
  }
}
