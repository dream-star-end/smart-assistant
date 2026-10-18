// Offline CPU benchmark. No network/model calls and no prompt content output.
import assert from 'node:assert/strict'
import { estimateModelHistoryTokens } from '@openclaude/protocol'
import { PromptContentMetricsCache } from '../packages/gateway/src/promptContentMetrics.js'

const slots = Array.from({ length: 14 }, (_, i) => `${i}:` + '工具 instructions 中文 🐈\n'.repeat(50 + i * 5))
const content = slots.join('\n\n---\n\n')
const samples = [...slots, content]
async function baseline(s: string) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
  return { bytes: Buffer.byteLength(s), sha256: Array.from(hash, b => b.toString(16).padStart(2, '0')).join(''),
    tokensEstimate: estimateModelHistoryTokens(s) }
}
const warm = new PromptContentMetricsCache()
for (const s of samples) assert.deepEqual(await warm.get(s), await baseline(s))
async function measure(name: string, fn: (s: string, i: number) => Promise<unknown>) {
  const values: number[] = []
  for (let i = 0; i < 250; i++) {
    const started = performance.now()
    await Promise.all(samples.map(s => fn(s, i)))
    values.push(performance.now() - started)
  }
  values.sort((a, b) => a - b)
  return { name, iterations: values.length, p50Ms: values[125], p95Ms: values[237] }
}
const disabled = new PromptContentMetricsCache(0)
const changed = new PromptContentMetricsCache()
const oversized = new PromptContentMetricsCache(2, 1)
console.log(JSON.stringify({ inputBytes: Buffer.byteLength(content), slots: slots.length,
  results: [await measure('baseline', baseline), await measure('candidate-warm', s => warm.get(s)),
    await measure('candidate-disabled', s => disabled.get(s)),
    await measure('candidate-changed-content', (s, i) => changed.get(s + i)),
    await measure('candidate-oversized', s => oversized.get(s))], retained: warm.size }, null, 2))
