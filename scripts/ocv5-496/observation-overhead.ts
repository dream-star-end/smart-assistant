/** Local synthetic benchmark. No network, credentials, product requests, or log writes. */
import { performance } from 'node:perf_hooks'
import { Transform, Writable, Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { codexResponseTiming } from '../../packages/commercial/src/http/codexRelayTiming.js'
import { measureLogWrite, takeLogWriteTimingSnapshot } from '@openclaude/protocol'
const frame = Buffer.from('data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: 'x'.repeat(512) }) + '\n\n')
const chunks = Array.from({ length: 200 }, () => frame)
const samples = { passthrough: [] as number[], observed: [] as number[] }
for (let round = 0; round < 120; round++) {
  for (const kind of ['passthrough', 'observed'] as const) {
    const tap = kind === 'observed' ? codexResponseTiming(() => {}) : new Transform({ transform: (b, _e, cb) => cb(null, b) })
    const started = performance.now()
    await pipeline(Readable.from(chunks), tap, new Writable({ write: (_b, _e, cb) => cb() }))
    if (round >= 20) samples[kind].push(performance.now() - started)
  }
}
const distribution = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return { n: sorted.length, p50Ms: sorted[Math.floor(sorted.length / 2)], maxMs: sorted.at(-1) }
}
takeLogWriteTimingSnapshot()
const writes = 100_000
const started = performance.now()
for (let i = 0; i < writes; i++) measureLogWrite(() => {}, 32)
const writeCounterTotalMs = performance.now() - started
console.log(JSON.stringify({ mode: 'synthetic-no-network-no-disk-logs', providerRequests: 0,
  bytesPerStream: frame.length * chunks.length, framesPerStream: chunks.length,
  passthrough: distribution(samples.passthrough), observed: distribution(samples.observed),
  writeCounterCalls: writes, writeCounterTotalMs, counter: takeLogWriteTimingSnapshot() }))
