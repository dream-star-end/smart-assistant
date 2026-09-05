/**
 * Local mTLS WSS register server for tunnel client tests.
 * Not a production mock of desktopRegister.ts — only the wire bits S2 needs.
 */

import https from 'node:https'
import { attachWssUpgrade } from '../../src/tunnel/wss.mjs'
import {
  FLAG_FIN,
  MuxType,
  createMuxDecoder,
  decodeFrames,
  encodeFrame,
  encodeJsonFrame,
  parseJsonPayload,
} from '../../src/tunnel/mux.mjs'

export function createRegisterTestServer({
  originKey,
  originCert,
  caCert,
  requestClientCert = true,
  mode = 'ok',
  containerId = 42,
  keyringFp = 'fp',
  onHeartbeat,
  httpHandler,
} = {}) {
  const sessions = []
  const connectLog = []

  const server = https.createServer({
    key: originKey,
    cert: originCert,
    ca: caCert,
    requestCert: requestClientCert,
    rejectUnauthorized: requestClientCert,
    minVersion: 'TLSv1.3',
    maxVersion: 'TLSv1.3',
  }, (req, res) => {
    res.writeHead(404)
    res.end('not ws')
  })

  server.on('tlsClientError', () => {})
  server.on('clientError', (_err, socket) => {
    try { socket.destroy() } catch { /* */ }
  })
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {})
    connectLog.push({ url: req.url, auth: req.headers.authorization })
    if (req.url !== '/ws/desktop-container-register') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    if (mode === 'flag_off') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    if (mode === 'killswitch') {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    if (mode === 'unauthorized') {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    attachWssUpgrade(req, socket, head, {
      onOpen(ws) {
        const session = {
          ws,
          frames: [],
          decoder: createMuxDecoder(),
          registered: false,
          heartbeats: 0,
        }
        sessions.push(session)
        if (mode === 'silent') return
        ws.on('message', (raw, isBinary) => {
          if (!session.registered) {
            let msg
            try { msg = JSON.parse(raw.toString('utf8')) } catch {
              ws.close(1008, 'bad_register')
              return
            }
            if (mode === 'update_required') {
              ws.close(1008, 'update_required')
              return
            }
            if (mode === 'stale_generation') {
              ws.close(1008, 'stale_generation')
              return
            }
            if (mode === 'mux_version') {
              ws.close(1008, 'mux_version')
              return
            }
            if (msg.type !== 'register' || msg.v !== 1 || msg.muxVersion !== 1) {
              ws.close(1008, 'bad_register')
              return
            }
            if (Number(msg.containerId) !== containerId) {
              ws.close(1008, 'container_mismatch')
              return
            }
            session.registered = true
            ws.sendText(JSON.stringify({
              type: 'register_ok',
              v: 1,
              containerId,
              muxVersion: 1,
              keyringFp,
            }))
            if (mode === 'kick_after_ok') {
              setTimeout(() => ws.close(4001, 'replaced'), 20).unref?.()
            }
            return
          }
          if (!isBinary) return
          let frames
          try {
            frames = session.decoder.push(raw)
          } catch {
            ws.close(4001, 'bad_mux')
            return
          }
          for (const f of frames) {
            session.frames.push(f)
            if (f.type === MuxType.HEARTBEAT) {
              session.heartbeats += 1
              onHeartbeat?.(session, f)
              if (mode !== 'no_heartbeat_ack') {
                let ts = Date.now()
                try {
                  const obj = f.payload.length ? parseJsonPayload(f.payload) : {}
                  if (typeof obj.ts === 'number') ts = obj.ts
                } catch { /* */ }
                ws.sendBinary(encodeJsonFrame(MuxType.HEARTBEAT_ACK, 0, { ts, serverNow: Date.now() }))
              }
            }
          }
        })
      },
    })
  })

  function sendOpenHttp(session, {
    streamId = 1,
    method = 'GET',
    path = '/healthz',
    headers = {},
    body = Buffer.alloc(0),
    deadlineMs = Date.now() + 2_000,
  } = {}) {
    session.ws.sendBinary(encodeJsonFrame(MuxType.OPEN_HTTP, streamId, {
      method,
      path,
      headers,
      deadlineMs,
    }))
    session.ws.sendBinary(encodeFrame(MuxType.HTTP_DATA, FLAG_FIN, streamId, body))
  }

  return {
    server,
    sessions,
    connectLog,
    sendOpenHttp,
    decodeFrames,
    MuxType,
    FLAG_FIN,
    listen() {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address()
          resolve(addr.port)
        })
      })
    },
    close() {
      for (const s of sessions) {
        try { s.ws.terminate() } catch { /* */ }
      }
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}
