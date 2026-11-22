/**
 * Unit tests for `verifyClientSessionOwnership()` (RFC D6b single-authority lookup).
 *
 * Run: npx tsx --test packages/storage/src/__tests__/verifyClientSessionOwnership.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, describe, it } from 'node:test'

const testHome = await mkdtemp(join(tmpdir(), 'oc-verify-owner-'))
process.env.OPENCLAUDE_HOME = testHome

const { closeSessionsDb, getSessionsDb, verifyClientSessionOwnership } = await import(
  '../sessionsDb.js'
)

async function seedSession(
  id: string,
  userId: string,
  deletedAt: number | null = null,
): Promise<void> {
  const db = await getSessionsDb()
  const now = Date.now()
  db.prepare(
    `INSERT INTO client_sessions
       (id, user_id, agent_id, title, pinned, created_at, last_at, messages, message_count, updated_at, deleted_at)
     VALUES (?, ?, 'main', 't', 0, ?, ?, '[]', 0, ?, ?)`,
  ).run(id, userId, now, now, now, deletedAt)
}

beforeEach(async () => {
  const db = await getSessionsDb()
  db.exec('DELETE FROM client_sessions')
})

after(async () => {
  await closeSessionsDb()
  await rm(testHome, { recursive: true, force: true })
})

describe('verifyClientSessionOwnership', () => {
  it('returns owner for matching active session, forbidden for another user, not_found for missing/deleted', async () => {
    await seedSession('sess-active', 'c:101')
    await seedSession('sess-deleted', 'c:101', Date.now())

    assert.equal(await verifyClientSessionOwnership('sess-active', 'c:101'), 'owner')
    assert.equal(await verifyClientSessionOwnership('sess-active', 'c:202'), 'forbidden')
    assert.equal(await verifyClientSessionOwnership('sess-deleted', 'c:101'), 'not_found')
    assert.equal(await verifyClientSessionOwnership('sess-missing', 'c:101'), 'not_found')
  })
})
