/**
 * V3 S12e CG8 — contract C(best-effort)spawn-time trace env injection tests.
 *
 * Verifies that:
 *   1. The `_buildCcbSpawnTraceEnv` pure helper returns the exact shape the
 *      spawn env block needs(`{ OPENCLAUDE_TRACE_ID: <value> }` with empty
 *      string fallback rather than key omission — see helper JSDoc for the
 *      `process.env` inheritance rationale).
 *   2. `SubprocessRunner.setTraceId` is a pure mutator(no `'spawn'`/`'exit'`
 *      side effect)mirroring the existing `setModel` / `setEffortLevel`
 *      contract.
 *   3. **Structural** assertion: the `backend.spawn({ env: { … } })` call
 *      site in `subprocessRunner.ts` spreads `_buildCcbSpawnTraceEnv(this.opts.
 *      traceId)` exactly once. This pins the wiring — a refactor that drops
 *      the spread silently loses contract C, this test forces it visible.
 *
 * Test 11 from docs/V3_S12e_PLAN_2026-05-11.md §697-698.
 *
 * Run:
 *   npx tsx --test packages/gateway/src/__tests__/subprocessRunnerSpawnTraceEnv.test.ts
 */
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { SubprocessRunner, _buildCcbSpawnTraceEnv } from '../subprocessRunner.js'

// ── _buildCcbSpawnTraceEnv unit tests ──

test('buildCcbSpawnTraceEnv: provided traceId → exact { OPENCLAUDE_TRACE_ID: <value> } shape', () => {
  const env = _buildCcbSpawnTraceEnv('env-test-xxx')
  assert.deepEqual(env, { OPENCLAUDE_TRACE_ID: 'env-test-xxx' })
})

test('buildCcbSpawnTraceEnv: undefined → empty-string fallback(NOT key omission)', () => {
  // Rationale documented in helper JSDoc: env block starts from `...process.env`,
  // so omitting the key would let an inherited `OPENCLAUDE_TRACE_ID` from
  // gateway's own process env leak into CCB. Empty string is the explicit
  // "no trace stash at this spawn" contract.
  const env = _buildCcbSpawnTraceEnv(undefined)
  assert.deepEqual(env, { OPENCLAUDE_TRACE_ID: '' })
  assert.ok('OPENCLAUDE_TRACE_ID' in env, 'key must be present even when value is empty')
})

test('buildCcbSpawnTraceEnv: empty string traceId → preserved as empty string(not normalised)', () => {
  // Edge case: if a caller passes literal '' (rare but possible), the helper
  // should treat it the same as undefined for env purposes. Pure-data test —
  // no normalisation rule lives in the helper, so '' → '' is the correct
  // expectation today; if a future caller wants to validate non-empty, that's
  // their job, not the env helper's.
  const env = _buildCcbSpawnTraceEnv('')
  assert.deepEqual(env, { OPENCLAUDE_TRACE_ID: '' })
})

// ── setTraceId mutator (no-side-effect) tests ──
//
// Mirror the existing setModel / setEffortLevel test in
// subprocessRunnerSetters.test.ts. We construct a real SubprocessRunner with
// minimal opts and exercise the getter/setter without ever calling start();
// no subprocess is forked.

function createRunner(initial: Partial<{ traceId: string }> = {}): SubprocessRunner {
  return new SubprocessRunner({
    sessionKey: 'test',
    agentId: 'test',
    agentBaseDir: '/tmp',
    config: {} as any,
    ...initial,
  } as any)
}

test('setTraceId: getter returns undefined when not set in constructor', () => {
  const r = createRunner()
  assert.equal(r.traceId, undefined)
})

test('setTraceId: getter reflects constructor-supplied traceId', () => {
  const r = createRunner({ traceId: 'init-trace-id-1234567890ab' })
  assert.equal(r.traceId, 'init-trace-id-1234567890ab')
})

test('setTraceId: mutates and getter reflects new value', () => {
  const r = createRunner({ traceId: 'init-trace-id-1234567890ab' })
  r.setTraceId('next-trace-id-fedcba0987654321')
  assert.equal(r.traceId, 'next-trace-id-fedcba0987654321')
})

test('setTraceId(undefined): clears the trace id', () => {
  const r = createRunner({ traceId: 'init-trace-id-1234567890ab' })
  r.setTraceId(undefined)
  assert.equal(r.traceId, undefined)
})

test('setTraceId: no side effect — does not spawn / exit / emit any event', () => {
  // Sanity: setTraceId is a pure opts mutator. If a future change adds
  // auto-restart on trace change, every event listener below would fire and
  // this assertion would break. That's the desired catch.
  const r = createRunner()
  const seenEvents: string[] = []
  for (const ev of ['spawn', 'exit', 'error', 'message', 'telemetry', 'parse_error']) {
    r.on(ev as any, () => seenEvents.push(ev))
  }
  r.setTraceId('first')
  r.setTraceId('second')
  r.setTraceId(undefined)
  assert.deepEqual(seenEvents, [], 'setTraceId must not emit any event')
})

// ── Structural source assertion ──
//
// The spawn env block in subprocessRunner.ts must spread the helper EXACTLY
// ONCE. This pins the wiring against:
//   (a) A future refactor that accidentally drops the spread → contract C
//       silently degrades to no-op (CCB receives whatever OPENCLAUDE_TRACE_ID
//       gateway's own process.env happens to carry, possibly empty/missing).
//   (b) A double spread that would let an earlier write override a later one
//       — defense in depth, since spread-order on the same key would resolve
//       deterministically, but two spreads is a code smell that should
//       trigger review.

test('structural: backend.spawn env block spreads _buildCcbSpawnTraceEnv(this.opts.traceId) exactly once', () => {
  const path = new URL('../subprocessRunner.ts', import.meta.url).pathname
  const src = readFileSync(path, 'utf-8')

  // Locate `proc = backend.spawn({` — the actual call site assignment, which
  // is unique. (Plain `backend.spawn({` also appears textually inside the
  // helper's JSDoc and would shadow the real anchor.)
  const startMarker = 'proc = backend.spawn({'
  const startIdx = src.indexOf(startMarker)
  assert.ok(startIdx >= 0, 'proc = backend.spawn({ call site not found in subprocessRunner.ts')

  const span = src.slice(startIdx, startIdx + 6000)
  const calls = span.match(/\.\.\._buildCcbSpawnTraceEnv\(\s*this\.opts\.traceId\s*\)/g) ?? []
  assert.equal(
    calls.length,
    1,
    `backend.spawn env block must contain ..._buildCcbSpawnTraceEnv(this.opts.traceId) exactly once (got ${calls.length})`,
  )
})

test('structural: SubprocessRunnerOpts type declares traceId field', () => {
  // Pin the opts schema — a future cleanup that mistakenly drops the field
  // would silently break re-spawn trace propagation since the setter would
  // still be there but writing to a nonexistent opts key would be a
  // TypeScript error rather than a runtime no-op. This source-level check
  // adds belt to the tsc suspenders.
  const path = new URL('../subprocessRunner.ts', import.meta.url).pathname
  const src = readFileSync(path, 'utf-8')

  const optsIdx = src.indexOf('export interface SubprocessRunnerOpts')
  assert.ok(optsIdx >= 0, 'SubprocessRunnerOpts interface declaration not found')
  // Body between this and the next top-level `}`. Use a coarse 5000-char
  // window — the interface is currently ~70 lines.
  const span = src.slice(optsIdx, optsIdx + 5000)
  assert.match(
    span,
    /traceId\?:\s*string/,
    'SubprocessRunnerOpts must declare an optional traceId field',
  )
})
