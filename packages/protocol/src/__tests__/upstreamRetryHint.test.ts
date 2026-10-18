import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodeUpstreamRetryHint, decodeUpstreamRetryHint, stripUpstreamRetryHint } from '../upstreamRetryHint.js'

test('429 deadline roundtrip, repeated identical hints and safe long timers', () => {
  for (const deadline of [0, Date.now() + 10_000, Date.now() + 2 ** 32]) {
    const encoded = encodeUpstreamRetryHint(deadline)!
    assert.deepEqual(decodeUpstreamRetryHint(`API Error: 429 ${encoded} ${encoded}`),
      { status: 429, retryNotBeforeMs: deadline })
  }
})
test('malformed, conflicting, non-429 and extra fields never create a deadline', () => {
  assert.equal(decodeUpstreamRetryHint('ordinary diagnostic'), undefined)
  assert.equal(decodeUpstreamRetryHint('OC_RETRY_HINT_V1:broken'), undefined)
  assert.equal(decodeUpstreamRetryHint(`${encodeUpstreamRetryHint(1)} ${encodeUpstreamRetryHint(2)}`), undefined)
  for (const value of [{ status: 500, retryNotBeforeMs: 1 }, { status: 429, retryNotBeforeMs: -1 },
    { status: 429, retryNotBeforeMs: 1.5 }, { status: 429, retryNotBeforeMs: 1, extra: true }]) {
    assert.equal(decodeUpstreamRetryHint(`OC_RETRY_HINT_V1:${btoa(JSON.stringify(value)).replace(/=+$/, '')}`), undefined)
  }
  assert.equal(encodeUpstreamRetryHint(-1), undefined)
  assert.equal(encodeUpstreamRetryHint(Number.POSITIVE_INFINITY), undefined)
})

test('error presentation removes only valid machine metadata, restoring pre-hint diagnostic bytes', () => {
  const original = 'API Error: 429 {"message":"rate limited"}'
  const withHint = original.replace('rate limited', `rate limited ${encodeUpstreamRetryHint(0)}`)
  assert.equal(stripUpstreamRetryHint(withHint), original)
  assert.equal(stripUpstreamRetryHint('OC_RETRY_HINT_V1:broken'), 'OC_RETRY_HINT_V1:broken')
})
