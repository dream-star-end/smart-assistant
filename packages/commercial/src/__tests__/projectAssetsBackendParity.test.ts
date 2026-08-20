/**
 * PG 侧项目资产不得与 SQLite 契约漂移:
 * 迁移 0237 存在、pgSessionsBackend 实现同名方法、requiredMigrations 登记。
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/projectAssetsBackendParity.test.ts
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const migration = join(here, '../db/migrations/0237_project_assets.sql')
const backendSrc = readFileSync(join(here, '../db/pgSessionsBackend.ts'), 'utf8')
const sqliteSrc = readFileSync(join(here, '../../../storage/src/sessionsDb.ts'), 'utf8')
const metadata = JSON.parse(
  readFileSync(join(here, '../../../../deploy/v5/release-metadata.json'), 'utf8'),
) as { requiredMigrations: string[] }

describe('project_assets PG/SQLite 契约对齐', () => {
  test('0237 迁移建表加索引,并登记 requiredMigrations', () => {
    assert.equal(existsSync(migration), true)
    const sql = readFileSync(migration, 'utf8')
    assert.match(sql, /CREATE TABLE IF NOT EXISTS project_assets/)
    assert.match(sql, /idx_project_assets_user_project_created/)
    assert.match(sql, /idx_project_assets_user_project_pinned/)
    assert.match(sql, /idx_project_assets_user_digest/)
    assert.match(sql, /CHECK \(source IN \('upload', 'output'\)\)/)
    assert.ok(sql.includes('BIGINT'), 'PG 时间戳跟随 0134 BIGINT epoch ms')
    assert.match(sql, /never unlink|绝不删磁盘文件/)
    assert.ok(metadata.requiredMigrations.includes('0237_project_assets'))
  })

  test('pgSessionsBackend 覆盖 sqliteBackend 新增方法', () => {
    for (const method of [
      'listProjectAssets',
      'createProjectAsset',
      'updateProjectAsset',
      'deleteProjectAsset',
      'listPinnedProjectAssetsForSession',
    ]) {
      assert.ok(backendSrc.includes(`async ${method}(`), `PG 缺 ${method}`)
      assert.ok(sqliteSrc.includes(`${method}:`), `sqliteBackend 缺 ${method}`)
    }
  })

  test('删除注释明确不删磁盘文件', () => {
    assert.match(sqliteSrc, /绝不(写\/)?删磁盘文件|软删只标 deleted_at,绝不 unlink/)
    assert.match(backendSrc, /绝不(写\/)?删磁盘文件|软删只标 deleted_at,绝不 unlink/)
  })
})
