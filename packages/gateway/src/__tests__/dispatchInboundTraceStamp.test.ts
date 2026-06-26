/**
 * V3 S12e CG7 — turn-level trace id stamping on every outbound frame
 * emitted by `Gateway.dispatchInbound`.
 *
 * Tests are split into three groups:
 *
 *   ── Helper unit tests ─────────────────────────────────────────────
 *     `_buildTurnTraceContext`:
 *       - master mints fresh traceId regardless of clientTraceId presence
 *       - valid client trace → echoed as clientTraceId
 *       - invalid client trace → warn ctx carries ONLY `issue` enum
 *         (anti-log-injection); fallback newTraceId still returned
 *       - missing / undefined client trace → no warn, just newTraceId
 *     `_inheritOutboundRouting`:
 *       - copies sessionKey/channel/peer from main `out`
 *       - conditionally copies _userId (omit key when absent)
 *       - conditionally copies traceId (omit key when absent)
 *       - explicit field list — non-routing extras on `out` do NOT spread
 *
 *   ── Structural regression assertion (dispatchInbound stamp coverage)─
 *     Per Codex CG7 plan v2 blocker: helper-only tests don't prove that
 *     every outbound frame literal in `dispatchInbound` carries the stamp.
 *     The architectural fix in CG7 made 4 derived frames go through
 *     `_inheritOutboundRouting(out)`, so the remaining hand-stamp surface
 *     is the 5 early-return outbounds + the main `out` skeleton.
 *
 *     Rather than spin up a full Gateway with stubbed sessions/router/
 *     repoWorkspace just to drive 5 branch scenarios, we statically scan
 *     the `dispatchInbound` method body and assert that every outbound
 *     frame literal in it carries EITHER `traceId: turnTraceId` (early
 *     return / main out) OR `..._inheritOutboundRouting(out)` (derived
 *     callback frames). This catches the "added a new outbound branch
 *     and forgot to stamp" regression directly. Any future PR moving the
 *     stamping pattern would also need to update this guard, surfacing
 *     the intent change in review.
 *
 *     `outbound.ack` is intentionally excluded — see plan v3: it's a
 *     duplicate-dedup wire signal not in protocol schema and not part of
 *     Contract B's turn-level trace surface.
 *
 * Repository convention: `.js` imports for TS NodeNext + tsx test runner.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  _buildTurnTraceContext,
  _inheritOutboundRouting,
  _stripPrivateRoutingFields,
} from '../server.js'
import type { OutboundMessage } from '@openclaude/protocol'

// ── Helper unit tests: _buildTurnTraceContext ──

function makeLog() {
  const logs: Array<{ msg: string; ctx: any }> = []
  return {
    log: {
      debug: () => {},
      info: () => {},
      warn: (msg: string, ctx?: any) => {
        logs.push({ msg, ctx })
      },
      error: () => {},
    } as any,
    logs,
  }
}

test('buildTurnTraceContext: clientRaw === undefined → no warn, fresh traceId, no clientTraceId', () => {
  const { log, logs } = makeLog()
  const r = _buildTurnTraceContext(undefined, log)
  assert.match(r.traceId, /^[A-Za-z0-9_-]{16,64}$/)
  assert.equal(r.clientTraceId, undefined)
  assert.equal(logs.length, 0)
})

test('buildTurnTraceContext: valid client trace → newTraceId master + clientTraceId echoed', () => {
  const { log, logs } = makeLog()
  const client = '0123456789abcdef0123456789abcdef'
  const r = _buildTurnTraceContext(client, log)
  // master mints fresh, NOT identical to client
  assert.match(r.traceId, /^[A-Za-z0-9_-]{16,64}$/)
  assert.notEqual(r.traceId, client, 'master traceId must be freshly minted, not echoed from client')
  // client value preserved as observation echo
  assert.equal(r.clientTraceId, client)
  assert.equal(logs.length, 0)
})

test('buildTurnTraceContext: bad-charset client trace → warn issue=bad-charset, raw NOT in log', () => {
  const { log, logs } = makeLog()
  const poison = 'INJECTED_TRACE$$$$\r\nLog: pwned'
  const r = _buildTurnTraceContext(poison, log)
  // fallback fresh
  assert.match(r.traceId, /^[A-Za-z0-9_-]{16,64}$/)
  assert.equal(r.clientTraceId, undefined)
  assert.equal(logs.length, 1)
  assert.equal(logs[0].msg, 'inbound.client_trace_invalid')
  assert.equal(logs[0].ctx.issue, 'bad-charset')
  // anti-log-injection: warn ctx keys must be ONLY `issue`
  assert.deepEqual(Object.keys(logs[0].ctx), ['issue'])
  // serialised log record must not contain poison fragments
  const serialised = JSON.stringify(logs[0])
  assert.equal(serialised.includes('INJECTED'), false)
  assert.equal(serialised.includes('pwned'), false)
})

test('buildTurnTraceContext: too-short client trace → warn issue=too-short, fallback fresh id', () => {
  const { log, logs } = makeLog()
  const r = _buildTurnTraceContext('short', log)
  assert.match(r.traceId, /^[A-Za-z0-9_-]{16,64}$/)
  assert.equal(r.clientTraceId, undefined)
  assert.equal(logs[0].ctx.issue, 'too-short')
})

test('buildTurnTraceContext: wrong-type (non-string) → warn issue=wrong-type, fallback fresh', () => {
  const { log, logs } = makeLog()
  const r = _buildTurnTraceContext({ malicious: 'object' }, log)
  assert.match(r.traceId, /^[A-Za-z0-9_-]{16,64}$/)
  assert.equal(r.clientTraceId, undefined)
  assert.equal(logs[0].ctx.issue, 'wrong-type')
})

test('buildTurnTraceContext: empty string client trace → warn issue=empty, fallback fresh', () => {
  const { log, logs } = makeLog()
  const r = _buildTurnTraceContext('', log)
  assert.match(r.traceId, /^[A-Za-z0-9_-]{16,64}$/)
  assert.equal(r.clientTraceId, undefined)
  assert.equal(logs[0].ctx.issue, 'empty')
})

// ── Helper unit tests: _inheritOutboundRouting ──

test('inheritOutboundRouting: copies sessionKey/channel/peer when traceId/_userId absent', () => {
  const out = {
    type: 'outbound.message',
    sessionKey: 'sk1',
    channel: 'webchat',
    peer: { id: 'p1', kind: 'dm' as const },
    blocks: [],
    isFinal: false,
  } as OutboundMessage
  const r = _inheritOutboundRouting(out)
  assert.equal(r.sessionKey, 'sk1')
  assert.equal(r.channel, 'webchat')
  assert.deepEqual(r.peer, { id: 'p1', kind: 'dm' })
  // optional fields ABSENT — key must not appear at all (not just `undefined`)
  assert.equal('traceId' in r, false, 'traceId key must be omitted when out.traceId absent')
  assert.equal('_userId' in r, false, '_userId key must be omitted when out._userId absent')
})

test('inheritOutboundRouting: propagates traceId + _userId when present on out', () => {
  const out = {
    type: 'outbound.message',
    sessionKey: 'sk1',
    channel: 'webchat',
    peer: { id: 'p1', kind: 'dm' as const },
    blocks: [],
    isFinal: false,
    traceId: '01234567890abcdef01234567890abcd',
  } as OutboundMessage
  ;(out as any)._userId = 'u1'
  const r = _inheritOutboundRouting(out as any)
  assert.equal(r.traceId, '01234567890abcdef01234567890abcd')
  assert.equal(r._userId, 'u1')
})

test('inheritOutboundRouting: explicit field list — non-routing extras on out do NOT leak', () => {
  // This is the v2-minor-2 guard: if `out` ever grows a non-routing field
  // (e.g. block buffers, per-turn meta), `_inheritOutboundRouting` must NOT
  // forward it onto derived frames. Otherwise a future innocent change to
  // the main `out` skeleton would silently bloat every error/permission/
  // billing frame.
  const out = {
    type: 'outbound.message',
    sessionKey: 'sk1',
    channel: 'webchat',
    peer: { id: 'p1', kind: 'dm' as const },
    blocks: [{ kind: 'text', text: 'leak me' }],
    isFinal: false,
    traceId: '01234567890abcdef01234567890abcd',
    meta: { cost: 0.01 },
    // hypothetical future field
    customExtra: 'must-not-spread',
  } as any
  const r = _inheritOutboundRouting(out)
  const keys = Object.keys(r).sort()
  assert.deepEqual(
    keys,
    ['channel', 'peer', 'sessionKey', 'traceId'],
    'helper must only emit explicitly listed routing fields',
  )
  assert.equal('blocks' in r, false)
  assert.equal('meta' in r, false)
  assert.equal('customExtra' in r, false)
  assert.equal('type' in r, false)
})

// ── CG7 Codex-round-1 fix: _sendStampedSessionFrame private-field leak ──
//
// Direct-send path (`_sendStampedSessionFrame`) bypasses `deliver()`. Prior to
// the CG7 fix it did *not* strip private routing fields before JSON-sending,
// so permFrame built via `_inheritOutboundRouting(out)` (which propagates
// `_userId`) leaked `_userId` to WS clients + the outbound ring buffer.
//
// Fix: `_sendStampedSessionFrame` now funnels through `_stripPrivateRoutingFields`,
// generalized to `Record<string, unknown>`. These tests pin that invariant:
//   (a) helper unit: a permission_request-shaped record with all private fields
//       is stripped; public traceId survives.
//   (b) structural: `_sendStampedSessionFrame` body must call the helper.

test('stripPrivateRoutingFields: permission_request shape — private fields removed, public traceId kept', () => {
  // permFrame as built by `_inheritOutboundRouting(out)` after CG7. Note `_userId`
  // is present (would-be leak), traceId is present (must survive).
  const permFrame = {
    type: 'outbound.permission_request',
    sessionKey: 'sk1',
    channel: 'webchat',
    peer: { id: 'p1', kind: 'dm' as const },
    traceId: '01234567890abcdef01234567890abcd',
    _userId: 'u1',
    _connectionTraceId: 'c1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    requestId: 'r1',
    toolName: 'Bash',
    toolUseId: 't1',
    inputPreview: '{"cmd":"ls"}',
    inputJson: { cmd: 'ls' },
  } as Record<string, unknown>
  const { wire, userId, connectionTraceId } = _stripPrivateRoutingFields(permFrame)
  // private fields stripped (key absent, not just undefined)
  assert.equal('_userId' in wire, false)
  assert.equal('_connectionTraceId' in wire, false)
  // stripped values returned to caller for routing decisions
  assert.equal(userId, 'u1')
  assert.equal(connectionTraceId, 'c1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  // public schema fields preserved
  assert.equal((wire as any).type, 'outbound.permission_request')
  assert.equal((wire as any).traceId, '01234567890abcdef01234567890abcd')
  assert.equal((wire as any).requestId, 'r1')
  assert.equal((wire as any).toolName, 'Bash')
  // CRITICAL: serialise the wire — must not contain any private field name
  const serialised = JSON.stringify(wire)
  assert.equal(serialised.includes('_userId'), false, '_userId must not appear in wire JSON')
  assert.equal(serialised.includes('_connectionTraceId'), false)
})

// ── Structural regression assertion ──

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverSrc = readFileSync(join(__dirname, '..', 'server.ts'), 'utf8')

/**
 * Extract the body of `Gateway.dispatchInbound` so we can scan only the
 * relevant function. Stops at the next `private` / `public` method or the
 * closing brace of the class — we use a simple line scan keyed on the
 * `dispatchInbound` signature and a heuristic depth-1 outdent (the next
 * `  private ` / `  public ` / `  async ` at the same indent level).
 *
 * Heuristic suffices for the regression check; if the source structure
 * changes drastically the test will fail loudly and need updating, which
 * is exactly the audit signal we want.
 */
