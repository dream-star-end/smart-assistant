/**
 * Run: npx tsx --test packages/channels/feishu/src/__tests__/feishuChannel.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  FEISHU_NONCE_HEADER,
  FEISHU_SIGNATURE_HEADER,
  FEISHU_TIMESTAMP_HEADER,
  buildFeishuApprovalCard,
  buildFeishuResolvedCard,
  computeFeishuSignature,
  decryptFeishuPayload,
  encryptFeishuPayload,
  feishuChannelFactory,
  handleFeishuWebhookPayload,
  parseFeishuApprovalCardCallback,
  verifyFeishuSignature,
} from '../index.js'

function makeSignedHeaders(rawBody: string, encryptKey: string, nowMs: number) {
  const ts = String(Math.floor(nowMs / 1000))
  const nonce = 'nonce-abc-123'
  const sig = computeFeishuSignature({ timestamp: ts, nonce, encryptKey, rawBody })
  return {
    [FEISHU_TIMESTAMP_HEADER]: ts,
    [FEISHU_NONCE_HEADER]: nonce,
    [FEISHU_SIGNATURE_HEADER]: sig,
  }
}

describe('Feishu crypto — signature, replay window & AES-256-CBC round-trip', () => {
  it('verifies valid signature, rejects tampered body, and rejects stale timestamps', () => {
    const nowMs = 1_700_000_000_000
    const rawBody = JSON.stringify({ type: 'url_verification', challenge: 'ch-1', token: 'vt-1' })
    const headers = makeSignedHeaders(rawBody, 'enc-key-secret', nowMs)

    assert.deepEqual(
      verifyFeishuSignature({ headers, rawBody, encryptKey: 'enc-key-secret', nowMs }),
      { ok: true },
    )
    assert.deepEqual(
      verifyFeishuSignature({
        headers,
        rawBody: `${rawBody} `,
        encryptKey: 'enc-key-secret',
        nowMs,
      }),
      { ok: false, reason: 'signature_mismatch' },
    )
    assert.deepEqual(
      verifyFeishuSignature({
        headers,
        rawBody,
        encryptKey: 'enc-key-secret',
        nowMs: nowMs + 10 * 60_000,
      }),
      { ok: false, reason: 'timestamp_out_of_window' },
    )
  })

  it('encrypts and decrypts Feishu AES-256-CBC envelopes cleanly', () => {
    const plain = JSON.stringify({ challenge: 'hello-feishu', token: 'vt-1' })
    const cipher = encryptFeishuPayload(plain, 'my-encrypt-key')
    assert.equal(decryptFeishuPayload(cipher, 'my-encrypt-key'), plain)
  })
})

describe('Feishu B8 hardening — fail-closed token, mandatory chat/operator, owner binding & eventId dedupe', () => {
  it('fails closed when verificationToken is empty and handles encrypted Challenge handshake', async () => {
    const nowMs = 1_700_000_000_000
    const emptyTokRes = await handleFeishuWebhookPayload(
      { headers: {}, rawBody: JSON.stringify({ type: 'url_verification', challenge: 'c1' }) },
      { verificationToken: '' },
    )
    assert.equal(emptyTokRes.status, 401)

    const encryptKey = 'feishu-enc-key'
    const inner = JSON.stringify({
      type: 'url_verification',
      token: 'feishu-verify-token',
      challenge: 'challenge-xyz-789',
    })
    const rawBody = JSON.stringify({ encrypt: encryptFeishuPayload(inner, encryptKey) })
    const headers = makeSignedHeaders(rawBody, encryptKey, nowMs)

    const okRes = await handleFeishuWebhookPayload(
      { headers, rawBody },
      { verificationToken: 'feishu-verify-token', encryptKey, now: () => nowMs },
    )
    assert.equal(okRes.status, 200)
    assert.deepEqual(okRes.body, { challenge: 'challenge-xyz-789' })
  })

  it('rejects missing open_chat_id (no self-fill), missing operator, unauthorized clicker, and replayed event_id', async () => {
    const nowMs = 1_700_000_000_000
    const signingSecret = 'card-hmac-secret'
    const card = buildFeishuApprovalCard({
      signingSecret,
      chatId: 'oc_chat_1',
      decisionId: 'connector_write:11111111-1111-4111-8111-111111111111',
      code: '4920',
      title: '发送外发邮件',
      summary: '收件人: partner@example.com',
      sourceLabel: '连接器外部写入',
      riskLevel: 'high',
      expiresAtMs: nowMs + 10 * 60_000,
      nowMs,
    })
    const actionBlock = card.elements[1] as { actions: Array<{ value: Record<string, unknown> }> }
    const approveValue = actionBlock.actions[0]!.value

    // Missing open_chat_id -> MUST reject (never self-fill from signed card value!)
    assert.deepEqual(
      parseFeishuApprovalCardCallback(
        {
          header: { event_type: 'card.action.trigger', token: 'vt-1' },
          event: {
            operator: { open_id: 'ou_alice' },
            context: {},
            action: { value: approveValue },
          },
        },
        { signingSecret, nowMs: nowMs + 1000 },
      ),
      { ok: false, reason: 'missing_chat_id' },
    )

    // Missing operator open_id -> MUST reject
    assert.deepEqual(
      parseFeishuApprovalCardCallback(
        {
          header: { event_type: 'card.action.trigger', token: 'vt-1' },
          event: {
            operator: {},
            context: { open_chat_id: 'oc_chat_1' },
            action: { value: approveValue },
          },
        },
        { signingSecret, nowMs: nowMs + 1000 },
      ),
      { ok: false, reason: 'missing_operator' },
    )

    const triggerPayload = {
      schema: '2.0',
      header: { event_id: 'ev-card-1', event_type: 'card.action.trigger', token: 'vt-1' },
      event: {
        operator: { open_id: 'ou_alice' },
        context: { open_chat_id: 'oc_chat_1' },
        action: { value: approveValue },
      },
    }

    // Unauthorized operator -> rejected by resolveOperatorUid
    let callbackCount = 0
    const seenEventIds = new Map<string, number>()
    const unauthOp = await handleFeishuWebhookPayload(
      { headers: {}, rawBody: JSON.stringify({ ...triggerPayload, header: { ...triggerPayload.header, event_id: 'ev-card-unauth' } }) },
      {
        verificationToken: 'vt-1',
        cardSigningSecret: signingSecret,
        seenEventIds,
        now: () => nowMs + 1000,
        resolveOperatorUid: async () => null,
        onApprovalCallback: async () => {
          callbackCount += 1
          return { ok: true, toastText: 'ok' }
        },
      },
    )
    assert.equal((unauthOp.body.toast as { type: string }).type, 'error')
    assert.equal(callbackCount, 0)

    // Missing resolveOperatorUid MUST refuse to call onApprovalCallback
    let noResolverCalls = 0
    const noResolverRes = await handleFeishuWebhookPayload(
      { headers: {}, rawBody: JSON.stringify({ ...triggerPayload, header: { ...triggerPayload.header, event_id: 'ev-no-resolver' } }) },
      {
        verificationToken: 'vt-1',
        cardSigningSecret: signingSecret,
        seenEventIds,
        now: () => nowMs + 500,
        onApprovalCallback: async () => {
          noResolverCalls += 1
          return { ok: true, toastText: 'should not run' }
        },
      },
    )
    assert.equal((noResolverRes.body.toast as { type: string }).type, 'error')
    assert.equal(noResolverCalls, 0)

    // Transient error MUST NOT mark event_id committed -> retry succeeds, then replay is deduped!
    let failOnce = true
    const authDeps = {
      verificationToken: 'vt-1',
      cardSigningSecret: signingSecret,
      seenEventIds,
      now: () => nowMs + 2000,
      resolveOperatorUid: async ({ operatorOpenId }: { operatorOpenId: string }) =>
        operatorOpenId === 'ou_alice' ? '42' : null,
      onApprovalCallback: async (ev: { code: string; action: 'approve' | 'deny'; operatorOpenId: string; operatorUid: string }) => {
        if (failOnce) {
          failOnce = false
          throw new Error('transient store error')
        }
        assert.equal(ev.operatorUid, '42')
        callbackCount += 1
        return {
          ok: true,
          toastText: `已批准 ${ev.code}`,
          updatedCard: buildFeishuResolvedCard({
            title: '发送外发邮件',
            code: ev.code,
            action: ev.action,
            operatorId: ev.operatorOpenId,
          }),
        }
      },
    }
    await assert.rejects(
      () => handleFeishuWebhookPayload({ headers: {}, rawBody: JSON.stringify(triggerPayload) }, authDeps),
      /transient store error/,
    )
    const first = await handleFeishuWebhookPayload(
      { headers: {}, rawBody: JSON.stringify(triggerPayload) },
      authDeps,
    )
    assert.equal((first.body.toast as { type: string }).type, 'success')
    assert.equal(callbackCount, 1)

    const replayed = await handleFeishuWebhookPayload(
      { headers: {}, rawBody: JSON.stringify(triggerPayload) },
      authDeps,
    )
    assert.equal(replayed.body.handled, 'duplicate_event_ignored')
    assert.equal(callbackCount, 1)
  })

  it('feishuChannelFactory rejects empty verificationToken on init, caches token, and dispatches inbound', async () => {
    const emptyAdapter = feishuChannelFactory({
      appId: 'cli_a',
      appSecret: 'sec_a',
      verificationToken: '   ',
    })
    await assert.rejects(
      () =>
        emptyAdapter.init({
          dispatch: () => {},
          log: { info: () => {}, error: () => {} },
          config: {},
        }),
      /verificationToken/,
    )

    let tokenCalls = 0
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).includes('tenant_access_token')) {
        tokenCalls += 1
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 't-abc', expire: 7200 }), {
          status: 200,
        })
      }
      return new Response(JSON.stringify({ code: 0, data: { message_id: 'om_123' } }), {
        status: 200,
      })
    }) as unknown as typeof fetch

    const dispatched: unknown[] = []
    const adapter = feishuChannelFactory({
      appId: 'cli_a',
      appSecret: 'sec_a',
      verificationToken: 'vt-1',
      fetchImpl,
    })
    await adapter.init({
      dispatch: (f) => dispatched.push(f),
      log: { info: () => {}, error: () => {} },
      config: {},
    })

    const inboundRes = await adapter.handleWebhook({
      headers: {},
      rawBody: JSON.stringify({
        schema: '2.0',
        header: { event_id: 'ev-1', event_type: 'im.message.receive_v1', token: 'vt-1' },
        event: {
          sender: { sender_id: { open_id: 'ou_1' } },
          message: {
            message_id: 'om_in_1',
            chat_id: 'oc_chat_1',
            chat_type: 'p2p',
            content: JSON.stringify({ text: '/pending' }),
          },
        },
      }),
    })
    assert.equal(inboundRes.body.handled, 'message_dispatched')
    assert.equal(dispatched.length, 1)

    await adapter.sendApprovalCard({
      chatId: 'oc_chat_1',
      decisionId: 'taskboard:tb-1@v1',
      code: '5511',
      title: '上线审批',
      summary: '确认发布',
    })
    await adapter.client.sendTextMessage('oc_chat_1', 'hello')
    assert.equal(tokenCalls, 1)
  })
})
