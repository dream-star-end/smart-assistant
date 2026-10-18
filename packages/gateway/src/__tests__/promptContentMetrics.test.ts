import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { estimateModelHistoryTokens } from '@openclaude/protocol'
import { PromptContentMetricsCache } from '../promptContentMetrics.js'
import { buildPromptContext } from '../promptSlots.js'

test('exact UTF8 content derivatives, immutable values and single-flight hits', async () => {
  const cache = new PromptContentMetricsCache(4, 1000)
  const text = 'same prefix 中文 🐈\r\n'
  const first = cache.get(text)
  assert.equal(cache.get(text), first)
  const value = first
  assert.equal(cache.get(text).sha256, value.sha256)
  assert.equal(value.bytes, Buffer.byteLength(text))
  assert.equal(await value.sha256, createHash('sha256').update(text).digest('hex'))
  assert.equal(value.tokensEstimate, estimateModelHistoryTokens(text))
  assert.ok(Object.isFrozen(value))
  assert.notEqual(await cache.get(`${text}.`).sha256, await value.sha256)
  assert.equal(await cache.get(text), value)
})

test('LRU entry bound promotes hits and does not reinsert completed evictions', async () => {
  const cache = new PromptContentMetricsCache(2, 1000)
  const a = cache.get('a')
  const b = cache.get('b')
  const pending = [a.sha256, b.sha256]
  assert.equal(cache.get('a'), a)
  await cache.get('c')
  assert.equal(cache.get('a'), a)
  assert.notEqual(cache.get('b'), b)
  await Promise.all(pending)
  assert.equal(cache.size.entries, 2)
})

test('UTF8 byte budget, oversized bypass and disabled cache', async () => {
  const cache = new PromptContentMetricsCache(10, 6)
  await cache.get('中文')
  assert.deepEqual(cache.size, { entries: 1, bytes: 6 })
  await cache.get('abc')
  assert.deepEqual(cache.size, { entries: 1, bytes: 3 })
  assert.notEqual(cache.get('oversized'), cache.get('oversized'))
  assert.deepEqual(cache.size, { entries: 1, bytes: 3 })
  const disabled = new PromptContentMetricsCache(0, 100)
  assert.notEqual(disabled.get('a'), disabled.get('a'))
  assert.deepEqual(disabled.size, { entries: 0, bytes: 0 })
  assert.throws(() => new PromptContentMetricsCache(-1, 1), RangeError)
})

test('warm full builds preserve exact content, order and fresh applied metadata', async () => {
  const ctx = { agentId: 'nonexistent-metrics-test', provider: 'ccb' as const,
    model: 'deepseek-v4-flash', cacheLayout: 'static-first' as const,
    availableMcpTools: ['skill_search', 'skill_view'] }
  const a = await buildPromptContext(ctx)
  const b = await buildPromptContext(ctx)
  assert.equal(a.content, b.content)
  assert.equal(a.contentSha256, createHash('sha256').update(a.content).digest('hex'))
  assert.deepEqual(a.applied, b.applied)
  assert.notEqual(a.applied, b.applied)
  for (let i = 0; i < a.applied.length; i++) {
    assert.notEqual(a.applied[i], b.applied[i])
    if (a.applied[i]!.meta) assert.notEqual(a.applied[i]!.meta, b.applied[i]!.meta)
  }
  const changed = await buildPromptContext({ ...ctx, availableMcpTools: [] })
  assert.notEqual(changed.contentSha256, a.contentSha256)
})

test('failed derivations are removed and a later call can recover', async (t) => {
  const cache = new PromptContentMetricsCache(2, 100)
  const digest = crypto.subtle.digest.bind(crypto.subtle)
  let fail = true
  t.mock.method(crypto.subtle, 'digest', (...args: Parameters<typeof digest>) => {
    if (fail) return Promise.reject(new Error('injected digest failure'))
    return digest(...args)
  })
  await assert.rejects(cache.get('retry').sha256, /injected digest failure/)
  assert.deepEqual(cache.size, { entries: 0, bytes: 0 })
  fail = false
  assert.equal(await cache.get('retry').sha256, createHash('sha256').update('retry').digest('hex'))
})
