import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { spkiSha256Base64FromPem } from '../src/tunnel/bootstrap.mjs'
import {
  RuntimeCorruptError,
  createArtifactTlsOptions,
  fetchArtifact,
  sha256File,
} from '../src/host/runtime/fetchArtifact.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const tlsDir = path.join(here, 'fixtures/tls')

function pem(name) {
  return fs.readFileSync(path.join(tlsDir, name), 'utf8')
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function serveBytes(body, { status = 200 } = {}) {
  const server = https.createServer({
    key: pem('origin.key'),
    cert: pem('origin.crt'),
    ca: pem('ca.crt'),
    requestCert: false,
    minVersion: 'TLSv1.3',
    maxVersion: 'TLSv1.3',
  }, (req, res) => {
    res.writeHead(status, {
      'content-type': 'application/octet-stream',
      'content-length': String(body.length),
    })
    res.end(body)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        async close() {
          await new Promise((r) => server.close(r))
        },
      })
    })
  })
}

test('createArtifactTlsOptions freezes rejectUnauthorized true and requires pin or same origin', () => {
  const pin = spkiSha256Base64FromPem(pem('origin.crt'))
  const tls = createArtifactTlsOptions({
    url: 'https://127.0.0.1:9/a.bin',
    spkiPin: pin,
    caPem: pem('ca.crt'),
  })
  assert.equal(tls.rejectUnauthorized, true)
  assert.equal(typeof tls.checkServerIdentity, 'function')
  assert.throws(() => { tls.rejectUnauthorized = false }, TypeError)
  assert.throws(
    () => createArtifactTlsOptions({ url: 'https://other.example/a.bin' }),
    /public origin or provide SPKI pin/,
  )
  const same = createArtifactTlsOptions({
    url: 'https://cdn.example.test/a.bin',
    publicOrigin: 'https://cdn.example.test',
  })
  assert.equal(same.rejectUnauthorized, true)
  assert.equal(same.checkServerIdentity, undefined)
  assert.equal(same.ca, undefined)
})

test('createArtifactTlsOptions ignores 18445 pin and device CA on public same-origin artifact', () => {
  const pin = spkiSha256Base64FromPem(pem('origin.crt'))
  const tls = createArtifactTlsOptions({
    url: 'https://claudeai.chat/artifacts/ccb.bin',
    publicOrigin: 'https://claudeai.chat',
    spkiPin: pin,
    caPem: pem('ca.crt'),
  })
  assert.equal(tls.rejectUnauthorized, true)
  assert.equal(tls.minVersion, 'TLSv1.3')
  assert.equal(tls.checkServerIdentity, undefined)
  assert.equal(tls.ca, undefined)
  assert.equal('ca' in tls, false)
})

test('fetchArtifact downloads over pinned https and skips when hash already matches', async () => {
  const payload = Buffer.from('ccb-fixture-artifact')
  const digest = sha256(payload)
  const stub = await serveBytes(payload)
  const pin = spkiSha256Base64FromPem(pem('origin.crt'))
  const destRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-runtime-'))
  try {
    const first = await fetchArtifact({
      url: `https://127.0.0.1:${stub.port}/ccb.bin`,
      sha256: digest,
      destRoot,
      spkiPin: pin,
      caPem: pem('ca.crt'),
    })
    assert.equal(first.downloaded, true)
    assert.equal(fs.existsSync(first.path), true)
    assert.equal(await sha256File(first.path), digest)
    const second = await fetchArtifact({
      url: `https://127.0.0.1:${stub.port}/ccb.bin`,
      sha256: digest,
      destRoot,
      spkiPin: pin,
      caPem: pem('ca.crt'),
    })
    assert.equal(second.downloaded, false)
    assert.equal(second.path, first.path)
  } finally {
    await stub.close()
    fs.rmSync(destRoot, { recursive: true, force: true })
  }
})

test('fetchArtifact deletes a corrupt download and reports 运行时损坏', async () => {
  const payload = Buffer.from('not-the-expected-bytes')
  const stub = await serveBytes(payload)
  const pin = spkiSha256Base64FromPem(pem('origin.crt'))
  const destRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-runtime-'))
  try {
    await assert.rejects(
      () => fetchArtifact({
        url: `https://127.0.0.1:${stub.port}/ccb.bin`,
        sha256: 'ab'.repeat(32),
        destRoot,
        spkiPin: pin,
        caPem: pem('ca.crt'),
      }),
      (err) => err instanceof RuntimeCorruptError && err.message.includes('运行时损坏'),
    )
    const dir = path.join(destRoot, 'ccb', 'ab'.repeat(32))
    const leftover = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((name) => !name.endsWith('.part'))
      : []
    assert.equal(leftover.length, 0)
  } finally {
    await stub.close()
    fs.rmSync(destRoot, { recursive: true, force: true })
  }
})

test('fetchArtifact refuses http urls', async () => {
  await assert.rejects(
    () => fetchArtifact({
      url: 'http://127.0.0.1/ccb.bin',
      sha256: 'ab'.repeat(32),
      destRoot: os.tmpdir(),
    }),
    /must be https/,
  )
})

test('existing dest with mismatched hash is deleted and reported corrupt', async () => {
  const destRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-runtime-'))
  const digest = 'cd'.repeat(32)
  const dest = path.join(destRoot, 'ccb', digest, 'artifact.bin')
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, 'stale')
  try {
    await assert.rejects(
      () => fetchArtifact({
        url: 'https://127.0.0.1:1/ccb.bin',
        sha256: digest,
        destRoot,
        filename: 'artifact.bin',
        spkiPin: spkiSha256Base64FromPem(pem('origin.crt')),
        caPem: pem('ca.crt'),
      }),
      (err) => err instanceof RuntimeCorruptError,
    )
    assert.equal(fs.existsSync(dest), false)
  } finally {
    fs.rmSync(destRoot, { recursive: true, force: true })
  }
})
