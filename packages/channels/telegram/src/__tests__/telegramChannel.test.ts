/**
 * Run: npx tsx --test packages/channels/telegram/src/__tests__/telegramChannel.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  TELEGRAM_SECRET_HEADER,
  TelegramBotApi,
  buildSignedCallbackData,
  buildTelegramApprovalCard,
  handleTelegramWebhookPayload,
  telegramChannelFactory,
  verifyTelegramApprovalCallback,
} from '../index.js'

function makeMockFetch(
  handler: (url: string, body: Record<string, unknown>) => unknown,
) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    calls.push({ url: String(url), body })
    const result = handler(String(url), body)
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe('Telegram signed Inline Keyboard callback_data (B8 decisionId binding)', () => {
  it('stays <= 64 bytes and binds action, code, decisionId, chatId & TTL via HMAC', () => {
    const nowMs = 1_700_000_000_000
    const decisionId = 'taskboard:tb-1@v1'
    const data = buildSignedCallbackData({
      secret: 'tg-signing-secret',
      action: 'approve',
      code: '4829',
      decisionId,
      chatId: 123456789,
      expiresAtMs: nowMs + 10 * 60_000,
      nowMs,
    })
    assert.ok(Buffer.byteLength(data, 'utf8') <= 64)

    const ok = verifyTelegramApprovalCallback({
      secret: 'tg-signing-secret',
      data,
      chatId: 123456789,
      expectedDecisionId: decisionId,
      allowedChatIds: [123456789],
      nowMs: nowMs + 60_000,
    })
    assert.equal(ok.ok, true)

    // Reusing old card against a DIFFERENT decision after short-code reallocation fails!
    const crossDecision = verifyTelegramApprovalCallback({
      secret: 'tg-signing-secret',
      data,
      chatId: 123456789,
      expectedDecisionId: 'taskboard:tb-other@v1',
      nowMs: nowMs + 60_000,
    })
    assert.deepEqual(crossDecision, { ok: false, reason: 'decision_mismatch' })

    // Tampered action fails signature check
    const tampered = data.replace('oc:a:', 'oc:d:')
    assert.deepEqual(
      verifyTelegramApprovalCallback({
        secret: 'tg-signing-secret',
        data: tampered,
        chatId: 123456789,
        nowMs,
      }),
      { ok: false, reason: 'invalid_signature' },
    )

    // Replaying in another chatId fails signature check
    assert.deepEqual(
      verifyTelegramApprovalCallback({
        secret: 'tg-signing-secret',
        data,
        chatId: 999999,
        nowMs,
      }),
      { ok: false, reason: 'invalid_signature' },
    )

    // Expired callback rejected
    assert.deepEqual(
      verifyTelegramApprovalCallback({
        secret: 'tg-signing-secret',
        data,
        chatId: 123456789,
        nowMs: nowMs + 11 * 60_000,
      }),
      { ok: false, reason: 'expired' },
    )
  })
})

describe('Telegram webhook fail-closed auth, operator binding & dedupe (B8)', () => {
  it('rejects missing/empty webhookSecret with 401 and enforces operatorUid binding + callback dedupe', async () => {
    const nowMs = 1_700_000_000_000
    const mock = makeMockFetch((url) => {
      if (url.endsWith('/getMe')) return { id: 1, is_bot: true, username: 'openclaude_bot' }
      return true
    })
    const api = new TelegramBotApi({ botToken: '12345:TEST', fetchImpl: mock.fetchImpl })

    // Missing/empty webhookSecret MUST fail closed (401), never allow unauthenticated public webhook!
    const noSecret = await handleTelegramWebhookPayload(
      { headers: {}, body: { update_id: 1 } },
      { api, webhookSecret: '' },
    )
    assert.equal(noSecret.status, 401)

    const card = buildTelegramApprovalCard({
      secret: 'cb-secret',
      chatId: -10099,
      decisionId: 'connector_write:11111111-1111-4111-8111-111111111111',
      code: '7312',
      title: '发布站点',
      summary: 'oc-site publish docs',
      expiresAtMs: nowMs + 5 * 60_000,
      nowMs,
    })
    const approveBtn = card.reply_markup.inline_keyboard[0]![0]!
    const seenCallbackIds = new Map<string, number>()

    // Missing resolveOperatorUid MUST refuse to call onApprovalCallback (fail-closed)
    let missingResolverCalls = 0
    const noResolver = await handleTelegramWebhookPayload(
      {
        headers: { [TELEGRAM_SECRET_HEADER]: 'expected-secret' },
        body: {
          update_id: 9,
          callback_query: {
            id: 'cq-no-resolver',
            from: { id: 4200, username: 'owner' },
            message: { message_id: 77, chat: { id: -10099, type: 'supergroup' } },
            data: approveBtn.callback_data,
          },
        },
      },
      {
        api,
        webhookSecret: 'expected-secret',
        callbackSecret: 'cb-secret',
        seenCallbackIds,
        now: () => nowMs + 500,
        onApprovalCallback: async () => {
          missingResolverCalls += 1
          return { ok: true, toastText: 'should never run' }
        },
      },
    )
    assert.equal(noResolver.body.reason, 'missing_operator_resolver')
    assert.equal(missingResolverCalls, 0)

    // Group bystander (from.id = 8888, unauthorized) -> rejected by resolveOperatorUid
    let callbackInvocations = 0
    const bystander = await handleTelegramWebhookPayload(
      {
        headers: { [TELEGRAM_SECRET_HEADER]: 'expected-secret' },
        body: {
          update_id: 10,
          callback_query: {
            id: 'cq-bystander',
            from: { id: 8888, username: 'stranger' },
            message: { message_id: 77, chat: { id: -10099, type: 'supergroup' } },
            data: approveBtn.callback_data,
          },
        },
      },
      {
        api,
        webhookSecret: 'expected-secret',
        callbackSecret: 'cb-secret',
        seenCallbackIds,
        now: () => nowMs + 1000,
        resolveOperatorUid: async ({ fromUserId }) => (fromUserId === '4200' ? '42' : null),
        onApprovalCallback: async () => {
          callbackInvocations += 1
          return { ok: true, toastText: 'ok' }
        },
      },
    )
    assert.equal(bystander.body.handled, 'callback_rejected')
    assert.equal(bystander.body.reason, 'operator_not_authorized')
    assert.equal(callbackInvocations, 0)

    // Transient failure MUST NOT mark callback_query.id committed -> retry succeeds, then duplicate is deduped!
    const ownerUpdate = {
      update_id: 11,
      callback_query: {
        id: 'cq-owner',
        from: { id: 4200, username: 'owner' },
        message: { message_id: 77, chat: { id: -10099, type: 'supergroup' } },
        data: approveBtn.callback_data,
      },
    }
    let failOnce = true
    const deps = {
      api,
      webhookSecret: 'expected-secret',
      callbackSecret: 'cb-secret',
      seenCallbackIds,
      now: () => nowMs + 2000,
      resolveOperatorUid: async ({ fromUserId }: { fromUserId: string }) =>
        fromUserId === '4200' ? '42' : null,
      resolveExpectedDecisionId: async () =>
        'connector_write:11111111-1111-4111-8111-111111111111',
      onApprovalCallback: async (ev: { operatorUid: string }) => {
        if (failOnce) {
          failOnce = false
          throw new Error('transient db glitch')
        }
        assert.equal(ev.operatorUid, '42')
        callbackInvocations += 1
        return { ok: true, toastText: '已批准 7312', updatedMessageText: '✅ 已批准 (7312)' }
      },
    }
    await assert.rejects(
      () =>
        handleTelegramWebhookPayload(
          { headers: { [TELEGRAM_SECRET_HEADER]: 'expected-secret' }, body: ownerUpdate },
          deps,
        ),
      /transient db glitch/,
    )
    // Retry of the exact same callback_query.id succeeds because transient failure was NOT marked committed!
    const first = await handleTelegramWebhookPayload(
      { headers: { [TELEGRAM_SECRET_HEADER]: 'expected-secret' }, body: ownerUpdate },
      deps,
    )
    assert.equal(first.body.handled, 'callback_resolved')
    assert.equal(callbackInvocations, 1)

    const dup = await handleTelegramWebhookPayload(
      { headers: { [TELEGRAM_SECRET_HEADER]: 'expected-secret' }, body: ownerUpdate },
      deps,
    )
    assert.equal(dup.body.handled, 'callback_duplicate_ignored')
    assert.equal(callbackInvocations, 1)
  })
})

describe('B9 — legacy CLI config defaults to polling & receives inbound messages', () => {
  it('telegramChannelFactory({ botToken, mentionRequired }) starts polling and dispatches message to ctx.dispatch', async () => {
    let delivered = false
    const mock = makeMockFetch((url) => {
      if (url.endsWith('/getMe')) return { id: 1, is_bot: true, username: 'legacy_oc_bot' }
      if (url.endsWith('/deleteWebhook')) return true
      if (url.endsWith('/getUpdates')) {
        if (!delivered) {
          delivered = true
          return [
            {
              update_id: 100,
              message: {
                message_id: 5,
                chat: { id: 4200, type: 'private' },
                from: { id: 4200, username: 'alice' },
                text: 'hello from legacy cli config',
              },
            },
          ]
        }
        return []
      }
      return true
    })

    // Exact CLI invocation shape from packages/cli/src/commands/gateway.ts:208-211
    const adapter = telegramChannelFactory({
      botToken: '12345:CLI_LEGACY',
      mentionRequired: true,
      pollIntervalMs: 20,
      pollTimeoutSec: 1,
      fetchImpl: mock.fetchImpl,
    })
    assert.equal(adapter.mode, 'polling')

    const dispatched: Array<{ content?: { text?: string }; peer?: { id?: string } }> = []
    await adapter.init({
      dispatch: (frame) => {
        dispatched.push(frame as { content?: { text?: string }; peer?: { id?: string } })
      },
      log: { info: () => {}, error: () => {} },
      config: {},
    })

    // Wait briefly for the first polling tick to complete
    for (let i = 0; i < 30 && dispatched.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 15))
    }
    await adapter.shutdown()

    assert.equal(dispatched.length, 1)
    assert.equal(dispatched[0]!.content?.text, 'hello from legacy cli config')
    assert.equal(dispatched[0]!.peer?.id, '4200')
  })

  it('webhook mode without webhookSecret throws fail-closed on init', async () => {
    const mock = makeMockFetch(() => true)
    const adapter = telegramChannelFactory({
      botToken: '12345:WH',
      mode: 'webhook',
      fetchImpl: mock.fetchImpl,
    })
    await assert.rejects(
      () =>
        adapter.init({
          dispatch: () => {},
          log: { info: () => {}, error: () => {} },
          config: {},
        }),
      /webhookSecret/,
    )
  })
})
