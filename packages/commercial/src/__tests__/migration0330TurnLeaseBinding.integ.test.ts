import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { Pool } from 'pg'

test('0330 keeps old authority bindings valid and persists an exact turn key', async () => {
  const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.OCV5_289_JOURNAL_TEST_DATABASE_URL
  assert.ok(databaseUrl, 'a real isolated PostgreSQL fixture is required')
  const pool = new Pool({ connectionString: databaseUrl, max: 1 })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('CREATE TEMP TABLE authority_turn_dispatches (authority_turn_id text PRIMARY KEY)')
    await client.query('INSERT INTO authority_turn_dispatches VALUES ($1)', ['a'.repeat(32)])
    const sql = await readFile(new URL('../db/migrations/0330_turn_lease_binding.sql', import.meta.url), 'utf8')
    await client.query(sql)
    assert.equal((await client.query('SELECT turn_key FROM authority_turn_dispatches')).rows[0].turn_key, null)
    // Old writers may continue omitting the additive nullable column.
    await client.query('INSERT INTO authority_turn_dispatches(authority_turn_id) VALUES ($1)', ['b'.repeat(32)])
    const key = 'c'.repeat(64)
    const bind = await client.query('UPDATE authority_turn_dispatches SET turn_key=$2 WHERE authority_turn_id=$1 AND turn_key IS NULL', ['a'.repeat(32), key])
    assert.equal(bind.rowCount, 1)
    assert.equal((await client.query('SELECT turn_key FROM authority_turn_dispatches WHERE authority_turn_id=$1', ['a'.repeat(32)])).rows[0].turn_key, key)
    for (const invalid of ['', 'z'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
      await client.query('SAVEPOINT invalid_key')
      await assert.rejects(client.query('UPDATE authority_turn_dispatches SET turn_key=$2 WHERE authority_turn_id=$1', ['a'.repeat(32), invalid]), { code: '23514' })
      await client.query('ROLLBACK TO SAVEPOINT invalid_key')
    }
  } finally {
    await client.query('ROLLBACK')
    client.release()
    await pool.end()
  }
})
