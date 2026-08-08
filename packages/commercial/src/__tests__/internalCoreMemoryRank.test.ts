import * as assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, test } from 'node:test'

import { hashSecret, type ContainerIdentityRepo } from '../auth/containerIdentity.js'
import { CoreMemoryRankQueue } from '../http/coreMemoryLocalRanker.js'
import {
  CORE_MEMORY_RANK_PATH,
  makeCoreMemoryRankHandler,
} from '../http/internalCoreMemoryRank.js'

const SECRET = 'a'.repeat(64)
const TOKEN = `oc-v3.7.${SECRET}`
const CTX = { hostUuid: 'host-1', boundIp: '172.31.0.7' }

function identityRepo(): ContainerIdentityRepo {
  return {
    async findActiveByHostAndBoundIp(hostUuid, boundIp) {
      return {
        id: 7,
        user_id: 42,
        bound_ip: boundIp,
        host_uuid: hostUuid,
        secret_hash: hashSecret(SECRET),
      }
    },
  }
}

function makeReq(body: unknown, auth = `Bearer ${TOKEN}`, method = 'POST'): IncomingMessage {
  const raw = JSON.stringify(body)
  const req = Readable.from([Buffer.from(raw)]) as unknown as IncomingMessage
  req.method = method
  req.url = CORE_MEMORY_RANK_PATH
  req.headers = auth ? { authorization: auth } : {}
  return req
}

function makeRes(): ServerResponse & { body?: any; headers: Record<string, unknown> } {
  const emitter = new EventEmitter() as ServerResponse & {
    body?: any
    headers: Record<string, unknown>
  }
  emitter.statusCode = 0
  emitter.headers = {}
  emitter.destroyed = false
  ;(emitter as any).setHeader = (key: string, value: unknown) => {
    emitter.headers[key.toLowerCase()] = value
    return emitter
  }
  ;(emitter as any).end = (body?: string) => {
    emitter.body = body ? JSON.parse(body) : undefined
    return emitter
  }
  return emitter
}

describe('internal Core memory rank handler', () => {
  test('authenticates container and returns only local scores', async () => {
    const calls: unknown[] = []
    const handler = makeCoreMemoryRankHandler({
      identityRepo: identityRepo(),
      rankQueue: {
        async rank(query, documents) {
          calls.push({ query, documents })
          return documents.map((document, index) => ({ id: document.id, score: 0.91 - index / 100 }))
        },
      },
    })
    const res = makeRes()
    await handler(
      makeReq({
        query: 'How should I write?',
        documents: [
          { id: '0', text: 'The user prefers concise answers.' },
          { id: '1', text: 'A deployment note.' },
        ],
      }),
      res,
      CTX,
    )
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.ok, true)
    assert.deepEqual(res.body.ranked, [
      { id: '0', score: 0.91 },
      { id: '1', score: 0.9 },
    ])
    assert.equal(calls.length, 1)
  })

  test('rejects unauthenticated and malformed requests before ranking', async () => {
    let calls = 0
    const handler = makeCoreMemoryRankHandler({
      identityRepo: identityRepo(),
      rankQueue: {
        async rank() {
          calls++
          return []
        },
      },
    })

    let res = makeRes()
    await handler(makeReq({ query: 'q', documents: [{ id: '0', text: 'x' }] }, ''), res, CTX)
    assert.equal(res.statusCode, 401)

    res = makeRes()
    await handler(makeReq({ query: 'q', documents: [] }), res, CTX)
    assert.equal(res.statusCode, 400)

    res = makeRes()
    await handler(
      makeReq({ query: 'q', documents: [{ id: 'same', text: 'a' }, { id: 'same', text: 'b' }] }),
      res,
      CTX,
    )
    assert.equal(res.statusCode, 400)
    assert.equal(calls, 0)
  })

  test('does not write query or Core text to logs', async () => {
    const events: unknown[] = []
    const logger: any = {
      child(fields: unknown) {
        events.push(fields)
        return this
      },
      info(event: string, fields: unknown) {
        events.push({ event, fields })
      },
      warn(event: string, fields: unknown) {
        events.push({ event, fields })
      },
    }
    const handler = makeCoreMemoryRankHandler({
      identityRepo: identityRepo(),
      logger,
      rankQueue: { async rank() { return [{ id: '0', score: 0.9 }] } },
    })
    const res = makeRes()
    await handler(
      makeReq({ query: 'PRIVATE-QUERY-7391', documents: [{ id: '0', text: 'PRIVATE-CORE-2486' }] }),
      res,
      CTX,
    )
    const logged = JSON.stringify(events)
    assert.doesNotMatch(logged, /PRIVATE-QUERY-7391|PRIVATE-CORE-2486/)
  })
})

test('Core memory rank queue is FIFO and immediately releases cancelled queued work', async () => {
  const order: string[] = []
  let releaseFirst!: () => void
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve })
  const queue = new CoreMemoryRankQueue(async (query, documents) => {
    order.push(query)
    if (query === 'first') await firstBlocked
    return documents.map((document) => ({ id: document.id, score: 0.9 }))
  })
  const doc = [{ id: '0', text: 'memory' }]
  const first = queue.rank('first', doc, undefined, 'owner-first')
  const abort = new AbortController()
  const cancelled = queue.rank('cancelled', doc, abort.signal, 'owner-cancelled')
  abort.abort()
  await assert.rejects(cancelled, /cancelled/)
  // The cancelled owner can immediately reuse its pending slot before the
  // active inference finishes, proving the private queued payload was removed.
  const third = queue.rank('third', doc, undefined, 'owner-cancelled')
  releaseFirst()
  await first
  await third
  assert.deepEqual(order, ['first', 'third'])
})

test('Core memory rank queue bounds global and per-user pending requests', async () => {
  let releaseFirst!: () => void
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve })
  const queue = new CoreMemoryRankQueue(async (query, documents) => {
    if (query === 'active') await firstBlocked
    return documents.map((document) => ({ id: document.id, score: 0.9 }))
  })
  const doc = [{ id: '0', text: 'memory' }]
  const active = queue.rank('active', doc, undefined, 'active-owner')
  const sameOwnerPending = queue.rank('same-owner-1', doc, undefined, 'same-owner')
  await assert.rejects(
    queue.rank('same-owner-2', doc, undefined, 'same-owner'),
    /queue saturated/,
  )

  const pending = [sameOwnerPending]
  for (let index = 0; index < 7; index++) {
    pending.push(queue.rank(`pending-${index}`, doc, undefined, `owner-${index}`))
  }
  await assert.rejects(queue.rank('global-overflow', doc, undefined, 'overflow'), /queue saturated/)
  releaseFirst()
  await active
  await Promise.all(pending)
})
