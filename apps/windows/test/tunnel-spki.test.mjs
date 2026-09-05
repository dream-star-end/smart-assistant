import assert from 'node:assert/strict'
import { X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  createOutboundTlsOptions,
  createSpkiPinChecker,
  spkiSha256Base64FromPem,
} from '../src/tunnel/bootstrap.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const tlsDir = path.join(here, 'fixtures/tls')
const tunnelDir = path.resolve(here, '../src/tunnel')

function readPem(name) {
  return fs.readFileSync(path.join(tlsDir, name), 'utf8')
}

test('createOutboundTlsOptions freezes rejectUnauthorized true and a real pin checker', () => {
  const origin = readPem('origin.crt')
  const pin = spkiSha256Base64FromPem(origin)
  const tls = createOutboundTlsOptions({
    spkiPin: pin,
    deviceCaPem: readPem('ca.crt'),
    certPem: readPem('device.crt'),
    keyPem: readPem('device.key'),
  })
  assert.equal(tls.rejectUnauthorized, true)
  assert.equal(typeof tls.checkServerIdentity, 'function')
  assert.equal(tls.minVersion, 'TLSv1.3')
  assert.throws(() => { tls.rejectUnauthorized = false }, TypeError)
})

test('SPKI pin checker accepts matching origin leaf and rejects the other origin', () => {
  const pin = spkiSha256Base64FromPem(readPem('origin.crt'))
  const check = createSpkiPinChecker(pin)
  const good = new X509Certificate(readPem('origin.crt'))
  const bad = new X509Certificate(readPem('origin-other.crt'))
  assert.equal(check('localhost', { raw: good.raw }), undefined)
  const err = check('localhost', { raw: bad.raw })
  assert.ok(err instanceof Error)
  assert.equal(err.message, 'SPKI_PIN_MISMATCH')
})

test('missing pin or empty check is rejected at config time', () => {
  assert.throws(
    () => createOutboundTlsOptions({
      spkiPin: '',
      deviceCaPem: readPem('ca.crt'),
      certPem: readPem('device.crt'),
      keyPem: readPem('device.key'),
    }),
    /spkiPin/,
  )
  assert.throws(() => createSpkiPinChecker(''), /spkiPin/)
})

test('src/tunnel has zero rejectUnauthorized:false and no empty checkServerIdentity', () => {
  const files = fs.readdirSync(tunnelDir).filter((f) => f.endsWith('.mjs'))
  assert.ok(files.length >= 6)
  let pinHits = 0
  for (const file of files) {
    const src = fs.readFileSync(path.join(tunnelDir, file), 'utf8')
    assert.equal(
      /rejectUnauthorized\s*:\s*false/.test(src),
      false,
      `${file} sets rejectUnauthorized:false`,
    )
    assert.equal(
      /checkServerIdentity\s*:\s*(undefined|null)/.test(src),
      false,
      `${file} has empty checkServerIdentity`,
    )
    if (src.includes('SPKI_PIN_MISMATCH') || src.includes('createSpkiPinChecker')) pinHits += 1
  }
  assert.ok(pinHits >= 1)
})
