import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { createEnrollmentController } from '../src/enroll.mjs'
import { createMemoryIdentityStore } from '../src/identity.mjs'
import { createHostLogger } from '../src/host/log.mjs'
import { createTunnelClient, TunnelState } from '../src/tunnel/tunnelClient.mjs'
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

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

test('E1 enroll → finish → 18445 token path → WSS register_ok muxVersion=1', async () => {
  const logs = []
  const logger = {
    info(event, fields) {
      logs.push({ event, fields })
    },
  }
  const enrollments = new Map()
  const httpStub = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'POST' && url.pathname === '/api/desktop/enroll/start') {
      const id = randomUUID()
      const body = await readJson(req)
      enrollments.set(id, { challenge: body.pkce_challenge, code: randomBytes(16).toString('hex') })
      send(200, {
        enrollment_id: id,
        auth_url: `https://claudeai.chat/desktop/enroll?enrollment_id=${id}`,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/desktop/enroll/finish') {
      const body = await readJson(req)
      const row = enrollments.get(body.enrollment_id)
      if (!row) {
        send(404, { error: { code: 'NOT_FOUND' } })
        return
      }
      send(200, {
        deviceId: '11111111-1111-1111-1111-111111111111',
        containerId: 42,
        device_cert: pem('device.crt'),
        device_key: pem('device.key'),
        device_credential: `oc-dv.11111111-1111-1111-1111-111111111111.${'ab'.repeat(32)}`,
      })
      return
    }
    send(404, { error: { code: 'NOT_FOUND' } })
  })
  const originPort = await new Promise((resolve) => httpStub.listen(0, '127.0.0.1', () => resolve(httpStub.address().port)))
  const store = createMemoryIdentityStore()
  const enroll = createEnrollmentController({
    origin: `http://127.0.0.1:${originPort}`,
    identityStore: store,
    openExternal: () => {},
    audit: (event, fields) => logger.info(event, fields),
  })
  try {
    const started = await enroll.start()
    const finished = await enroll.handleCallback({
      action: 'enroll-callback',
      enrollmentId: started.enrollmentId,
      code: 'any',
    })
    assert.equal(finished.ok, true)
    const rec = await store.load()
    assert.equal(rec.containerId, 42)
    assert.ok(logs.some((row) => row.event === 'enroll_start'))
    assert.ok(logs.some((row) => row.event === 'enroll_finish'))

    const wss = createRegisterTestServer({
      originKey: pem('origin.key'),
      originCert: pem('origin.crt'),
      caCert: pem('ca.crt'),
      containerId: 42,
      keyringFp: 'abc',
      mode: 'ok',
    })
    const port = await wss.listen()
    const acks = []
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
      initialBackoffMs: 40,
      maxBackoffMs: 80,
      jitter: 0,
      onEvent: (event, extra) => {
        if (event === 'register_ok') acks.push(extra.ack)
      },
    })
    try {
      client.start()
      await waitFor(() => client.state === TunnelState.REGISTERED)
      assert.equal(acks[0].muxVersion, 1)
      assert.equal(acks[0].v, 1)
    } finally {
      client.stop('test_done')
      await wss.close()
    }
  } finally {
    await new Promise((r) => httpStub.close(r))
  }
})
