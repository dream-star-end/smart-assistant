import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { closePool, createPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query, tx } from '../db/queries.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'
let pgAvailable = false

async function probePg(): Promise<boolean> {
  const pool = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 })
  try {
    await pool.query('SELECT 1')
    return true
  } catch {
    return false
  } finally {
    await pool.end().catch(() => {})
  }
}

async function resetSchema(): Promise<void> {
  const db = await query<{ db: string }>('SELECT current_database() AS db')
  if (!/_test$/.test(db.rows[0]?.db ?? '')) throw new Error('refusing to reset non-test database')
  await query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
}

before(async () => {
  pgAvailable = await probePg()
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error('Postgres test fixture required')
    return
  }
  await resetPool()
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 5 }))
  await resetSchema()
  await runMigrations()
})

after(async () => {
  if (!pgAvailable) return
  await resetSchema().catch(() => {})
  await closePool()
})

describe('marketplace Plugin kernel migration', () => {
  test('enforces subtype/signature boundaries and transactional revision', async (t) => {
    if (!pgAvailable) return t.skip('pg not available')
    const user = await query<{ id: string }>(
      `INSERT INTO users(email, password_hash, email_verified)
       VALUES ('plugin-kernel@test.local', 'x', TRUE) RETURNING id::text`,
    )
    const userId = user.rows[0]!.id
    const revision = async () =>
      BigInt(
        (
          await query<{ revision: string }>(
            'SELECT revision::text FROM marketplace_catalog_revision WHERE singleton=TRUE',
          )
        ).rows[0]!.revision,
      )

    const startRevision = await revision()
    // Old binaries omit plugin_type; historical connector rows remain readable.
    await query(
      `INSERT INTO marketplace_skill_listings(slug, owner_user_id, kind)
       VALUES ('legacy-plugin', $1, 'connector')`,
      [userId],
    )
    const legacyListing = await query<{ plugin_type: string | null }>(
      "SELECT plugin_type FROM marketplace_skill_listings WHERE slug='legacy-plugin'",
    )
    assert.equal(legacyListing.rows[0]!.plugin_type, 'declarative-http')
    assert.ok((await revision()) > startRevision)

    const legacyVersion = await query<{ id: string }>(
      `INSERT INTO marketplace_skill_versions
         (slug, version, name, description, raw_artifact, artifact_hash,
          embedding_hash, submitted_by)
       VALUES ('legacy-plugin', '1.0.0', 'Legacy', 'Legacy', '{}', 'a', 'b', $1)
       RETURNING id::text`,
      [userId],
    )
    await query(
      `UPDATE marketplace_skill_versions
          SET signature=decode(repeat('ab', 32), 'hex'), key_id='v1'
        WHERE id=$1`,
      [legacyVersion.rows[0]!.id],
    )
    const legacyScheme = await query<{ signature_scheme: string | null }>(
      'SELECT signature_scheme FROM marketplace_skill_versions WHERE id=$1',
      [legacyVersion.rows[0]!.id],
    )
    assert.equal(legacyScheme.rows[0]!.signature_scheme, 'connector-v1')

    await query(
      `INSERT INTO marketplace_skill_listings(slug, owner_user_id, kind, plugin_type)
       VALUES ('browser-plugin', $1, 'connector', 'managed-browser')`,
      [userId],
    )
    const browserVersion = await query<{ id: string }>(
      `INSERT INTO marketplace_skill_versions
         (slug, version, name, description, raw_artifact, artifact_hash,
          embedding_hash, submitted_by)
       VALUES ('browser-plugin', '1.0.0', 'Browser', 'Browser', '{}', 'c', 'd', $1)
       RETURNING id::text`,
      [userId],
    )
    await assert.rejects(
      query(
        `UPDATE marketplace_skill_versions
            SET signature=decode(repeat('cd', 32), 'hex'), key_id='v1'
          WHERE id=$1`,
        [browserVersion.rows[0]!.id],
      ),
      /legacy connector signature is only valid/,
    )
    await assert.rejects(
      query(
        `UPDATE marketplace_skill_versions
            SET signature_scheme='plugin-v2',
                signature=decode(repeat('cd', 32), 'hex'), key_id='v1'
          WHERE id=$1`,
        [browserVersion.rows[0]!.id],
      ),
      /explicit transaction writer gate/,
    )
    await tx(async (client) => {
      await client.query(
        "SELECT set_config('openclaude.plugin_signature_writer', 'plugin-v2', true)",
      )
      await client.query(
        `UPDATE marketplace_skill_versions
            SET signature_scheme='plugin-v2',
                signature=decode(repeat('cd', 32), 'hex'), key_id='v1'
          WHERE id=$1`,
        [browserVersion.rows[0]!.id],
      )
    })
    await assert.rejects(
      query(
        `UPDATE marketplace_skill_versions
            SET signature=decode(repeat('ef', 32), 'hex')
          WHERE id=$1`,
        [browserVersion.rows[0]!.id],
      ),
      /explicit transaction writer gate/,
    )
    await assert.rejects(
      query(
        "UPDATE marketplace_skill_listings SET plugin_type='sandboxed-local' WHERE slug='browser-plugin'",
      ),
      /kind\/plugin_type is immutable/,
    )
    await assert.rejects(
      query(
        `INSERT INTO marketplace_skill_listings(slug, owner_user_id, kind, plugin_type)
         VALUES ('not-a-plugin', $1, 'skill', 'managed-browser')`,
        [userId],
      ),
      /marketplace_listing_plugin_type_shape/,
    )

    const beforeRollback = await revision()
    await assert.rejects(
      tx(async (client) => {
        await client.query(
          "UPDATE marketplace_skill_listings SET state='unlisted' WHERE slug='legacy-plugin'",
        )
        throw new Error('revision rollback probe')
      }),
      /revision rollback probe/,
    )
    assert.equal(await revision(), beforeRollback)
  })
})