function extractDispatchInboundBody(src: string): string {
  const startMarker = 'private async dispatchInbound('
  const startIdx = src.indexOf(startMarker)
  assert.ok(startIdx >= 0, 'dispatchInbound declaration not found in server.ts')
  // Walk forward to find the next sibling method at the same indent level
  // ("  private " / "  public " / "  async " / "  protected " starting with
  // exactly 2 spaces). The function we want ends right before it.
  const tail = src.slice(startIdx + startMarker.length)
  const lines = tail.split('\n')
  // Find the line index where a sibling member declaration begins.
  let endLine = -1
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (
      line.startsWith('  private ') ||
      line.startsWith('  public ') ||
      line.startsWith('  protected ') ||
      line.startsWith('  static ') ||
      line.startsWith('  async ') ||
      // class close
      line === '}'
    ) {
      endLine = i
      break
    }
  }
  assert.ok(endLine > 0, 'dispatchInbound body terminator not found')
  return lines.slice(0, endLine).join('\n')
}

const dispatchBody = extractDispatchInboundBody(serverSrc)

/**
 * Strip `//` line comments before structural regex assertions so doc
 * references to symbols don't false-positive count as call sites.
 * (We keep the original `dispatchBody` for the type-literal scan which
 * already uses a precise enough pattern.)
 */
