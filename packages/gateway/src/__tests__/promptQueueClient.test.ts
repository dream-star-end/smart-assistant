import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { type Server, createServer } from 'node:http'
import { after, before, describe, test } from 'node:test'

import {
  HttpPromptQueueClient,
  PromptQueueClientError,
  type PromptQueueWireOwner,
} from '../promptQueueClient.js'

const owner: PromptQueueWireOwner = {
  sessionKey: 'agent:main:webchat:dm:peer-1',
  clientSessionId: 'peer-1',
  agentId: 'main',
  peer: { id: 'peer-1', kind: 'dm' },
}

const snapshot = (userId = '42', version = '9007199254740993123456789') => ({
  type: 'outbound.prompt_queue.snapshot',
  owner: {
    userId,
    sessionKey: owner.sessionKey,
    clientSessionId: owner.clientSessionId,
    agentId: owner.agentId,
  },
  version,
  activeTurn: null,
  items: [],
  serverTs: 1,
})

describe('HttpPromptQueueClient strict P1 boundary', () => {
  let server: Server
  let baseUrl = ''
  let response: unknown

  before(async () => {
    server = createServer((_request, outgoing) => {
      const encoded = JSON.stringify(response)
      outgoing.writeHead(200, {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(encoded)),
      })
      outgoing.end(encoded)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const client = () => new HttpPromptQueueClient({ baseUrl, bearer: 'secret', userId: '42' })

  test('preserves canonical decimal versions beyond Number precision', async () => {
    response = { ok: true, snapshot: snapshot() }
    const value = await client().snapshot(owner)
    assert.equal(value.version, '9007199254740993123456789')
  })

  test('rejects owner drift, unknown response fields and non-canonical decimals', async () => {
    response = { ok: true, snapshot: snapshot('43') }
    await assert.rejects(client().snapshot(owner), PromptQueueClientError)

    response = { ok: true, snapshot: { ...snapshot(), guessedReceipt: true } }
    await assert.rejects(client().snapshot(owner), PromptQueueClientError)

    response = { ok: true, snapshot: snapshot('42', '01') }
    await assert.rejects(client().snapshot(owner), PromptQueueClientError)
  })

  test('detail uses the attachment-sized response budget and validates the exact item', async () => {
    const largeText = 'x'.repeat(3 * 1024 * 1024)
    const canonical = JSON.stringify({ text: largeText })
    response = {
      ok: true,
      detail: {
        owner: snapshot().owner,
        snapshotVersion: '9',
        itemId: 'item-1',
        clientMessageId: 'message-1',
        state: 'dispatch_claimed',
        content: { text: largeText },
        contentHash: createHash('sha256').update(canonical).digest('hex'),
        contentBytes: String(Buffer.byteLength(canonical)),
        attachments: [],
        requestedExecution: { agentId: 'main' },
        createdAt: 1,
        updatedAt: 2,
      },
    }
    const detail = await client().detail(owner, 'item-1')
    assert.equal((detail.content.text as string).length, largeText.length)

    await assert.rejects(client().detail(owner, 'different-item'), PromptQueueClientError)
  })
})
