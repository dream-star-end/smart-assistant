import * as assert from 'node:assert/strict'
/**
 * Callback pump tests (BLOCKER2): durable broker→master callback delivery over
 * the REAL SQLite outbox (temp OPENCLAUDE_HOME) with injected fetch/capability.
 * Covers: fresh capability per send, body {message, detail:OBJECT}, 409 =
 * idempotent completion, 401 → one capability refresh + retry, 404 → abandoned,
 * explicit claim-capability refusal → abandoned, network error → backoff (never
 * gives up), and the per-repair pending_release-before-done ordering.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/selfhealCallbackPump.test.ts
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

const testHome = await mkdtemp(join(tmpdir(), 'oc-selfheal-pump-'))
process.env.OPENCLAUDE_HOME = testHome

const {
  SELFHEAL_CALLBACK_BACKOFF_BASE_MS,
  closeSelfhealDb,
  enqueueCallback,
  listCallbacksForRepair,
} = await import('@openclaude/storage')
const { SelfhealCallbackPump, postMasterCallback } = await import('../selfheal/callbackPump.js')
const { CapabilityClaimRejectedError } = await import('../selfheal/jobWorker.js')

after(async () => {
  await closeSelfhealDb()
})

let clockNow = 1_000_000
const clock = () => clockNow

/** fetch stub for the SEND side only (capability claims are injected). */
function fakeSend(script: (call: { url: string; init?: RequestInit }) => number | 'throw') {
  const calls: { url: string; init?: RequestInit }[] = []
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const call = { url: String(url), init }
    calls.push(call)
    const status = script(call)
    if (status === 'throw') throw new Error('tunnel down')
    return { ok: status >= 200 && status < 300, status, text: async () => '{}' }
  }) as unknown as typeof fetch
  return { impl, calls }
}

function makePump(opts: {
  fetchImpl: typeof fetch
  claim?: (repairId: string) => Promise<string>
  claims?: string[]
}) {
  const claims = opts.claims ?? []
  return new SelfhealCallbackPump({
    callbackBaseUrl: 'http://127.0.0.1:18796',
    hmacSecret: 'unused-in-tests',
    fetchImpl: opts.fetchImpl,
    now: clock,
    claimCapability:
      opts.claim ??
      (async (repairId: string) => {
        claims.push(repairId)
        return `cap-${claims.length}`
      }),
  })
}

describe('pump delivery — fresh capability, object detail, phase→action mapping', () => {
  it('delivers pending_release as /progress with a freshly claimed capability', async () => {
    await enqueueCallback({
      repairId: 'p-ok',
      phase: 'pending_release',
      message: 'gated',
      detail: { phase: 'pending_release', sha: 'a'.repeat(40) },
      now: clockNow,
    })
    const claims: string[] = []
    const { impl, calls } = fakeSend(() => 200)
    await makePump({ fetchImpl: impl, claims }).pumpOnce()

    assert.deepEqual(claims, ['p-ok'], 'capability claimed fresh before the send')
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url, 'http://127.0.0.1:18796/internal/v5/repairs/p-ok/progress')
    assert.equal((calls[0]?.init?.headers as Record<string, string>)?.Authorization, 'Bearer cap-1')
    const body = JSON.parse(String(calls[0]?.init?.body)) as {
      message: string
      detail: Record<string, unknown>
    }
    assert.equal(body.message, 'gated')
    assert.deepEqual(body.detail, { phase: 'pending_release', sha: 'a'.repeat(40) })
    assert.equal((await listCallbacksForRepair('p-ok'))[0]?.status, 'sent')
  })

  it('delivers done as /done and a 409 counts as delivered (idempotent completion)', async () => {
    await enqueueCallback({
      repairId: 'p-409',
      phase: 'done',
      message: 'deployed',
      detail: { phase: 'deployed' },
      now: clockNow,
    })
    const { impl, calls } = fakeSend(() => 409)
    await makePump({ fetchImpl: impl }).pumpOnce()
    assert.ok(calls[0]?.url.endsWith('/internal/v5/repairs/p-409/done'))
    assert.equal(
      (await listCallbacksForRepair('p-409'))[0]?.status,
      'sent',
      '409 = master already applied it — never retried',
    )
  })

  it('preserves per-repair order: done waits until pending_release is sent', async () => {
    await enqueueCallback({
      repairId: 'p-ord',
      phase: 'pending_release',
      message: 'gated',
      detail: { phase: 'pending_release' },
      now: clockNow,
    })
    await enqueueCallback({
      repairId: 'p-ord',
      phase: 'done',
      message: 'deployed',
      detail: { phase: 'deployed' },
      now: clockNow,
    })
    const sends: string[] = []
    const { impl } = fakeSend((c) => {
      sends.push(c.url)
      return 200
    })
    const pump = makePump({ fetchImpl: impl })
    await pump.pumpOnce() // pending_release only (done held back at claim time)
    assert.equal(sends.length, 1)
    assert.ok(sends[0]?.endsWith('/p-ord/progress'))
    await pump.pumpOnce() // now done is claimable
    assert.equal(sends.length, 2)
    assert.ok(sends[1]?.endsWith('/p-ord/done'))
    const rows = await listCallbacksForRepair('p-ord')
    assert.deepEqual(
      rows.map((r) => r.status),
      ['sent', 'sent'],
    )
  })
})

