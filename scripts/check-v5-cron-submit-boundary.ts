import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

/** Frozen default C leaves: Layer1 11 + Layer2 1. Env-gated cleanup red is not a publish target. */
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

const DEFAULT_BEHAVIOR_TEST = join(
  root,
  'packages/gateway/src/__tests__/cronExecutionHeartbeat.test.ts',
)
const WORKSPACE_PACKAGES = ['gateway', 'storage', 'protocol'] as const
const DEFAULT_TIMEOUT_MS = 120_000
const CLEANUP_MS = 8_000

type TapLeaf = { name: string; ok: boolean; skip: boolean; todo: boolean }
type TapCounts = {
  tests?: number
  pass?: number
  fail?: number
  cancelled?: number
  skipped?: number
  todo?: number
}

export type TapEval = {
  leaves: TapLeaf[]
  counts: TapCounts
  plan?: number
}

export function parseNodeTestTap(tap: string): TapEval {
  const lines = tap.split(/\r?\n/)
  const leaves: TapLeaf[] = []
  let plan: number | undefined
  const counts: TapCounts = {}
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const planMatch = line.match(/^(\s*)1\.\.(\d+)\s*$/)
    if (planMatch && planMatch[1] === '') plan = Number(planMatch[2])
    const summary = line.match(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/)
    if (summary) {
      const key = summary[1] as keyof TapCounts
      counts[key] = Number(summary[2])
      continue
    }
    const point = line.match(/^( *)(not )?ok (\d+) - (.*)$/)
    if (!point) continue
    const rest = point[4]!.trimEnd()
    let skip = /\b#\s*SKIP\b/i.test(rest)
    let todo = /\b#\s*TODO\b/i.test(rest)
    const name = rest.replace(/\s+#\s*(SKIP|TODO)\b.*$/i, '').trim()
    let type = ''
    let j = i + 1
    if (lines[j]?.trim() === '---') {
      j += 1
      while (j < lines.length && lines[j]!.trim() !== '...') {
        const yaml = lines[j]!
        const typeMatch = yaml.match(/^\s*type:\s*'([^']+)'/)
        if (typeMatch) type = typeMatch[1]!
        if (/^\s*skip:\s*true\b/.test(yaml)) skip = true
        if (/^\s*todo:\s*true\b/.test(yaml)) todo = true
        j += 1
      }
    }
    if (type === 'suite') continue
    leaves.push({ name, ok: !point[2], skip, todo })
  }
  return { leaves, counts, plan }
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
  const expected = {
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
    plan: parsed.plan,
  }
  const problems: string[] = []
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
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'] as const) {
    if (parsed.counts[key] === undefined) problems.push(`missing summary # ${key}`)
  }
  if (parsed.counts.tests !== expectedNames.length) {
    problems.push(`# tests ${parsed.counts.tests}`)
  }
  if (parsed.counts.pass !== expectedNames.length) {
    problems.push(`# pass ${parsed.counts.pass}`)
  }
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

function sourceIdentity(tree: string): string {
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
  const testFile = readFileSync(DEFAULT_BEHAVIOR_TEST)
  return `ungitted-${createHash('sha256').update(cron).update(testFile).digest('hex')}`
}

function fileSha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function verifyPinnedWorkspace(tree: string): { loader: string; sqlite: string } {
  const treeReal = realpathSync(tree)
  for (const name of WORKSPACE_PACKAGES) {
    const linked = realpathSync(join(tree, 'node_modules/@openclaude', name))
    const pkg = realpathSync(join(tree, 'packages', name))
    if (linked !== pkg) {
      throw new Error(
        `[cron-submit-boundary] @openclaude/${name} escaped pinned tree: ${linked} != ${pkg}`,
      )
    }
    if (linked !== pkg && !linked.startsWith(`${treeReal}/`)) {
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

function behaviorEnv(home: string, tmp: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    OPENCLAUDE_HOME: home,
    TMPDIR: tmp,
    NO_COLOR: '1',
  }
  if (process.env.LANG) env.LANG = process.env.LANG
  if (process.env.LC_ALL) env.LC_ALL = process.env.LC_ALL
  if (process.env.TZ) env.TZ = process.env.TZ
  return env
}

function boundedCleanup(work: () => void): void {
  const timer = setTimeout(() => {
    console.error('[cron-submit-boundary] CLEANUP_TIMEOUT')
    process.exit(1)
  }, CLEANUP_MS)
  try {
    work()
  } finally {
    clearTimeout(timer)
  }
}

function killChild(child: ChildProcess | undefined): void {
  if (!child || child.exitCode !== null || child.signalCode) return
  try {
    child.kill('SIGKILL')
  } catch {
    // already gone
  }
}

async function runNodeTest(opts: {
  tree: string
  loader: string
  testFile: string
  home: string
  tmp: string
  timeoutMs: number
  onSpawn?: (child: ChildProcess) => void
}): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const args = [
    '--import',
    pathToFileURL(opts.loader).href,
    '--test',
    '--test-concurrency=1',
    opts.testFile,
  ]
  const child = spawn(process.execPath, args, {
    cwd: opts.tree,
    env: behaviorEnv(opts.home, opts.tmp),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  opts.onSpawn?.(child)
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
    killChild(child)
  }, opts.timeoutMs)
  const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    },
  ).finally(() => clearTimeout(timer))
  if (timedOut) {
    throw new Error(
      `[cron-submit-boundary] behavior timeout after ${opts.timeoutMs}ms signal=${closed.signal} code=${closed.code}`,
    )
  }
  return { ...closed, stdout, stderr }
}

