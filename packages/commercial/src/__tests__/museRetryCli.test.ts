import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

test('oc-muse defers offline dispatch and retry timing to the server, then uses existing failure delivery', () => {
  const path = fileURLToPath(new URL('../../muse-bridge/tests/test_oc_muse_retry.py', import.meta.url))
  const result = spawnSync('python3', ['-I', path], { encoding: 'utf8', timeout: 10_000 })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
})