describe('pump 401 handling — one fresh-capability retry', () => {
  it('a 401 refreshes the capability once and the retry succeeds', async () => {
    await enqueueCallback({
      repairId: 'p-401',
      phase: 'done',
      message: 'm',
      detail: {},
      now: clockNow,
    })
    const claims: string[] = []
    const { impl, calls } = fakeSend((c) =>
      (c.init?.headers as Record<string, string>)?.Authorization === 'Bearer cap-2' ? 200 : 401,
    )
    await makePump({ fetchImpl: impl, claims }).pumpOnce()
    assert.deepEqual(claims, ['p-401', 'p-401'], 'capability re-claimed exactly once')
    assert.equal(calls.length, 2)
    assert.equal((await listCallbacksForRepair('p-401'))[0]?.status, 'sent')
  })

  it('a persistent 401 backs off (row stays queued, attempt bumped) — never abandoned', async () => {
    await enqueueCallback({
      repairId: 'p-401x2',
      phase: 'done',
      message: 'm',
      detail: {},
      now: clockNow,
    })
    const { impl, calls } = fakeSend(() => 401)
    await makePump({ fetchImpl: impl }).pumpOnce()
    assert.equal(calls.length, 2, 'original send + one refreshed retry')
    const row = (await listCallbacksForRepair('p-401x2'))[0]
    assert.equal(row?.status, 'queued')
    assert.equal(row?.attempts, 1)
    assert.equal(row?.nextAttemptAt, clockNow + SELFHEAL_CALLBACK_BACKOFF_BASE_MS)
  })
})

describe('pump permanent refusals — abandoned with a loud log', () => {
  it('a 404 from the master abandons the callback', async () => {
    await enqueueCallback({
      repairId: 'p-404',
      phase: 'done',
      message: 'm',
      detail: {},
      now: clockNow,
    })
    const { impl } = fakeSend(() => 404)
    await makePump({ fetchImpl: impl }).pumpOnce()
    assert.equal((await listCallbacksForRepair('p-404'))[0]?.status, 'abandoned')
  })

  it('an explicit claim-capability refusal (repair unknown/terminal) abandons the callback', async () => {
    await enqueueCallback({
      repairId: 'p-claimrej',
      phase: 'pending_release',
      message: 'm',
      detail: {},
      now: clockNow,
    })
    const { impl, calls } = fakeSend(() => 200)
    const pump = makePump({
      fetchImpl: impl,
      claim: async () => {
        throw new CapabilityClaimRejectedError(404)
      },
    })
    await pump.pumpOnce()
    assert.equal((await listCallbacksForRepair('p-claimrej'))[0]?.status, 'abandoned')
    assert.equal(calls.length, 0, 'nothing was sent without a capability')
  })
})

describe('pump transient failures — exponential backoff, durable forever', () => {
  it('a network error bumps the attempt; the row is retried only after the backoff', async () => {
    await enqueueCallback({
      repairId: 'p-net',
      phase: 'done',
      message: 'm',
      detail: {},
      now: clockNow,
    })
    let fail = true
    const { impl, calls } = fakeSend(() => (fail ? 'throw' : 200))
    // The outbox DB is shared across this file's tests (advancing the clock can
    // make OTHER repairs' backed-off rows due) — assert on p-net's sends only.
    const mySends = () => calls.filter((c) => c.url.includes('/p-net/')).length
    const pump = makePump({ fetchImpl: impl })

    await pump.pumpOnce()
    let row = (await listCallbacksForRepair('p-net'))[0]
    assert.equal(row?.status, 'queued', 'transient failure never abandons')
    assert.equal(row?.attempts, 1)

    // Before the backoff elapses the row is not due — nothing is sent.
    await pump.pumpOnce()
    assert.equal(mySends(), 1)

    // Past the backoff it is retried and succeeds.
    clockNow += SELFHEAL_CALLBACK_BACKOFF_BASE_MS + 1
    fail = false
    await pump.pumpOnce()
    assert.equal(mySends(), 2)
    row = (await listCallbacksForRepair('p-net'))[0]
    assert.equal(row?.status, 'sent')
  })

  it('a transient claim-capability failure also backs off (row stays queued)', async () => {
    await enqueueCallback({
      repairId: 'p-claimnet',
      phase: 'done',
      message: 'm',
      detail: {},
      now: clockNow,
    })
    const { impl, calls } = fakeSend(() => 200)
    const pump = makePump({
      fetchImpl: impl,
      claim: async () => {
        throw new Error('claim-capability HTTP 503')
      },
    })
    await pump.pumpOnce()
    const row = (await listCallbacksForRepair('p-claimnet'))[0]
    assert.equal(row?.status, 'queued')
    assert.equal(row?.attempts, 1)
    assert.equal(calls.length, 0)
  })
})

describe('postMasterCallback — pure send primitive', () => {
  it('POSTs {message, detail} with the EXPLICIT capability and returns the status', async () => {
    const { impl, calls } = fakeSend(() => 202)
    const status = await postMasterCallback({
      callbackBaseUrl: 'http://127.0.0.1:18796/',
      capability: 'explicit-cap',
      repairId: 'prim-1',
      action: 'progress',
      message: 'hello',
      detail: { phase: 'pending_release' },
      fetchImpl: impl,
    })
    assert.equal(status, 202)
    assert.equal(calls[0]?.url, 'http://127.0.0.1:18796/internal/v5/repairs/prim-1/progress')
    assert.equal(
      (calls[0]?.init?.headers as Record<string, string>)?.Authorization,
      'Bearer explicit-cap',
    )
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
      message: 'hello',
      detail: { phase: 'pending_release' },
    })
  })
})
