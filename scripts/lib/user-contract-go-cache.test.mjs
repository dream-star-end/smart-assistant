import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { GO_CACHE_MODEL, assessGoCache, goCachePrompts } from './user-contract-go-cache.mjs'

// Shapes from production usage (OCV5-432): before the fix every Luna request wrote the whole
// prompt and read nothing; after it, later turns read the earlier prompt.
test('OCV5-432: the defect shape (full writes, zero reads) fails the go-cache check', () => {
  const v = assessGoCache({
    requests: '3',
    input_tokens: '9',
    cache_read_tokens: '0',
    cache_write_tokens: '96764',
  })
  assert.equal(v.ok, false)
  assert.match(v.reason, /cache read ratio 0 < 0\.5/)
})

test('OCV5-527: stable prefix cache passes; one full eviction fails the stricter Muse check', () => {
  assert.equal(
    assessGoCache({
      requests: '3',
      input_tokens: '60',
      cache_read_tokens: '64700',
      cache_write_tokens: '32300',
    }).ok,
    true,
  )
  assert.equal(
    assessGoCache({
      requests: '3',
      input_tokens: '60',
      cache_read_tokens: '32300',
      cache_write_tokens: '64700',
    }).ok,
    false,
  )
})

test('OCV5-432: a missing row, too few requests or non-numeric usage fail closed', () => {
  assert.equal(assessGoCache(undefined).ok, false)
  assert.match(
    assessGoCache({
      requests: '2',
      input_tokens: '1',
      cache_read_tokens: '9',
      cache_write_tokens: '1',
    }).reason,
    /≥3 billed requests/,
  )
  assert.equal(
    assessGoCache({
      requests: '3',
      input_tokens: 'x',
      cache_read_tokens: '9',
      cache_write_tokens: '1',
    }).ok,
    false,
  )
})

test('OCV5-432: prompts are unique per run and the proven model is fixed', () => {
  const p = goCachePrompts('0123abcd')
  assert.equal(p.length, 3)
  assert.equal(new Set(p).size, 3)
  assert.throws(() => goCachePrompts('bad nonce'))
  assert.equal(GO_CACHE_MODEL, 'muse-spark-1.3-go')
})

test('OCV5-432 Codex r1: the release check has no model override', () => {
  const src = readFileSync(new URL('../v5-go-cache-contract.mjs', import.meta.url), 'utf8')
  assert.match(src, /const model = GO_CACHE_MODEL\n/)
  assert.doesNotMatch(src, /process\.env\.V5_GO_CACHE/)
})

// Actual usage aggregates from H/g425-accept on 2026-10-15: p3-accept-muse-spark-1.3-go
// (before OCV5-432) and g432-accept-muse-spark-1.3-go (after). The old 0.3 threshold
// accepts the broken 0.319 prefix, so merely swapping the model would weaken the proof.
test('OCV5-527: real Muse broken partial-prefix usage fails and repaired prefix usage passes', () => {
  const broken = { requests: '3', input_tokens: '69903', cache_read_tokens: '32738', cache_write_tokens: '0' }
  assert.equal(assessGoCache(broken, { minRatio: 0.3 }).ok, true)
  assert.equal(assessGoCache(broken).ok, false)
  assert.equal(assessGoCache({
    requests: '3', input_tokens: '34468', cache_read_tokens: '68194', cache_write_tokens: '0',
  }).ok, true)
})
