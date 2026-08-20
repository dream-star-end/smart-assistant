#!/usr/bin/env tsx
/**
 * Fail-closed tutorial eval control-plane worker.
 *
 * Does NOT spawn an agent inside the commercial master process.
 * Claims a leased job, optionally records operator-supplied evidence,
 * and for failures prints a sanitized `oc-memory delegate` command.
 *
 * Usage:
 *   npx tsx scripts/tutorial-eval-worker.ts claim --owner eval-worker-1
 *   npx tsx scripts/tutorial-eval-worker.ts recover
 *   npx tsx scripts/tutorial-eval-worker.ts finish --job <id> --token <fencing> --result failed --evidence /path/sanitized.json
 */
import { readFileSync } from 'node:fs'
import {
  buildCompassDelegatePrompt,
  claimEvalJob,
  finishEvalJob,
  recoverExpiredEvalLeases,
} from '../packages/commercial/src/tutorials/tutorialEval.ts'
import { scanJsonValue } from '../packages/commercial/src/tutorials/snapshotSanitizer.ts'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return undefined
  return process.argv[index + 1]
}

function requireArg(name: string): string {
  const value = arg(name)
  if (!value) {
    console.error(`missing --${name}`)
    process.exit(2)
  }
  return value
}

async function main(): Promise<void> {
  const cmd = process.argv[2]
  if (cmd === 'recover') {
    const n = await recoverExpiredEvalLeases()
    console.log(JSON.stringify({ recovered: n }))
    return
  }
  if (cmd === 'claim') {
    const job = await claimEvalJob({ ownerId: requireArg('owner') })
    if (!job) {
      console.log(JSON.stringify({ claimed: false }))
      return
    }
    console.log(JSON.stringify({ claimed: true, job }))
    console.error(
      'No in-process agent executor. Attach sanitized evidence via admin API or `finish`.\n' +
        'On failure, run:\n' +
        '  oc-memory delegate --model cursor-grok-4.6-high --goal "<sanitized compass prompt>"',
    )
    return
  }
  if (cmd === 'finish') {
    const evidencePath = arg('evidence')
    const evidence = evidencePath ? JSON.parse(readFileSync(evidencePath, 'utf8')) : {}
    const leaks = scanJsonValue(evidence, 'evidence')
    if (leaks.length > 0) {
      console.error(JSON.stringify({ ok: false, leakReport: { leaks } }))
      process.exit(1)
    }
    const result = requireArg('result')
    if (result !== 'passed' && result !== 'failed') {
      console.error('result must be passed|failed')
      process.exit(2)
    }
    const finished = await finishEvalJob({
      jobId: requireArg('job'),
      fencingToken: requireArg('token'),
      result,
      evidence,
      errorCode: arg('error') ?? (result === 'failed' ? 'eval_failed' : null),
    })
    if (result === 'failed') {
      const prompt = buildCompassDelegatePrompt({
        jobId: requireArg('job'),
        errorCode: arg('error') ?? 'eval_failed',
        evidenceSummary: JSON.stringify(evidence).slice(0, 1500),
      })
      console.log(
        JSON.stringify({
          ...finished,
          compassCommand: `oc-memory delegate --model cursor-grok-4.6-high --goal ${JSON.stringify(prompt)}`,
        }),
      )
      return
    }
    console.log(JSON.stringify(finished))
    return
  }
  console.error('usage: tutorial-eval-worker.ts claim|finish|recover')
  process.exit(2)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
