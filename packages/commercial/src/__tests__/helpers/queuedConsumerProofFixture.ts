/**
 * Test-only fixture for the OCV5-121 hermetic deploy proof/tests.
 * No production consumer or export: this module owns only isolated test setup,
 * fake session rows and their tenant-scoped readback, never dispatch behavior.
 * The caller owns the Pool, DSN, search_path and schema lifecycle. Borrowing a
 * Pool client keeps each guard and operation on the same physical connection.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import type { Pool, PoolClient } from 'pg'

type SessionIdentity = { sessionId: string; userId: string }

export async function installQueuedConsumerProofFixture(input: { pool: Pool; schema: string }): Promise<{
  seedSession(input: SessionIdentity): Promise<void>
  readSessionMessages(input: SessionIdentity): Promise<string>
}> {
  const { pool, schema } = input
  assert.match(schema, /^oc_qconsumer_[a-f0-9]{32}$/, 'dedicated proof schema required')
  const guarded = async <T>(operation: (client: PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect()
    try {
      const scope = await client.query<{ schema: string; database: string }>(
        'SELECT current_schema() AS schema, current_database() AS database',
      )
      assert.equal(scope.rowCount, 1)
      assert.equal(scope.rows[0]!.schema, schema, 'fixture connection escaped its schema')
      assert.match(scope.rows[0]!.database, /^[a-zA-Z0-9_]+_test$/, 'fixture requires a test database')
      return await operation(client)
    } finally {
      client.release()
    }
  }

  await guarded(async client => {
    await client.query(`
      CREATE TABLE client_sessions (id text, user_id text, deleted_at bigint, messages text DEFAULT '[]', PRIMARY KEY(id,user_id));
      CREATE TABLE agent_containers (id bigint PRIMARY KEY, user_id bigint, state text, runtime_kind text);
      CREATE TABLE request_finalize_journal (request_id text PRIMARY KEY, ctx jsonb DEFAULT '{}', state text);
      CREATE TABLE usage_records (id bigint PRIMARY KEY);
      CREATE TABLE client_session_turn_tapes (tape_id text, session_id text, user_id text,
        finalized_at bigint, visible_at bigint, status text, part_count integer);
      CREATE TABLE client_session_turn_tape_parts (tape_id text, session_id text, user_id text);
      CREATE TABLE client_session_live_streams (stream_key text, dispatch_id uuid);
      CREATE TABLE client_session_live_frames (stream_key text, created_at timestamptz);
      CREATE TABLE turn_traces (trace_id text, user_id bigint, session_key text, first_visible_at timestamptz);
    `)
    for (const migration of [
      '0170_durable_turn_dispatch.sql',
      '0239_turn_dispatch_shutdown_ctx.sql',
      '0267_turn_dispatches_agent_container.sql',
    ]) {
      await client.query(await readFile(new URL('../../db/migrations/' + migration, import.meta.url), 'utf8'))
    }
    await client.query('ALTER TABLE turn_dispatches ADD COLUMN visible_head jsonb, ADD COLUMN visible_at bigint, ADD COLUMN producer_fenced_at timestamptz')
  })

  return {
    async seedSession({ sessionId, userId }) {
      await guarded(async client => {
        await client.query('INSERT INTO client_sessions(id,user_id) VALUES($1,$2)', [sessionId, userId])
      })
    },
    async readSessionMessages({ sessionId, userId }) {
      return guarded(async client => {
        const result = await client.query<{ messages: string }>(
          'SELECT messages FROM client_sessions WHERE id=$1 AND user_id=$2', [sessionId, userId],
        )
        assert.equal(result.rowCount, 1, 'exact fixture session must exist')
        assert.equal(typeof result.rows[0]!.messages, 'string')
        return result.rows[0]!.messages
      })
    },
  }
}
