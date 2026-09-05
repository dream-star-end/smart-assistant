import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  assertGatewayEnvSafe,
  buildGatewayEnv,
  createGatewayProcess,
  healthzHasFileProxy,
} from '../src/host/gatewayProcess.mjs'
import {
  applyLocalBridgeHeaders,
  connectLoopbackWs,
  createMuxHttpForwarder,
} from '../src/host/muxForward.mjs'
import { createHostRuntime } from '../src/host/runtime.mjs'
import {
  FORBIDDEN_GATEWAY_ENV,
  LOCAL_BRIDGE_HEADER,
  LOCAL_BRIDGE_HEADER_CANON,
  createLahGwToken,
  createLahToken,
  createLocalBridgeToken,
} from '../src/host/tokens.mjs'
import { spkiSha256Base64FromPem } from '../src/tunnel/bootstrap.mjs'
import { MuxType } from '../src/tunnel/mux.mjs'
import { TunnelState } from '../src/tunnel/tunnelClient.mjs'
import { createStub18445 } from './fixtures/stub-18445.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const realGateway = path.join(here, 'fixtures/real-local-bridge-gateway.mjs')
const repoRoot = path.resolve(here, '../../..')
const tlsDir = path.join(here, 'fixtures/tls')
const skipWin = process.platform === 'win32'
const TOKEN_RE = /^[0-9a-f]{64}$/i
const LAH_GW_RE = /^oc-lah-gw\.[0-9a-f]{64}$/i

function realGatewaySpawn() {
  const tsx = process.platform === 'win32'
    ? path.join(repoRoot, 'node_modules/.bin/tsx.cmd')
    : path.join(repoRoot, 'node_modules/.bin/tsx')
  if (fs.existsSync(tsx)) {
    return { command: tsx, args: [realGateway], extraEnv: { OC_S3C_GATEWAY_LOADER: '1' } }
  }
  const major = Number(String(process.versions.node).split('.')[0])
  if (major >= 22) {
    return {
      command: process.execPath,
      args: ['--experimental-strip-types', realGateway],
      extraEnv: { OC_S3C_GATEWAY_LOADER: '1' },
    }
  }
  return { command: process.execPath, args: [realGateway], extraEnv: {} }
}

function pem(name) {
  return fs.readFileSync(path.join(tlsDir, name), 'utf8')
}

function sampleRecord() {
  return {
    deviceId: '11111111-1111-1111-1111-111111111111',
    containerId: 42,
    device_cert: pem('device.crt'),
    device_key: pem('device.key'),
    device_credential: 'oc-dv.11111111-1111-1111-1111-111111111111.' + 'ab'.repeat(32),
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port
      s.close(() => resolve(port))
    })
    s.on('error', reject)
  })
}

function waitFor(pred, ms = 4_000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (pred()) return resolve()
      if (Date.now() - start > ms) return reject(new Error('waitFor timeout'))
      setTimeout(tick, 25)
    }
    tick()
  })
}

function getJson(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = JSON.parse(raw) } catch { /* */ }
        resolve({ status: res.statusCode, raw, json, headers: res.headers })
      })
    }).on('error', reject)
  })
}

function postJson(port, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8')
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: urlPath,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(payload.length),
        ...headers,
      },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = JSON.parse(raw) } catch { /* */ }
        resolve({ status: res.statusCode, raw, json })
      })
    })
    req.on('error', reject)
    req.end(payload)
  })
}

