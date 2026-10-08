import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'run-parallel.sh')

function run(...cmds: string[]) {
  return spawnSync('bash', [script, ...cmds], { encoding: 'utf8' })
}

test('all groups green → exit 0, every group ran, output is prefixed per group', () => {
  const r = run('echo alpha && echo beta', 'echo gamma')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /^\[1\] alpha$/m)
  assert.match(r.stdout, /^\[1\] beta$/m)
  assert.match(r.stdout, /^\[2\] gamma$/m)
  assert.match(r.stdout, /\[1\] rc=0/)
  assert.match(r.stdout, /\[2\] rc=0/)
})

test('one red group fails the step even when the other is green, and the green one still finishes', () => {
  const r = run('echo first; exit 7', 'sleep 0.3; echo slow-green')
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /::error::并行组 \[1\] 失败\(rc=7\)/)
  assert.match(r.stdout, /^\[2\] slow-green$/m)
})

test('&& chains inside a group keep short-circuit semantics and propagate failure', () => {
  const r = run('false && echo must-not-run', 'true')
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.doesNotMatch(r.stdout, /^\[1\] must-not-run$/m)
})

test('a failure inside a pipe is not hidden by the prefixing sed (pipefail)', () => {
  const r = run('false | cat')
  assert.equal(r.status, 1, r.stdout + r.stderr)
})

test('groups really run concurrently', () => {
  const started = Date.now()
  const r = run('sleep 1', 'sleep 1', 'sleep 1')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.ok(Date.now() - started < 2500, `took ${Date.now() - started}ms`)
})

test('GitHub workflow commands are not prefixed', () => {
  const r = run('echo "::error::boom"; exit 1')
  assert.match(r.stdout, /^::error::boom$/m)
})

test('no arguments is a usage error', () => {
  const r = spawnSync('bash', [script], { encoding: 'utf8' })
  assert.equal(r.status, 2)
})
