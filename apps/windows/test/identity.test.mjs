import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createEncryptedFileIdentityStore,
  createMemoryIdentityStore,
  normalizeIdentityRecord,
  redactSecrets,
  resolveIdentityDirectory,
} from '../src/identity.mjs'

const SAMPLE = {
  deviceId: '11111111-1111-4111-8111-111111111111',
  containerId: 42,
  device_cert: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
  device_key: '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----',
  device_credential: `oc-dv.11111111-1111-4111-8111-111111111111.${'ab'.repeat(32)}`,
}

test('resolveIdentityDirectory uses %LOCALAPPDATA%\\Clarvy\\identity on Windows', () => {
  assert.equal(
    resolveIdentityDirectory({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\sam\\AppData\\Local' },
    }),
    'C:\\Users\\sam\\AppData\\Local\\Clarvy\\identity',
  )
  assert.equal(
    resolveIdentityDirectory({ platform: 'linux', userDataPath: '/tmp/clarvy' }),
    path.join('/tmp/clarvy', 'identity'),
  )
})

test('normalizeIdentityRecord keeps cert/key/oc-dv and refuses verifier or oc-v3', () => {
  const normalized = normalizeIdentityRecord(SAMPLE)
  assert.equal(normalized.device_cert, SAMPLE.device_cert)
  assert.throws(() => normalizeIdentityRecord({ ...SAMPLE, pkce_verifier: 'secret' }))
  assert.throws(() => normalizeIdentityRecord({ ...SAMPLE, 'oc-v3': 'oc-v3.nope' }))
  assert.throws(() => normalizeIdentityRecord({ device_cert: SAMPLE.device_cert }))
})

test('memory IdentityStore save/load/revoke never records verifier', async () => {
  const store = createMemoryIdentityStore()
  await store.save(SAMPLE)
  assert.deepEqual(Object.keys(store.writes[0]).sort(), [
    'containerId',
    'deviceId',
    'device_cert',
    'device_credential',
    'device_key',
    'version',
  ])
  assert.equal('pkce_verifier' in store.writes[0], false)
  assert.equal((await store.load()).deviceId, SAMPLE.deviceId)
  await store.revoke()
  assert.equal(await store.load(), null)
})

test('encrypted file IdentityStore writes only the encrypted blob and revoke deletes it', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'clarvy-identity-'))
  const plainWrites = []
  try {
    const store = createEncryptedFileIdentityStore({
      directory,
      encrypt: (text) => {
        plainWrites.push(text)
        return Buffer.from(text, 'utf8')
      },
      decrypt: (buffer) => buffer.toString('utf8'),
    })
    await store.save(SAMPLE)
    const onDisk = await readFile(store.filePath, 'utf8')
    assert.equal(onDisk.includes('pkce_verifier'), false)
    assert.equal(onDisk.includes('oc-v3'), false)
    assert.equal(JSON.parse(plainWrites[0]).device_key, SAMPLE.device_key)
    assert.equal((await store.load()).device_credential, SAMPLE.device_credential)
    await store.revoke()
    assert.equal(await store.load(), null)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('redactSecrets strips PEM and secret field names from audit payloads', () => {
  const redacted = redactSecrets({
    event: 'enroll_finish',
    deviceId: SAMPLE.deviceId,
    device_cert: SAMPLE.device_cert,
    pkce_verifier: 'aaaaaaaa',
  })
  assert.equal(redacted.event, 'enroll_finish')
  assert.equal(redacted.deviceId, SAMPLE.deviceId)
  assert.equal(redacted.device_cert, '[redacted]')
  assert.equal(redacted.pkce_verifier, '[redacted]')
  assert.equal(JSON.stringify(redacted).includes('BEGIN '), false)
})
