import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import { listDeclarativeConnections } from '../connectors/engine/binding.js'
import { listConnections } from '../connectors/store.js'
import { closePool, createPool, getPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query, tx } from '../db/queries.js'
import {
  commitPluginAccountState,
  createManagedBrowserPluginAccount,
  decryptPluginAccountEnvelope,
  fencePluginAccountInvocation,
  getPluginAccount,
} from '../plugins/accounts.js'
import { compileRuntimePluginArtifact } from '../plugins/contracts.js'
import {
  approveRuntimePluginVersion,
  loadVerifiedRuntimePluginContract,
} from '../plugins/review.js'
import { PluginRuntimeFacade } from '../plugins/runtime.js'

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
        `SELECT set_config(
           'openclaude.plugin_signature_writer',
           'plugin-v2:' || pg_current_xact_id()::text,
           true
         )`,
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

    // Even a mistakenly session-scoped marker is valid for at most its bound
    // transaction; it cannot authorize the next checkout/transaction.
    const pooledClient = await getPool().connect()
    try {
      await pooledClient.query('BEGIN')
      await pooledClient.query(
        `SELECT set_config(
           'openclaude.plugin_signature_writer',
           'plugin-v2:' || pg_current_xact_id()::text,
           false
         )`,
      )
      await pooledClient.query(
        `UPDATE marketplace_skill_versions
            SET signature=decode(repeat('12', 32), 'hex')
          WHERE id=$1`,
        [browserVersion.rows[0]!.id],
      )
      await pooledClient.query('COMMIT')
      await pooledClient.query('BEGIN')
      await assert.rejects(
        pooledClient.query(
          `UPDATE marketplace_skill_versions
              SET signature=decode(repeat('34', 32), 'hex')
            WHERE id=$1`,
          [browserVersion.rows[0]!.id],
        ),
        /explicit transaction writer gate/,
      )
      await pooledClient.query('ROLLBACK')
    } finally {
      pooledClient.release()
    }
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

  test('approves and reloads a real plugin-v2 runtime contract atomically', async (t) => {
    if (!pgAvailable) return t.skip('pg not available')
    const author = await query<{ id: string }>(
      `INSERT INTO users(email, password_hash, email_verified)
       VALUES ('plugin-runtime-author@test.local', 'x', TRUE) RETURNING id::text`,
    )
    const admin = await query<{ id: string }>(
      `INSERT INTO users(email, password_hash, email_verified, role)
       VALUES ('plugin-runtime-admin@test.local', 'x', TRUE, 'admin') RETURNING id::text`,
    )
    const raw = {
      schemaVersion: 1,
      pluginType: 'managed-browser',
      id: 'approved-browser-plugin',
      version: '1.0.0',
      driver: { id: 'approved-browser-plugin', version: '1.0.0' },
      account: { mode: 'required', contractVersion: 1 },
      network: { origins: ['https://example.com'], methods: ['GET'] },
      actions: [
        {
          id: 'read',
          description: 'Read one page',
          effect: 'read',
          timeoutSeconds: 10,
          params: { type: 'object', properties: {}, additionalProperties: false },
          result: { type: 'object', properties: {}, additionalProperties: false },
        },
      ],
    }
    const compiled = compileRuntimePluginArtifact(raw)
    await query(
      `INSERT INTO marketplace_skill_listings(slug, owner_user_id, kind, plugin_type, state)
       VALUES ($1, $2, 'connector', 'managed-browser', 'unlisted')`,
      [raw.id, author.rows[0]!.id],
    )
    const version = await query<{ id: string }>(
      `INSERT INTO marketplace_skill_versions
         (slug, version, name, description, raw_artifact, artifact_hash,
          embedding_hash, submitted_by)
       VALUES ($1, $2, 'Approved Browser Plugin', 'integration probe', $3, $4, $5, $6)
       RETURNING id::text`,
      [
        raw.id,
        raw.version,
        JSON.stringify(raw),
        compiled.artifactHash,
        compiled.artifactHash,
        author.rows[0]!.id,
      ],
    )
    const env = {
      ...process.env,
      OPENCLAUDE_KMS_KEY: randomBytes(32).toString('base64'),
    }
    await query('UPDATE marketplace_skill_versions SET exec_revoked_at = NOW() WHERE id = $1', [
      version.rows[0]!.id,
    ])
    await assert.rejects(
      approveRuntimePluginVersion({
        versionId: version.rows[0]!.id,
        reviewerUserId: Number(admin.rows[0]!.id),
        expectedArtifactHash: compiled.artifactHash,
        functionalVerified: true,
        env,
        pool: getPool(),
      }),
      /Plugin version is revoked/,
    )
    await query('UPDATE marketplace_skill_versions SET exec_revoked_at = NULL WHERE id = $1', [
      version.rows[0]!.id,
    ])
    await approveRuntimePluginVersion({
      versionId: version.rows[0]!.id,
      reviewerUserId: Number(admin.rows[0]!.id),
      expectedArtifactHash: compiled.artifactHash,
      functionalVerified: true,
      env,
      pool: getPool(),
    })

    const trusted = await loadVerifiedRuntimePluginContract(
      Number(version.rows[0]!.id),
      getPool(),
      { env },
    )
    assert.equal(trusted.pluginType, 'managed-browser')
    if (trusted.pluginType !== 'managed-browser') throw new Error('unexpected Plugin subtype')
    assert.equal(trusted.execContractHash, compiled.execContractHash)
    const stored = await query<{
      state: string
      current_id: string
      signature_scheme: string
      functional_verify_state: string
    }>(
      `SELECT l.state, l.current_approved_version_id::text AS current_id,
              v.signature_scheme, v.functional_verify_state
         FROM marketplace_skill_listings l
         JOIN marketplace_skill_versions v ON v.id = l.current_approved_version_id
        WHERE l.slug = $1`,
      [raw.id],
    )
    assert.deepEqual(stored.rows[0], {
      state: 'active',
      current_id: version.rows[0]!.id,
      signature_scheme: 'plugin-v2',
      functional_verify_state: 'verified',
    })

    await query(
      `INSERT INTO marketplace_installs
         (user_id, slug, version_id, artifact_hash, installed_by)
       VALUES ($1, $2, $3, $4, $1)`,
      [author.rows[0]!.id, raw.id, version.rows[0]!.id, compiled.artifactHash],
    )
    const account = await createManagedBrowserPluginAccount({
      userId: Number(author.rows[0]!.id),
      versionId: Number(version.rows[0]!.id),
      displayName: 'Integration account',
      storageState: { cookies: [], origins: [] },
      env,
      pool: getPool(),
    })
    const accountRow = await getPluginAccount(account.id, Number(author.rows[0]!.id), getPool())
    assert.ok(accountRow)
    const facade = new PluginRuntimeFacade({ pool: getPool(), redis: null, env })
    assert.equal(
      await facade.classifyTarget(Number(author.rows[0]!.id), account.id),
      'managed-browser',
    )
    assert.equal(
      (await listDeclarativeConnections(Number(author.rows[0]!.id), getPool())).some(
        (connection) => connection.id === account.id,
      ),
      false,
    )
    assert.equal(
      (await listConnections(Number(author.rows[0]!.id), getPool())).some(
        (connection) => connection.id === account.id,
      ),
      false,
    )
    const fenced = await fencePluginAccountInvocation({
      connectionId: account.id,
      userId: Number(author.rows[0]!.id),
      expectedRevision: accountRow.revision,
      verified: trusted,
      runner: getPool(),
    })
    const envelope = decryptPluginAccountEnvelope(fenced, trusted.contract, env)
    assert.equal(envelope.accountInstanceId, account.accountInstanceId)
    await query(
      `UPDATE marketplace_installs SET uninstalled_at = NOW()
        WHERE user_id = $1 AND slug = $2 AND uninstalled_at IS NULL`,
      [author.rows[0]!.id, raw.id],
    )
    assert.equal(await facade.classifyTarget(Number(author.rows[0]!.id), account.id), null)
    await assert.rejects(
      commitPluginAccountState({
        row: fenced,
        verified: trusted,
        envelope,
        runner: getPool(),
        env,
      }),
      /state CAS failed/,
    )
    await query(
      `UPDATE marketplace_installs SET uninstalled_at = NULL
        WHERE user_id = $1 AND slug = $2`,
      [author.rows[0]!.id, raw.id],
    )
    assert.equal(
      await commitPluginAccountState({
        row: fenced,
        verified: trusted,
        envelope,
        runner: getPool(),
        env,
      }),
      '3',
    )
  })
})
