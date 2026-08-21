/**
 * 0234 all-model half pricing + exact compensation snapshot.
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0234.integ.test.ts'
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { query } from '../db/queries.js'
import { resetAndMigrateBefore, useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('models_0234_test')
const here = path.dirname(fileURLToPath(import.meta.url))
const migrationPath = path.resolve(here, '../db/migrations/0234_all_model_prices_half.sql')
const rollbackPath = path.resolve(here, '../db/rollbacks/0234_all_model_prices_half.sql')

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

function assertHalf(actual: PriceRow, expected: PriceRow): void {
  assert.equal(
    actual.input_per_mtok,
    (BigInt(expected.input_per_mtok) / 2n).toString(),
    actual.model_id,
  )
  assert.equal(
    actual.output_per_mtok,
    (BigInt(expected.output_per_mtok) / 2n).toString(),
    actual.model_id,
  )
  assert.equal(
    actual.cache_read_per_mtok,
    (BigInt(expected.cache_read_per_mtok) / 2n).toString(),
    actual.model_id,
  )
  assert.equal(
    actual.cache_write_per_mtok,
    (BigInt(expected.cache_write_per_mtok) / 2n).toString(),
    actual.model_id,
  )
}

function assertExactPrices(actual: PriceRow, expected: PriceRow): void {
  assert.equal(actual.input_per_mtok, expected.input_per_mtok, actual.model_id)
  assert.equal(actual.output_per_mtok, expected.output_per_mtok, actual.model_id)
  assert.equal(actual.cache_read_per_mtok, expected.cache_read_per_mtok, actual.model_id)
  assert.equal(actual.cache_write_per_mtok, expected.cache_write_per_mtok, actual.model_id)
}

describe('0234_all_model_prices_half', () => {
  test('halves every row, preserves history, and compensates exactly', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0234')

    await query(
      `UPDATE model_pricing
          SET input_per_mtok = 451,
              output_per_mtok = 1351,
              cache_read_per_mtok = 15,
              cache_write_per_mtok = 3
        WHERE model_id = 'deepseek-v4-pro'`,
    )
    await query(
      `INSERT INTO users(id, email, email_verified, password_hash, role)
       VALUES (234, 'pricing-0234@example.invalid', TRUE, 'argon2$stub', 'admin')`,
    )
    await query(
      `INSERT INTO usage_records(
         user_id, mode, model, input_tokens, output_tokens, cache_read_tokens,
         cache_write_tokens, price_snapshot, cost_credits, request_id, status
       ) VALUES (
         234, 'chat', 'deepseek-v4-pro', 10, 5, 2, 1,
         '{"model_id":"deepseek-v4-pro","input_per_mtok":"451","output_per_mtok":"1351","cache_read_per_mtok":"15","cache_write_per_mtok":"3","multiplier":"1.000"}'::jsonb,
         777, 'pricing-0234-history', 'success'
       )`,
    )

    const beforeRows = (await query<PriceRow>(PRICE_SELECT)).rows
    assert.ok(beforeRows.length > 0)
    const before = byId(beforeRows)
    const historyBefore = (
      await query<{ price_snapshot: string; cost_credits: string }>(
        `SELECT price_snapshot::text AS price_snapshot,
                cost_credits::text AS cost_credits
           FROM usage_records
          WHERE request_id = 'pricing-0234-history'`,
      )
    ).rows[0]!

    await query(await readFile(migrationPath, 'utf8'))

    const afterRows = (await query<PriceRow>(PRICE_SELECT)).rows
    assert.equal(afterRows.length, beforeRows.length)
    for (const actual of afterRows) {
      const expected = before.get(actual.model_id)
      assert.ok(expected, actual.model_id)
      assertHalf(actual, expected)
      assertNonPriceState(actual, expected)
      assert.equal(actual.lock_version, expected.lock_version + 1, actual.model_id)
    }

    const backupRows = (
      await query<PriceRow>(
        PRICE_SELECT.replace('FROM model_pricing', 'FROM model_pricing_0234_backup'),
      )
    ).rows
    assert.equal(backupRows.length, beforeRows.length)
    for (const backup of backupRows) {
      const expected = before.get(backup.model_id)
      assert.ok(expected, backup.model_id)
      assertExactPrices(backup, expected)
      assertNonPriceState(backup, expected)
      assert.equal(backup.lock_version, expected.lock_version, backup.model_id)
    }

    const historyAfter = (
      await query<{ price_snapshot: string; cost_credits: string }>(
        `SELECT price_snapshot::text AS price_snapshot,
                cost_credits::text AS cost_credits
           FROM usage_records
          WHERE request_id = 'pricing-0234-history'`,
      )
    ).rows[0]!
    assert.deepEqual(historyAfter, historyBefore)

    await query("INSERT INTO schema_migrations(version) VALUES ('0234_all_model_prices_half')")
    await query(await readFile(rollbackPath, 'utf8'))

    const restoredRows = (await query<PriceRow>(PRICE_SELECT)).rows
    assert.equal(restoredRows.length, beforeRows.length)
    for (const actual of restoredRows) {
      const expected = before.get(actual.model_id)
      assert.ok(expected, actual.model_id)
      assertExactPrices(actual, expected)
      assertNonPriceState(actual, expected)
      assert.equal(actual.lock_version, expected.lock_version + 2, actual.model_id)
    }

    const historyRestored = (
      await query<{ price_snapshot: string; cost_credits: string }>(
        `SELECT price_snapshot::text AS price_snapshot,
                cost_credits::text AS cost_credits
           FROM usage_records
          WHERE request_id = 'pricing-0234-history'`,
      )
    ).rows[0]!
    assert.deepEqual(historyRestored, historyBefore)
  })
})
