import assert from 'node:assert/strict'
import test from 'node:test'
import { LiteratureArtifactStore } from './artifactStore.js'
import { LiteratureError } from './errors.js'
import {
  type DownstreamHttpRequester,
  SPRINGER_WEBVPN_PREFIX,
  WanfangLiteratureHttpExecutor,
  createPinnedDownstreamRequester,
} from './httpExecutor.js'
import {
  LITERATURE_ARTIFACT_LOG_MSG,
  LITERATURE_CALL_LOG_MSG,
  LiteratureCallTrace,
  aggregateLiteratureLogLines,
  literatureErrorClass,
} from './observability.js'
import {
  acceptJieyouCookie,
  createJieyouCookieJar,
  exportJieyouAccountState,
} from './accountState.js'
import { LITERATURE_SITE } from './policy.js'

const FORBIDDEN_KEYS = [
  'query',
  'documentId',
  'artifactId',
  'paperId',
  'title',
  'cookie',
  'url',
  'filename',
]

function authState() {
  const jar = createJieyouCookieJar()
  acceptJieyouCookie(jar, 'ecmsmluserid=101; Path=/', LITERATURE_SITE, Date.now())
  acceptJieyouCookie(jar, 'ecmsmlauth=token101; Path=/', LITERATURE_SITE, Date.now())
  return exportJieyouAccountState(jar)
}

test('error classes separate client mistakes, upstream, capacity, session and platform faults', () => {
  assert.equal(literatureErrorClass('DOCUMENT_EXPIRED'), 'client')
  assert.equal(literatureErrorClass('INVALID_INPUT'), 'client')
  assert.equal(literatureErrorClass('BAD_REQUEST'), 'client')
  assert.equal(literatureErrorClass('LITERATURE_NO_ACCESS'), 'upstream')
  assert.equal(literatureErrorClass('LITERATURE_UPSTREAM_RATE_LIMITED'), 'upstream')
  assert.equal(literatureErrorClass('RESPONSE_INVALID'), 'upstream')
  assert.equal(literatureErrorClass('TIMEOUT'), 'upstream')
  assert.equal(literatureErrorClass('LITERATURE_ARTIFACT_CAPACITY'), 'capacity')
  assert.equal(literatureErrorClass('RELINK_REQUIRED'), 'session')
  assert.equal(literatureErrorClass('LEASE_BUSY'), 'platform')
  assert.equal(literatureErrorClass('SOMETHING_NEW'), 'platform')
})

test('call trace records phases, egress routes and an allow-listed event', () => {
  let now = 1000
  const trace = new LiteratureCallTrace('download', () => now)
  now += 40
  trace.phase('lease')
  trace.route = 'en'
  trace.recordHop({ via: 'proxy', fallback: 'timeout' })
  trace.recordHop({ via: 'direct' })
  trace.recordHop({ via: 'proxy' })
  now += 900
  trace.phase('upstream')
  trace.download = { bytes: 2_393_378, pdfValid: true, reused: false }
  now += 60
  const ev = trace.finish({ uid: 247, error: new LiteratureError('LITERATURE_NO_ACCESS') })
  assert.equal(ev.plugin, 'literature-db')
  assert.equal(ev.action, 'download')
  assert.equal(ev.outcome, 'error')
  assert.equal(ev.code, 'LITERATURE_NO_ACCESS')
  assert.equal(ev.errClass, 'upstream')
  assert.equal(ev.totalMs, 1000)
  assert.equal(ev.leaseMs, 40)
  assert.equal(ev.upstreamMs, 900)
  assert.deepEqual(
    {
      proxy: ev.egressProxy,
      fallback: ev.egressFallback,
      direct: ev.egressDirect,
      reasons: ev.fallbackReasons,
    },
    { proxy: 2, fallback: 1, direct: 1, reasons: 'timeout:1' },
  )
  for (const key of FORBIDDEN_KEYS) assert.equal(key in ev, false, key)
  const ok = new LiteratureCallTrace('search', () => now).finish({ uid: 1 })
  assert.equal(ok.outcome, 'ok')
  assert.equal(ok.code, 'OK')
})

