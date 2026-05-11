/**
 * Runner contract parity test — guards against the "sessionManager calls
 * runner.X but one of the codex variants doesn't expose X" class of bugs.
 *
 * History (and reason this test exists):
 *   - 2026-04-26: sessionManager.submit() began calling `runner.setModel()`.
 *     Both CodexRunner and CodexAppServerRunner were missing the method.
 *     Result: every model switch on a codex session threw TypeError → turn
 *     never completed → user stuck on "thinking…". Patched as a no-op opts
 *     mutator on each codex runner.
 *   - 2026-05-11 (v1.0.123 hot bug): the same omission for `setTraceId`
 *     (added in V3 S12e CG8 telemetry) triggered the identical failure mode
 *     on every codex turn. Same pattern, same symptom.
 *
 * Two strikes is enough — this test pins the surface that sessionManager.
 * submit() calls on every runner so a third regression is caught before
 * deploy. Per-runner getter/setter semantics live in their own dedicated
 * tests (subprocessRunnerSetters.test.ts, subprocessRunnerSpawnTraceEnv.
 * test.ts, codexRunnerArgs.test.ts, …); we deliberately keep this file
 * narrow: presence + pure-mutator behaviour + no event side effects.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/runnerContractParity.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CodexAppServerRunner } from '../codexAppServerRunner.js'
import { CodexRunner } from '../codexRunner.js'
import { SubprocessRunner } from '../subprocessRunner.js'

// ── runner contract used by sessionManager.submit() / recyclePeerForRepoChange
// Anything dropped from this shape = TypeError at first submit on the affected
// runner kind. Keeping it as a structural type lets `satisfies` below preserve
// TS-level checking on the RUNNERS array (no `as any` escape hatch). */
interface RunnerContract {
  setTraceId(v: string | undefined): void
  setModel(v: string | undefined): void
  setEffortLevel(v: string | undefined): void
  getBoundRepoBinding(): unknown
  shutdown(): Promise<void>
  readonly traceId: string | undefined
  readonly model: string | undefined
  readonly effortLevel: string | undefined
  on(event: string, listener: (...args: unknown[]) => void): unknown
}

interface FactoryInitial {
  traceId?: string
  model?: string
  effortLevel?: string
}
type RunnerFactory = (initial?: FactoryInitial) => RunnerContract

// ── runner factory helpers (minimal opts; never call start()) ──────────────

function makeSubprocess(initial: FactoryInitial = {}): SubprocessRunner {
  // `config: {} as any` is intentional test-fixture simplification — the
  // contract surface we exercise here doesn't read config; per-field config
  // semantics live in dedicated subprocessRunner*.test.ts files.
  return new SubprocessRunner({
    sessionKey: 'sk',
    agentId: 'a',
    agentBaseDir: '/tmp',
    config: {} as any,
    ...initial,
  })
}

function makeCodex(initial: FactoryInitial = {}): CodexRunner {
  return new CodexRunner({
    sessionKey: 'sk',
    agentId: 'a',
    cwd: '/tmp',
    ...initial,
  })
}

function makeCodexAppServer(initial: FactoryInitial = {}): CodexAppServerRunner {
  return new CodexAppServerRunner({
    sessionKey: 'sk',
    agentId: 'a',
    cwd: '/tmp',
    ...initial,
  })
}

// `satisfies` (instead of explicit `: Array<...>` + `as any` casts) makes the
// TS compiler verify each runner class structurally implements RunnerContract.
// Adding a new sessionManager-side mutator surfaces a compile error here
// before runtime — the harder gate Codex flagged in review.
const RUNNERS = [
  { name: 'SubprocessRunner', make: makeSubprocess },
  { name: 'CodexRunner', make: makeCodex },
  { name: 'CodexAppServerRunner', make: makeCodexAppServer },
] satisfies Array<{ name: string; make: RunnerFactory }>

// ── presence: every runner must expose the sessionManager.submit contract ──

describe('runner contract parity — method presence', () => {
  for (const { name, make } of RUNNERS) {
    it(`${name} exposes setTraceId / setModel / setEffortLevel / getBoundRepoBinding / shutdown as functions`, () => {
      const r = make()
      // sessionManager.submit() L1131 setTraceId, L1140-1142 setEffortLevel/
      // setModel, L1150 shutdown, recyclePeerForRepoChange getBoundRepoBinding.
      // Anything dropped here = TypeError at first submit on that runner kind.
      assert.equal(typeof r.setTraceId, 'function', `${name}.setTraceId missing`)
      assert.equal(typeof r.setModel, 'function', `${name}.setModel missing`)
      assert.equal(typeof r.setEffortLevel, 'function', `${name}.setEffortLevel missing`)
      assert.equal(typeof r.getBoundRepoBinding, 'function', `${name}.getBoundRepoBinding missing`)
      assert.equal(typeof r.shutdown, 'function', `${name}.shutdown missing`)
    })
  }
})

// ── traceId pure-mutator semantics, mirrored across all three runners ──────

