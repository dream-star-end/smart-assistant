// OCV5-566 (plan §7.7): oc-trace's pure parts — CSV from psql, per-table events, log lines,
// timeline order, first error, retention. Run: npx tsx --test scripts/__tests__/ocTrace.test.ts
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  collapseRuns,
  eventFromLogLine,
  eventsFromRows,
  firstError,
  idsFromRows,
  parseCsv,
  pastRetention,
  timeline,
  toIso,
} from '../lib/ocTraceLib.ts'

const T = '0a1b2c3d4e5f60718293a4b5c6d7e8f9'
const D = '7f0c1e2a-0000-4000-8000-0000000000aa'

describe('oc-trace lib', () => {
  test('parseCsv: header row, quoted fields with commas, quotes and newlines, empty values', () => {
    const rows = parseCsv('a,b,c\n1,"x, y","say ""hi""\nline2"\n2,,\n')
    assert.deepEqual(rows, [
      { a: '1', b: 'x, y', c: 'say "hi"\nline2' },
      { a: '2', b: '', c: '' },
    ])
    assert.deepEqual(parseCsv(''), [])
  })

  test('toIso: psql timestamps with offsets and ISO strings; empty and garbage are undefined', () => {
    assert.equal(toIso('2026-10-21 22:48:01.123+00'), '2026-10-21T22:48:01.123Z')
    assert.equal(toIso('2026-10-21 23:48:01+01'), '2026-10-21T22:48:01.000Z')
    assert.equal(toIso('2026-10-21T22:48:01.000Z'), '2026-10-21T22:48:01.000Z')
    assert.equal(toIso(''), undefined)
    assert.equal(toIso('soon'), undefined)
  })

  test('a failed dispatch: admitted / accepted / attempt / terminal events, the terminal one carries the code', () => {
    const ev = eventsFromRows('turn_dispatches', [
      {
        dispatch_id: D,
        billing_request_id: 'req-1',
        attempt_no: '2',
        status: 'failed',
        failure_code: 'SERVICE_RESTART',
        admitted_at: '2026-10-21 10:00:00+00',
        accepted_at: '2026-10-21 10:00:01+00',
        last_attempt_at: '2026-10-21 10:00:05+00',
        terminal_at: '2026-10-21 10:01:00+00',
      },
    ])
    assert.deepEqual(
      ev.map((e) => e.event),
      ['dispatch.admitted', 'dispatch.accepted', 'dispatch.attempt#2', 'dispatch.failed'],
    )
    assert.equal(ev[3]!.code, 'SERVICE_RESTART')
    assert.equal(ev[3]!.level, 'error')
    assert.equal(ev[0]!.ids.dispatch_id, D)
  })

  test('finalize journal, usage and upstream rows become events; non-ok outcomes are errors', () => {
    const j = eventsFromRows('request_finalize_journal', [
      {
        request_id: 'r',
        state: 'aborted',
        failure_code: 'TURN_ABORTED',
        created_at: '2026-10-21 10:00:02+00',
        updated_at: '2026-10-21 10:00:59+00',
      },
    ])
    assert.deepEqual(
      j.map((e) => [e.event, e.code]),
      [
        ['finalize.opened', undefined],
        ['finalize.aborted', 'TURN_ABORTED'],
      ],
    )
    const u = eventsFromRows('turn_upstream_performance', [
      {
        request_id: 'r',
        outcome: 'timeout',
        observed_at: '2026-10-21 10:00:30+00',
      },
    ])
    assert.equal(u[0]!.code, 'UPSTREAM_TIMEOUT')
    const ok = eventsFromRows('turn_upstream_performance', [
      { request_id: 'r', outcome: 'ok', observed_at: '2026-10-21 10:00:30+00' },
    ])
    assert.equal(ok[0]!.code, undefined)
  })

  test('log lines: JSON with ts/level/msg/ids/code is an event; non-JSON or no ts is skipped', () => {
    const e = eventFromLogLine(
      'master-log',
      JSON.stringify({
        traceId: T,
        dispatchId: D,
        errorCode: 'X_FAILED',
        error: 'boom',
        ts: '2026-10-21T10:00:40.000Z',
        level: 'error',
        msg: 'turn failed',
      }),
    )
    assert.deepEqual(e, {
      at: '2026-10-21T10:00:40.000Z',
      source: 'master-log',
      event: 'turn failed',
      code: 'X_FAILED',
      level: 'error',
      ids: { traceId: T, dispatchId: D },
      message: 'boom',
    })
    assert.equal(eventFromLogLine('master-log', `plain text with ${T}`), null)
    assert.equal(eventFromLogLine('master-log', JSON.stringify({ msg: 'no ts', traceId: T })), null)
    // a saved container log line: docker's timestamp, then the gateway's JSON line (OCV5-568)
    const c = eventFromLogLine(
      'container-log',
      `2026-10-21T10:00:41.123456789Z ${JSON.stringify({ module: 'gateway', traceId: T, ts: '2026-10-21T10:00:41.120Z', level: 'error', msg: 'runner crashed' })}`,
    )
    assert.equal(c?.event, 'runner crashed')
    assert.equal(c?.ids.traceId, T)
  })

  test('timeline is time-ordered across sources; first error prefers a coded error over a bare error line', () => {
    const ev = [
      {
        at: '2026-10-21T10:00:50.000Z',
        source: 'master-log',
        event: 'late',
        level: 'error',
        ids: {},
      },
      {
        at: '2026-10-21T10:00:40.000Z',
        source: 'egress-log',
        event: 'warn only',
        level: 'warn',
        ids: {},
      },
      {
        at: '2026-10-21T10:00:45.000Z',
        source: 'turn_dispatches',
        event: 'dispatch.failed',
        code: 'SERVICE_RESTART',
        level: 'error',
        ids: {},
      },
    ] as const
    assert.deepEqual(
      timeline([...ev]).map((e) => e.event),
      ['warn only', 'dispatch.failed', 'late'],
    )
    assert.equal(firstError([...ev])!.code, 'SERVICE_RESTART')
    assert.equal(firstError([ev[0], ev[1]])!.event, 'late')
    assert.equal(firstError([ev[1]]), undefined)
  })

  test('retention: nominal windows do not claim conditional journal rows were deleted', () => {
    const now = new Date('2026-11-10T00:00:00Z')
    const past = pastRetention('2026-10-21T10:00:00Z', now)
    assert.ok(
      past.includes('master-log') &&
        past.includes('egress-log') &&
        !past.includes('request_finalize_journal'),
    )
    assert.ok(
      !past.includes('turn_traces') &&
        !past.includes('turn_dispatches') &&
        !past.includes('usage_records'),
    )
  })

  test('collapseRuns: a run of identical events becomes one with a count; different neighbours stay', () => {
    const relay = (s: number) => ({
      at: `2026-10-21T10:00:${String(s).padStart(2, '0')}.000Z`,
      source: 'egress-log' as const,
      event: 'native_relay_stage_timing',
      level: 'info' as const,
      ids: {},
    })
    const c = collapseRuns([
      relay(1),
      relay(2),
      relay(3),
      {
        at: '2026-10-21T10:00:04.000Z',
        source: 'turn_dispatches',
        event: 'dispatch.failed',
        code: 'SERVICE_RESTART',
        level: 'error',
        ids: {},
      },
      relay(5),
    ])
    assert.deepEqual(
      c.map((e) => [e.event, e.count ?? 1, e.until]),
      [
        ['native_relay_stage_timing', 3, '2026-10-21T10:00:03.000Z'],
        ['dispatch.failed', 1, undefined],
        ['native_relay_stage_timing', 1, undefined],
      ],
    )
  })

  test('Codex r1: a usage / journal error flag (has_error = t) makes an error event that can be the first error', () => {
    const usage = eventsFromRows('usage_records', [
      {
        request_id: 'r',
        status: 'error',
        has_error: 't',
        created_at: '2026-10-21 10:00:00+00',
      },
    ])
    const journal = eventsFromRows('request_finalize_journal', [
      {
        request_id: 'r',
        state: 'open',
        has_error: 't',
        created_at: '2026-10-21 09:59:00+00',
        updated_at: '2026-10-21 10:00:10+00',
      },
    ])
    assert.equal(usage[0]!.level, 'error')
    assert.equal(journal[1]!.code, 'FINALIZE_ERROR')
    const restart = eventsFromRows('turn_dispatches', [
      {
        dispatch_id: 'd',
        status: 'failed',
        failure_code: 'SERVICE_RESTART',
        terminal_at: '2026-10-21 10:01:00+00',
      },
    ])
    assert.equal(firstError([...restart, ...usage])!.source, 'usage_records')
    const ok = eventsFromRows('usage_records', [
      {
        request_id: 'r',
        status: 'success',
        has_error: 'f',
        created_at: '2026-10-21 10:00:00+00',
      },
    ])
    assert.equal(ok[0]!.level, 'info')
  })

  test('Codex r1: ids for the next round come from every table, e.g. an upstream request id only in the journal', () => {
    const ids = idsFromRows({
      turn_traces: [{ trace_id: T, dispatch_id: D, request_id: 'B' }],
      request_finalize_journal: [{ request_id: 'R-upstream', dispatch_id: D }],
      turn_upstream_performance: [{ request_id: 'R2', dispatch_id: D }],
      turn_dispatches: [{ dispatch_id: D, billing_request_id: 'B' }],
    })
    assert.deepEqual([...ids].sort(), [D, 'B', 'R-upstream', 'R2', T].sort())
  })
  test('604: an earlier usage error or warn code wins over a later dispatch error', () => {
    const usage = eventsFromRows('usage_records', [
      { status: 'error', has_error: 'f', created_at: '2026-10-21T10:00:00Z' },
    ])
    const dispatch = eventsFromRows('turn_dispatches', [
      {
        status: 'terminal',
        outcome: 'crashed',
        failure_code: 'SERVICE_RESTART',
        terminal_at: '2026-10-21T10:01:00Z',
      },
    ])
    assert.equal(firstError([...dispatch, ...usage])?.code, 'USAGE_ERROR')
    const warn = eventFromLogLine(
      'egress-log',
      JSON.stringify({
        ts: '2026-10-21T09:59:00Z',
        level: 'warn',
        code: 'RATE_LIMITED',
        msg: 'upstream rejected',
      }),
    )!
    assert.equal(firstError([...dispatch, warn])?.code, 'RATE_LIMITED')
  })

  test('604: crashed without failure_code is an uncoded error; cancellation is not a failure', () => {
    const crashed = eventsFromRows('turn_dispatches', [
      {
        status: 'terminal',
        outcome: 'crashed',
        terminal_at: '2026-10-21T10:00:00Z',
      },
    ])
    assert.equal(firstError(crashed)?.event, 'dispatch.crashed')
    assert.equal(firstError(crashed)?.code, undefined)
    const cancelled = eventsFromRows('turn_dispatches', [
      {
        status: 'terminal',
        outcome: 'interrupted',
        failure_code: 'USER_CANCELLED',
        terminal_at: '2026-10-21T10:00:00Z',
      },
    ])
    assert.equal(firstError(cancelled), undefined)
    const informational = eventFromLogLine(
      'master-log',
      JSON.stringify({
        ts: '2026-10-21T10:00:00Z',
        level: 'info',
        msg: 'success',
        code: 'OK',
      }),
    )!
    assert.equal(firstError([informational]), undefined)
  })

  test('604: different request identities never collapse; identical identities still collapse', () => {
    const e = (second: number, requestId: string) => ({
      at: `2026-10-21T10:00:0${second}Z`,
      source: 'egress-log' as const,
      event: 'retry',
      code: 'UPSTREAM_ERROR',
      level: 'error' as const,
      ids: { requestId },
    })
    assert.equal(collapseRuns([e(1, 'request-one'), e(2, 'request-two')]).length, 2)
    assert.equal(collapseRuns([e(1, 'request-one'), e(2, 'request-one')])[0]?.count, 2)
  })
})
