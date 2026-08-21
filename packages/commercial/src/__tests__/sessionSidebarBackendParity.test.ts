/**
 * 侧栏归档 / 搜索 / 批量 / 列表分页:PG 与 SQLite 不得漂移。
 * 迁移 0233、同名 backend 方法、list 默认排除 archived_at、SQL 侧截 last preview。
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/sessionSidebarBackendParity.test.ts
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const migration = join(here, '../db/migrations/0233_client_session_list_archived_at.sql')
const backendSrc = readFileSync(join(here, '../db/pgSessionsBackend.ts'), 'utf8')
const sqliteSrc = readFileSync(join(here, '../../../storage/src/sessionsDb.ts'), 'utf8')
const metadata = JSON.parse(
  readFileSync(join(here, '../../../../deploy/v5/release-metadata.json'), 'utf8'),
) as { requiredMigrations: string[] }

describe('session sidebar PG/SQLite 契约对齐', () => {
  test('0233 加 archived_at,并登记 requiredMigrations', () => {
    assert.equal(existsSync(migration), true)
    const sql = readFileSync(migration, 'utf8')
    assert.match(sql, /ALTER TABLE client_sessions ADD COLUMN IF NOT EXISTS archived_at/)
    assert.match(sql, /idx_client_sessions_user_list_active/)
    assert.ok(sql.includes('BIGINT'))
    assert.match(sql, /Not the message-spill watermark/)
    assert.ok(metadata.requiredMigrations.includes('0233_client_session_list_archived_at'))
    assert.match(sqliteSrc, /archived_at INTEGER DEFAULT NULL/)
  })

  test('两条 backend 覆盖 search / batch / 项目指令查找', () => {
    for (const method of [
      'searchClientSessions',
      'batchClientSessions',
      'getSessionProjectInstructions',
      'listClientSessions',
      'patchClientSessionMeta',
    ]) {
      assert.ok(backendSrc.includes(`async ${method}(`), `PG 缺 ${method}`)
      assert.ok(sqliteSrc.includes(`${method}:`), `sqliteBackend 缺 ${method}`)
    }
  })

  test('list 默认排除归档,SQL 侧截 last preview,不 N+1 拉 messages blob', () => {
    const pgList = backendSrc.slice(
      backendSrc.indexOf('async listClientSessions'),
      backendSrc.indexOf('async listClientSessions') + 4500,
    )
    const sqliteList = sqliteSrc.slice(
      sqliteSrc.indexOf('async function _sqliteListClientSessions'),
      sqliteSrc.indexOf('async function _sqliteListClientSessions') + 3500,
    )
    assert.match(pgList, /archived_at IS NULL/)
    assert.match(sqliteList, /archived_at IS NULL/)
    assert.match(pgList, /json_array_elements\(cs\.messages::json\)/)
    assert.match(pgList, /ORDER BY n DESC/)
    assert.match(pgList, /LAST_MESSAGE_PREVIEW_TAIL_MAX/)
    assert.match(pgList, /octet_length\(cs\.messages\)/)
    assert.match(sqliteSrc, /SQLITE_LAST_PREVIEW_SQL/)
    assert.match(sqliteSrc, /json_each\(cs\.messages\)/)
    assert.match(sqliteSrc, /LAST_MESSAGE_PREVIEW_TAIL_MAX/)
    assert.doesNotMatch(pgList, /messages::json -> -1/)
    assert.doesNotMatch(pgList, /for \(const/)
    assert.match(backendSrc, /elem->>'text' ILIKE/)
    assert.match(sqliteSrc, /json_each\(cs\.messages\)/)
    assert.match(backendSrc, /client_session_archive_chunks/)
    assert.match(sqliteSrc, /client_session_archive_chunks/)
    assert.match(backendSrc, /cs\.messages ILIKE \$2 ESCAPE/)
    assert.match(backendSrc, /octet_length\(cs\.messages\)/)
    assert.match(backendSrc, /ch\.messages ILIKE \$2 ESCAPE/)
    assert.match(sqliteSrc, /cs\.messages LIKE \? ESCAPE/)
    assert.match(sqliteSrc, /length\(CAST\(cs\.messages AS BLOB\)\)/)
    assert.match(sqliteSrc, /ch\.messages LIKE \? ESCAPE/)
    assert.match(sqliteSrc, /SESSION_SEARCH_JSON_CANDIDATE_MAX = 80/)
    assert.match(sqliteSrc, /SESSION_SEARCH_JSON_EXPAND_MAX_BYTES = 2 \* 1024 \* 1024/)
    assert.match(backendSrc, /SESSION_SEARCH_JSON_CANDIDATE_MAX/)
    assert.match(backendSrc, /SESSION_SEARCH_JSON_EXPAND_MAX_BYTES/)
  })
})
