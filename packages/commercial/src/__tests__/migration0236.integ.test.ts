import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { query } from '../db/queries.js'
import { insertMemoryUsageEvents } from '../http/internalMemoryUsage.js'
import { useDedicatedTestDatabase } from './helpers/db.js'

useDedicatedTestDatabase('memory_usage_0236_test')

describe('0236 memory usage observability', () => {
  test('stores privacy-safe events and exposes daily aggregate view', async () => {
    const user = await query<{ id: string }>(
      `INSERT INTO users(email,email_verified,password_hash,role,credits,status)
       VALUES ('memory-usage-0236@example.test',TRUE,'x','user',1000,'active')
       RETURNING id::text`,
    )
    const deps = {
      identityRepo: {} as never,
      queryRunner: {
        async query<Row = unknown>(sql: string, params?: readonly unknown[]) {
          return (await query(sql, params)) as unknown as {
            rows: Row[]
            rowCount: number | null
          }
        },
      },
    }
    const timestamp = Date.now()
    const inserted = await insertMemoryUsageEvents(deps, Number(user.rows[0]!.id), 1, [
      {
        schemaVersion: 1,
        eventId: 'mem-0236-1',
        sessionHash: 'a'.repeat(64),
        agentId: 'main',
        turnIndex: 1,
        operation: 'core_search',
        memoryType: 'core',
        outcome: 'hit',
        policyReason: 'explicit_continuity',
        retrievalMode: 'semantic',
        resultCount: 2,
        latencyMs: 321,
        queryHash: 'b'.repeat(64),
        queryChars: 8,
        topMatchHash: 'c'.repeat(64),
        freshnessGap: false,
        timestamp,
      },
    ])
    assert.equal(inserted, 1)
    const row = await query<{ events: string; sessions: string; p50_ms: number }>(
      `SELECT events::text,sessions::text,p50_ms
         FROM memory_usage_daily
        WHERE user_id=$1 AND operation='core_search'`,
      [user.rows[0]!.id],
    )
    assert.equal(row.rows[0]?.events, '1')
    assert.equal(row.rows[0]?.sessions, '1')
    assert.equal(Number(row.rows[0]?.p50_ms), 321)
    const columns = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name='memory_usage_events'`,
    )
    const names = new Set(columns.rows.map((entry) => entry.column_name))
    assert.equal(names.has('query_text'), false)
    assert.equal(names.has('session_key'), false)
    assert.equal(names.has('memory_content'), false)
  })
})
