import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const CRON_EXECUTION_HEARTBEAT_LEAVES = [
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
] as const

const WORKSPACE_PACKAGES = ['gateway', 'storage', 'protocol'] as const
const DEFAULT_TIMEOUT_MS = 120_000
const DRAIN_MS = 2_000
const SUMMARY_KEYS = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'] as const

export function assertCronSubmitBoundarySource(source: string): void {
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
}

type TapLeaf = { name: string; ok: boolean; skip: boolean; todo: boolean }
type TapCounts = Partial<Record<(typeof SUMMARY_KEYS)[number], number>>

export type TapEval = {
  leaves: TapLeaf[]
  counts: TapCounts
  headers: number
  rootPlans: number[]
  topLevelPoints: number
  summaryHits: Record<string, number>
  bailout: boolean
  unclosedYaml: boolean
  duplicatePointNumbers: string[]
  failedSuites: number
  skippedAny: number
  todoAny: number
  nestedPlanMismatches: string[]
}

function isTapStructural(line: string): boolean {
  if (/^TAP version 13\s*$/.test(line)) return true
  if (/^\s*Bail out!/i.test(line)) return true
  if (/^( *)(not )?ok \d+ - /.test(line)) return true
  if (/^( *)1\.\.\d+\s*$/.test(line)) return true
  if (/^# (tests|pass|fail|cancelled|skipped|todo) \d+\s*$/.test(line)) return true
  return false
}

export function parseNodeTestTap(tap: string): TapEval {
  const lines = tap.split(/\r?\n/)
  const leaves: TapLeaf[] = []
  const rootPlans: number[] = []
  const summaryHits: Record<string, number> = {}
  const counts: TapCounts = {}
  const duplicatePointNumbers: string[] = []
  const nestedPlanMismatches: string[] = []
  const openNumbers = new Map<number, number[]>()
  let headers = 0
  let topLevelPoints = 0
  let bailout = false
  let unclosedYaml = false
  let failedSuites = 0
  let skippedAny = 0
  let todoAny = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (/^TAP version 13\s*$/.test(line)) headers += 1
    if (/^\s*Bail out!/i.test(line)) bailout = true
    const planMatch = line.match(/^( *)1\.\.(\d+)\s*$/)
    if (planMatch) {
      const indent = planMatch[1]!.length
      const planned = Number(planMatch[2])
      if (indent === 0) rootPlans.push(planned)
      const seen = openNumbers.get(indent) ?? []
      const unique = new Set(seen)
      if (unique.size !== seen.length) {
        duplicatePointNumbers.push(`indent ${indent}`)
      }
      if (seen.length !== planned) {
        nestedPlanMismatches.push(`indent ${indent}: ${seen.length} points vs plan ${planned}`)
      }
      openNumbers.set(indent, [])
      for (const deeper of [...openNumbers.keys()]) {
        if (deeper > indent) openNumbers.set(deeper, [])
      }
    }
    const summary = line.match(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/)
    if (summary) {
      const key = summary[1] as (typeof SUMMARY_KEYS)[number]
      summaryHits[key] = (summaryHits[key] ?? 0) + 1
      counts[key] = Number(summary[2])
      continue
    }
    const point = line.match(/^( *)(not )?ok (\d+) - (.*)$/)
    if (!point) continue
    const indent = point[1]!.length
    const num = Number(point[3])
    if (indent === 0) topLevelPoints += 1
    const rest = point[4]!.trimEnd()
    let skip = /(?:^|\s)#\s*SKIP\b/i.test(rest)
    let todo = /(?:^|\s)#\s*TODO\b/i.test(rest)
    const name = rest.replace(/\s+#\s*(SKIP|TODO)\b.*$/i, '').trim()
    let type = ''
    if (lines[i + 1]?.trim() === '---') {
      let j = i + 2
      let closed = false
      while (j < lines.length) {
        const yaml = lines[j]!
        if (yaml.trim() === '...') {
          closed = true
          break
        }
        if (isTapStructural(yaml)) {
          unclosedYaml = true
          break
        }
        const typeMatch = yaml.match(/^\s*type:\s*'([^']+)'/)
        if (typeMatch) type = typeMatch[1]!
        if (/^\s*skip:\s*true\b/.test(yaml)) skip = true
        if (/^\s*todo:\s*true\b/.test(yaml)) todo = true
        j += 1
      }
      if (!closed && i + 2 >= lines.length) unclosedYaml = true
      if (!closed && j >= lines.length) unclosedYaml = true
    }
    const ok = !point[2]
    if (skip) skippedAny += 1
    if (todo) todoAny += 1
    const bucket = openNumbers.get(indent) ?? []
    if (bucket.includes(num)) duplicatePointNumbers.push(`indent ${indent} #${num}`)
    bucket.push(num)
    openNumbers.set(indent, bucket)
    if (type === 'suite') {
      if (!ok || skip || todo) failedSuites += 1
      continue
    }
    leaves.push({ name, ok, skip, todo })
  }
  return {
    leaves,
    counts,
    headers,
    rootPlans,
    topLevelPoints,
    summaryHits,
    bailout,
    unclosedYaml,
    duplicatePointNumbers,
    failedSuites,
    skippedAny,
    todoAny,
    nestedPlanMismatches,
  }
}

