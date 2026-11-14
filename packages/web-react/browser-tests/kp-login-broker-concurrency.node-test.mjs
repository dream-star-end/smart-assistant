// INC-20261109-KP-QR-BROKER-CONCURRENCY real-browser proof.
// A real Chromium loads a WeChat-shaped login page whose assets open more than
// 9 simultaneous TLS tunnels, through the real host managed-browser broker
// (browserBroker.ts) with the real Knowledge Planet login limits. The QR image is
// requested while those tunnels are still busy and must load. The same page with
// the previous envelope (maxConcurrent 8) must show broker drops, proving the
// scenario actually exceeds the old limit.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpsServer } from 'node:https'
import { createRequire } from 'node:module'
import { createConnection, createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveBrowserExecutable } from '../../../scripts/lib/resolve-browser.mjs'

const require = createRequire(import.meta.url)
const { build } = require('esbuild')
const { chromium } = require('playwright-core')

const HOSTS = [
  'open.weixin.qq.com',
  'lp.open.weixin.qq.com',
  'res.wx.qq.com',
  'support.weixin.qq.com',
]
const ASSETS_PER_HOST = 3 // 4 hosts x 3 held assets = 12 concurrent tunnels (> 9) before the QR request
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

async function loadBroker(dir) {
  const commercial = fileURLToPath(new URL('../../commercial/src/plugins/', import.meta.url))
  const out = join(dir, 'broker.mjs')
  await build({
    stdin: {
      contents:
        "export { createManagedBrowserTlsBroker } from './browserBroker.ts'\n" +
        "export { KNOWLEDGE_PLANET_LOGIN_BROKER_LIMITS, KNOWLEDGE_PLANET_ACTION_BROKER_LIMITS } from './knowledgePlanetBrokerLimits.ts'\n",
      resolveDir: commercial,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: out,
    logLevel: 'silent',
  })
  return import(pathToFileURL(out).href)
}

function frame(value) {
  const body = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}

async function runPage({ broker, limits, label, dir, cert, key }) {
  const sockets = new Set()
  let qrServed = false
  const upstream = createHttpsServer({ cert, key }, (req, res) => {
    const url = new URL(req.url, 'https://x')
    if (url.pathname === '/login') {
      const port = upstream.address().port
      const assets = HOSTS.flatMap((host) =>
        Array.from(
          { length: ASSETS_PER_HOST },
          (_, i) => `<img class="asset" src="https://${host}:${port}/asset/${i}.png">`,
        ),
      ).join('')
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Connection', 'close')
      res.end(`<!doctype html><body>${assets}<script>
        setTimeout(() => { const qr = document.createElement('img'); qr.id = 'qr';
          qr.src = 'https://open.weixin.qq.com:${port}/connect/qrcode/test-uuid'; document.body.append(qr) }, 400)
      </script></body>`)
      return
    }
    const hold = url.pathname.startsWith('/asset/') ? 2_500 : 0
    if (url.pathname.startsWith('/connect/qrcode/')) qrServed = true
    setTimeout(() => {
      res.setHeader('Content-Type', 'image/png')
      res.setHeader('Cache-Control', 'no-store')
      res.end(PNG_1X1)
    }, hold)
  })
  upstream.on('connection', (socket) => sockets.add(socket))
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const port = upstream.address().port
  const root = await mkdtemp(join(dir, `${label}-`))
  const handle = await broker.createManagedBrowserTlsBroker({
    root,
    invocationId: randomUUID(),
    pins: HOSTS.map((hostname) => ({
      origin: `https://${hostname}:${port}`,
      hostname,
      port,
      ip: '127.0.0.1',
      family: 4,
    })),
    expectedOwnerUid: process.getuid?.() ?? 0,
    socketUid: process.getuid?.() ?? 0,
    socketGid: process.getgid?.() ?? 0,
    limits,
  })
  // In-container relay stand-in: HTTP CONNECT -> authenticated broker tunnel.
  let open = 0
  let peak = 0
  let dropped = 0
  const relay = createNetServer((client) => {
    sockets.add(client)
    client.on('error', () => {})
    client.once('data', (chunk) => {
      const match = /^CONNECT ([a-z0-9.-]+):(\d+) HTTP\/1\.[01]\r\n/.exec(chunk.toString('latin1'))
      // like the real relay: only the pinned login origins are tunnelled at all
      if (!match || !HOSTS.includes(match[1])) return client.destroy()
      const tunnel = createConnection(handle.mount.hostSocketPath)
      sockets.add(tunnel)
      let acked = false
      tunnel.on('error', () => {})
      tunnel.once('connect', () =>
        tunnel.write(frame({ token: handle.mount.token, host: match[1], port: Number(match[2]) })),
      )
      tunnel.once('data', (first) => {
        if (first[0] !== 0) return client.destroy()
        acked = true
        open++
        peak = Math.max(peak, open)
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (first.length > 1) client.write(first.subarray(1))
        tunnel.pipe(client)
        client.pipe(tunnel)
      })
      tunnel.once('close', () => {
        if (acked) open--
        else dropped++
        client.destroy()
      })
      client.once('close', () => tunnel.destroy())
    })
  })
  await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve))
  let browser
  try {
    browser = await chromium.launch({
      executablePath: resolveBrowserExecutable(),
      headless: true,
      proxy: { server: `http://127.0.0.1:${relay.address().port}` },
      args: [
        '--disable-quic',
        '--no-sandbox',
        '--disable-background-networking',
        '--disable-component-update',
        '--no-first-run',
      ],
    })
    const context = await browser.newContext({ ignoreHTTPSErrors: true })
    const page = await context.newPage()
    await page.goto(`https://open.weixin.qq.com:${port}/login`, {
      waitUntil: 'domcontentloaded',
      timeout: 15_000,
    })
    const qr = await page
      .waitForFunction(
        () => {
          const img = document.getElementById('qr')
          if (!img || !img.complete) return null
          return { loaded: img.naturalWidth > 0 }
        },
        null,
        { timeout: 12_000, polling: 50 },
      )
      .then((h) => h.jsonValue())
      .catch(() => ({ loaded: false }))
    return { qrLoaded: qr.loaded, qrServed, peak, dropped }
  } finally {
    await browser?.close().catch(() => {})
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => relay.close(() => resolve()))
    await new Promise((resolve) => upstream.close(() => resolve()))
    await handle.close()
  }
}

