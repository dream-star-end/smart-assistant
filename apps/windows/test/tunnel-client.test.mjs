import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { createFixtureIdentityStore } from '../src/tunnel/identity.mjs'
import { spkiSha256Base64FromPem } from '../src/tunnel/bootstrap.mjs'
import { TunnelState, createTunnelClient } from '../src/tunnel/tunnelClient.mjs'
import { createRegisterTestServer } from './fixtures/tunnel-test-server.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const tlsDir = path.join(here, 'fixtures/tls')

function pem(name) {
  return fs.readFileSync(path.join(tlsDir, name), 'utf8')
}

function waitFor(pred, ms = 1_500) {
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

function makeClient(port, extra = {}) {
  return createTunnelClient({
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
    initialBackoffMs: extra.initialBackoffMs ?? 40,
    maxBackoffMs: extra.maxBackoffMs ?? 200,
    jitter: extra.jitter ?? 0,
    heartbeatIntervalMs: extra.heartbeatIntervalMs ?? 80,
    heartbeatTimeoutMs: extra.heartbeatTimeoutMs ?? 5_000,
    minHeartbeatIntervalMs: extra.minHeartbeatIntervalMs ?? 20,
    killSwitchBackoffMs: extra.killSwitchBackoffMs ?? 80,
    registerTimeoutMs: extra.registerTimeoutMs ?? 500,
    connectTimeoutMs: extra.connectTimeoutMs ?? 1_000,
    refreshToken: extra.refreshToken,
    onState: extra.onState,
    onUpdateRequired: extra.onUpdateRequired,
    onEvent: extra.onEvent,
  })
}

async function withServer(opts, fn) {
  const srv = createRegisterTestServer({
    originKey: pem('origin.key'),
    originCert: pem('origin.crt'),
    caCert: pem('ca.crt'),
    containerId: 42,
    keyringFp: 'abc',
    ...opts,
  })
  const port = await srv.listen()
  let client
  try {
    client = makeClient(port, opts.client || {})
    return await fn(srv, client, port)
  } finally {
    try { client?.stop('test_done') } catch { /* */ }
    await srv.close()
  }
}

test('register_ok moves connecting → registered', async () => {
  const states = []
  await withServer({ mode: 'ok', client: { onState: (s) => states.push(s) } }, async (_srv, client) => {
    client.start()
    await waitFor(() => client.state === TunnelState.REGISTERED)
    assert.ok(states.includes(TunnelState.CONNECTING))
    assert.equal(client.state, TunnelState.REGISTERED)
  })
})

test('update_required stops reconnect and reports offline', async () => {
  let required = null
  await withServer({
    mode: 'update_required',
    client: {
      onUpdateRequired: (info) => { required = info },
      initialBackoffMs: 20,
    },
  }, async (_srv, client) => {
    client.start()
    await waitFor(() => client.stopped && client.updateRequired)
    assert.equal(client.state, TunnelState.OFFLINE)
    assert.ok(required)
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(client.connectTimes.length, 1)
  })
})

test('heartbeat timeout degrades then reconnects', async () => {
  await withServer({
    mode: 'no_heartbeat_ack',
    client: {
      heartbeatIntervalMs: 40,
      heartbeatTimeoutMs: 90,
      minHeartbeatIntervalMs: 20,
      initialBackoffMs: 30,
      jitter: 0,
    },
  }, async (_srv, client) => {
    client.start()
    await waitFor(() => client.state === TunnelState.REGISTERED)
    await waitFor(() => client.state === TunnelState.DEGRADED || client.connectTimes.length >= 2, 1_200)
    await waitFor(() => client.connectTimes.length >= 2, 1_200)
    assert.ok(client.connectTimes.length >= 2)
  })
})

test('kick after register_ok backs off instead of storming', async () => {
  await withServer({
    mode: 'kick_after_ok',
    client: {
      initialBackoffMs: 80,
      maxBackoffMs: 80,
      jitter: 0,
      heartbeatTimeoutMs: 5_000,
    },
  }, async (_srv, client) => {
    client.start()
    await waitFor(() => client.connectTimes.length >= 3, 2_000)
    const times = client.connectTimes
    const gaps = []
    for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1])
    assert.ok(gaps.every((g) => g >= 50), `gaps=${gaps.join(',')}`)
    assert.ok(times.length <= 8)
  })
})

test('token refresh drop reconnects with new token after in-flight drain', async () => {
  let refreshed = 0
  await withServer({
    mode: 'ok',
    client: {
      refreshToken: async () => {
        refreshed += 1
        return {
          token: 'oc-v3.42.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          generation: 2,
        }
      },
    },
  }, async (_srv, client) => {
    client.start()
    await waitFor(() => client.state === TunnelState.REGISTERED)
    await client.refreshAndReconnect('test')
    await waitFor(() => client.state === TunnelState.REGISTERED && refreshed === 1)
    assert.equal(refreshed, 1)
    assert.equal(client.generation, 2)
  })
})

test('suspend then resume forces a new connection', async () => {
  await withServer({ mode: 'ok' }, async (_srv, client) => {
    client.start()
    await waitFor(() => client.state === TunnelState.REGISTERED)
    const before = client.connectTimes.length
    client.onSuspend()
    assert.equal(client.state, TunnelState.DEGRADED)
    client.onResume()
    await waitFor(() => client.connectTimes.length > before && client.state === TunnelState.REGISTERED)
  })
})