const dispatchBodyNoComments = dispatchBody
  .split('\n')
  .map((l) => l.replace(/\/\/.*$/, ''))
  .join('\n')

test('structural: every outbound frame literal in dispatchInbound is trace-stamped', () => {
  // Find every `type: 'outbound.<x>'` literal inside dispatchInbound, EXCEPT
  // outbound.ack which is plan-excluded.
  //
  // For each match, slice the surrounding object literal (up to 40 lines
  // forward — generous to cover multi-line frame builders like billingFrame)
  // and assert it contains EITHER `traceId: turnTraceId` OR
  // `..._inheritOutboundRouting(out)`.
  const outboundTypeRegex = /type:\s*'outbound\.[a-z_]+'(?!\s*\/\/.*excluded)/g
  const matches: Array<{ start: number; type: string }> = []
  for (const m of dispatchBody.matchAll(outboundTypeRegex)) {
    const literal = m[0]
    // Skip ack (plan-excluded)
    if (literal.includes('outbound.ack')) continue
    matches.push({ start: m.index ?? 0, type: literal })
  }

  // Sanity: expect at least 9 outbound type literals in dispatchInbound
  // (5 early-return outbound.message + 1 main out + 1 streaming `out`
  // re-spread inside callback + 4 derived). Lower-bound 8 is conservative.
  assert.ok(
    matches.length >= 8,
    `expected ≥ 8 outbound type literals in dispatchInbound, found ${matches.length}. ` +
      `Either coverage shrank unexpectedly or the structural scan is mis-locating the body.`,
  )

  const lines = dispatchBody.split('\n')
  // Map literal index → line number for diagnostics
  function lineOf(charIdx: number): number {
    let cumulative = 0
    for (let i = 0; i < lines.length; i++) {
      cumulative += (lines[i]?.length ?? 0) + 1 // +1 for the '\n'
      if (cumulative > charIdx) return i + 1
    }
    return -1
  }

  const failures: string[] = []
  for (const m of matches) {
    // 40-line window starting at the line containing the type literal
    const startLine = lineOf(m.start)
    const window = lines.slice(startLine - 1, startLine + 40).join('\n')
    const hasDirectStamp = /traceId:\s*turnTraceId\b/.test(window)
    const hasDerivedSpread = /\.\.\._inheritOutboundRouting\(\s*out\s*\)/.test(window)
    // The outbound `{ ...out, blocks: ..., isFinal: ... }` spread variants
    // inherit traceId from main `out` automatically — accept `...out` spread
    // as a valid stamp source too.
    const hasMainOutSpread = /\.\.\.out\b/.test(window)
    if (!hasDirectStamp && !hasDerivedSpread && !hasMainOutSpread) {
      failures.push(
        `outbound literal ${m.type} near line ${startLine} of dispatchInbound has no trace stamp. ` +
          `Window:\n${window.slice(0, 600)}`,
      )
    }
  }
  assert.equal(
    failures.length,
    0,
    failures.length > 0 ? `Unstamped outbound frames:\n${failures.join('\n---\n')}` : '',
  )
})

