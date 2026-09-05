/**
 * 0256 Cursor picker: Lite plan gate, half-price promo, Composer 2.5 retirement.
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0256.integ.test.ts'
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CURSOR_ENGINE_MODELS } from '@openclaude/protocol'
import { query, tx } from '../db/queries.js'
import { resetAndMigrateBefore, useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('models_0256_test')
const here = path.dirname(fileURLToPath(import.meta.url))
const migrationPath = path.resolve(
  here,
  '../db/migrations/0256_cursor_picker_plan_gate_half_price.sql',
)
const rollbackPath = path.resolve(
  here,
  '../db/rollbacks/0256_cursor_picker_plan_gate_half_price.sql',
)
const metadataPath = path.resolve(here, '../../../../deploy/v5/release-metadata.json')

const TARGET_IDS = [
  'cursor-opus-4.8-low',
  'cursor-opus-4.8-low-fast',
  'cursor-opus-4.8-medium',
  'cursor-opus-4.8-medium-fast',
  'cursor-opus-4.8-high',
  'cursor-opus-4.8-high-fast',
  'cursor-opus-4.8-xhigh',
  'cursor-opus-4.8-xhigh-fast',
  'cursor-opus-4.8-max',
  'cursor-opus-4.8-max-fast',
  'cursor-opus-5-low',
  'cursor-opus-5-low-fast',
  'cursor-opus-5-medium',
  'cursor-opus-5-medium-fast',
  'cursor-opus-5-high',
  'cursor-opus-5-high-fast',
  'cursor-opus-5-xhigh',
  'cursor-opus-5-xhigh-fast',
  'cursor-opus-5-max',
  'cursor-opus-5-max-fast',
  'cursor-fable-5-low',
  'cursor-fable-5-medium',
  'cursor-fable-5-high',
  'cursor-fable-5-xhigh',
  'cursor-fable-5-max',
  'cursor-fable-5.1-low',
  'cursor-fable-5.1-medium',
  'cursor-fable-5.1-high',
  'cursor-fable-5.1-xhigh',
  'cursor-fable-5.1-max',
] as const

const COMPOSER_IDS = ['cursor-composer-2.5', 'cursor-composer-2.5-fast'] as const
const OPUS_BEFORE = { input: '1523', output: '7617', cacheRead: '152', cacheWrite: '0' }
const FABLE_BEFORE = { input: '3049', output: '15243', cacheRead: '305', cacheWrite: '0' }

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
  promo_label: string | null
}

function priceSelect(withPromo: boolean): string {
  return `
  SELECT model_id, display_name,
         input_per_mtok::text AS input_per_mtok,
         output_per_mtok::text AS output_per_mtok,
         cache_read_per_mtok::text AS cache_read_per_mtok,
         cache_write_per_mtok::text AS cache_write_per_mtok,
         multiplier::text AS multiplier,
         enabled, sort_order, updated_by::text AS updated_by, visibility,
         extra_system_prompt, default_effort, lock_version, min_plan_code,
         ${withPromo ? 'promo_label' : 'NULL::text AS promo_label'}
    FROM model_pricing
   ORDER BY model_id
`
}

function byId(rows: PriceRow[]): Map<string, PriceRow> {
  return new Map(rows.map((row) => [row.model_id, row]))
}

function half(value: string): string {
  return (BigInt(value) / 2n).toString()
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

describe('0256_cursor_picker_plan_gate_half_price', () => {
  test('gates Opus/Fable behind lite, halves fen, strips Cursor prefix, retires Composer', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0256')

    const uniqueProtocol = [...new Set(CURSOR_ENGINE_MODELS.map((model) => model.id))]
    const cursorBefore = (
      await query<{ count: string }>(
        `SELECT count(*)::text AS count FROM model_pricing WHERE model_id LIKE 'cursor-%'`,
      )
    ).rows[0]!.count
    assert.equal(cursorBefore, '42')
    // Later families (0259 Gemini 3.8 Flash, ...) grow the protocol registry
    // past the 0256-era 42; every 0256-era catalog id must still be a
    // protocol id, but the registry may be a superset.
    const catalogBefore = (
      await query<{ model_id: string }>(
        `SELECT model_id FROM model_pricing WHERE model_id LIKE 'cursor-%'`,
      )
    ).rows.map((row) => row.model_id)
    const protocolIds = new Set<string>(uniqueProtocol)
    for (const id of catalogBefore) {
      assert.ok(protocolIds.has(id), `catalog ${id} missing from protocol CURSOR_ENGINE_MODELS`)
    }
    assert.ok(uniqueProtocol.length >= 42, 'protocol unique CURSOR_ENGINE_MODELS must cover catalog')

    const beforeRows = (await query<PriceRow>(priceSelect(false))).rows
    const before = byId(beforeRows)
    const targets = new Set<string>(TARGET_IDS)
    const composers = new Set<string>(COMPOSER_IDS)

    for (const id of TARGET_IDS) {
      const row = before.get(id)
      assert.ok(row, id)
      const expected = id.includes('fable') ? FABLE_BEFORE : OPUS_BEFORE
      assert.equal(row.input_per_mtok, expected.input, id)
      assert.equal(row.output_per_mtok, expected.output, id)
      assert.equal(row.cache_read_per_mtok, expected.cacheRead, id)
      assert.equal(row.cache_write_per_mtok, expected.cacheWrite, id)
      assert.equal(row.min_plan_code, null, id)
      assert.equal(row.promo_label, null, id)
    }

    assert.equal(before.get('cursor-auto')?.display_name, 'Cursor Auto')
    assert.ok(before.get('cursor-opus-5-high')?.display_name.startsWith('Cursor '))
    assert.ok(before.get('cursor-grok-4.6-high')?.display_name.startsWith('Cursor '))

    const groupBefore = (
      await query<{ count: string }>(
        `SELECT count(*)::text AS count FROM account_group_models
          WHERE model_id IN ('cursor-composer-2.5','cursor-composer-2.5-fast')`,
      )
    ).rows[0]!.count
    assert.equal(groupBefore, '2')

    await query(
      `INSERT INTO users(id, email, email_verified, password_hash, role)
       VALUES (256, 'pricing-0256@example.invalid', TRUE, 'argon2$stub', 'admin')`,
    )
    await query(
      `INSERT INTO usage_records(
         user_id, mode, model, input_tokens, output_tokens, cache_read_tokens,
         cache_write_tokens, price_snapshot, cost_credits, request_id, status
       ) VALUES (
         256, 'chat', 'cursor-opus-5-high', 10, 5, 2, 1,
         '{"model_id":"cursor-opus-5-high","input_per_mtok":"1523","output_per_mtok":"7617","cache_read_per_mtok":"152","cache_write_per_mtok":"0","multiplier":"1.000"}'::jsonb,
         4242, 'pricing-0256-history', 'success'
       )`,
    )
    const historyBefore = (
      await query<{ price_snapshot: string; cost_credits: string }>(
        `SELECT price_snapshot::text AS price_snapshot,
                cost_credits::text AS cost_credits
           FROM usage_records
          WHERE request_id='pricing-0256-history'`,
      )
    ).rows[0]!

    await query(await readFile(migrationPath, 'utf8'))

    const afterRows = (await query<PriceRow>(priceSelect(true))).rows
    assert.equal(afterRows.length, beforeRows.length)
    const after = byId(afterRows)

    for (const actual of afterRows) {
      const previous = before.get(actual.model_id)
      assert.ok(previous, actual.model_id)
      if (targets.has(actual.model_id)) {
        assert.equal(actual.input_per_mtok, half(previous.input_per_mtok), actual.model_id)
        assert.equal(actual.output_per_mtok, half(previous.output_per_mtok), actual.model_id)
        assert.equal(actual.cache_read_per_mtok, half(previous.cache_read_per_mtok), actual.model_id)
        assert.equal(actual.cache_write_per_mtok, half(previous.cache_write_per_mtok), actual.model_id)
        assert.equal(actual.multiplier, previous.multiplier, actual.model_id)
        assert.equal(actual.min_plan_code, 'lite', actual.model_id)
        assert.equal(actual.promo_label, '限时半价', actual.model_id)
        assert.equal(actual.display_name, previous.display_name.replace(/^Cursor /, ''), actual.model_id)
        assert.equal(actual.enabled, previous.enabled, actual.model_id)
        assert.equal(actual.visibility, previous.visibility, actual.model_id)
        continue
      }
      if (composers.has(actual.model_id)) {
        assertExactPrices(actual, previous)
        assert.equal(actual.enabled, false, actual.model_id)
        assert.equal(actual.visibility, 'hidden', actual.model_id)
        assert.equal(actual.display_name, previous.display_name.replace(/^Cursor /, ''), actual.model_id)
        assert.equal(actual.min_plan_code, previous.min_plan_code, actual.model_id)
        assert.equal(actual.promo_label, previous.promo_label, actual.model_id)
        continue
      }
      assertExactPrices(actual, previous)
      assert.equal(actual.multiplier, previous.multiplier, actual.model_id)
      assert.equal(actual.enabled, previous.enabled, actual.model_id)
      assert.equal(actual.min_plan_code, previous.min_plan_code, actual.model_id)
      assert.equal(actual.promo_label, previous.promo_label, actual.model_id)
      if (actual.model_id === 'cursor-auto') {
        assert.equal(actual.display_name, 'Cursor Auto')
      } else if (actual.model_id.startsWith('cursor-')) {
        assert.equal(actual.display_name, previous.display_name.replace(/^Cursor /, ''), actual.model_id)
        assert.equal(actual.visibility, previous.visibility, actual.model_id)
      } else {
        assert.equal(actual.display_name, previous.display_name, actual.model_id)
        assert.equal(actual.visibility, previous.visibility, actual.model_id)
      }
    }

    const catalogComposer = await query<{ model_id: string; state: string }>(
      `SELECT model_id, state FROM model_catalog
        WHERE model_id IN ('cursor-composer-2.5','cursor-composer-2.5-fast')
        ORDER BY model_id`,
    )
    assert.deepEqual(
      catalogComposer.rows.map((row) => row.state),
      ['disabled', 'disabled'],
    )
    const groupAfter = (
      await query<{ count: string }>(
        `SELECT count(*)::text AS count FROM account_group_models
          WHERE model_id IN ('cursor-composer-2.5','cursor-composer-2.5-fast')`,
      )
    ).rows[0]!.count
    assert.equal(groupAfter, '0')

    assert.equal(after.get('kimi-k3')!.input_per_mtok, before.get('kimi-k3')!.input_per_mtok)
    assert.equal(after.get('cursor-grok-4.6-high')!.input_per_mtok, before.get('cursor-grok-4.6-high')!.input_per_mtok)
    assert.equal(after.get('cursor-grok-4.6-high')!.display_name, 'Grok 4.6 High')
    assert.equal(after.get('cursor-opus-5-high')!.display_name, 'Opus 5 High')
    assert.ok(after.get('cursor-fable-5-high')!.display_name.startsWith('Fable 5'))
    assert.ok(!after.get('cursor-fable-5-high')!.display_name.startsWith('Cursor '))

    const backupCount = (
      await query<{ count: string }>(
        'SELECT count(*)::text AS count FROM model_pricing_0256_backup',
      )
    ).rows[0]!.count
    assert.equal(backupCount, '30')

    const historyAfter = (
      await query<{ price_snapshot: string; cost_credits: string }>(
        `SELECT price_snapshot::text AS price_snapshot,
                cost_credits::text AS cost_credits
           FROM usage_records
          WHERE request_id='pricing-0256-history'`,
      )
    ).rows[0]!
    assert.deepEqual(historyAfter, historyBefore)

    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
      requiredMigrations: string[]
    }
    assert.ok(metadata.requiredMigrations.includes('0256_cursor_picker_plan_gate_half_price'))

    await assert.rejects(
      tx(async (client) => {
        await client.query(await readFile(migrationPath, 'utf8'))
      }),
      /0256 refuses replay because model_pricing_0256_backup already exists/,
    )
    assert.equal(byId((await query<PriceRow>(priceSelect(true))).rows).get('cursor-opus-5-high')!.input_per_mtok, half(OPUS_BEFORE.input))

    await query("INSERT INTO schema_migrations(version) VALUES ('0256_cursor_picker_plan_gate_half_price')")
    await query(await readFile(rollbackPath, 'utf8'))

    const restored = byId((await query<PriceRow>(priceSelect(true))).rows)
    for (const id of TARGET_IDS) {
      const previous = before.get(id)!
      const actual = restored.get(id)!
      assertExactPrices(actual, previous)
      assert.equal(actual.min_plan_code, previous.min_plan_code, id)
      assert.equal(actual.promo_label, previous.promo_label, id)
      assert.equal(actual.display_name, previous.display_name, id)
    }
    for (const id of COMPOSER_IDS) {
      const previous = before.get(id)!
      const actual = restored.get(id)!
      assertExactPrices(actual, previous)
      assert.equal(actual.enabled, true, id)
      assert.equal(actual.visibility, 'public', id)
      assert.equal(actual.display_name, previous.display_name, id)
    }
    assert.equal(restored.get('cursor-auto')!.display_name, 'Cursor Auto')
    assert.equal(restored.get('cursor-grok-4.6-high')!.display_name, before.get('cursor-grok-4.6-high')!.display_name)
    const composerState = await query<{ state: string }>(
      `SELECT state FROM model_catalog WHERE model_id='cursor-composer-2.5'`,
    )
    assert.equal(composerState.rows[0]!.state, 'active')
    const groupRestored = (
      await query<{ count: string }>(
        `SELECT count(*)::text AS count FROM account_group_models
          WHERE model_id IN ('cursor-composer-2.5','cursor-composer-2.5-fast')`,
      )
    ).rows[0]!.count
    assert.equal(groupRestored, '2')

    const compensationState = (
      await query<{ ledger_rows: string; backup_table: string | null }>(
        `SELECT
           (SELECT count(*)::text FROM schema_migrations
             WHERE version='0256_cursor_picker_plan_gate_half_price') AS ledger_rows,
           to_regclass('public.model_pricing_0256_backup')::text AS backup_table`,
      )
    ).rows[0]!
    assert.equal(compensationState.ledger_rows, '1')
    assert.equal(compensationState.backup_table, 'model_pricing_0256_backup')
    assert.deepEqual(
      (
        await query<{ price_snapshot: string; cost_credits: string }>(
          `SELECT price_snapshot::text AS price_snapshot,
                  cost_credits::text AS cost_credits
             FROM usage_records
            WHERE request_id='pricing-0256-history'`,
        )
      ).rows[0],
      historyBefore,
    )
  })

  test('refuses unexpected before-image prices without changing live rows', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0256')
    await query(
      `UPDATE model_pricing SET input_per_mtok = 1 WHERE model_id='cursor-opus-5-high'`,
    )
    const before = byId((await query<PriceRow>(priceSelect(false))).rows)

    await assert.rejects(
      tx(async (client) => {
        await client.query(await readFile(migrationPath, 'utf8'))
      }),
      /0256 refuses unexpected Opus\/Fable before-image prices/,
    )

    const after = byId((await query<PriceRow>(priceSelect(false))).rows)
    assert.equal(after.size, before.size)
    for (const [id, previous] of before) {
      const actual = after.get(id)
      assert.ok(actual, id)
      assertExactPrices(actual, previous)
      assert.equal(actual.lock_version, previous.lock_version, id)
      assert.equal(actual.display_name, previous.display_name, id)
    }
    const backup = (
      await query<{ backup_table: string | null }>(
        "SELECT to_regclass('public.model_pricing_0256_backup')::text AS backup_table",
      )
    ).rows[0]!
    assert.equal(backup.backup_table, null)
  })

  test('refuses Composer disable while a preference reference remains', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0256')
    await query(
      `INSERT INTO users(id, email, email_verified, password_hash, role)
       VALUES (2561, 'composer-0256@example.invalid', TRUE, 'argon2$stub', 'user')`,
    )
    await query(
      `INSERT INTO user_preferences(user_id, prefs)
       VALUES (2561, '{"default_model":"cursor-composer-2.5"}'::jsonb)`,
    )
    const before = byId((await query<PriceRow>(priceSelect(false))).rows)

    await assert.rejects(
      tx(async (client) => {
        await client.query(await readFile(migrationPath, 'utf8'))
      }),
      /0256 refuses Composer 2.5 disable while persisted references remain/,
    )

    const after = byId((await query<PriceRow>(priceSelect(false))).rows)
    assertExactPrices(after.get('cursor-composer-2.5')!, before.get('cursor-composer-2.5')!)
    assert.equal(after.get('cursor-composer-2.5')!.enabled, true)
    const backup = (
      await query<{ backup_table: string | null }>(
        "SELECT to_regclass('public.model_pricing_0256_backup')::text AS backup_table",
      )
    ).rows[0]!
    assert.equal(backup.backup_table, null)
  })

  test('refuses Composer pricing that is not public without changing live rows', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0256')
    await query(
      `UPDATE model_pricing SET visibility = 'hidden' WHERE model_id='cursor-composer-2.5'`,
    )
    const before = byId((await query<PriceRow>(priceSelect(false))).rows)
    const groupBefore = (
      await query<{ count: string }>(
        `SELECT count(*)::text AS count FROM account_group_models
          WHERE model_id IN ('cursor-composer-2.5','cursor-composer-2.5-fast')`,
      )
    ).rows[0]!.count

    await assert.rejects(
      tx(async (client) => {
        await client.query(await readFile(migrationPath, 'utf8'))
      }),
      /0256 requires two active enabled public Composer 2.5 catalog\/pricing rows/,
    )

    const after = byId((await query<PriceRow>(priceSelect(false))).rows)
    assert.equal(after.size, before.size)
    for (const [id, previous] of before) {
      const actual = after.get(id)
      assert.ok(actual, id)
      assertExactPrices(actual, previous)
      assert.equal(actual.lock_version, previous.lock_version, id)
      assert.equal(actual.display_name, previous.display_name, id)
      assert.equal(actual.visibility, previous.visibility, id)
      assert.equal(actual.enabled, previous.enabled, id)
    }
    assert.equal(after.get('cursor-composer-2.5')!.visibility, 'hidden')
    const groupAfter = (
      await query<{ count: string }>(
        `SELECT count(*)::text AS count FROM account_group_models
          WHERE model_id IN ('cursor-composer-2.5','cursor-composer-2.5-fast')`,
      )
    ).rows[0]!.count
    assert.equal(groupAfter, groupBefore)
    const catalogState = await query<{ state: string }>(
      `SELECT state FROM model_catalog WHERE model_id='cursor-composer-2.5'`,
    )
    assert.equal(catalogState.rows[0]!.state, 'active')
    const backup = (
      await query<{ backup_table: string | null }>(
        "SELECT to_regclass('public.model_pricing_0256_backup')::text AS backup_table",
      )
    ).rows[0]!
    assert.equal(backup.backup_table, null)
  })

  test('compensation locks the ledger and refuses later migrations', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0256')

    const rollback = await readFile(rollbackPath, 'utf8')
    assert.match(
      rollback,
      /LOCK TABLE schema_migrations IN SHARE ROW EXCLUSIVE MODE;/,
      'later-migration check must hold a write-conflicting ledger lock through commit',
    )

    await query(await readFile(migrationPath, 'utf8'))
    await query("INSERT INTO schema_migrations(version) VALUES ('0256_cursor_picker_plan_gate_half_price')")
    await query("INSERT INTO schema_migrations(version) VALUES ('0257_later_sentinel')")
    await assert.rejects(
      tx(async (client) => {
        await client.query(rollbackTransactionBody(rollback))
      }),
      /0256 rollback refuses when later migrations are already applied/,
    )
    await query("DELETE FROM schema_migrations WHERE version='0257_later_sentinel'")
  })
})
