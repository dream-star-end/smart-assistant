/** Real SQL in this file's dedicated database only; never reset the shared test DB. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getPool } from '../db/index.js'
import { query } from '../db/queries.js'
import { KIMI31_MODEL_ID, KIMI31_VERSION, ensureKimi31Pricing }
  from '../admin/kimi31Catalog.js'
import { resetAndMigrateTestSchema, useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('kimi31_catalog_611_test')

test('Kimi 3.1 SQL preparation stays disabled, audited, repeatable and drift-refusing', async (t) => {
  if (db.skipIfUnavailable(t)) return
  await resetAndMigrateTestSchema()
  await query("INSERT INTO users(id,email,password_hash,role) VALUES(765,'g611@example.invalid','test-only','admin') ON CONFLICT (id) DO NOTHING")
  const before = await query("SELECT model_id,enabled,input_per_mtok::text,output_per_mtok::text FROM model_pricing WHERE model_id IN ('kimi-k3','k3-256k') ORDER BY model_id")
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await assert.rejects(() => ensureKimi31Pricing(client, 765n), /KIMI31_REQUIRES_EXACT_STAGE/)
    assert.equal((await client.query('SELECT 1 FROM model_pricing WHERE model_id=$1', [KIMI31_MODEL_ID])).rowCount, 0)
    const v = KIMI31_VERSION
    const staged = await client.query<{ id: string }>(
      'SELECT fn_model_stage_version($1,$2,$3,$4,$5,$6::jsonb,$7,$8::bigint)::text AS id',
      [v.model_id, v.engine, v.provider_id, v.upstream_model_id, v.context_window,
        JSON.stringify(v.capability_profile), v.capability_schema_version, '765'])
    assert.equal(await ensureKimi31Pricing(client, 765n), true)
    assert.equal(await ensureKimi31Pricing(client, 765n), false)
    const state = await client.query("SELECT c.state,p.enabled,p.default_effort,p.input_per_mtok::text,p.output_per_mtok::text,p.cache_read_per_mtok::text,p.cache_write_per_mtok::text FROM model_catalog c JOIN model_pricing p USING(model_id) WHERE c.model_id=$1", [KIMI31_MODEL_ID])
    assert.deepEqual(state.rows, [{ state: 'staged', enabled: false, default_effort: 'max',
      input_per_mtok: '609', output_per_mtok: '3046', cache_read_per_mtok: '61', cache_write_per_mtok: '0' }])
    const audit = await client.query("SELECT count(*)::int AS n FROM admin_audit WHERE action='pricing.create' AND target=$1", [`model:${KIMI31_MODEL_ID}`])
    assert.equal(audit.rows[0].n, 1)
    await client.query('SAVEPOINT price_drift')
    await client.query('UPDATE model_pricing SET input_per_mtok=915 WHERE model_id=$1', [KIMI31_MODEL_ID])
    await assert.rejects(() => ensureKimi31Pricing(client, 765n), /KIMI31_PRICE_CONFLICT/)
    await client.query('ROLLBACK TO SAVEPOINT price_drift')
    await client.query('SAVEPOINT active_entry')
    const lock = await client.query('SELECT lock_version FROM model_catalog WHERE entry_id=$1', [staged.rows[0]!.id])
    await client.query('SELECT fn_model_activate_entry($1::bigint,$2,$3::bigint)', [staged.rows[0]!.id, lock.rows[0].lock_version, '765'])
    await assert.rejects(() => ensureKimi31Pricing(client, 765n), /KIMI31_REQUIRES_EXACT_STAGE/)
    await client.query('ROLLBACK TO SAVEPOINT active_entry')
    const after = await client.query("SELECT model_id,enabled,input_per_mtok::text,output_per_mtok::text FROM model_pricing WHERE model_id IN ('kimi-k3','k3-256k') ORDER BY model_id")
    assert.deepEqual(after.rows, before.rows, 'old K3 prices and enabled flags unchanged')
    await client.query('ROLLBACK')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
})
