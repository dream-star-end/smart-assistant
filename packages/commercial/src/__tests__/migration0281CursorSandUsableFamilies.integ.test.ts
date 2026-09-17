/**
 * 0281 Cursor Sand usable families: public Grok 4.6, re-enable Composer 2.5,
 * Haiku CHECK, GPT-5.6 Luna Sand, Gemini 3.1 Pro.
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0281CursorSandUsableFamilies.integ.test.ts'
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { query } from '../db/queries.js'
import { resetAndMigrateBefore, useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('models_0281_cursor_sand_usable_test')
const here = path.dirname(fileURLToPath(import.meta.url))
const migrationPath = path.resolve(here, '../db/migrations/0281_cursor_sand_usable_families.sql')

const LUNA_IDS = [
  'cursor-gpt-5.6-luna-low',
  'cursor-gpt-5.6-luna-low-fast',
  'cursor-gpt-5.6-luna-medium',
  'cursor-gpt-5.6-luna-medium-fast',
  'cursor-gpt-5.6-luna-high',
  'cursor-gpt-5.6-luna-high-fast',
  'cursor-gpt-5.6-luna-xhigh',
  'cursor-gpt-5.6-luna-xhigh-fast',
  'cursor-gpt-5.6-luna-max',
  'cursor-gpt-5.6-luna-max-fast',
] as const

async function loadSql(): Promise<string> {
  return readFile(migrationPath, 'utf8')
}

describe('0281_cursor_sand_usable_families', () => {
  test('re-enables Composer, publishes Grok 4.6, adds Luna Sand and Gemini 3.1 Pro', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0281')
    await query(await loadSql())

    const composer = await query<{ state: string; enabled: boolean; visibility: string }>(
      `SELECT c.state, p.enabled, p.visibility
         FROM model_catalog c JOIN model_pricing p USING (model_id)
        WHERE c.model_id = 'cursor-composer-2.5'`,
    )
    assert.equal(composer.rows[0]?.state, 'active')
    assert.equal(composer.rows[0]?.enabled, true)
    assert.equal(composer.rows[0]?.visibility, 'public')

    const grokPublic = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM model_pricing
        WHERE model_id LIKE 'cursor-grok-4.6-%' AND visibility = 'public'`,
    )
    assert.equal(grokPublic.rows[0]?.count, '8')

    const luna = await query<{
      model_id: string
      upstream_model_id: string
      multiplier: string
      visibility: string
      enabled: boolean
    }>(
      `SELECT c.model_id, c.upstream_model_id, p.multiplier::text AS multiplier,
              p.visibility, p.enabled
         FROM model_catalog c JOIN model_pricing p USING (model_id)
        WHERE c.model_id = ANY($1::text[])
        ORDER BY c.model_id`,
      [LUNA_IDS],
    )
    assert.equal(luna.rows.length, 10)
    const grok = await query<{
      input_per_mtok: string
      output_per_mtok: string
      cache_read_per_mtok: string
      cache_write_per_mtok: string
    }>(
      `SELECT input_per_mtok::text, output_per_mtok::text,
              cache_read_per_mtok::text, cache_write_per_mtok::text
         FROM model_pricing WHERE model_id = 'cursor-grok-4.6-high'`,
    )
    const base = grok.rows[0]!
    for (const row of luna.rows) {
      assert.equal(row.enabled, true)
      assert.equal(row.visibility, 'public')
      const fast = row.model_id.endsWith('-fast')
      assert.equal(Number(row.multiplier), fast ? 2 : 1)
    }
    const prices = await query<{ input_per_mtok: string }>(
      `SELECT input_per_mtok::text FROM model_pricing WHERE model_id = 'cursor-gpt-5.6-luna-high'`,
    )
    assert.equal(prices.rows[0]?.input_per_mtok, base.input_per_mtok)

    const gemini = await query<{
      upstream_model_id: string
      state: string
      enabled: boolean
      visibility: string
      multiplier: string
    }>(
      `SELECT c.upstream_model_id, c.state, p.enabled, p.visibility, p.multiplier::text AS multiplier
         FROM model_catalog c JOIN model_pricing p USING (model_id)
        WHERE c.model_id = 'cursor-gemini-3.1-pro'`,
    )
    assert.equal(gemini.rows[0]?.upstream_model_id, 'gemini-3.1-pro')
    assert.equal(gemini.rows[0]?.state, 'active')
    assert.equal(gemini.rows[0]?.enabled, true)
    assert.equal(gemini.rows[0]?.visibility, 'public')
    assert.equal(Number(gemini.rows[0]?.multiplier), 1)

    const grants = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM model_visibility_grants
        WHERE model_id = ANY($1::text[]) OR model_id = 'cursor-gemini-3.1-pro'`,
      [LUNA_IDS],
    )
    assert.equal(grants.rows[0]?.count, '0')
  })

  test('audit CHECK lists Haiku, Luna Sand and Gemini 3.1 Pro', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0281')
    await query(await loadSql())
    const def = await query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = 'cursor_external_usage_audit'::regclass
          AND conname = 'cursor_external_usage_audit_model_id_check'`,
    )
    const text = def.rows[0]?.def ?? ''
    assert.match(text, /cursor-haiku-4\.5/)
    assert.match(text, /cursor-gemini-3\.1-pro/)
    assert.match(text, /cursor-gpt-5\.6-luna-high/)
    assert.match(text, /cursor-gpt-5\.6-luna-max-fast/)
    assert.match(text, /cursor-composer-2\.5/)
    assert.doesNotMatch(text, /gpt-5\.6-luna-none/)
  })

  test('converges an exact pre-existing family without duplicating rows', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0281')
    await query(await loadSql())
    await query(await loadSql())
    const count = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM model_catalog WHERE model_id = ANY($1::text[])`,
      [LUNA_IDS],
    )
    assert.equal(count.rows[0]?.count, '10')
  })
})
