import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { type TraceEvent, eventFromLogLine } from '../lib/ocTraceLib.ts'
import { type LogReadResult, readLogEvents } from '../lib/ocTraceLogs.ts'
import { type TraceIo, trace } from '../oc-trace.ts'

const T = '60400000000000000000000000000001'
const T2 = '60400000000000000000000000000002'
const D = '60400000-0000-4000-8000-000000000001'
const C = '604-client-message-00000001'
const at = '2026-10-23T07:00:00.000Z'
const noLogs = async (): Promise<LogReadResult> => ({
  events: [],
  truncated: false,
  errors: [],
  windows: [],
})
const event = (ids: Record<string, string>, code?: string): TraceEvent =>
  eventFromLogLine(
    'master-log',
    JSON.stringify({
      ...ids,
      ts: at,
      level: code ? 'error' : 'info',
      msg: code ? 'failed' : 'linked',
      code,
    }),
  )!
const logs =
  (events: TraceEvent[]): NonNullable<TraceIo['readLogs']> =>
  async (ids) => ({
    events: events.filter((e) =>
      Object.entries(e.ids).some(([key, id]) => key !== 'sessionKey' && ids.has(id)),
    ),
    truncated: false,
    errors: [],
    windows: [],
  })
const durableQuery: NonNullable<TraceIo['query']> = (sql, vars) => {
  assert.match(sql, /ORDER BY/)
  if (!sql.includes('FROM turn_dispatches')) return []
  const ids = vars.ids!
  const byDispatch = ids.includes(D)
  const byTrace = ids.includes(T) && sql.includes("WHERE trace_id = ANY(:'ids'::text[])")
  if (!byDispatch && !byTrace) return []
  assert.match(sql, /SELECT trace_id, dispatch_id/)
  return [
    {
      trace_id: T,
      dispatch_id: D,
      status: 'terminal',
      outcome: 'crashed',
      failure_code: 'SERVICE_RESTART',
      admitted_at: at,
      terminal_at: at,
    },
  ]
}

test('604: durable dispatch trace is reachable in both directions with no turn_traces row', async () => {
  for (const input of [T, D]) {
    const r = await trace(input, { query: durableQuery, readLogs: noLogs })
    assert.ok(r.ids.includes(T) && r.ids.includes(D))
    assert.equal(r.firstError?.code, 'SERVICE_RESTART')
    assert.deepEqual(r.incomplete, [])
  }
})

test('604: client id reaches canonical then durable dispatch; log snapshots do not double count', async () => {
  const r = await trace(C, {
    query: durableQuery,
    readLogs: logs([event({ clientTraceId: C, traceId: T })]),
  })
  assert.ok(r.ids.includes(T) && r.ids.includes(D))
  assert.equal(r.firstError?.code, 'SERVICE_RESTART')
  assert.equal(r.events.filter((e) => e.source === 'master-log').length, 1)
})

test('604: reused client id is ambiguous and cannot be counted as one exact turn', async () => {
  const r = await trace(C, {
    query: () => [],
    readLogs: logs([
      event({ clientTraceId: C, traceId: T }),
      event({ clientTraceId: C, traceId: T2 }),
    ]),
  })
  assert.deepEqual(r.clientCandidates.sort(), [T, T2])
  assert.ok(r.incomplete.includes('ambiguous-client-trace-id'))
})

test('604: canonical lookup does not fan out through a reused client id', async () => {
  const r = await trace(T, {
    query: () => [],
    readLogs: logs([
      event({ clientTraceId: C, traceId: T }),
      event({ clientTraceId: C, traceId: T2 }, 'UNRELATED_FAILURE'),
    ]),
  })
  assert.ok(!r.ids.includes(T2) && !r.ids.includes(C))
  assert.equal(r.firstError, undefined)
})

