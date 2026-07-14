import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  CONTAINER_PREVIEW_TICKET_TTL_MS,
  ContainerPreviewTicketStore,
} from '../ws/containerPreviewTickets.js'

describe('ContainerPreviewTicketStore', () => {
  test('ticket is one-use, delete-before-return and stored only by SHA-256', () => {
    const now = 1_760_000_000_000
    const store = new ContainerPreviewTicketStore(() => now)
    const issued = store.issue(42n, 'http://0.0.0.0:3000/app#x', undefined)
    assert.equal(issued.ticket.length, 32)
    assert.equal(issued.url, 'http://127.0.0.1:3000/app')

    const records = (store as unknown as { records: Map<string, unknown> }).records
    assert.equal(records.has(issued.ticket), false)
    assert.match([...records.keys()][0] ?? '', /^[0-9a-f]{64}$/)

    assert.deepEqual(store.consume(issued.ticket), {
      uid: 42n,
      url: issued.url,
      viewport: issued.viewport,
      expiresAt: now + CONTAINER_PREVIEW_TICKET_TTL_MS,
    })
    assert.equal(store.consume(issued.ticket), null)
  })

  test("new ticket revokes the user's prior ticket and expiry is fail-closed", () => {
    let now = 1_760_000_000_000
    const store = new ContainerPreviewTicketStore(() => now)
    const first = store.issue(42n, 'http://localhost:3000/', undefined)
    const second = store.issue(42n, 'http://localhost:3001/', undefined)
    assert.equal(store.consume(first.ticket), null)
    now += CONTAINER_PREVIEW_TICKET_TTL_MS
    assert.equal(store.consume(second.ticket), null)
    assert.equal(store.size, 0)
  })

  test('platform and administrative listeners never receive a ticket', () => {
    const store = new ContainerPreviewTicketStore()
    for (const port of [22, 5432, 6379, 18789]) {
      assert.throws(() => store.issue(42n, `http://localhost:${port}/`, undefined))
    }
  })
})
