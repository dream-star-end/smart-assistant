import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { closePool, createPool, resetPool, setPoolOverride } from '../db/index.js'
import { query } from '../db/queries.js'
import { resetAndMigrateBefore } from './helpers/db.js'

/**
 * 0189_auto_dream_deepseek_v4_flash 的迁移行为。
 *
 * 2026-07-26 门禁审计整改:此前本文件在自己的 schema 里手搓 `system_settings`
 * (`CREATE TABLE system_settings (key TEXT PRIMARY KEY, value JSONB NOT NULL,
 * description TEXT, updated_at TIMESTAMPTZ ...)`)再 apply 单条 SQL。前置表形状
 * 由测试自己定义 —— 真 schema 一漂(某列改 NOT NULL、加约束、改类型),这条迁移
 * 在生产会炸而测试照绿。它守的是"我写的 DDL 和我写的 DDL 一致"。
 *
 * 现在改为**重放真实迁移链到 0188 为止**(resetAndMigrateBefore('0189')),再 apply
 * 0189。前置状态 = 生产在应用 0189 前的真实状态,不是测试的想象。
 */

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'
const here = path.dirname(fileURLToPath(import.meta.url))
const MIGRATION = path.resolve(here, '../db/migrations/0189_auto_dream_deepseek_v4_flash.sql')

let pgAvailable = false

async function probe(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 1, connectionTimeoutMillis: 1500 })
  try {
    await p.query('SELECT 1')
    return true
  } catch {
    return false
  } finally {
    await p.end().catch(() => undefined)
  }
}

before(async () => {
  pgAvailable = await probe()
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error('Postgres test fixture required')
    return
  }
  await resetPool()
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 4 }))
})

after(async () => {
  if (pgAvailable) await closePool()
})

/**
 * 把库带到"0189 尚未应用"的真实状态,再把 auto_dream_model 摆成想测的前置值。
 *
 * `value === undefined` 表示"这一行根本不存在" —— 注意这里必须 DELETE,因为真实
 * 迁移链(0188 之前)可能已经种下一行默认值;手搓表的老写法看不到这件事。
 */
async function seedSetting(value?: string): Promise<void> {
  await resetAndMigrateBefore('0189')
  if (value === undefined) {
    await query("DELETE FROM system_settings WHERE key='auto_dream_model'")
    return
  }
  await query(
    `INSERT INTO system_settings(key,value,description)
     VALUES ('auto_dream_model',to_jsonb($1::text),'before')
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, description='before'`,
    [value],
  )
}

async function applyMigration(): Promise<void> {
  await query(await readFile(MIGRATION, 'utf8'))
}

async function currentSetting(): Promise<{ value: string; description: string | null }> {
  const result = await query<{ value: string; description: string | null }>(
    "SELECT value #>> '{}' AS value,description FROM system_settings WHERE key='auto_dream_model'",
  )
  return result.rows[0]!
}

describe('0189_auto_dream_deepseek_v4_flash', () => {
  test('inserts DeepSeek when the old default row is absent', async (t) => {
    if (!pgAvailable) return t.skip('Postgres unavailable')
    await seedSetting()
    await applyMigration()
    assert.deepEqual(await currentSetting(), {
      value: 'deepseek-v4-flash',
      description:
        'Auto-Dream 全面优化审计模型（默认使用 active/public 的 DeepSeek V4 Flash）',
    })
  })

  test('updates Terra but preserves an explicit non-Terra administrator choice', async (t) => {
    if (!pgAvailable) return t.skip('Postgres unavailable')
    await seedSetting('gpt-5.6-terra')
    await applyMigration()
    assert.equal((await currentSetting()).value, 'deepseek-v4-flash')

    await seedSetting('custom-optimizer')
    await applyMigration()
    assert.deepEqual(await currentSetting(), {
      value: 'custom-optimizer',
      description: 'before',
    })
  })
})
