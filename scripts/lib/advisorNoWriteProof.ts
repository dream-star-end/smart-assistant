import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

/** Exercise real dispatch/runner/MCP boundaries with local fake upstreams only.
 * The same focused regressions run in CI and in the pinned release tree. */
export function proveAdvisorNoWrite(root: string): void {
  const tests = [
    'packages/gateway/src/__tests__/advisorNoWriteTurn.test.ts',
    'packages/gateway/src/__tests__/advisorReadOnlyCcb.test.ts',
    'packages/gateway/src/__tests__/advisorReadOnlyBox.test.ts',
    'packages/gateway/src/__tests__/advisorReadOnlyCliAdapters.test.ts',
    'packages/gateway/src/__tests__/codexAdvisorReadOnly.test.ts',
    'packages/mcp-memory/src/__tests__/advisorReadOnlyPolicy.test.ts',
  ]
  const result = spawnSync('bash', [
    'scripts/test-mutex.sh', 'gateway',
    `npx --no-install tsx --test --test-concurrency=1 ${tests.join(' ')}`,
  ], {
    cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, OC_TEST_MUTEX_TIMEOUT: '240' },
  })
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  assert.equal(result.status, 0, output)
  assert.match(output, /^# fail 0$/m, output)
  assert.match(output, /^# skipped 0$/m, output)
  assert.match(output, /^# cancelled 0$/m, output)
  assert.ok(Number(output.match(/^# tests (\d+)$/m)?.[1]) >= 12, output)
  console.log('[advisor-no-write] PASS — all four engines remove mutation paths; direct MCP writes and billing admission stay blocked; later turns restore tools')
}