test('604: explicit parent links discover a child error; deeper closure is bounded and marked', async () => {
  const family = [event({ parentTraceId: T, traceId: T2 }), event({ traceId: T2 }, 'CHILD_ERROR')]
  const r = await trace(T, { query: () => [], readLogs: logs(family) })
  assert.equal(r.firstError?.code, 'CHILD_ERROR')
  const chain = Array.from({ length: 8 }, (_, i) =>
    event({
      parentTraceId: `parent-trace-${i}`,
      traceId: `parent-trace-${i + 1}`,
    }),
  )
  const bounded = await trace('parent-trace-0', {
    query: () => [],
    readLogs: logs(chain),
  })
  assert.ok(bounded.incomplete.includes('log-closure-incomplete'))
})

test('604: database failure and row/id caps make the result explicitly incomplete', async () => {
  const failed = await trace(T, {
    query: () => {
      throw new Error('synthetic database failure')
    },
    readLogs: noLogs,
  })
  assert.ok(failed.incomplete.some((x) => x.endsWith('database-read-failed')))
  const rows = Array.from({ length: 201 }, (_, i) => ({
    trace_id: `cap-trace-${i}`,
    request_id: `cap-request-${i}`,
    created_at: at,
  }))
  const capped = await trace(T, {
    query: (sql) => (sql.includes('FROM turn_traces') ? rows : []),
    readLogs: noLogs,
  })
  assert.ok(capped.truncated.includes('turn_traces'))
  assert.ok(capped.incomplete.includes('id-cap'))
})

test('604: an earlier uncoded error is visible alongside the first available code', async () => {
  const bare = {
    ...event({ traceId: T }),
    level: 'error' as const,
    at: '2026-10-23T06:59:00.000Z',
  }
  const r = await trace(T, { query: durableQuery, readLogs: logs([bare]) })
  assert.equal(r.firstError?.code, 'SERVICE_RESTART')
  assert.equal(r.firstUncodedError?.at, bare.at)
})

test('604: real plain/gzip reader returns actual source windows and rejects free-text id matches', async () => {
  // Keep the tiny fixtures as test evidence; never remove a shared directory or cache.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oc-trace-604-'))
  const line = (ids: Record<string, string>, ts: string, msg = 'event') =>
    JSON.stringify({
      ...ids,
      nested: { ts: '1900-01-01T00:00:00Z' },
      ts,
      level: 'warn',
      msg,
      code: 'UPSTREAM_ERROR',
    })
  await writeFile(
    path.join(dir, 'master.log'),
    [
      line({ traceId: T2 }, '2026-10-22T00:00:00Z'),
      line({ traceId: T }, at),
      line({ traceId: T2 }, '2026-10-24T00:00:00Z', T),
    ].join('\n'),
  )
  await writeFile(
    path.join(dir, 'master.log.1.gz'),
    gzipSync(line({ traceId: T }, '2026-10-21T00:00:00Z')),
  )
  const locations = [{ source: 'master-log' as const, dir, pattern: /master\.log/ }]
  const r = await readLogEvents(new Set([T]), locations, Date.now() + 5000)
  assert.equal(r.events.length, 2)
  assert.deepEqual(r.errors, [])
  const plain = r.windows.find((x) => x.file === 'master.log')!
  assert.equal(plain.first, '2026-10-22T00:00:00.000Z')
  assert.equal(plain.last, '2026-10-24T00:00:00.000Z')
  assert.equal(plain.complete, true)
  const capped = await readLogEvents(new Set([T]), locations, Date.now() + 5000, 1)
  assert.ok(capped.truncated)
  const timed = await readLogEvents(new Set([T]), locations, Date.now() - 1)
  assert.ok(timed.errors.includes('master-log:scan-deadline'))
  await writeFile(path.join(dir, 'broken.log.gz'), 'not gzip')
  const broken = await readLogEvents(
    new Set([T]),
    [{ source: 'master-log', dir, pattern: /broken/ }],
    Date.now() + 5000,
  )
  assert.ok(broken.errors.length)
  assert.equal(broken.windows[0]?.complete, false)
  const absent = await readLogEvents(
    new Set([T]),
    [{ source: 'master-log', dir: path.join(dir, 'absent'), pattern: /./ }],
    Date.now() + 5000,
  )
  assert.ok(absent.errors.includes('master-log:directory-unreadable'))
})
