#!/usr/bin/env tsx
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { BASE_REF, fetchReceipt, inputs, makeReceipt } from './lib/selfhostGateReceipt.js'

try {
  const [mode, root, sha, extra] = process.argv.slice(2)
  assert.ok(root && sha)
  if (mode === 'issue') {
    assert.equal(process.env.GITHUB_EVENT_NAME, 'merge_group')
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, 'utf8'))
    assert.equal(event.action, 'checks_requested')
    assert.equal(event.merge_group.base_ref, BASE_REF)
    assert.equal(event.merge_group.head_sha, sha)
    assert.equal(process.env.GITHUB_SHA, sha)
    assert.equal(execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sha)
    assert.equal(event.merge_group.head_ref, process.env.GITHUB_REF)
    const raw = JSON.parse(process.env.GATE_RESULTS!)
    const outcomes = Object.fromEntries(Object.entries(raw).map(([id, step]) => {
      const s = step as { outcome: string; conclusion: string }
      return [id, { outcome: s.outcome, conclusion: s.conclusion }]
    }))
    const receipt = makeReceipt({ repository: process.env.GITHUB_REPOSITORY!, sourceSha: sha,
      sourceRef: process.env.GITHUB_REF!, runId: Number(process.env.GITHUB_RUN_ID),
      runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT) }, inputs(root), outcomes)
    writeFileSync(extra!, `${JSON.stringify(receipt)}\n`, { flag: 'wx' })
  } else {
    assert.equal(mode, 'fetch')
    assert.equal(process.env.OC_SELFHOST_GATE_RECEIPTS, '1')
    const receipt = fetchReceipt(root, process.env.OC_SELFHOST_GATE_RECEIPT_REPO!, sha, extra!)
    process.stdout.write(`${JSON.stringify(receipt)}\n`)
  }
} catch {
  // Malformed data, command output and upstream errors must never leak credentials to train logs.
  console.error('[gate-receipt] unavailable or invalid; local gates required')
  process.exitCode = 1
}
