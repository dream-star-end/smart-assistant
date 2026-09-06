import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import test from 'node:test'

import { parseOpenClaudeDeepLink } from '../src/desktop-protocol.mjs'
import {
  createEnrollmentController,
  createLocalHostResponse,
  generatePkceVerifier,
  pkceChallengeS256,
  registerLocalHostProtocol,
  resolveLocalHostAsset,
} from '../src/enroll.mjs'
import { createMemoryIdentityStore } from '../src/identity.mjs'

const DEVICE_ID = '22222222-2222-4222-8222-222222222222'
const CONTAINER_ID = 7
const DEVICE_CERT = '-----BEGIN CERTIFICATE-----\nMIIBstub\n-----END CERTIFICATE-----'
const DEVICE_KEY = '-----BEGIN PRIVATE KEY-----\nMIIBstub\n-----END PRIVATE KEY-----'
const DEVICE_CREDENTIAL = `oc-dv.${DEVICE_ID}.${'cd'.repeat(32)}`

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function listenStub() {
  const enrollments = new Map()
  const finishBodies = []
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (req.method === 'POST' && url.pathname === '/api/desktop/enroll/start') {
        const body = await readJson(req)
        const id = randomUUID()
        enrollments.set(id, {
          challenge: body.pkce_challenge,
          appId: body.app_id,
          platform: body.platform,
          confirmed: false,
          code: null,
        })
        send(res, 200, {
          enrollment_id: id,
          auth_url: `https://claudeai.chat/desktop/enroll?enrollment_id=${id}`,
          expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        })
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/desktop/enroll/confirm') {
        const body = await readJson(req)
        const row = enrollments.get(body.enrollment_id)
        if (!row) {
          send(res, 409, { error: { code: 'ENROLL_INVALID', message: 'missing' } })
          return
        }
        const code = randomBytes(32).toString('hex')
        row.confirmed = true
        row.code = code
        send(res, 200, {
          enrollment_id: body.enrollment_id,
          code,
          deep_link: `openclaude://enroll/callback?enrollment_id=${body.enrollment_id}&code=${code}`,
        })
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/desktop/enroll/finish') {
        const body = await readJson(req)
        finishBodies.push(body)
        const row = enrollments.get(body.enrollment_id)
        if (!row) {
          send(res, 404, { error: { code: 'ENROLL_NOT_FOUND', message: 'missing' } })
          return
        }
        if (pkceChallengeS256(body.pkce_verifier) !== row.challenge) {
          send(res, 401, { error: { code: 'PKCE_MISMATCH', message: 'pkce' } })
          return
        }
        if (body.code !== row.code) {
          send(res, 401, { error: { code: 'CODE_MISMATCH', message: 'code' } })
          return
        }
        send(res, 200, {
          deviceId: DEVICE_ID,
          containerId: CONTAINER_ID,
          device_credential: DEVICE_CREDENTIAL,
          device_cert: DEVICE_CERT,
          device_key: DEVICE_KEY,
        })
        return
      }
      send(res, 404, { error: { code: 'NOT_FOUND', message: 'nope' } })
    } catch (error) {
      send(res, 500, { error: { code: 'INTERNAL', message: error.message } })
    }
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    origin: `http://127.0.0.1:${port}`,
    enrollments,
    finishBodies,
    async confirm(enrollmentId) {
      const response = await fetch(`http://127.0.0.1:${port}/api/desktop/enroll/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enrollment_id: enrollmentId }),
      })
      return response.json()
    },
    async close() {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    },
  }
}

test('pkceChallengeS256 matches the commercial S256 helper shape', () => {
  const verifier = generatePkceVerifier()
  assert.equal(verifier.length, 64)
  assert.equal(pkceChallengeS256(verifier), createHash('sha256').update(verifier, 'ascii').digest('base64url'))
})

test('enrollment controller completes start/confirm/finish against a stub and never persists verifier', async () => {
  const stub = await listenStub()
  const store = createMemoryIdentityStore()
  const opened = []
  const audits = []
  try {
    const controller = createEnrollmentController({
      origin: stub.origin,
      identityStore: store,
      openExternal: (url) => opened.push(url),
      audit: (event, fields) => audits.push({ event, fields }),
    })
    const started = await controller.start()
    assert.equal(opened.length, 1)
    assert.equal(opened[0], started.authUrl)
    assert.equal(controller.getStatus().phase, 'awaiting-callback')
    assert.equal(controller.getStatus().enrollmentId, started.enrollmentId)

    const confirmed = await stub.confirm(started.enrollmentId)
    const parsed = parseOpenClaudeDeepLink(confirmed.deep_link)
    assert.equal(parsed.action, 'enroll-callback')
    const finished = await controller.handleCallback(parsed)
    assert.equal(finished.ok, true)
    assert.equal(finished.deviceId, DEVICE_ID)
    assert.equal(store.writes.length, 1)
    assert.deepEqual(Object.keys(store.writes[0]).sort(), [
      'containerId',
      'deviceId',
      'device_cert',
      'device_credential',
      'device_key',
      'version',
    ])
    assert.equal('pkce_verifier' in store.writes[0], false)
    assert.equal(JSON.stringify(store.writes[0]).includes(stub.finishBodies[0].pkce_verifier), false)
    assert.equal(controller.getStatus().phase, 'enrolled')
    assert.equal(
      audits.some((entry) => JSON.stringify(entry).includes('BEGIN CERTIFICATE')),
      false,
    )
    assert.equal(
      audits.some((entry) => JSON.stringify(entry).includes(stub.finishBodies[0].pkce_verifier)),
      false,
    )
    assert.equal(sha256Hex(stub.finishBodies[0].code).length, 64)
  } finally {
    await stub.close()
  }
})

test('enrollment callback with a mismatched enrollment_id is ignored and does not finish', async () => {
  const stub = await listenStub()
  const store = createMemoryIdentityStore()
  try {
    const controller = createEnrollmentController({
      origin: stub.origin,
      identityStore: store,
      openExternal: () => {},
    })
    await controller.start()
    const other = parseOpenClaudeDeepLink(
      `openclaude://enroll/callback?enrollment_id=${randomUUID()}&code=${'ab'.repeat(32)}`,
    )
    const result = await controller.handleCallback(other)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'id-mismatch')
    assert.equal(stub.finishBodies.length, 0)
    assert.equal(store.writes.length, 0)
    assert.equal(controller.getStatus().phase, 'awaiting-callback')
  } finally {
    await stub.close()
  }
})

