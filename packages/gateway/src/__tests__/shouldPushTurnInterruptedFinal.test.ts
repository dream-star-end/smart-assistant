/**
 * turn-alive-heartbeat (Plan 1) — `_shouldPushTurnInterruptedFinal` unit tests.
 *
 * Helper is the autoResumeFromHello synthetic-isFinal judgment for v3 commercial
 * chat. The pre-Plan-1 condition was `peerInFlight && !runner.isRunning`, which
 * uses process-level liveness as a stand-in for turn-level liveness and races
 * against in-turn subprocess respawn windows (phantom-turn / auth-refresh /
 * effort+model swap). Plan 1 introduces `AgentSession._activeTurnCount` as the
 * turn-level truth source; this helper is the single judgment point exercised
 * by `Gateway.autoResumeFromHello`.
 *
 * Repository convention: import from `../server.js` (TS source resolves via
 * tsx). See `deliverStripAndConnTrace.test.ts` for the same pattern.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { _shouldPushTurnInterruptedFinal } from '../server.js'

// ── core 4-case matrix from the helper jsdoc decision table ──

test('peer not in-flight → false (nothing stuck to clear)', () => {
  // Even with proc down and no active turn, if the peer itself is not marked
  // in-flight there is no stuck client state to release.
  assert.equal(_shouldPushTurnInterruptedFinal(false, false, 0), false)
  // undefined peer.inFlight should be treated as not-in-flight too.
  assert.equal(_shouldPushTurnInterruptedFinal(undefined, false, 0), false)
})

test('peer in-flight + runner alive → false (process will drive turn)', () => {
  // Old judgment also returned false here; preserved.  Active turn count is
  // intentionally irrelevant when the process is alive.
  assert.equal(_shouldPushTurnInterruptedFinal(true, true, 0), false)
  assert.equal(_shouldPushTurnInterruptedFinal(true, true, 1), false)
  assert.equal(_shouldPushTurnInterruptedFinal(true, true, 5), false)
})

test('peer in-flight + proc dead + active turn → false (Plan 1 fix)', () => {
  // This is the core regression the fix addresses: subprocess respawn windows
  // (phantom-turn / auth-refresh / effort+model swap) leave runner.isRunning
  // momentarily false while the same submit() promise is still pending.
  // Sending a synthetic isFinal here strands the user.
  assert.equal(_shouldPushTurnInterruptedFinal(true, false, 1), false)
  // Defensive: counter > 1 (queued submit waiting on prev) should also block.
  assert.equal(_shouldPushTurnInterruptedFinal(true, false, 2), false)
})

test('peer in-flight + proc dead + no active turn → true (push isFinal)', () => {
  // This is the genuine "turn interrupted, client stuck" path the original
  // code targeted.  Counter 0 means no submit() is pending — proc really is
  // gone and the turn really did end.
  assert.equal(_shouldPushTurnInterruptedFinal(true, false, 0), true)
})

// ── compatibility: activeTurnCount field missing ──

test('activeTurnCount undefined → treated as 0 (preserves pre-Plan-1 behavior)', () => {
  // Historical session objects, test fakes, or sessions created in a code
  // path that bypasses submit() won't have the field set.  Treating undefined
  // as 0 preserves the pre-Plan-1 judgment for those cases.  This is also a
  // future-proofing guard: if a refactor accidentally drops the `?? 0` fallback,
  // this test will catch it.
  assert.equal(
    _shouldPushTurnInterruptedFinal(true, false, undefined),
    true,
    'undefined active count + interrupted turn → push isFinal (matches counter=0)',
  )
  assert.equal(
    _shouldPushTurnInterruptedFinal(true, true, undefined),
    false,
    'undefined active count but proc alive → still no push',
  )
  assert.equal(
    _shouldPushTurnInterruptedFinal(false, false, undefined),
    false,
    'undefined active count but peer not in-flight → still no push',
  )
})

// ── defensive: stale negative counter values ──

test('negative activeTurnCount → treated as 0 (defense against double-finally)', () => {
  // Math.max(0, n - 1) in sessionManager already guards the producer side,
  // but defense-in-depth: if a future regression lets a negative value slip
  // in, the consumer should treat it as "no active turn" (the same as 0)
  // rather than "turn alive" (which would silently suppress legitimate
  // isFinal pushes).
  assert.equal(_shouldPushTurnInterruptedFinal(true, false, -1), true)
})
