import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, test } from 'node:test'
import { signAccess } from '../auth/jwt.js'
import { HttpError } from '../http/util.js'
import type { RequestContext } from '../http/handlers.js'
import {
  handleMarketplaceInstall,
  handleMarketplacePublish,
} from '../marketplace/marketplaceRoutes.js'
import { handleMarketplaceSearch } from '../marketplace/marketplaceSearch.js'
import { createImRemoteControlHandler } from '../pendingDecisions/imCommandBridge.js'
import { OutboundBrowserHandoffFrameObserver } from '../pendingDecisions/pgBrowserHandoffStore.js'
import { createPendingDecisionsService } from '../pendingDecisions/service.js'
import { ShortCodeRegistry } from '../pendingDecisions/shortCodeRegistry.js'
import { dispatchSitesBrowserRoute } from '../sites/browserHttp.js'
import type { SitesService } from '../sites/service.js'
import { handleSubmitCommunityTutorial } from '../tutorials/communityTutorialRoutes.js'
import { PreferencesError, resolvePreferencesPatch } from '../user/preferences.js'
import {
  boundedMapSet,
  boundedSetAdd,
  createOutboundFrameAccessor,
  pruneTimestampMap,
} from '../ws/outboundFrameDecode.js'

const JWT_SECRET = 'w2-commercial-perf-secret-0123456789abcdef0123456789abcdef'

function makeReq(opts: {
  method: string
  url: string
  headers?: Record<string, string>
  body?: unknown
}): IncomingMessage {
  const ee = new EventEmitter() as IncomingMessage & {
    [Symbol.asyncIterator]: () => AsyncGenerator<Buffer>
  }
  ee.method = opts.method
  ee.url = opts.url
  ee.headers = opts.headers ?? {}
  const buf = opts.body !== undefined ? Buffer.from(JSON.stringify(opts.body), 'utf8') : null
  ee[Symbol.asyncIterator] = async function* () {
    if (buf) yield buf
  }
  return ee
}

function makeRes() {
  let statusCode = 200
  let raw = ''
  const res = {
    get statusCode() { return statusCode },
    set statusCode(v: number) { statusCode = v },
    setHeader() {},
    end(chunk?: string) { raw = chunk ?? '' },
  } as unknown as ServerResponse
  return { res, get status() { return statusCode }, json: () => JSON.parse(raw) }
}

