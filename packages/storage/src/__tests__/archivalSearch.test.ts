import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const testHome = await mkdtemp(join(tmpdir(), 'oc-archival-search-'))
process.env.OPENCLAUDE_HOME = testHome

const { archivalAdd, archivalSearch } = await import('../archivalStore.js')
const { closeSessionsDb } = await import('../sessionsDb.js')
const { hybridArchivalSearch } = await import('../vectorStore.js')

after(async () => {
  await closeSessionsDb()
  await rm(testHome, { recursive: true, force: true })
})

test('archival * lists only the requested agent, newest first, and obeys limit', async () => {
  const older = await archivalAdd('agent-a', 'older entry')
  await archivalAdd('agent-b', 'other agent entry')
  const newer = await archivalAdd('agent-a', 'newer entry')

  const direct = await archivalSearch('agent-a', '*', 1)
  assert.deepEqual(
    direct.map((row) => row.id),
    [newer],
  )
  assert.equal(direct[0].score, 1 / 61)

  const hybrid = await hybridArchivalSearch('agent-a', '*', null, 2)
  assert.deepEqual(
    hybrid.map((row) => row.id),
    [newer, older],
  )
  assert.ok(hybrid[0].score > hybrid[1].score)
  assert.deepEqual(
    hybrid.map(({ bm25Rank, vecRank }) => ({ bm25Rank, vecRank })),
    [
      { bm25Rank: null, vecRank: null },
      { bm25Rank: null, vecRank: null },
    ],
  )
  assert.deepEqual(await archivalSearch('agent-a', '---***', 5), [])
  assert.deepEqual(await hybridArchivalSearch('agent-a', '---***', null, 5), [])
})
