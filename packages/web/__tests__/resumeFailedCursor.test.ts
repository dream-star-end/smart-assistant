import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

/**
 * resume_failed cursor re-anchoring.
 *
 * When the gateway can no longer replay the live stream from our hello cursor it
 * sends `outbound.resume_failed { from, to, reason }`. The client must re-anchor
 * its frameSeq cursor to the SERVER's authoritative currentLast (`frame.to`),
 * NOT to literal 0.
 *
 * The old code did `sess._lastFrameSeq = 0`. For a `buffer_miss` (server still
 * up, ring pruned its low end, currentLast still high) that made the next hello
 * send lastFrameSeq:0 — unreplayable again — producing another resume_failed and
 * an endless reconnect loop. This guards the fix against regression.
 *
 * Web modules are vanilla JS with no bundler / no DOM here, so — matching the
 * permissionFrameDispatch.test.ts convention — we assert on source structure and
 * behaviorally re-execute the extracted cursor decision.
 *
 * Run: npx tsx --test packages/web/__tests__/resumeFailedCursor.test.ts
 */
const WS_JS = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'websocket.js'),
  'utf-8',
)

// Isolate the handleResumeFailed cursor region (everything before the
// maybeSyncNow REST-escalation call), where the cursor assignment lives.
const hrfStart = WS_JS.indexOf('function handleResumeFailed')
const hrfCursorRegion = WS_JS.slice(hrfStart, WS_JS.indexOf('maybeSyncNow', hrfStart))
const hrfRegion = WS_JS.slice(hrfStart, WS_JS.indexOf('// ══', hrfStart))

describe('T01: handleResumeFailed re-anchors cursor to server frame.to (source guard)', () => {
  it('handleResumeFailed exists', () => {
    assert.ok(hrfStart >= 0, 'handleResumeFailed must exist in websocket.js')
  })

  it('does NOT reset the cursor to literal 0', () => {
    assert.doesNotMatch(
      hrfCursorRegion,
      /_lastFrameSeq\s*=\s*0\b/,
      'cursor must not be hard-reset to 0 (causes buffer_miss resume_failed loop)',
    )
  })

  it('anchors the cursor to frame.to', () => {
    assert.match(
      hrfCursorRegion,
      /_lastFrameSeq\s*=\s*typeof\s+frame\.to\s*===\s*['"]number['"]\s*\?\s*frame\.to\s*:\s*0/,
      'cursor must be set from server-authoritative frame.to',
    )
  })

  it('does not clear the replay-miss marker after a list-only sync', () => {
    assert.doesNotMatch(
      hrfRegion,
      /_liveStreamBroken\s*=\s*false/,
      'only hydrateSession may retire the marker after adopting REST/tape',
    )
  })
})

describe('T02: cursor decision picks server currentLast for every reason', () => {
  // Behaviorally re-execute the extracted decision exactly as written in source.
  const pickCursor = (frame: { to?: number }) => (typeof frame.to === 'number' ? frame.to : 0)

  it('buffer_miss → jump up to server currentLast (no more stale request)', () => {
    assert.equal(pickCursor({ to: 3864 }), 3864)
  })

  it('no_buffer (server restart) → adopt the fresh low currentLast', () => {
    assert.equal(pickCursor({ to: 0 }), 0)
  })

  it('sequence_mismatch (client outran server) → fall back to authoritative to', () => {
    assert.equal(pickCursor({ to: 3863 }), 3863)
  })

  it('missing to → safe 0 fallback (degrades to a REST-only reconcile, not a crash)', () => {
    assert.equal(pickCursor({}), 0)
  })
})
