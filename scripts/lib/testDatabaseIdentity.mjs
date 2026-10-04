/** Test-only identity fence: external DSN and server DB, not NAT listen port.
 * Call before Pool construction, then assert the connected DB before any writes.
 * Callers must additionally prove their TEMP/exclusive schema isolation. */
import assert from 'node:assert/strict'

export function assertTestDatabaseUrl(value) {
  const url = new URL(value)
  assert.ok(url.protocol === 'postgres:' || url.protocol === 'postgresql:', 'test PostgreSQL DSN required')
  assert.equal(url.hostname, '127.0.0.1', 'test DB must be loopback')
  assert.equal(url.port, '55432', 'test DB external endpoint must be 55432')
  assert.equal(url.pathname, '/openclaude_test', 'non-test DB refused')
  assert.equal(url.username, 'test', 'non-test role refused')
  assert.equal(url.password, 'test', 'non-test credential refused')
  assert.equal(url.search, '', 'DSN options may not override fixture identity')
  assert.equal(url.hash, '', 'DSN fragment refused')
}

export async function assertConnectedTestDatabase(
  client,
) {
  const result = await client.query('SELECT current_database() AS db')
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].db, 'openclaude_test', 'connected to non-test database')
}
