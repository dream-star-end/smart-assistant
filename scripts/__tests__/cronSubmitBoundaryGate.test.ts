import assert from 'node:assert/strict'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
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

function realShapedTap(opts: { leafType?: boolean } = {}): string {
  const layer1 = CRON_EXECUTION_HEARTBEAT_LEAVES.slice(0, 11)
  const layer2 = CRON_EXECUTION_HEARTBEAT_LEAVES[11]!
  const leafYaml = opts.leafType === false ? '' : `      type: 'test'\n`
  const leafBlock = (n: number, name: string) =>
    `    ok ${n} - ${name}\n      ---\n      duration_ms: 1\n${leafYaml}      ...`
  const suite = (n: number, name: string) =>
    `ok ${n} - ${name}\n  ---\n  duration_ms: 1\n  type: 'suite'\n  ...`
  return [
    'TAP version 13',
    '# Subtest: OCV5-188 Layer 1 — CronScheduler + SQLite + synthetic submit',
    ...layer1.map((name, i) => leafBlock(i + 1, name)),
    '    1..11',
    suite(1, 'OCV5-188 Layer 1 — CronScheduler + SQLite + synthetic submit'),
    '# Subtest: OCV5-188 Layer 2 — real SessionManager.submit + synthetic HangRunner (not model E2E)',
    leafBlock(1, layer2),
    '    1..1',
    suite(2, 'OCV5-188 Layer 2 — real SessionManager.submit + synthetic HangRunner (not model E2E)'),
    '1..2',
    '# tests 12',
    '# pass 12',
    '# fail 0',
    '# cancelled 0',
    '# skipped 0',
    '# todo 0',
    '',
  ].join('\n')
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
      HOME: dir,
      OPENCLAUDE_HOME: dir,
      TMPDIR: dir,
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

test('parser rejects six single-site mutations of real-shaped TAP (C-P2-R1-1)', () => {
  const tap = realShapedTap()
  evaluateHeartbeatTap(tap, { code: 0, signal: null })
  evaluateHeartbeatTap(realShapedTap({ leafType: false }), { code: 0, signal: null })
  const cases: Record<string, string> = {
    leafSkipContradictsSummary: tap.replace(/^(    ok 1 - .*?)$/m, '$1 # SKIP'),
    leafTodoContradictsSummary: tap.replace(/^(    ok 1 - .*?)$/m, '$1 # TODO'),
    failedTopSuiteContradictsSummary: tap.replace(/^ok 1 - /m, 'not ok 1 - '),
    duplicateRootPointNumber: tap.replace(/^ok 2 - /m, 'ok 1 - '),
    nestedBailout: tap.replace(/^(    1\.\.11)$/m, '    Bail out! actual child aborted\n$1'),
    unclosedFinalYaml: tap.replace(/  \.\.\.\n1\.\.2/, '1..2'),
  }
  let accepted = 0
  for (const [name, data] of Object.entries(cases)) {
    assert.notEqual(data, tap, `${name} must mutate`)
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
        contractId: 'C-proof-R1-1-TAP',
        case: name,
        expected: { rejected: true },
        actual: { rejected, error },
      }),
    )
  }
  assert.equal(accepted, 0, 'all six single-site TAP mutations must reject')
})

const OBSERVED_BULK_BYTES = 10_500
const C481_CONTRACT = '"contractId":"C-481-submit"'
const observerFixture = resolve(fixtures, 'observe-official-spawn.mjs')