test('structural: dispatchInbound mints turnTraceId via _buildTurnTraceContext exactly once', () => {
  // Guards against accidental double-mint (would cause derived frames in
  // separate branches to disagree) or removal of the mint entirely.
  const mints = dispatchBodyNoComments.match(/_buildTurnTraceContext\(/g) ?? []
  assert.equal(
    mints.length,
    1,
    `expected exactly 1 _buildTurnTraceContext call in dispatchInbound, got ${mints.length}`,
  )
})

test('structural: _sendStampedSessionFrame body funnels through _stripPrivateRoutingFields', () => {
  // CG7 Codex-round-1 fix: prior to this, `_sendStampedSessionFrame` directly
  // JSON-stringified its `wireFrame` parameter, so a caller passing a frame
  // built via `_inheritOutboundRouting(out)` (which carries `_userId`) leaked
  // private routing fields to WS + outbound ring. Pin the fix structurally so
  // a future refactor that re-extracts the body has to either keep the strip
  // call or knowingly break this test.
  //
  // Locate `private _sendStampedSessionFrame(` and scan its body up to the next
  // sibling member; assert the body references `_stripPrivateRoutingFields(`.
  const startMarker = 'private _sendStampedSessionFrame('
  const startIdx = serverSrc.indexOf(startMarker)
  assert.ok(startIdx >= 0, '_sendStampedSessionFrame not found in server.ts')
  const tail = serverSrc.slice(startIdx)
  const lines = tail.split('\n')
  let endLine = -1
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (
      line.startsWith('  private ') ||
      line.startsWith('  public ') ||
      line.startsWith('  protected ') ||
      line.startsWith('  static ') ||
      line.startsWith('  async ') ||
      line === '}'
    ) {
      endLine = i
      break
    }
  }
  assert.ok(endLine > 0, '_sendStampedSessionFrame body terminator not found')
  const body = lines.slice(0, endLine).join('\n')

  // (a) exactly one strip call — guards against accidental double-strip /
  //     mid-body re-introduction of a `wireFrame`-based JSON path.
  const stripCalls = body.match(/_stripPrivateRoutingFields\(/g) ?? []
  assert.equal(
    stripCalls.length,
    1,
    `_sendStampedSessionFrame must call _stripPrivateRoutingFields exactly once, got ${stripCalls.length}`,
  )

  // (b) BOTH JSON.stringify branches (sessionKey present + absent) must spread
  //     the post-strip `wire`, not the raw `wireFrame` parameter. Pin both
  //     count and spread variable name structurally so a regression that
  //     reverts either branch to `...wireFrame` fails the test.
  const wireSpreads = body.match(/JSON\.stringify\(\s*\{\s*\.\.\.wire\b/g) ?? []
  assert.equal(
    wireSpreads.length,
    2,
    `_sendStampedSessionFrame must JSON.stringify({ ...wire, ... }) in both branches (got ${wireSpreads.length})`,
  )
  assert.equal(
    body.includes('...wireFrame'),
    false,
    '_sendStampedSessionFrame must not spread `wireFrame` (raw, unstripped) into JSON output — would leak private routing fields',
  )
})

test('structural: dispatchInbound uses _inheritOutboundRouting for derived frames (4 callsites)', () => {
  // The architectural change in CG7 routes derived frames through one helper.
  // Drift detection: if a future PR re-introduces a hand-spread sessionKey/
  // channel/peer in a derived frame, this count drops and the assertion fails.
  // Use comment-stripped body so JSDoc references in the main `out` literal
  // (e.g. "derived frames copy traceId via `_inheritOutboundRouting(out)`")
  // don't false-positive count as call sites.
  //
  // P1f (v5 ccb-only) — bumped 5 → 4: codex billingFrame 分支已随 codex 全栈移除。
  // Derived frames now: errFrame×2 / permFrame / turnStatusFrame.
  const calls = dispatchBodyNoComments.match(/_inheritOutboundRouting\(\s*out\s*\)/g) ?? []
  assert.equal(
    calls.length,
    4,
    `expected exactly 4 _inheritOutboundRouting(out) callsites (errFrame×2 / permFrame / turnStatusFrame), got ${calls.length}`,
  )
})
