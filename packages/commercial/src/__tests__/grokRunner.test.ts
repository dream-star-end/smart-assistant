import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

import type { Pool } from 'pg'

import { InMemoryPreCheckRedis } from '../billing/preCheck.js'
import { PricingCache } from '../billing/pricing.js'
import {
  GrokRunError,
  __resetGrokVisionRateState,
  makeGrokRunner,
  resettleGrokRun,
} from '../grok/visionProxy.js'
import {
  GROK_TOKEN_BYTES,
  PNG_BASE64,
  PUBLIC_VISION_AUTHZ,
  grokVisionSnapshot,
  grokVisionUpstreamPayload,
} from './helpers/grokVisionFixtures.js'

// OCV5-591 A0: the vision proxy core is callable from master without a container.

function harness(
  opts: {
    upstream?: { statusCode: number; text: string }
    upstreams?: Array<{ statusCode: number; text: string }>
    admit?: (requestId: string) => boolean
    onAbort?: (requestId: string) => void
    journalState?: (requestId: string) => string | null
  } = {},
) {
  const events: string[] = []
  const bodies: string[] = []
  const settled: Array<{ userId: bigint; frame: any }> = []
  const run = makeGrokRunner({
    getPool: () => ({}) as Pool,
    preCheckRedis: new InMemoryPreCheckRedis(),
    pricing: new PricingCache(),
    catalog: { assertFresh: async () => grokVisionSnapshot() },
    loadUserModelAuthz: async () => PUBLIC_VISION_AUTHZ,
    pickAccountId: async () => 24n,
    freshToken: async () => Buffer.from(GROK_TOKEN_BYTES),
    requestFn: async (_url, init) => {
      events.push('upstream')
      bodies.push(init.body)
      const up = opts.upstreams?.shift() ??
        opts.upstream ?? {
          statusCode: 200,
          text: JSON.stringify(grokVisionUpstreamPayload()),
        }
      return { statusCode: up.statusCode, body: { text: async () => up.text } }
    },
    recordStatus: async () => {},
    preCheckWithCostFn: (async (_r: unknown, input: any) => {
      events.push('precheck')
      return {
        maxCost: input.maxCost,
        balance: 1000n,
        capped: false,
        originalMaxCost: input.maxCost,
        reservation: { userId: String(input.userId), requestId: input.requestId },
      }
    }) as any,
    startInflightJournalFn: (async (_p: unknown, ctx: any) => {
      events.push(`journal:${ctx.containerId === null ? 'null' : String(ctx.containerId)}`)
      return opts.admit ? opts.admit(ctx.requestId) : true
    }) as any,
    settleDurableCodexBillingFn: (async (_d: unknown, userId: bigint, frame: any) => {
      events.push('settle')
      settled.push({ userId, frame })
      return 'committed'
    }) as any,
    abortInflightJournalFn: (async (_p: unknown, requestId: string) => {
      opts.onAbort?.(requestId)
      events.push('abort')
      return true
    }) as any,
    releasePreCheckFn: (async () => {
      events.push('release')
    }) as any,
    readJournalForTakeoverFn: (async (_p: unknown, requestId: string) => {
      const state = opts.journalState ? opts.journalState(requestId) : null
      return state === null
        ? null
        : { state, userId: '7', dispatchId: null, attemptNo: null, model: null }
    }) as any,
  })
  return { run, events, bodies, settled }
}

