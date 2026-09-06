import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createHostLogger, redactLogValue, resolveLogsDirectory } from '../src/host/log.mjs'

test('resolveLogsDirectory uses %LOCALAPPDATA%\\Clarvy\\logs on Windows', () => {
  assert.equal(
    resolveLogsDirectory({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' } }),
    'C:\\Users\\a\\AppData\\Local\\Clarvy\\logs',
  )
})

test('redactLogValue masks oc-v3, oc-dv, oc-lah, PEM, verifier, and 64-hex', () => {
  const hex = 'ab'.repeat(32)
  const redacted = redactLogValue({
    token: 'oc-v3.deadbeef',
    verifier: 'pkce-verifier-value',
    pem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
    note: `bearer oc-lah.${hex} and oc-dv.11111111-1111-1111-1111-111111111111.${hex}`,
  })
  const blob = JSON.stringify(redacted)
  assert.equal(blob.includes('oc-v3.'), false)
  assert.equal(blob.includes('oc-dv.'), false)
  assert.equal(blob.includes('oc-lah'), false)
  assert.equal(blob.includes('BEGIN CERTIFICATE'), false)
  assert.equal(blob.includes('pkce-verifier-value'), false)
  assert.equal(blob.includes(hex), false)
  assert.equal(redacted.token, '[redacted]')
  assert.equal(redacted.verifier, '[redacted]')
})

test('host jsonl logger writes required fields, redacts secrets, and rotates 20MB×5', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'clarvy-log-'))
  try {
    const logger = createHostLogger({
      directory,
      now: () => new Date('2026-09-06T12:00:00.000Z'),
      maxBytes: 200,
      maxFiles: 5,
      containerId: 'ctr-1',
      generation: 3,
    })
    const hex = 'cd'.repeat(32)
    logger.info('workspace_denied', {
      muxStreamId: 7,
      errCode: 'OUT_OF_WORKSPACE',
      token: `oc-v3.${hex}`,
      detail: `PEM -----BEGIN RSA PRIVATE KEY-----\nABC\n-----END RSA PRIVATE KEY----- verifier=${hex}`,
    })
    const filePath = path.join(directory, 'lah-20260906.jsonl')
    const line = await readFile(filePath, 'utf8')
    const record = JSON.parse(line)
    assert.equal(record.ts, '2026-09-06T12:00:00.000Z')
    assert.equal(record.level, 'info')
    assert.equal(record.event, 'workspace_denied')
    assert.equal(record.containerId, 'ctr-1')
    assert.equal(record.generation, 3)
    assert.equal(record.muxStreamId, 7)
    assert.equal(record.errCode, 'OUT_OF_WORKSPACE')
    assert.equal(line.includes('oc-v3'), false)
    assert.equal(line.includes('BEGIN RSA'), false)
    assert.equal(line.includes(hex), false)

    for (let index = 0; index < 12; index += 1) {
      logger.info('noise', { n: index, pad: 'x'.repeat(40) })
    }
    const names = (await readdir(directory)).sort()
    assert.equal(names.includes('lah-20260906.jsonl'), true)
    assert.equal(names.includes('lah-20260906.jsonl.1'), true)
    assert.ok(names.filter((name) => name.startsWith('lah-20260906')).length <= 5)
    const current = await stat(filePath)
    assert.ok(current.size <= 200 + 80)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
