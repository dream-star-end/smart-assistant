import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { createEncryptedFileIdentityStore } from '../src/identity.mjs'
import { createHostSupervisor } from '../src/hostSupervisor.mjs'
import { createStub18445 } from './fixtures/stub-18445.mjs'
import { spkiSha256Base64FromPem } from '../src/tunnel/bootstrap.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const tlsDir = path.join(here, 'fixtures/tls')
const stubGateway = path.join(here, 'fixtures/stub-gateway.mjs')
const hostMain = path.join(here, '../src/host/hostMain.mjs')

function pem(name) {
  return fs.readFileSync(path.join(tlsDir, name), 'utf8')
}

function waitFor(pred, ms = 8_000) {
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
    const s = http.createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port
      s.close(() => resolve(port))
    })
    s.on('error', reject)
  })
}

test('E16 revoke deletes identity blob, stops Host/gateway, remint 401', { timeout: 25_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clarvy-revoke-'))
  const store = createEncryptedFileIdentityStore({
    directory: dir,
    encrypt: (text) => Buffer.from(text, 'utf8'),
    decrypt: (buf) => Buffer.from(buf).toString('utf8'),
  })
  await store.save({
    deviceId: '11111111-1111-1111-1111-111111111111',
    containerId: 42,
    device_cert: pem('device.crt'),
    device_key: pem('device.key'),
    device_credential: `oc-dv.11111111-1111-1111-1111-111111111111.${'ab'.repeat(32)}`,
  })
  assert.equal(fs.existsSync(store.filePath), true)

  const stub = createStub18445({
    originKey: pem('origin.key'),
    originCert: pem('origin.crt'),
    caCert: pem('ca.crt'),
  })
  const originPort = await stub.listen()
  const origin = `https://127.0.0.1:${originPort}`
  const gatewayPort = await freePort()
  const supervisor = createHostSupervisor({
    execPath: process.execPath,
    hostEntry: hostMain,
    identityLoader: async () => store.load(),
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
  try {
    await supervisor.start()
    await waitFor(() => Number(supervisor.pid) > 0)
    const pid = supervisor.pid
    await supervisor.stop()
    assert.equal(supervisor.pid, null)
    assert.notEqual(pid, null)
    await store.revoke()
    assert.equal(fs.existsSync(store.filePath), false)
    assert.equal(await store.load(), null)
  } finally {
    await supervisor.stop().catch(() => {})
    await stub.close()
  }

  const mint401 = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/desktop/token') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
    server.on('error', reject)
  })
  try {
    const res = await fetch(`http://127.0.0.1:${mint401.port}/api/desktop/token`, { method: 'POST', body: '{}' })
    assert.equal(res.status, 401)
  } finally {
    await new Promise((r) => mint401.server.close(r))
  }
})