const PARENT_SIGTERM_ORACLE_PY = `\
import fcntl, json, os, pathlib, signal, subprocess, sys, threading, time
observer, cli, tree = sys.argv[1], sys.argv[2], sys.argv[3]
node = sys.argv[4] if len(sys.argv) > 4 else "/usr/local/bin/node"
tmp = pathlib.Path(os.environ["TMPDIR"])
home = pathlib.Path(os.environ["HOME"])
env = {
    "PATH": os.environ["PATH"],
    "LANG": os.environ.get("LANG", "C.UTF-8"),
    "LC_ALL": os.environ.get("LC_ALL", "C.UTF-8"),
    "TZ": os.environ.get("TZ", "UTC"),
    "HOME": str(home),
    "OPENCLAUDE_HOME": str(home),
    "TMPDIR": str(tmp),
    "NO_COLOR": "1",
}
p = None
observed_pid = 0
try:
    p = subprocess.Popen(
        [node, "--import", observer, "--import", "tsx", cli],
        cwd=tree,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    try:
        if p.stdout:
            fcntl.fcntl(p.stdout.fileno(), fcntl.F_SETPIPE_SZ, 4096)
        if p.stderr:
            fcntl.fcntl(p.stderr.fileno(), fcntl.F_SETPIPE_SZ, 4096)
    except OSError:
        pass
    deadline = time.monotonic() + 45
    observed = b""
    while time.monotonic() < deadline and p.poll() is None:
        marker = tmp / "observer-child.json"
        trace = tmp / "observer-child.stdout"
        if marker.exists():
            try:
                observed_pid = int(json.loads(marker.read_text()).get("pid") or 0)
            except Exception:
                pass
        if trace.exists():
            observed = trace.read_bytes()
        if len(observed) > 10500:
            break
        time.sleep(0.003)
    if len(observed) <= 10500:
        raise SystemExit(
            "precondition: observed --test child did not produce >10500B before signal observedBytes=%d"
            % len(observed)
        )
    if p.poll() is not None:
        raise SystemExit(
            "precondition: official CLI exited before >10500B observed output code=%s"
            % p.returncode
        )
    p.send_signal(signal.SIGTERM)
    out_chunks = []
    err_chunks = []
    def read_out():
        out_chunks.append(p.stdout.read() if p.stdout else b"")
    def read_err():
        err_chunks.append(p.stderr.read() if p.stderr else b"")
    to = threading.Thread(target=read_out)
    te = threading.Thread(target=read_err)
    to.start()
    te.start()
    p.wait(timeout=20)
    to.join(5)
    te.join(5)
    stdout = b"".join(out_chunks)
    stderr = b"".join(err_chunks)
    observed = (tmp / "observer-child.stdout").read_bytes() if (tmp / "observer-child.stdout").exists() else observed
    args = []
    if (tmp / "observer-child.json").exists():
        try:
            args = json.loads((tmp / "observer-child.json").read_text()).get("args") or []
        except Exception:
            args = []
    (tmp / "official.stdout").write_bytes(stdout)
    (tmp / "official.stderr").write_bytes(stderr)
    leftovers = [x.name for x in tmp.glob("oc-cron-boundary-*")] + [
        x.name for x in home.glob("oc-cron-boundary-*")
    ]
    def alive(pid):
        return pid > 0 and (pathlib.Path("/proc") / str(pid)).exists()
    result = {
        "parentPid": p.pid,
        "observedPid": observed_pid,
        "args": args,
        "code": p.returncode,
        "observedBytes": len(observed),
        "officialStdoutBytes": len(stdout),
        "officialStderrBytes": len(stderr),
        "preserved": observed in stdout,
        "hasC481": b'"contractId":"C-481-submit"' in observed,
        "passPrinted": b"[cron-submit-boundary] PASS" in stdout,
        "hasInterrupted": b"interrupted" in stdout or b"interrupted" in stderr,
        "parentAlive": alive(p.pid),
        "observedAlive": alive(observed_pid),
        "leftovers": leftovers,
    }
    print(json.dumps(result), flush=True)
finally:
    for group in [observed_pid, p.pid if p else None]:
        if group:
            try:
                os.killpg(group, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except PermissionError:
                pass
    if p:
        try:
            p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
`

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isolationEnv(iso: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: iso,
    OPENCLAUDE_HOME: iso,
    TMPDIR: iso,
    NO_COLOR: '1',
  }
  if (process.env.LANG) env.LANG = process.env.LANG
  if (process.env.LC_ALL) env.LC_ALL = process.env.LC_ALL
  if (process.env.TZ) env.TZ = process.env.TZ
  return env
}

