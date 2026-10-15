import assert from 'node:assert/strict'
import test from 'node:test'
import { assessGoCache, goCachePrompts, parseGoCacheModel } from './user-contract-go-cache.mjs'

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
  assert.match(v.reason, /cache read ratio 0 < 0\.3/)
})

test('OCV5-432: later turns reading the earlier prompt pass; one evicted entry still passes', () => {
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
    true,
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

test('OCV5-432: prompts are unique per run and the model id is validated', () => {
  const p = goCachePrompts('0123abcd')
  assert.equal(p.length, 3)
  assert.equal(new Set(p).size, 3)
  assert.throws(() => goCachePrompts('bad nonce'))
  assert.throws(() => parseGoCacheModel('bad model!'))
  assert.equal(parseGoCacheModel(), 'opencode-gpt-6-luna')
})
