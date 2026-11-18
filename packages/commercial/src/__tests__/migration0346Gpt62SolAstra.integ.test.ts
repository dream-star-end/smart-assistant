/**
 * 0346 GPT-6.2 Astra / Sol (+1m) onboard and legacy GPT-6 Astra / GPT-6.1 Sol (+ remote) retirement.
 *
 * Run through the commercial test mutex, never invoke this file directly:
 * REQUIRE_TEST_DB=1 TEST_DATABASE_URL=postgres://test:test@127.0.0.1:55432/openclaude_test \
 *   bash scripts/test-mutex.sh commercial 'npx tsx --test packages/commercial/src/__tests__/migration0346Gpt62SolAstra.integ.test.ts'
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'
import { resetAndMigrateBefore, useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('models_0346_gpt62_sol_astra_test')
const here = path.dirname(fileURLToPath(import.meta.url))
const migrationPath = path.resolve(here, '../db/migrations/0346_selfhost_gpt62_sol_astra_retire_legacy.sql')
const metadataPath = path.resolve(here, '../../../../deploy/v5/release-metadata.json')

interface ModelRow {
  model_id: string
  engine: string
  provider_id: string
  upstream_model_id: string | null
  context_window: number | null
  capability_profile: {
    supports_vision?: boolean
    reasoning?: { supported?: string[]; codex_model_default?: string }
  }
  state: string
  placement: string
  pool_auto_disabled: boolean
  entry_id: string
  lock_version: number
  display_name: string
  input_per_mtok: string
  output_per_mtok: string
  cache_read_per_mtok: string
  cache_write_per_mtok: string
  multiplier: string
  enabled: boolean
  visibility: string
  sort_order: number
  default_effort: string | null
  extra_system_prompt: string | null
  min_plan_code: string | null
}

async function fetchModels(ids: string[]): Promise<Map<string, ModelRow>> {
  const res = await query<ModelRow>(
    `SELECT c.model_id, c.engine, c.provider_id, c.upstream_model_id, c.context_window,
            c.capability_profile, c.state, c.placement, c.pool_auto_disabled,
            c.entry_id::text AS entry_id, c.lock_version,
            p.display_name, p.input_per_mtok::text, p.output_per_mtok::text,
            p.cache_read_per_mtok::text, p.cache_write_per_mtok::text,
            p.multiplier::text, p.enabled, p.visibility, p.sort_order,
            p.default_effort, p.extra_system_prompt, p.min_plan_code
       FROM model_catalog c
       JOIN model_pricing p USING (model_id)
      WHERE c.model_id = ANY($1::text[])`,
    [ids],
  )
  return new Map(res.rows.map((r) => [r.model_id, r]))
}

async function createUser(email: string): Promise<string> {
  const res = await query<{ id: string }>(
    `INSERT INTO users(email, password_hash, role) VALUES ($1, 'x', 'user') RETURNING id::text AS id`,
    [email],
  )
  return res.rows[0]!.id
}

async function insertSession(id: string, userId: string, model: string, deletedAt: number | null = null): Promise<void> {
  await query(
    `INSERT INTO client_sessions(
       id, user_id, agent_id, title, pinned, created_at, last_at, messages, message_count,
       updated_at, deleted_at, next_seq, archived_through_seq, archived_count, model_id
     ) VALUES ($1, $2, 'main', 'test', 0, 1000, 1000, '[]', 0, 1000, $3, 1, 0, 0, $4)`,
    [id, userId, deletedAt, model],
  )
}

async function seedRemoteModel(profileId: string, canonical: string, upstream: string, active: boolean): Promise<void> {
  await query(
    `INSERT INTO remote_model_offers(profile_id, upstream_model_id, canonical_model_id, base_display_name, enabled)
     VALUES ($1, $2, $3, $4, TRUE)`,
    [profileId, upstream, canonical, canonical],
  )
  const cap = JSON.stringify({ supports_vision: true, reasoning: { supported: ['low', 'medium', 'high', 'xhigh', 'max'], codex_model_default: 'medium' } })
  const ins = await query<{ entry_id: string; lock_version: number }>(
    `INSERT INTO model_catalog(model_id, engine, provider_id, placement, upstream_model_id, context_window, capability_profile, capability_schema_version, state)
     VALUES ($1, 'codex', 'codex', 'remote_pool', $2, NULL, $3::jsonb, 1, 'staged')
     RETURNING entry_id::text AS entry_id, lock_version`,
    [canonical, upstream, cap],
  )
  await query(
    `INSERT INTO model_pricing(model_id, display_name, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok, multiplier, enabled, sort_order, visibility, default_effort, lock_version)
     VALUES ($1, $2, 100, 500, 5, 125, 1, FALSE, 110, 'hidden', 'medium', 0)`,
    [canonical, `${canonical} 远端`],
  )
  await query('SELECT fn_model_activate_entry($1::bigint, $2::int, NULL)', [ins.rows[0]!.entry_id, ins.rows[0]!.lock_version])
  if (active) {
    await query(`UPDATE model_pricing SET enabled = TRUE, visibility = 'public', lock_version = lock_version + 1 WHERE model_id = $1`, [canonical])
  } else {
    const cur = await query<{ entry_id: string; lock_version: number }>('SELECT entry_id::text AS entry_id, lock_version FROM model_catalog WHERE model_id = $1', [canonical])
    await query('SELECT fn_model_disable_entry($1::bigint, $2::int, NULL)', [cur.rows[0]!.entry_id, cur.rows[0]!.lock_version])
    await query('UPDATE model_catalog SET pool_auto_disabled = TRUE WHERE model_id = $1', [canonical])
  }
}

describe('0346_selfhost_gpt62_sol_astra_retire_legacy', () => {
  test('onboards 6.2 Astra/Sol (+1m) at exact parity, remaps pointers, retires legacy + remote, and replays cleanly', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0346')

    const before = await fetchModels(['gpt-6-astra', 'gpt-6-astra-1m', 'gpt-6.1-sol', 'gpt-6.1-sol-1m', 'gpt-6-luna', 'gpt-6-luna-1m'])
    const u1 = await createUser('u346-1@test.invalid')
    const u2 = await createUser('u346-2@test.invalid')
    const u3 = await createUser('u346-3@test.invalid')
    await query(`INSERT INTO user_preferences(user_id, prefs) VALUES ($1, '{"theme":"dark","default_model":"gpt-6-astra"}'), ($2, '{"default_model":"gpt-6.1-sol-remote"}'), ($3, '{"default_model":"gpt-6-luna"}')`, [u1, u2, u3])

    const container = await query<{ id: string }>('INSERT INTO agent_containers(user_id, secret_hash) VALUES ($1, $2) RETURNING id::text AS id', [u1, Buffer.alloc(32, 1)])
    const codexGroup = await query<{ id: string }>(`SELECT id::text AS id FROM account_groups WHERE provider = 'codex' ORDER BY id LIMIT 1`)
    const cred = await query<{ id: string }>(
      `INSERT INTO api_relay_credentials(group_id, label, base_url, model_provider, api_key_enc, api_key_nonce)
       VALUES ($1, 'relay346', 'https://relay.invalid/v1', 'openai', $2, $3) RETURNING id::text AS id`,
      [codexGroup.rows[0]!.id, Buffer.alloc(16, 2), Buffer.alloc(12, 3)],
    )
    const node = await query<{ id: string }>(
      `INSERT INTO remote_agent_nodes(label, ssh_host, ssh_user, host_key_fp, key_id, controller_sha256, status)
       VALUES ('node346', 'fixture.invalid', 'box', 'SHA256:f', 'k', 'c', 'active') RETURNING id`,
    )
    const prof = await query<{ id: string }>(
      `INSERT INTO remote_agent_profiles(node_id, engine, profile_name, account_fingerprint, runner_mode)
       VALUES ($1, 'codex', 'p346', 'fp346', 'app-server') RETURNING id`,
      [node.rows[0]!.id],
    )
    await seedRemoteModel(prof.rows[0]!.id, 'gpt-6-astra-remote', 'gpt-6-astra', true)
    await seedRemoteModel(prof.rows[0]!.id, 'gpt-6.1-sol-remote', 'gpt-6.1-sol', false)
    await seedRemoteModel(prof.rows[0]!.id, 'gpt-6-luna-remote', 'gpt-6-luna', true)

    await insertSession('s-astra', u1, 'gpt-6-astra')
    await insertSession('s-astra-1m', u1, 'gpt-6-astra-1m')
    await insertSession('s-sol', u1, 'gpt-6.1-sol')
    await insertSession('s-sol-1m', u1, 'gpt-6.1-sol-1m')
    await insertSession('s-astra-rem', u2, 'gpt-6-astra-remote')
    await insertSession('s-sol-rem', u2, 'gpt-6.1-sol-remote')
    await insertSession('s-luna', u3, 'gpt-6-luna')
    await insertSession('s-deleted', u1, 'gpt-6-astra', 2000)

    for (const [idx, modelId] of ['gpt-6-astra', 'gpt-6.1-sol-1m', 'gpt-6-astra-remote', 'gpt-6-luna'].entries()) {
      await query(
        `INSERT INTO codex_route_contexts(token_hash, container_id, user_id, model_id, group_id, credential_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW() + interval '1 hour')`,
        [String(idx + 1).repeat(64), container.rows[0]!.id, u1, modelId, codexGroup.rows[0]!.id, cred.rows[0]!.id],
      )
    }

    const epochBefore = BigInt((await query<{ epoch: string }>('SELECT epoch::text AS epoch FROM model_security_epoch')).rows[0]!.epoch)
    const applied = await runMigrations()
    assert.deepEqual(applied.applied, ['0346_selfhost_gpt62_sol_astra_retire_legacy'])

    const after = await fetchModels([
      'gpt-6.2-astra', 'gpt-6.2-astra-1m', 'gpt-6.2-sol', 'gpt-6.2-sol-1m',
      'gpt-6-astra', 'gpt-6-astra-1m', 'gpt-6.1-sol', 'gpt-6.1-sol-1m',
      'gpt-6-astra-remote', 'gpt-6.1-sol-remote', 'gpt-6-luna', 'gpt-6-luna-1m', 'gpt-6-luna-remote',
    ])

    const checks: Array<[string, Partial<ModelRow> & { inP: string; outP: string; crP: string; cwP: string; donor: string }]> = [
      ['gpt-6.2-astra', { upstream_model_id: null, context_window: null, display_name: 'GPT-6.2-Astra', inP: '598', outP: '3598', crP: '60', cwP: '0', default_effort: 'xhigh', donor: 'gpt-6-astra' }],
      ['gpt-6.2-astra-1m', { upstream_model_id: 'gpt-6.2-astra', context_window: 1_000_000, display_name: 'GPT-6.2-Astra', inP: '897', outP: '5397', crP: '90', cwP: '0', default_effort: 'xhigh', donor: 'gpt-6-astra' }],
      ['gpt-6.2-sol', { upstream_model_id: null, context_window: null, display_name: 'GPT-6.2-Sol', inP: '100', outP: '500', crP: '5', cwP: '125', default_effort: 'medium', donor: 'gpt-6.1-sol' }],
      ['gpt-6.2-sol-1m', { upstream_model_id: 'gpt-6.2-sol', context_window: 1_000_000, display_name: 'GPT-6.2-Sol', inP: '150', outP: '750', crP: '8', cwP: '188', default_effort: 'medium', donor: 'gpt-6.1-sol' }],
    ]
    for (const [id, exp] of checks) {
      const row = after.get(id)!
      const donor = before.get(exp.donor)!
      assert.equal(row.state, 'active', id)
      assert.equal(row.enabled, true, id)
      assert.equal(row.visibility, 'public', id)
      assert.equal(row.multiplier, '1.000', id)
      assert.equal(row.sort_order, 109, id)
      assert.equal(row.display_name, exp.display_name, id)
      assert.equal(row.upstream_model_id, exp.upstream_model_id, id)
      assert.equal(row.context_window, exp.context_window, id)
      assert.equal(row.input_per_mtok, exp.inP, id)
      assert.equal(row.output_per_mtok, exp.outP, id)
      assert.equal(row.cache_read_per_mtok, exp.crP, id)
      assert.equal(row.cache_write_per_mtok, exp.cwP, id)
      assert.equal(row.default_effort, exp.default_effort, id)
      assert.equal(row.extra_system_prompt, donor.extra_system_prompt, id)
      assert.equal(row.min_plan_code, donor.min_plan_code, id)
      assert.equal(row.capability_profile.supports_vision, true, id)
      assert.deepEqual(row.capability_profile.reasoning, { supported: ['low', 'medium', 'high', 'xhigh', 'max'], codex_model_default: exp.default_effort })
    }

    for (const retired of ['gpt-6-astra', 'gpt-6-astra-1m', 'gpt-6.1-sol', 'gpt-6.1-sol-1m', 'gpt-6-astra-remote', 'gpt-6.1-sol-remote']) {
      const row = after.get(retired)!
      assert.equal(row.state, 'disabled', retired)
      assert.equal(row.enabled, false, retired)
      assert.equal(row.visibility, 'hidden', retired)
      assert.equal(row.pool_auto_disabled, false, retired)
    }
    assert.equal(after.get('gpt-6-luna')!.state, 'active')
    assert.equal(after.get('gpt-6-luna')!.visibility, 'public')
    assert.equal(after.get('gpt-6-luna-1m')!.state, 'active')
    assert.equal(after.get('gpt-6-luna-remote')!.state, 'active')

    const offers = await query<{ canonical_model_id: string; enabled: boolean }>('SELECT canonical_model_id, enabled FROM remote_model_offers ORDER BY canonical_model_id')
    assert.deepEqual(offers.rows, [
      { canonical_model_id: 'gpt-6-astra-remote', enabled: false },
      { canonical_model_id: 'gpt-6-luna-remote', enabled: true },
      { canonical_model_id: 'gpt-6.1-sol-remote', enabled: false },
    ])

    const sessions = await query<{ id: string; model_id: string }>('SELECT id, model_id FROM client_sessions ORDER BY id')
    assert.deepEqual(sessions.rows, [
      { id: 's-astra', model_id: 'gpt-6.2-astra' },
      { id: 's-astra-1m', model_id: 'gpt-6.2-astra-1m' },
      { id: 's-astra-rem', model_id: 'gpt-6.2-astra' },
      { id: 's-deleted', model_id: 'gpt-6-astra' },
      { id: 's-luna', model_id: 'gpt-6-luna' },
      { id: 's-sol', model_id: 'gpt-6.2-sol' },
      { id: 's-sol-1m', model_id: 'gpt-6.2-sol-1m' },
      { id: 's-sol-rem', model_id: 'gpt-6.2-sol' },
    ])

    const routes = await query<{ token_hash: string; model_id: string }>('SELECT token_hash, model_id FROM codex_route_contexts ORDER BY token_hash')
    assert.deepEqual(routes.rows.map((r) => r.model_id), ['gpt-6.2-astra', 'gpt-6.2-sol-1m', 'gpt-6.2-astra', 'gpt-6-luna'])

    const prefs = await query<{ default_model: string }>(`SELECT prefs->>'default_model' AS default_model FROM user_preferences ORDER BY user_id`)
    assert.deepEqual(prefs.rows.map((r) => r.default_model), ['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6-luna'])

    const groups = await query<{ model_id: string; count: string }>(
      `SELECT model_id, count(*)::text AS count FROM account_group_models
        WHERE model_id LIKE 'gpt-6%' GROUP BY model_id ORDER BY model_id`,
    )
    const groupCounts = new Map(groups.rows.map((r) => [r.model_id, Number(r.count)]))
    assert.ok((groupCounts.get('gpt-6.2-astra') ?? 0) >= 1)
    assert.equal(groupCounts.get('gpt-6.2-sol'), groupCounts.get('gpt-6.2-astra'))
    for (const absent of ['gpt-6.2-astra-1m', 'gpt-6.2-sol-1m', 'gpt-6-astra', 'gpt-6-astra-1m', 'gpt-6.1-sol', 'gpt-6.1-sol-1m']) {
      assert.equal(groupCounts.get(absent) ?? 0, 0, absent)
    }

    const reqs = await query<{ model_id: string }>(`SELECT model_id FROM model_runtime_requirements WHERE requirement = 'default_codex_engine'`)
    assert.deepEqual(reqs.rows, [{ model_id: 'gpt-6.2-astra' }])

    const astra62 = after.get('gpt-6.2-astra')!
    await assert.rejects(async () => query('SELECT fn_model_disable_entry($1::bigint, $2::int, NULL)', [astra62.entry_id, astra62.lock_version]))

    const epochAfter = BigInt((await query<{ epoch: string }>('SELECT epoch::text AS epoch FROM model_security_epoch')).rows[0]!.epoch)
    assert.ok(epochAfter > epochBefore)

    // Replay idempotency
    await query(await readFile(migrationPath, 'utf8'))
    const replayAfter = await fetchModels(['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6-astra'])
    assert.equal(replayAfter.get('gpt-6.2-astra')!.state, 'active')
    assert.equal(replayAfter.get('gpt-6.2-sol')!.state, 'active')
    assert.equal(replayAfter.get('gpt-6-astra')!.state, 'disabled')
  })

  test('is registered in release metadata after 0345_user_sites', async () => {
    const meta = JSON.parse(await readFile(metadataPath, 'utf8')) as { requiredMigrations: string[] }
    const idx = meta.requiredMigrations.indexOf('0346_selfhost_gpt62_sol_astra_retire_legacy')
    assert.ok(idx > 0)
    assert.equal(meta.requiredMigrations[idx - 1], '0345_user_sites')
  })
})
