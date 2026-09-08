import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { after, test } from 'node:test'

const root = process.cwd()
const gate = resolve(root, 'scripts/check-v5-cron-submit-boundary.ts')
const source = readFileSync(resolve(root, 'packages/gateway/src/cron.ts'), 'utf8')
const dir = mkdtempSync(join(tmpdir(), 'oc-cron-submit-boundary-'))
const fixtures = resolve(root, 'scripts/__tests__/fixtures/cron-heartbeat-proof')

after(() => rmSync(dir, { recursive: true, force: true }))

const EXPECTED_LEAVES = [
  'tick→claim→synthetic submit keeps a healthy occurrence alive across 481 injected 15s beats',
  'injected waitingForUserInput getter is not cron-killed across 481 beats (synthetic scheduler submit)',
  'pre-submit persist pending does not renew the lease and stop refuses the late submit',
  'persistLastRun barrier then second-store adopt must not submit as the old owner',
  'persistLastRun barrier then reaper closeout must not submit',
  'execution-boundary sqlite error must not start submit or look like a fence reject',
  'submit success then hung destroy does not keep renewing',
  'submit throw then hung destroy does not keep renewing',
  'submit cancel then hung destroy does not keep renewing',
  'origin-session inject/ACK pending archive creates no local heartbeat',
  'stop during submit stops renewal; queued callback and the next due job cannot start',
  'non-waiting silence trips idle; waiting skips idle at 2h; 12h hard limit still fires',
]

function run(candidate: string) {
  const path = join(dir, `cron-${Math.random().toString(36).slice(2)}.ts`)
  writeFileSync(path, candidate)
  return spawnSync(process.execPath, ['--import', 'tsx', gate], {
    cwd: root,
    env: { ...process.env, OC_CRON_SUBMIT_BOUNDARY_SOURCE: path },
    encoding: 'utf8',
  })
}

function regularRunJob(input: string): { start: number; end: number; body: string } {
  const start = input.indexOf('  private async runJob(')
  const end = input.indexOf('\n  private async ', start + 1)
  assert.ok(start >= 0 && end > start)
  return { start, end, body: input.slice(start, end) }
}

function runGate(
  extra: NodeJS.ProcessEnv = {},
  opts: { timeoutMs?: number; killSignal?: NodeJS.Signals } = {},
) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', gate], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      LANG: process.env.LANG,
      TZ: process.env.TZ,
      ...extra,
    },
    encoding: 'utf8',
    timeout: opts.timeoutMs,
    killSignal: opts.killSignal,
  })
  return result
}

