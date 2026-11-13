import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractNpmScripts } from '../check-ci-parity.ts'

// 2026-10-08:CI 把整组命令作为引号参数传给 .github/scripts/run-parallel.sh。脚本名两侧的引号
// 都不能粘进/挡住脚本名 —— 否则一个只在一侧的门就能躲过 CI ≡ check:v5 的核对。
test('plain, chained and pre-existing forms are unchanged', () => {
  assert.deepEqual(extractNpmScripts('npm run typecheck && npm run check:ci-parity').scripts, ['typecheck', 'check:ci-parity'])
  assert.deepEqual(extractNpmScripts("npm run test:commercial:integ:shard -- 'pr-1'").scripts, ['test:commercial:integ:shard'])
})

test('a trailing quote from a quoted command group does not leak into the script name', () => {
  const run = "bash .github/scripts/run-parallel.sh 'npm run check:v5:incidents && npm run check:tutorials' 'npm run test:web-react'"
  assert.deepEqual(extractNpmScripts(run).scripts, ['check:v5:incidents', 'check:tutorials', 'test:web-react'])
  assert.deepEqual(extractNpmScripts('bash x.sh "npm run a" "npm run b"').scripts, ['a', 'b'])
})

test('a quoted script name is still extracted, not silently ignored', () => {
  assert.deepEqual(extractNpmScripts("npm run 'test:new-gate' && npm run \"lint:x\"").scripts, ['test:new-gate', 'lint:x'])
})

test('workspace forms are still flagged', () => {
  assert.equal(extractNpmScripts('npm run --workspace packages/web-react build').workspaceForms.length, 1)
})
