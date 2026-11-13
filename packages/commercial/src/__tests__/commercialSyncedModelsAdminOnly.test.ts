/**
 * Models that a selfhost → commercial sync brings are visible to admins only.
 *
 * 跑法:npx tsx --test packages/commercial/src/__tests__/commercialSyncedModelsAdminOnly.test.ts
 *
 * User rule (2026-10-15, OCV5-411): in the commercial catalog every model added by a
 * selfhost sync is model_pricing.visibility = 'admin' — ordinary users cannot see, pick
 * or be billed for it. Selfhost migrations may create public rows (0307 Flash did), so
 * the commercial tree edits them before release. This test pins that for every migration
 * from 0305 on: no statement that writes model_pricing may name the 'public' visibility.
 * Opening a model to users in commercial is an admin catalog action, not a synced migration.
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../db/migrations',
)
/** First migration number the rule applies to (0304 was the last one released before it). */
const RULE_FROM = '0305'

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '')
}

/** Statements that write model_pricing and name the 'public' visibility. */
function publicPricingWrites(sql: string): string[] {
  return stripSqlComments(sql)
    .split(';')
    .filter((stmt) => /\b(INSERT\s+INTO|UPDATE)\s+model_pricing\b/i.test(stmt))
    .filter((stmt) => /'public'/i.test(stmt))
    .map((stmt) => stmt.trim().slice(0, 120))
}

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql') && f.slice(0, 4) >= RULE_FROM)
  .sort()

describe('commercial: synced models are admin-only', () => {
  test('the scan covers the synced migrations (0306–0309 at least)', () => {
    for (const v of ['0306_pool_policy.sql', '0307_antigravity_engine.sql', '0308_pool_user_affinity.sql', '0309_box_profile_quota_windows.sql']) {
      assert.ok(files.includes(v), `${v} missing from the scan`)
    }
  })

  for (const f of files) {
    test(`${f}: no model_pricing write makes a model public`, () => {
      assert.deepEqual(publicPricingWrites(readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')), [])
    })
  }

  test('0307: all four Antigravity pricing rows are admin-only and disabled', () => {
    const sql = stripSqlComments(readFileSync(path.join(MIGRATIONS_DIR, '0307_antigravity_engine.sql'), 'utf8'))
    const insert = sql.split(';').find((s) => /INSERT\s+INTO\s+model_pricing/i.test(s))
    assert.ok(insert, 'pricing insert not found')
    assert.equal(insert.match(/'admin', NULL/g)?.length, 4)
    assert.equal(insert.match(/, FALSE,/g)?.length, 4)
  })

  test('oracle flags a public insert or update and ignores comments and other tables', () => {
    assert.equal(publicPricingWrites("INSERT INTO model_pricing(model_id, visibility) VALUES ('m', 'public');").length, 1)
    assert.equal(publicPricingWrites("UPDATE model_pricing SET visibility = 'public' WHERE model_id = 'm';").length, 1)
    assert.equal(publicPricingWrites("-- INSERT INTO model_pricing VALUES ('public');\nSELECT 1;").length, 0)
    assert.equal(publicPricingWrites("INSERT INTO model_catalog(model_id) VALUES ('public');").length, 0)
  })
})
