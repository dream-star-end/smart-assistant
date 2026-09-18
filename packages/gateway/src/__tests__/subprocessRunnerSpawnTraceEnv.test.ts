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
 *   3. The real start path binds unique `spawnOpts` and directly spreads
 *      `_buildCcbSpawnTraceEnv(this.opts.traceId)` exactly once into that
 *      env, consumed by default `backend.spawn(spawnOpts)`.
 *   4. A real default LocalBackend child observes the three trace cases
 *      (value / undefined→empty key present / explicit empty) and does not
 *      inherit parent or provider synthetic values.
 *
 * Test 11 from docs/V3_S12e_PLAN_2026-05-11.md §697-698.
 *
 * Run:
 *   npx tsx --test packages/gateway/src/__tests__/subprocessRunnerSpawnTraceEnv.test.ts
 */
import './helpers/subprocessRunnerSpawnEnvIsolate.js'

import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { SubprocessRunner, _buildCcbSpawnTraceEnv } from '../subprocessRunner.js'
import {
  assertCcbSpawnWiring,
  assertNotInheritedWrongValues,
  inspectCcbSpawnWiring,
  spawnAndReadChildEnv,
  variantDeleteTraceHelper,
  variantDuplicateTraceHelper,
} from './helpers/subprocessRunnerSpawnWiring.js'

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

const src = readFileSync(new URL('../subprocessRunner.ts', import.meta.url), 'utf8')

test('structural: start-path spawnOpts env spreads _buildCcbSpawnTraceEnv(this.opts.traceId) exactly once', () => {
  const wiring = assertCcbSpawnWiring(src)
  assert.equal(wiring.traceHelperSpreadCount, 1)
  assert.ok(wiring.traceHelperSpreadIndex >= 0)
})

test('oracle rejects deleting the trace helper spread', () => {
  const mutated = variantDeleteTraceHelper(src)
  const result = inspectCcbSpawnWiring(mutated)
  if (result.ok) assert.fail('expected oracle to reject deleted trace helper')
  assert.match(result.reason, /_buildCcbSpawnTraceEnv\(this\.opts\.traceId\) exactly once/)
})

test('oracle rejects duplicating the trace helper spread', () => {
  const mutated = variantDuplicateTraceHelper(src)
  const result = inspectCcbSpawnWiring(mutated)
  if (result.ok) assert.fail('expected oracle to reject duplicated trace helper')
  assert.match(result.reason, /_buildCcbSpawnTraceEnv\(this\.opts\.traceId\) exactly once/)
})

test('structural: SubprocessRunnerOpts type declares traceId field', () => {
  // Pin the opts schema — a future cleanup that mistakenly drops the field
  // would silently break re-spawn trace propagation since the setter would
  // still be there but writing to a nonexistent opts key would be a
  // TypeScript error rather than a runtime no-op. This source-level check
  // adds belt to the tsc suspenders.
  const path = new URL('../subprocessRunner.ts', import.meta.url).pathname
  const optsSrc = readFileSync(path, 'utf-8')

  const optsIdx = optsSrc.indexOf('export interface SubprocessRunnerOpts')
  assert.ok(optsIdx >= 0, 'SubprocessRunnerOpts interface declaration not found')
  // Body between this and the next top-level `}`. Use a coarse 5000-char
  // window — the interface is currently ~70 lines.
  const span = optsSrc.slice(optsIdx, optsIdx + 5000)
  assert.match(
    span,
    /traceId\?:\s*string/,
    'SubprocessRunnerOpts must declare an optional traceId field',
  )
})

test('real LocalBackend child receives provided traceId and not inherited wrong values', async () => {
  const sessionKey = 'a9-runner-session-trace-value'
  const traceId = 'a9-trace-real-value-xyz'
  const { probe, childPid } = await spawnAndReadChildEnv({
    sessionKey,
    traceId,
    caseMarker: 'trace-value',
  })
  assert.ok(childPid !== process.pid)
  assert.equal(probe.OC_SESSION_KEY, sessionKey)
  assert.equal(probe.OPENCLAUDE_TRACE_ID, traceId)
  assert.equal(probe.OPENCLAUDE_TRACE_ID_PRESENT, true)
  assertNotInheritedWrongValues(probe)
})

test('real LocalBackend child writes empty OPENCLAUDE_TRACE_ID when traceId is undefined', async () => {
  const sessionKey = 'a9-runner-session-trace-undef'
  const { probe } = await spawnAndReadChildEnv({
    sessionKey,
    traceId: undefined,
    caseMarker: 'trace-undefined',
  })
  assert.equal(probe.OPENCLAUDE_TRACE_ID_PRESENT, true, 'key must be present even when value is empty')
  assert.equal(probe.OPENCLAUDE_TRACE_ID, '')
  assert.equal(probe.OC_SESSION_KEY, sessionKey)
  assertNotInheritedWrongValues(probe)
})

test('real LocalBackend child preserves explicit empty traceId and does not inherit', async () => {
  const sessionKey = 'a9-runner-session-trace-empty'
  const { probe } = await spawnAndReadChildEnv({
    sessionKey,
    traceId: '',
    caseMarker: 'trace-empty',
  })
  assert.equal(probe.OPENCLAUDE_TRACE_ID_PRESENT, true)
  assert.equal(probe.OPENCLAUDE_TRACE_ID, '')
  assert.equal(probe.OC_SESSION_KEY, sessionKey)
  assertNotInheritedWrongValues(probe)
})
