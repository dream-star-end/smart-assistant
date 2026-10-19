// Offline paired CPU benchmark. No network/model calls or prompt content output.
import assert from 'node:assert/strict'
import { estimateModelHistoryTokens } from '@openclaude/protocol'
import { PromptContentMetricsCache } from '../packages/gateway/src/promptContentMetrics.js'

const fixture = Array.from({ length: 16 }, (_, i) => ({
  text: `${i}:${'工具 instructions 中文 🐈\n'.repeat(50 + i * 5)}`,
  estimate: i < 14, // static-first AGENTS_DYNAMIC/MEMORY_INDEX were never token-estimated.
}))
async function sha(content: string) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)))
  return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('')
}
async function baseline(slots: typeof fixture) {
  const content = slots.map(s => s.text).join('\n\n---\n\n')
  const applied = await Promise.all(slots.map(async s => ({ bytes: Buffer.byteLength(s.text), sha256: await sha(s.text) })))
  const tokens = slots.map(s => s.estimate ? estimateModelHistoryTokens(s.text) : null)
  const totalTokens = estimateModelHistoryTokens(content)
  return { applied, tokens, totalTokens, contentSha256: await sha(content) }
}
async function candidate(slots: typeof fixture, cache: PromptContentMetricsCache) {
  const content = slots.map(s => s.text).join('\n\n---\n\n')
  const metrics = slots.map(s => cache.get(s.text))
  const applied = await Promise.all(metrics.map(async m => ({ bytes: m.bytes, sha256: await m.sha256 })))
  const final = cache.get(content)
  const tokens = slots.map((s, i) => s.estimate ? metrics[i]!.tokensEstimate : null)
  const totalTokens = final.tokensEstimate
  return { applied, tokens, totalTokens, contentSha256: await final.sha256 }
}
const results = []
for (const mode of ['warm', 'cold', 'churn', 'oversized']) {
  const cache = new PromptContentMetricsCache(128, mode === 'oversized' ? 1 : 2 * 1024 * 1024)
  assert.deepEqual(await candidate(fixture, cache), await baseline(fixture))
  const base: number[] = []
  const head: number[] = []
  for (let i = 0; i < 120; i++) {
    const slots = mode === 'churn' ? fixture.map(s => ({ ...s, text: `${s.text}${i}` })) : fixture
    const currentCache = mode === 'cold' ? new PromptContentMetricsCache() : cache
    const run = async (kind: 'base' | 'head') => {
      const start = performance.now()
      if (kind === 'base') await baseline(slots)
      else await candidate(slots, currentCache)
      ;(kind === 'base' ? base : head).push(performance.now() - start)
    }
    for (const kind of (i % 2 ? ['head', 'base'] : ['base', 'head']) as ('base' | 'head')[]) await run(kind)
  }
  const stats = (data: number[]) => { data.sort((a, b) => a - b); return { p50Ms: data[60], p95Ms: data[114] } }
  results.push({ mode, iterations: base.length, base: stats(base), candidate: stats(head) })
}
console.log(JSON.stringify({ fixtureBytes: fixture.reduce((n, s) => n + Buffer.byteLength(s.text), 0),
  slots: fixture.length, scheduling: 'slot hashes -> token estimates -> final hash; alternating paired order', results }, null, 2))
