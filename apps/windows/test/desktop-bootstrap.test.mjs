import assert from 'node:assert/strict'
import { X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  BOOTSTRAP_PIN_CHANGED_MESSAGE,
  BOOTSTRAP_UNAVAILABLE_MESSAGE,
  loadDesktopHostConfig,
  validateBootstrapDocument,
} from '../src/desktopBootstrap.mjs'
import { spkiSha256Base64FromPem } from '../src/tunnel/bootstrap.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const tlsDir = path.join(here, 'fixtures/tls')

function pem(name) {
  return fs.readFileSync(path.join(tlsDir, name), 'utf8')
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body)
    },
  }
}

function validDoc(overrides = {}) {
  const ca = pem('ca.crt')
  const pin = spkiSha256Base64FromPem(pem('origin.crt'))
  return {
    v: 1,
    register_wss: 'wss://desktop.example:18445/ws/desktop-container-register',
    master_https: 'https://desktop.example:18445',
    egress_https: 'https://desktop.example:18446',
    device_ca_pem: ca,
    origin_spki_pin: pin,
    runtime_manifest_url: 'https://claudeai.chat/api/desktop/runtime-manifest',
    min_app_version: '0.5.0',
    ...overrides,
  }
}

test('validateBootstrapDocument accepts a well-formed payload', () => {
  const result = validateBootstrapDocument(validDoc())
  assert.equal(result.ok, true)
  assert.equal(new X509Certificate(result.doc.device_ca_pem).serialNumber.length > 0, true)
})

test('loadDesktopHostConfig adopts a successful bootstrap', async () => {
  const cachePath = path.join(os.tmpdir(), `clarvy-bootstrap-${process.pid}-${Date.now()}.json`)
  const doc = validDoc()
  const calls = []
  const result = await loadDesktopHostConfig({
    publicOrigin: 'https://claudeai.chat',
    cachePath,
    env: {},
    fetchImpl: async (url) => {
      calls.push(url)
      return jsonResponse(200, doc)
    },
  })
  assert.equal(calls[0], 'https://claudeai.chat/api/desktop/bootstrap')
  assert.equal(result.ready, true)
  assert.equal(result.disabled, false)
  assert.equal(result.registerOrigin, doc.register_wss)
  assert.equal(result.spkiPin, doc.origin_spki_pin)
  assert.equal(result.runtimeManifestUrl, doc.runtime_manifest_url)
  const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
  assert.equal(cached.origin_spki_pin, doc.origin_spki_pin)
  fs.unlinkSync(cachePath)
})

test('404 and 503 disable local mode instead of crashing', async () => {
  const cachePath = path.join(os.tmpdir(), `clarvy-bootstrap-miss-${process.pid}.json`)
  const off = await loadDesktopHostConfig({
    publicOrigin: 'https://claudeai.chat',
    cachePath,
    env: {},
    fetchImpl: async () => jsonResponse(404, { error: { code: 'NOT_FOUND' } }),
  })
  assert.equal(off.ready, false)
  assert.equal(off.disabled, true)
  assert.equal(off.message, BOOTSTRAP_UNAVAILABLE_MESSAGE)

  const unconfigured = await loadDesktopHostConfig({
    publicOrigin: 'https://claudeai.chat',
    cachePath,
    env: {},
    fetchImpl: async () => jsonResponse(503, { error: 'DESKTOP_BOOTSTRAP_UNCONFIGURED' }),
  })
  assert.equal(unconfigured.disabled, true)
  assert.equal(unconfigured.disabledReason, 'DESKTOP_BOOTSTRAP_UNCONFIGURED')
})

test('invalid bootstrap fields are rejected', async () => {
  const cachePath = path.join(os.tmpdir(), `clarvy-bootstrap-bad-${process.pid}.json`)
  const result = await loadDesktopHostConfig({
    publicOrigin: 'https://claudeai.chat',
    cachePath,
    env: {},
    fetchImpl: async () => jsonResponse(200, validDoc({ register_wss: 'https://desktop.example/ws' })),
  })
  assert.equal(result.ready, false)
  assert.equal(result.disabled, true)
  assert.equal(result.disabledReason, 'INVALID_BOOTSTRAP')
})

test('loopback hosts are rejected unless OPENCLAUDE_DESKTOP_ALLOW_LOOPBACK=1', async () => {
  const cachePath = path.join(os.tmpdir(), `clarvy-bootstrap-loop-${process.pid}.json`)
  const loopDoc = validDoc({
    register_wss: 'wss://127.0.0.1:18445/ws/desktop-container-register',
    master_https: 'https://127.0.0.1:18445',
    egress_https: 'https://127.0.0.1:18446',
  })
  const denied = await loadDesktopHostConfig({
    publicOrigin: 'https://claudeai.chat',
    cachePath,
    env: {},
    fetchImpl: async () => jsonResponse(200, loopDoc),
  })
  assert.equal(denied.ready, false)

  const allowed = await loadDesktopHostConfig({
    publicOrigin: 'https://claudeai.chat',
    cachePath,
    env: { OPENCLAUDE_DESKTOP_ALLOW_LOOPBACK: '1' },
    fetchImpl: async () => jsonResponse(200, loopDoc),
  })
  assert.equal(allowed.ready, true)
  fs.unlinkSync(cachePath)
})

test('pin change against cache refuses to silently rotate', async () => {
  const cachePath = path.join(os.tmpdir(), `clarvy-bootstrap-pin-${process.pid}.json`)
  const first = validDoc()
  await loadDesktopHostConfig({
    publicOrigin: 'https://claudeai.chat',
    cachePath,
    env: {},
    fetchImpl: async () => jsonResponse(200, first),
  })
  const rotated = validDoc({
    origin_spki_pin: Buffer.alloc(32, 9).toString('base64'),
  })
  const result = await loadDesktopHostConfig({
    publicOrigin: 'https://claudeai.chat',
    cachePath,
    env: {},
    fetchImpl: async () => jsonResponse(200, rotated),
  })
  assert.equal(result.ready, false)
  assert.equal(result.pinChanged, true)
  assert.equal(result.message, BOOTSTRAP_PIN_CHANGED_MESSAGE)
  fs.unlinkSync(cachePath)
})

test('env overlay wins over bootstrap fields', async () => {
  const cachePath = path.join(os.tmpdir(), `clarvy-bootstrap-env-${process.pid}.json`)
  const doc = validDoc()
  const result = await loadDesktopHostConfig({
    publicOrigin: 'https://claudeai.chat',
    cachePath,
    env: {
      OPENCLAUDE_DESKTOP_REGISTER_ORIGIN: 'wss://override.example:18445/ws/desktop-container-register',
      OPENCLAUDE_DESKTOP_KEYRING_FP: 'abc123',
    },
    fetchImpl: async () => jsonResponse(200, doc),
  })
  assert.equal(result.registerOrigin, 'wss://override.example:18445/ws/desktop-container-register')
  assert.equal(result.egressOrigin, doc.egress_https)
  assert.equal(result.keyringFp, 'abc123')
  fs.unlinkSync(cachePath)
})
