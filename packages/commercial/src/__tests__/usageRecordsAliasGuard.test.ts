/**
 * loadSettledUsageAttribution 外层 usage_records 查询「禁加别名」不变量的显式守卫(批D D6)。
 *
 * pgSessionsBackend.loadSettledUsageAttribution 的外层 `FROM usage_records` **故意不加别名**
 * ——不只是为了简洁,而是要保住 finalizer 测试里那条**长期存在的故障注入桩**的匹配条件:
 *   anthropicProxy.test.ts 的 `commitThrowsButUsageVisible` 桩靠
 *   `sql.includes("FROM usage_records WHERE user_id")` 识别"这是那条不确定 COMMIT 复核查询",
 *   从而模拟"COMMIT 抛错但 usage 行其实可见"。外层一旦别名化(`FROM usage_records u WHERE …`),
 *   子串不再命中→桩不触发→整条"indeterminate COMMIT 复核"路径静默失去覆盖。
 *
 * 此前该不变量只靠 pgSessionsBackend.ts:240 的一行注释维系。本测试在**运行时**捕获该函数
 * 真实发出的 SQL,断言其形态与桩的匹配条件**同源**:含 `FROM usage_records WHERE user_id`、
 * 且外层 usage_records 不带任何别名。任何别名化改动都会同时打红本测试与桩,不再靠注释自觉。
 *
 * 跑法:npx tsx --test packages/commercial/src/__tests__/usageRecordsAliasGuard.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { loadSettledUsageAttribution } from '../db/pgSessionsBackend.js'

test('loadSettledUsageAttribution 外层 usage_records 查询无别名(与故障注入桩匹配条件同源)', async () => {
  const captured: string[] = []
  // fake runner:只捕获 SQL,返回空结果(函数取 rows[0] → undefined → null,不触碰真 DB)。
  const fakeRunner = {
    query: async (sql: string) => {
      captured.push(sql)
      return { rows: [], rowCount: 0 }
    },
  }

  const result = await loadSettledUsageAttribution(
    fakeRunner as never,
    1n,
    'req-alias-guard',
  )
  assert.equal(result, null, '空结果集应映射为 null(fake runner 语义自检)')
  assert.equal(captured.length, 1, 'loadSettledUsageAttribution 应恰好发一条查询')

  const sql = captured[0]

  // ① 正向:与故障注入桩逐字同源的匹配子串(anthropicProxy.test.ts:1621/1773)。
  assert.ok(
    sql.includes('FROM usage_records WHERE user_id'),
    `外层查询必须含子串 "FROM usage_records WHERE user_id"(finalizer 故障注入桩依赖此子串识别` +
      `本查询);缺失=桩失效。实际 SQL:\n${sql}`,
  )

  // ② 反向:外层 usage_records 不得带别名(`usage_records u` / `usage_records AS u` 等)。
  // 负向前瞻排除紧跟的 SQL 关键字(WHERE/USING/ON/SET),只在"别名标识符"出现时命中。
  // 注:表内的 `usage_records.<col>`(带点)与子查询里的 `pending_usage_patches p` /
  // `turn_tape_cost_components c`(别表)都不会误伤本正则。
  const aliasForm = /\busage_records\s+(?:as\s+)?(?!where\b|using\b|on\b|set\b)[a-z][a-z0-9_]*/i
  assert.ok(
    !aliasForm.test(sql),
    `外层 usage_records 检测到别名形态,会破坏故障注入桩的 "FROM usage_records WHERE user_id" ` +
      `匹配。实际 SQL:\n${sql}`,
  )
})
