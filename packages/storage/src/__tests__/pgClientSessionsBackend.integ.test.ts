import * as assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { Pool } from 'pg'
import {
  createPgClientSessionsBackend,
  createPgClientSessionsSchema,
} from '../pgClientSessionsBackend.js'

const url = process.env.OPENCLAUDE_TEST_PG_URL

describe('PostgreSQL personal session backend', { skip: !url }, () => {
  const pool = new Pool({ connectionString: url })
  const backend = createPgClientSessionsBackend(pool)

  before(async () => {
    await createPgClientSessionsSchema(pool)
    await pool.query(
      'TRUNCATE client_session_tape_payload_parts, client_session_tape, client_session_turns, client_session_tombstones, client_sessions',
    )
    await pool.query(
      'UPDATE client_sessions_authority SET mutation_count=0, first_mutation_at=NULL WHERE singleton=TRUE',
    )
    await backend.probe()
  })

  after(async () => {
    await pool.end()
  })

  it('keeps tape-before-session counters and complete turn paging exact', async () => {
    await backend.appendClientSessionTapeFrame({
      sessionId: 'pg-tape-first',
      userId: 'owner',
      turnKey: 'turn-1',
      direction: 'inbound',
      ts: 10,
      frame: { type: 'inbound.message', clientMessage: { id: 'u1' } },
    })
    await backend.appendClientSessionTapeFrame({
      sessionId: 'pg-tape-first',
      userId: 'owner',
      turnKey: 'turn-1',
      direction: 'outbound',
      ts: 11,
      frame: { type: 'outbound.message', blocks: [{ kind: 'text', text: '完整回答' }] },
    })
    assert.equal(
      await backend.upsertClientSession({
        id: 'pg-tape-first',
        userId: 'owner',
        agentId: 'codex',
        title: 'PG tape',
        pinned: false,
        createdAt: 1,
        lastAt: 11,
        updatedAt: 12,
        messages: [],
      }),
      true,
    )
    const meta = (await backend.listClientSessions('owner'))[0]
    assert.equal(meta.tapeTurnCount, 1)
    assert.equal(meta.lastTapeSeq, 2)
    const page = await backend.listClientSessionTapePage('pg-tape-first', 'owner', { turns: 1 })
    assert.deepEqual(
      page?.frames.map((frame) => frame.tapeSeq),
      [1, 2],
    )
    const blocks = page?.frames[1]?.frame.blocks as Array<{ text?: string }> | undefined
    assert.equal(blocks?.[0]?.text, '完整回答')
    const payload = await backend.readClientSessionTapePayload('pg-tape-first', 'owner', 2)
    assert.ok(payload)
    assert.equal(payload.bytes, payload.payload.byteLength)
    assert.equal(payload.sha256.length, 64)
    assert.equal(JSON.parse(payload.payload.toString('utf8')).blocks[0].text, '完整回答')
  })

  it('records exact turn outcomes and advances the authority mutation fence', async () => {
    await backend.recordClientTurnState({
      sessionId: 'pg-tape-first',
      userId: 'owner',
      clientMessageId: 'submit-1',
      state: 'running',
      startedAt: 20,
    })
    await backend.recordClientTurnState({
      sessionId: 'pg-tape-first',
      userId: 'owner',
      clientMessageId: 'submit-1',
      state: 'completed',
      startedAt: 20,
      finishedAt: 30,
    })
    assert.deepEqual(await backend.getClientTurnState('pg-tape-first', 'owner', 'submit-1'), {
      clientMessageId: 'submit-1',
      state: 'completed',
      startedAt: 20,
      finishedAt: 30,
    })
    const fence = await pool.query(
      'SELECT mutation_count, first_mutation_at FROM client_sessions_authority WHERE singleton=TRUE',
    )
    assert.ok(Number(fence.rows[0].mutation_count) > 0)
    assert.ok(Number(fence.rows[0].first_mutation_at) > 0)
  })

  it('appends a legacy server-authored message without dropping existing history', async () => {
    const sessionId = 'pg-legacy-append'
    const history = [
      { id: 'legacy-user-1', role: 'user', text: '第一问', ts: 1 },
      { id: 'legacy-assistant-1', role: 'assistant', text: '第一答', ts: 2 },
      { id: 'legacy-user-2', role: 'user', text: '第二问', ts: 3 },
    ]
    assert.equal(
      await backend.upsertClientSession({
        id: sessionId,
        userId: 'owner',
        agentId: 'codex',
        title: 'legacy append',
        pinned: false,
        createdAt: 1,
        lastAt: 3,
        updatedAt: 4,
        messages: history,
      }),
      true,
    )
    assert.deepEqual(
      await backend.appendServerAuthoredMessage(sessionId, 'owner', {
        id: 'legacy-assistant-2',
        role: 'assistant',
        text: '第二答',
        ts: 4,
      }),
      { applied: true },
    )
    const stored = await backend.getClientSession(sessionId, 'owner')
    assert.ok(stored)
    assert.deepEqual(
      (stored.messages as Array<{ id?: string; text?: string }>).map((message) => [
        message.id,
        message.text,
      ]),
      [
        ['legacy-user-1', '第一问'],
        ['legacy-assistant-1', '第一答'],
        ['legacy-user-2', '第二问'],
        ['legacy-assistant-2', '第二答'],
      ],
    )
  })

  it('preserves deletion through a tombstone', async () => {
    assert.equal(await backend.deleteClientSession('pg-tape-first', 'owner'), true)
    assert.equal(await backend.getClientSession('pg-tape-first', 'owner'), null)
    const tombstone = await pool.query(
      `SELECT deleted_at,last_tape_seq FROM client_session_tombstones
       WHERE session_id='pg-tape-first' AND user_id='owner'`,
    )
    assert.equal(tombstone.rowCount, 1)
    assert.equal(Number(tombstone.rows[0].last_tape_seq), 2)
  })
})
