import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { PromptQueueSnapshot } from '@openclaude/protocol'

import { hashSecret, type ContainerIdentityRepo } from '../auth/containerIdentity.js'
import {
  PROMPT_QUEUE_CLAIM_PATH,
  PROMPT_QUEUE_MUTATION_PATH,
  PROMPT_QUEUE_SNAPSHOT_PATH,
  isPromptQueueV1Enabled,
  makePromptQueueHandler,
} from '../http/internalPromptQueue.js'

const secret = 'a'.repeat(64)
const authorization = `Bearer oc-v3.7.${secret}`
const identityRepo: ContainerIdentityRepo = {
  async findActiveByHostAndBoundIp() {
    return {
      id: 7,
      user_id: 42,
      bound_ip: '10.0.0.7',
      host_uuid: 'host-a',
      secret_hash: hashSecret(secret),
    }
  },
}
const owner = {
  sessionKey: 'agent:main:webchat:dm:peer-1',
  clientSessionId: 'peer-1',
  agentId: 'main',
  peer: { id: 'peer-1', kind: 'dm' },
}

interface CallResult {
  status: number
  headers: Record<string, string>
  json: Record<string, any>
}

async function call(
  handler: ReturnType<typeof makePromptQueueHandler>,
  path: string,
  body: unknown,
  opts: { auth?: string; declaredLength?: string; raw?: string; omitLength?: boolean } = {},
): Promise<CallResult> {
  const raw = opts.raw ?? JSON.stringify(body)
  const req = Readable.from(raw ? [Buffer.from(raw)] : []) as unknown as IncomingMessage
  const requestHeaders: Record<string, string> = {
    authorization: opts.auth === undefined ? authorization : opts.auth,
  }
  if (!opts.omitLength) {
    requestHeaders['content-length'] = opts.declaredLength ?? String(Buffer.byteLength(raw))
  }
  Object.assign(req, {
    method: 'POST',
    url: path,
    headers: requestHeaders,
  })
  let status = 200
  let response = ''
  let headersSent = false
  const headers: Record<string, string> = {}
  const res = {
    get headersSent() { return headersSent },
    get statusCode() { return status },
    set statusCode(value: number) { status = value },
    setHeader(name: string, value: string | number) { headers[name.toLowerCase()] = String(value) },
    end(value?: string) { response = value ?? ''; headersSent = true },
  } as unknown as ServerResponse
  await handler(req, res, { hostUuid: 'host-a', boundIp: '10.0.0.7' })
  return { status, headers, json: response ? JSON.parse(response) : {} }
}

function fakeStore() {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const snapshot: PromptQueueSnapshot = {
    type: 'outbound.prompt_queue.snapshot' as const,
    owner: { userId: '42', sessionKey: owner.sessionKey, clientSessionId: 'peer-1', agentId: 'main' },
    version: '0', activeTurn: null, items: [], serverTs: 1,
  }
  return {
    calls,
    store: {
      async mutate(...args: unknown[]) { calls.push({ method: 'mutate', args }); return { snapshot } },
      async getSnapshot(...args: unknown[]) { calls.push({ method: 'getSnapshot', args }); return snapshot },
      async getDetail(...args: unknown[]) {
        calls.push({ method: 'getDetail', args })
        return {
          owner: snapshot.owner,
          snapshotVersion: snapshot.version,
          itemId: 'x',
          state: 'queued',
          content: {},
          contentHash: 'a'.repeat(64),
          contentBytes: '0',
          requestedExecution: {},
          createdAt: 1,
          updatedAt: 1,
        }
      },
      async claim(...args: unknown[]) {
        calls.push({ method: 'claim', args })
        return { snapshot, outcome: 'empty' as const }
      },
    },
  }
}