export function evaluateHeartbeatTap(
  tap: string,
  child: { code: number | null; signal: NodeJS.Signals | null },
  expectedNames: readonly string[] = CRON_EXECUTION_HEARTBEAT_LEAVES,
): { expected: Record<string, unknown>; actual: Record<string, unknown> } {
  if (child.signal) {
    throw new Error(
      `[cron-submit-boundary] behavior child signal=${child.signal} (not a product assertion)`,
    )
  }
  const parsed = parseNodeTestTap(tap)
  const names = parsed.leaves.map((l) => l.name)
  const unique = new Set(names)
  const expectedSet = new Set(expectedNames)
  const missing = expectedNames.filter((n) => !unique.has(n))
  const unexpected = [...unique].filter((n) => !expectedSet.has(n))
  const duplicates = [...unique].filter((n) => names.filter((x) => x === n).length > 1)
  const skippedLeaves = parsed.leaves.filter((l) => l.skip).length
  const todoLeaves = parsed.leaves.filter((l) => l.todo).length
  const failedLeaves = parsed.leaves.filter((l) => !l.ok).length
  const rootPlan = parsed.rootPlans[0]
  const expected = {
    headers: 1,
    rootPlans: 1,
    topLevelPointsMatchPlan: true,
    bailout: false,
    duplicateSummary: false,
    leafCount: expectedNames.length,
    uniqueLeafCount: expectedNames.length,
    fail: 0,
    skipped: 0,
    todo: 0,
    cancelled: 0,
    missing: [] as string[],
    unexpected: [] as string[],
    duplicates: [] as string[],
    exit: 0,
    signal: null as string | null,
  }
  const actual = {
    headers: parsed.headers,
    rootPlans: parsed.rootPlans.length,
    rootPlan,
    topLevelPoints: parsed.topLevelPoints,
    bailout: parsed.bailout,
    unclosedYaml: parsed.unclosedYaml,
    duplicatePointNumbers: parsed.duplicatePointNumbers,
    failedSuites: parsed.failedSuites,
    skippedAny: parsed.skippedAny,
    todoAny: parsed.todoAny,
    nestedPlanMismatches: parsed.nestedPlanMismatches,
    summaryHits: parsed.summaryHits,
    leafCount: parsed.leaves.length,
    uniqueLeafCount: unique.size,
    fail: parsed.counts.fail ?? failedLeaves,
    skipped: parsed.counts.skipped ?? skippedLeaves,
    todo: parsed.counts.todo ?? todoLeaves,
    cancelled: parsed.counts.cancelled ?? 0,
    missing,
    unexpected,
    duplicates,
    exit: child.code,
    signal: child.signal,
    names,
    counts: parsed.counts,
  }
  const problems: string[] = []
  if (parsed.headers !== 1) problems.push(`header count ${parsed.headers}`)
  if (parsed.rootPlans.length !== 1) problems.push(`root plan count ${parsed.rootPlans.length}`)
  if (parsed.rootPlans.length === 1 && parsed.topLevelPoints !== rootPlan) {
    problems.push(`root plan ${rootPlan} != top-level points ${parsed.topLevelPoints}`)
  }
  if (parsed.bailout) problems.push('bailout')
  if (parsed.unclosedYaml) problems.push('unclosed yaml')
  if (parsed.duplicatePointNumbers.length) {
    problems.push(`duplicate point numbers ${parsed.duplicatePointNumbers.join(',')}`)
  }
  if (parsed.failedSuites) problems.push(`failed suites ${parsed.failedSuites}`)
  if (parsed.skippedAny) problems.push(`skip/todo directive on ${parsed.skippedAny} result(s)`)
  if (parsed.todoAny) problems.push(`todo directive on ${parsed.todoAny} result(s)`)
  if (parsed.nestedPlanMismatches.length) {
    problems.push(`plan mismatch ${parsed.nestedPlanMismatches.join(';')}`)
  }
  for (const key of SUMMARY_KEYS) {
    const hits = parsed.summaryHits[key] ?? 0
    if (hits === 0) problems.push(`missing summary # ${key}`)
    if (hits > 1) problems.push(`duplicate summary # ${key} x${hits}`)
  }
  if (child.code !== 0) problems.push(`exit=${child.code}`)
  if (actual.leafCount !== expected.leafCount) problems.push(`leafCount ${actual.leafCount}`)
  if (actual.uniqueLeafCount !== expected.uniqueLeafCount) {
    problems.push(`uniqueLeafCount ${actual.uniqueLeafCount}`)
  }
  if (missing.length) problems.push(`missing=${JSON.stringify(missing)}`)
  if (unexpected.length) problems.push(`unexpected=${JSON.stringify(unexpected)}`)
  if (duplicates.length) problems.push(`duplicates=${JSON.stringify(duplicates)}`)
  if (actual.fail !== 0) problems.push(`fail=${actual.fail}`)
  if (actual.skipped !== 0) problems.push(`skipped=${actual.skipped}`)
  if (actual.todo !== 0) problems.push(`todo=${actual.todo}`)
  if (actual.cancelled !== 0) problems.push(`cancelled=${actual.cancelled}`)
  if (skippedLeaves !== 0) problems.push(`leafSkip=${skippedLeaves}`)
  if (todoLeaves !== 0) problems.push(`leafTodo=${todoLeaves}`)
  if (failedLeaves !== 0) problems.push(`leafFail=${failedLeaves}`)
  if (parsed.counts.tests !== expectedNames.length) problems.push(`# tests ${parsed.counts.tests}`)
  if (parsed.counts.pass !== expectedNames.length) problems.push(`# pass ${parsed.counts.pass}`)
  if (
    parsed.counts.tests !== undefined &&
    parsed.counts.pass !== undefined &&
    parsed.counts.fail !== undefined &&
    parsed.counts.cancelled !== undefined &&
    parsed.counts.skipped !== undefined &&
    parsed.counts.todo !== undefined &&
    parsed.counts.tests !==
      parsed.counts.pass +
        parsed.counts.fail +
        parsed.counts.cancelled +
        parsed.counts.skipped +
        parsed.counts.todo
  ) {
    problems.push('summary counts contradict each other')
  }
  if (parsed.leaves.length !== (parsed.counts.tests ?? -1)) {
    problems.push('leaf rows contradict # tests')
  }
  if (problems.length) {
    throw new Error(`[cron-submit-boundary] behavior TAP rejected: ${problems.join('; ')}`)
  }
  return { expected, actual }
}