async function runBehavior(): Promise<void> {
  if (process.env.OC_CRON_SUBMIT_BOUNDARY_SOURCE) {
    console.log(
      '[cron-submit-boundary] OC_CRON_SUBMIT_BOUNDARY_SOURCE is static-read only; behavior leaves were not executed',
    )
    return
  }
  const tree = root
  const testOverride = process.env.OC_CRON_SUBMIT_BOUNDARY_BEHAVIOR_TEST
  const testFile = testOverride
    ? isAbsolute(testOverride)
      ? testOverride
      : resolve(tree, testOverride)
    : DEFAULT_BEHAVIOR_TEST
  const identity = sourceIdentity(tree)
  const timeoutMs = Number(
    process.env.OC_CRON_SUBMIT_BOUNDARY_BEHAVIOR_TIMEOUT_MS || DEFAULT_TIMEOUT_MS,
  )
  if (testFile.endsWith('.tap')) {
    if (!existsSync(testFile)) {
      throw new Error(`[cron-submit-boundary] TAP file missing: ${testFile}`)
    }
    const tap = readFileSync(testFile, 'utf8')
    const verdict = evaluateHeartbeatTap(tap, { code: 0, signal: null })
    console.log(
      JSON.stringify({
        contractId: 'C-cron-submit-boundary-behavior',
        source: identity,
        node: process.version,
        execPath: process.execPath,
        testFile,
        expected: verdict.expected,
        actual: verdict.actual,
      }),
    )
    return
  }
  if (!existsSync(testFile)) {
    throw new Error(`[cron-submit-boundary] behavior test missing: ${testFile}`)
  }
  const pinned = verifyPinnedWorkspace(tree)
  const cronPath = join(tree, 'packages/gateway/src/cron.ts')
  const home = mkdtempSync(join(tmpdir(), 'oc-cron-boundary-home-'))
  const tmp = mkdtempSync(join(tmpdir(), 'oc-cron-boundary-tmp-'))
  let running: ChildProcess | undefined
  const stop = (sig: NodeJS.Signals) => {
    killChild(running)
    boundedCleanup(() => {
      rmSync(home, { recursive: true, force: true })
      rmSync(tmp, { recursive: true, force: true })
    })
    console.error(`[cron-submit-boundary] behavior interrupted by ${sig}`)
    process.exit(1)
  }
  process.once('SIGTERM', () => stop('SIGTERM'))
  process.once('SIGINT', () => stop('SIGINT'))
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
    const child = await runNodeTest({
      tree,
      loader: pinned.loader,
      testFile,
      home,
      tmp,
      timeoutMs,
      onSpawn: (proc) => {
        running = proc
      },
    })
    process.stderr.write(child.stderr)
    process.stdout.write(child.stdout)
    const verdict = evaluateHeartbeatTap(`${child.stdout}\n${child.stderr}`, {
      code: child.code,
      signal: child.signal,
    })
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
        },
      }),
    )
  } finally {
    process.removeAllListeners('SIGTERM')
    process.removeAllListeners('SIGINT')
    boundedCleanup(() => {
      rmSync(home, { recursive: true, force: true })
      rmSync(tmp, { recursive: true, force: true })
    })
  }
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
  await runBehavior()
}
