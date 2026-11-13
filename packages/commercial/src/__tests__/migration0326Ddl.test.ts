import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

// OCV5-577：个人版列车切流前用 scripts/lib/v5-migration-ddl.sh 拒绝破坏性 DDL（含 ALTER ... DROP）。
// 经验分享的两支迁移必须过这道门，否则下一趟列车会卡住所有人。
const repo = fileURLToPath(new URL('../../../../', import.meta.url))

for (const version of ['0326_community_blog', '0327_community_tutorial_moderation', '0328_community_tutorial_revisions']) {
  test(`${version} 不含列车门拒绝的破坏性 DDL`, () => {
    const file = `packages/commercial/src/db/migrations/${version}.sql`
    const result = spawnSync(
      'bash',
      ['-c', 'source scripts/lib/v5-migration-ddl.sh && sql_file_has_breaking_ddl "$1"', 'ddl', file],
      { cwd: repo, encoding: 'utf8' },
    )
    assert.equal(result.status, 1, `breaking DDL detected: ${result.stdout.trim()}`)
  })
}