describe('internalPromptQueue flag and trust boundary', () => {
  test('feature flag is strict opt-in only', () => {
    assert.equal(isPromptQueueV1Enabled({}), false)
    assert.equal(isPromptQueueV1Enabled({ OC_PROMPT_QUEUE_V1: 'true' }), false)
    assert.equal(isPromptQueueV1Enabled({ OC_PROMPT_QUEUE_V1: '0' }), false)
    assert.equal(isPromptQueueV1Enabled({ OC_PROMPT_QUEUE_V1: '1' }), true)
  })

  test('container identity is checked before a declared oversized body is read', async () => {
    const fake = fakeStore()
    const handler = makePromptQueueHandler({ identityRepo, store: fake.store })
    const result = await call(handler, PROMPT_QUEUE_MUTATION_PATH, {}, {
      auth: 'Bearer invalid',
      declaredLength: String(400 * 1024 * 1024),
    })
    assert.equal(result.status, 401)
    assert.equal(fake.calls.length, 0)
  })

  test('verified identity supplies userId and canonical owner reaches the store', async () => {
    const fake = fakeStore()
    const handler = makePromptQueueHandler({ identityRepo, store: fake.store })
    const result = await call(handler, PROMPT_QUEUE_SNAPSHOT_PATH, { owner })
    assert.equal(result.status, 200)
    assert.equal(fake.calls[0]?.method, 'getSnapshot')
    const storeOwner = fake.calls[0]?.args[0] as { userId: bigint; sessionKey: string }
    assert.equal(storeOwner.userId, 42n)
    assert.equal(storeOwner.sessionKey, owner.sessionKey)
  })

  test('wire userId, unknown fields and non-canonical session keys are rejected', async () => {
    const fake = fakeStore()
    const handler = makePromptQueueHandler({ identityRepo, store: fake.store })
    const topUser = await call(handler, PROMPT_QUEUE_SNAPSHOT_PATH, { owner, userId: '999' })
    assert.equal(topUser.status, 400)
    const unknown = await call(handler, PROMPT_QUEUE_SNAPSHOT_PATH, { owner: { ...owner, leaseOwner: 'evil' } })
    assert.equal(unknown.status, 400)
    const badSession = await call(handler, PROMPT_QUEUE_SNAPSHOT_PATH, {
      owner: { ...owner, sessionKey: 'agent:other:webchat:dm:peer-1' },
    })
    assert.equal(badSession.status, 400)
    assert.equal(fake.calls.length, 0)
  })

  test('field limits are measured in UTF-8 bytes', async () => {
    const fake = fakeStore()
    const handler = makePromptQueueHandler({ identityRepo, store: fake.store })
    const longAgent = '你'.repeat(22)
    const result = await call(handler, PROMPT_QUEUE_SNAPSHOT_PATH, {
      owner: {
        ...owner,
        agentId: longAgent,
        sessionKey: `agent:${longAgent}:webchat:dm:peer-1`,
      },
    })
    assert.equal(result.status, 400)
    assert.match(result.json.error.message, /agentId/)
  })

  test('small routes reject Content-Length before streaming', async () => {
    const fake = fakeStore()
    const handler = makePromptQueueHandler({ identityRepo, store: fake.store })
    const result = await call(handler, PROMPT_QUEUE_SNAPSHOT_PATH, { owner }, {
      declaredLength: String(9 * 1024),
    })
    assert.equal(result.status, 413)
    assert.equal(fake.calls.length, 0)
  })
})

describe('internalPromptQueue mutation and claim parsing', () => {
  test('valid P0 enqueue is cross-checked then forwarded', async () => {
    const fake = fakeStore()
    const handler = makePromptQueueHandler({ identityRepo, store: fake.store })
    const mutation = {
      type: 'inbound.prompt_queue.enqueue',
      peer: owner.peer,
      channel: 'webchat',
      agentId: 'main',
      itemId: 'item-1',
      clientMessageId: 'item-1',
      idempotencyKey: 'idem-1',
      content: { text: 'hello' },
      requestedExecution: {},
    }
    const result = await call(handler, PROMPT_QUEUE_MUTATION_PATH, { owner, mutation })
    assert.equal(result.status, 200)
    assert.equal(fake.calls[0]?.method, 'mutate')
  })

  test('mutation requires Content-Length for bounded memory admission', async () => {
    const fake = fakeStore()
    const handler = makePromptQueueHandler({ identityRepo, store: fake.store })
    const result = await call(handler, PROMPT_QUEUE_MUTATION_PATH, { owner, mutation: {} }, {
      omitLength: true,
    })
    assert.equal(result.status, 411)
    assert.equal(result.json.error.code, 'LENGTH_REQUIRED')
    assert.equal(fake.calls.length, 0)
  })

  test('mutation owner mismatch, unknown nested field and inline media are rejected', async () => {
    const fake = fakeStore()
    const handler = makePromptQueueHandler({ identityRepo, store: fake.store })
    const base = {
      type: 'inbound.prompt_queue.enqueue', peer: owner.peer, channel: 'webchat', agentId: 'main',
      itemId: 'item-1', clientMessageId: 'item-1', idempotencyKey: 'idem-1',
      content: { text: 'hello' }, requestedExecution: {},
    }
    assert.equal((await call(handler, PROMPT_QUEUE_MUTATION_PATH, {
      owner, mutation: { ...base, peer: { id: 'other', kind: 'dm' } },
    })).status, 400)
    assert.equal((await call(handler, PROMPT_QUEUE_MUTATION_PATH, {
      owner, mutation: { ...base, surprise: true },
    })).status, 400)
    assert.equal((await call(handler, PROMPT_QUEUE_MUTATION_PATH, {
      owner,
      mutation: {
        ...base,
        content: { media: [{ kind: 'image', url: `/api/media/${'a'.repeat(64)}.png`, base64: 'x' }] },
      },
    })).status, 400)
    assert.equal(fake.calls.length, 0)
  })

  test('acquire rejects forged owner/epoch/token fields; valid acquire gets verified container id', async () => {
    const fake = fakeStore()
    const handler = makePromptQueueHandler({ identityRepo, store: fake.store })
    const forged = await call(handler, PROMPT_QUEUE_CLAIM_PATH, {
      owner,
      claim: {
        action: 'acquire', expectedVersion: '0', leaseOwner: 'container:999',
        epoch: '999', claimToken: 'a'.repeat(64), ttlSeconds: 999,
      },
    })
    assert.equal(forged.status, 400)
    const valid = await call(handler, PROMPT_QUEUE_CLAIM_PATH, {
      owner, claim: { action: 'acquire', expectedVersion: '0' },
    })
    assert.equal(valid.status, 200)
    assert.equal(fake.calls[0]?.method, 'claim')
    assert.equal(fake.calls[0]?.args[1], 7)
  })
})
