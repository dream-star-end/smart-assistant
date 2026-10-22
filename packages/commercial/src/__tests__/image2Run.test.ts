import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'
import type { Pool } from 'pg'
import sharp from 'sharp'
import {
  type Image2Billing,
  Image2RunError,
  buildImage2Request,
  makeImage2Runner,
} from '../billing/image2Run.js'
import { ImageDailyLimitError } from '../billing/imageBilling.js'
import { InMemoryPreCheckRedis, InsufficientCreditsError } from '../billing/preCheck.js'

const POLICY = {
  allowed: new Set(['gpt-image-2', 'gpt-image-2.5-flare']),
  editDefault: 'gpt-image-2',
}
let PNG: Buffer

before(async () => {
  PNG = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#336699' } })
    .png({ compressionLevel: 0 })
    .toBuffer()
})

function okBody(n: number): string {
  return JSON.stringify({
    data: Array.from({ length: n }, () => ({ b64_json: PNG.toString('base64') })),
  })
}

type Call = { name: string; args: unknown }

function harness(
  opts: {
    responses?: Array<() => Response>
    cached?: Buffer | null
    reserveError?: Error
    precheckError?: Error
    alreadyCharged?: boolean
    settleDuplicate?: boolean
    account?: bigint | null
    token?: Buffer | null
  } = {},
) {
  const calls: Call[] = []
  const fetches: Array<{ url: string; init: RequestInit }> = []
  const responses = [...(opts.responses ?? [() => new Response(okBody(1), { status: 200 })])]
  const tokens: Buffer[] = []
  const rec = (name: string) => async (_pool: unknown, args: unknown) => {
    calls.push({ name, args })
  }
  const billing: Image2Billing = {
    getCompletedImageUsage: async () =>
      opts.cached ? { responseBody: opts.cached, contentType: 'application/json' } : null,
    reserveImageUsage: async (_p, args) => {
      calls.push({ name: 'reserve', args })
      if (opts.reserveError) throw opts.reserveError
      return { alreadyCharged: opts.alreadyCharged === true }
    },
    markImageUsage: rec('mark') as Image2Billing['markImageUsage'],
    beginImageUpstreamAttempt: async (_p, args) => {
      calls.push({ name: 'begin', args })
      return { attemptId: BigInt(calls.filter((c) => c.name === 'begin').length), attemptNo: 1 }
    },
    finishImageUpstreamAttempt: async (_p, args) => {
      calls.push({ name: 'finish', args })
      return true
    },
    settleImageCharge: async (_p, args) => {
      calls.push({ name: 'settle', args })
      return { ledgerId: 1n, balanceAfter: 950n, duplicate: opts.settleDuplicate === true }
    },
    preCheckExactCost: async (_r, args) => {
      calls.push({ name: 'precheck', args })
      if (opts.precheckError) throw opts.precheckError
      return { reservation: { userId: String(args.userId), requestId: args.requestId } } as never
    },
    releasePreCheck: async (_r, args) => {
      calls.push({ name: 'release', args })
      return true as never
    },
  }
  const charges: unknown[] = []
  const run = makeImage2Runner({
    pool: {} as Pool,
    preCheckRedis: new InMemoryPreCheckRedis(),
    policy: POLICY,
    enabled: true,
    upstreamBaseUrl: 'https://upstream.test/backend-api/codex/',
    billing,
    pickAccount: async () => (opts.account === undefined ? 11n : opts.account),
    resolveDispatcher: async (accountId) => ({ accountId, proxyId: 1n, dispatcher: {} as never }),
    readAccessToken: async () => {
      if (opts.token === null) return null
      const t = Buffer.from(
        opts.token ??
          'hdr.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoid3MtMSJ9fQ.sig',
      )
      tokens.push(t)
      return t
    },
    waitRetry: async () => {},
    fetchImpl: (async (url: string, init: RequestInit) => {
      fetches.push({ url, init })
      const next = responses.shift()
      if (!next) throw new Error('unexpected fetch')
      return next()
    }) as typeof fetch,
    onImageCharge: (_uid, info) => charges.push(info),
  })
  return { run, calls, fetches, tokens, charges }
}

const names = (calls: Call[]) => calls.map((c) => c.name)

