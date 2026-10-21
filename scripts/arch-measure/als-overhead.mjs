#!/usr/bin/env node
// OCV5-560 (phase 3 plan v3.6 P1 exit criterion, §11.1): CPU cost of AsyncLocalStorage on
// turn-path-shaped work. Each mode runs in its own fresh child process (ALS, once created, stays
// active for the whole process), modes alternate, and the medians are compared.
//
//   off   no AsyncLocalStorage in the process; log calls read a constant context of the same shape
//   als   one AsyncLocalStorage; every turn runs inside store.run(ctx) and every log call reads
//         the context (what kernel/node's currentTraceFields does)
//
// A "turn" is a chain of awaited steps; each step parses and re-serialises a ~2 KB frame, and every
// 10th step writes a kernel log line (redaction included) to a no-op sink. That is a CPU-heavy
// approximation of the master turn path (the real one also waits on I/O, which ALS does not
// slow), so it over-states the share of ALS cost rather than hiding it.
//
// Usage: node --import tsx scripts/arch-measure/als-overhead.mjs [--turns 400] [--steps 200]
//          [--work 1] [--repeats 7] [--json out.json]
// Exit 0 always (it is a measurement); prints overheadPct and whether it is under 1 %.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const arg = (name, def) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : def
}
const TURNS = Number(arg('--turns', 400))
const STEPS = Number(arg('--steps', 200))
const REPEATS = Number(arg('--repeats', 7))
/** parse + re-serialise cycles of the ~2 KB frame per awaited step (CPU work between promises) */
const WORK = Number(arg('--work', 1))

const FRAME = JSON.stringify({
  type: 'outbound.stream_delta',
  sessionKey: 'agent:main:webmtqk46abc',
  traceId: '0a1b2c3d4e5f60718293a4b5c6d7e8f9',
  delta: 'x'.repeat(1500),
  usage: { input_tokens: 1234, output_tokens: 567 },
  seq: 1,
})

async function child(mode) {
  const { createLogger } = await import('../../packages/kernel/src/log.ts')
  // off: the same context shape from a constant, so both modes pay the same log-side cost
  // (reading + redacting the context) and only AsyncLocalStorage differs
  const fixed = { traceId: 't0', sessionKey: 'agent:main:x' }
  let context = () => fixed
  let run = (_ctx, fn) => fn()
  if (mode === 'als') {
    const { AsyncLocalStorage } = await import('node:async_hooks')
    const store = new AsyncLocalStorage()
    run = (ctx, fn) => store.run(ctx, fn)
    context = () => store.getStore()
  }
  const log = createLogger({ sink: () => {}, level: undefined, context })
  const step = async (i, turn) => {
    await Promise.resolve()
    let out = FRAME
    for (let w = 0; w < WORK; w++) {
      const f = JSON.parse(out)
      f.seq = i
      out = JSON.stringify(f)
    }
    if (i % 10 === 0) log.info('turn step', { seq: i, bytes: out.length, turn })
    return out.length
  }
  const turn = async (t) => {
    let n = 0
    for (let i = 0; i < STEPS; i++) n += await step(i, t)
    return n
  }
  for (let t = 0; t < 20; t++) await run({ traceId: `w${t}` }, () => turn(t)) // warm-up
  const c0 = process.cpuUsage()
  for (let t = 0; t < TURNS; t++)
    await run({ traceId: `t${t}`, sessionKey: 'agent:main:x' }, () => turn(t))
  const c = process.cpuUsage(c0)
  process.stdout.write(JSON.stringify({ mode, cpuMs: (c.user + c.system) / 1000 }))
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

if (process.argv[2] === '--child') {
  await child(process.argv[3])
} else {
  const self = fileURLToPath(import.meta.url)
  const runs = { off: [], als: [] }
  for (let r = 0; r < REPEATS; r++) {
    for (const mode of r % 2 ? ['als', 'off'] : ['off', 'als']) {
      const out = execFileSync(
        process.execPath,
        [
          '--import',
          'tsx',
          self,
          '--child',
          mode,
          '--turns',
          String(TURNS),
          '--steps',
          String(STEPS),
          '--work',
          String(WORK),
        ],
        { encoding: 'utf8' },
      )
      runs[mode].push(JSON.parse(out).cpuMs)
    }
  }
  const off = median(runs.off)
  const als = median(runs.als)
  const report = {
    turns: TURNS,
    steps: STEPS,
    work: WORK,
    repeats: REPEATS,
    node: process.version,
    cpuMsMedian: { off, als },
    overheadPct: Number((((als - off) / off) * 100).toFixed(2)),
    runs,
  }
  report.underOnePercent = report.overheadPct < 1
  const json = arg('--json')
  if (json) writeFileSync(json, `${JSON.stringify(report, null, 1)}\n`)
  console.log(
    `[als-overhead] node ${report.node} turns=${TURNS} steps=${STEPS} work=${WORK} repeats=${REPEATS} cpu median off=${off.toFixed(0)}ms als=${als.toFixed(0)}ms overhead=${report.overheadPct}% (<1%: ${report.underOnePercent})`,
  )
}
