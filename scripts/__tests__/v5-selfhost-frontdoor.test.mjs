import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startFrontdoor } from '../v5-selfhost-frontdoor.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FRONTDOOR_SCRIPT = path.resolve(__dirname, '../v5-selfhost-frontdoor.mjs')

function startMockUpstream(label, port = 0) {
  return new Promise((resolve, reject) => {
    const sockets = new Set()
    let accepted = 0
    let closed = 0
    const server = http.createServer((req, res) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        res.writeHead(200, {
          'content-type': 'application/json',
          'x-slot-label': label,
        })
        res.end(JSON.stringify({
          slot: label,
          method: req.method,
          url: req.url,
          bodyLen: body.length,
          body,
        }))
      })
    })
    server.on('connection', (s) => {
      accepted += 1
      sockets.add(s)
      s.once('close', () => {
        closed += 1
        sockets.delete(s)
      })
    })
    server.on('upgrade', (req, socket, head) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `X-Slot-Label: ${label}\r\n` +
        '\r\n',
      )
      if (head && head.length > 0) {
        socket.write(Buffer.concat([Buffer.from(`[${label}:head]`), head]))
      }
      socket.on('data', (chunk) => {
        socket.write(Buffer.concat([Buffer.from(`[${label}:echo]`), chunk]))
      })
    })
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address()
      resolve({
        server,
        port: addr.port,
        stats: () => ({ accepted, closed, open: sockets.size }),
        close: () => new Promise((r) => {
          server.close(() => r())
          if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
          for (const s of sockets) s.destroy()
        }),
      })
    })
  })
}

function httpReq(port, reqPath, { method = 'GET', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: reqPath,
      method,
      headers,
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.once('error', reject)
    if (body !== null) req.write(body)
    req.end()
  })
}

function controlReq(socketPath, method, reqPath, jsonBody = null) {
  return new Promise((resolve, reject) => {
    const payload = jsonBody !== null ? JSON.stringify(jsonBody) : null
    const req = http.request({
      socketPath,
      method,
      path: reqPath,
      headers: payload !== null
        ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
        : {},
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode, body: JSON.parse(text) })
      })
    })
    req.once('error', reject)
    if (payload !== null) req.write(payload)
    req.end()
  })
}

function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port
      s.close(() => resolve(port))
    })
  })
}

function wsRawRoundtrip(port, headPayload, secondPayload) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port })
    let buf = Buffer.alloc(0)
    let gotHeaders = false
    let headerText = ''
    let bodyBuf = Buffer.alloc(0)
    let sentSecond = false
    const timer = setTimeout(() => {
      sock.destroy()
      reject(new Error(`ws roundtrip timeout; got headers=${gotHeaders} body=${bodyBuf.toString('utf8')}`))
    }, 5000)

    sock.once('error', (err) => { clearTimeout(timer); reject(err) })
    sock.once('connect', () => {
      const reqStr =
        'GET /ws/user-chat-bridge HTTP/1.1\r\n' +
        'Host: 127.0.0.1\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
        'Sec-WebSocket-Version: 13\r\n' +
        '\r\n'
      sock.write(Buffer.concat([Buffer.from(reqStr), Buffer.from(headPayload)]))
    })
    sock.on('data', (chunk) => {
      if (!gotHeaders) {
        buf = Buffer.concat([buf, chunk])
        const idx = buf.indexOf('\r\n\r\n')
        if (idx === -1) return
        gotHeaders = true
        headerText = buf.subarray(0, idx).toString('utf8')
        bodyBuf = Buffer.concat([bodyBuf, buf.subarray(idx + 4)])
      } else {
        bodyBuf = Buffer.concat([bodyBuf, chunk])
      }
      const bodyStr = bodyBuf.toString('utf8')
      if (!sentSecond && bodyStr.includes(headPayload)) {
        sentSecond = true
        sock.write(Buffer.from(secondPayload))
      }
      if (sentSecond && bodyStr.includes(secondPayload)) {
        clearTimeout(timer)
        sock.destroy()
        resolve({ headerText, bodyStr })
      }
    })
  })
}