function out(result: ReturnType<typeof spawnSync>): string {
  return `${result.stdout || ''}${result.stderr || ''}`
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

test('SOURCE override does not execute behavior leaves (not an old-product red)', () => {
  const result = run(source)
  assert.equal(result.status, 0, out(result))
  assert.match(out(result), /static-read only; behavior leaves were not executed/)
  assert.doesNotMatch(out(result), /C-cron-submit-boundary-behavior"/)
})

test('missing behavior test is a runner red', () => {
  const result = runGate({
    OC_CRON_SUBMIT_BOUNDARY_BEHAVIOR_TEST: join(dir, 'no-such-heartbeat.test.ts'),
  })
  assert.notEqual(result.status, 0)
  assert.match(out(result), /behavior test missing/)
})

test('empty TAP is a runner red', () => {
  const tap = join(dir, 'empty.tap')
  writeFileSync(tap, 'TAP version 13\n')
  const result = runGate({ OC_CRON_SUBMIT_BOUNDARY_BEHAVIOR_TEST: tap })
  assert.notEqual(result.status, 0)
  assert.match(out(result), /behavior TAP rejected/)
})

test('skip leaf is a runner red', () => {
  const result = runGate({
    OC_CRON_SUBMIT_BOUNDARY_BEHAVIOR_TEST: join(fixtures, 'skip.mjs'),
  })
  assert.notEqual(result.status, 0)
  assert.match(out(result), /skip/)
})

test('todo leaf is a runner red', () => {
  const result = runGate({
    OC_CRON_SUBMIT_BOUNDARY_BEHAVIOR_TEST: join(fixtures, 'todo.mjs'),
  })
  assert.notEqual(result.status, 0)
  assert.match(out(result), /todo/i)
})

test('duplicate leaf names are a runner red', () => {
  const result = runGate({
    OC_CRON_SUBMIT_BOUNDARY_BEHAVIOR_TEST: join(fixtures, 'duplicate.mjs'),
  })
  assert.notEqual(result.status, 0)
  assert.match(out(result), /duplicate/)
})

test('missing expected leaf names are a runner red', () => {
  const result = runGate({
    OC_CRON_SUBMIT_BOUNDARY_BEHAVIOR_TEST: join(fixtures, 'missing-name.mjs'),
  })
  assert.notEqual(result.status, 0)
  assert.match(out(result), /missing=/)
})

test('loader failure is a runner red', () => {
  const result = runGate({
    OC_CRON_SUBMIT_BOUNDARY_BEHAVIOR_TEST: join(fixtures, 'loader-miss.mjs'),
  })
  assert.notEqual(result.status, 0)
  assert.match(out(result), /Cannot find module|behavior TAP rejected|exit=/)
})

test('nonzero child exit is a runner red', () => {
  const result = runGate({
    OC_CRON_SUBMIT_BOUNDARY_BEHAVIOR_TEST: join(fixtures, 'fail.mjs'),
  })
  assert.notEqual(result.status, 0)
  assert.match(out(result), /exit=|leafFail|fail=/)
})

test('child signal is a runner red', { timeout: 20_000 }, async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', gate], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      OC_CRON_SUBMIT_BOUNDARY_BEHAVIOR_TEST: join(fixtures, 'hang.mjs'),
      OC_CRON_SUBMIT_BOUNDARY_BEHAVIOR_TIMEOUT_MS: '30000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c: string) => {
    stdout += c
  })
  child.stderr.on('data', (c: string) => {
    stderr += c
  })
  await new Promise((r) => setTimeout(r, 400))
  child.kill('SIGTERM')
  const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => child.once('close', (code, signal) => resolve({ code, signal })),
  )
  assert.ok(closed.code !== 0 || closed.signal, `${stdout}\n${stderr}`)
})

test('behavior timeout is a runner red', () => {
  const result = runGate(
    {
      OC_CRON_SUBMIT_BOUNDARY_BEHAVIOR_TEST: join(fixtures, 'hang.mjs'),
      OC_CRON_SUBMIT_BOUNDARY_BEHAVIOR_TIMEOUT_MS: '800',
    },
    { timeoutMs: 20_000 },
  )
  assert.notEqual(result.status, 0)
  assert.match(out(result), /timeout/)
})

test('summary count contradiction is a runner red', () => {
  const tap = join(dir, 'contradict.tap')
  const blocks = EXPECTED_LEAVES.map(
    (name, i) => `ok ${i + 1} - ${name}\n  ---\n  duration_ms: 1\n  type: 'test'\n  ...`,
  )
  writeFileSync(
    tap,
    ['TAP version 13', ...blocks, '1..12', '# tests 11', '# pass 12', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0', ''].join(
      '\n',
    ),
  )
  const result = runGate({ OC_CRON_SUBMIT_BOUNDARY_BEHAVIOR_TEST: tap })
  assert.notEqual(result.status, 0)
  assert.match(out(result), /contradict|# tests 11/)
})

test('git-less identity still runs exact 12 candidate leaves', { timeout: 120_000 }, () => {
  const result = runGate({
    GIT_DIR: join(dir, 'not-a-git-dir'),
    GIT_WORK_TREE: join(dir, 'not-a-work-tree'),
  })
  assert.equal(result.status, 0, out(result))
  assert.match(out(result), /C-cron-submit-boundary-behavior/)
  const line = (result.stdout || '')
    .split('\n')
    .reverse()
    .find((row) => row.includes('"contractId":"C-cron-submit-boundary-behavior"'))
  assert.ok(line, out(result))
  const payload = JSON.parse(line!) as {
    actual: { names: string[]; leafCount: number; exit: number; skipped: number }
    source: string
  }
  assert.equal(payload.actual.leafCount, 12)
  assert.equal(payload.actual.exit, 0)
  assert.equal(payload.actual.skipped, 0)
  assert.deepEqual(payload.actual.names, EXPECTED_LEAVES)
  assert.match(payload.source, /^(ungitted-[0-9a-f]{64}|[0-9a-f]{40})$/)
  assert.doesNotMatch(out(result), /# skipped [1-9]/)
})
