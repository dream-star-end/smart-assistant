import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

test('durable release policy filesystem and decision contract (23 tests)', () => {
  const r = spawnSync('python3', [path.join(here, 'v5ReleasePolicy.test.py')], {
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout + r.stderr, /Ran 23 tests/)
  assert.match(r.stdout + r.stderr, /\bOK\b/)
})

test('real saga policy and legacy capability controls (87 assertions)', () => {
  const r = spawnSync('bash', [path.join(here, 'v5-release-policy-drill.sh')], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /RESULT PASS=87 FAIL=0/)
})

function focused(command: string, filename: string) {
  const r = spawnSync(command, [path.join(here, filename)], {
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  return r.stdout
}

test('actual saga policy ablation fails the healthy-candidate contract', () => {
  assert.match(focused('bash', 'v5-release-policy-red-drill.sh'),
    /POLICY_RED_GREEN ablated=1 actual=0 faultHits=1:1/)
})

test('actual outer caller preserves holds and dry-run boundaries', () => {
  const out = focused('bash', 'v5-selfhost-outer-policy.test.sh')
  assert.equal((out.match(/^PASS /gm) ?? []).length, 7)
  for (const rc of [78, 79, 86]) assert.match(out, new RegExp(`PASS actual-outer rc=${rc} no-compensation`))
})

test('real SQLite exact archive acceptance and ride binding', () => {
  assert.match(focused('python3', 'v5LeasePolicyAcceptance.test.py'), /PASS total=42 failed=0/)
})

test('production resume adapter refuses stale live and reuses exact acceptance', () => {
  assert.match(focused('python3', 'v5SelfhostPolicyResume.test.py'),
    /PASS actual resume adapter stale\/dual-file regression cases/)
})

test('actual bootstrap readers and post-lock mutation barrier', () => {
  const out = focused('bash', 'v5-release-policy-bootstrap.test.sh')
  assert.equal((out.match(/^PASS /gm) ?? []).length, 26)
  assert.match(out, /PASS actual-post-lock-barrier fresh79 no-holder-or-following-write/)
  assert.match(out, /PASS actual-post-lock-barrier inherited79 no-holder-or-following-write/)
})

test('actual registrar and native binding preserve exact request ownership', () => {
  assert.match(focused('python3', 'v5SelfhostPolicyBind.test.py'),
    /PASS actual register \/ native SQL \/ early PID0-race \/ legacy \/ rejection cases/)
})

test('actual failed cleanup resumes through receipt, reader and ride settlement', () => {
  const out = focused('python3', 'v5SelfhostPolicyPhaseReplay.test.py')
  assert.match(out, /PASS keep-resume-reader-settle witness=/)
  assert.match(out, /PASS phase-repair-failure-holds witness=/)
  assert.match(out, /PASS total=2 failed=0/)
})


test('actual runtime history readers drain large files and preserve upstream failures (5 tests)', () => {
  const r = spawnSync('python3', [path.join(here, 'v5RuntimeHistoryDrain.test.py')], {
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  const out = r.stdout + r.stderr
  assert.equal(r.status, 0, out)
  assert.match(out, /Ran 5 tests/)
  assert.match(out, /test_large_last_and_nth_drain_without_revalidating_older_rows/)
  assert.match(out, /\bOK\b/)
  console.log(out.trim())
})
