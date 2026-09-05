import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { createLocalModeController, LocalMode } from '../src/localMode.mjs'
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

test('E6 killswitch 503 does not tight-loop: backoff >= killSwitchBackoffMs and UI falls back once', async () => {
  const mode = createLocalModeController({ cooldownMs: 30_000, now: () => Date.now() })
  mode.enableLocal()
  const srv = createRegisterTestServer({
    originKey: pem('origin.key'),
    originCert: pem('origin.crt'),
    caCert: pem('ca.crt'),
    containerId: 42,
    keyringFp: 'abc',
    mode: 'killswitch',
  })
  const port = await srv.listen()
  const events = []
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
    maxBackoffMs: 40,
    jitter: 0,
    killSwitchBackoffMs: 80,
    registerTimeoutMs: 400,
    connectTimeoutMs: 400,
    onEvent: (event, extra) => events.push({ event, extra }),
  })
  try {
    client.start()
    await waitFor(() => client.connectTimes.length >= 1)
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(client.connectTimes.length, 1)
    await waitFor(() => client.connectTimes.length >= 2, 400)
    const gap = client.connectTimes[1] - client.connectTimes[0]
    assert.ok(gap >= 80, `gap=${gap}`)
    assert.ok(client.connectTimes.length <= 4)
    const kill = events.find((row) => row.extra?.code === 'KILLSWITCH' || row.event === 'connect_error')
    assert.ok(kill)
    mode.noteKillSwitch()
    assert.equal(mode.mode, LocalMode.FALLBACK)
    assert.equal(mode.enableLocal().ok, false)
    assert.ok(client.state === TunnelState.DEGRADED || client.state === TunnelState.CONNECTING, client.state)
  } finally {
    client.stop('test_done')
    await srv.close()
  }
})
