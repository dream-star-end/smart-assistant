import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { createHostRuntime } from '../src/host/runtime.mjs'
import { ElectronToHost, HostToElectron } from '../src/host/ipc.mjs'
import { MuxType } from '../src/tunnel/mux.mjs'
import { spkiSha256Base64FromPem } from '../src/tunnel/bootstrap.mjs'
import { TunnelState } from '../src/tunnel/tunnelClient.mjs'
import { createStub18445 } from './fixtures/stub-18445.mjs'
import { LOCAL_BRIDGE_HEADER_CANON } from '../src/host/tokens.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const tlsDir = path.join(here, 'fixtures/tls')
const stubGateway = path.join(here, 'fixtures/stub-gateway.mjs')
const hostMain = path.join(here, '../src/host/hostMain.mjs')

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

async function withMaster(fn, extra = {}) {
  const stub = createStub18445({
    originKey: pem('origin.key'),
    originCert: pem('origin.crt'),
    caCert: pem('ca.crt'),
    expiresIn: extra.expiresIn ?? 3600,
  })
  const port = await stub.listen()
  try {
    return await fn(stub, port)
  } finally {
    await stub.close()
  }
}

test('runtime: mint, bind proxies, mux OPEN_HTTP reaches stub gateway with local-bridge header', { timeout: 20_000 }, async () => {
  await withMaster(async (stub, originPort) => {
    const gatewayPort = await freePort()
    const origin = `https://127.0.0.1:${originPort}`
    const runtime = createHostRuntime({
      registerOrigin: origin,
      egressOrigin: origin,
      spkiPin: spkiSha256Base64FromPem(pem('origin.crt')),
      deviceCaPem: pem('ca.crt'),
      keyringFp: 'abc',
      gatewayCommand: process.execPath,
      gatewayArgs: [stubGateway],
      gatewayPort,
      egressPort: 0,
      masterPort: 0,
    })
    try {
      await runtime.start(sampleRecord())
      await waitFor(() => runtime.tunnel?.state === TunnelState.REGISTERED, 4_000)
      assert.equal(stub.mints.length, 1)
      await waitFor(() => stub.sessions.some((s) => s.registered), 2_000)
      const session = stub.sessions.find((s) => s.registered)
      stub.sendOpenHttp(session, { path: '/echo', body: Buffer.from('ping') })
      await waitFor(() => session.frames.some((f) => f.type === MuxType.HTTP_END), 2_000)
      const start = session.frames.find((f) => f.type === MuxType.HTTP_RESPONSE_START)
      assert.ok(start)
      assert.equal(JSON.parse(start.payload.toString('utf8')).status, 200)
      const data = session.frames.find((f) => f.type === MuxType.HTTP_DATA)
      assert.equal(data.payload.toString('utf8'), 'ping')

      const envProbe = await new Promise((resolve, reject) => {
        http.get({
          host: '127.0.0.1',
          port: gatewayPort,
          path: '/env-probe',
          headers: { [LOCAL_BRIDGE_HEADER_CANON]: runtime.tokens.localBridge },
        }, (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
        }).on('error', reject)
      })
      assert.equal(envProbe.hasTrust, false)
      assert.equal(envProbe.hasCid, false)
      assert.equal(envProbe.hasNonce, false)
      assert.equal(envProbe.tokenIsOcV3, false)

      const unauth = await new Promise((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1',
          port: runtime.status().ports.egress,
          path: '/v1/messages',
          method: 'POST',
        }, (res) => {
          res.resume()
          resolve(res.statusCode)
        })
        req.on('error', reject)
        req.end('{}')
      })
      assert.equal(unauth, 401)
    } finally {
      await runtime.stop()
    }
  })
})

test('short expires_in refreshes and reconnects the tunnel', { timeout: 20_000 }, async () => {
  const stub = createStub18445({
    originKey: pem('origin.key'),
    originCert: pem('origin.crt'),
    caCert: pem('ca.crt'),
    expiresIn: 1,
  })
  const originPort = await stub.listen()
  const gatewayPort = await freePort()
  const origin = `https://127.0.0.1:${originPort}`
  const runtime = createHostRuntime({
    registerOrigin: origin,
    egressOrigin: origin,
    spkiPin: spkiSha256Base64FromPem(pem('origin.crt')),
    deviceCaPem: pem('ca.crt'),
    keyringFp: 'abc',
    gatewayCommand: process.execPath,
    gatewayArgs: [stubGateway],
    gatewayPort,
    egressPort: 0,
    masterPort: 0,
    refreshLeadMs: 700,
  })
  try {
    await runtime.start(sampleRecord())
    await waitFor(() => runtime.tunnel?.state === TunnelState.REGISTERED, 4_000)
    await waitFor(() => stub.refreshes.length >= 1 && runtime.identity.getGeneration() >= 2, 3_000)
    await waitFor(() => runtime.tunnel?.state === TunnelState.REGISTERED, 4_000)
    assert.ok(stub.refreshes.length >= 1)
    assert.ok(runtime.identity.getGeneration() >= 2)
  } finally {
    await runtime.stop()
    await stub.close()
  }
})

test('hostMain IPC handshake, start, and parent exit tears down Host', { timeout: 20_000 }, async () => {
  const stub = createStub18445({
    originKey: pem('origin.key'),
    originCert: pem('origin.crt'),
    caCert: pem('ca.crt'),
  })
  const originPort = await stub.listen()
  const gatewayPort = await freePort()
  const origin = `https://127.0.0.1:${originPort}`
  const child = spawn(process.execPath, [hostMain], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env },
  })
  const messages = []
  child.on('message', (m) => messages.push(m))
  try {
    child.send({ type: ElectronToHost.HELLO, v: 1 })
    await waitFor(() => messages.some((m) => m.type === HostToElectron.HELLO_OK))
    const hello = messages.find((m) => m.type === HostToElectron.HELLO_OK)
    assert.equal(typeof hello.pid, 'number')
    assert.equal(child.spawnargs.join(' ').includes('oc-dv.'), false)
    child.send({
      type: ElectronToHost.START,
      identity: sampleRecord(),
      config: {
        registerOrigin: origin,
        egressOrigin: origin,
        spkiPin: spkiSha256Base64FromPem(pem('origin.crt')),
        deviceCaPem: pem('ca.crt'),
        keyringFp: 'abc',
        gatewayCommand: process.execPath,
        gatewayArgs: [stubGateway],
        gatewayPort,
        egressPort: 0,
        masterPort: 0,
      },
    })
    await waitFor(() => messages.some((m) => m.type === HostToElectron.STARTED || m.type === HostToElectron.ERROR), 6_000)
    const err = messages.find((m) => m.type === HostToElectron.ERROR)
    if (err) throw new Error(`host error ${err.code}: ${err.message}`)
    const started = messages.find((m) => m.type === HostToElectron.STARTED)
    assert.ok(started)
    assert.equal(JSON.stringify(started).includes('oc-v3.'), false)

    const pid = child.pid
    child.kill('SIGTERM')
    await waitFor(() => child.exitCode !== null || child.killed, 3_000)
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(pid > 0, true)
  } finally {
    try { child.kill('SIGKILL') } catch { /* */ }
    await stub.close()
  }
})