function livePid(pid: number): boolean {
  if (pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitPidGone(pid: number, ms: number): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (!livePid(pid) && pidsInGroup(pid).length === 0) return true
    await sleep(50)
  }
  return !livePid(pid) && pidsInGroup(pid).length === 0
}

async function reapOwnPid(pid: number, group: boolean, ms = 8_000): Promise<void> {
  if (pid <= 0) return
  const send = (sig: NodeJS.Signals) => {
    try {
      process.kill(group ? -pid : pid, sig)
    } catch {
      // already gone
    }
  }
  if (!livePid(pid) && (!group || pidsInGroup(pid).length === 0)) return
  send('SIGTERM')
  if (await waitPidGone(pid, Math.floor(ms / 2))) return
  send('SIGKILL')
  await waitPidGone(pid, Math.ceil(ms / 2))
}

type SigtermOracle = {
  kind: 'official-04' | 'd9-negative'
  cli: string
  observedAtSignal: Buffer
  officialStdout: Buffer
  officialStderr: Buffer
  closed: { code: number | null; signal: NodeJS.Signals | null }
  observedPid: number
  parentPid: number
  driverPid: number
  args: string[]
  leftovers: string[]
}

async function runOfficialParentSigtermOracle(
  cliPath: string,
  kind: SigtermOracle['kind'],
): Promise<SigtermOracle> {
  assert.equal(existsSync(observerFixture), true, `observer fixture missing: ${observerFixture}`)
  assert.equal(existsSync(cliPath), true, `official CLI missing: ${cliPath}`)
  const iso = mkdtempSync(join(dir, `cli-sig-${kind}-`))
  const driver = join(iso, 'sigterm-oracle.py')
  writeFileSync(driver, PARENT_SIGTERM_ORACLE_PY)
  const child: ChildProcess = spawn(
    'python3',
    [driver, observerFixture, cliPath, root, process.execPath],
    {
      cwd: root,
      env: isolationEnv(iso),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const driverPid = child.pid ?? 0
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk
  })
  try {
    const closed = await Promise.race([
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once('close', (code, signal) => resolve({ code, signal }))
      }),
      sleep(70_000).then(() => {
        throw new Error(`precondition: oracle driver did not exit within 70s stdout=${stdout} stderr=${stderr}`)
      }),
    ])
    if (closed.code !== 0) {
      throw new Error(
        `precondition: oracle driver exited ${closed.code} signal=${closed.signal} stdout=${stdout} stderr=${stderr}`,
      )
    }
    const line = stdout
      .split('\n')
      .map((row) => row.trim())
      .filter(Boolean)
      .at(-1)
    assert.ok(line, `precondition: oracle driver printed no JSON stdout=${stdout} stderr=${stderr}`)
    const payload = JSON.parse(line!) as {
      parentPid: number
      observedPid: number
      args: string[]
      code: number | null
      leftovers: string[]
    }
    const observedAtSignal = existsSync(join(iso, 'observer-child.stdout'))
      ? readFileSync(join(iso, 'observer-child.stdout'))
      : Buffer.alloc(0)
    const officialStdout = existsSync(join(iso, 'official.stdout'))
      ? readFileSync(join(iso, 'official.stdout'))
      : Buffer.alloc(0)
    const officialStderr = existsSync(join(iso, 'official.stderr'))
      ? readFileSync(join(iso, 'official.stderr'))
      : Buffer.alloc(0)
    assert.ok(
      Array.isArray(payload.args) && payload.args.includes('--test'),
      `observer must mirror official --test spawn, args=${JSON.stringify(payload.args)}`,
    )
    assert.match(
      (payload.args || []).join(' '),
      /cronExecutionHeartbeat\.test\.ts/,
      'observer must mirror the fixed business test, not a fixture substitute',
    )
    await reapOwnPid(payload.parentPid, true)
    await reapOwnPid(payload.observedPid, true)
    await reapOwnPid(driverPid, false)
    return {
      kind,
      cli: cliPath,
      observedAtSignal,
      officialStdout,
      officialStderr,
      closed: { code: payload.code, signal: null },
      observedPid: payload.observedPid,
      parentPid: payload.parentPid,
      driverPid,
      args: payload.args || [],
      leftovers: payload.leftovers || [],
    }
  } finally {
    await reapOwnPid(driverPid, false)
    const metaPath = join(iso, 'observer-child.json')
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { pid?: number }
        if (meta.pid) await reapOwnPid(Number(meta.pid), true)
      } catch {
        // ignore malformed observer meta during cleanup
      }
    }
    await waitPidGone(driverPid, 2_000)
    if (existsSync(iso)) rmSync(iso, { recursive: true, force: true })
  }
}

