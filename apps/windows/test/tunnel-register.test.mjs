import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { createFixtureIdentityStore } from '../src/tunnel/identity.mjs'
import {
  createOutboundTlsOptions,
  spkiSha256Base64FromPem,
} from '../src/tunnel/bootstrap.mjs'
import { FLAG_FIN, MuxType, decodeFrames } from '../src/tunnel/mux.mjs'
import { RegisterError, registerDesktopTunnel } from '../src/tunnel/register.mjs'
import { attachMuxHttpServer } from '../src/tunnel/muxHttpServer.mjs'
import { createRegisterTestServer } from './fixtures/tunnel-test-server.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const tlsDir = path.join(here, 'fixtures/tls')

function pem(name) {
  return fs.readFileSync(path.join(tlsDir, name), 'utf8')
}

function identity() {
  return createFixtureIdentityStore({
    certPem: pem('device.crt'),
    keyPem: pem('device.key'),
    token: 'oc-v3.42.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    generation: 1,
  })
}

function tlsOpts() {
  return createOutboundTlsOptions({
    spkiPin: spkiSha256Base64FromPem(pem('origin.crt')),
    deviceCaPem: pem('ca.crt'),
    certPem: pem('device.crt'),
    keyPem: pem('device.key'),
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
  try {
    return await fn(srv, port)
  } finally {
    await srv.close()
  }
}

test('register_ok then OPEN_HTTP 200 round-trip over mTLS WSS', async () => {
  await withServer({ mode: 'ok' }, async (srv, port) => {
    const { ws, ack } = await registerDesktopTunnel({
      registerUrl: `wss://127.0.0.1:${port}/ws/desktop-container-register`,
      tls: tlsOpts(),
      identity: identity(),
      containerId: 42,
      keyringFp: 'abc',
    })
    assert.equal(ack.type, 'register_ok')
    assert.equal(ack.containerId, 42)
    assert.equal(ack.muxVersion, 1)

    const got = []
    attachMuxHttpServer({
      transport: {
        send: (buf) => ws.sendBinary(buf),
        close: (c, r) => ws.close(c, r),
        on: (ev, cb) => ws.on(ev, cb),
        off: (ev, cb) => ws.off(ev, cb),
      },
      handler: async (req) => {
        got.push(req)
        return { status: 200, headers: [{ k: 'content-type', v: 'text/plain' }], body: 'pong' }
      },
    })

    await new Promise((r) => setTimeout(r, 20))
    const session = srv.sessions[0]
    assert.ok(session)
    srv.sendOpenHttp(session, { path: '/healthz', body: Buffer.from('ping') })

    const deadline = Date.now() + 1_000
    while (!session.frames.some((f) => f.type === MuxType.HTTP_END) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15))
    }
    const start = session.frames.find((f) => f.type === MuxType.HTTP_RESPONSE_START)
    assert.ok(start, 'expected HTTP_RESPONSE_START from desktop')
    assert.equal(JSON.parse(start.payload.toString('utf8')).status, 200)
    const data = session.frames.find((f) => f.type === MuxType.HTTP_DATA)
    assert.ok(data, 'expected HTTP_DATA from desktop')
    assert.equal(data.payload.toString('utf8'), 'pong')
    assert.equal(data.flags & FLAG_FIN, FLAG_FIN)
    assert.equal(got[0].path, '/healthz')
    ws.close()
  })
})

test('update_required close is mapped and does not yield register_ok', async () => {
  await withServer({ mode: 'update_required' }, async (_srv, port) => {
    await assert.rejects(
      () => registerDesktopTunnel({
        registerUrl: `wss://127.0.0.1:${port}/ws/desktop-container-register`,
        tls: tlsOpts(),
        identity: identity(),
        containerId: 42,
        keyringFp: 'abc',
      }),
      (e) => e instanceof RegisterError && e.code === 'UPDATE_REQUIRED',
    )
  })
})

test('wrong SPKI pin fails the TLS handshake (not rejectUnauthorized:false)', async () => {
  await withServer({ mode: 'ok' }, async (_srv, port) => {
    const wrongPin = spkiSha256Base64FromPem(pem('origin-other.crt'))
    const tls = createOutboundTlsOptions({
      spkiPin: wrongPin,
      deviceCaPem: pem('ca.crt'),
      certPem: pem('device.crt'),
      keyPem: pem('device.key'),
    })
    assert.equal(tls.rejectUnauthorized, true)
    await assert.rejects(
      () => registerDesktopTunnel({
        registerUrl: `wss://127.0.0.1:${port}/ws/desktop-container-register`,
        tls,
        identity: identity(),
        containerId: 42,
        keyringFp: 'abc',
      }),
      (e) => /SPKI_PIN_MISMATCH|ERR_TLS/.test(String(e)) || e.code === 'ERR_TLS_SPKI_PIN_MISMATCH' || e.message === 'SPKI_PIN_MISMATCH',
    )
  })
})

test('killswitch 503 is FLAG/KILLSWITCH register error', async () => {
  await withServer({ mode: 'killswitch' }, async (_srv, port) => {
    await assert.rejects(
      () => registerDesktopTunnel({
        registerUrl: `wss://127.0.0.1:${port}/ws/desktop-container-register`,
        tls: tlsOpts(),
        identity: identity(),
        containerId: 42,
        keyringFp: 'abc',
      }),
      (e) => e instanceof RegisterError && e.code === 'KILLSWITCH' && e.status === 503,
    )
  })
})

void decodeFrames