test('executor feeds the trace: route, item count, zero result and reused download', async () => {
  const springer = `<div data-test="results-data"><li class="app-card-open"><div data-test="entitlements">Full access</div>
    <h3 data-test="title"><a href="${SPRINGER_WEBVPN_PREFIX}/article/10.1007/s11128-026-05359-y">A</a></h3></li></div>`
  const requester: DownstreamHttpRequester = async ({ url, onRoute }) => {
    onRoute?.({ via: 'proxy' })
    if (url.pathname === `${SPRINGER_WEBVPN_PREFIX}/search`)
      return {
        statusCode: 200,
        headers: { 'content-type': 'text/html' },
        body: Buffer.from(springer),
      }
    throw new Error('unexpected')
  }
  const exec = new WanfangLiteratureHttpExecutor({
    artifactStore: new LiteratureArtifactStore(),
    tokenSecret: Buffer.alloc(32, 3),
    verifyMemberSession: async (s) => s,
    requester,
  })
  const trace = new LiteratureCallTrace('search')
  await exec.executeRead({
    actionId: 'search',
    params: { query: 'quantum' },
    userId: 3,
    ownerUserId: '3',
    accountInstanceId: 'i-3',
    storageState: authState(),
    signal: new AbortController().signal,
    trace,
  })
  const ev = trace.finish({ uid: 3 })
  assert.equal(ev.route, 'en')
  assert.equal(ev.items, 1)
  assert.equal(ev.zeroResult, false)
  assert.equal(ev.egressProxy, 1)
})

