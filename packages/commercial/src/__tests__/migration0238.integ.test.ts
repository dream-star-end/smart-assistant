/**
 * 0238: selectable 1M context tiers cost 1.5x their standard twins.
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial  *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0238.integ.test.ts'
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { query, tx } from '../db/queries.js'
import { resetAndMigrateBefore, useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('models_0238_test')
const here = path.dirname(fileURLToPath(import.meta.url))
const migrationPath = path.resolve(here, '../db/migrations/0238_long_context_price_15x.sql')
const rollbackPath = path.resolve(here, '../db/rollbacks/0238_long_context_price_15x.sql')
const metadataPath = path.resolve(here, '../../../../deploy/v5/release-metadata.json')

const PAIRS = new Map([
  ['gpt-5.6-sol-1m', 'gpt-5.6-sol'],
  ['gpt-5.6-terra-1m', 'gpt-5.6-terra'],
  ['gpt-5.6-luna-1m', 'gpt-5.6-luna'],
  ['kimi-k3', 'k3-256k'],
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

function rounded15x(value: string): string {
  const n = BigInt(value)
  return ((n * 3n + 1n) / 2n).toString()
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

function rollbackTransactionBody(sql: string): string {
  const begin = '\nBEGIN;\n'
  const commit = '\nCOMMIT;'
  assert.ok(sql.includes(begin), 'rollback must include BEGIN')
  assert.ok(sql.endsWith(`${commit}\n`), 'rollback must end with COMMIT')
  return sql.replace(begin, '\n').slice(0, -`${commit}\n`.length)
}

describe('0238_long_context_price_15x', () => {
  test('reprices only four long tiers, preserves history, and compensates exactly', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0238')

    // Exercise odd/even/zero rounding independently of the seeded catalog.
    await query(
      `UPDATE model_pricing
          SET input_per_mtok=5, output_per_mtok=4,
              cache_read_per_mtok=3, cache_write_per_mtok=0
        WHERE model_id='gpt-5.6-luna'`,
    )
    await query(
      `INSERT INTO users(id, email, email_verified, password_hash, role)
       VALUES (238, 'pricing-0238@example.invalid', TRUE, 'argon2$stub', 'admin')`,
    )
    await query(
      `INSERT INTO usage_records(
         user_id, mode, model, input_tokens, output_tokens, cache_read_tokens,
         cache_write_tokens, price_snapshot, cost_credits, request_id, status
       ) VALUES (
         238, 'chat', 'gpt-5.6-sol-1m', 10, 5, 2, 1,
         '{"model_id":"gpt-5.6-sol-1m","input_per_mtok":"1199","output_per_mtok":"7197","cache_read_per_mtok":"120","cache_write_per_mtok":"0","multiplier":"1.000"}'::jsonb,
         8160, 'pricing-0238-history', 'success'
       )`,
    )

    const beforeRows = (await query<PriceRow>(PRICE_SELECT)).rows
    const before = byId(beforeRows)
    const historyBefore = (
      await query<{ price_snapshot: string; cost_credits: string }>(
        `SELECT price_snapshot::text AS price_snapshot,
                cost_credits::text AS cost_credits
           FROM usage_records
          WHERE request_id='pricing-0238-history'`,
      )
    ).rows[0]!

    await query(await readFile(migrationPath, 'utf8'))

    const afterRows = (await query<PriceRow>(PRICE_SELECT)).rows
    assert.equal(afterRows.length, beforeRows.length)
    for (const actual of afterRows) {
      const previous = before.get(actual.model_id)
      assert.ok(previous, actual.model_id)
      const standardId = PAIRS.get(actual.model_id)
      if (!standardId) {
        assertExactPrices(actual, previous)
        assertNonPriceState(actual, previous)
        assert.equal(actual.lock_version, previous.lock_version, actual.model_id)
        continue
      }
      const standard = before.get(standardId)
      assert.ok(standard, standardId)
      assert.equal(actual.input_per_mtok, rounded15x(standard.input_per_mtok), actual.model_id)
      assert.equal(actual.output_per_mtok, rounded15x(standard.output_per_mtok), actual.model_id)
      assert.equal(
        actual.cache_read_per_mtok,
        rounded15x(standard.cache_read_per_mtok),
        actual.model_id,
      )
      assert.equal(
        actual.cache_write_per_mtok,
        rounded15x(standard.cache_write_per_mtok),
        actual.model_id,
      )
      assertNonPriceState(actual, previous)
      assert.equal(actual.lock_version, previous.lock_version + 1, actual.model_id)
    }

    const backupCount = (
      await query<{ count: string }>(
        'SELECT count(*)::text AS count FROM model_pricing_0238_backup',
      )
    ).rows[0]!.count
    assert.equal(backupCount, '4')

    const historyAfter = (
      await query<{ price_snapshot: string; cost_credits: string }>(
        `SELECT price_snapshot::text AS price_snapshot,
                cost_credits::text AS cost_credits
           FROM usage_records
          WHERE request_id='pricing-0238-history'`,
      )
    ).rows[0]!
    assert.deepEqual(historyAfter, historyBefore)

    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
      requiredMigrations: string[]
    }
    assert.ok(metadata.requiredMigrations.includes('0238_long_context_price_15x'))

    await query("INSERT INTO schema_migrations(version) VALUES ('0238_long_context_price_15x')")
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
        previous.lock_version + (PAIRS.has(actual.model_id) ? 2 : 0),
        actual.model_id,
      )
    }

    const compensationState = (
      await query<{ ledger_rows: string; backup_table: string | null }>(
        `SELECT
           (SELECT count(*)::text FROM schema_migrations
             WHERE version='0238_long_context_price_15x') AS ledger_rows,
           to_regclass('public.model_pricing_0238_backup')::text AS backup_table`,
      )
    ).rows[0]!
    assert.equal(compensationState.ledger_rows, '0')
    assert.equal(compensationState.backup_table, null)

    // A release retry can now run the normal migration again instead of
    // skipping a compensated old-price state.
    await query(await readFile(migrationPath, 'utf8'))
    const reapplied = byId((await query<PriceRow>(PRICE_SELECT)).rows)
    for (const [longId, standardId] of PAIRS) {
      const actual = reapplied.get(longId)
      const standard = before.get(standardId)
      const previous = before.get(longId)
      assert.ok(actual && standard && previous)
      assert.equal(actual.input_per_mtok, rounded15x(standard.input_per_mtok), longId)
      assert.equal(actual.output_per_mtok, rounded15x(standard.output_per_mtok), longId)
      assert.equal(actual.cache_read_per_mtok, rounded15x(standard.cache_read_per_mtok), longId)
      assert.equal(actual.cache_write_per_mtok, rounded15x(standard.cache_write_per_mtok), longId)
      assert.equal(actual.lock_version, previous.lock_version + 3, longId)
    }

    const historyRestored = (
      await query<{ price_snapshot: string; cost_credits: string }>(
        `SELECT price_snapshot::text AS price_snapshot,
                cost_credits::text AS cost_credits
           FROM usage_records
          WHERE request_id='pricing-0238-history'`,
      )
    ).rows[0]!
    assert.deepEqual(historyRestored, historyBefore)
  })

  test('compensation locks the ledger and refuses a missing standard tier atomically', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0238')

    const migration = await readFile(migrationPath, 'utf8')
    const rollback = await readFile(rollbackPath, 'utf8')
    assert.match(
      rollback,
      /LOCK TABLE schema_migrations IN SHARE ROW EXCLUSIVE MODE;/,
      'later-migration check must hold a write-conflicting ledger lock through commit',
    )

    await query(migration)
    await query("INSERT INTO schema_migrations(version) VALUES ('0238_long_context_price_15x')")
    await query("DELETE FROM model_pricing WHERE model_id='gpt-5.6-luna'")

    const before = (
      await query<{ input_per_mtok: string }>(
        "SELECT input_per_mtok::text AS input_per_mtok FROM model_pricing WHERE model_id='gpt-5.6-luna-1m'",
      )
    ).rows[0]!

    await assert.rejects(
      tx(async (client) => {
        await client.query(rollbackTransactionBody(rollback))
      }),
      /0238 rollback expected 4 standard-tier rows, found 3/,
    )

    const after = (
      await query<{ input_per_mtok: string; ledger_rows: string; backup_table: string | null }>(
        `SELECT input_per_mtok::text AS input_per_mtok,
                (SELECT count(*)::text FROM schema_migrations
                  WHERE version='0238_long_context_price_15x') AS ledger_rows,
                to_regclass('public.model_pricing_0238_backup')::text AS backup_table
           FROM model_pricing
          WHERE model_id='gpt-5.6-luna-1m'`,
      )
    ).rows[0]!
    assert.equal(after.input_per_mtok, before.input_per_mtok)
    assert.equal(after.ledger_rows, '1')
    assert.equal(after.backup_table, 'model_pricing_0238_backup')
  })
})
