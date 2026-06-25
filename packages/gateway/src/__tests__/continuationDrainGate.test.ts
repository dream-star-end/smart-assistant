import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

/**
 * The user-submit gate must NOT wait unbounded on a prior turn's continuation
 * watch. The watch's backstop can be re-armed indefinitely by a background
 * workflow that keeps emitting activity, so `watch.done` may never resolve on
 * its own. A bare `await session._continuationWatch.done` then wedges the new
 * turn BEFORE the per-turn liveness watchdog is armed (the watchdog is armed
 * later, inside _runOneTurn), so idle-timeout never fires and the run sits in
 * `running` for tens of minutes — the exact failure this fix targets.
 *
 * Driving the real deadlock needs a re-arming background workflow plus 21 min of
 * faked time; instead — matching the source-structure guard convention used by
 * the web frame tests — we assert the gate stays bounded so it can't silently
 * regress to a bare await.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/continuationDrainGate.test.ts
 */
const SM = readFileSync(resolve(import.meta.dirname, '..', 'sessionManager.ts'), 'utf-8')

// Isolate the user-submit drain gate. `if (session._continuationWatch) {` is the
// gate; `if (session._continuationWatch) return` in _armContinuationWatch does
// not match the `{` form.
const gateStart = SM.indexOf('if (session._continuationWatch) {')
const gateRegion = SM.slice(gateStart, gateStart + 1600)

describe('continuation drain gate is bounded', () => {
  it('the gate exists', () => {
    assert.ok(gateStart >= 0, 'user-submit continuation gate must exist')
  })

  it('does not bare-await watch.done (must be raced against a timeout)', () => {
    assert.doesNotMatch(
      gateRegion,
      /\n\s*await session\._continuationWatch\.done\s*\n\s*}/,
      'bare unbounded await on watch.done regressed',
    )
  })

  it('races watch.done against a drain timeout derived from the backstop', () => {
    assert.match(gateRegion, /Promise\.race\(\[\s*session\._continuationWatch\.done/)
    assert.match(gateRegion, /CONTINUATION_DRAIN_LIMIT_MS/)
    assert.match(gateRegion, /CONTINUATION_WATCH_BACKSTOP_MS/)
  })

  it('force-ends an overstaying watch so the new turn can proceed', () => {
    assert.match(gateRegion, /!session\._continuationWatch\.ended/)
    assert.match(gateRegion, /this\._endContinuationWatch\(session\)/)
  })
})

describe('continuation backstop has a single authoritative constant', () => {
  it('the module-level constant exists and the arm site references it', () => {
    assert.match(SM, /export const CONTINUATION_WATCH_BACKSTOP_MS = 20 \* 60_000/)
    assert.match(SM, /const WATCH_BACKSTOP_MS = CONTINUATION_WATCH_BACKSTOP_MS/)
  })
})
