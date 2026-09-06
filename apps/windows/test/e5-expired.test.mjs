import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { TunnelState, createTunnelClient } from '../src/tunnel/tunnelClient.mjs'
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

test('expired token without refresh is unauthorized and does not keep the tunnel alive', async () => {
  const srv = createRegisterTestServer({
    originKey: pem('origin.key'),
    originCert: pem('origin.crt'),
    caCert: pem('ca.crt'),
    containerId: 42,
    keyringFp: 'abc',
    mode: 'unauthorized',
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
    assert.equal(client.state, TunnelState.OFFLINE)
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(client.connectTimes.length, 1)
  } finally {
    client.stop('test_done')
    await srv.close()
  }
})
