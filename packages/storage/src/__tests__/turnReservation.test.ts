import * as assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const testHome = await mkdtemp(join(tmpdir(), 'oc-turn-reservation-'))
process.env.OPENCLAUDE_HOME = testHome

const {
  closeSessionsDb,
  getSessionsDb,
  indexTurn,
  reserveTurnIndex,
  upsertSessionMeta,
} = await import('../sessionsDb.js')

after(async () => {
  await closeSessionsDb()
  await rm(testHome, { recursive: true, force: true })
})

test('reserveTurnIndex never reuses a slot across failures, lagging FTS, aliases, or reopen', async () => {
  const db = await getSessionsDb()
  assert.deepEqual(db.pragma('busy_timeout'), [{ timeout: 10_000 }])

  assert.equal(await reserveTurnIndex('webchat:alpha'), 1)
  assert.equal(await reserveTurnIndex('webchat:alpha'), 2)

  // An in-memory completion can be newer than the async FTS write.
  assert.equal(
    await reserveTurnIndex('webchat:alpha', { minimumLastTurn: 7 }),
    8,
  )

  // Seed from the historical pre-sessionKey FTS identity.
  await upsertSessionMeta({
    id: 'legacy-thread-id',
    agentId: 'main',
    channel: 'webchat',
    peerId: 'alpha',
    title: 'legacy',
    startedAt: 1,
    lastAt: 1,
    turnCount: 11,
    totalCostUSD: 0,
  })
  await indexTurn('legacy-thread-id', 11, 'u', 'a')
  assert.equal(
    await reserveTurnIndex('webchat:beta', { legacySessionIds: ['legacy-thread-id'] }),
    12,
  )

  // A process-style close/reopen still advances the committed reservation,
  // including when no output row was ever indexed for slot 12.
  await closeSessionsDb()
  assert.equal(await reserveTurnIndex('webchat:beta'), 13)
})