describe('runner contract parity — setTraceId pure mutator', () => {
  for (const { name, make } of RUNNERS) {
    it(`${name}: getter returns undefined when not set in constructor`, () => {
      const r = make()
      assert.equal(r.traceId, undefined)
    })

    it(`${name}: getter reflects constructor-supplied traceId`, () => {
      const r = make({ traceId: 'init-trace-id-1234567890ab' })
      assert.equal(r.traceId, 'init-trace-id-1234567890ab')
    })

    it(`${name}: setTraceId mutates and getter reflects the new value`, () => {
      const r = make({ traceId: 'init-trace-id-1234567890ab' })
      r.setTraceId('next-trace-id-fedcba0987654321')
      assert.equal(r.traceId, 'next-trace-id-fedcba0987654321')
    })

    it(`${name}: setTraceId(undefined) clears the trace id`, () => {
      const r = make({ traceId: 'init-trace-id-1234567890ab' })
      r.setTraceId(undefined)
      assert.equal(r.traceId, undefined)
    })

    it(`${name}: setTraceId never throws, including with empty string`, () => {
      const r = make()
      assert.doesNotThrow(() => r.setTraceId('a'))
      assert.doesNotThrow(() => r.setTraceId(''))
      assert.doesNotThrow(() => r.setTraceId(undefined))
    })

    it(`${name}: setTraceId emits no spawn / exit / message / error event`, () => {
      // Every runner promises setTraceId is a side-effect-free opts mutator.
      // If a future change adds auto-respawn on trace change, every listener
      // below would fire and this assertion would surface the regression
      // before it reaches the gateway turn loop.
      const r = make()
      const seen: string[] = []
      for (const ev of ['spawn', 'exit', 'error', 'message', 'telemetry', 'parse_error']) {
        r.on(ev, () => seen.push(ev))
      }
      r.setTraceId('first')
      r.setTraceId('second')
      r.setTraceId(undefined)
      assert.deepEqual(seen, [], `${name}.setTraceId must not emit any event`)
    })
  }
})

// ── model setter parity (the 2026-04-26 lesson — keep it pinned too) ──────

describe('runner contract parity — setModel pure mutator', () => {
  for (const { name, make } of RUNNERS) {
    it(`${name}: setModel mutates and getter reflects the new value`, () => {
      const r = make({ model: 'gpt-5-codex' })
      assert.equal(r.model, 'gpt-5-codex')
      r.setModel('claude-opus-4-7')
      assert.equal(r.model, 'claude-opus-4-7')
    })

    it(`${name}: setModel(undefined) clears the model`, () => {
      const r = make({ model: 'gpt-5-codex' })
      r.setModel(undefined)
      assert.equal(r.model, undefined)
    })
  }
})

// ── effortLevel setter parity ──────────────────────────────────────────────
// sessionManager.submit() reads `runner.effortLevel !== desiredEffort` to
// decide whether to shutdown+respawn for an effort change. If a runner's
// setEffortLevel becomes a no-op (writes nowhere), the inequality stays true
// every turn → repeated shutdown loop. Pin the getter-after-setter contract
// here so a future "we don't really need to track effort on codex" cleanup
// surfaces immediately.

describe('runner contract parity — setEffortLevel pure mutator', () => {
  for (const { name, make } of RUNNERS) {
    it(`${name}: getter reflects constructor-supplied effortLevel`, () => {
      const r = make({ effortLevel: 'medium' })
      assert.equal(r.effortLevel, 'medium')
    })

    it(`${name}: setEffortLevel mutates and getter reflects the new value`, () => {
      const r = make({ effortLevel: 'medium' })
      r.setEffortLevel('xhigh')
      assert.equal(r.effortLevel, 'xhigh')
    })

    it(`${name}: setEffortLevel(undefined) clears the level`, () => {
      const r = make({ effortLevel: 'medium' })
      r.setEffortLevel(undefined)
      assert.equal(r.effortLevel, undefined)
    })
  }
})

// ── getBoundRepoBinding initial state ──────────────────────────────────────

describe('runner contract parity — getBoundRepoBinding initial state', () => {
  for (const { name, make } of RUNNERS) {
    it(`${name}: getBoundRepoBinding returns null on a freshly constructed runner`, () => {
      const r = make()
      assert.equal(r.getBoundRepoBinding(), null)
    })
  }
})

// ── shutdown on a never-started runner ─────────────────────────────────────
// sessionManager.submit() can call `runner.shutdown()` on the effort/model
// change path even when the underlying proc was never started in this lock
// window (e.g. spawned-then-exited between turns). Each runner's shutdown()
// must therefore be idempotent on a fresh / never-spawned instance.
//
// Each test gets its own runner so a hypothetical 'exit' emit from shutdown
// can't leak into the no-event assertion in the setTraceId block above.

describe('runner contract parity — shutdown is safe on a fresh runner', () => {
  for (const { name, make } of RUNNERS) {
    it(`${name}: await shutdown() does not reject on a never-started instance`, async () => {
      const r = make()
      await assert.doesNotReject(() => r.shutdown())
    })
  }
})