describe('runImage2ForUser (OCV5-591 A0)', () => {
  it('generates, settles 50×n against a container-less journey and zeroes the token', async () => {
    const h = harness({ responses: [() => new Response(okBody(2), { status: 200 })] })
    const out = await h.run({
      userId: 247n,
      requestKey: 'studio:t1',
      prompt: '  a lighthouse  ',
      n: 2,
      size: '1024x1536',
    })
    assert.equal(out.images.length, 2)
    assert.equal(out.costCredits, 100n)
    assert.equal(out.charged, true)
    assert.deepEqual(names(h.calls), [
      'reserve',
      'precheck',
      'begin',
      'finish',
      'settle',
      'release',
    ])
    const reserve = h.calls[0]!.args as Record<string, unknown>
    assert.equal(reserve.containerId, null)
    assert.equal(reserve.operation, 'native_image')
    assert.equal(reserve.imageCount, 2)
    assert.equal((h.calls[1]!.args as { maxCost: bigint }).maxCost, 100n)
    assert.equal(h.fetches[0]!.url, 'https://upstream.test/backend-api/codex/images/generations')
    const sent = JSON.parse(String(h.fetches[0]!.init.body))
    assert.deepEqual(sent, {
      model: 'gpt-image-2',
      prompt: 'a lighthouse',
      n: 2,
      size: '1024x1536',
    })
    const headers = h.fetches[0]!.init.headers as Headers
    assert.match(headers.get('authorization') ?? '', /^Bearer /)
    assert.equal(headers.get('chatgpt-account-id'), 'ws-1')
    assert.ok(
      h.tokens[0]!.every((b) => b === 0),
      'access token buffer must be zeroed',
    )
    assert.deepEqual(h.charges, [{ costCredits: '100', balanceAfter: '950' }])
  })

  it('binds the journey request id to the exact input (Codex code r1 P1)', async () => {
    const base = { requestKey: 'studio:task-1', prompt: 'a lighthouse' }
    const a = buildImage2Request(base, POLICY)
    assert.match(a.requestId, /^studio:task-1#[0-9a-f]{32}$/)
    assert.equal(buildImage2Request({ ...base }, POLICY).requestId, a.requestId)
    for (const changed of [
      { prompt: 'a castle' },
      { n: 4 },
      { model: 'gpt-image-2.5-flare' },
      { size: '1024x1024' },
    ]) {
      assert.notEqual(buildImage2Request({ ...base, ...changed }, POLICY).requestId, a.requestId)
    }
    const h = harness()
    const out = await h.run({ userId: 247n, ...base })
    assert.equal(out.requestId, a.requestId)
    assert.equal((h.calls[0]!.args as { requestId: string }).requestId, a.requestId)
    assert.throws(() => buildImage2Request({ ...base, requestKey: 'k'.repeat(96) }, POLICY), {
      code: 'INVALID_IMAGE_REQUEST',
    })
  })

  it('routes reference images to /images/edits as data URLs', async () => {
    const h = harness()
    await h.run({
      userId: 247n,
      requestKey: 'studio:t2',
      prompt: 'restyle',
      referenceImages: [PNG],
      model: 'gpt-image-2.5-flare',
    })
    assert.equal(h.fetches[0]!.url, 'https://upstream.test/backend-api/codex/images/edits')
    const sent = JSON.parse(String(h.fetches[0]!.init.body))
    assert.equal(sent.model, 'gpt-image-2.5-flare')
    assert.match(sent.images[0].image_url, /^data:image\/png;base64,/)
  })

  it('replays a completed request without reserving or calling upstream', async () => {
    const h = harness({ cached: Buffer.from(okBody(1)) })
    const out = await h.run({ userId: 247n, requestKey: 'studio:t3', prompt: 'x' })
    assert.equal(out.charged, false)
    assert.equal(h.fetches.length, 0)
    assert.deepEqual(names(h.calls), ['release'])
  })

  it('rejects disallowed models and bad input before touching billing', async () => {
    const h = harness()
    for (const input of [
      { model: 'dall-e-3' },
      { prompt: '   ' },
      { size: '1024' },
      { referenceImages: [Buffer.from('not an image')] },
    ]) {
      await assert.rejects(
        h.run({ userId: 247n, requestKey: 'studio:t4', prompt: 'x', ...input }),
        (e: unknown) => e instanceof Image2RunError && e.code === 'INVALID_IMAGE_REQUEST',
      )
    }
    assert.equal(h.calls.length, 0)
  })

  it('maps preflight failures and marks the journey failed', async () => {
    const daily = harness({ reserveError: new ImageDailyLimitError() })
    await assert.rejects(daily.run({ userId: 247n, requestKey: 'studio:t5', prompt: 'x' }), {
      code: 'IMAGE_DAILY_LIMIT',
    })
    assert.ok(!names(daily.calls).includes('mark'), 'nothing was reserved, so nothing to mark')

    const poor = harness({ precheckError: new InsufficientCreditsError(10n, 50n) })
    await assert.rejects(poor.run({ userId: 247n, requestKey: 'studio:t6', prompt: 'x' }), {
      code: 'ERR_INSUFFICIENT_CREDITS',
    })
    assert.equal(
      (poor.calls.find((c) => c.name === 'mark')!.args as { errorCode: string }).errorCode,
      'precheck_failed',
    )

    const busy = Object.assign(new Error('dup'), { code: '23505' })
    const raced = harness({ reserveError: busy })
    await assert.rejects(raced.run({ userId: 247n, requestKey: 'studio:t7', prompt: 'x' }), {
      code: 'IMAGE_REQUEST_IN_PROGRESS',
    })
  })

  it('skips the redis hold on paid recovery', async () => {
    const h = harness({ alreadyCharged: true, settleDuplicate: true })
    const out = await h.run({ userId: 247n, requestKey: 'studio:t8', prompt: 'x' })
    assert.equal(out.charged, false)
    assert.ok(!names(h.calls).includes('precheck'))
    assert.equal(h.charges.length, 0)
  })

  it('fails closed without an account or token and releases the hold', async () => {
    const noAccount = harness({ account: null })
    await assert.rejects(noAccount.run({ userId: 247n, requestKey: 'studio:t9', prompt: 'x' }), {
      code: 'NO_CODEX_ACCOUNT',
    })
    assert.deepEqual(names(noAccount.calls), ['reserve', 'precheck', 'mark', 'release'])
    assert.equal(
      (noAccount.calls[2]!.args as { errorCode: string }).errorCode,
      'account_unavailable',
    )

    const noToken = harness({ token: null })
    await assert.rejects(noToken.run({ userId: 247n, requestKey: 'studio:t10', prompt: 'x' }), {
      code: 'CODEX_ACCOUNT_TOKEN_UNAVAILABLE',
    })
    assert.equal(noToken.fetches.length, 0)
  })

  it('retries one short 429 and records both attempts', async () => {
    const h = harness({
      responses: [
        () => new Response('{}', { status: 429, headers: { 'retry-after': '1' } }),
        () => new Response(okBody(1), { status: 200 }),
      ],
    })
    await h.run({ userId: 247n, requestKey: 'studio:t11', prompt: 'x' })
    const finishes = h.calls
      .filter((c) => c.name === 'finish')
      .map((c) => (c.args as { outcome: string }).outcome)
    assert.deepEqual(finishes, ['failed', 'succeeded'])
    assert.equal(h.fetches.length, 2)
  })

  it('classifies upstream rejections without leaking the body', async () => {
    const h = harness({
      responses: [
        () => new Response('{"error":"flagged by moderation secret-detail"}', { status: 400 }),
      ],
    })
    await assert.rejects(
      h.run({ userId: 247n, requestKey: 'studio:t12', prompt: 'x' }),
      (e: unknown) =>
        e instanceof Image2RunError &&
        e.code === 'IMAGE_UPSTREAM_REJECTED_MODERATION' &&
        !e.message.includes('secret-detail') &&
        e.retryable === false,
    )
    assert.ok(!names(h.calls).includes('settle'))
    assert.deepEqual(names(h.calls).slice(-2), ['mark', 'release'])

    const down = harness({ responses: [() => new Response('oops', { status: 502 })] })
    await assert.rejects(down.run({ userId: 247n, requestKey: 'studio:t13', prompt: 'x' }), {
      code: 'IMAGE_UPSTREAM_FAILED',
      retryable: true,
    })
  })

  it('never settles a response with the wrong image count', async () => {
    const h = harness({ responses: [() => new Response(okBody(1), { status: 200 })] })
    await assert.rejects(h.run({ userId: 247n, requestKey: 'studio:t14', prompt: 'x', n: 2 }), {
      code: 'IMAGE_INVALID_RESPONSE',
    })
    assert.ok(!names(h.calls).includes('settle'))
  })

  it('marks an aborted run cancelled and uncharged', async () => {
    const ac = new AbortController()
    const h = harness({
      responses: [
        () => {
          ac.abort()
          throw new DOMException('aborted', 'AbortError')
        },
      ],
    })
    await assert.rejects(
      h.run({ userId: 247n, requestKey: 'studio:t15', prompt: 'x', signal: ac.signal }),
      { code: 'IMAGE_CLIENT_ABORT' },
    )
    assert.equal(
      (h.calls.find((c) => c.name === 'finish')!.args as { outcome: string }).outcome,
      'cancelled',
    )
    assert.ok(!names(h.calls).includes('settle'))
  })

  it('refuses everything while Image 2 is disabled', async () => {
    const run = makeImage2Runner({
      pool: {} as Pool,
      preCheckRedis: new InMemoryPreCheckRedis(),
      policy: POLICY,
      enabled: false,
    })
    await assert.rejects(run({ userId: 247n, requestKey: 'studio:t16', prompt: 'x' }), {
      code: 'IMAGE2_DISABLED',
    })
  })
})
