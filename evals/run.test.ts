// Evaluation test entry point — run with:
//   npx tsx --test evals/run.test.ts
//   npx tsx --test evals/run.test.ts -- --category=skill
//   npx tsx --test evals/run.test.ts -- --tags=security

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, after } from 'node:test'
import * as assert from 'node:assert/strict'

// Hermetic isolation: set env BEFORE dynamic-importing storage (paths.ts reads HOME at import time).
const evalHome = mkdtempSync(join(tmpdir(), 'openclaude-eval-'))
process.env.OPENCLAUDE_HOME = evalHome

// Dynamic imports — these must come after setting OPENCLAUDE_HOME so paths.ts picks up the temp dir.
const { loadTasks, runTask } = await import('./runner.js')
const { closeSessionsDb } = await import('@openclaude/storage')

// Parse CLI filter from process.argv
function parseFilter(): { category?: string; tags?: string[]; ids?: string[] } {
  const filter: { category?: string; tags?: string[]; ids?: string[] } = {}
  for (const arg of process.argv) {
    if (arg.startsWith('--category=')) filter.category = arg.split('=')[1]
    if (arg.startsWith('--tags=')) filter.tags = arg.split('=')[1].split(',')
    if (arg.startsWith('--ids=')) filter.ids = arg.split('=')[1].split(',')
  }
  return filter
}

const filter = parseFilter()
const tasks = loadTasks(filter)

if (tasks.length === 0) {
  console.error('[eval] No tasks loaded — check filters or task files')
  process.exit(1)
}

describe(`Evaluation Suite (${tasks.length} tasks)`, () => {
  after(async () => {
    await closeSessionsDb()
    try { rmSync(evalHome, { recursive: true, force: true }) } catch {}
  })

  for (const task of tasks) {
    const isXfail = task.expected_failure === true
    const label = isXfail
      ? `[${task.category}] ${task.id}: ${task.description} [XFAIL]`
      : `[${task.category}] ${task.id}: ${task.description}`

    it(label, async () => {
      const result = await runTask(task)
      if (isXfail) {
        if (result.passed) {
          console.log(`  ℹ ${task.id} XFAIL passed unexpectedly — consider removing expected_failure`)
        }
        return
      }
      if (!result.passed) {
        const details = result.error
          ? `Error: ${result.error}`
          : `Failures:\n${result.failures.map((f) => `  - ${f}`).join('\n')}`
        assert.fail(`${task.id} FAILED (${result.duration_ms}ms)\n${details}`)
      }
    })
  }
})
