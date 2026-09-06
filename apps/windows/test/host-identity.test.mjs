import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { createIdentityBridge } from '../src/host/identityBridge.mjs'
import { createLahToken, createLahGwToken, createLocalBridgeToken, timingSafeEqualString } from '../src/host/tokens.mjs'
import { isLoopbackAddress } from '../src/host/loopback.mjs'
import { classifyMuxHttp } from '../src/host/muxForward.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const tlsDir = path.join(here, 'fixtures/tls')

function pem(name) {
  return fs.readFileSync(path.join(tlsDir, name), 'utf8')
}

function sampleRecord() {
  return {
    version: 1,
    deviceId: '11111111-1111-1111-1111-111111111111',
    containerId: 42,
    device_cert: pem('device.crt'),
    device_key: pem('device.key'),
    device_credential: 'oc-dv.11111111-1111-1111-1111-111111111111.' + 'ab'.repeat(32),
  }
}

test('identityBridge maps S1 record onto S2 cert/key getters and keeps oc-v3 in memory only', () => {
  const record = sampleRecord()
  const identity = createIdentityBridge(record)
  assert.equal(identity.getCertPem(), record.device_cert)
  assert.equal(identity.getKeyPem(), record.device_key)
  assert.equal(identity.getDeviceCredential(), record.device_credential)
  assert.equal(identity.hasSession(), false)
  assert.throws(() => identity.getToken(), /oc-v3/)
  identity.setSession('oc-v3.42.' + 'd'.repeat(64), 3, 42)
  assert.equal(identity.getToken().startsWith('oc-v3.'), true)
  assert.equal(identity.getGeneration(), 3)
  const persisted = identity.persistedRecord()
  assert.equal(Object.hasOwn(persisted, 'token'), false)
  assert.equal(JSON.stringify(persisted).includes('oc-v3.'), false)
})

test('token helpers emit prefixed secrets and timing-safe compare rejects length mismatch', () => {
  const lah = createLahToken()
  const gw = createLahGwToken()
  const bridge = createLocalBridgeToken()
  assert.match(lah, /^oc-lah\.[0-9a-f]{64}$/)
  assert.match(gw, /^oc-lah-gw\.[0-9a-f]{64}$/)
  assert.match(bridge, /^[0-9a-f]{64}$/)
  assert.equal(timingSafeEqualString(lah, lah), true)
  assert.equal(timingSafeEqualString(lah, gw), false)
  assert.equal(timingSafeEqualString('abc', 'ab'), false)
})

test('isLoopbackAddress accepts v4/v6 mapped loopback and rejects others', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('0.0.0.0'), false)
  assert.equal(isLoopbackAddress('8.8.8.8'), false)
  assert.equal(isLoopbackAddress('10.0.0.1'), false)
})

test('mux HTTP classifier forwards healthz/dispatch and 501s file-proxy/inbound', () => {
  assert.equal(classifyMuxHttp('GET', '/healthz'), 'forward')
  assert.equal(classifyMuxHttp('POST', '/internal/v3/turn-reject-if-absent'), 'forward')
  assert.equal(classifyMuxHttp('GET', '/internal/v3/turn-dispatch-state'), 'forward')
  assert.equal(classifyMuxHttp('GET', '/api/file'), 'not_implemented')
  assert.equal(classifyMuxHttp('GET', '/api/media/x'), 'not_implemented')
  assert.equal(classifyMuxHttp('POST', '/internal/v3/wechat-inbound'), 'not_implemented')
  assert.equal(classifyMuxHttp('POST', '/internal/v3/engine-preheat'), 'not_implemented')
})
