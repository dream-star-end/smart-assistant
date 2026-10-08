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
      'searchProjectAssets',
      'listProjectAssetVersions',
      'createProjectAsset',
      'updateProjectAsset',
      'deleteProjectAsset',
      'listPinnedProjectAssetsForSession',
      'searchChatProjectAssets',
    ]) {
      assert.ok(backendSrc.includes(`async ${method}(`), `PG 缺 ${method}`)
      assert.ok(sqliteSrc.includes(`${method}:`), `sqliteBackend 缺 ${method}`)
    }
  })

  test('删除注释明确不删磁盘文件', () => {
    assert.match(sqliteSrc, /绝不(写\/)?删磁盘文件|软删只标 deleted_at,绝不 unlink/)
    assert.match(backendSrc, /绝不(写\/)?删磁盘文件|软删只标 deleted_at,绝不 unlink/)
  })

  test('create/update 在计数前取事务级 advisory lock,防 READ COMMITTED 突破 500 上限', () => {
    const createSrc = extractMethod(backendSrc, 'createProjectAsset', 'updateProjectAsset')
    const updateSrc = extractMethod(backendSrc, 'updateProjectAsset', 'deleteProjectAsset')
    for (const [name, src] of [
      ['createProjectAsset', createSrc],
      ['updateProjectAsset', updateSrc],
    ] as const) {
      const lockAt = src.indexOf('pg_advisory_xact_lock')
      const countAt = src.indexOf('pgCountProjectAssets')
      assert.ok(lockAt >= 0, `${name} 缺 pg_advisory_xact_lock`)
      assert.ok(countAt >= 0, `${name} 缺 pgCountProjectAssets`)
      assert.ok(lockAt < countAt, `${name} 必须在计数之前取 xact lock`)
    }
  })

  test('产出物版本:两侧同一去重规则、同一折叠键、同样的版本时间下限', () => {
    // 带字节副本的产出只与该源路径的最新版本比 digest;其它仍按 digest / container_path。
    assert.match(sqliteSrc, /source === 'output' && containerPath && digest\)[\s\S]{0,200}_sqliteLatestOutputVersion[\s\S]{0,120}latest\.digest === digest/)
    assert.match(backendSrc, /source === "output" && containerPath && digest\)[\s\S]{0,200}pgLatestOutputVersion[\s\S]{0,120}latest\.digest === digest/)
    for (const src of [sqliteSrc, backendSrc]) {
      assert.match(src, /ORDER BY created_at DESC, id DESC/)
      assert.ok(src.includes('PROJECT_ASSET_VERSION_GROUP_SQL'), 'list 必须用共享的折叠键')
      assert.ok(src.includes('withVersionCount('), 'versionCount 形状两侧一致')
    }
    // Output versions are dated by capture time (never later than now), floored above the previous version.
    assert.match(sqliteSrc, /Math\.min\(parsed\.value\.capturedAt, now\)/)
    assert.match(sqliteSrc, /Math\.max\(versionBase, latest\.createdAt \+ 1\)/)
    assert.match(backendSrc, /createdAtFloor = latest\.createdAt \+ 1/)
    assert.match(backendSrc, /GREATEST\(LEAST\(\$\{CLOCK_MS_SQL\}, \$15::bigint\), \$14::bigint\)/)
    assert.match(backendSrc, /parsed\.value\.source === "output" \? parsed\.value\.capturedAt : null/)
  })

  test('重放识别:两侧都只在 capturedAt 不晚于最新版本时复用旧版本', () => {
    assert.match(sqliteSrc, /capturedAt !== null && capturedAt <= latest\.createdAt/)
    assert.match(backendSrc, /capturedAt !== null && capturedAt <= latest\.createdAt/)
    assert.match(sqliteSrc, /parsed\.value\.capturedAt,\n    \)/)
    assert.match(backendSrc, /parsed\.value\.capturedAt,\n        \)/)
  })

  test('常用只挂最新版本:两侧继承+取消旧版本,注入查询只认最新版本', () => {
    assert.match(sqliteSrc, /pinned = pinned \|\| latest\.pinned/)
    assert.match(backendSrc, /pinned = pinned \|\| latest\.pinned/)
    assert.match(sqliteSrc, /UPDATE project_assets SET pinned = 0[\s\S]{0,200}container_path = \? AND pinned = 1/)
    assert.match(backendSrc, /UPDATE project_assets SET pinned = FALSE[\s\S]{0,260}container_path = \$3 AND pinned IS TRUE/)
    assert.equal(sqliteSrc.split('AND ${SQLITE_ASSET_IS_LATEST_VERSION}').length - 1, 2)
    assert.equal(backendSrc.split('AND ${PG_ASSET_IS_LATEST_VERSION}').length - 1, 2)
    for (const [name, src] of [
      ['listPinnedProjectAssetsForChatProject', extractMethod(backendSrc, 'listPinnedProjectAssetsForChatProject', 'searchClientSessions')],
      ['listPinnedProjectAssetsForSession', extractMethod(backendSrc, 'listPinnedProjectAssetsForSession', 'bumpClientSessionHistoryRevision')],
    ] as const) {
      assert.ok(src.includes('PG_ASSET_IS_LATEST_VERSION'), `${name} 必须只认最新版本`)
    }
  })

  test('PG create 在去重之前取锁(并发的两个新版本不会互相看不见)', () => {
    const createSrc = extractMethod(backendSrc, 'createProjectAsset', 'updateProjectAsset')
    const lockAt = createSrc.indexOf('pg_advisory_xact_lock')
    const dupAt = createSrc.indexOf('pgFindDuplicateAsset(')
    assert.ok(lockAt >= 0 && dupAt > lockAt)
  })
})