export function verifyPinnedWorkspace(tree: string): { loader: string; sqlite: string } {
  const treeReal = realpathSync(tree)
  for (const name of WORKSPACE_PACKAGES) {
    const linked = realpathSync(join(tree, 'node_modules/@openclaude', name))
    const pkg = realpathSync(join(tree, 'packages', name))
    if (linked !== pkg) {
      throw new Error(
        `[cron-submit-boundary] @openclaude/${name} escaped pinned tree: ${linked} != ${pkg}`,
      )
    }
    if (!linked.startsWith(`${treeReal}/`) && linked !== treeReal) {
      throw new Error(`[cron-submit-boundary] @openclaude/${name} is outside candidate root`)
    }
  }
  const loader = join(tree, 'node_modules/tsx/dist/loader.mjs')
  if (!existsSync(loader)) {
    throw new Error(`[cron-submit-boundary] tsx loader missing: ${loader}`)
  }
  try {
    const req = createRequire(join(tree, 'packages/gateway/package.json'))
    const sqlite = realpathSync(req.resolve('better-sqlite3'))
    return { loader: realpathSync(loader), sqlite }
  } catch (err) {
    throw new Error(
      `[cron-submit-boundary] better-sqlite3 unreadable under ${process.execPath} ${process.version}: ${
        (err as Error).message
      }`,
    )
  }
}

