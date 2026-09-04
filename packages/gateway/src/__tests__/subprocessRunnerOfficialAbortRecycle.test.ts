/**
 * INC-20260904-OFFICIAL-CC-STOP-STALE-PROCESS
 *
 * Official Claude Code (`official-cc` harness, Cursor Sand Opus/Fable) answers
 * a cooperative Stop with an `aborted_streaming` result and then exits 1 on its
 * own a few seconds later. Before this fix the runner kept `this.proc` pointing
 * at that dying process, so a user turn submitted inside the window was written
 * into it and terminated as RUNNER_CRASHED (`子进程异常退出 (code 1)`), which
 * master then tried to auto-recover up to ten times.
 *
 * Contract under test:
 *  - the abort result immediately retires the process generation
 *    (`isRunning === false`, `proc` detached) so the next submit() spawns;
 *  - the trailing exit of the retired process is NOT forwarded as a runner
 *    'exit' (no RUNNER_CRASHED for whoever is listening);
 *  - the retired generation's stdout close still settles its own drain barrier
 *    and never touches a newer generation's barrier;
 *  - CCB harness is untouched (same frame does nothing).
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/subprocessRunnerOfficialAbortRecycle.test.ts
 */
import * as assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import { SubprocessRunner, _shutdownOriginFrames } from '../subprocessRunner.js'

class FakeStream extends EventEmitter {
  ended = false
  destroyed = false
  writable = true
  setEncoding(): this {
    return this
  }
  end(): void {
    this.ended = true
  }
  write(_chunk: string, cb?: (err?: Error | null) => void): boolean {
    cb?.(null)
    return true
  }
  destroy(): void {
    this.destroyed = true
  }
}

class FakeProc extends EventEmitter {
  pid = 4242
  exitCode: number | null = null
  signalCode: string | null = null
  stdin = new FakeStream()
  stdout = new FakeStream()
  stderr = new FakeStream()
  killed = false
  kill(): boolean {
    this.killed = true
    return true
  }
}

const ABORT_RESULT = JSON.stringify({
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  terminal_reason: 'aborted_streaming',
  stop_reason: null,
  session_id: 'sess-1',
})

function createRunner(harness: 'ccb' | 'official-cc'): SubprocessRunner {
  return new SubprocessRunner({
    sessionKey: 'agent:main:webchat:dm:test',
    agentId: 'main',
    agentBaseDir: '/tmp',
    config: {} as any,
    harness,
  } as any)
}

/** Install a fake child into a runner by replaying the private wiring that
 * `_startInternal` performs after `spawn()` succeeds. Kept as a thin mirror of
 * the production listener set so the test exercises the real handlers. */
function attachFakeProc(runner: SubprocessRunner, proc: FakeProc): void {
  const r = runner as any
  r.proc = proc
  r.closed = false
  r.officialAbortResultObserved = false
  let resolveThisDrain!: () => void
  r.outputDrainPromise = new Promise<void>((resolve) => {
    resolveThisDrain = resolve
  })
  r.resolveOutputDrain = resolveThisDrain
  proc.stdout.on('data', (chunk: string) => {
    if (r.proc !== proc) return
    r.handleStdout(chunk)
  })
  proc.stdout.once('close', () => {
    resolveThisDrain()
    if (r.resolveOutputDrain === resolveThisDrain) r.resolveOutputDrain = null
  })
  proc.on('exit', (code: number | null, signal: string | null) => {
    if (r.proc !== proc) return
    r.closed = true
    r.emit('exit', { code, signal, crashed: !r.shuttingDown })
    r.proc = null
  })
}

