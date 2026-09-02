import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, test } from 'node:test'

import { type ContainerIdentityRepo, hashSecret } from '../auth/containerIdentity.js'
import {
  DELEGATE_ENGINE_BILLING_ADMIT_PATH,
  DELEGATE_ENGINE_BILLING_SETTLE_PATH,
  makeDelegateEngineBillingHandler,
} from '../http/internalDelegateEngineBilling.js'

const secret = 'ab'.repeat(32)
const authorization = `Bearer oc-v3.7.${secret}`
const identityRepo: ContainerIdentityRepo = {
  async findActiveByHostAndBoundIp() {
    return {
      id: 7,
      user_id: 42,
      bound_ip: '172.30.0.7',
      host_uuid: 'host-1',
      secret_hash: hashSecret(secret),
    }
  },
}

async function call(
  path: string,
  raw: string,
  options: {
    correlationId?: string
    runtimeResult?: Record<string, unknown>
    runtimeError?: Error
  } = {},
): Promise<{ status: number; json: any; headers: Record<string, string> }> {
  const req = Readable.from([Buffer.from(raw)]) as unknown as IncomingMessage
  Object.assign(req, {
    method: 'POST',
    headers: {
      authorization,
      'content-length': String(Buffer.byteLength(raw)),
      ...(options.correlationId ? { 'x-request-id': options.correlationId } : {}),
    },
  })
  let status = 200
  let response = ''
  const headers: Record<string, string> = {}
  const res = {
    get statusCode() {
      return status
    },
    set statusCode(value: number) {
      status = value
    },
    setHeader(name: string, value: string | number | readonly string[]) {
      headers[name.toLowerCase()] = String(value)
    },
    end(value?: string) {
      response = value ?? ''
    },
  } as unknown as ServerResponse
  const calls: unknown[] = []
  const handler = makeDelegateEngineBillingHandler({
    identityRepo,
    runtimeRef: {
      current: {
        async handle(input) {
          calls.push(input)
          if (options.runtimeError) throw options.runtimeError
          return options.runtimeResult ?? { ok: true }
        },
      },
    },
  })
  await handler(req, res, { hostUuid: 'host-1', boundIp: '172.30.0.7' }, path)
  return { status, json: { ...(response ? JSON.parse(response) : {}), calls }, headers }
}

describe('internal delegate engine-billing HTTP', () => {
  test('preserves the billing request id and keeps HTTP correlation in the header', async () => {
    const billingRequestId = 'a'.repeat(32)
    const correlationId = 'http-correlation-id'
    const result = await call(
      DELEGATE_ENGINE_BILLING_ADMIT_PATH,
      JSON.stringify({
        model: 'gpt-5.6-sol',
        engine: 'codex',
        agentId: 'auditor',
        delegateAgentId: 'auditor',
        sessionKey: 'agent:auditor:delegate:main:1',
      }),
      {
        correlationId,
        runtimeResult: {
          requestId: billingRequestId,
          engineSessionId: `oceng-${'b'.repeat(48)}`,
        },
      },
    )
    assert.equal(result.status, 200)
    assert.equal(result.json.requestId, billingRequestId)
    assert.equal(result.headers['x-request-id'], correlationId)
    assert.equal(result.json.calls.length, 1)
  })

  test('maps insufficient credits to HTTP 402', async () => {
    const result = await call(
      DELEGATE_ENGINE_BILLING_ADMIT_PATH,
      JSON.stringify({
        model: 'gpt-5.6-sol',
        engine: 'codex',
        agentId: 'auditor',
        delegateAgentId: 'auditor',
        sessionKey: 'agent:auditor:delegate:main:1',
      }),
      { runtimeError: new Error('DELEGATE_ENGINE_BILLING_INSUFFICIENT_CREDITS') },
    )
    assert.equal(result.status, 402)
    assert.equal(result.json.error.code, 'DELEGATE_ENGINE_BILLING_INSUFFICIENT_CREDITS')
  })

  test('keeps settle bodies under the 128 KiB cap', async () => {
    const result = await call(
      DELEGATE_ENGINE_BILLING_SETTLE_PATH,
      JSON.stringify({ requestId: 'a'.repeat(32), pad: 'x'.repeat(130 * 1024) }),
    )
    assert.equal(result.status, 400)
    assert.equal(result.json.error.code, 'DELEGATE_ENGINE_BILLING_INVALID_BODY_SIZE')
    assert.equal(result.json.calls.length, 0)
  })
})