function sourceIdentity(tree: string, testFile: string): string {
  try {
    const manifest = JSON.parse(readFileSync(join(tree, 'flavor.manifest.json'), 'utf8')) as {
      sourceCommit?: string
    }
    if (manifest.sourceCommit && /^[0-9a-f]{40}$/.test(manifest.sourceCommit)) {
      return manifest.sourceCommit
    }
  } catch {
    // archive without flavor.manifest.json
  }
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: tree,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    if (/^[0-9a-f]{40}$/.test(sha)) return sha
  } catch {
    // archive without .git
  }
  const cron = readFileSync(join(tree, 'packages/gateway/src/cron.ts'))
  const test = readFileSync(testFile)
  return `ungitted-${createHash('sha256').update(cron).update(test).digest('hex')}`
}

function fileSha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function behaviorEnv(home: string, tmp: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    OPENCLAUDE_HOME: home,
    TMPDIR: tmp,
    NO_COLOR: '1',
    ...extra,
  }
  if (process.env.LANG) env.LANG = process.env.LANG
  if (process.env.LC_ALL) env.LC_ALL = process.env.LC_ALL
  if (process.env.TZ) env.TZ = process.env.TZ
  return env
}

export function pidsInGroup(pgid: number): Array<{ pid: number; state: string; ppid: number }> {
  const found: Array<{ pid: number; state: string; ppid: number }> = []
  let names: string[] = []
  try {
    names = readdirSync('/proc')
  } catch {
    return found
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8')
      const close = stat.lastIndexOf(')')
      const rest = stat.slice(close + 2).split(' ')
      const state = rest[0] ?? '?'
      const ppid = Number(rest[1])
      const pgrp = Number(rest[2])
      if (pgrp === pgid) found.push({ pid: Number(name), state, ppid })
    } catch {
      // exited between readdir and read
    }
  }
  return found
}

