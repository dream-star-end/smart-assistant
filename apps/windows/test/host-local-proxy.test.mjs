import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { createIdentityBridge } from '../src/host/identityBridge.mjs'
import { createLahToken, createLahGwToken } from '../src/host/tokens.mjs'
import { createEgressProxy, createMasterProxy, createLocalProxy } from '../src/host/localProxy.mjs'
import { spkiSha256Base64FromPem } from '../src/tunnel/bootstrap.mjs'
import { createStub18445 } from './fixtures/stub-18445.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const tlsDir = path.join(here, 'fixtures/tls')

function pem(name) {
  return fs.readFileSync(path.join(tlsDir, name), 'utf8')
}

function identityWithSession() {
  const identity = createIdentityBridge({
    deviceId: '11111111-1111-1111-1111-111111111111',
    containerId: 42,
    device_cert: pem('device.crt'),
    device_key: pem('device.key'),
    device_credential: 'oc-dv.11111111-1111-1111-1111-111111111111.' + 'ab'.repeat(32),
  })
  identity.setSession('oc-v3.42.' + 'e'.repeat(64), 1, 42)
  return identity
}

function jsonRequest(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: p,
      method,
      headers,
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    if (body) req.end(body)
    else req.end()
  })
}

test('18791/18792 reject missing token with 401 and do not outbound', async () => {
  const stub = createStub18445({
    originKey: pem('origin.key'),
    originCert: pem('origin.crt'),
    caCert: pem('ca.crt'),
  })
  const originPort = await stub.listen()
  const origin = `https://127.0.0.1:${originPort}`
  const identity = identityWithSession()
  const pin = spkiSha256Base64FromPem(pem('origin.crt'))
  const lah = createLahToken()
  const gw = createLahGwToken()
  const outbound = []
  const egress = createEgressProxy({
    port: 0,
    lahToken: lah,
    identity,
    egressOrigin: origin,
    spkiPin: pin,
    deviceCaPem: pem('ca.crt'),
    onOutbound: (info) => outbound.push(info),
  })
  const master = createMasterProxy({
    port: 0,
    lahGwToken: gw,
    identity,
    registerOrigin: origin,
    spkiPin: pin,
    deviceCaPem: pem('ca.crt'),
    onOutbound: (info) => outbound.push(info),
  })
  await egress.start()
  await master.start()
  try {
    const a = await jsonRequest(egress.port, { method: 'POST', path: '/v1/messages', body: '{}' })
    assert.equal(a.status, 401)
    const b = await jsonRequest(master.port, { method: 'GET', path: '/internal/v3/model-catalog' })
    assert.equal(b.status, 401)
    const c = await jsonRequest(egress.port, {
      method: 'POST',
      path: '/v1/messages',
      headers: { authorization: 'Bearer oc-lah.' + '0'.repeat(64) },
      body: '{}',
    })
    assert.equal(c.status, 401)
    assert.equal(outbound.length, 0)
    assert.equal(egress.stats.unauth >= 2, true)
    assert.equal(stub.mints.length, 0)
  } finally {
    await egress.stop()
    await master.stop()
    await stub.close()
  }
})

test('18791 only allows POST /v1/messages; other methods/paths are 405/404', async () => {
  const stub = createStub18445({
    originKey: pem('origin.key'),
    originCert: pem('origin.crt'),
    caCert: pem('ca.crt'),
  })
  const originPort = await stub.listen()
  const identity = identityWithSession()
  const pin = spkiSha256Base64FromPem(pem('origin.crt'))
  const lah = createLahToken()
  const egress = createEgressProxy({
    port: 0,
    lahToken: lah,
    identity,
    egressOrigin: `https://127.0.0.1:${originPort}`,
    spkiPin: pin,
    deviceCaPem: pem('ca.crt'),
  })
  await egress.start()
  try {
    const headers = { authorization: `Bearer ${lah}` }
    const get = await jsonRequest(egress.port, { method: 'GET', path: '/v1/messages', headers })
    assert.equal(get.status, 405)
    const other = await jsonRequest(egress.port, { method: 'POST', path: '/v1/models', headers, body: '{}' })
    assert.equal(other.status, 404)
    const ok = await jsonRequest(egress.port, {
      method: 'POST',
      path: '/v1/messages',
      headers: { ...headers, 'content-type': 'application/json' },
      body: '{"model":"x"}',
    })
    assert.equal(ok.status, 200)
    assert.equal(JSON.parse(ok.body).id, 'msg_stub')
    assert.equal(egress.stats.outbound, 1)
  } finally {
    await egress.stop()
    await stub.close()
  }
})

test('0.0.0.0 occupant of the proxy port makes exclusive loopback bind fail', async () => {
  const blocker = net.createServer()
  await new Promise((resolve, reject) => {
    blocker.once('error', reject)
    blocker.listen({ host: '0.0.0.0', port: 0, exclusive: true }, resolve)
  })
  const port = blocker.address().port
  const identity = identityWithSession()
  const pin = spkiSha256Base64FromPem(pem('origin.crt'))
  const proxy = createEgressProxy({
    port,
    lahToken: createLahToken(),
    identity,
    egressOrigin: 'https://127.0.0.1:1',
    spkiPin: pin,
    deviceCaPem: pem('ca.crt'),
  })
  await assert.rejects(() => proxy.start(), (err) => err && (err.code === 'EADDRINUSE' || /EADDRINUSE/.test(err.message)))
  await new Promise((resolve) => blocker.close(resolve))
})

test('bind-all test variant rejects non-loopback remote addresses', async () => {
  const identity = identityWithSession()
  const pin = spkiSha256Base64FromPem(pem('origin.crt'))
  const lah = createLahToken()
  const proxy = createLocalProxy({
    kind: 'egress',
    port: 0,
    expectedToken: lah,
    identity,
    outboundOrigin: 'https://127.0.0.1:1',
    spkiPin: pin,
    deviceCaPem: pem('ca.crt'),
    bindAllForTest: true,
    inspectRemote: () => '8.8.8.8',
    allowlist: [{ method: 'POST', path: '/v1/messages' }],
  })
  await proxy.start()
  try {
    const res = await jsonRequest(proxy.port, {
      method: 'POST',
      path: '/v1/messages',
      headers: { authorization: `Bearer ${lah}` },
      body: '{}',
    })
    assert.equal(res.status, 403)
    assert.equal(proxy.stats.outbound, 0)
  } finally {
    await proxy.stop()
  }
})
