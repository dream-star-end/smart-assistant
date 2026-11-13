import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { g8ReplayGateMain, runG8ReplayGate } from '../v5-selfhost-g8-replay.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const fixtures = path.join(root, 'scripts/fixtures/g8-replay')

test('the replay gate matches every desensitized case', () => {
  const result = runG8ReplayGate(fixtures)
  assert.deepEqual(result.failures, [])
  assert.equal(result.checked, 7)
  assert.equal(result.ok, true)
  assert.equal(g8ReplayGateMain([fixtures]), 0)
})

test('a mismatched expectation fails the gate without exiting the importer', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'g8-replay-'))
  writeFileSync(
    path.join(dir, 'bad.json'),
    JSON.stringify({
      id: 'bad',
      expect: {
        verdict: 'ok',
        severity: 'info',
        retryable: false,
        askHuman: false,
        alert: false,
        stopSession: false,
        reason: 'ok',
        point: 'turn_end',
        traceId: '11111111111111111111111111111111',
      },
      observation: {
        point: 'turn_end',
        traceId: '11111111111111111111111111111111',
        boxDecision: 'rejected',
      },
    }),
  )
  const result = runG8ReplayGate(dir)
  assert.equal(result.ok, false)
  assert.equal(result.failures.some((line) => line.startsWith('bad: verdict')), true)
  assert.equal(g8ReplayGateMain([dir]), 1)
})

test('the command exits 0 on the shipped fixtures', () => {
  const tsx = path.join(root, 'node_modules/.bin/tsx')
  const ran = spawnSync(tsx, ['scripts/v5-selfhost-g8-replay.ts'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(ran.status, 0, ran.stderr || ran.stdout)
  assert.equal(ran.stdout.includes('g8 replay gate ok: 7 cases'), true)
})
