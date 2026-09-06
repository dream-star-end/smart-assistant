import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { createIdentityBridge } from '../src/host/identityBridge.mjs'
import { createTokenMinter } from '../src/host/tokenMinter.mjs'
import { createOutboundTlsOptions, spkiSha256Base64FromPem } from '../src/tunnel/bootstrap.mjs'
import { createStub18445 } from './fixtures/stub-18445.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const tlsDir = path.join(here, 'fixtures/tls')

function pem(name) {
  return fs.readFileSync(path.join(tlsDir, name), 'utf8')
}

function record() {
  return {
    deviceId: '11111111-1111-1111-1111-111111111111',
    containerId: 42,
    device_cert: pem('device.crt'),
    device_key: pem('device.key'),
    device_credential: 'oc-dv.11111111-1111-1111-1111-111111111111.' + 'ab'.repeat(32),
  }
}

function waitFor(pred, ms = 2_000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (pred()) return resolve()
      if (Date.now() - start > ms) return reject(new Error('waitFor timeout'))
      setTimeout(tick, 20)
    }
    tick()
  })
}

test('token minter mints oc-v3 over mTLS and refreshes before expiry', async () => {
  const stub = createStub18445({
    originKey: pem('origin.key'),
    originCert: pem('origin.crt'),
    caCert: pem('ca.crt'),
    expiresIn: 1,
  })
  const port = await stub.listen()
  const identity = createIdentityBridge(record())
  const pin = spkiSha256Base64FromPem(pem('origin.crt'))
  const tls = createOutboundTlsOptions({
    spkiPin: pin,
    deviceCaPem: pem('ca.crt'),
    certPem: pem('device.crt'),
    keyPem: pem('device.key'),
  })
  assert.equal(tls.rejectUnauthorized, true)
  const rotated = []
  const minter = createTokenMinter({
    identity,
    registerOrigin: `https://127.0.0.1:${port}`,
    spkiPin: pin,
    deviceCaPem: pem('ca.crt'),
    refreshLeadMs: 800,
    onRotated: (info) => rotated.push(info),
  })
  try {
    const minted = await minter.mint()
    assert.match(minted.token, /^oc-v3\.42\./)
    assert.equal(identity.getToken(), minted.token)
    assert.equal(stub.mints.length, 1)
    minter.start(minted.expires_in)
    await waitFor(() => rotated.length >= 2 && stub.refreshes.length >= 1, 2_500)
    assert.ok(stub.refreshes.length >= 1)
    assert.ok(rotated.length >= 2)
    assert.equal(identity.getGeneration() >= 2, true)
  } finally {
    minter.stop()
    await stub.close()
  }
})

test('token minter TLS options freeze rejectUnauthorized true', () => {
  const tls = createOutboundTlsOptions({
    spkiPin: spkiSha256Base64FromPem(pem('origin.crt')),
    deviceCaPem: pem('ca.crt'),
    certPem: pem('device.crt'),
    keyPem: pem('device.key'),
  })
  assert.equal(tls.rejectUnauthorized, true)
  assert.equal(typeof tls.checkServerIdentity, 'function')
  assert.throws(() => { tls.rejectUnauthorized = false }, TypeError)
})
