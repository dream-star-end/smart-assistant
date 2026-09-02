/**
 * engine-reported 委派计费客户端:admit 字段白名单、32-hex 校验、
 * settle/abandon 路径。不打 live master。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/delegateEngineBilling.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createDelegateEngineBillingClient,
  shouldAdmitDelegateEngineBilling,
} from '../delegateEngineBilling.js'

function response(statusCode: number, body: unknown) {
  return {
    statusCode,
    body: {
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify(body))
      },
    },
  }
}

const ENV = {
  OPENCLAUDE_V3_MASTER_BASE_URL: 'https://master.invalid',
  OPENCLAUDE_V3_CONTAINER_TOKEN: 'container-token',
}

describe('shouldAdmitDelegateEngineBilling', () => {
  it('admits catalog engine codex/grok and skips ccb', () => {
    assert.equal(shouldAdmitDelegateEngineBilling({ delegateEngine: 'codex' }), true)
    assert.equal(shouldAdmitDelegateEngineBilling({ delegateEngine: 'grok' }), true)
    assert.equal(shouldAdmitDelegateEngineBilling({ delegateEngine: 'ccb' }), false)
    assert.equal(shouldAdmitDelegateEngineBilling({ delegateEngine: 'cursor' }), false)
  })

  it('falls back to baked model ids when engine is unknown', () => {
    assert.equal(shouldAdmitDelegateEngineBilling({ requestedModel: 'gpt-5.6-sol' }), true)
    assert.equal(shouldAdmitDelegateEngineBilling({ requestedModel: 'grok-build' }), true)
    assert.equal(shouldAdmitDelegateEngineBilling({ requestedModel: 'glm-5.3-zai' }), false)
    assert.equal(shouldAdmitDelegateEngineBilling({ agentModel: 'gpt-5.6-sol-1m' }), true)
  })
})

describe('createDelegateEngineBillingClient', () => {
  it('fails closed when the master channel env is missing', async () => {
    const client = createDelegateEngineBillingClient({ env: {} })
    await assert.rejects(
      () =>
        client.admit({
          model: 'gpt-5.6-sol',
          engine: 'codex',
          agentId: 'auditor',
          delegateAgentId: 'auditor',
          sessionKey: 'agent:auditor:delegate:main:1',
        }),
      /MASTER_NOT_CONFIGURED/,
    )
  })

  it('posts admit fields and requires a 32-hex requestId', async () => {
    let posted = ''
    const client = createDelegateEngineBillingClient({
      env: ENV,
      fetcher: (async (url: string, options: { body: string }) => {
        assert.equal(new URL(url).pathname, '/internal/v3/delegate/engine-billing/admit')
        posted = options.body
        return response(200, {
          requestId: 'a'.repeat(32),
          engineSessionId: `oceng-${'b'.repeat(48)}`,
        })
      }) as any,
    })
    const admission = await client.admit({
      model: 'grok-build',
      engine: 'grok',
      agentId: 'auditor',
      delegateAgentId: 'auditor',
      sessionKey: 'agent:auditor:delegate:main:1',
      parentSessionId: 'web-parent',
      parentTurnKey: 'c'.repeat(64),
    })
    assert.equal(admission.requestId, 'a'.repeat(32))
    assert.deepEqual(JSON.parse(posted), {
      model: 'grok-build',
      engine: 'grok',
      agentId: 'auditor',
      delegateAgentId: 'auditor',
      sessionKey: 'agent:auditor:delegate:main:1',
      parentSessionId: 'web-parent',
      parentTurnKey: 'c'.repeat(64),
    })
  })

  it('rejects a non-hex admission requestId', async () => {
    const client = createDelegateEngineBillingClient({
      env: ENV,
      fetcher: (async () => response(200, { requestId: 'not-hex', engineSessionId: 'x' })) as any,
    })
    await assert.rejects(
      () =>
        client.admit({
          model: 'gpt-5.6-sol',
          engine: 'codex',
          agentId: 'auditor',
          delegateAgentId: 'auditor',
          sessionKey: 'agent:auditor:delegate:main:1',
        }),
      /ADMISSION_INVALID/,
    )
  })

  it('settle and abandon post the requestId', async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = []
    const client = createDelegateEngineBillingClient({
      env: ENV,
      fetcher: (async (url: string, options: { body: string }) => {
        calls.push({
          path: new URL(url).pathname,
          body: JSON.parse(options.body) as Record<string, unknown>,
        })
        return response(200, { ok: true })
      }) as any,
    })
    const requestId = 'd'.repeat(32)
    await client.settle({
      requestId,
      engineSessionId: `oceng-${'e'.repeat(48)}`,
      status: 'success',
      durationMs: 9,
      delegateAgentId: 'auditor',
    })
    await client.abandon(requestId)
    assert.equal(calls[0]?.path, '/internal/v3/delegate/engine-billing/settle')
    assert.equal(calls[0]?.body.requestId, requestId)
    assert.equal(calls[0]?.body.delegateAgentId, 'auditor')
    assert.equal(calls[1]?.path, '/internal/v3/delegate/engine-billing/abandon')
    assert.equal(calls[1]?.body.requestId, requestId)
  })
})
