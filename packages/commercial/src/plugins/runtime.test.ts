import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { QueryResult, QueryResultRow } from 'pg'

import { PluginRuntimeFacade } from './runtime.js'

function result<Row extends QueryResultRow>(rows: Row[]): QueryResult<Row> {
  return { command: 'SELECT', rowCount: rows.length, oid: 0, fields: [], rows }
}

describe('Plugin runtime facade', () => {
  test('catalog/list expose only installed current runtime Plugins and stable target ids', async () => {
    // Contract verification itself is covered in review.test; this test pins facade SQL and
    // empty-safe behavior without manufacturing signed DB rows.
    const calls: string[] = []
    const pool = {
      async query<Row extends QueryResultRow>(sql: string): Promise<QueryResult<Row>> {
        calls.push(sql)
        return result([])
      },
    }
    const facade = new PluginRuntimeFacade({ pool: pool as never, redis: null })
    assert.deepEqual(await facade.catalog(7), [])
    assert.deepEqual(await facade.list(7), [])
    assert.deepEqual(await facade.management(7), { catalog: [], accounts: [] })
    assert.ok(calls.some((sql) => sql.includes('marketplace_installs')))
    assert.ok(calls.some((sql) => sql.includes("l.plugin_type = 'managed-browser'")))
    assert.ok(calls.some((sql) => sql.includes('NOT EXISTS')))
  })

  test('classifyTarget starts from a user-scoped current install and rejects absent targets', async () => {
    const calls: string[] = []
    const pool = {
      async query<Row extends QueryResultRow>(sql: string): Promise<QueryResult<Row>> {
        calls.push(sql)
        return result([])
      },
    }
    const facade = new PluginRuntimeFacade({ pool: pool as never, redis: null })
    assert.equal(await facade.classifyTarget(7, 'github'), null)
    assert.equal(await facade.classifyTarget(7, 'plugin:42'), null)
    assert.equal(await facade.classifyTarget(7, '41'), null)
    assert.equal(calls.length, 2)
    assert.match(calls[0]!, /i\.user_id = \$1 AND i\.version_id = \$2::bigint/)
    assert.match(calls[0]!, /l\.current_approved_version_id = v\.id/)
    assert.match(calls[1]!, /JOIN marketplace_installs i/)
    assert.match(calls[1]!, /i\.uninstalled_at IS NULL/)
    assert.match(calls[1]!, /v\.exec_revoked_at IS NULL/)
  })
})
