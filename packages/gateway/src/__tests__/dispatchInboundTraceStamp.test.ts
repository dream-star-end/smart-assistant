/**
 * V3 S12e CG7 — turn-level trace id stamping on every outbound frame
 * emitted by `Gateway.dispatchInbound`.
 *
 * Tests are split into three groups:
 *
 *   ── Helper unit tests ─────────────────────────────────────────────
 *     `_buildTurnTraceContext` (traceId 双权威源收口, 2026-07-10):
 *       Authority = master-injected `frame.traceId`; gateway self-mints ONLY
 *       when master didn't inject (personal direct-connect) or injected a
 *       malformed value. Three-tier priority:
 *       - valid master frame.traceId → adopted verbatim as turnTraceId
 *         (NO self-mint), regardless of clientTraceId presence
 *       - malformed master frame.traceId (bad-charset / too-long / wrong-type)
 *         → warn `inbound.master_trace_invalid` (issue enum only) + self-mint
 *       - absent master frame.traceId → self-mint, no master warn
 *       - clientTraceId is observation-only echo, NEVER selects turnTraceId:
 *         valid client → echoed as clientTraceId; invalid client → warn
 *         `inbound.client_trace_invalid` with ONLY `issue` enum
 *         (anti-log-injection)
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

// A syntactically valid 32hex trace id (matches TRACE_ID_REGEX). Used both as a
// master-injected canonical and, in the legacy group below, as a client echo.
const VALID_TRACE = '0123456789abcdef0123456789abcdef'

// ── Group 1: no master injection → self-mint + clientTraceId echo ──
// These pin the fallback tier (personal direct-connect / master omitted
// frame.traceId). masterRaw is always `undefined` here; the assertions on the
// self-minted traceId + clientTraceId echo semantics are unchanged from the
// pre-收口 helper — only the call arity changed (masterRaw arg prepended).

test('buildTurnTraceContext: no master + no client → no warn, fresh traceId, no clientTraceId', () => {
  const { log, logs } = makeLog()
  const r = _buildTurnTraceContext(undefined, undefined, log)
  assert.match(r.traceId, /^[A-Za-z0-9_-]{16,64}$/)
  assert.equal(r.clientTraceId, undefined)
  assert.equal(logs.length, 0)
})

test('buildTurnTraceContext: no master + valid client → self-mint + clientTraceId echoed', () => {
  const { log, logs } = makeLog()
  const client = VALID_TRACE
  const r = _buildTurnTraceContext(undefined, client, log)
  // no master injection → self-mint, NOT identical to client (client never selects turnTraceId)
  assert.match(r.traceId, /^[A-Za-z0-9_-]{16,64}$/)
  assert.notEqual(r.traceId, client, 'self-minted traceId must not be echoed from clientTraceId')
  // client value preserved as observation echo
  assert.equal(r.clientTraceId, client)
  assert.equal(logs.length, 0)
})

test('buildTurnTraceContext: no master + bad-charset client → warn issue=bad-charset, raw NOT in log', () => {
  const { log, logs } = makeLog()
  const poison = 'INJECTED_TRACE$$$$\r\nLog: pwned'
  const r = _buildTurnTraceContext(undefined, poison, log)
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

test('buildTurnTraceContext: no master + too-short client → warn issue=too-short, fallback fresh id', () => {
  const { log, logs } = makeLog()
  const r = _buildTurnTraceContext(undefined, 'short', log)
  assert.match(r.traceId, /^[A-Za-z0-9_-]{16,64}$/)
  assert.equal(r.clientTraceId, undefined)
  assert.equal(logs[0].ctx.issue, 'too-short')
})

test('buildTurnTraceContext: no master + wrong-type client (non-string) → warn issue=wrong-type, fallback fresh', () => {
  const { log, logs } = makeLog()
  const r = _buildTurnTraceContext(undefined, { malicious: 'object' }, log)
  assert.match(r.traceId, /^[A-Za-z0-9_-]{16,64}$/)
  assert.equal(r.clientTraceId, undefined)
  assert.equal(logs[0].ctx.issue, 'wrong-type')
})

test('buildTurnTraceContext: no master + empty-string client → warn issue=empty, fallback fresh', () => {
  const { log, logs } = makeLog()
  const r = _buildTurnTraceContext(undefined, '', log)
  assert.match(r.traceId, /^[A-Za-z0-9_-]{16,64}$/)
  assert.equal(r.clientTraceId, undefined)
  assert.equal(logs[0].ctx.issue, 'empty')
})

// ── Group 2: master-injected frame.traceId authority (traceId 双权威源收口) ──
// These are the behavioral core of the fix: when master injects a valid
// frame.traceId the gateway MUST adopt it verbatim (no self-mint), so the
// front-end "请求ID" == master's PG turn_traces registration. Malformed /
// forged injections fall back to self-mint + warn.

test('buildTurnTraceContext: valid master frame.traceId → adopted verbatim, NO self-mint, no warn', () => {
  const { log, logs } = makeLog()
  const master = 'cc395cf5e883c7b54fcdbd6c45f8902e' // 32hex, the shape master injects
  const r = _buildTurnTraceContext(master, undefined, log)
  // authority: turnTraceId IS the master-injected value, not a fresh mint
  assert.equal(r.traceId, master, 'master-injected frame.traceId must be adopted verbatim')
  assert.equal(r.clientTraceId, undefined)
  assert.equal(logs.length, 0)
})

test('buildTurnTraceContext: valid master + valid client → master wins traceId, client only echoed', () => {
  const { log, logs } = makeLog()
  const master = 'cc395cf5e883c7b54fcdbd6c45f8902e'
  const client = VALID_TRACE
  const r = _buildTurnTraceContext(master, client, log)
  // master selects turnTraceId; client NEVER competes for it
  assert.equal(r.traceId, master)
  assert.notEqual(r.traceId, client)
  assert.equal(r.clientTraceId, client, 'client value still echoed as observation-only')
  assert.equal(logs.length, 0)
})

test('buildTurnTraceContext: bad-charset master frame.traceId → self-mint + warn inbound.master_trace_invalid, raw NOT in log', () => {
  const { log, logs } = makeLog()
  const poison = 'FORGED\r\nturn_traces spoof $$$'
  const r = _buildTurnTraceContext(poison, undefined, log)
  // malformed master injection → fall back to self-mint (never adopt the forged value)
  assert.match(r.traceId, /^[A-Za-z0-9_-]{16,64}$/)
  assert.notEqual(r.traceId, poison)
  assert.equal(r.clientTraceId, undefined)
  assert.equal(logs.length, 1)
  assert.equal(logs[0].msg, 'inbound.master_trace_invalid')
  assert.equal(logs[0].ctx.issue, 'bad-charset')
  // anti-log-injection: warn ctx keys must be ONLY `issue`
  assert.deepEqual(Object.keys(logs[0].ctx), ['issue'])
  const serialised = JSON.stringify(logs[0])
  assert.equal(serialised.includes('FORGED'), false)
  assert.equal(serialised.includes('spoof'), false)
})

test('buildTurnTraceContext: too-long master frame.traceId (>64) → self-mint + warn issue=too-long', () => {
  const { log, logs } = makeLog()
  const tooLong = 'a'.repeat(65) // valid charset but exceeds max length
  const r = _buildTurnTraceContext(tooLong, undefined, log)
  assert.match(r.traceId, /^[A-Za-z0-9_-]{16,64}$/)
  assert.notEqual(r.traceId, tooLong)
  assert.equal(logs.length, 1)
  assert.equal(logs[0].msg, 'inbound.master_trace_invalid')
  assert.equal(logs[0].ctx.issue, 'too-long')
})

test('buildTurnTraceContext: wrong-type master frame.traceId (object) → self-mint + warn issue=wrong-type', () => {
  const { log, logs } = makeLog()
  const r = _buildTurnTraceContext({ forged: 'object' }, undefined, log)
  assert.match(r.traceId, /^[A-Za-z0-9_-]{16,64}$/)
  assert.equal(logs.length, 1)
  assert.equal(logs[0].msg, 'inbound.master_trace_invalid')
  assert.equal(logs[0].ctx.issue, 'wrong-type')
})

test('buildTurnTraceContext: malformed master + valid client → self-mint traceId, master warn, client echoed', () => {
  // master injection is malformed (fall back to self-mint) but a valid client
  // observation is still echoed independently — proves the two tiers are decoupled.
  const { log, logs } = makeLog()
  const client = VALID_TRACE
  const r = _buildTurnTraceContext('short', client, log)
  assert.match(r.traceId, /^[A-Za-z0-9_-]{16,64}$/)
  assert.notEqual(r.traceId, client, 'client must not be promoted to turnTraceId even when master is invalid')
  assert.equal(r.clientTraceId, client)
  // exactly one master warn, no client warn (client was valid)
  assert.equal(logs.length, 1)
  assert.equal(logs[0].msg, 'inbound.master_trace_invalid')
  assert.equal(logs[0].ctx.issue, 'too-short')
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

test('structural: dispatchInbound derives turnTraceId via _buildTurnTraceContext exactly once, feeding master frame.traceId first', () => {
  // traceId 双权威源收口 — the single authority for turnTraceId is ONE
  // _buildTurnTraceContext call whose FIRST arg is the master-injected
  // `frame.traceId`, SECOND is `frame.clientTraceId` (observation echo).
  //
  // Guards against: (a) accidental double-derive (would let derived frames in
  // separate branches disagree), (b) removal of the derive entirely, and
  // (c) — the regression this fix targets — reverting to the pre-收口 wiring
  // that ignored frame.traceId and passed only clientTraceId, which self-mints
  // a fresh id and reintroduces the "底部请求ID 查 turn_traces 查不到" bug.
  const mints = dispatchBodyNoComments.match(/_buildTurnTraceContext\(/g) ?? []
  assert.equal(
    mints.length,
    1,
    `expected exactly 1 _buildTurnTraceContext call in dispatchInbound, got ${mints.length}`,
  )
  // Pin the argument order structurally (whitespace/newlines between args are
  // tolerated). First arg = master authority, second = client echo.
  const callArgs = dispatchBodyNoComments.match(
    /_buildTurnTraceContext\(\s*\(frame as any\)\.traceId\s*,\s*\(frame as any\)\.clientTraceId\s*,/,
  )
  assert.ok(
    callArgs,
    'dispatchInbound must call _buildTurnTraceContext((frame as any).traceId, (frame as any).clientTraceId, ...) — ' +
      'master frame.traceId FIRST (authority, == PG turn_traces registration), clientTraceId SECOND (echo). ' +
      'Regressing to a clientTraceId-only call reintroduces the traceId 双权威源 mismatch bug.',
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

test('structural: dispatchInbound uses _inheritOutboundRouting for derived frames (5 callsites)', () => {
  // The architectural change in CG7 routes derived frames through one helper.
  // Drift detection: if a future PR re-introduces a hand-spread sessionKey/
  // channel/peer in a derived frame, this count drops and the assertion fails.
  // Use comment-stripped body so JSDoc references in the main `out` literal
  // (e.g. "derived frames copy traceId via `_inheritOutboundRouting(out)`")
  // don't false-positive count as call sites.
  //
  // M1a(codex 复活)— 4 → 5:codex billingFrame 分支随 CodexAdapter 复活。
  // Derived frames now: errFrame×2 / permFrame / billingFrame / turnStatusFrame.
  const calls = dispatchBodyNoComments.match(/_inheritOutboundRouting\(\s*out\s*\)/g) ?? []
  assert.equal(
    calls.length,
    5,
    `expected exactly 5 _inheritOutboundRouting(out) callsites (errFrame×2 / permFrame / billingFrame / turnStatusFrame), got ${calls.length}`,
  )
})