function killGroup(pgid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pgid, sig)
  } catch {
    // already gone
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function drainGroup(
  pgid: number,
  ms: number,
): Promise<Array<{ pid: number; state: string; ppid: number }>> {
  const start = Date.now()
  for (;;) {
    const live = pidsInGroup(pgid)
    if (live.length === 0) return []
    if (Date.now() - start >= ms) return live
    await sleep(50)
  }
}

export async function stopProcessGroup(pgid: number): Promise<void> {
  killGroup(pgid, 'SIGTERM')
  let live = await drainGroup(pgid, DRAIN_MS)
  if (live.length) {
    killGroup(pgid, 'SIGKILL')
    live = await drainGroup(pgid, DRAIN_MS)
  }
  if (live.length) {
    throw new Error(
      `[cron-submit-boundary] process group ${pgid} still live: ${live.map((p) => `${p.pid}:${p.state}`).join(',')}`,
    )
  }
}

export type SuperviseResult = {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  pgid: number
  home: string
  tmp: string
}

export async function superviseNodeTest(opts: {
  tree: string
  loader: string
  testFile: string
  home: string
  tmp: string
  timeoutMs: number
  extraEnv?: NodeJS.ProcessEnv
  onSpawn?: (child: ChildProcess, pgid: number) => void
}): Promise<SuperviseResult> {
  const args = [
    '--import',
    pathToFileURL(opts.loader).href,
    '--test',
    '--test-concurrency=1',
    opts.testFile,
  ]
  const child = spawn(process.execPath, args, {
    cwd: opts.tree,
    env: behaviorEnv(opts.home, opts.tmp, opts.extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  const pgid = child.pid
  if (!pgid) throw new Error('[cron-submit-boundary] child pid missing')
  opts.onSpawn?.(child, pgid)
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    void stopProcessGroup(pgid).catch(() => {
      // drain error surfaces after close
    })
  }, opts.timeoutMs)
  const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    },
  ).finally(() => clearTimeout(timer))
  await drainGroup(pgid, DRAIN_MS)
  if (timedOut) {
    await stopProcessGroup(pgid)
  } else if (pidsInGroup(pgid).length) {
    await stopProcessGroup(pgid)
  }
  if (pidsInGroup(pgid).length) {
    throw new Error(
      `[cron-submit-boundary] process group ${pgid} still live after drain: ${pidsInGroup(pgid)
        .map((p) => `${p.pid}:${p.state}`)
        .join(',')}`,
    )
  }
  rmSync(opts.home, { recursive: true, force: true })
  rmSync(opts.tmp, { recursive: true, force: true })
  return { ...closed, stdout, stderr, timedOut, pgid, home: opts.home, tmp: opts.tmp }
}

