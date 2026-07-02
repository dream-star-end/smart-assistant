import assert from 'node:assert'
import { test } from 'node:test'
import {
  canonicalBundleJson,
  validateBenchmark,
  validateBundleFiles,
  validateBundlePath,
} from '../bundle.js'

test('validateBundlePath enforces allowlist, depth and traversal', () => {
  assert.equal(validateBundlePath('references/guide.md'), null)
  assert.equal(validateBundlePath('evals/evals.json'), null)
  assert.equal(validateBundlePath('assets/tpl/report.md'), null)
  assert.ok(validateBundlePath('scripts/run.sh')?.includes('暂不支持'))
  assert.ok(validateBundlePath('references/../secret'))
  assert.ok(validateBundlePath('/etc/passwd'))
  assert.ok(validateBundlePath('other/file.md'))
  assert.ok(validateBundlePath('references/a/b/c.md')) // 深度>2
})

test('validateBundleFiles caps sizes and validates evals.json', () => {
  const ok = validateBundleFiles([
    { path: 'references/x.md', content: 'hello' },
    {
      path: 'evals/evals.json',
      content: JSON.stringify({ version: 1, cases: [{ id: 'c1', prompt: 'p', assertions: ['a'] }] }),
    },
  ])
  assert.ok(ok.ok && ok.bundle && Object.keys(ok.bundle).length === 2)

  const badEvals = validateBundleFiles([{ path: 'evals/evals.json', content: '{"version":2}' }])
  assert.ok(!badEvals.ok)

  const dup = validateBundleFiles([
    { path: 'references/x.md', content: 'a' },
    { path: 'references/x.md', content: 'b' },
  ])
  assert.ok(!dup.ok)

  const big = validateBundleFiles([{ path: 'references/x.md', content: 'x'.repeat(65 * 1024) }])
  assert.ok(!big.ok)

  assert.deepEqual(validateBundleFiles(undefined), { ok: true, bundle: null })
  assert.deepEqual(validateBundleFiles([]), { ok: true, bundle: null })
})

test('canonicalBundleJson is key-order stable', () => {
  assert.equal(canonicalBundleJson({ b: '2', a: '1' }), canonicalBundleJson({ a: '1', b: '2' }))
})

test('validateBenchmark range checks', () => {
  assert.deepEqual(validateBenchmark(undefined), { ok: true, benchmark: null })
  const ok = validateBenchmark({ withPassRate: 0.9, withoutPassRate: 0.4, cases: 3 })
  assert.ok(ok.ok && ok.benchmark?.cases === 3)
  assert.ok(!validateBenchmark({ withPassRate: 1.5, withoutPassRate: 0, cases: 3 }).ok)
  assert.ok(!validateBenchmark({ withPassRate: 0.5, withoutPassRate: 0.4, cases: 9 }).ok)
})
