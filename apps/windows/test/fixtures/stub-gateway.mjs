#!/usr/bin/env node
/**
 * Stub gateway child for Host tests. Binds loopback, echoes local-bridge,
 * healthz capabilities, optional /ws upgrade.
 */
import http from 'node:http'
import { attachWssUpgrade } from '../../src/tunnel/wss.mjs'

const port = Number(process.env.OPENCLAUDE_GATEWAY_PORT || process.env.PORT || 18789)
const bind = process.env.OPENCLAUDE_GATEWAY_BIND || '127.0.0.1'
const caps = String(process.env.STUB_HEALTHZ_CAPS || 'durable-turn-dispatch-v1')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const crashAfter = Number(process.env.STUB_CRASH_AFTER_MS || 0)

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  if (url.pathname === '/healthz') {
    const body = JSON.stringify({ ok: true, capabilities: caps })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(body)
    return
  }
  if (url.pathname === '/env-probe') {
    const body = JSON.stringify({
      hasTrust: Object.prototype.hasOwnProperty.call(process.env, 'OPENCLAUDE_TRUST_BRIDGE_IP'),
      hasCid: Object.prototype.hasOwnProperty.call(process.env, 'OC_CONTAINER_ID'),
      hasNonce: Object.prototype.hasOwnProperty.call(process.env, 'OC_BRIDGE_NONCE'),
      hasBridge: Boolean(process.env.OPENCLAUDE_LOCAL_BRIDGE_TOKEN),
      bind: process.env.OPENCLAUDE_GATEWAY_BIND || null,
      master: process.env.OPENCLAUDE_V3_MASTER_BASE_URL || null,
      tokenPrefix: String(process.env.OPENCLAUDE_V3_CONTAINER_TOKEN || '').slice(0, 10),
      tokenIsOcV3: String(process.env.OPENCLAUDE_V3_CONTAINER_TOKEN || '').startsWith('oc-v3.'),
    })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(body)
    return
  }
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    res.writeHead(200, {
      'content-type': 'text/plain',
      'x-echo-bridge': req.headers['x-openclaude-local-bridge'] || '',
      'x-echo-path': url.pathname,
    })
    res.end(Buffer.concat(chunks).length ? Buffer.concat(chunks) : Buffer.from('gateway-ok'))
  })
})

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  if (url.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  attachWssUpgrade(req, socket, head, {
    onOpen(ws) {
      ws.on('message', (data, isBinary) => {
        if (isBinary) ws.sendBinary(data)
        else ws.sendText(data.toString('utf8'))
      })
    },
  })
})

server.listen({ host: bind, port, exclusive: true }, () => {
  if (process.send) process.send({ type: 'listening', port })
})

if (crashAfter > 0) {
  setTimeout(() => process.exit(2), crashAfter).unref?.()
}

process.on('SIGTERM', () => {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 200).unref?.()
})
