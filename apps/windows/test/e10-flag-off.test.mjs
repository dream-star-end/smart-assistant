import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { createEnrollmentController } from '../src/enroll.mjs'
import { createMemoryIdentityStore } from '../src/identity.mjs'
import { createLocalModeController, LocalMode } from '../src/localMode.mjs'
import { createTunnelClient } from '../src/tunnel/tunnelClient.mjs'
import { createFixtureIdentityStore } from '../src/tunnel/identity.mjs'
import { spkiSha256Base64FromPem } from '../src/tunnel/bootstrap.mjs'
import { createRegisterTestServer } from './fixtures/tunnel-test-server.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const tlsDir = path.join(here, 'fixtures/tls')

function pem(name) {
  return fs.readFileSync(path.join(tlsDir, name), 'utf8')
}

function waitFor(pred, ms = 2_000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (pred()) return resolve()
      if (Date.now() - start > ms) return reject(new Error('waitFor timeout'))
      setTimeout(tick, 15)
    }
    tick()
  })
}

test('E10 flag-off enroll 404 leaves cloud shell usable and stops local reconnect', async () => {
  const httpStub = createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'FLAG_OFF' } }))
  })
  const originPort = await new Promise((resolve) => httpStub.listen(0, '127.0.0.1', () => resolve(httpStub.address().port)))
  const enroll = createEnrollmentController({
    origin: `http://127.0.0.1:${originPort}`,
    identityStore: createMemoryIdentityStore(),
    openExternal: () => {},
  })
  try {
    await assert.rejects(() => enroll.start(), /http 404/)
    const mode = createLocalModeController()
    const srv = createRegisterTestServer({
      originKey: pem('origin.key'),
      originCert: pem('origin.crt'),
      caCert: pem('ca.crt'),
      containerId: 42,
      keyringFp: 'abc',
      mode: 'flag_off',
    })
    const port = await srv.listen()
    const client = createTunnelClient({
      identity: createFixtureIdentityStore({
        certPem: pem('device.crt'),
        keyPem: pem('device.key'),
        token: 'oc-v3.42.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        generation: 1,
      }),
      registerOrigin: `wss://127.0.0.1:${port}/ws/desktop-container-register`,
      egressOrigin: `https://127.0.0.1:${port}`,
      spkiPin: spkiSha256Base64FromPem(pem('origin.crt')),
      deviceCaPem: pem('ca.crt'),
      containerId: 42,
      keyringFp: 'abc',
      handler: async () => ({ status: 200, headers: [], body: 'ok' }),
      initialBackoffMs: 20,
      jitter: 0,
      registerTimeoutMs: 400,
      connectTimeoutMs: 400,
    })
    try {
      client.start()
      await waitFor(() => client.stopped === true)
      assert.equal(client.updateRequired || client.stopped, true)
      await new Promise((r) => setTimeout(r, 60))
      assert.equal(client.connectTimes.length, 1)
      mode.noteFlagOff()
      assert.equal(mode.mode, LocalMode.FALLBACK)
    } finally {
      client.stop('test_done')
      await srv.close()
    }
  } finally {
    await new Promise((r) => httpStub.close(r))
  }
})
