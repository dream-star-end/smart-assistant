/**
 * 0258 Cursor Opus 5 / Opus 4.8 / Fable 5 / Fable 5.1 catalog context_window → 1M.
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0258.integ.test.ts'
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { query } from '../db/queries.js'
import { resetAndMigrateBefore, useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('models_0258_cursor_ctx_1m_test')
const here = path.dirname(fileURLToPath(import.meta.url))
const migrationPath = path.resolve(here, '../db/migrations/0258_cursor_opus_fable_context_1m.sql')
const metadataPath = path.resolve(here, '../../../../deploy/v5/release-metadata.json')

const FAMILY_RE = '^cursor-(opus-5|opus-4\\.8|fable-5|fable-5\\.1)-'

type ActiveRow = {
  model_id: string
  entry_id: string
  upstream_model_id: string | null
  context_window: number | null
  capability_profile: unknown
}

async function activeFamilyRows(): Promise<ActiveRow[]> {
  const r = await query<ActiveRow>(
    `SELECT model_id, entry_id::text AS entry_id, upstream_model_id, context_window, capability_profile
       FROM model_catalog
      WHERE state = 'active' AND model_id ~ $1
      ORDER BY model_id`,
    [FAMILY_RE],
  )
  return r.rows
}

async function pricingSnapshot(): Promise<unknown> {
  const r = await query<{ snap: unknown }>(
    `SELECT COALESCE(jsonb_agg(to_jsonb(p) - ARRAY['updated_at', 'lock_version'] ORDER BY p.model_id), '[]'::jsonb) AS snap
       FROM model_pricing p WHERE p.model_id ~ $1`,
    [FAMILY_RE],
  )
  return r.rows[0]!.snap
}

async function epoch(): Promise<number> {
  const r = await query<{ epoch: string }>('SELECT epoch::text AS epoch FROM model_security_epoch')
  return Number(r.rows[0]!.epoch)
}

describe('0258_cursor_opus_fable_context_1m', () => {
  test('switches every active Opus 5 / 4.8 / Fable 5 / 5.1 row to context_window=1M via switch_version, pricing untouched', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0258')

    const before = await activeFamilyRows()
    assert.ok(before.length >= 20, `expected the four families to be active pre-0258, got ${before.length}`)
    for (const row of before) {
      assert.ok(row.context_window === null || row.context_window === 200000, `${row.model_id} pre-image window ${row.context_window}`)
    }
    const pricingBefore = await pricingSnapshot()
    const epochBefore = await epoch()

    const sql = await readFile(migrationPath, 'utf8')
    assert.match(sql, /^-- order-dependency: 0257_cursor_session_credential/m)
    await query(sql)

    const after = await activeFamilyRows()
    assert.deepEqual(after.map((r) => r.model_id), before.map((r) => r.model_id), 'same active model ids')
    const beforeById = new Map(before.map((r) => [r.model_id, r]))
    for (const row of after) {
      const prev = beforeById.get(row.model_id)!
      assert.equal(row.context_window, 1000000, row.model_id)
      assert.notEqual(row.entry_id, prev.entry_id, `${row.model_id} must be a new catalog entry`)
      assert.equal(row.upstream_model_id, prev.upstream_model_id, `${row.model_id} upstream id preserved`)
      assert.deepEqual(row.capability_profile, prev.capability_profile, `${row.model_id} capability profile preserved`)
    }
    // Previous entries are retired, not deleted.
    const retired = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM model_catalog
        WHERE state = 'retired' AND entry_id = ANY($1::bigint[])`,
      [before.map((r) => r.entry_id)],
    )
    assert.equal(retired.rows[0]?.count, String(before.length))

    // Other Cursor families are not touched.
    const grok = await query<{ context_window: number | null }>(
      `SELECT context_window FROM model_catalog WHERE state = 'active' AND model_id = 'cursor-grok-4.6-high'`,
    )
    if (grok.rows[0]) assert.notEqual(grok.rows[0].context_window, 1000000)

    assert.deepEqual(await pricingSnapshot(), pricingBefore, 'pricing rows unchanged')
    assert.ok((await epoch()) > epochBefore, 'security epoch bumped so catalog caches refresh')

    // Replay is idempotent: all rows already at 1M are skipped, no new entries.
    const entriesAfterFirst = after.map((r) => r.entry_id)
    await query(sql)
    const replay = await activeFamilyRows()
    assert.deepEqual(replay.map((r) => r.entry_id), entriesAfterFirst)

    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as { requiredMigrations: string[] }
    assert.ok(metadata.requiredMigrations.includes('0258_cursor_opus_fable_context_1m'))
  })

})
