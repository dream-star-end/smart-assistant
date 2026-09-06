#!/usr/bin/env node
/**
 * Minimal HTTP+WS process that uses the REAL gateway `checkLocalBridge` /
 * `isHealthzFileProxyReady` / `resolveGatewayListen` modules and the same
 * needsAuth OR predicate as `packages/gateway/src/server.ts` (HTTP around
 * the checkLocalBridge call, WS around handleWsConnection).
 *
 * Why not `packages/cli` `gatewayCmd` / `new Gateway()`:
 *   createGateway() needs onboard config, SQLite session store, CCB path,
 *   AutoDream, commercial hooks, and (when Host injects
 *   OPENCLAUDE_V3_MASTER_BASE_URL) the v3 master sink. apps/windows CI
 *   only `npm ci`s the Electron package — no workspace @openclaude/*.
 *   Booting the full class is not Linux-unit-testable here.
 *
 * Self-reexecs under Node 22 `--experimental-strip-types` or repo-root
 * `tsx` so the TypeScript modules can be imported.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const self = fileURLToPath(import.meta.url)
const windowsRoot = path.resolve(path.dirname(self), '../..')
const repoRoot = path.resolve(windowsRoot, '../..')

function nodeMajor() {
  return Number(String(process.versions.node).split('.')[0])
}

function tsxBin() {
  const base = path.join(repoRoot, 'node_modules', '.bin')
  if (process.platform === 'win32') {
    const cmd = path.join(base, 'tsx.cmd')
    if (fs.existsSync(cmd)) return cmd
  }
  const plain = path.join(base, 'tsx')
  return fs.existsSync(plain) ? plain : null
}

if (!process.env.OC_S3C_GATEWAY_LOADER) {
  const env = { ...process.env, OC_S3C_GATEWAY_LOADER: '1' }
  let command
  let args
  if (nodeMajor() >= 22) {
    command = process.execPath
    args = ['--experimental-strip-types', self]
  } else {
    const tsx = tsxBin()
    if (!tsx) {
      console.error('real-local-bridge-gateway: need Node >= 22 or repo-root tsx')
      process.exit(2)
    }
    command = tsx
    args = [self]
  }
  const child = spawn(command, args, {
    env,
    stdio: 'inherit',
    windowsHide: true,
  })
  const forward = (signal) => {
    try { child.kill(signal) } catch { /* */ }
  }
  process.on('SIGTERM', () => forward('SIGTERM'))
  process.on('SIGINT', () => forward('SIGINT'))
  child.on('exit', (code, signal) => {
    if (signal) {
      process.exit(1)
      return
    }
    process.exit(code ?? 1)
  })
} else {
  void main()
}

