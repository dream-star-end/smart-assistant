import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { after, test } from 'node:test'

const root = process.cwd()
const gate = resolve(root, 'scripts/check-v5-cron-submit-boundary.ts')
const source = readFileSync(resolve(root, 'packages/gateway/src/cron.ts'), 'utf8')
const dir = mkdtempSync(join(tmpdir(), 'oc-cron-submit-boundary-'))

after(() => rmSync(dir, { recursive: true, force: true }))

function run(candidate: string) {
  const path = join(dir, `cron-${Math.random().toString(36).slice(2)}.ts`)
  writeFileSync(path, candidate)
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', gate],
    {
      cwd: root,
      env: { ...process.env, OC_CRON_SUBMIT_BOUNDARY_SOURCE: path },
      encoding: 'utf8',
    },
  )
}

function regularRunJob(input: string): { start: number; end: number; body: string } {
  const start = input.indexOf('  private async runJob(')
  const end = input.indexOf('\n  private async ', start + 1)
  assert.ok(start >= 0 && end > start)
  return { start, end, body: input.slice(start, end) }
}

test('cron submit-boundary gate accepts the production contract', () => {
  const result = run(source)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /cron-submit-boundary.*PASS/)
})

test('cron submit-boundary gate rejects deletion of the regular runJob boundary', () => {
  const method = regularRunJob(source)
  const marker = 'await durability.markSubmitStarted?.()'
  assert.equal(method.body.split(marker).length - 1, 1)
  const mutatedBody = method.body.replace(marker, '/* submit boundary deleted */')
  const mutated = source.slice(0, method.start) + mutatedBody + source.slice(method.end)
  const result = run(mutated)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr + result.stdout, /exactly one submit boundary/)
})

test('cron submit-boundary gate rejects retryable unknown-boundary failures', () => {
  const method = regularRunJob(source)
  const terminal = "return { kind: 'terminal_failure', code: 'EXECUTION_ERROR' }"
  const markerAt = method.body.indexOf('await durability.markSubmitStarted?.()')
  const submitAt = method.body.indexOf('await this.sessions.submit(', markerAt)
  const boundary = method.body.slice(markerAt, submitAt)
  assert.equal(boundary.split(terminal).length - 1, 1)
  const mutatedBoundary = boundary.replace(
    terminal,
    "return { kind: 'retryable_failure', code: 'SUBMIT_START_FAILED' }",
  )
  const mutatedBody =
    method.body.slice(0, markerAt) + mutatedBoundary + method.body.slice(submitAt)
  const mutated = source.slice(0, method.start) + mutatedBody + source.slice(method.end)
  const result = run(mutated)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr + result.stdout, /must be terminal|unsafe automatic replay/)
})