async function runOfficialBehavior(tree: string): Promise<void> {
  if (process.env.OC_CRON_SUBMIT_BOUNDARY_BEHAVIOR_TEST) {
    throw new Error(
      '[cron-submit-boundary] official CLI refuses OC_CRON_SUBMIT_BOUNDARY_BEHAVIOR_TEST; parser/supervisor tests must call helpers',
    )
  }
  const testFile = join(tree, 'packages/gateway/src/__tests__/cronExecutionHeartbeat.test.ts')
  if (!existsSync(testFile)) {
    throw new Error(`[cron-submit-boundary] behavior test missing: ${testFile}`)
  }
  const pinned = verifyPinnedWorkspace(tree)
  const identity = sourceIdentity(tree, testFile)
  const timeoutMs = Number(
    process.env.OC_CRON_SUBMIT_BOUNDARY_BEHAVIOR_TIMEOUT_MS || DEFAULT_TIMEOUT_MS,
  )
  const cronPath = join(tree, 'packages/gateway/src/cron.ts')
  const home = mkdtempSync(join(tmpdir(), 'oc-cron-boundary-home-'))
  const tmp = mkdtempSync(join(tmpdir(), 'oc-cron-boundary-tmp-'))
  let pgid: number | undefined
  let interrupt: NodeJS.Signals | null = null
  const requestStop = (sig: NodeJS.Signals) => {
    interrupt = sig
    if (pgid) {
      void stopProcessGroup(pgid).catch(() => {
        // drain finishes in the main supervise/finally path
      })
    }
  }
  const onTerm = () => requestStop('SIGTERM')
  const onInt = () => requestStop('SIGINT')
  process.on('SIGTERM', onTerm)
  process.on('SIGINT', onInt)
  try {
    console.log(
      JSON.stringify({
        contractId: 'C-cron-submit-boundary-behavior-start',
        source: identity,
        node: process.version,
        modules: process.versions.modules,
        execPath: process.execPath,
        root: tree,
        testFile,
        testSha256: fileSha(testFile),
        cronSha256: existsSync(cronPath) ? fileSha(cronPath) : null,
        loader: pinned.loader,
        sqlite: pinned.sqlite,
      }),
    )
    const child = await superviseNodeTest({
      tree,
      loader: pinned.loader,
      testFile,
      home,
      tmp,
      timeoutMs,
      onSpawn: (_proc, group) => {
        pgid = group
      },
    })
    process.stderr.write(child.stderr)
    process.stdout.write(child.stdout)
    if (interrupt) {
      console.error(`[cron-submit-boundary] behavior interrupted by ${interrupt}`)
      process.exitCode = 1
      return
    }
    if (child.timedOut) {
      throw new Error(
        `[cron-submit-boundary] behavior timeout after ${timeoutMs}ms signal=${child.signal} code=${child.code}`,
      )
    }
    const verdict = evaluateHeartbeatTap(`${child.stdout}\n${child.stderr}`, {
      code: child.code,
      signal: child.signal,
    })
    if (interrupt) {
      console.error(`[cron-submit-boundary] behavior interrupted by ${interrupt}`)
      process.exitCode = 1
      return
    }
    console.log(
      JSON.stringify({
        contractId: 'C-cron-submit-boundary-behavior',
        source: identity,
        node: process.version,
        execPath: process.execPath,
        testFile,
        expected: verdict.expected,
        actual: {
          leafCount: verdict.actual.leafCount,
          uniqueLeafCount: verdict.actual.uniqueLeafCount,
          fail: verdict.actual.fail,
          skipped: verdict.actual.skipped,
          todo: verdict.actual.todo,
          cancelled: verdict.actual.cancelled,
          missing: verdict.actual.missing,
          unexpected: verdict.actual.unexpected,
          duplicates: verdict.actual.duplicates,
          exit: verdict.actual.exit,
          signal: verdict.actual.signal,
          names: verdict.actual.names,
          counts: verdict.actual.counts,
          rootPlan: verdict.actual.rootPlan,
          topLevelPoints: verdict.actual.topLevelPoints,
          headers: verdict.actual.headers,
        },
      }),
    )
    console.log(
      '[cron-submit-boundary] PASS — unknown submit-start durability failures are terminal and never auto-replayed',
    )
  } finally {
    process.off('SIGTERM', onTerm)
    process.off('SIGINT', onInt)
    if (pgid) {
      try {
        await stopProcessGroup(pgid)
      } catch {
        // already drained
      }
    }
    if (existsSync(home)) rmSync(home, { recursive: true, force: true })
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true })
  }
}

export async function runOfficialCli(tree = process.cwd()): Promise<void> {
  const sourcePath =
    process.env.OC_CRON_SUBMIT_BOUNDARY_SOURCE || join(tree, 'packages/gateway/src/cron.ts')
  assertCronSubmitBoundarySource(readFileSync(sourcePath, 'utf8'))
  await runOfficialBehavior(tree)
}

const invokedDirectly = (() => {
  const self = fileURLToPath(import.meta.url)
  const arg = process.argv[1]
  if (!arg) return false
  try {
    return realpathSync(arg) === realpathSync(self)
  } catch {
    return resolve(arg) === self || arg.endsWith('check-v5-cron-submit-boundary.ts')
  }
})()

if (invokedDirectly) {
  if (process.env.OC_CRON_SUBMIT_BOUNDARY_BEHAVIOR_TEST) {
    console.error(
      '[cron-submit-boundary] official CLI refuses OC_CRON_SUBMIT_BOUNDARY_BEHAVIOR_TEST; parser/supervisor tests must call helpers',
    )
    process.exitCode = 1
  } else {
    await runOfficialCli()
  }
}
