import test from 'node:test'
import assert from 'node:assert/strict'
import { assertTestDatabaseUrl, assertConnectedTestDatabase } from '../lib/testDatabaseIdentity.mjs'
const DSN = 'postgres://test:test@127.0.0.1:55432/openclaude_test'
test('fixture identity accepts external mapping without checking the internal listen port', async () => {
  assertTestDatabaseUrl(DSN)
  const queries: string[] = []
  await assertConnectedTestDatabase({ async query(sql) { queries.push(sql); return { rows: [{ db: 'openclaude_test' }] } } })
  assert.deepEqual(queries, ['SELECT current_database() AS db'])
})
test('rejects remote, production, wrong port/role and option-overridden DSNs before connecting', () => {
  for (const dsn of [DSN.replace('127.0.0.1', 'prod.invalid'), DSN.replace('55432', '5432'),
    DSN.replace('openclaude_test', 'openclaude'), DSN.replace('test:test', 'root:test'), DSN+'?options=-csearch_path=public']) {
    assert.throws(() => assertTestDatabaseUrl(dsn))
  }
})
test('rejects an actual non-test database even with a whitelisted DSN', async () => {
  await assert.rejects(() => assertConnectedTestDatabase({ async query() { return { rows: [{ db: 'production' }] } } }))
})
