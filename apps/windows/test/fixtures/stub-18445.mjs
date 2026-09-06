/**
 * Stub 18445: mTLS token mint/refresh + WSS register on one TLS port.
 */
import https from 'node:https'
import { attachWssUpgrade } from '../../src/tunnel/wss.mjs'
import {
  FLAG_FIN,
  MuxType,
  createMuxDecoder,
  encodeFrame,
  encodeJsonFrame,
  parseJsonPayload,
} from '../../src/tunnel/mux.mjs'

export function createStub18445({
  originKey,
  originCert,
  caCert,
  requestClientCert = true,
  containerId = 42,
  keyringFp = 'abc',
  expiresIn = 3600,
  mode = 'ok',
} = {}) {
  let generation = 0
  const mints = []
  const refreshes = []
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
    const url = new URL(req.url || '/', 'https://127.0.0.1')
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      let body = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { body = {} }
      if (req.method === 'POST' && url.pathname === '/api/desktop/token') {
        generation += 1
        const token = `oc-v3.${containerId}.${'a'.repeat(64)}`.replace(/a{64}/, generation.toString(16).padStart(64, 'b'))
        mints.push({ body, auth: req.headers.authorization, generation })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          token,
          expires_in: expiresIn,
          container_id: containerId,
          generation,
        }))
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/desktop/token/refresh') {
        generation += 1
        const token = `oc-v3.${containerId}.${generation.toString(16).padStart(64, 'c')}`
        refreshes.push({ body, auth: req.headers.authorization, generation })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          token,
          expires_in: expiresIn,
          container_id: containerId,
          generation,
        }))
        return
      }
      if (req.method === 'POST' && url.pathname === '/v1/messages') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: 'msg_stub', type: 'message', role: 'assistant', content: [] }))
        return
      }
      if (url.pathname.startsWith('/internal/v3/')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, path: url.pathname }))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }))
    })
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
    if (mode === 'killswitch') {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
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
        ws.on('message', (raw, isBinary) => {
          if (!session.registered) {
            let msg
            try { msg = JSON.parse(raw.toString('utf8')) } catch {
              ws.close(1008, 'bad_register')
              return
            }
            if (msg.type !== 'register' || msg.v !== 1 || msg.muxVersion !== 1) {
              ws.close(1008, 'bad_register')
              return
            }
            session.registered = true
            ws.sendText(JSON.stringify({
              type: 'register_ok',
              v: 1,
              containerId,
              muxVersion: 1,
              keyringFp,
              generation,
            }))
            return
          }
          if (!isBinary) return
          let frames
          try { frames = session.decoder.push(raw) } catch {
            ws.close(4001, 'bad_mux')
            return
          }
          for (const f of frames) {
            session.frames.push(f)
            if (f.type === MuxType.HEARTBEAT) {
              session.heartbeats += 1
              let ts = Date.now()
              try {
                const obj = f.payload.length ? parseJsonPayload(f.payload) : {}
                if (typeof obj.ts === 'number') ts = obj.ts
              } catch { /* */ }
              ws.sendBinary(encodeJsonFrame(MuxType.HEARTBEAT_ACK, 0, { ts, serverNow: Date.now() }))
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
      method, path, headers, deadlineMs,
    }))
    session.ws.sendBinary(encodeFrame(MuxType.HTTP_DATA, FLAG_FIN, streamId, body))
  }

  function sendOpenWs(session, { streamId = 3, path = '/ws' } = {}) {
    session.ws.sendBinary(encodeJsonFrame(MuxType.OPEN_WS, streamId, { path }))
  }

  return {
    server,
    sessions,
    mints,
    refreshes,
    connectLog,
    sendOpenHttp,
    sendOpenWs,
    MuxType,
    FLAG_FIN,
    listen() {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port))
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
