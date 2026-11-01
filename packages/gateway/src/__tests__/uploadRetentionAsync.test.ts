import assert from 'node:assert/strict'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { isUploadRetentionEnabled, runUploadRetentionSweep, scanJsonlTree, startUploadRetention, stopUploadRetention } from '../uploadRetention.js'

const name = `${'ab'.repeat(32)}.txt`

test('large JSONL directory scans keep heartbeat gaps below one second', async t => {
  const root = mkdtempSync(join(tmpdir(), 'retention-heartbeat-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const body = `${'x'.repeat(64 * 1024)} /api/media/${name}\n`
  for (let dir = 0; dir < 96; dir++) {
    const path = join(root, `d${dir}`)
    mkdirSync(path)
    for (let file = 0; file < 20; file++) writeFileSync(join(path, `${file}.jsonl`), body)
  }
  let last = performance.now()
  let maxGap = 0
  let beats = 0
  const timer = setInterval(() => {
    const now = performance.now()
    maxGap = Math.max(maxGap, now - last)
    last = now
    beats++
  }, 10)
  const names = new Set<string>()
  try {
    assert.equal(await scanJsonlTree(root, names), true)
    maxGap = Math.max(maxGap, performance.now() - last)
    assert.ok(beats > 0, 'heartbeat must run during the scan')
    assert.ok(maxGap < 1000, `maximum heartbeat gap ${maxGap.toFixed(1)}ms must be below 1000ms`)
    assert.ok(names.has(name), 'the entire synthetic tree is actually scanned')
    t.diagnostic(`1920 JSONL files; heartbeat beats=${beats}; maxGapMs=${maxGap.toFixed(1)}`)
  } finally {
    clearInterval(timer)
  }
})

test('chunk-boundary references survive and failed or oversized reads fail closed', async t => {
  const root = mkdtempSync(join(tmpdir(), 'retention-boundary-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const reference = `/api/media/${name}`
  for (const offset of [1, 12, reference.length - 2]) {
    writeFileSync(join(root, `${offset}.jsonl`), `${'x'.repeat(256 * 1024 - offset)}${reference}\n`)
  }
  const names = new Set<string>()
  assert.equal(await scanJsonlTree(root, names), true)
  assert.ok(names.has(name))
  const huge = join(root, 'oversized.jsonl')
  writeFileSync(huge, '')
  truncateSync(huge, 32 * 1024 * 1024 + 1)
  assert.equal(await scanJsonlTree(root, new Set()), false)
  assert.equal(await scanJsonlTree(join(root, 'missing'), new Set()), false)
  rmSync(huge)
  const outside = join(root, 'outside.txt')
  writeFileSync(outside, `/uploads/${'cd'.repeat(32)}.bin`)
  symlinkSync(outside, join(root, 'link.jsonl'))
  const safe = new Set<string>()
  assert.equal(await scanJsonlTree(root, safe), true)
  assert.equal(safe.has(`${'cd'.repeat(32)}.bin`), false)
})

test('retention is opt-in and its disabled scheduler and entry point do no filesystem scans', async () => {
  const previous = process.env.OC_UPLOAD_RETENTION_ENABLED
  const fs = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises')
  const originalOpen = fs.opendir
  const originalRead = fs.readdir
  let scans = 0
  fs.opendir = (async () => { scans++; throw new Error('disabled retention must not scan') }) as typeof fs.opendir
  fs.readdir = (async () => { scans++; throw new Error('disabled retention must not scan') }) as typeof fs.readdir
  syncBuiltinESMExports()
  const logs: string[] = []
  try {
    Reflect.deleteProperty(process.env, 'OC_UPLOAD_RETENTION_ENABLED')
    assert.equal(isUploadRetentionEnabled(), false)
    startUploadRetention({ info: msg => logs.push(msg) })
    await runUploadRetentionSweep()
    await delay(20)
    assert.equal(scans, 0)
    assert.deepEqual(logs, ['upload retention disabled'])
    process.env.OC_UPLOAD_RETENTION_ENABLED = '0'
    assert.equal(isUploadRetentionEnabled(), false)
    process.env.OC_UPLOAD_RETENTION_ENABLED = '1'
    assert.equal(isUploadRetentionEnabled(), true)
  } finally {
    stopUploadRetention()
    fs.opendir = originalOpen
    fs.readdir = originalRead
    syncBuiltinESMExports()
    if (previous === undefined) Reflect.deleteProperty(process.env, 'OC_UPLOAD_RETENTION_ENABLED')
    else process.env.OC_UPLOAD_RETENTION_ENABLED = previous
  }
})
