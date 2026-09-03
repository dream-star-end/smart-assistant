import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const source = readFileSync(join(root, 'packages/gateway/src/cron.ts'), 'utf8')
const start = source.indexOf('await durability.markSubmitStarted?.()')
const end = source.indexOf('await this.sessions.submit(', start)

if (start < 0 || end <= start) {
  throw new Error('[cron-submit-boundary] cannot locate the regular cron submit boundary')
}

const boundary = source.slice(start, end)
if (!boundary.includes("return { kind: 'terminal_failure', code: 'EXECUTION_ERROR' }")) {
  throw new Error('[cron-submit-boundary] submit-start durability failures must be terminal')
}
if (boundary.includes("return { kind: 'retryable_failure', code: 'SUBMIT_START_FAILED' }")) {
  throw new Error('[cron-submit-boundary] unsafe automatic replay remains enabled')
}

console.log(
  '[cron-submit-boundary] PASS — unknown submit-start durability failures are terminal and never auto-replayed',
)
