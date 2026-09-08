import assert from 'node:assert/strict'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { after, test } from 'node:test'
import {
  assertCronSubmitBoundarySource,
  CRON_EXECUTION_HEARTBEAT_LEAVES,
  evaluateHeartbeatTap,
  pidsInGroup,
  superviseNodeTest,
  verifyPinnedWorkspace,
} from '../check-v5-cron-submit-boundary.js'

const root = process.cwd()
const gate = resolve(root, 'scripts/check-v5-cron-submit-boundary.ts')
const source = readFileSync(resolve(root, 'packages/gateway/src/cron.ts'), 'utf8')
const dir = mkdtempSync(join(tmpdir(), 'oc-cron-submit-boundary-'))
const fixtures = resolve(root, 'scripts/__tests__/fixtures/cron-heartbeat-proof')

after(() => rmSync(dir, { recursive: true, force: true }))

function regularRunJob(input: string): { start: number; end: number; body: string } {
  const start = input.indexOf('  private async runJob(')
  const end = input.indexOf('\n  private async ', start + 1)
  assert.ok(start >= 0 && end > start)
  return { start, end, body: input.slice(start, end) }
}

function validLeafTap(): string {
  const blocks = CRON_EXECUTION_HEARTBEAT_LEAVES.map(
    (name, i) => `ok ${i + 1} - ${name}\n  ---\n  duration_ms: 1\n  type: 'test'\n  ...`,
  )
  return [
    'TAP version 13',
    ...blocks,
    '1..12',
    '# tests 12',
    '# pass 12',
    '# fail 0',
    '# cancelled 0',
    '# skipped 0',
    '# todo 0',
    '',
  ].join('\n')
}

function runOfficial(extra: NodeJS.ProcessEnv = {}, timeoutMs = 120_000) {
  return spawnSync(process.execPath, ['--import', 'tsx', gate], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      LANG: process.env.LANG,
      TZ: process.env.TZ,
      ...extra,
    },
    encoding: 'utf8',
    timeout: timeoutMs,
  })
}

function out(result: ReturnType<typeof spawnSync>): string {
  return `${result.stdout || ''}${result.stderr || ''}`
}

test('cron submit-boundary gate accepts the production contract', () => {
  assertCronSubmitBoundarySource(source)
})

test('cron submit-boundary gate rejects deletion of the regular runJob boundary', () => {
  const method = regularRunJob(source)
  const marker = 'await durability.markSubmitStarted?.()'
  assert.equal(method.body.split(marker).length - 1, 1)
  const mutatedBody = method.body.replace(marker, '/* submit boundary deleted */')
  const mutated = source.slice(0, method.start) + mutatedBody + source.slice(method.end)
  assert.throws(() => assertCronSubmitBoundarySource(mutated), /exactly one submit boundary/)
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
  assert.throws(
    () => assertCronSubmitBoundarySource(mutated),
    /must be terminal|unsafe automatic replay/,
  )
})

test('official CLI refuses BEHAVIOR_TEST tap substitute (C-P1)', () => {
  const tap = join(dir, 'bypass.tap')
  writeFileSync(tap, validLeafTap())
  const result = runOfficial({ OC_CRON_SUBMIT_BOUNDARY_BEHAVIOR_TEST: tap }, 15_000)
  assert.notEqual(result.status, 0, out(result))
  assert.match(out(result), /refuses OC_CRON_SUBMIT_BOUNDARY_BEHAVIOR_TEST/)
  assert.doesNotMatch(out(result), /"leafCount":12/)
})

test('complete TAP helper rejects header/rootplan/contradiction/bailout/duplicate summary (C-P2)', () => {
  const tap = validLeafTap()
  evaluateHeartbeatTap(tap, { code: 0, signal: null })
  const cases: Record<string, string> = {
    missingHeader: tap.replace('TAP version 13\n', ''),
    missingPlan: tap.replace('1..12\n', ''),
    contradictoryPlan: tap.replace('1..12', '1..1'),
    bailOut: `${tap}Bail out! fixture failure\n`,
    duplicateSummary: tap.replace('# tests 12', '# tests 11\n# tests 12'),
  }
  let accepted = 0
  for (const [name, data] of Object.entries(cases)) {
    let rejected = false
    let error = ''
    try {
      evaluateHeartbeatTap(data, { code: 0, signal: null })
    } catch (err) {
      rejected = true
      error = (err as Error).message
    }
    if (!rejected) accepted += 1
    console.log(
      JSON.stringify({
        contractId: 'C-proof-complete-TAP',
        case: name,
        expected: { rejected: true },
        actual: { rejected, error },
      }),
    )
  }
  assert.equal(accepted, 0, 'all malformed TAP controls must reject')
})