async function main() {
  const authUrl = pathToFileURL(path.join(repoRoot, 'packages/gateway/src/localBridgeAuth.ts')).href
  const bindUrl = pathToFileURL(path.join(repoRoot, 'packages/gateway/src/gatewayBind.ts')).href
  const wssUrl = pathToFileURL(path.join(windowsRoot, 'src/tunnel/wss.mjs')).href
  const { checkLocalBridge, isHealthzFileProxyReady } = await import(authUrl)
  const { resolveGatewayListen } = await import(bindUrl)
  const { attachWssUpgrade } = await import(wssUrl)

  const listen = resolveGatewayListen('0.0.0.0', 18789, process.env)
  const probeEnabled = process.env.OPENCLAUDE_S3C_PROBE === '1'

  function json(res, status, body, extraHeaders = {}) {
    const raw = Buffer.from(JSON.stringify(body), 'utf8')
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': String(raw.length),
      ...extraHeaders,
    })
    res.end(raw)
  }

  function checkHttpAuth(_req) {
    // Desktop spawn has no gateway accessToken in Host env. Matches the
    // production OR: local-bridge is the branch that must succeed.
    return false
  }

  /**
   * Copied from packages/gateway/src/server.ts needsAuth + the
   * `!bridgeVerified && !checkHttpAuth && !checkLocalBridge && !delegateAuthed`
   * reject. TRUST_BRIDGE three-pack is stripped by Host, so bridgeVerified
   * stays false.
   */
  function allowHttp(req, pathname) {
    const needsAuth =
      (pathname.startsWith('/api/') && pathname !== '/api/healthz') ||
      pathname.startsWith('/v1/') ||
      pathname === '/metrics'
    if (!needsAuth) return true
    const bridgeVerified = false
    const delegateAuthedByContext = false
    return (
      bridgeVerified ||
      checkHttpAuth(req) ||
      checkLocalBridge(req) ||
      delegateAuthedByContext
    )
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (url.pathname === '/healthz' || url.pathname === '/api/healthz') {
      const caps = []
      if (isHealthzFileProxyReady(process.env)) caps.push('file-proxy-v1')
      const body = {
        ok: true,
        containerId: process.env.OC_CONTAINER_ID || null,
        capabilities: caps,
        channel: process.env.OC_RUNTIME_CHANNEL?.trim() || 'v3',
      }
      const raw = Buffer.from(JSON.stringify(body), 'utf8')
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(raw.length) })
      res.end(raw)
      return
    }

    if (url.pathname === '/env-probe') {
      json(res, 200, {
        hasTrust: Object.prototype.hasOwnProperty.call(process.env, 'OPENCLAUDE_TRUST_BRIDGE_IP'),
        hasCid: Object.prototype.hasOwnProperty.call(process.env, 'OC_CONTAINER_ID'),
        hasNonce: Object.prototype.hasOwnProperty.call(process.env, 'OC_BRIDGE_NONCE'),
        hasBridge: Boolean(process.env.OPENCLAUDE_LOCAL_BRIDGE_TOKEN),
        bind: process.env.OPENCLAUDE_GATEWAY_BIND || null,
        port: process.env.OPENCLAUDE_GATEWAY_PORT || null,
        master: process.env.OPENCLAUDE_V3_MASTER_BASE_URL || null,
        tokenPrefix: String(process.env.OPENCLAUDE_V3_CONTAINER_TOKEN || '').slice(0, 10),
        tokenIsOcV3: String(process.env.OPENCLAUDE_V3_CONTAINER_TOKEN || '').startsWith('oc-v3.'),
        listen,
      })
      return
    }

    if (probeEnabled && url.pathname === '/__s3c-probe' && req.method === 'POST') {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        let body = {}
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { body = {} }
        const allowed = checkLocalBridge({
          socket: { remoteAddress: body.remoteAddress },
          headers: { 'x-openclaude-local-bridge': body.header || '' },
        })
        json(res, 200, { allowed })
      })
      return
    }

    if (!allowHttp(req, url.pathname)) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }

    if (url.pathname === '/v1/models') {
      json(res, 200, { object: 'list', data: [], echoBridge: req.headers['x-openclaude-local-bridge'] || '' })
      return
    }

    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-echo-bridge': req.headers['x-openclaude-local-bridge'] || '',
        'x-echo-path': url.pathname,
      })
      res.end(JSON.stringify({
        ok: true,
        path: url.pathname,
        echoBridge: req.headers['x-openclaude-local-bridge'] || '',
      }))
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
        const remoteIp = req.socket.remoteAddress || ''
        const TRUST_BRIDGE_IP = process.env.OPENCLAUDE_TRUST_BRIDGE_IP || ''
        const isFromBridge = !!TRUST_BRIDGE_IP && (
          remoteIp === TRUST_BRIDGE_IP ||
          remoteIp === `::ffff:${TRUST_BRIDGE_IP}`
        )
        if (!isFromBridge && !checkLocalBridge(req) && !checkHttpAuth(req)) {
          ws.close(1008, 'unauthorized')
          return
        }
        ws.on('message', (data, isBinary) => {
          if (isBinary) ws.sendBinary(data)
          else ws.sendText(Buffer.isBuffer(data) ? data.toString('utf8') : String(data))
        })
      },
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ port: listen.port, host: listen.host, exclusive: listen.exclusive }, () => resolve())
  })

  const shutdown = () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 400).unref?.()
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}
