/**
 * Tests for `getMaxTurnIdx`, used by SessionManager.submit() to resume the
 * per-session turn counter on the first turn of a fresh in-memory Session.
 * Without this, every gateway/CCB process restart would re-write turn_idx
 * 1, 2, 3 … into sessions_fts, colliding with already-persisted rows for
 * the same sessionKey and confusing the frontend's per-(session_id, turn_idx)
 * dedupe.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/getMaxTurnIdx.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { before, describe, it } from 'node:test'

// Point OPENCLAUDE_HOME at a fresh dir BEFORE importing storage so that
// `paths` (captured at module-load time) resolves to it.
const testHome = await mkdtemp(join(tmpdir(), 'oc-getmaxturnidx-'))
process.env.OPENCLAUDE_HOME = testHome

// Import the workspace source directly rather than through the
// `@openclaude/storage` package alias. In some workspace setups
// `node_modules/@openclaude` is a symlink that resolves outside the current
// worktree, which would test the wrong copy of the source.
const { getMaxTurnIdx, indexTurn, upsertSessionMeta } = await import(
  '../../../storage/src/sessionsDb.js'
)

describe('getMaxTurnIdx', () => {
  before(async () => {
    // Touch the DB once so subsequent calls hit the same prepared statements.
    await getMaxTurnIdx(['warmup-key'])
  })

  it('returns 0 for a sessionKey with no FTS history', async () => {
    const m = await getMaxTurnIdx(['agent:main:webchat:dm:web-empty-session'])
    assert.equal(m, 0)
  })

  it('returns 0 for an empty id array', async () => {
    // API contract: empty input returns 0 to avoid invalid `IN ()` SQL.
    // SessionManager always passes at least [sessionKey] today, but the
    // guard makes this safe for future callers.
    assert.equal(await getMaxTurnIdx([]), 0)
  })

  it('returns the max turn_idx already written by indexTurn', async () => {
    const sessId = 'agent:main:webchat:dm:web-history-session'
    // Seed both sessions_meta (mirrors prod write path — gateway upserts meta
    // and indexes FTS together at turn.completed) and sessions_fts. Using only
    // a bare FTS row would bypass orphan cleanup and be misleading.
    await upsertSessionMeta({
      id: sessId,
      agentId: 'main',
      channel: 'webchat',
      peerId: 'web-history-session',
      title: 'historical conv',
      startedAt: 1_700_000_000_000,
      lastAt: 1_700_000_005_000,
      turnCount: 5,
      totalCostUSD: 0,
    })
    await indexTurn(sessId, 1, 'user line 1', 'assistant line 1')
    await indexTurn(sessId, 3, 'user line 3', 'assistant line 3')
    await indexTurn(sessId, 5, 'user line 5', 'assistant line 5')

    const m = await getMaxTurnIdx([sessId])
    assert.equal(m, 5)
  })

  it('isolates max per sessionKey (no cross-session bleed)', async () => {
    const sessA = 'agent:main:webchat:dm:web-iso-A'
    const sessB = 'agent:main:webchat:dm:web-iso-B'
    await indexTurn(sessA, 7, 'A user', 'A assistant')
    await indexTurn(sessB, 2, 'B user', 'B assistant')
    assert.equal(await getMaxTurnIdx([sessA]), 7)
    assert.equal(await getMaxTurnIdx([sessB]), 2)
  })

  it('returns an integer even when turn_idx is stored as REAL', async () => {
    const sessId = 'agent:main:webchat:dm:web-realtype'
    // FTS columns are typeless; better-sqlite3 stores JS numbers as REAL.
    // Math.floor in getMaxTurnIdx() guards downstream callers that
    // increment + use as an integer turn counter.
    await indexTurn(sessId, 4, 'u', 'a')
    const m = await getMaxTurnIdx([sessId])
    assert.equal(m, 4)
    assert.equal(Number.isInteger(m), true)
  })

  it('returns global max across multiple ids (legacy ccbSessionId fallback)', async () => {
    // Mirrors the post-fix legacy path: pre-existing rows live under
    // ccbSessionId; new rows under sessionKey. SessionManager passes both,
    // and the resumed turn counter must be the global max so the next turn
    // doesn't collide with either side.
    const sessKey = 'agent:main:webchat:dm:web-legacy-merge'
    const legacyId = 'ccb-uuid-legacy-for-merge'
    await indexTurn(legacyId, 9, 'legacy u', 'legacy a')
    await indexTurn(sessKey, 2, 'new u', 'new a')
    assert.equal(await getMaxTurnIdx([sessKey]), 2)
    assert.equal(await getMaxTurnIdx([legacyId]), 9)
    assert.equal(await getMaxTurnIdx([sessKey, legacyId]), 9)
  })
})
