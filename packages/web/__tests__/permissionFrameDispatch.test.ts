import * as assert from 'node:assert/strict'
/**
 * Mobile-reconnect permission flow:
 *
 *   - Pre-dispatch frameSeq cursor: ANY stamped outbound frame (message,
 *     permission_request, permission_settled) must advance `sess._lastFrameSeq`
 *     before the type-specific handler runs. Without this, replayed permission
 *     frames would never move the cursor forward and the gateway would
 *     re-replay them on every reconnect.
 *   - Permission request idempotency: a replayed permission_request whose
 *     requestId already has a card in `sess.messages` must NOT add a duplicate
 *     card; it should rehydrate the modal if missing instead.
 *
 * These tests verify the source structure (so the contract can't silently
 * regress) and behaviorally re-execute the extracted helper to confirm the
 * routing decisions are correct.
 *
 * Run: npx tsx --test packages/web/__tests__/permissionFrameDispatch.test.ts
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const WS_JS = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'websocket.js'),
  'utf-8',
)

// ── Source-structure assertions ──
// Cheap regressions guard. If someone deletes the pre-dispatch cursor or
// reverts the idempotency check we fail loudly.

describe('T01: source structure — pre-dispatch frameSeq + permission idempotency', () => {
  it('_resolveSessForFrame helper exists', () => {
    assert.match(WS_JS, /function\s+_resolveSessForFrame\s*\(/)
  })

  it('pre-dispatch frameSeq advances cursor in ws.onmessage', () => {
    // Match the block as a whole — we want both _resolveSessForFrame and the
    // _lastFrameSeq cursor advance to live in the onmessage handler.
    const onmessageStart = WS_JS.indexOf('ws.onmessage = (ev) => {')
    assert.ok(onmessageStart !== -1, 'ws.onmessage handler should exist')
    const onmessageEnd = WS_JS.indexOf('ws.onerror', onmessageStart)
    const onmessageBody = WS_JS.slice(onmessageStart, onmessageEnd)
    assert.match(onmessageBody, /_resolveSessForFrame\s*\(/)
    assert.match(onmessageBody, /_lastFrameSeq\s*=\s*f\.frameSeq/)
  })

  it('handleOutbound no longer holds the inline frameSeq dedupe block', () => {
    // The dedupe was migrated to pre-dispatch. If someone re-adds the inline
    // block we end up with double-advancement, which would skip over real
    // forward frames. This guards against that regression.
    const fnIdx = WS_JS.indexOf('export function handleOutbound(')
    assert.ok(fnIdx !== -1, 'handleOutbound should be exported')
    const next = WS_JS.indexOf('export function ', fnIdx + 30)
    const body = WS_JS.slice(fnIdx, next === -1 ? undefined : next)
    assert.doesNotMatch(
      body,
      /sess\._lastFrameSeq\s*=\s*frame\.frameSeq/,
      'handleOutbound must not advance _lastFrameSeq directly — pre-dispatch handles it',
    )
  })

  it('handlePermissionRequest checks for an existing card by requestId', () => {
    const fnIdx = WS_JS.indexOf('function handlePermissionRequest(')
    assert.ok(fnIdx !== -1, 'handlePermissionRequest should exist')
    const body = WS_JS.slice(fnIdx, fnIdx + 2000)
    assert.match(
      body,
      /sess\.messages\.find\(/,
      'handlePermissionRequest must look up existing card to dedupe replay',
    )
    assert.match(
      body,
      /m\.requestId\s*===\s*frame\.requestId/,
      'idempotency must be keyed on requestId',
    )
  })
})

// ── Behavioral test for _resolveSessForFrame ──
// We extract the helper and inject mock `state` + `getSession` so we can
// verify routing decisions independently of the rest of websocket.js.

function extractHelper(): string {
  const start = WS_JS.indexOf('function _resolveSessForFrame(')
  assert.ok(start !== -1, '_resolveSessForFrame not found')
  // Find the closing brace at column 0 (top-level function in the module).
  const lines = WS_JS.slice(start).split('\n')
  let endLine = 1
  for (; endLine < lines.length; endLine++) {
    if (lines[endLine] === '}') break
  }
  return lines.slice(0, endLine + 1).join('\n')
}

function makeResolver(
  sessionsMap: Map<string, unknown>,
  currentSession: unknown,
): (frame: { peer?: { id?: string }; cronJob?: boolean }) => unknown {
  const src = extractHelper()
  // We inject `state` and `getSession` as parameters of an enclosing factory so
  // the helper closes over them via lexical scope.
  const factory = new Function(
    'state',
    'getSession',
    `${src}; return _resolveSessForFrame;`,
  )
  return factory(
    { sessions: sessionsMap },
    () => currentSession,
  ) as (frame: { peer?: { id?: string }; cronJob?: boolean }) => unknown
}

describe('T02: _resolveSessForFrame — routing decisions', () => {
  it('returns the registered session for a known peerId', () => {
    const sess = { id: 'p1', messages: [] }
    const resolver = makeResolver(new Map([['p1', sess]]), null)
    assert.equal(resolver({ peer: { id: 'p1' } }), sess)
  })

  it('returns null for an unknown peerId with no fallback', () => {
    const resolver = makeResolver(new Map(), null)
    assert.equal(resolver({ peer: { id: 'ghost' } }), null)
  })

  it('falls back to current session for cron-pushed frames', () => {
    const current = { id: 'current', messages: [] }
    const resolver = makeResolver(new Map(), current)
    assert.equal(resolver({ peer: { id: 'unknown' }, cronJob: true }), current)
  })

  it('falls back to current session for broadcast frames (no peer)', () => {
    const current = { id: 'current', messages: [] }
    const resolver = makeResolver(new Map(), current)
    assert.equal(resolver({}), current)
  })

  it('returns null if current session is missing on broadcast', () => {
    const resolver = makeResolver(new Map(), null)
    assert.equal(resolver({}), null)
  })
})

// ── Behavioral test for the pre-dispatch cursor ──
// Re-implement the exact pre-dispatch snippet from ws.onmessage as a plain
// function and verify it (a) drops duplicates without invoking the handler
// and (b) advances the cursor on forward frames.

function preDispatch(
  frame: { frameSeq?: number; peer?: { id?: string } },
  resolveSess: (f: typeof frame) => { _lastFrameSeq?: number } | null,
  handler: (f: typeof frame) => void,
): boolean {
  if (typeof frame.frameSeq === 'number' && frame.frameSeq > 0) {
    const sess = resolveSess(frame)
    if (sess) {
      const last = sess._lastFrameSeq || 0
      if (frame.frameSeq <= last) return false
      sess._lastFrameSeq = frame.frameSeq
    }
  }
  handler(frame)
  return true
}

describe('T03: pre-dispatch cursor — duplicates do not reach handlers', () => {
  it('forward frame advances cursor and invokes handler', () => {
    const sess: { _lastFrameSeq?: number } = { _lastFrameSeq: 0 }
    const calls: number[] = []
    const dispatched = preDispatch(
      { frameSeq: 5, peer: { id: 'p1' } },
      () => sess,
      (f) => calls.push(f.frameSeq ?? -1),
    )
    assert.equal(dispatched, true)
    assert.equal(sess._lastFrameSeq, 5)
    assert.deepEqual(calls, [5])
  })

  it('duplicate (frameSeq <= last) drops without invoking handler', () => {
    const sess: { _lastFrameSeq?: number } = { _lastFrameSeq: 5 }
    const calls: number[] = []
    const dispatched = preDispatch(
      { frameSeq: 5, peer: { id: 'p1' } },
      () => sess,
      (f) => calls.push(f.frameSeq ?? -1),
    )
    assert.equal(dispatched, false)
    assert.deepEqual(calls, [], 'handler must not run on duplicate frame')
    assert.equal(sess._lastFrameSeq, 5, 'cursor must not regress')
  })

  it('regressing frame (frameSeq < last) drops without invoking handler', () => {
    const sess: { _lastFrameSeq?: number } = { _lastFrameSeq: 10 }
    const calls: number[] = []
    const dispatched = preDispatch(
      { frameSeq: 7, peer: { id: 'p1' } },
      () => sess,
      (f) => calls.push(f.frameSeq ?? -1),
    )
    assert.equal(dispatched, false)
    assert.deepEqual(calls, [])
    assert.equal(sess._lastFrameSeq, 10)
  })

  it('frame without frameSeq still dispatches (legacy / unstamped)', () => {
    const sess: { _lastFrameSeq?: number } = { _lastFrameSeq: 5 }
    const calls: number[] = []
    const dispatched = preDispatch(
      { peer: { id: 'p1' } },
      () => sess,
      () => calls.push(1),
    )
    assert.equal(dispatched, true)
    assert.deepEqual(calls, [1])
    assert.equal(sess._lastFrameSeq, 5)
  })

  it('unknown peer (sess null) leaves cursor untouched but still dispatches', () => {
    const calls: number[] = []
    const dispatched = preDispatch(
      { frameSeq: 3, peer: { id: 'ghost' } },
      () => null,
      (f) => calls.push(f.frameSeq ?? -1),
    )
    assert.equal(dispatched, true)
    assert.deepEqual(calls, [3], 'handler runs so it can warn / route')
  })
})
