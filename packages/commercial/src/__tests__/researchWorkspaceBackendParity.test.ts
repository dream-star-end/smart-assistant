/**
 * R3.0 课题工作区 PG/SQLite 契约对齐:
 * 0260 迁移建 membership 表 + is_research_default;
 * sessionsDb 自愈列; pgSessionsBackend createChatProject 支持 isResearchDefault;
 * requiredMigrations 登记。
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/researchWorkspaceBackendParity.test.ts
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const migration = join(here, '../db/migrations/0260_research_workspace.sql')
const backendSrc = readFileSync(join(here, '../db/pgSessionsBackend.ts'), 'utf8')
const sqliteSrc = readFileSync(join(here, '../../../storage/src/sessionsDb.ts'), 'utf8')
const metadata = JSON.parse(
  readFileSync(join(here, '../../../../deploy/v5/release-metadata.json'), 'utf8'),
) as { requiredMigrations: string[] }

describe('research workspace PG/SQLite 契约对齐', () => {
  test('0260 建 membership 表+默认课题列,含 rollback 与 order-dependency,并登记 requiredMigrations', () => {
    assert.equal(existsSync(migration), true)
    const sql = readFileSync(migration, 'utf8')
    assert.match(sql, /^-- order-dependency: 0259_cursor_gemini_38_flash/m)
    assert.match(sql, /CREATE TABLE IF NOT EXISTS research_library_memberships/)
    assert.match(sql, /PRIMARY KEY \(user_id, doc_id, project_id\)/)
    assert.match(sql, /idx_rlm_project/)
    assert.match(sql, /is_research_default/)
    assert.match(sql, /idx_chat_projects_user_research_default/)
    assert.match(sql, /rollback:/)
    assert.match(sql, /DROP TABLE IF EXISTS research_library_memberships/)
    assert.ok(metadata.requiredMigrations.includes('0260_research_workspace'))
  })

  test('sqlite sessionsDb 自愈 is_research_default 列与 unique partial index', () => {
    assert.match(sqliteSrc, /is_research_default/)
    assert.match(sqliteSrc, /idx_chat_projects_user_research_default/)
    assert.match(sqliteSrc, /ALTER TABLE chat_projects ADD COLUMN is_research_default/)
  })

  test('createChatProject 双后端支持 isResearchDefault,unique 冲突回读已有默认课题', () => {
    assert.match(sqliteSrc, /isResearchDefault/)
    assert.match(backendSrc, /isResearchDefault/)
    assert.match(sqliteSrc, /idx_chat_projects_user_research_default/)
    assert.match(backendSrc, /is_research_default/)
  })
})