test('searchProjectAssets: both backends escape LIKE, scope by user_id, skip deleted, cap the limit', () => {
  const pg = extractMethod(backendSrc, 'searchProjectAssets', 'createProjectAsset')
  const lite = sqliteSrc.slice(
    sqliteSrc.indexOf('async function _sqliteSearchProjectAssets('),
    sqliteSrc.indexOf('async function _sqliteCreateProjectAsset('),
  )
  for (const [name, src] of [['pg', pg], ['sqlite', lite]] as const) {
    assert.ok(src.length > 0, `${name} search missing`)
    assert.match(src, /escapeLikePattern\(q\)/, `${name} must escape LIKE wildcards`)
    assert.match(src, /ESCAPE '\\\\'/, `${name} must use ESCAPE '\\'`)
    assert.match(src, /user_id = /, `${name} must scope by user_id`)
    assert.match(src, /deleted_at IS NULL/, `${name} must skip soft-deleted assets`)
    assert.match(src, /PROJECT_ASSET_SEARCH_LIMIT_MAX/, `${name} must cap the limit`)
    assert.match(src, /excerpt/, `${name} must search the excerpt too`)
  }
  assert.match(pg, /ILIKE/, 'PG search is case-insensitive')
})
test('searchChatProjectAssets: same normaliser, user + project scope, latest version only, escaped LIKE', () => {
  const pg = extractMethod(backendSrc, 'searchChatProjectAssets', 'bumpClientSessionHistoryRevision')
  const lite = sqliteSrc.slice(
    sqliteSrc.indexOf('async function _sqliteSearchChatProjectAssets('),
    sqliteSrc.indexOf('export function rankSessionSearchHits<'),
  )
  for (const [name, src] of [['pg', pg], ['sqlite', lite]] as const) {
    assert.ok(src.length > 0, `${name} search missing`)
    assert.match(src, /normalizeChatProjectAssetSearch\(opts\)/, `${name} must share the normaliser (escape + limit cap)`)
    assert.match(src, /ESCAPE '\\\\'/, `${name} must use ESCAPE '\\'`)
    assert.match(src, /user_id = (\?|\$1) AND deleted_at IS NULL AND project_id = (\?|\$2)/, `${name} must scope by user and project`)
    assert.ok(src.includes('PROJECT_ASSET_VERSION_GROUP_SQL'), `${name} must fold output versions`)
    assert.match(src, /version_rank = 1/, `${name} must search the latest version only`)
    assert.match(src, /excerpt/, `${name} must search the excerpt too`)
    assert.match(src, /ORDER BY created_at DESC, id DESC/, `${name} must order deterministically`)
  }
  assert.match(pg, /ILIKE/, 'PG search is case-insensitive')
})

function extractMethod(src: string, name: string, nextName: string): string {
  const start = src.indexOf(`async ${name}(`)
  const end = src.indexOf(`async ${nextName}(`, start + 1)
  assert.ok(start >= 0, `missing ${name}`)
  assert.ok(end > start, `missing successor ${nextName}`)
  return src.slice(start, end)
}
