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
  assert.equal((out.match(/^PASS /gm) ?? []).length, 6)
  for (const rc of [78, 79, 86]) assert.match(out, new RegExp(`PASS actual-outer rc=${rc} no-compensation`))
})

test('real SQLite exact archive acceptance and ride binding', () => {
  assert.match(focused('python3', 'v5LeasePolicyAcceptance.test.py'), /PASS total=41 failed=0/)
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