test('malformed enroll deep links never reach finish', async () => {
  const stub = await listenStub()
  const store = createMemoryIdentityStore()
  try {
    const controller = createEnrollmentController({
      origin: stub.origin,
      identityStore: store,
      openExternal: () => {},
    })
    const started = await controller.start()
    const result = await controller.handleDeepLink(
      `openclaude://enroll/callback?enrollment_id=${started.enrollmentId}&code=${'ab'.repeat(32)}&extra=1`,
    )
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'invalid-query')
    assert.equal(stub.finishBodies.length, 0)
  } finally {
    await stub.close()
  }
})

test('local-host protocol only serves app://clarvy-local assets', async () => {
  assert.equal(resolveLocalHostAsset('app://clarvy-local/index.html')?.mime.startsWith('text/html'), true)
  assert.equal(resolveLocalHostAsset('app://aurora-shell/index.html'), null)
  assert.equal(resolveLocalHostAsset('app://clarvy-local/index.html?x=1'), null)
  const ok = createLocalHostResponse({ method: 'GET', url: 'app://clarvy-local/index.html' })
  assert.equal(ok.status, 200)
  const denied = createLocalHostResponse({ method: 'GET', url: 'https://claudeai.chat/' })
  assert.equal(denied.status, 404)

  let boundScheme = null
  registerLocalHostProtocol({
    handle(scheme, handler) {
      boundScheme = scheme
      assert.equal(typeof handler, 'function')
    },
  })
  assert.equal(boundScheme, 'app')
})