test(
  'Knowledge Planet login broker loads the WeChat QR while more than 9 tunnels are open',
  { timeout: 120_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-kp-broker-browser-'))
    try {
      const keyPath = join(dir, 'key.pem')
      const certPath = join(dir, 'cert.pem')
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-days',
          '1',
          '-subj',
          '/CN=open.weixin.qq.com',
          '-addext',
          `subjectAltName=${HOSTS.map((h) => `DNS:${h}`).join(',')}`,
          '-keyout',
          keyPath,
          '-out',
          certPath,
        ],
        { stdio: 'ignore' },
      )
      const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)])
      await writeFile(join(dir, '.keep'), '')
      const broker = await loadBroker(dir)

      const login = await runPage({
        broker,
        limits: broker.KNOWLEDGE_PLANET_LOGIN_BROKER_LIMITS,
        label: 'login',
        dir,
        cert,
        key,
      })
      assert.ok(login.peak > 9, `scenario must exceed 9 concurrent tunnels (peak=${login.peak})`)
      assert.equal(login.dropped, 0, 'login limits must not drop any WeChat tunnel')
      assert.ok(
        login.qrServed && login.qrLoaded,
        'Knowledge Planet login broker loads the WeChat QR image with more than 9 concurrent tunnels',
      )

      const old = await runPage({
        broker,
        limits: broker.KNOWLEDGE_PLANET_ACTION_BROKER_LIMITS,
        label: 'action',
        dir,
        cert,
        key,
      })
      assert.ok(
        old.dropped > 0,
        `previous envelope (maxConcurrent 8) must drop tunnels on the same page (dropped=${old.dropped}, peak=${old.peak})`,
      )
      assert.ok(old.peak <= 8)
      console.log('KP_BROKER_PROOF', JSON.stringify({ login, old }))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
)