function assertPreservationOracle(result: SigtermOracle): void {
  const observedText = result.observedAtSignal.toString('utf8')
  const officialText = result.officialStdout.toString('utf8')
  const combined = `${officialText}${result.officialStderr.toString('utf8')}`
  const expected = {
    observedHasContractOrBulk: true,
    preserved: true,
    nonzero: true,
    noPass: true,
    parentGone: true,
    observedGroupGone: true,
    behaviorDirsGone: true,
  }
  const actual = {
    observedHasContractOrBulk:
      result.observedAtSignal.length > OBSERVED_BULK_BYTES || observedText.includes(C481_CONTRACT),
    preserved: result.officialStdout.includes(result.observedAtSignal),
    nonzero: result.closed.code !== 0 || Boolean(result.closed.signal),
    noPass: !/\[cron-submit-boundary\] PASS/.test(combined),
    parentGone: !livePid(result.parentPid) && !livePid(result.driverPid),
    observedGroupGone: !livePid(result.observedPid) && pidsInGroup(result.observedPid).length === 0,
    behaviorDirsGone: result.leftovers.length === 0,
  }
  console.log(
    JSON.stringify({
      contractId: 'C-proof-parent-sigterm-preserve',
      kind: result.kind,
      expected,
      actual: {
        ...actual,
        code: result.closed.code,
        signal: result.closed.signal,
        observedBytes: result.observedAtSignal.length,
        officialStdoutBytes: result.officialStdout.length,
        officialStderrBytes: result.officialStderr.length,
        hasTapHeaderOnly:
          result.observedAtSignal.length <= 15 && observedText.includes('TAP version 13'),
        hasC481: observedText.includes(C481_CONTRACT),
        hasInterrupted: combined.includes('interrupted'),
        observedHead: observedText.slice(0, 120),
        officialHead: officialText.slice(0, 120),
      },
    }),
  )
  assert.equal(
    actual.observedHasContractOrBulk,
    true,
    `oracle requires >${OBSERVED_BULK_BYTES}B observed child output or C-481-submit, not TAP header/interrupted`,
  )
  assert.equal(
    result.observedAtSignal.length > OBSERVED_BULK_BYTES,
    true,
    `oracle requires the original >${OBSERVED_BULK_BYTES}B loss window, not a 15B TAP header`,
  )
  assert.equal(
    actual.preserved,
    true,
    `C-T1 preservation oracle: observed ${result.observedAtSignal.length}B not present in official stdout ${result.officialStdout.length}B (proof-diagnostic, not cron product)`,
  )
  assert.deepEqual(actual, expected)
}

test('official CLI parent SIGTERM preserves observed child output (C-T1)', {
  timeout: 90_000,
}, async () => {
  const result = await runOfficialParentSigtermOracle(gate, 'official-04')
  assertPreservationOracle(result)
})

if (process.env.OCV5_188_C_D9_SIGNAL_CLI) {
  test('d9 same-oracle parent SIGTERM preserves observed child output (proof-diagnostic negative)', {
    timeout: 90_000,
  }, async () => {
    const cli = resolve(process.env.OCV5_188_C_D9_SIGNAL_CLI as string)
    assert.equal(existsSync(cli), true, `d9 CLI missing: ${cli}`)
    assert.notEqual(cli, gate, 'd9 negative must not point at the frozen 04 runner')
    const result = await runOfficialParentSigtermOracle(cli, 'd9-negative')
    assertPreservationOracle(result)
  })
}

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
