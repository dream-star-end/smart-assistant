import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { publishReceiptReport, snapshotReceiptReport } from '../receiptCliTransport.js'

const locator = (i: number) => ({ jobId: `dlgjob-report-${i}`, generation: 1, receiptNonce: i.toString(16).padStart(64, '0') })
test('parallel actual processes publish complete distinct records and duplicate wait is idempotent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'receipt-report-'))
  try {
    const source = new URL('../receiptCliTransport.ts', import.meta.url).pathname
    await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
        `import {publishReceiptReport} from ${JSON.stringify(source)};publishReceiptReport(${JSON.stringify(dir)},${JSON.stringify(locator(i % 4))});`],
      { env: { PATH: process.env.PATH!, HOME: dir }, stdio: ['ignore', 'ignore', 'pipe'] })
      let err = ''; child.stderr.on('data', b => { err += b })
      child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(err)))
    })))
    const snapshot = snapshotReceiptReport(dir)
    assert.equal(snapshot.invalid, false)
    assert.deepEqual(snapshot.locators.map(l => l.jobId).sort(), [0, 1, 2, 3].map(i => locator(i).jobId))
    assert.equal(readdirSync(dir).length, 4)
    assert.ok(existsSync(dir), 'snapshot must not delete an unknown live writer directory')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('record conflict and overflow are visible; malformed sibling does not erase complete results', () => {
  const dir = mkdtempSync(join(tmpdir(), 'receipt-report-'))
  try {
    for (let i = 0; i < 64; i++) publishReceiptReport(dir, locator(i))
    assert.throws(() => publishReceiptReport(dir, locator(64)), /limit exceeded/)
    publishReceiptReport(dir, locator(63))
    assert.throws(() => publishReceiptReport(dir, { ...locator(0), receiptNonce: 'f'.repeat(64) }), /conflicting/)
    writeFileSync(join(dir, '00.json'), 'broken-json')
    writeFileSync(join(dir, '.pending-incomplete'), '{')
    const snapshot = snapshotReceiptReport(dir)
    assert.equal(snapshot.invalid, true)
    assert.equal(snapshot.locators.length, 63)
    assert.ok(existsSync(join(dir, '.pending-incomplete')))
    assert.ok(existsSync(join(dir, '00.json')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