test('pinned requester reports proxy fallback reasons through onRoute', async () => {
  const http = await import('node:http')
  // Proxy-form requests carry an absolute URL; the fake proxy answers them with 503.
  const srv = http.createServer((req, res) => {
    res.writeHead(req.url?.startsWith('http://') ? 503 : 200)
    res.end('ok')
  })
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const port = (srv.address() as { port: number }).port
  const calls: string[] = []
  const localRequest: typeof http.request = ((options: any, cb: any) => {
    calls.push(options.port === 29999 ? 'proxy' : 'direct')
    return http.request({ ...options, hostname: '127.0.0.1', port, lookup: undefined }, cb)
  }) as any
  const resolver = { resolve4: async () => ['8.8.8.8'], resolve6: async () => [] }
  try {
    const requester = createPinnedDownstreamRequester(
      resolver,
      5_000,
      10_000,
      localRequest,
      'http://127.0.0.1:29999',
    )
    const routes: Array<{ via: string; fallback?: string }> = []
    const res = await requester({
      url: new URL('http://webvpn.ustb.booktsg.com/x'),
      method: 'GET',
      headers: {},
      maxBytes: 1024,
      signal: new AbortController().signal,
      onRoute: (r) => routes.push(r),
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(calls, ['proxy', 'direct'])
    assert.deepEqual(routes, [{ via: 'proxy', fallback: 'status_5xx' }, { via: 'direct' }])
  } finally {
    srv.closeAllConnections()
    await new Promise<void>((resolve) => srv.close(() => resolve()))
  }
})

test('aggregate: 7/14 day windows, success rate excludes client errors and test uids, p50/p95, download and fallback ratios', () => {
  const day = 86_400_000
  const end = Date.parse('2026-10-22T16:00:00Z')
  const line = (
    offsetDays: number,
    fields: Record<string, unknown>,
    msg = LITERATURE_CALL_LOG_MSG,
  ) =>
    JSON.stringify({
      ...fields,
      ts: new Date(end - offsetDays * day).toISOString(),
      level: 'info',
      msg,
    })
  const lines = [
    line(1, {
      uid: 11,
      action: 'search',
      outcome: 'ok',
      code: 'OK',
      errClass: null,
      totalMs: 100,
      items: 2,
      zeroResult: false,
      egressProxy: 1,
      egressFallback: 0,
      egressDirect: 0,
    }),
    line(2, {
      uid: 12,
      action: 'search',
      outcome: 'ok',
      code: 'OK',
      errClass: null,
      totalMs: 300,
      items: 0,
      zeroResult: true,
      egressProxy: 1,
      egressFallback: 1,
      egressDirect: 1,
      fallbackReasons: 'timeout:1',
    }),
    line(3, {
      uid: 11,
      action: 'download',
      outcome: 'ok',
      code: 'OK',
      errClass: null,
      totalMs: 5000,
      pdfValid: true,
      reused: false,
      egressProxy: 1,
      egressFallback: 0,
      egressDirect: 0,
    }),
    line(4, {
      uid: 12,
      action: 'download',
      outcome: 'error',
      code: 'LITERATURE_NO_ACCESS',
      errClass: 'upstream',
      totalMs: 2000,
    }),
    line(5, {
      uid: 12,
      action: 'download',
      outcome: 'error',
      code: 'DOCUMENT_EXPIRED',
      errClass: 'client',
      totalMs: 50,
    }),
    line(1, {
      uid: 247,
      action: 'download',
      outcome: 'error',
      code: 'DOCUMENT_EXPIRED',
      errClass: 'client',
      totalMs: 40,
    }),
    line(10, {
      uid: 13,
      action: 'search',
      outcome: 'error',
      code: 'LITERATURE_UPSTREAM_CHANGED',
      errClass: 'upstream',
      totalMs: 900,
    }),
    line(20, { uid: 13, action: 'search', outcome: 'ok', code: 'OK', totalMs: 1 }),
    line(1, { uid: 11, event: 'get', outcome: 'ok' }, LITERATURE_ARTIFACT_LOG_MSG),
    line(1, { uid: 12, event: 'expire', reason: 'unsaved' }, LITERATURE_ARTIFACT_LOG_MSG),
    '{"msg":"served","ts":"2026-10-21T00:00:00Z"}',
    'not json',
  ]
  const report = aggregateLiteratureLogLines(lines, {
    endMs: end,
    windowsDays: [7, 14],
    excludeUids: new Set([247]),
  })
  const w7 = report.windows.find((w) => w.days === 7)!
  const w14 = report.windows.find((w) => w.days === 14)!
  assert.equal(w7.calls, 5)
  assert.equal(w7.excludedTestCalls, 1)
  assert.equal(w7.users, 2)
  assert.equal(w7.clientErrors, 1)
  // success = ok / (calls - client errors) = 3 / 4
  assert.equal(w7.successRate, 0.75)
  assert.deepEqual(w7.errorCodes, { LITERATURE_NO_ACCESS: 1, DOCUMENT_EXPIRED: 1 })
  assert.equal(w7.byAction.search?.calls, 2)
  assert.equal(w7.byAction.search?.zeroResults, 1)
  assert.equal(w7.byAction.download?.calls, 3)
  assert.equal(w7.download.attempts, 2)
  assert.equal(w7.download.ok, 1)
  assert.equal(w7.download.successRate, 0.5)
  assert.equal(w7.download.saved, 1)
  assert.equal(w7.download.expiredUnsaved, 1)
  assert.equal(w7.latencyMs.p50, 300)
  assert.equal(w7.latencyMs.p95, 5000)
  assert.equal(w7.egress.proxy, 3)
  assert.equal(w7.egress.fallback, 1)
  assert.equal(w7.egress.fallbackRatio, 1 / 3)
  assert.deepEqual(w7.egress.fallbackReasons, { timeout: 1 })
  assert.equal(w14.calls, 6)
  assert.equal(report.parsedLines, 10)
})
