import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, test } from 'node:test'

import { closePool, createPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query, tx } from '../db/queries.js'
import { resetTestSchemaForTest } from './helpers/db.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'
const MIGRATIONS = fileURLToPath(new URL('../db/migrations/', import.meta.url))

let pgAvailable = false
let partialDir = ''

async function resetSchema(): Promise<void> {
  await resetTestSchemaForTest()
}

before(async () => {
  const probe = createPool({ connectionString: TEST_DB_URL, max: 1, connectionTimeoutMillis: 1500 })
  try {
    await probe.query('SELECT 1')
    pgAvailable = true
  } catch {
    if (REQUIRE_TEST_DB) throw new Error('Postgres test fixture required')
  } finally {
    await probe.end().catch(() => {})
  }
  if (!pgAvailable) return
  await resetPool()
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 4 }))
  await resetSchema()
  partialDir = await mkdtemp(join(tmpdir(), 'oc-migrations-through-0151-'))
  for (const file of (await readdir(MIGRATIONS)).filter((name) => name.endsWith('.sql'))) {
    // 构造 0152 之前的真实旧 schema；不能只跳过 0152 后继续套用 0153+，否则
    // 后续 plugin signature trigger 会先于待测迁移生效，fixture 不再代表升级起点。
    if (file >= '0152_') continue
    await symlink(join(MIGRATIONS, file), join(partialDir, file))
  }
  await runMigrations({ dir: partialDir })

  const owner = await query<{ id: string }>(
    `INSERT INTO users(email, password_hash, credits, role)
     VALUES ('legacy-capability-owner@x.com', 'x', 0, 'user') RETURNING id::text`,
  )
  const userId = owner.rows[0]!.id
  await query(
    `INSERT INTO marketplace_skill_listings(slug, owner_user_id, kind)
     VALUES ('legacy-skill', $1, 'skill'),
            ('legacy-agent', $1, 'agent'),
            ('legacy-plugin', $1, 'connector'),
            ('legacy-plugin-agent', $1, 'agent')`,
    [userId],
  )
  const skill = await query<{ id: string }>(
    `INSERT INTO marketplace_skill_versions
       (slug, version, name, description, tags, raw_skill_md, raw_artifact,
        artifact_hash, embedding_hash, status, risk_flags, policy_version, submitted_by)
     VALUES ('legacy-skill','1.0.0','Legacy Skill','legacy','[]','# skill','# skill',
             'skill-hash','skill-embed','approved','[]',1,$1)
     RETURNING id::text`,
    [userId],
  )
  const agent = await query<{ id: string }>(
    `INSERT INTO marketplace_skill_versions
       (slug, version, name, description, tags, raw_skill_md, raw_artifact, manifest,
        artifact_hash, embedding_hash, status, risk_flags, policy_version, submitted_by)
     VALUES ('legacy-agent','1.0.0','Legacy Agent','legacy','[]',NULL,'{}',
             '{"skillDeps":["legacy-skill"]}',
             'agent-hash','agent-embed','approved','[]',1,$1)
     RETURNING id::text`,
    [userId],
  )
  const plugin = await query<{ id: string }>(
    `INSERT INTO marketplace_skill_versions
       (slug, version, name, description, tags, raw_skill_md, raw_artifact,
        artifact_hash, embedding_hash, status, risk_flags, policy_version, submitted_by)
     VALUES ('legacy-plugin','1.0.0','Legacy Plugin','legacy','[]',NULL,'{}',
             'plugin-hash','plugin-embed','approved','[]',1,$1)
     RETURNING id::text`,
    [userId],
  )
  const pluginAgent = await query<{ id: string }>(
    `INSERT INTO marketplace_skill_versions
       (slug, version, name, description, tags, raw_skill_md, raw_artifact, manifest,
        artifact_hash, embedding_hash, status, risk_flags, policy_version, submitted_by)
     VALUES ('legacy-plugin-agent','1.0.0','Legacy Plugin Agent','legacy','[]',NULL,
             '{"capabilities":[{"kind":"plugin","slug":"legacy-plugin","optional":false}],"skillDeps":[]}',
             '{"capabilities":[{"kind":"plugin","slug":"legacy-plugin","optional":false}],"skillDeps":[]}',
             'plugin-agent-hash','plugin-agent-embed','approved','[]',1,$1)
     RETURNING id::text`,
    [userId],
  )
  await query(
    `UPDATE marketplace_skill_listings
        SET current_approved_version_id = CASE slug
          WHEN 'legacy-skill' THEN $1::bigint
          WHEN 'legacy-agent' THEN $2::bigint
          WHEN 'legacy-plugin' THEN $3::bigint
          ELSE $4::bigint END`,
    [skill.rows[0]!.id, agent.rows[0]!.id, plugin.rows[0]!.id, pluginAgent.rows[0]!.id],
  )
  await query(
    `INSERT INTO marketplace_installs
     (user_id, slug, version_id, artifact_hash, installed_by, agent_ids)
     VALUES ($1,'legacy-skill',$2,'skill-hash',$1,'["legacy-agent","main"]'),
            ($1,'legacy-agent',$3,'agent-hash',$1,'["main"]'),
            ($1,'legacy-plugin-agent',$4,'plugin-agent-hash',$1,'["main"]')`,
    [userId, skill.rows[0]!.id, agent.rows[0]!.id, pluginAgent.rows[0]!.id],
  )

  await symlink(
    join(MIGRATIONS, '0152_marketplace_capability_bindings.sql'),
    join(partialDir, '0152_marketplace_capability_bindings.sql'),
  )
  const migrated = await runMigrations({ dir: partialDir })
  assert.deepEqual(migrated.applied, ['0152_marketplace_capability_bindings'])
})

