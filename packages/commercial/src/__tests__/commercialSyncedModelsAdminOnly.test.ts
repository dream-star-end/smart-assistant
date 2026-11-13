/** Selfhost keeps its applied visibility history; commercial admin-only policy is not imported.
 * Pin the pre-sync SQL blobs and the exact historical public-write set. New migrations still
 * cannot add public writes here without an explicit policy change. No applied SQL is rewritten.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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

describe('selfhost: synced models preserve edition visibility history', () => {
  test('the scan covers the synced migrations (0306–0309 at least)', () => {
    for (const v of ['0306_pool_policy.sql', '0307_antigravity_engine.sql', '0308_pool_user_affinity.sql', '0309_box_profile_quota_windows.sql']) {
      assert.ok(files.includes(v), `${v} missing from the scan`)
    }
  })

  const baseline = JSON.parse(readFileSync(new URL('./fixtures/selfhostSyncBaseline.json', import.meta.url), 'utf8')) as { migrations: Record<string, string> }
  const publicHistory = new Set(['0307_antigravity_engine.sql', '0312_antigravity_gemini_4_argon.sql', '0338_antigravity_gemini_4_carbon.sql'])
  for (const f of files) {
    test(`${f}: preserves applied SQL and only its original public write`, () => {
      const raw = readFileSync(path.join(MIGRATIONS_DIR, f))
      const pinned = baseline.migrations[f.slice(0, -4)]
      if (pinned) {
        const blob = createHash('sha1').update(`blob ${raw.length}\0`).update(raw).digest('hex')
        assert.equal(blob, pinned, 'applied migration bytes must not drift during synchronization')
      }
      assert.equal(publicPricingWrites(raw.toString('utf8')).length, publicHistory.has(f) ? 1 : 0)
    })
  }

  test('0307: original Flash visibility and all four disabled rows are preserved', () => {
    const sql = stripSqlComments(readFileSync(path.join(MIGRATIONS_DIR, '0307_antigravity_engine.sql'), 'utf8'))
    const insert = sql.split(';').find((s) => /INSERT\s+INTO\s+model_pricing/i.test(s))
    assert.ok(insert, 'pricing insert not found')
    assert.equal(insert.match(/'admin', NULL/g)?.length, 3)
    assert.equal(insert.match(/'public', NULL/g)?.length, 1)
    assert.equal(insert.match(/, FALSE,/g)?.length, 4)
  })

  test('oracle flags a public insert or update and ignores comments and other tables', () => {
    assert.equal(publicPricingWrites("INSERT INTO model_pricing(model_id, visibility) VALUES ('m', 'public');").length, 1)
    assert.equal(publicPricingWrites("UPDATE model_pricing SET visibility = 'public' WHERE model_id = 'm';").length, 1)
    assert.equal(publicPricingWrites("-- INSERT INTO model_pricing VALUES ('public');\nSELECT 1;").length, 0)
    assert.equal(publicPricingWrites("INSERT INTO model_catalog(model_id) VALUES ('public');").length, 0)
  })
})
