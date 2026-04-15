// Evaluation runner — loads YAML tasks, executes actions, judges results, produces report.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { getAction } from './actions.js'
import { evaluate } from './judges/index.js'
import type { EvalReport, TaskDef, TaskResult } from './types.js'

const TASKS_DIR = join(import.meta.dirname, 'tasks')

const REQUIRED_FIELDS = ['id', 'action', 'category', 'difficulty', 'assertions'] as const

function validateTask(task: unknown, file: string): task is TaskDef {
  if (!task || typeof task !== 'object') return false
  const t = task as Record<string, unknown>
  for (const field of REQUIRED_FIELDS) {
    if (!(field in t) || t[field] == null) {
      console.warn(`[eval] skipping invalid task in ${file}: missing required field '${field}'`)
      return false
    }
  }
  return true
}

export function loadTasks(filter?: { category?: string; tags?: string[]; ids?: string[] }): TaskDef[] {
  const files = readdirSync(TASKS_DIR).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).sort()
  const tasks: TaskDef[] = []
  const seenIds = new Set<string>()
  for (const file of files) {
    const raw = readFileSync(join(TASKS_DIR, file), 'utf-8')
    const docs = raw.split(/^---$/m).filter((s) => s.trim())
    for (const doc of docs) {
      let parsed: unknown
      try {
        parsed = parseYaml(doc)
      } catch (err: any) {
        console.warn(`[eval] YAML parse error in ${file}: ${err.message}`)
        continue
      }
      if (!validateTask(parsed, file)) continue
      const task = parsed as TaskDef
      if (seenIds.has(task.id)) {
        console.warn(`[eval] duplicate task id '${task.id}' in ${file}, skipping`)
        continue
      }
      seenIds.add(task.id)
      if (filter?.category && task.category !== filter.category) continue
      if (filter?.ids && !filter.ids.includes(task.id)) continue
      if (filter?.tags && !filter.tags.some((t) => task.tags?.includes(t))) continue
      tasks.push(task)
    }
  }
  return tasks.sort((a, b) => a.id.localeCompare(b.id))
}

export async function runTask(task: TaskDef): Promise<TaskResult> {
  const start = Date.now()
  const failures: string[] = []
  const timeout = task.timeout_ms ?? 10_000
  const expectThrows = task.assertions.some((a) => a.type === 'throws')

  try {
    // Run setup steps
    if (task.setup) {
      for (const step of task.setup) {
        const setupAction = getAction(step.action)
        if (!setupAction) {
          failures.push(`setup action not found: ${step.action}`)
          return mkResult(task, start, false, failures)
        }
        const setupResult = await withTimeout(setupAction(step.args), timeout)
        // Check setup returned ok (if it returns an object with ok field)
        if (setupResult && typeof setupResult === 'object' && 'ok' in setupResult && !(setupResult as any).ok) {
          failures.push(`setup action ${step.action} failed: ${(setupResult as any).error ?? 'unknown'}`)
          return mkResult(task, start, false, failures)
        }
      }
    }

    // Run main action
    const action = getAction(task.action)
    if (!action) {
      return mkResult(task, start, false, [`action not found: ${task.action}`])
    }

    let result: unknown
    try {
      result = await withTimeout(action(task.args), timeout)
    } catch (err: any) {
      if (expectThrows) {
        for (const assertion of task.assertions) {
          if (assertion.type === 'throws') {
            const errStr = err.message ?? String(err)
            if (assertion.value && !errStr.includes(String(assertion.value))) {
              failures.push(`expected error containing "${assertion.value}", got: "${errStr}"`)
            }
          }
        }
        return mkResult(task, start, failures.length === 0, failures)
      }
      return mkResult(task, start, false, [], err.message ?? String(err))
    }

    if (expectThrows) {
      failures.push('expected action to throw, but it succeeded')
    }

    // Evaluate non-throws assertions
    for (const assertion of task.assertions) {
      if (assertion.type === 'throws') continue
      const err = evaluate(assertion, result)
      if (err) failures.push(err)
    }
  } catch (err: any) {
    return mkResult(task, start, false, [], err.message ?? String(err))
  }

  return mkResult(task, start, failures.length === 0, failures)
}

function mkResult(task: TaskDef, start: number, passed: boolean, failures: string[], error?: string): TaskResult {
  return {
    id: task.id,
    category: task.category,
    difficulty: task.difficulty,
    passed,
    duration_ms: Date.now() - start,
    failures,
    error,
  }
}

export async function runAll(filter?: {
  category?: string
  tags?: string[]
  ids?: string[]
}): Promise<EvalReport> {
  const tasks = loadTasks(filter)
  const results: TaskResult[] = []
  for (const task of tasks) {
    results.push(await runTask(task))
  }
  return buildReport(results, tasks)
}

function buildReport(results: TaskResult[], tasks: TaskDef[]): EvalReport {
  const xfailIds = new Set(tasks.filter((t) => t.expected_failure).map((t) => t.id))
  const effective = results.filter((r) => !xfailIds.has(r.id))
  const passed = effective.filter((r) => r.passed).length
  const byCategory: EvalReport['by_category'] = {}
  const byDifficulty: EvalReport['by_difficulty'] = {}

  for (const r of effective) {
    // by category
    if (!byCategory[r.category]) byCategory[r.category] = { total: 0, passed: 0, pass_rate: 0 }
    byCategory[r.category].total++
    if (r.passed) byCategory[r.category].passed++

    // by difficulty
    if (!byDifficulty[r.difficulty]) byDifficulty[r.difficulty] = { total: 0, passed: 0, pass_rate: 0 }
    byDifficulty[r.difficulty].total++
    if (r.passed) byDifficulty[r.difficulty].passed++
  }

  for (const cat of Object.values(byCategory)) {
    cat.pass_rate = cat.total > 0 ? Math.round((cat.passed / cat.total) * 100) : 0
  }
  for (const diff of Object.values(byDifficulty)) {
    diff.pass_rate = diff.total > 0 ? Math.round((diff.passed / diff.total) * 100) : 0
  }

  return {
    timestamp: new Date().toISOString(),
    total: effective.length,
    passed,
    failed: effective.length - passed,
    xfail: xfailIds.size,
    pass_rate: effective.length > 0 ? Math.round((passed / effective.length) * 100) : 0,
    by_category: byCategory,
    by_difficulty: byDifficulty,
    results,
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}
