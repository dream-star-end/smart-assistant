/**
 * INC-20261005-BOX-CC-FOLLOWUP-TURN
 *
 * The box-resident Claude (`box-claude-*`) runs with the official-cc harness
 * and no `authorityEngine`, so the runner took it for the engine=ccb proxy
 * lane: every turn carries a new lease, the spawn-env fingerprint changed, and
 * the runner shut the process down before each follow-up turn. The bridge was
 * then SIGKILLed and the new turn ended as `子进程被信号 SIGKILL 终止`.
 *
 * Contract under test: a follow-up turn, and a lease renewal in between, are
 * written to the same box process.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/subprocessRunnerBoxCcTurnReuse.test.ts
 */
import * as assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import { SubprocessRunner, _officialCcProxyLane } from '../subprocessRunner.js'

const DESCRIPTOR = {
  canonicalModel: 'box-claude-haiku-4-5',
  contextWindow: 200_000,
  capabilityZero: true,
  supportsThinking: true,
  supportsVision: true,
  supportedEfforts: [],
} as const

class FakeStream extends EventEmitter {
  ended = false
  writable = true
  lines: string[] = []
  setEncoding(): this { return this }
  end(): void { this.ended = true }
  write(chunk: string, cb?: (err?: Error | null) => void): boolean {
    this.lines.push(chunk)
    cb?.(null)
    return true
  }
  destroy(): void {}
}

class FakeProc extends EventEmitter {
  pid = 4242
  exitCode: number | null = null
  signalCode: string | null = null
  stdin = new FakeStream()
  stdout = new FakeStream()
  stderr = new FakeStream()
  kill(): boolean { return true }
}

function authority(lease: string) {
  return {
    authorityEnvelope: `AUTH-${lease}`,
    leaseEnvelope: lease,
    executionDescriptor: DESCRIPTOR,
  } as never
}

describe('box-resident Claude keeps its process across turns', () => {
  it('is not the engine=ccb official-cc proxy lane', () => {
    assert.equal(_officialCcProxyLane({ harness: 'official-cc', authorityEngine: undefined, boxResidentCc: true }), false)
    assert.equal(_officialCcProxyLane({ harness: 'official-cc', authorityEngine: undefined, boxResidentCc: false }), true)
    assert.equal(_officialCcProxyLane({ harness: 'official-cc', authorityEngine: 'ccb', boxResidentCc: false }), true)
    assert.equal(_officialCcProxyLane({ harness: 'official-cc', authorityEngine: 'cursor', boxResidentCc: false }), false)
    assert.equal(_officialCcProxyLane({ harness: 'ccb', authorityEngine: 'ccb', boxResidentCc: false }), false)
  })

  it('a second turn with a new lease goes to the same process', async () => {
    const prevGrace = process.env.OPENCLAUDE_RUNNER_SHUTDOWN_GRACE_MS
    const prevDrain = process.env.OPENCLAUDE_RUNNER_SHUTDOWN_FINAL_DRAIN_MS
    // Only matters when the runner wrongly recycles: keep that path short and
    // keep its process-group kill away from real pids.
    process.env.OPENCLAUDE_RUNNER_SHUTDOWN_GRACE_MS = '20'
    process.env.OPENCLAUDE_RUNNER_SHUTDOWN_FINAL_DRAIN_MS = '20'
    const origKill = process.kill
    ;(process as { kill: unknown }).kill = () => true
    try {
      const runner = new SubprocessRunner({
        sessionKey: 'agent:main:webchat:dm:test',
        agentId: 'main',
        agentBaseDir: '/tmp',
        model: 'box-claude-haiku-4-5',
        config: {} as never,
        harness: 'official-cc',
        boxResidentCc: true,
      } as never)
      const proc = new FakeProc()
      const r = runner as unknown as {
        proc: unknown
        closed: boolean
        spawnedExecutionDescriptor: unknown
        pendingOfficialSpawnEnv: unknown
      }
      r.proc = proc
      r.closed = false
      r.spawnedExecutionDescriptor = DESCRIPTOR
      const submit = (text: string, lease: string): Promise<'ok' | string> =>
        runner.submit(text, undefined, authority(lease), `turn-${lease}`).then(
          () => 'ok' as const,
          (err: unknown) => (err instanceof Error ? err.message : String(err)),
        )

      assert.equal(await submit('first', 'LEASE-1'), 'ok')
      await runner.updateTurnLease('LEASE-1b')
      assert.equal(await submit('second', 'LEASE-2'), 'ok')

      assert.equal(r.proc, proc, 'the follow-up turn must not replace the box process')
      assert.equal(proc.stdin.ended, false, 'the box process must not be shut down between turns')
      assert.equal(r.pendingOfficialSpawnEnv, null, 'box Claude takes no per-turn spawn env')
      const users = proc.stdin.lines.map(
        (line) => JSON.parse(line) as { type: string; message: { content: Array<{ text?: string }> } },
      )
      assert.deepEqual(users.map((u) => u.type), ['user', 'user'])
      assert.deepEqual(users.map((u) => u.message.content[0]?.text), ['first', 'second'])
    } finally {
      ;(process as { kill: unknown }).kill = origKill
      if (prevGrace === undefined) delete process.env.OPENCLAUDE_RUNNER_SHUTDOWN_GRACE_MS
      else process.env.OPENCLAUDE_RUNNER_SHUTDOWN_GRACE_MS = prevGrace
      if (prevDrain === undefined) delete process.env.OPENCLAUDE_RUNNER_SHUTDOWN_FINAL_DRAIN_MS
      else process.env.OPENCLAUDE_RUNNER_SHUTDOWN_FINAL_DRAIN_MS = prevDrain
    }
  })
})