test('frontdoor: HTTP, WS bidirectional + head buffer, atomic A->B switch, and state persistence', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-frontdoor-test-'))
  const controlSocket = path.join(tmpDir, 'frontdoor.sock')
  const stateFile = path.join(tmpDir, 'frontdoor-state.json')
  const upA = await startMockUpstream('A')
  const upB = await startMockUpstream('B')
  let fd = await startFrontdoor({
    port: 0,
    slotAPort: upA.port,
    slotBPort: upB.port,
    controlSocket,
    stateFile,
    logger: { info() {}, warn() {}, error() {} },
  })

  try {
    // Control socket permission must be 0600
    const mode = fs.statSync(controlSocket).mode & 0o777
    assert.equal(mode, 0o600)

    // Initial GET & streaming POST go to A
    const r1 = await httpReq(fd.port, '/healthz')
    assert.equal(r1.status, 200)
    assert.equal(JSON.parse(r1.text).slot, 'A')

    const payload = 'x'.repeat(64 * 1024)
    const rPost = await httpReq(fd.port, '/api/echo', { method: 'POST', body: payload })
    assert.equal(rPost.status, 200)
    assert.equal(JSON.parse(rPost.text).bodyLen, payload.length)
    assert.equal(JSON.parse(rPost.text).slot, 'A')

    // WS upgrade preserves head buffer + bidirectional stream on A
    const wsA = await wsRawRoundtrip(fd.port, 'HEAD_A', 'MSG_A')
    assert.match(wsA.headerText, /101 Switching Protocols/)
    assert.match(wsA.headerText, /X-Slot-Label: A/)
    assert.ok(wsA.bodyStr.includes('[A:head]HEAD_A'))
    assert.ok(wsA.bodyStr.includes('[A:echo]MSG_A'))

    // Invalid slot rejected
    const bad = await controlReq(controlSocket, 'POST', '/switch', { slot: 'C' })
    assert.equal(bad.status, 400)
    assert.equal(bad.body.ok, false)

    // Atomic switch A -> B
    const sw = await controlReq(controlSocket, 'POST', '/switch', { slot: 'B' })
    assert.equal(sw.status, 200)
    assert.equal(sw.body.ok, true)
    assert.equal(sw.body.slot, 'B')
    assert.equal(sw.body.previousSlot, 'A')

    const st = await controlReq(controlSocket, 'GET', '/status')
    assert.equal(st.status, 200)
    assert.equal(st.body.slot, 'B')

    // New HTTP + WS route to B
    const r2 = await httpReq(fd.port, '/healthz')
    assert.equal(JSON.parse(r2.text).slot, 'B')

    const wsB = await wsRawRoundtrip(fd.port, 'HEAD_B', 'MSG_B')
    assert.match(wsB.headerText, /X-Slot-Label: B/)
    assert.ok(wsB.bodyStr.includes('[B:head]HEAD_B'))
    assert.ok(wsB.bodyStr.includes('[B:echo]MSG_B'))

    // Restart frontdoor and verify state file restores slot B
    await fd.close()
    fd = await startFrontdoor({
      port: 0,
      slotAPort: upA.port,
      slotBPort: upB.port,
      controlSocket,
      stateFile,
      logger: { info() {}, warn() {}, error() {} },
    })
    assert.equal(fd.getSlot(), 'B')
    const r3 = await httpReq(fd.port, '/healthz')
    assert.equal(JSON.parse(r3.text).slot, 'B')
  } finally {
    await fd.close()
    await upA.close()
    await upB.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('frontdoor: retries transient ECONNREFUSED within 2000ms budget for HTTP and WS', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-frontdoor-retry-'))
  const controlSocket = path.join(tmpDir, 'frontdoor.sock')
  const stateFile = path.join(tmpDir, 'frontdoor-state.json')
  const delayedPortA = await reserveFreePort()
  const delayedPortB = await reserveFreePort()

  const fd = await startFrontdoor({
    port: 0,
    slotAPort: delayedPortA,
    slotBPort: delayedPortB,
    controlSocket,
    stateFile,
    retryBudgetMs: 2000,
    logger: { info() {}, warn() {}, error() {} },
  })

  let upA = null
  let upB = null
  try {
    // HTTP arrives while slot A is down; slot A binds 220ms later
    const reqPromise = httpReq(fd.port, '/retry-ok')
    await new Promise((r) => setTimeout(r, 220))
    upA = await startMockUpstream('A', delayedPortA)
    const res = await reqPromise
    assert.equal(res.status, 200)
    assert.equal(JSON.parse(res.text).slot, 'A')

    // Switch to B while B is down; WS upgrade retries and succeeds when B binds 220ms later
    await controlReq(controlSocket, 'POST', '/switch', { slot: 'B' })
    const wsPromise = wsRawRoundtrip(fd.port, 'RETRY_HEAD', 'RETRY_MSG')
    await new Promise((r) => setTimeout(r, 220))
    upB = await startMockUpstream('B', delayedPortB)
    const wsRes = await wsPromise
    assert.match(wsRes.headerText, /X-Slot-Label: B/)
    assert.ok(wsRes.bodyStr.includes('[B:head]RETRY_HEAD'))
    assert.ok(wsRes.bodyStr.includes('[B:echo]RETRY_MSG'))
  } finally {
    await fd.close()
    if (upA) await upA.close()
    if (upB) await upB.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('frontdoor: cancels retry immediately on client disconnect without socket leak', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-frontdoor-abort-'))
  const controlSocket = path.join(tmpDir, 'frontdoor.sock')
  const stateFile = path.join(tmpDir, 'frontdoor-state.json')
  const deadPortA = await reserveFreePort()
  const deadPortB = await reserveFreePort()

  const fd = await startFrontdoor({
    port: 0,
    slotAPort: deadPortA,
    slotBPort: deadPortB,
    controlSocket,
    stateFile,
    retryBudgetMs: 2000,
    logger: { info() {}, warn() {}, error() {} },
  })

  try {
    const req = http.request({ host: '127.0.0.1', port: fd.port, path: '/abort-me' })
    req.on('error', () => {})
    req.end()
    await new Promise((r) => setTimeout(r, 80))
    req.destroy()
    await new Promise((r) => setTimeout(r, 120))

    const st = await controlReq(controlSocket, 'GET', '/status')
    assert.equal(st.body.activeHttpRequests, 0)
    assert.equal(st.body.activeUpgrades, 0)
  } finally {
    await fd.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('frontdoor CLI: handles SIGTERM cleanly and removes control socket', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-frontdoor-cli-'))
  const controlSocket = path.join(tmpDir, 'frontdoor.sock')
  const stateFile = path.join(tmpDir, 'frontdoor-state.json')
  const port = await reserveFreePort()
  const slotA = await reserveFreePort()
  const slotB = await reserveFreePort()

  const child = spawn(process.execPath, [FRONTDOOR_SCRIPT], {
    env: {
      ...process.env,
      OC_FRONTDOOR_HOST: '127.0.0.1',
      OC_FRONTDOOR_PORT: String(port),
      OC_FRONTDOOR_SLOT_A_PORT: String(slotA),
      OC_FRONTDOOR_SLOT_B_PORT: String(slotB),
      OC_FRONTDOOR_CONTROL_SOCKET: controlSocket,
      OC_FRONTDOOR_STATE_FILE: stateFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  try {
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('frontdoor CLI startup timeout')), 5000)
      const poll = () => {
        if (fs.existsSync(controlSocket)) {
          clearTimeout(deadline)
          resolve()
          return
        }
        setTimeout(poll, 30)
      }
      poll()
    })

    const st = await controlReq(controlSocket, 'GET', '/status')
    assert.equal(st.status, 200)
    assert.equal(st.body.slot, 'A')

    const exitCode = await new Promise((resolve) => {
      child.once('exit', (code) => resolve(code))
      child.kill('SIGTERM')
    })
    assert.equal(exitCode, 0)
    assert.equal(fs.existsSync(controlSocket), false)
  } finally {
    try { child.kill('SIGKILL') } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('B01: frontdoor CLI starts and forwards traffic when invoked via symlinked -live directory', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-frontdoor-symlink-'))
  const controlSocket = path.join(tmpDir, 'frontdoor.sock')
  const stateFile = path.join(tmpDir, 'frontdoor-state.json')
  const liveLink = path.join(tmpDir, 'openclaude-v5-selfhost-live')
  fs.symlinkSync(path.resolve(__dirname, '../..'), liveLink)
  const symlinkEntry = path.join(liveLink, 'scripts/v5-selfhost-frontdoor.mjs')

  const port = await reserveFreePort()
  const upA = await startMockUpstream('A')
  const slotB = await reserveFreePort()

  const child = spawn(process.execPath, [symlinkEntry], {
    env: {
      ...process.env,
      OC_FRONTDOOR_HOST: '127.0.0.1',
      OC_FRONTDOOR_PORT: String(port),
      OC_FRONTDOOR_SLOT_A_PORT: String(upA.port),
      OC_FRONTDOOR_SLOT_B_PORT: String(slotB),
      OC_FRONTDOOR_CONTROL_SOCKET: controlSocket,
      OC_FRONTDOOR_STATE_FILE: stateFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  try {
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('symlink frontdoor CLI failed to start')), 5000)
      child.once('exit', (code) => {
        clearTimeout(deadline)
        reject(new Error(`symlink frontdoor exited early with code=${code}`))
      })
      const poll = () => {
        if (fs.existsSync(controlSocket)) {
          clearTimeout(deadline)
          resolve()
          return
        }
        setTimeout(poll, 30)
      }
      poll()
    })

    const st = await controlReq(controlSocket, 'GET', '/status')
    assert.equal(st.status, 200)
    assert.equal(st.body.slot, 'A')

    const res = await httpReq(port, '/via-symlink')
    assert.equal(res.status, 200)
    assert.equal(JSON.parse(res.text).slot, 'A')
  } finally {
    child.kill('SIGTERM')
    await new Promise((r) => child.once('exit', r))
    await upA.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('B10: each HTTP request opens exactly one upstream TCP connection with zero leaked sockets', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-frontdoor-b10-'))
  const controlSocket = path.join(tmpDir, 'frontdoor.sock')
  const stateFile = path.join(tmpDir, 'frontdoor-state.json')
  const upA = await startMockUpstream('A')
  const upB = await startMockUpstream('B')
  const fd = await startFrontdoor({
    port: 0,
    slotAPort: upA.port,
    slotBPort: upB.port,
    controlSocket,
    stateFile,
    logger: { info() {}, warn() {}, error() {} },
  })

  try {
    for (let i = 0; i < 3; i += 1) {
      const res = await httpReq(fd.port, `/single-sock-${i}`)
      assert.equal(res.status, 200)
      assert.equal(JSON.parse(res.text).slot, 'A')
    }
    // Wait briefly for TCP FIN/close propagation on loopback
    for (let i = 0; i < 20 && upA.stats().closed < 3; i += 1) {
      await new Promise((r) => setTimeout(r, 25))
    }
    const stats = upA.stats()
    assert.equal(stats.accepted, 3, `expected exactly 3 upstream TCP accepts, got ${stats.accepted}`)
    assert.equal(stats.closed, 3, `expected all 3 upstream TCP sockets closed, got ${stats.closed} (open=${stats.open})`)
  } finally {
    await fd.close()
    await upA.close()
    await upB.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('N02: hard deadline aborts hanging pending dial within budget and returns 502 with zero dangling sockets', async () => {
  const { EventEmitter } = await import('node:events')
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-frontdoor-n02-'))
  const controlSocket = path.join(tmpDir, 'frontdoor.sock')
  const stateFile = path.join(tmpDir, 'frontdoor-state.json')
  const fakeSockets = []

  const fd = await startFrontdoor({
    port: 0,
    slotAPort: 18791,
    slotBPort: 18795,
    controlSocket,
    stateFile,
    retryBudgetMs: 300,
    dialUpstream: () => {
      // Simulate a blackholed socket that never emits 'connect' or 'error' on its own.
      const s = new EventEmitter()
      s.destroyed = false
      s.setNoDelay = () => {}
      s.setTimeout = () => {}
      s.destroy = () => { s.destroyed = true }
      fakeSockets.push(s)
      return s
    },
    logger: { info() {}, warn() {}, error() {} },
  })

  try {
    const started = Date.now()
    const res = await httpReq(fd.port, '/hang-dial')
    const elapsed = Date.now() - started
    assert.equal(res.status, 502)
    assert.equal(JSON.parse(res.text).code, 'ETIMEDOUT')
    assert.ok(elapsed < 1200, `expected bounded deadline exit, took ${elapsed}ms`)
    assert.ok(fakeSockets.length >= 1)
    assert.ok(fakeSockets.every((s) => s.destroyed === true), 'all hanging dial sockets must be destroyed')
  } finally {
    await fd.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})
