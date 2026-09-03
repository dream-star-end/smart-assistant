import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const sourcePath =
  process.env.OC_CRON_SUBMIT_BOUNDARY_SOURCE || join(root, 'packages/gateway/src/cron.ts')
const source = readFileSync(sourcePath, 'utf8')
const runJobStart = source.indexOf('  private async runJob(')
const nextMethod = source.indexOf('\n  private async ', runJobStart + 1)

if (runJobStart < 0 || nextMethod <= runJobStart) {
  throw new Error('[cron-submit-boundary] cannot locate the regular CronScheduler.runJob method')
}

const runJob = source.slice(runJobStart, nextMethod)
const marker = 'await durability.markSubmitStarted?.()'
const markerCount = runJob.split(marker).length - 1
const start = runJob.indexOf(marker)
const end = runJob.indexOf('await this.sessions.submit(', start)

if (markerCount !== 1 || start < 0 || end <= start) {
  throw new Error(
    `[cron-submit-boundary] regular runJob must contain exactly one submit boundary before sessions.submit (got ${markerCount})`,
  )
}

const boundary = runJob.slice(start, end)
if (!boundary.includes("return { kind: 'terminal_failure', code: 'EXECUTION_ERROR' }")) {
  throw new Error('[cron-submit-boundary] submit-start durability failures must be terminal')
}
if (boundary.includes("return { kind: 'retryable_failure', code: 'SUBMIT_START_FAILED' }")) {
  throw new Error('[cron-submit-boundary] unsafe automatic replay remains enabled')
}

console.log(
  '[cron-submit-boundary] PASS — unknown submit-start durability failures are terminal and never auto-replayed',
)