function once(ee, event, ms = 3_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timeout`)), ms)
    const onErr = (err) => {
      if (event === 'error') return
      clearTimeout(timer)
      reject(err)
    }
    ee.once(event, (...args) => {
      clearTimeout(timer)
      ee.off('error', onErr)
      resolve(args)
    })
    if (event !== 'error') ee.once('error', onErr)
  })
}

function rawUpgrade(port, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/ws',
      method: 'GET',
      headers: {
        host: `127.0.0.1:${port}`,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': Buffer.alloc(16).toString('base64'),
        ...headers,
      },
    })
    const timer = setTimeout(() => {
      req.destroy()
      reject(new Error('upgrade timeout'))
    }, 3_000)
    req.on('upgrade', (res, socket) => {
      clearTimeout(timer)
      socket.once('data', (chunk) => {
        socket.destroy()
        resolve({ kind: 'upgrade', status: res.statusCode, first: chunk })
      })
      socket.once('close', () => resolve({ kind: 'upgrade-close', status: res.statusCode }))
    })
    req.on('response', (res) => {
      clearTimeout(timer)
      res.resume()
      resolve({ kind: 'http', status: res.statusCode })
    })
    req.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    req.end()
  })
}

async function withRealGateway(fn, extraEnv = {}) {
  const port = await freePort()
  const localBridgeToken = createLocalBridgeToken()
  const lahGwToken = createLahGwToken()
  const lahToken = createLahToken()
  const spawnSpec = realGatewaySpawn()
  const proc = createGatewayProcess({
    command: spawnSpec.command,
    args: spawnSpec.args,
    localBridgeToken,
    lahGwToken,
    lahToken,
    masterProxyPort: 18792,
    gatewayPort: port,
    extraEnv: { OPENCLAUDE_S3C_PROBE: '1', ...spawnSpec.extraEnv, ...extraEnv },
    healthzTimeoutMs: 20_000,
  })
  await proc.start()
  try {
    return await fn({ proc, port, localBridgeToken, lahGwToken })
  } finally {
    await proc.stop()
  }
}

test('S3c-1 buildGatewayEnv keys/format match gateway local-bridge + v3 sink contract', () => {
  const localBridgeToken = createLocalBridgeToken()
  const lahGwToken = createLahGwToken()
  const lahToken = createLahToken()
  const env = buildGatewayEnv({
    baseEnv: {
      PATH: process.env.PATH,
      OPENCLAUDE_TRUST_BRIDGE_IP: '172.30.0.1',
      OC_CONTAINER_ID: '9',
      OC_BRIDGE_NONCE: 'aa'.repeat(32),
      OPENCLAUDE_V3_CONTAINER_TOKEN_FILE: '/tmp/secret',
    },
    localBridgeToken,
    lahGwToken,
    lahToken,
    masterProxyPort: 18792,
  })
  assert.equal(TOKEN_RE.test(env.OPENCLAUDE_LOCAL_BRIDGE_TOKEN), true)
  assert.equal(env.OPENCLAUDE_LOCAL_BRIDGE_TOKEN.length, 64)
  assert.equal(env.OPENCLAUDE_GATEWAY_BIND, '127.0.0.1')
  assert.equal(env.OPENCLAUDE_V3_MASTER_BASE_URL, 'http://127.0.0.1:18792')
  assert.equal(env.OPENCLAUDE_V3_MASTER_BASE_URL.includes('localhost'), false)
  assert.equal(LAH_GW_RE.test(env.OPENCLAUDE_V3_CONTAINER_TOKEN), true)
  assert.equal(env.OPENCLAUDE_V3_CONTAINER_TOKEN.startsWith('oc-v3.'), false)
  assert.equal(/^oc-lah\.[0-9a-f]{64}$/i.test(env.ANTHROPIC_AUTH_TOKEN), true)
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:18791')
  for (const key of FORBIDDEN_GATEWAY_ENV) {
    assert.equal(Object.hasOwn(env, key), false, key)
  }
  assertGatewayEnvSafe(env)
})

test('S3c-3 assertGatewayEnvSafe rejects TRUST_BRIDGE trio and oc-v3', () => {
  assert.throws(() => assertGatewayEnvSafe({ OPENCLAUDE_TRUST_BRIDGE_IP: '127.0.0.1' }))
  assert.throws(() => assertGatewayEnvSafe({ OC_CONTAINER_ID: '1' }))
  assert.throws(() => assertGatewayEnvSafe({ OC_BRIDGE_NONCE: 'ab'.repeat(32) }))
  assert.throws(() => assertGatewayEnvSafe({ OPENCLAUDE_V3_CONTAINER_TOKEN: 'oc-v3.1.' + 'a'.repeat(64) }))
  assert.doesNotThrow(() => assertGatewayEnvSafe({
    OPENCLAUDE_V3_CONTAINER_TOKEN: createLahGwToken(),
    OPENCLAUDE_LOCAL_BRIDGE_TOKEN: createLocalBridgeToken(),
    ANTHROPIC_AUTH_TOKEN: createLahToken(),
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:18791',
  }))
})

test('S3c-2 muxForward stamps X-OpenClaude-Local-Bridge and drops inbound copies', () => {
  const token = createLocalBridgeToken()
  const stamped = applyLocalBridgeHeaders({
    [LOCAL_BRIDGE_HEADER]: 'attacker',
    [LOCAL_BRIDGE_HEADER_CANON]: 'attacker',
    accept: '*/*',
  }, token)
  assert.equal(stamped[LOCAL_BRIDGE_HEADER_CANON], token)
  assert.equal(stamped[LOCAL_BRIDGE_HEADER], undefined)
  assert.equal(stamped.accept, '*/*')
})

test('S3c-4/5/6 real local-bridge gateway: healthz, needsAuth HTTP, WS, non-loopback', {
  skip: skipWin,
  timeout: 30_000,
}, async () => {
  await withRealGateway(async ({ proc, port, localBridgeToken }) => {
    const healthz = await getJson(port, '/healthz', { [LOCAL_BRIDGE_HEADER_CANON]: localBridgeToken })
    assert.equal(healthz.status, 200)
    assert.equal(healthz.json?.ok, true)
    assert.equal(healthzHasFileProxy(healthz.raw), false)
    assert.equal(Array.isArray(healthz.json.capabilities), true)
    assert.equal(healthz.json.capabilities.includes('file-proxy-v1'), false)

    const envProbe = await getJson(port, '/env-probe')
    assert.equal(envProbe.json.hasTrust, false)
    assert.equal(envProbe.json.hasCid, false)
    assert.equal(envProbe.json.hasNonce, false)
    assert.equal(envProbe.json.hasBridge, true)
    assert.equal(envProbe.json.bind, '127.0.0.1')
    assert.equal(envProbe.json.tokenIsOcV3, false)
    assert.equal(String(envProbe.json.tokenPrefix).startsWith('oc-lah-gw.'), true)
    assert.equal(envProbe.json.listen.host, '127.0.0.1')
    assert.equal(envProbe.json.listen.port, port)
    assert.equal(envProbe.json.listen.exclusive, true)
    assert.equal(proc.degraded, false)

    const ok = await getJson(port, '/v1/models', { [LOCAL_BRIDGE_HEADER_CANON]: localBridgeToken })
    assert.equal(ok.status, 200)
    assert.equal(ok.json.echoBridge, localBridgeToken)

    const missing = await getJson(port, '/v1/models')
    assert.equal(missing.status, 401)

    const wrong = await getJson(port, '/v1/models', { [LOCAL_BRIDGE_HEADER_CANON]: 'bb'.repeat(32) })
    assert.equal(wrong.status, 401)

    const fwd = createMuxHttpForwarder({ gatewayPort: port, localBridgeToken })
    const muxed = await fwd.handler({ method: 'GET', path: '/v1/models', headers: { [LOCAL_BRIDGE_HEADER]: 'attacker' } })
    assert.equal(muxed.status, 200)
    const muxBody = JSON.parse(muxed.body.toString('utf8'))
    assert.equal(muxBody.echoBridge, localBridgeToken)

    const wsOk = connectLoopbackWs({ port, path: '/ws', localBridgeToken })
    await once(wsOk, 'open')
    wsOk.close(1000, 'done')
    await once(wsOk, 'close').catch(() => {})

    const wsBad = connectLoopbackWs({ port, path: '/ws', localBridgeToken: 'cc'.repeat(32) })
    const badClosed = once(wsBad, 'close')
    await once(wsBad, 'open').catch(() => {})
    const [badCode] = await badClosed
    assert.ok(badCode === 1008 || badCode === 1006, `expected WS 1008/1006, got ${badCode}`)

    const noHdr = await rawUpgrade(port, {})
    assert.ok(noHdr.kind === 'upgrade' || noHdr.kind === 'upgrade-close' || noHdr.kind === 'http')
    if (noHdr.kind === 'http') assert.equal(noHdr.status, 401)
    else if (noHdr.first) {
      assert.ok(noHdr.first.length >= 2)
      assert.equal(noHdr.first.readUInt16BE(0) === 1008 || noHdr.first[0] === 0x88, true)
    }

    const loop = await postJson(port, '/__s3c-probe', {
      remoteAddress: '127.0.0.1',
      header: localBridgeToken,
    })
    assert.equal(loop.json.allowed, true)
    const mapped = await postJson(port, '/__s3c-probe', {
      remoteAddress: '::ffff:127.0.0.1',
      header: localBridgeToken,
    })
    assert.equal(mapped.json.allowed, true)
    const remote = await postJson(port, '/__s3c-probe', {
      remoteAddress: '10.0.0.8',
      header: localBridgeToken,
    })
    assert.equal(remote.json.allowed, false)

    const nics = os.networkInterfaces()
    let other = null
    for (const rows of Object.values(nics)) {
      for (const row of rows || []) {
        if (row.family === 'IPv4' && !row.internal && row.address !== '127.0.0.1') {
          other = row.address
          break
        }
      }
      if (other) break
    }
    if (other) {
      const refused = await new Promise((resolve) => {
        const sock = net.connect({ host: other, port }, () => {
          sock.destroy()
          resolve('connected')
        })
        sock.setTimeout(400)
        sock.on('timeout', () => { sock.destroy(); resolve('timeout') })
        sock.on('error', (err) => resolve(err.code || err.message))
      })
      assert.notEqual(refused, 'connected')
    }
  })
})

test('S3c Host spawn real gateway + stub 18445: mux needsAuth 200 and 18792 Bearer oc-lah-gw', {
  skip: skipWin,
  timeout: 40_000,
}, async () => {
  const stub = createStub18445({
    originKey: pem('origin.key'),
    originCert: pem('origin.crt'),
    caCert: pem('ca.crt'),
  })
  const originPort = await stub.listen()
  const gatewayPort = await freePort()
  const origin = `https://127.0.0.1:${originPort}`
  const spawnSpec = realGatewaySpawn()
  const runtime = createHostRuntime({
    registerOrigin: origin,
    egressOrigin: origin,
    spkiPin: spkiSha256Base64FromPem(pem('origin.crt')),
    deviceCaPem: pem('ca.crt'),
    keyringFp: 'abc',
    gatewayCommand: spawnSpec.command,
    gatewayArgs: spawnSpec.args,
    gatewayExtraEnv: spawnSpec.extraEnv,
    gatewayPort,
    egressPort: 0,
    masterPort: 0,
  })
  try {
    await runtime.start(sampleRecord())
    await waitFor(() => runtime.tunnel?.state === TunnelState.REGISTERED, 8_000)
    const lastEnv = runtime.gateway.lastEnv
    assert.ok(lastEnv)
    assert.equal(TOKEN_RE.test(lastEnv.OPENCLAUDE_LOCAL_BRIDGE_TOKEN), true)
    assert.equal(lastEnv.OPENCLAUDE_GATEWAY_BIND, '127.0.0.1')
    assert.equal(lastEnv.OPENCLAUDE_V3_MASTER_BASE_URL, `http://127.0.0.1:${runtime.status().ports.master}`)
    assert.equal(LAH_GW_RE.test(lastEnv.OPENCLAUDE_V3_CONTAINER_TOKEN), true)
    assertGatewayEnvSafe(lastEnv)
    assert.equal(runtime.status().degraded, false)

    const healthz = await getJson(gatewayPort, '/healthz')
    assert.equal(healthz.status, 200)
    assert.equal(healthzHasFileProxy(healthz.raw), false)

    const session = stub.sessions.find((s) => s.registered)
    assert.ok(session)
    stub.sendOpenHttp(session, { path: '/v1/models' })
    await waitFor(() => session.frames.some((f) => f.type === MuxType.HTTP_END), 4_000)
    const start = session.frames.find((f) => f.type === MuxType.HTTP_RESPONSE_START)
    assert.equal(JSON.parse(start.payload.toString('utf8')).status, 200)

    const masterPort = runtime.status().ports.master
    const gwTok = runtime.tokens.lahGw
    const authed = await postJson(masterPort, '/internal/v3/server-authored-message', { ok: true }, {
      authorization: `Bearer ${gwTok}`,
    })
    assert.equal(authed.status, 200)
    const noTok = await postJson(masterPort, '/internal/v3/server-authored-message', { ok: true })
    assert.equal(noTok.status, 401)
    const badTok = await postJson(masterPort, '/internal/v3/server-authored-message', { ok: true }, {
      authorization: 'Bearer oc-lah-gw.' + 'dd'.repeat(32),
    })
    assert.equal(badTok.status, 401)
    const ocV3 = await postJson(masterPort, '/internal/v3/server-authored-message', { ok: true }, {
      authorization: 'Bearer oc-v3.42.' + 'ee'.repeat(32),
    })
    assert.equal(ocV3.status, 401)
  } finally {
    await runtime.stop()
    await stub.close()
  }
})
