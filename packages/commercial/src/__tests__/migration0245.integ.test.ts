/**
 * 0245 GPT-5.6 Sol/Terra/Luna standard xN half + 1M stays 1.5x.
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0245.integ.test.ts'
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { costXVsBaseline } from '@openclaude/protocol'
import { query, tx } from '../db/queries.js'
import { resetAndMigrateBefore, useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('models_0245_test')
const here = path.dirname(fileURLToPath(import.meta.url))
const migrationPath = path.resolve(here, '../db/migrations/0245_gpt56_family_half_xn.sql')
const rollbackPath = path.resolve(here, '../db/rollbacks/0245_gpt56_family_half_xn.sql')
const metadataPath = path.resolve(here, '../../../../deploy/v5/release-metadata.json')

const TARGET_IDS = [
  'gpt-5.6-sol',
  'gpt-5.6-sol-1m',
  'gpt-5.6-terra',
  'gpt-5.6-terra-1m',
  'gpt-5.6-luna',
  'gpt-5.6-luna-1m',
] as const

const STANDARD_IDS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'] as const

const LONG_BY_STANDARD = new Map([
  ['gpt-5.6-sol', 'gpt-5.6-sol-1m'],
  ['gpt-5.6-terra', 'gpt-5.6-terra-1m'],
  ['gpt-5.6-luna', 'gpt-5.6-luna-1m'],
])

type PriceRow = {
  model_id: string
  display_name: string
  input_per_mtok: string
  output_per_mtok: string
  cache_read_per_mtok: string
  cache_write_per_mtok: string
  multiplier: string
  enabled: boolean
  sort_order: number
  updated_by: string | null
  visibility: string
  extra_system_prompt: string | null
  default_effort: string | null
  lock_version: number
  min_plan_code: string | null
}

const PRICE_SELECT = `
  SELECT model_id, display_name,
         input_per_mtok::text AS input_per_mtok,
         output_per_mtok::text AS output_per_mtok,
         cache_read_per_mtok::text AS cache_read_per_mtok,
         cache_write_per_mtok::text AS cache_write_per_mtok,
         multiplier::text AS multiplier,
         enabled, sort_order, updated_by::text AS updated_by, visibility,
         extra_system_prompt, default_effort, lock_version, min_plan_code
    FROM model_pricing
   ORDER BY model_id
`

function byId(rows: PriceRow[]): Map<string, PriceRow> {
  return new Map(rows.map((row) => [row.model_id, row]))
}

function half(value: string): string {
  return (BigInt(value) / 2n).toString()
}

function fifteenXAfterHalf(value: string): string {
  return (((BigInt(value) / 2n) * 3n + 1n) / 2n).toString()
}

function assertNonPriceState(actual: PriceRow, expected: PriceRow): void {
  assert.equal(actual.display_name, expected.display_name, actual.model_id)
  assert.equal(actual.multiplier, expected.multiplier, actual.model_id)
  assert.equal(actual.enabled, expected.enabled, actual.model_id)
  assert.equal(actual.sort_order, expected.sort_order, actual.model_id)
  assert.equal(actual.updated_by, expected.updated_by, actual.model_id)
  assert.equal(actual.visibility, expected.visibility, actual.model_id)
  assert.equal(actual.extra_system_prompt, expected.extra_system_prompt, actual.model_id)
  assert.equal(actual.default_effort, expected.default_effort, actual.model_id)
  assert.equal(actual.min_plan_code, expected.min_plan_code, actual.model_id)
}

function assertExactPrices(actual: PriceRow, expected: PriceRow): void {
  assert.equal(actual.input_per_mtok, expected.input_per_mtok, actual.model_id)
  assert.equal(actual.output_per_mtok, expected.output_per_mtok, actual.model_id)
  assert.equal(actual.cache_read_per_mtok, expected.cache_read_per_mtok, actual.model_id)
  assert.equal(actual.cache_write_per_mtok, expected.cache_write_per_mtok, actual.model_id)
}

function xOf(row: PriceRow, pro: PriceRow): number | undefined {
  return costXVsBaseline(
    {
      inputPerMtok: row.input_per_mtok,
      cacheReadPerMtok: row.cache_read_per_mtok,
      outputPerMtok: row.output_per_mtok,
      multiplier: row.multiplier,
    },
    {
      inputPerMtok: pro.input_per_mtok,
      cacheReadPerMtok: pro.cache_read_per_mtok,
      outputPerMtok: pro.output_per_mtok,
      multiplier: pro.multiplier,
    },
  )
}

function halvedRow(row: PriceRow): PriceRow {
  return {
    ...row,
    input_per_mtok: half(row.input_per_mtok),
    output_per_mtok: half(row.output_per_mtok),
    cache_read_per_mtok: half(row.cache_read_per_mtok),
    cache_write_per_mtok: half(row.cache_write_per_mtok),
  }
}

function rollbackTransactionBody(sql: string): string {
  const begin = '\nBEGIN;\n'
  const commit = '\nCOMMIT;'
  assert.ok(sql.includes(begin), 'rollback must include BEGIN')
  assert.ok(sql.endsWith(`${commit}\n`), 'rollback must end with COMMIT')
  return sql.replace(begin, '\n').slice(0, -`${commit}\n`.length)
}

describe('0245_gpt56_family_half_xn', () => {
  test('halves GPT-5.6 standard xN, keeps 1M at 1.5x, and compensates exactly', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0245')

    const seed = byId((await query<PriceRow>(PRICE_SELECT)).rows)
    const seedPro = seed.get('deepseek-v4-pro')
    assert.ok(seedPro)
    assert.equal(xOf(halvedRow(seed.get('gpt-5.6-sol')!), seedPro), 2.0)
    assert.equal(xOf(halvedRow(seed.get('gpt-5.6-terra')!), seedPro), 1.0)
    assert.equal(xOf(halvedRow(seed.get('gpt-5.6-luna')!), seedPro), 0.5)

    await query(
      `UPDATE model_pricing
          SET input_per_mtok=5, output_per_mtok=4,
              cache_read_per_mtok=3, cache_write_per_mtok=0
        WHERE model_id='gpt-5.6-luna'`,
    )
    await query(
      `INSERT INTO users(id, email, email_verified, password_hash, role)
       VALUES (245, 'pricing-0245@example.invalid', TRUE, 'argon2$stub', 'admin')`,
    )
    await query(
      `INSERT INTO usage_records(
         user_id, mode, model, input_tokens, output_tokens, cache_read_tokens,
         cache_write_tokens, price_snapshot, cost_credits, request_id, status
       ) VALUES (
         245, 'chat', 'gpt-5.6-sol', 10, 5, 2, 1,
         '{"model_id":"gpt-5.6-sol","input_per_mtok":"599","output_per_mtok":"3598","cache_read_per_mtok":"60","cache_write_per_mtok":"0","multiplier":"1.000"}'::jsonb,
         4242, 'pricing-0245-history', 'success'
       )`,
    )

    const beforeRows = (await query<PriceRow>(PRICE_SELECT)).rows
    const before = byId(beforeRows)
    const historyBefore = (
      await query<{ price_snapshot: string; cost_credits: string }>(
        `SELECT price_snapshot::text AS price_snapshot,
                cost_credits::text AS cost_credits
           FROM usage_records
          WHERE request_id='pricing-0245-history'`,
      )
    ).rows[0]!

    await query(await readFile(migrationPath, 'utf8'))

    const afterRows = (await query<PriceRow>(PRICE_SELECT)).rows
    assert.equal(afterRows.length, beforeRows.length)
    const after = byId(afterRows)
    const targets = new Set<string>(TARGET_IDS)

    for (const actual of afterRows) {
      const previous = before.get(actual.model_id)
      assert.ok(previous, actual.model_id)
      if (!targets.has(actual.model_id)) {
        assertExactPrices(actual, previous)
        assertNonPriceState(actual, previous)
        assert.equal(actual.lock_version, previous.lock_version, actual.model_id)
        continue
      }
      assertNonPriceState(actual, previous)
      assert.equal(actual.lock_version, previous.lock_version + 1, actual.model_id)
    }

    for (const standardId of STANDARD_IDS) {
      const previous = before.get(standardId)!
      const actual = after.get(standardId)!
      const longId = LONG_BY_STANDARD.get(standardId)!
      const longPrevious = before.get(longId)!
      const longActual = after.get(longId)!
      assert.equal(actual.input_per_mtok, half(previous.input_per_mtok), standardId)
      assert.equal(actual.output_per_mtok, half(previous.output_per_mtok), standardId)
      assert.equal(actual.cache_read_per_mtok, half(previous.cache_read_per_mtok), standardId)
      assert.equal(actual.cache_write_per_mtok, half(previous.cache_write_per_mtok), standardId)
      assert.equal(longActual.input_per_mtok, fifteenXAfterHalf(previous.input_per_mtok), longId)
      assert.equal(longActual.output_per_mtok, fifteenXAfterHalf(previous.output_per_mtok), longId)
      assert.equal(
        longActual.cache_read_per_mtok,
        fifteenXAfterHalf(previous.cache_read_per_mtok),
        longId,
      )
      assert.equal(
        longActual.cache_write_per_mtok,
        fifteenXAfterHalf(previous.cache_write_per_mtok),
        longId,
      )
      assert.equal(longPrevious.visibility, longActual.visibility, longId)
    }

    const pro = after.get('deepseek-v4-pro')!
    assert.equal(xOf(after.get('gpt-5.6-sol')!, pro), 2.0)
    assert.equal(xOf(after.get('gpt-5.6-terra')!, pro), 1.0)
    assert.equal(after.get('gpt-5.6-luna')!.visibility, 'hidden')
    assert.equal(after.get('gpt-5.6-luna-1m')!.visibility, 'hidden')
    assert.equal(after.get('kimi-k3')!.input_per_mtok, before.get('kimi-k3')!.input_per_mtok)

    const backupCount = (
      await query<{ count: string }>(
        'SELECT count(*)::text AS count FROM model_pricing_0245_backup',
      )
    ).rows[0]!.count
    assert.equal(backupCount, '6')

    const historyAfter = (
      await query<{ price_snapshot: string; cost_credits: string }>(
        `SELECT price_snapshot::text AS price_snapshot,
                cost_credits::text AS cost_credits
           FROM usage_records
          WHERE request_id='pricing-0245-history'`,
      )
    ).rows[0]!
    assert.deepEqual(historyAfter, historyBefore)

    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
      requiredMigrations: string[]
    }
    assert.ok(metadata.requiredMigrations.includes('0245_gpt56_family_half_xn'))

    await query("INSERT INTO schema_migrations(version) VALUES ('0245_gpt56_family_half_xn')")
    await query(await readFile(rollbackPath, 'utf8'))

    const restoredRows = (await query<PriceRow>(PRICE_SELECT)).rows
    assert.equal(restoredRows.length, beforeRows.length)
    for (const actual of restoredRows) {
      const previous = before.get(actual.model_id)
      assert.ok(previous, actual.model_id)
      assertExactPrices(actual, previous)
      assertNonPriceState(actual, previous)
      assert.equal(
        actual.lock_version,
        previous.lock_version + (targets.has(actual.model_id) ? 2 : 0),
        actual.model_id,
      )
    }

    const compensationState = (
      await query<{ ledger_rows: string; backup_table: string | null }>(
        `SELECT
           (SELECT count(*)::text FROM schema_migrations
             WHERE version='0245_gpt56_family_half_xn') AS ledger_rows,
           to_regclass('public.model_pricing_0245_backup')::text AS backup_table`,
      )
    ).rows[0]!
    assert.equal(compensationState.ledger_rows, '1')
    assert.equal(compensationState.backup_table, 'model_pricing_0245_backup')
    assert.deepEqual(
      (
        await query<{ price_snapshot: string; cost_credits: string }>(
          `SELECT price_snapshot::text AS price_snapshot,
                  cost_credits::text AS cost_credits
             FROM usage_records
            WHERE request_id='pricing-0245-history'`,
        )
      ).rows[0],
      historyBefore,
    )
  })

  test('refuses a missing GPT-5.6 pair without changing live prices', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0245')
    await query("DELETE FROM model_pricing WHERE model_id='gpt-5.6-luna-1m'")
    const before = byId((await query<PriceRow>(PRICE_SELECT)).rows)

    await assert.rejects(
      tx(async (client) => {
        await client.query(await readFile(migrationPath, 'utf8'))
      }),
      /0245 expected exactly 6 GPT-5.6 rows, found 5/,
    )

    const after = byId((await query<PriceRow>(PRICE_SELECT)).rows)
    assert.equal(after.size, before.size)
    for (const [id, previous] of before) {
      const actual = after.get(id)
      assert.ok(actual, id)
      assertExactPrices(actual, previous)
      assert.equal(actual.lock_version, previous.lock_version, id)
    }
    const backup = (
      await query<{ backup_table: string | null }>(
        "SELECT to_regclass('public.model_pricing_0245_backup')::text AS backup_table",
      )
    ).rows[0]!
    assert.equal(backup.backup_table, null)
  })

  test('compensation locks the ledger and refuses later migrations or missing rows', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0245')

    const rollback = await readFile(rollbackPath, 'utf8')
    assert.match(
      rollback,
      /LOCK TABLE schema_migrations IN SHARE ROW EXCLUSIVE MODE;/,
      'later-migration check must hold a write-conflicting ledger lock through commit',
    )

    await query(await readFile(migrationPath, 'utf8'))
    await query("INSERT INTO schema_migrations(version) VALUES ('0245_gpt56_family_half_xn')")

    await query("INSERT INTO schema_migrations(version) VALUES ('0246_later_sentinel')")
    await assert.rejects(
      tx(async (client) => {
        await client.query(rollbackTransactionBody(rollback))
      }),
      /0245 rollback refuses when later migrations are already applied/,
    )
    await query("DELETE FROM schema_migrations WHERE version='0246_later_sentinel'")

    const luna1mBefore = (
      await query<{ input_per_mtok: string }>(
        "SELECT input_per_mtok::text AS input_per_mtok FROM model_pricing WHERE model_id='gpt-5.6-luna-1m'",
      )
    ).rows[0]!
    await query("DELETE FROM model_pricing WHERE model_id='gpt-5.6-luna'")
    await assert.rejects(
      tx(async (client) => {
        await client.query(rollbackTransactionBody(rollback))
      }),
      /0245 rollback expected 6 live GPT-5.6 rows, found 5/,
    )
    const luna1mAfter = (
      await query<{ input_per_mtok: string; ledger_rows: string; backup_table: string | null }>(
        `SELECT input_per_mtok::text AS input_per_mtok,
                (SELECT count(*)::text FROM schema_migrations
                  WHERE version='0245_gpt56_family_half_xn') AS ledger_rows,
                to_regclass('public.model_pricing_0245_backup')::text AS backup_table
           FROM model_pricing
          WHERE model_id='gpt-5.6-luna-1m'`,
      )
    ).rows[0]!
    assert.equal(luna1mAfter.input_per_mtok, luna1mBefore.input_per_mtok)
    assert.equal(luna1mAfter.ledger_rows, '1')
    assert.equal(luna1mAfter.backup_table, 'model_pricing_0245_backup')
  })
})