describe('Wave 2 commercial perf & reliability regressions', () => {
  test('createOutboundFrameAccessor decodes UTF-8 and JSON.parse lazily once', () => {
    const payload = Buffer.from(JSON.stringify({ type: 'outbound.message', seq: 1 }), 'utf8')
    let toStringCalls = 0
    const origToString = payload.toString.bind(payload)
    payload.toString = ((...args: Parameters<Buffer['toString']>) => {
      toStringCalls += 1
      return origToString(...args)
    }) as Buffer['toString']

    const acc = createOutboundFrameAccessor(payload, false)
    assert.equal(toStringCalls, 0)
    const t1 = acc.getFrameText()
    const t2 = acc.getFrameText()
    const t3 = acc.getRawText()
    assert.equal(t1, t2)
    assert.equal(t1, t3)
    assert.equal(toStringCalls, 1)
    const p1 = acc.getParsedFrame()
    const p2 = acc.getParsedTextFrame()
    assert.equal(p1, p2)
    assert.deepEqual(p1, { type: 'outbound.message', seq: 1 })
  })

  test('bounded collection helpers enforce caps and TTL pruning', () => {
    const s = new Set<string>()
    for (let i = 0; i < 5; i++) boundedSetAdd(s, `k${i}`, 3)
    assert.deepEqual([...s], ['k2', 'k3', 'k4'])

    const m = new Map<string, number>()
    for (let i = 0; i < 5; i++) boundedMapSet(m, `u${i}`, i * 1000, 3)
    assert.deepEqual([...m.keys()], ['u2', 'u3', 'u4'])

    pruneTimestampMap(m, 10_000, 7_000, 3)
    assert.deepEqual([...m.keys()], ['u3', 'u4'])
  })

  test('OutboundBrowserHandoffFrameObserver accepts pre-parsed frames and pre-screens raw non-handoff frames', () => {
    const emitted: string[] = []
    const observer = new OutboundBrowserHandoffFrameObserver({
      emit: (evt) => { emitted.push(evt.text) },
    })

    // Pre-screened raw non-handoff frame should not fail or emit even if JSON is invalid after pre-screen
    observer.observeOutboundFrame('42', '{"type":"outbound.message","blocks":[{"text":"hello world"}]}')
    assert.equal(emitted.length, 0)

    // Pre-parsed frame object directly (0 decode / 0 JSON.parse)
    observer.observeOutboundFrame('42', {
      type: 'outbound.message',
      messageId: 'm-preparsed',
      peer: { id: 'sess-1' },
      isFinal: true,
      blocks: [
        {
          kind: 'text',
          text: '```ui\n{"type":"browser_handoff","title":"登录","url":"https://example.com","reason":"2FA"}\n```',
        },
      ],
    })
    assert.equal(emitted.length, 1)
  })

  test('PendingDecisionsService masks raw internal error messages in warnings', async () => {
    const svc = createPendingDecisionsService({
      sources: [
        {
          source: 'taskboard',
          listPending: async () => {
            throw new Error('PG password=supersecret connection refused 10.0.0.5:5432')
          },
          resolve: async () => {
            throw new Error('unused')
          },
        },
      ],
    })
    const res = await svc.list('42')
    assert.equal(res.warnings?.length, 1)
    assert.equal(res.warnings?.[0]?.code, 'SOURCE_UNAVAILABLE')
    assert.equal(res.warnings?.[0]?.message, '该来源暂时不可用，请稍后重试')
    assert.ok(!res.warnings?.[0]?.message.includes('supersecret'))
  })

  test('ShortCodeRegistry.lookup sets cooldownUntil on expired code', () => {
    let nowMs = 1_000_000
    let seq = 1234
    const reg = new ShortCodeRegistry({
      now: () => nowMs,
      defaultTtlMs: 10_000,
      cooldownMs: 60_000,
      randCode: () => seq,
    })
    const assigned = reg.getOrAssign('42', 'dec-1')
    assert.equal(assigned.code, '1234')
    nowMs += 15_000
    const res = reg.lookup('42', '1234')
    assert.deepEqual(res, { ok: false, reason: 'expired' })

    // Next assignment while in cooldown must NOT reuse '1234'
    const next = reg.getOrAssign('42', 'dec-2')
    assert.notEqual(next.code, '1234')
  })

  test('IM recentSessionSnapshot respects TTL and refreshes expired list on /switch', async () => {
    let nowMs = 1_000_000
    let listCalls = 0
    const switched: string[] = []
    const handler = createImRemoteControlHandler({
      now: () => nowMs,
      sessionSnapshotTtlMs: 60_000,
      sessions: {
        listSessions: async () => {
          listCalls += 1
          return listCalls === 1
            ? [{ sessionId: 'wsess-old', title: 'Old' }]
            : [{ sessionId: 'wsess-new', title: 'New' }]
        },
        getCurrentSessionId: async () => null,
        switchSession: async (_uid, sessionId) => { switched.push(sessionId) },
      },
    })
    await handler.tryHandleCommand({ userId: '42', text: '/sessions', originChannel: 'wechat' })
    assert.equal(listCalls, 1)

    // Within TTL -> uses cached snapshot
    await handler.tryHandleCommand({ userId: '42', text: '/switch 1', originChannel: 'wechat' })
    assert.equal(listCalls, 1)
    assert.deepEqual(switched, ['wsess-old'])

    // Past TTL -> numeric /switch refuses stale index and asks user to run /sessions first
    nowMs += 120_000
    const expiredReply = await handler.tryHandleCommand({ userId: '42', text: '/switch 1', originChannel: 'wechat' })
    assert.ok(expiredReply && expiredReply.includes('/sessions'))
    assert.equal(listCalls, 1)
    assert.deepEqual(switched, ['wsess-old'])

    // Explicit /sessions refreshes snapshot, then /switch 1 switches to the fresh entry
    await handler.tryHandleCommand({ userId: '42', text: '/sessions', originChannel: 'wechat' })
    assert.equal(listCalls, 2)
    await handler.tryHandleCommand({ userId: '42', text: '/switch 1', originChannel: 'wechat' })
    assert.deepEqual(switched, ['wsess-old', 'wsess-new'])
  })

  test('OutboundBrowserHandoffFrameObserver reassembles opening backticks split across frames', () => {
    const emitted: string[] = []
    const observer = new OutboundBrowserHandoffFrameObserver({
      emit: (evt) => { emitted.push(evt.text) },
    })
    observer.observeOutboundFrame('42', JSON.stringify({
      type: 'outbound.message',
      peer: { id: 'sess-split' },
      messageId: 'm-split',
      blocks: [{ kind: 'text', text: '需要接管：\n``' }],
    }))
    observer.observeOutboundFrame('42', JSON.stringify({
      type: 'outbound.message',
      peer: { id: 'sess-split' },
      messageId: 'm-split',
      isFinal: true,
      blocks: [{ kind: 'text', text: '`ui\n{"type":"browser_handoff","title":"登录验证","url":"https://example.com"}\n```' }],
    }))
    assert.equal(emitted.length, 1)
    assert.ok(emitted[0]?.includes('登录验证'))
  })

  test('sites browserHttp rejects null title/password and non-numeric invite fields with 400 INVALID_INPUT', async () => {
    const { token } = await signAccess({ sub: '42', role: 'user' }, JWT_SECRET)
    const headers = { authorization: `Bearer ${token}` }
    const stubSites = {
      updateSite: async () => { throw new Error('should not reach service') },
      createInvite: async () => { throw new Error('should not reach service') },
    } as unknown as SitesService
    const ctx = {} as RequestContext

    for (const badBody of [{ title: null }, { password: null }, { password: 123 }]) {
      const { res } = makeRes()
      await assert.rejects(
        () => dispatchSitesBrowserRoute(
          makeReq({ method: 'PATCH', url: '/api/sites/my-app', headers, body: badBody }),
          res,
          ctx,
          { jwtSecret: JWT_SECRET, sites: stubSites, verifyActiveAccount: async () => true },
        ),
        (err: unknown) => err instanceof HttpError && err.status === 400 && err.code === 'INVALID_INPUT',
      )
    }

    for (const badInvite of [{ expiresInHours: '' }, { expiresInHours: false }, { maxUses: '' }, { maxUses: 'abc' }]) {
      const { res } = makeRes()
      await assert.rejects(
        () => dispatchSitesBrowserRoute(
          makeReq({ method: 'POST', url: '/api/sites/my-app/invites', headers, body: badInvite }),
          res,
          ctx,
          { jwtSecret: JWT_SECRET, sites: stubSites, verifyActiveAccount: async () => true },
        ),
        (err: unknown) => err instanceof HttpError && err.status === 400 && err.code === 'INVALID_INPUT',
      )
    }
  })

  test('banned/inactive commercial users are blocked with 403 across sites, marketplace, and tutorials write surfaces', async () => {
    const { token } = await signAccess({ sub: '42', role: 'user' }, JWT_SECRET)
    const headers = { authorization: `Bearer ${token}` }
    const deny = async () => false

    await assert.rejects(
      () => dispatchSitesBrowserRoute(
        makeReq({ method: 'PATCH', url: '/api/sites/demo', headers, body: { title: 'hi' } }),
        makeRes().res,
        {} as RequestContext,
        { jwtSecret: JWT_SECRET, sites: {} as SitesService, verifyActiveAccount: deny },
      ),
      (err: unknown) => err instanceof HttpError && err.status === 403 && err.code === 'FORBIDDEN',
    )

    await assert.rejects(
      () => handleMarketplacePublish(
        makeReq({ method: 'POST', url: '/api/marketplace/publish', headers, body: {} }),
        makeRes().res,
        { jwtSecret: JWT_SECRET, verifyActiveAccount: deny },
      ),
      (err: unknown) => err instanceof HttpError && err.status === 403 && err.code === 'FORBIDDEN',
    )

    await assert.rejects(
      () => handleMarketplaceInstall(
        makeReq({ method: 'POST', url: '/api/marketplace/install', headers, body: { versionId: '1' } }),
        makeRes().res,
        { jwtSecret: JWT_SECRET, verifyActiveAccount: deny },
      ),
      (err: unknown) => err instanceof HttpError && err.status === 403 && err.code === 'FORBIDDEN',
    )

    await assert.rejects(
      () => handleMarketplaceSearch(
        makeReq({ method: 'GET', url: '/api/marketplace/search?q=test', headers }),
        makeRes().res,
        { jwtSecret: JWT_SECRET, verifyActiveAccount: deny },
      ),
      (err: unknown) => err instanceof HttpError && err.status === 403 && err.code === 'FORBIDDEN',
    )

    await assert.rejects(
      () => handleSubmitCommunityTutorial(
        makeReq({ method: 'POST', url: '/api/tutorials', headers, body: {} }),
        makeRes().res,
        { jwtSecret: JWT_SECRET, verifyActiveAccount: deny },
      ),
      (err: unknown) => err instanceof HttpError && err.status === 403 && err.code === 'FORBIDDEN',
    )
  })

  test('resolvePreferencesPatch returns localized Chinese Auto-Dream entitlement errors', async () => {
    await assert.rejects(
      () => resolvePreferencesPatch('42', { auto_dream_enabled: true }, { feature: async () => ({ eligible: false, available: true }) }),
      (err: unknown) => err instanceof PreferencesError && err.code === 'FORBIDDEN' && err.message.includes('Max'),
    )
    await assert.rejects(
      () => resolvePreferencesPatch('42', { auto_dream_enabled: true }, { feature: async () => ({ eligible: true, available: false }) }),
      (err: unknown) => err instanceof PreferencesError && err.code === 'UNAVAILABLE' && err.message.includes('不可用'),
    )
  })
})
