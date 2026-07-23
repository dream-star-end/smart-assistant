import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, test } from 'node:test'

import { type ContainerIdentityRepo, hashSecret } from '../auth/containerIdentity.js'
import {
  AUTO_DREAM_OPTIMIZER_ADMIT_PATH,
  AUTO_DREAM_OPTIMIZER_SETTLE_PATH,
  makeAutoDreamOptimizerHandler,
} from '../http/internalAutoDreamOptimizer.js'

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

async function call(path: string, raw: string): Promise<{ status: number; json: any }> {
  const req = Readable.from([Buffer.from(raw)]) as unknown as IncomingMessage
  Object.assign(req, {
    method: 'POST',
    headers: {
      authorization,
      'content-length': String(Buffer.byteLength(raw)),
    },
  })
  let status = 200
  let response = ''
  const res = {
    get statusCode() {
      return status
    },
    set statusCode(value: number) {
      status = value
    },
    setHeader() {},
    end(value?: string) {
      response = value ?? ''
    },
  } as unknown as ServerResponse
  const calls: unknown[] = []
  const handler = makeAutoDreamOptimizerHandler({
    identityRepo,
    runtimeRef: {
      current: {
        async handle(input) {
          calls.push(input)
          return { ok: true }
        },
      },
    },
  })
  await handler(req, res, { hostUuid: 'host-1', boundIp: '172.30.0.7' }, path)
  return { status, json: { ...(response ? JSON.parse(response) : {}), calls } }
}

function legacyBody(prompt: string): string {
  return JSON.stringify({
    runId: 'run-1',
    callId: 'call-1',
    agentId: 'main',
    model: 'gpt-5.6-terra',
    prompt,
    phase: 'map',
  })
}

describe('internal Auto-Dream legacy admission compatibility', () => {
  test('accepts the worst-case serialized 96k-code-unit legacy prompt on admit', async () => {
    const raw = legacyBody('\0'.repeat(96_000))
    assert.ok(Buffer.byteLength(raw) > 512 * 1024)
    assert.ok(Buffer.byteLength(raw) < 1024 * 1024)

    const result = await call(AUTO_DREAM_OPTIMIZER_ADMIT_PATH, raw)

    assert.equal(result.status, 200)
    assert.equal(result.json.ok, true)
    assert.equal(result.json.calls.length, 1)
  })

  test('keeps non-admission routes at the original 128 KiB limit', async () => {
    const result = await call(AUTO_DREAM_OPTIMIZER_SETTLE_PATH, legacyBody('x'.repeat(130 * 1024)))

    assert.equal(result.status, 400)
    assert.equal(result.json.error.code, 'AUTO_DREAM_INVALID_BODY_SIZE')
    assert.equal(result.json.calls.length, 0)
  })

  test('keeps admission memory bounded at 1 MiB', async () => {
    const result = await call(AUTO_DREAM_OPTIMIZER_ADMIT_PATH, legacyBody('\0'.repeat(180_000)))

    assert.equal(result.status, 400)
    assert.equal(result.json.error.code, 'AUTO_DREAM_INVALID_BODY_SIZE')
    assert.equal(result.json.calls.length, 0)
  })
})
