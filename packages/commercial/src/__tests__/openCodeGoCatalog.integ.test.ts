/**
 * OCV5-425 catalog operation against a real migrated schema: stage+activate the OpenCode Go
 * models with their reviewed prices, switch Gemini 4 to effort tiers, idempotent, reversible,
 * drift-refusing, and no other model touched.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  GO_CATALOG_MODELS,
  applyGoCatalog,
  goPricingFen,
  readGoCatalog,
} from '../admin/openCodeGoCatalog.js'
import { getPool } from '../db/index.js'
import { query } from '../db/queries.js'
import { resetAndMigrateBefore, useDedicatedTestDatabase } from './helpers/db.js'

const DB = 'opencode_go_425_test'
const db = useDedicatedTestDatabase(DB)
const gemini423Sql = readFileSync(
  new URL('../../../../scripts/ocv5-423/catalog.sql', import.meta.url),
  'utf8',
).replace("current_database() <> 'openclaude_v5_selfhost'", `current_database() <> '${DB}'`)

async function tx<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const out = await fn(client)
    await client.query('COMMIT')
    return out
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

const others = async () =>
  (
    await query(
      `SELECT jsonb_agg(to_jsonb(p) - 'updated_at' ORDER BY model_id) AS rows FROM model_pricing p
       WHERE model_id <> ALL($1)`,
      [['gemini-4-argon-contributor', ...GO_CATALOG_MODELS.map((m) => m.modelId)]],
    )
  ).rows[0]!.rows

test('OpenCode Go catalog op: reviewed rows, idempotent, reversible, drift-refusing', async (t) => {
  if (db.skipIfUnavailable(t)) return
  // The selfhost catalog op owns these ids there; commercial 0313 stages its own Go rows (OCV5-sync1020).
  await resetAndMigrateBefore('0313')
  await query(
    "INSERT INTO users(id,email,password_hash,role) VALUES(3,'g425-test@example.invalid','test-hash','admin') ON CONFLICT (id) DO NOTHING",
  )
  await tx(async (c) => {
    await c.query("SELECT set_config('openclaude.ocv5_423_enable','on',true)")
    await c.query(gemini423Sql)
  })
  const othersBefore = await others()

  await assert.rejects(() => tx((c) => applyGoCatalog(c, 'on')), /refuses any other database/)
  await tx((c) => applyGoCatalog(c, 'on', DB))
  const rows = await tx((c) => readGoCatalog(c))
  const byId = new Map(rows.map((r) => [r.model_id, r]))
  const gem = byId.get('gemini-4-argon-contributor')!
  assert.equal(gem.state, 'active')
  assert.deepEqual(gem.efforts, ['low', 'medium', 'high'])
  assert.equal(gem.default_effort, 'low')
  assert.equal(gem.visibility, 'admin')
  for (const m of GO_CATALOG_MODELS) {
    const r = byId.get(m.modelId)
    assert.ok(r, m.modelId)
    const fen = goPricingFen(m)
    assert.deepEqual(
      [
        r.upstream_model_id,
        r.context_window,
        r.state,
        r.enabled,
        r.visibility,
        Number(r.input_per_mtok),
        Number(r.output_per_mtok),
        Number(r.cache_read_per_mtok),
        Number(r.cache_write_per_mtok),
        r.thinking,
      ],
      [
        m.upstreamModelId,
        m.contextWindow,
        'active',
        true,
        'public',
        fen.input,
        fen.output,
        fen.cacheRead,
        fen.cacheWrite,
        m.supportsThinking,
      ],
      m.modelId,
    )
  }
  assert.deepEqual(byId.get('claude-haiku-5-5-go')!.efforts, [
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ])
  assert.deepEqual(byId.get('qwen3.8-max-go')!.efforts, ['low', 'high'])
  assert.deepEqual(byId.get('kimi-k3-go')!.efforts, [])
  assert.deepEqual(await others(), othersBefore, 'no other pricing row may change')

  // idempotent: a second --on changes nothing
  const snap = async () =>
    (
      await query(`SELECT jsonb_agg(jsonb_build_object('c',to_jsonb(c)-'updated_at','p',to_jsonb(p)-'updated_at') ORDER BY c.entry_id) AS s
      FROM model_catalog c JOIN model_pricing p USING(model_id) WHERE c.state IN ('active','disabled','staged')`)
    ).rows[0]!.s
  const once = await snap()
  await tx((c) => applyGoCatalog(c, 'on', DB))
  assert.deepEqual(await snap(), once)

  // --off hides the new models and returns Gemini to no tiers; --on restores
  await tx((c) => applyGoCatalog(c, 'off', DB))
  const off = new Map((await tx((c) => readGoCatalog(c))).map((r) => [r.model_id, r]))
  assert.deepEqual(off.get('gemini-4-argon-contributor')!.efforts, [])
  assert.equal(off.get('gemini-4-argon-contributor')!.default_effort, null)
  assert.equal(off.get('gemini-4-argon-contributor')!.state, 'active')
  for (const m of GO_CATALOG_MODELS) {
    assert.deepEqual(
      [off.get(m.modelId)!.state, off.get(m.modelId)!.enabled, off.get(m.modelId)!.visibility],
      ['disabled', false, 'hidden'],
      m.modelId,
    )
  }
  await tx((c) => applyGoCatalog(c, 'on', DB))
  const back = new Map((await tx((c) => readGoCatalog(c))).map((r) => [r.model_id, r]))
  assert.deepEqual(back.get('gemini-4-argon-contributor')!.efforts, ['low', 'medium', 'high'])
  for (const m of GO_CATALOG_MODELS) assert.equal(back.get(m.modelId)!.state, 'active', m.modelId)
  assert.deepEqual(await others(), othersBefore)

  // drift is refused, whole transaction rolled back
  await query(
    "UPDATE model_pricing SET input_per_mtok = input_per_mtok + 1 WHERE model_id='kimi-k3-go'",
  )
  await assert.rejects(
    () => tx((c) => applyGoCatalog(c, 'on', DB)),
    /kimi-k3-go: refuses drifted pricing/,
  )
})