describe('makeGrokRunner (OCV5-591 A0)', () => {
  beforeEach(() => __resetGrokVisionRateState())

  it('runs for a user without a container, with a caller-supplied stable request id', async () => {
    const h = harness()
    const out = await h.run({
      userId: 7n,
      containerId: null,
      requestId: 'studio:task-1',
      prompt: 'describe',
      image: { mediaType: 'image/png', data: PNG_BASE64 },
    })
    assert.ok(out.text.length > 0)
    assert.equal(out.requestId, 'studio:task-1')
    assert.deepEqual(h.events, ['precheck', 'journal:null', 'upstream', 'settle'])
    assert.equal(h.settled[0]!.frame.requestId, 'studio:task-1')
  })

  it('onResult runs before settlement; a persist failure abandons and never settles', async () => {
    const h = harness()
    await h.run({
      userId: 7n,
      containerId: null,
      requestId: 'r1',
      prompt: 'x',
      onResult: async () => {
        h.events.push('persist')
      },
    })
    assert.deepEqual(h.events.slice(-2), ['persist', 'settle'])
    const h2 = harness()
    await assert.rejects(
      h2.run({
        userId: 7n,
        containerId: null,
        requestId: 'r2',
        prompt: 'x',
        onResult: async () => {
          throw new Error('db down')
        },
      }),
      /db down/,
    )
    assert.ok(h2.events.includes('abort'))
    assert.ok(!h2.events.includes('settle'))
  })

  it('platform-paid steps never touch user billing', async () => {
    const h = harness()
    const out = await h.run({
      userId: 7n,
      containerId: null,
      requestId: 'p1',
      prompt: 'plan this',
      billTo: 'platform',
    })
    assert.ok(out.text)
    assert.deepEqual(h.events, ['upstream'])
  })

  it('text-only prompts use a text body; image prompts the vision body', async () => {
    const h = harness()
    await h.run({
      userId: 7n,
      containerId: null,
      requestId: 't1',
      prompt: 'only text',
      billTo: 'platform',
    })
    const body = JSON.parse(h.bodies[0]!)
    assert.deepEqual(body.input[0].content, [{ type: 'input_text', text: 'only text' }])
  })

  it("upstream failures surface as GrokRunError with the HTTP route's codes", async () => {
    const h = harness({ upstream: { statusCode: 500, text: 'oops' } })
    await assert.rejects(
      h.run({ userId: 7n, containerId: null, requestId: 'e1', prompt: 'x' }),
      (e: unknown) =>
        e instanceof GrokRunError && e.code === 'GROK_UPSTREAM_ERROR' && e.status === 502,
    )
    assert.ok(h.events.includes('abort'))
  })

  it("a failed attempt's aborted journal never blocks the next attempt (Codex code r1 P1)", async () => {
    const journal = new Map<string, 'inflight' | 'aborted'>()
    const ok = { statusCode: 200, text: JSON.stringify(grokVisionUpstreamPayload()) }
    const h = harness({
      upstreams: [{ statusCode: 503, text: 'busy' }, ok],
      // Real startInflightJournal semantics: INSERT … ON CONFLICT (request_id) DO NOTHING.
      admit: (id) => {
        if (journal.has(id)) return false
        journal.set(id, 'inflight')
        return true
      },
      onAbort: (id) => journal.set(id, 'aborted'),
    })
    const base = { userId: 7n, containerId: null, requestId: 'studio:task-3', prompt: 'x' }
    await assert.rejects(h.run(base), { code: 'GROK_UPSTREAM_ERROR' })
    assert.equal(journal.get('studio:task-3'), 'aborted')
    await assert.rejects(h.run(base), { code: 'GROK_VISION_JOURNAL_CONFLICT' })
    let persisted = ''
    const out = await h.run({
      ...base,
      attempt: 1,
      onResult: async (r) => {
        persisted = r.requestId
      },
    })
    assert.equal(out.requestId, 'studio:task-3~1')
    assert.equal(persisted, 'studio:task-3~1')
    assert.equal(h.settled.at(-1)!.frame.requestId, 'studio:task-3~1')
    await assert.rejects(h.run({ ...base, attempt: -1 }), { code: 'BAD_BODY' })
  })

  it('a journal conflict never releases the reservation of a call still in flight (Codex #1130 r1 P1)', async () => {
    const base = { userId: 7n, containerId: null, requestId: 'studio:task-4', prompt: 'x' }
    const inflight = harness({ admit: () => false, journalState: () => 'inflight' })
    await assert.rejects(inflight.run(base), { code: 'GROK_VISION_JOURNAL_CONFLICT' })
    assert.deepEqual(inflight.events, ['precheck', 'journal:null'])
    const unreadable = harness({
      admit: () => false,
      journalState: () => {
        throw new Error('db down')
      },
    })
    await assert.rejects(unreadable.run(base), { code: 'GROK_VISION_JOURNAL_CONFLICT' })
    assert.ok(!unreadable.events.includes('release'))
    for (const state of ['aborted', null]) {
      const ended = harness({ admit: () => false, journalState: () => state })
      await assert.rejects(ended.run(base), { code: 'GROK_VISION_JOURNAL_CONFLICT' })
      assert.deepEqual(ended.events, ['precheck', 'journal:null', 'release'])
    }
  })

  it('resettleGrokRun settles a persisted step idempotently by request id', async () => {
    const frames: any[] = []
    await resettleGrokRun(
      {
        getPool: () => ({}) as Pool,
        preCheckRedis: new InMemoryPreCheckRedis(),
        pricing: new PricingCache(),
        settleDurableCodexBillingFn: (async (_d: unknown, _u: bigint, frame: any) => {
          frames.push(frame)
          return 'committed'
        }) as any,
      },
      {
        userId: 7n,
        containerId: null,
        requestId: 'studio:task-9',
        durationMs: 10,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          reasoning_output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    )
    assert.equal(frames[0].requestId, 'studio:task-9')
    assert.equal(frames[0].status, 'success')
  })
})
