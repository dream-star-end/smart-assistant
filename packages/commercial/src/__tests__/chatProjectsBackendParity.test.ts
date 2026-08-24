/**
 * PG 侧聊天项目 / 会话 list 派生不得与 SQLite 契约漂移:
 * 迁移 0230 存在、pgSessionsBackend 实现同名方法、list SQL JOIN turn_dispatches。
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/chatProjectsBackendParity.test.ts
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const migration = join(here, '../db/migrations/0230_chat_projects.sql')
const bindMigration = join(here, '../db/migrations/0246_chat_project_board_bind.sql')
const backendSrc = readFileSync(join(here, '../db/pgSessionsBackend.ts'), 'utf8')
const sqliteSrc = readFileSync(join(here, '../../../storage/src/sessionsDb.ts'), 'utf8')
const metadata = JSON.parse(
  readFileSync(join(here, '../../../../deploy/v5/release-metadata.json'), 'utf8'),
) as { requiredMigrations: string[] }

describe('chat_projects PG/SQLite 契约对齐', () => {
  test('0230 迁移建表加列,并登记 requiredMigrations', () => {
    assert.equal(existsSync(migration), true)
    const sql = readFileSync(migration, 'utf8')
    assert.match(sql, /CREATE TABLE IF NOT EXISTS chat_projects/)
    assert.match(sql, /ALTER TABLE client_sessions ADD COLUMN IF NOT EXISTS project_id/)
    assert.match(sql, /idx_chat_projects_user_deleted/)
    assert.match(sql, /idx_client_sessions_user_project/)
    assert.ok(sql.includes('BIGINT'), 'PG 时间戳跟随 0134 BIGINT epoch ms')
    assert.ok(metadata.requiredMigrations.includes('0230_chat_projects'))
  })

  test('0246 board_project_id 绑定列与 1:1 索引', () => {
    assert.equal(existsSync(bindMigration), true)
    const sql = readFileSync(bindMigration, 'utf8')
    assert.match(sql, /board_project_id/)
    assert.match(sql, /idx_chat_projects_user_board/)
    assert.ok(metadata.requiredMigrations.includes('0246_chat_project_board_bind'))
    assert.match(sqliteSrc, /idx_chat_projects_user_board/)
    assert.match(sqliteSrc, /board_project_bound/)
    assert.match(backendSrc, /board_project_bound/)
  })

  test('pgSessionsBackend 覆盖 sqliteBackend 新增方法', () => {
    for (const method of [
      'listChatProjects',
      'createChatProject',
      'updateChatProject',
      'deleteChatProject',
      'patchClientSessionMeta',
      'getChatProjectBindBySessionId',
      'getChatProjectBindByBoardProjectId',
      'listPinnedProjectAssetsForChatProject',
    ]) {
      assert.ok(backendSrc.includes(`async ${method}(`), `PG 缺 ${method}`)
      assert.ok(sqliteSrc.includes(`${method}:`), `sqliteBackend 缺 ${method}`)
    }
  })

  test('listClientSessions 一条 SQL 派生 runState/lastOutcome,不 N+1', () => {
    assert.match(backendSrc, /FROM turn_dispatches/)
    assert.match(backendSrc, /status IN \('admitted', 'accepted', 'rejecting'\)/)
    assert.match(backendSrc, /ROW_NUMBER\(\) OVER/)
    assert.match(sqliteSrc, /FROM turn_dispatch_inbox/)
    assert.match(sqliteSrc, /state NOT IN \('terminal', 'rejected'\)/)
    assert.doesNotMatch(
      backendSrc.slice(backendSrc.indexOf('async listClientSessions'), backendSrc.indexOf('async listClientSessions') + 2500),
      /for \(const/,
      'list 不得对每条会话再查 dispatch',
    )
  })
})