describe('official-cc abort result retires the process generation', () => {
  it('detaches proc, reports not running, and swallows the trailing exit(1)', async () => {
    const runner = createRunner('official-cc')
    const proc = new FakeProc()
    attachFakeProc(runner, proc)
    assert.equal(runner.isRunning, true)

    const exits: unknown[] = []
    runner.on('exit', (info) => exits.push(info))

    proc.stdout.emit('data', `${ABORT_RESULT}\n`)

    assert.equal(runner.isRunning, false, 'generation must be retired immediately')
    assert.equal(proc.stdin.ended, true, 'stdin is closed so the CLI can wind down')

    // The CLI exits 1 on its own a moment later.
    proc.exitCode = 1
    proc.emit('exit', 1, null)
    proc.stdout.emit('close')
    assert.deepEqual(exits, [], 'retired generation exit must not surface as runner exit')
    await runner.waitForOutputDrain()
  })

  it('retired generation stdout close does not settle a newer generation barrier', async () => {
    const runner = createRunner('official-cc')
    const oldProc = new FakeProc()
    attachFakeProc(runner, oldProc)
    oldProc.stdout.emit('data', `${ABORT_RESULT}\n`)
    const oldDrain = runner.waitForOutputDrain()

    // Next submit() spawns a replacement before the old CLI has exited.
    const newProc = new FakeProc()
    newProc.pid = 4343
    attachFakeProc(runner, newProc)
    const newDrain = runner.waitForOutputDrain()
    assert.notEqual(oldDrain, newDrain)

    let newSettled = false
    void newDrain.then(() => {
      newSettled = true
    })

    oldProc.exitCode = 1
    oldProc.emit('exit', 1, null)
    oldProc.stdout.emit('close')
    await oldDrain
    await new Promise((r) => setImmediate(r))
    assert.equal(newSettled, false, 'old close must not resolve the new barrier')
    assert.equal(runner.isRunning, true, 'new generation still owns the runner')

    newProc.stdout.emit('close')
    await newDrain
  })

  it('SIGKILL reaper fires only when the retired CLI never exits', async () => {
    const prevGrace = process.env.OPENCLAUDE_RUNNER_SHUTDOWN_GRACE_MS
    process.env.OPENCLAUDE_RUNNER_SHUTDOWN_GRACE_MS = '20'
    try {
      const runner = createRunner('official-cc')
      const proc = new FakeProc()
      attachFakeProc(runner, proc)
      const kills: string[] = []
      const origKill = process.kill
      ;(process as any).kill = (pid: number, sig: string) => {
        kills.push(`${pid}:${sig}`)
        return true
      }
      try {
        proc.stdout.emit('data', `${ABORT_RESULT}\n`)
        await new Promise((r) => setTimeout(r, 60))
      } finally {
        ;(process as any).kill = origKill
      }
      assert.ok(
        kills.some((k) => k === '-4242:SIGKILL' || k === '4242:SIGKILL'),
        `expected SIGKILL, got ${kills.join(',')}`,
      )
    } finally {
      if (prevGrace === undefined)
        Reflect.deleteProperty(process.env, 'OPENCLAUDE_RUNNER_SHUTDOWN_GRACE_MS')
      else process.env.OPENCLAUDE_RUNNER_SHUTDOWN_GRACE_MS = prevGrace
    }
  })

  it('CCB harness ignores the same frame', () => {
    const runner = createRunner('ccb')
    const proc = new FakeProc()
    attachFakeProc(runner, proc)
    proc.stdout.emit('data', `${ABORT_RESULT}\n`)
    assert.equal(runner.isRunning, true)
    assert.equal(proc.stdin.ended, false)
  })
})

describe('_shutdownOriginFrames', () => {
  it('drops the header and this module, keeps compact caller tokens', () => {
    const stack = [
      'Error',
      '    at SubprocessRunner.shutdown (/opt/x/packages/gateway/src/subprocessRunner.ts:2580:5)',
      '    at CcbAdapter.shutdown (/opt/x/packages/gateway/src/engine/ccbAdapter.ts:626:23)',
      '    at async SessionManager.recyclePeerForRepoChange (/opt/x/packages/gateway/src/sessionManager.ts:2072:11)',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
    ].join('\n')
    assert.deepEqual(_shutdownOriginFrames(stack), [
      'CcbAdapter.shutdown (engine/ccbAdapter.ts:626)',
      'SessionManager.recyclePeerForRepoChange (src/sessionManager.ts:2072)',
      'process.processTicksAndRejections (process/task_queues:95)',
    ])
    assert.deepEqual(_shutdownOriginFrames(undefined), [])
  })
})