test('parser rejects skip/todo/duplicate/missing/fail/empty TAP', () => {
  const base = validLeafTap()
  assert.throws(
    () => evaluateHeartbeatTap('TAP version 13\n', { code: 0, signal: null }),
    /header|root plan|leafCount/,
  )
  const skipped = base
    .replace(
      `ok 1 - ${CRON_EXECUTION_HEARTBEAT_LEAVES[0]}`,
      `ok 1 - ${CRON_EXECUTION_HEARTBEAT_LEAVES[0]} # SKIP`,
    )
    .replace('# skipped 0', '# skipped 1')
    .replace('# pass 12', '# pass 11')
  assert.throws(() => evaluateHeartbeatTap(skipped, { code: 0, signal: null }), /skip/i)
  const todoTap = base
    .replace(
      `ok 1 - ${CRON_EXECUTION_HEARTBEAT_LEAVES[0]}`,
      `ok 1 - ${CRON_EXECUTION_HEARTBEAT_LEAVES[0]} # TODO`,
    )
    .replace('# todo 0', '# todo 1')
    .replace('# pass 12', '# pass 11')
  assert.throws(() => evaluateHeartbeatTap(todoTap, { code: 0, signal: null }), /todo/i)
  const dup = base.replace(
    `ok 2 - ${CRON_EXECUTION_HEARTBEAT_LEAVES[1]}`,
    `ok 2 - ${CRON_EXECUTION_HEARTBEAT_LEAVES[0]}`,
  )
  assert.throws(() => evaluateHeartbeatTap(dup, { code: 0, signal: null }), /duplicate|missing/)
  const missingName = base.replace(
    `ok 12 - ${CRON_EXECUTION_HEARTBEAT_LEAVES[11]}`,
    'ok 12 - not-the-expected-leaf',
  )
  assert.throws(() => evaluateHeartbeatTap(missingName, { code: 0, signal: null }), /missing=/)
  const failed = base
    .replace(`ok 1 - ${CRON_EXECUTION_HEARTBEAT_LEAVES[0]}`, `not ok 1 - ${CRON_EXECUTION_HEARTBEAT_LEAVES[0]}`)
    .replace('# fail 0', '# fail 1')
    .replace('# pass 12', '# pass 11')
  assert.throws(() => evaluateHeartbeatTap(failed, { code: 1, signal: null }), /fail/)
})

async function waitForMarker(path: string, ms: number): Promise<string> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (existsSync(path)) return readFileSync(path, 'utf8')
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`hold marker not written within ${ms}ms: ${path}`)
}

