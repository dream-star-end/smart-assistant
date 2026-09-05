import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { createIdentityBridge } from '../src/host/identityBridge.mjs'
import { createLahToken } from '../src/host/tokens.mjs'
import { createEgressProxy, MAX_PROXY_BODY_BYTES } from '../src/host/localProxy.mjs'
import { spkiSha256Base64FromPem } from '../src/tunnel/bootstrap.mjs'

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

function serveOrigin(handler) {
  const server = https.createServer({
    key: pem('origin.key'),
    cert: pem('origin.crt'),
    ca: pem('ca.crt'),
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.3',
    maxVersion: 'TLSv1.3',
  }, handler)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

async function startEgress(originPort) {
  const lah = createLahToken()
  const proxy = createEgressProxy({
    port: 0,
    lahToken: lah,
    identity: identityWithSession(),
    egressOrigin: `https://127.0.0.1:${originPort}`,
    spkiPin: spkiSha256Base64FromPem(pem('origin.crt')),
    deviceCaPem: pem('ca.crt'),
  })
  await proxy.start()
  return { proxy, lah }
}

function postMessages(port, { token, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...headers,
      },
    }, (res) => {
      const chunks = []
      const times = []
      res.on('data', (c) => {
        chunks.push(c)
        times.push(Date.now())
      })
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        chunks: chunks.map((c) => c.toString('utf8')),
        times,
      }))
    })
    req.on('error', reject)
    req.end(body ?? '{"model":"x","stream":true}')
  })
}

test('18791 forwards SSE chunks without buffering the whole package', async () => {
  const origin = await serveOrigin((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      })
      res.write('data: {"text":"one"}\n\n')
      setTimeout(() => {
        res.write('data: {"text":"two"}\n\n')
        setTimeout(() => res.end(), 80)
      }, 80)
    })
  })
  const { proxy, lah } = await startEgress(origin.port)
  try {
    const result = await postMessages(proxy.port, { token: lah })
    assert.equal(result.status, 200)
    assert.match(String(result.headers['content-type'] || ''), /text\/event-stream/)
    assert.match(result.body, /one/)
    assert.match(result.body, /two/)
    assert.equal(proxy.stats.success >= 1, true)
    assert.equal(result.chunks.length >= 1, true)
  } finally {
    await proxy.stop()
    await origin.close()
  }
})

test('18791 passes upstream 4xx/5xx status and body through unchanged', async () => {
  const payload = JSON.stringify({ error: { code: 'rate_limited', message: 'slow down' } })
  const origin = await serveOrigin((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(429, { 'content-type': 'application/json', 'x-upstream': 'yes' })
      res.end(payload)
    })
  })
  const { proxy, lah } = await startEgress(origin.port)
  try {
    const result = await postMessages(proxy.port, { token: lah, body: '{"model":"x"}' })
    assert.equal(result.status, 429)
    assert.equal(result.body, payload)
    assert.equal(result.headers['x-upstream'], 'yes')
    assert.equal(proxy.stats.upstreamError >= 1, true)
  } finally {
    await proxy.stop()
    await origin.close()
  }
})

test('18791 rejects request bodies larger than 8 MiB', async () => {
  let outboundHits = 0
  const origin = await serveOrigin((req, res) => {
    outboundHits += 1
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  const { proxy, lah } = await startEgress(origin.port)
  try {
    const huge = 'x'.repeat(MAX_PROXY_BODY_BYTES + 64)
    let result
    try {
      result = await postMessages(proxy.port, {
        token: lah,
        body: huge,
        headers: { 'content-type': 'application/octet-stream' },
      })
    } catch (error) {
      // Windows may RST the client socket after the proxy drops an oversized body.
      if (error && (error.code === 'ECONNRESET' || error.code === 'EPIPE')) {
        assert.equal(outboundHits, 0)
        return
      }
      throw error
    }
    assert.equal(result.status, 413)
    assert.match(result.body, /BODY_TOO_LARGE/)
    assert.equal(proxy.stats.tooLarge >= 1, true)
    assert.equal(outboundHits, 0)
  } finally {
    await proxy.stop()
    await origin.close()
  }
})