after(async () => {
  if (pgAvailable) {
    try {
      await resetSchema()
      await runMigrations()
    } finally {
      await closePool()
    }
  }
  if (partialDir) await rm(partialDir, { recursive: true, force: true })
})

describe('migration 0152 capability backfill', () => {
  test('backfills the graph and keeps legacy publish/install writes rollback-safe', async (t) => {
    if (!pgAvailable) return t.skip('pg not available')
    const requirement = await query<{
      capability_slug: string
      capability_kind: string
      required: boolean
    }>(
      `SELECT capability_slug, capability_kind, required
         FROM marketplace_capability_requirements
        WHERE capability_slug = 'legacy-skill'`,
    )
    assert.deepEqual(requirement.rows, [
      { capability_slug: 'legacy-skill', capability_kind: 'skill', required: true },
    ])
    const bindings = await query<{
      agent_slug: string
      source: string
      source_agent_version_id: string | null
    }>(
      `SELECT agent_slug, source, source_agent_version_id::text
         FROM marketplace_agent_capability_bindings
        WHERE capability_slug = 'legacy-skill'
        ORDER BY source`,
    )
    assert.equal(bindings.rows.length, 2)
    assert.deepEqual(bindings.rows.map((row) => row.source), ['agent_dependency', 'manual'])
    const dependency = bindings.rows.find((row) => row.source === 'agent_dependency')
    const manual = bindings.rows.find((row) => row.source === 'manual')
    assert.equal(dependency?.agent_slug, 'legacy-agent')
    assert.ok(dependency?.source_agent_version_id)
    assert.equal(manual?.agent_slug, 'main')
    assert.equal(manual?.source_agent_version_id, null)

    const gatedPluginAgent = await query<{ artifact_hash: string }>(
      `SELECT artifact_hash FROM marketplace_installs
        WHERE slug = 'legacy-plugin-agent' AND uninstalled_at IS NULL`,
    )
    assert.equal(
      gatedPluginAgent.rows[0]!.artifact_hash,
      'required-plugin-rollback-gate:plugin-agent-hash',
    )
    const legacyVisible = await query(
      `SELECT 1 FROM marketplace_installs i
        JOIN marketplace_skill_versions v ON v.id = i.version_id
       WHERE i.slug = 'legacy-plugin-agent' AND i.uninstalled_at IS NULL
         AND i.artifact_hash = v.artifact_hash`,
    )
    assert.equal(
      legacyVisible.rowCount,
      0,
      'old runtime reader must hide an Agent whose required Plugin has no legacy vocabulary',
    )

    // A pre-migration client only sends the compatibility union. If the same
    // Agent is both explicitly assigned and dependency-owned, the trigger must
    // retain the already-manual provenance instead of stripping it as automatic.
    await query(
      `INSERT INTO marketplace_agent_capability_bindings
        (user_id, agent_slug, capability_slug, capability_kind, source, source_agent_version_id)
       SELECT user_id, 'legacy-agent', slug, 'skill', 'manual', NULL
         FROM marketplace_installs
        WHERE slug = 'legacy-skill' AND uninstalled_at IS NULL`,
    )
    await query(
      `UPDATE marketplace_installs SET agent_ids = '["legacy-agent","main"]'::jsonb
        WHERE slug = 'legacy-skill' AND uninstalled_at IS NULL`,
    )
    const dualSource = await query<{ source: string }>(
      `SELECT source FROM marketplace_agent_capability_bindings
        WHERE capability_slug = 'legacy-skill' AND agent_slug = 'legacy-agent'
        ORDER BY source`,
    )
    assert.deepEqual(dualSource.rows.map((row) => row.source), [
      'agent_dependency',
      'manual',
    ])
    const ids = await query<{ user_id: string; agent_version_id: string }>(
      `SELECT i.user_id::text, i.version_id::text AS agent_version_id
         FROM marketplace_installs i
        WHERE i.slug = 'legacy-agent' AND i.uninstalled_at IS NULL`,
    )

    const replacementSkill = await query<{ id: string }>(
      `INSERT INTO marketplace_skill_versions
         (slug, version, name, description, tags, raw_skill_md, raw_artifact,
          artifact_hash, embedding_hash, status, risk_flags, policy_version, submitted_by)
       VALUES ('legacy-skill','2.0.0','Legacy Skill v2','legacy','[]','# skill v2','# skill v2',
               'skill-hash-v2','skill-embed-v2','approved','[]',1,$1)
       RETURNING id::text`,
      [ids.rows[0]!.user_id],
    )
    // The previous installer re-pins a Skill by soft-deleting its active row and
    // inserting the replacement with the same compatibility union. Manual
    // provenance for an Agent that also owns the Skill as a dependency must
    // survive that sequence.
    await tx(async (client) => {
      await query(
        `UPDATE marketplace_installs SET uninstalled_at = NOW()
          WHERE user_id = $1 AND slug = 'legacy-skill' AND uninstalled_at IS NULL`,
        [ids.rows[0]!.user_id],
        client,
      )
      await query(
        `INSERT INTO marketplace_installs
           (user_id, slug, version_id, artifact_hash, installed_by, agent_ids)
         VALUES ($1,'legacy-skill',$2,'skill-hash-v2',$1,'["legacy-agent","main"]')`,
        [ids.rows[0]!.user_id, replacementSkill.rows[0]!.id],
        client,
      )
    })
    const dualSourceAfterRepin = await query<{ source: string }>(
      `SELECT source FROM marketplace_agent_capability_bindings
        WHERE capability_slug = 'legacy-skill' AND agent_slug = 'legacy-agent'
        ORDER BY source`,
    )
    assert.deepEqual(
      dualSourceAfterRepin.rows.map((row) => row.source),
      ['agent_dependency', 'manual'],
      'legacy Skill re-pin must preserve manual+dependency dual provenance',
    )
    await query(
      `DELETE FROM marketplace_agent_capability_bindings
        WHERE capability_slug = 'legacy-skill' AND agent_slug = 'legacy-agent'
          AND source = 'manual'`,
    )

    const cache = await query<{ agent_ids: unknown }>(
      `SELECT agent_ids FROM marketplace_installs
        WHERE slug = 'legacy-skill' AND uninstalled_at IS NULL`,
    )
    assert.deepEqual(cache.rows[0]!.agent_ids, ['legacy-agent', 'main'])
    await assert.rejects(
      query(
        `UPDATE marketplace_installs SET agent_ids = '[]'::jsonb
          WHERE slug = 'legacy-skill' AND uninstalled_at IS NULL`,
      ),
      (error: unknown) => (error as { code?: string }).code === '23514',
    )

    await assert.rejects(
      query(
        `INSERT INTO marketplace_agent_capability_bindings
          (user_id, agent_slug, capability_slug, capability_kind, source, source_agent_version_id)
         VALUES ($1,'main','legacy-skill','skill','manual',$2)`,
        [ids.rows[0]!.user_id, ids.rows[0]!.agent_version_id],
      ),
      (error: unknown) => (error as { code?: string }).code === '23514',
    )
    await assert.rejects(
      query(
        `INSERT INTO marketplace_agent_capability_bindings
          (user_id, agent_slug, capability_slug, capability_kind, source, source_agent_version_id)
         VALUES ($1,'main','legacy-skill','connector','manual',NULL)`,
        [ids.rows[0]!.user_id],
      ),
      (error: unknown) => (error as { code?: string }).code === '23503',
    )

    // Simulate the previous source after the migration has committed: it only
    // publishes manifest.skillDeps and writes marketplace_installs.agent_ids.
    const nextAgent = await query<{ id: string }>(
      `INSERT INTO marketplace_skill_versions
         (slug, version, name, description, tags, raw_skill_md, raw_artifact, manifest,
          artifact_hash, embedding_hash, status, risk_flags, policy_version, submitted_by)
       VALUES ('legacy-agent','2.0.0','Legacy Agent v2','legacy','[]',NULL,'{}',
               '{"skillDeps":["legacy-skill"]}',
               'agent-hash-v2','agent-embed-v2','approved','[]',1,$1)
       RETURNING id::text`,
      [ids.rows[0]!.user_id],
    )
    const nextRequirements = await query<{ capability_slug: string }>(
      `SELECT capability_slug FROM marketplace_capability_requirements
        WHERE agent_version_id = $1`,
      [nextAgent.rows[0]!.id],
    )
    assert.deepEqual(nextRequirements.rows, [{ capability_slug: 'legacy-skill' }])

    // The old updater soft-deletes + reinserts inside one transaction. Deferred
    // reconciliation must not garbage-collect dependencies between those writes.
    await tx(async (client) => {
      await query(
        `UPDATE marketplace_installs SET uninstalled_at = NOW()
          WHERE user_id = $1 AND slug = 'legacy-agent' AND uninstalled_at IS NULL`,
        [ids.rows[0]!.user_id],
        client,
      )
      await query(
        `INSERT INTO marketplace_installs
           (user_id, slug, version_id, artifact_hash, installed_by, agent_ids)
         VALUES ($1,'legacy-agent',$2,'agent-hash-v2',$1,'["main"]')`,
        [ids.rows[0]!.user_id, nextAgent.rows[0]!.id],
        client,
      )
    })
    const upgradedBinding = await query<{ source_agent_version_id: string }>(
      `SELECT source_agent_version_id::text FROM marketplace_agent_capability_bindings
        WHERE user_id = $1 AND agent_slug = 'legacy-agent'
          AND capability_slug = 'legacy-skill' AND source = 'agent_dependency'`,
      [ids.rows[0]!.user_id],
    )
    assert.equal(upgradedBinding.rows[0]!.source_agent_version_id, nextAgent.rows[0]!.id)

    // A legacy scope edit is projected back into manual provenance. Removing the
    // last manual scope and then uninstalling the Agent soft-deletes the orphaned
    // dependency instead of persisting [] for an old reader to reactivate.
    await query(
      `UPDATE marketplace_installs SET agent_ids = '["legacy-agent"]'::jsonb
        WHERE user_id = $1 AND slug = 'legacy-skill' AND uninstalled_at IS NULL`,
      [ids.rows[0]!.user_id],
    )
    const manualAfterEdit = await query(
      `SELECT 1 FROM marketplace_agent_capability_bindings
        WHERE user_id = $1 AND capability_slug = 'legacy-skill' AND source = 'manual'`,
      [ids.rows[0]!.user_id],
    )
    assert.equal(manualAfterEdit.rowCount, 0)
    await query(
      `UPDATE marketplace_installs SET uninstalled_at = NOW()
        WHERE user_id = $1 AND slug = 'legacy-agent' AND uninstalled_at IS NULL`,
      [ids.rows[0]!.user_id],
    )
    const activeDependency = await query(
      `SELECT 1 FROM marketplace_installs
        WHERE user_id = $1 AND slug = 'legacy-skill' AND uninstalled_at IS NULL`,
      [ids.rows[0]!.user_id],
    )
    assert.equal(activeDependency.rowCount, 0)

    // Leaving manual rows alive until commit must not turn a real uninstall into
    // a ghost binding. A deferred reconcile removes them when no replacement row
    // exists in the transaction.
    const plugin = await query<{ id: string }>(
      `SELECT current_approved_version_id::text AS id
         FROM marketplace_skill_listings WHERE slug = 'legacy-plugin'`,
    )
    await query(
      `INSERT INTO marketplace_installs
         (user_id, slug, version_id, artifact_hash, installed_by, agent_ids)
       VALUES ($1,'legacy-plugin',$2,'plugin-hash',$1,'["main"]')`,
      [ids.rows[0]!.user_id, plugin.rows[0]!.id],
    )
    const manualPluginBefore = await query(
      `SELECT 1 FROM marketplace_agent_capability_bindings
        WHERE user_id = $1 AND capability_slug = 'legacy-plugin' AND source = 'manual'`,
      [ids.rows[0]!.user_id],
    )
    assert.equal(manualPluginBefore.rowCount, 1)
    await query(
      `UPDATE marketplace_installs SET uninstalled_at = NOW()
        WHERE user_id = $1 AND slug = 'legacy-plugin' AND uninstalled_at IS NULL`,
      [ids.rows[0]!.user_id],
    )
    const manualPluginAfter = await query(
      `SELECT 1 FROM marketplace_agent_capability_bindings
        WHERE user_id = $1 AND capability_slug = 'legacy-plugin' AND source = 'manual'`,
      [ids.rows[0]!.user_id],
    )
    assert.equal(manualPluginAfter.rowCount, 0, 'true uninstall must clean deferred manual provenance')

    // A rolled-back installer writes the canonical Agent hash and knows only
    // skillDeps. The compatibility trigger must rewrite that fresh row to the
    // same fail-closed marker rather than letting old runtime execute it.
    const pluginAgentInstall = await query<{ user_id: string; version_id: string }>(
      `SELECT user_id::text, version_id::text FROM marketplace_installs
        WHERE slug = 'legacy-plugin-agent' AND uninstalled_at IS NULL`,
    )
    await tx(async (client) => {
      await query(
        `UPDATE marketplace_installs SET uninstalled_at = NOW()
          WHERE user_id = $1 AND slug = 'legacy-plugin-agent' AND uninstalled_at IS NULL`,
        [pluginAgentInstall.rows[0]!.user_id],
        client,
      )
      await query(
        `INSERT INTO marketplace_installs
           (user_id, slug, version_id, artifact_hash, installed_by, agent_ids)
         VALUES ($1,'legacy-plugin-agent',$2,'plugin-agent-hash',$1,'["main"]')`,
        [pluginAgentInstall.rows[0]!.user_id, pluginAgentInstall.rows[0]!.version_id],
        client,
      )
    })
    const regated = await query<{ artifact_hash: string }>(
      `SELECT artifact_hash FROM marketplace_installs
        WHERE slug = 'legacy-plugin-agent' AND uninstalled_at IS NULL`,
    )
    assert.equal(regated.rows[0]!.artifact_hash, 'required-plugin-rollback-gate:plugin-agent-hash')
  })
})