async function runHold(timeoutMs: number) {
  const pinned = verifyPinnedWorkspace(root)
  const home = mkdtempSync(join(dir, 'hold-home-'))
  const tmp = mkdtempSync(join(dir, 'hold-tmp-'))
  const marker = join(dir, `hold-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
  let pgid = 0
  const started = superviseNodeTest({
    tree: root,
    loader: pinned.loader,
    testFile: join(fixtures, 'hold.mjs'),
    home,
    tmp,
    timeoutMs,
    extraEnv: { OC_PROOF_HOLD_MARKER: marker },
    onSpawn: (_proc, group) => {
      pgid = group
    },
  })
  let raw: string
  try {
    raw = await Promise.race([
      waitForMarker(marker, 8_000),
      started.then((result) => {
        throw new Error(
          `supervisor exited before hold marker timedOut=${result.timedOut} code=${result.code} stderr=${result.stderr} stdout=${result.stdout}`,
        )
      }),
    ])
  } catch (err) {
    await started.catch(() => undefined)
    throw err
  }
  const info = JSON.parse(raw) as { pid: number; ppid: number; home: string }
  assert.equal(info.home, home)
  assert.ok(existsSync(`/proc/${info.pid}`), 'grandchild must be running after hold')
  assert.ok(pgid > 0, 'process group id must be captured')
  return { started, info, home, tmp, marker, pgid }
}

test('timeout after real grandchild hold drains the group and deletes HOME (C-P3)', {
  timeout: 20_000,
}, async () => {
  const { started, info, home } = await runHold(8_000)
  const result = await started
  console.log(
    JSON.stringify({
      contractId: 'C-proof-tree-timeout',
      expected: { holdReached: true, boundedExit: true, runningGrandchild: false, homeExists: false },
      actual: {
        holdReached: true,
        timedOut: result.timedOut,
        exit: result.code,
        signal: result.signal,
        runningGrandchild: existsSync(`/proc/${info.pid}`),
        groupLive: pidsInGroup(result.pgid),
        homeExists: existsSync(home),
        stdoutChars: result.stdout.length,
        stderrChars: result.stderr.length,
        stdoutHead: result.stdout.slice(0, 400),
      },
    }),
  )
  assert.equal(result.timedOut, true, result.stdout + result.stderr)
  assert.ok(result.code !== 0 || result.signal)
  assert.equal(existsSync(`/proc/${info.pid}`), false, 'grandchild must not remain in S')
  assert.deepEqual(pidsInGroup(result.pgid), [])
  assert.equal(existsSync(home), false)
  assert.ok(result.stdout.length + result.stderr.length > 0, 'original TAP/stderr must be kept')
})

test('SIGTERM after real grandchild hold drains the group and deletes HOME (C-P3)', {
  timeout: 20_000,
}, async () => {
  const { started, info, home, pgid } = await runHold(30_000)
  process.kill(-pgid, 'SIGTERM')
  const result = await started
  console.log(
    JSON.stringify({
      contractId: 'C-proof-tree-signal',
      expected: { holdReached: true, boundedExit: true, runningGrandchild: false, homeExists: false },
      actual: {
        holdReached: true,
        exit: result.code,
        signal: result.signal,
        timedOut: result.timedOut,
        runningGrandchild: existsSync(`/proc/${info.pid}`),
        groupLive: pidsInGroup(pgid),
        homeExists: existsSync(home),
        stdoutChars: result.stdout.length,
        stderrChars: result.stderr.length,
      },
    }),
  )
  assert.ok(result.code !== 0 || result.signal)
  assert.equal(existsSync(`/proc/${info.pid}`), false)
  assert.deepEqual(pidsInGroup(pgid), [])
  assert.equal(existsSync(home), false)
})

test('official CLI with SOURCE still runs exact 12 candidate leaves (C-P1)', { timeout: 120_000 }, () => {
  const sourceCopy = join(dir, 'cron-source-copy.ts')
  writeFileSync(sourceCopy, source)
  const result = runOfficial({
    OC_CRON_SUBMIT_BOUNDARY_SOURCE: sourceCopy,
    GIT_DIR: join(dir, 'not-a-git-dir'),
    GIT_WORK_TREE: join(dir, 'not-a-work-tree'),
  })
  assert.equal(result.status, 0, out(result))
  assert.doesNotMatch(out(result), /behavior leaves were not executed/)
  assert.match(out(result), /C-cron-submit-boundary-behavior-start/)
  assert.match(result.stdout, /cron-submit-boundary.*PASS/)
  const line = (result.stdout || '')
    .split('\n')
    .reverse()
    .find((row) => row.includes('"contractId":"C-cron-submit-boundary-behavior"'))
  assert.ok(line, out(result))
  const payload = JSON.parse(line!) as {
    actual: {
      names: string[]
      leafCount: number
      exit: number
      skipped: number
      rootPlan?: number
      topLevelPoints?: number
    }
  }
  assert.equal(payload.actual.leafCount, 12)
  assert.equal(payload.actual.exit, 0)
  assert.equal(payload.actual.skipped, 0)
  assert.deepEqual([...payload.actual.names], [...CRON_EXECUTION_HEARTBEAT_LEAVES])
  assert.notEqual(payload.actual.rootPlan, 12)
  assert.equal(payload.actual.rootPlan, payload.actual.topLevelPoints)
  assert.doesNotMatch(out(result), /# skipped [1-9]/)
})
