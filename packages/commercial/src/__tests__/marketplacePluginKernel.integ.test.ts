import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import { listDeclarativeConnections } from '../connectors/engine/binding.js'
import { listConnections } from '../connectors/store.js'
import { closePool, createPool, getPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query, tx } from '../db/queries.js'
import {
  MarketplaceError,
  getListingDetail,
  installApprovedVersion,
  listApprovedForSearch,
  publishSkillVersion,
  recordUninstall,
} from '../marketplace/marketplaceDb.js'
import { listMarketBrowseCatalog } from '../marketplace/platformPresets.js'
import {
  findApprovedKnowledgePlanetPlugin,
  seedKnowledgePlanetPlugin,
} from '../marketplace/seedKnowledgePlanetPlugin.js'
import {
  commitPluginAccountState,
  createManagedBrowserPluginAccount,
  decryptPluginAccountEnvelope,
  fencePluginAccountInvocation,
  getPluginAccount,
} from '../plugins/accounts.js'
import { compileRuntimePluginArtifact } from '../plugins/contracts.js'
import { KnowledgePlanetRuntimeError } from '../plugins/knowledgePlanet.js'
import {
  COMPILED_KNOWLEDGE_PLANET_PLUGIN,
  KNOWLEDGE_PLANET_PLUGIN_ARTIFACT,
  KNOWLEDGE_PLANET_PLUGIN_SLUG,
  KNOWLEDGE_PLANET_PLUGIN_VERSION,
} from '../plugins/knowledgePlanetContract.js'
import {
  approveRuntimePluginVersion,
  loadVerifiedRuntimePluginContract,
} from '../plugins/review.js'
import { PluginRuntimeFacade, PluginRuntimeFacadeError } from '../plugins/runtime.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'
let pgAvailable = false

function leaseRedis() {
  let value: string | null = null
  return {
    async eval(script: string, _numKeys: number, ...args: Array<string | number>) {
      if (script.includes("redis.call('SET'")) {
        if (value !== null) return 0
        value = String(args[1])
        return 1
      }
      if (script.includes("redis.call('PEXPIRE'")) return value === String(args[1]) ? 1 : 0
      if (script.includes("redis.call('DEL'")) {
        if (value !== String(args[1])) return 0
        value = null
        return 1
      }
      return value === String(args[1]) ? 1 : 0
    },
  }
}

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
      accountState: { cookieDomains: ['example.com'], origins: ['https://example.com'] },
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

    const previousKmsKey = process.env.OPENCLAUDE_KMS_KEY
    const previousChannel = process.env.OC_RUNTIME_CHANNEL
    process.env.OPENCLAUDE_KMS_KEY = env.OPENCLAUDE_KMS_KEY
    process.env.OC_RUNTIME_CHANNEL = 'v5'
    try {
      const catalog = await listApprovedForSearch('connector')
      assert.equal(
        catalog.some(
          (item) =>
            item.slug === raw.id &&
            item.pluginType === 'managed-browser' &&
            item.versionId === version.rows[0]!.id,
        ),
        true,
      )
      const detail = await getListingDetail(raw.id)
      assert.equal(detail?.pluginType, 'managed-browser')
      assert.deepEqual(detail?.connectorContract, {
        authMode: 'managed_browser',
        approvedOrigins: ['https://example.com:443'],
        actions: [{ id: 'read', effect: 'read' }],
      })
      assert.deepEqual(
        await installApprovedVersion({
          userId: Number(author.rows[0]!.id),
          versionId: version.rows[0]!.id,
          agentIds: ['main'],
          scopeMode: 'replace',
        }),
        {
          slug: raw.id,
          version: raw.version,
          name: 'Approved Browser Plugin',
        },
      )
    } finally {
      if (previousKmsKey === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_KMS_KEY')
      else process.env.OPENCLAUDE_KMS_KEY = previousKmsKey
      if (previousChannel === undefined) Reflect.deleteProperty(process.env, 'OC_RUNTIME_CHANNEL')
      else process.env.OC_RUNTIME_CHANNEL = previousChannel
    }

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
    const currentManagement = await facade.management(Number(author.rows[0]!.id))
    assert.equal(currentManagement.catalog.length, 1)
    assert.deepEqual(
      {
        slug: currentManagement.catalog[0]!.slug,
        installed: currentManagement.catalog[0]!.installed,
        installedCurrent: currentManagement.catalog[0]!.installedCurrent,
        updateAvailable: currentManagement.catalog[0]!.updateAvailable,
      },
      {
        slug: raw.id,
        installed: true,
        installedCurrent: true,
        updateAvailable: false,
      },
    )
    assert.deepEqual(
      currentManagement.accounts.map((item) => ({ id: item.id, executable: item.executable })),
      [{ id: account.id, executable: true }],
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
    const orphanManagement = await facade.management(Number(author.rows[0]!.id))
    assert.equal(orphanManagement.catalog.length, 1)
    assert.deepEqual(
      {
        slug: orphanManagement.catalog[0]!.slug,
        installed: orphanManagement.catalog[0]!.installed,
        installedCurrent: orphanManagement.catalog[0]!.installedCurrent,
        updateAvailable: orphanManagement.catalog[0]!.updateAvailable,
      },
      {
        slug: raw.id,
        installed: false,
        installedCurrent: false,
        updateAvailable: true,
      },
    )
    assert.deepEqual(
      orphanManagement.accounts.map((item) => ({ id: item.id, executable: item.executable })),
      [{ id: account.id, executable: false }],
    )
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
    const expiringFacade = new PluginRuntimeFacade({
      pool: getPool(),
      redis: leaseRedis(),
      env,
      browserRuntime: {
        async runReadAction() {
          throw new KnowledgePlanetRuntimeError('LOGIN_EXPIRED_ACCOUNT')
        },
      } as never,
    })
    await assert.rejects(
      expiringFacade.call({
        userId: Number(author.rows[0]!.id),
        targetId: account.id,
        actionId: 'read',
        params: {},
      }),
      (error: unknown) =>
        error instanceof PluginRuntimeFacadeError && error.code === 'RELINK_REQUIRED',
    )
    const expired = await query<{ status: string; last_error_code: string | null }>(
      'SELECT status, last_error_code FROM connections WHERE id = $1',
      [account.id],
    )
    assert.deepEqual(expired.rows[0], {
      status: 'error',
      last_error_code: 'RELINK_REQUIRED',
    })
    const errorManagement = await facade.management(Number(author.rows[0]!.id))
    assert.deepEqual(
      errorManagement.accounts.map((item) => ({
        id: item.id,
        status: item.status,
        executable: item.executable,
      })),
      [{ id: account.id, status: 'error', executable: false }],
    )
    const revoker = new PluginRuntimeFacade({
      pool: getPool(),
      redis: leaseRedis(),
      env,
    })
    assert.deepEqual(await revoker.revokeManagedAccount(Number(author.rows[0]!.id), account.id), {
      id: account.id,
    })
    assert.equal(await getPluginAccount(account.id, Number(author.rows[0]!.id), getPool()), null)
    const scrubbed = await query<{
      secret_enc: Buffer | null
      secret_nonce: Buffer | null
      revoked_at: Date | null
    }>('SELECT secret_enc, secret_nonce, revoked_at FROM connections WHERE id = $1', [account.id])
    assert.equal(scrubbed.rows[0]!.secret_enc, null)
    assert.equal(scrubbed.rows[0]!.secret_nonce, null)
    assert.ok(scrubbed.rows[0]!.revoked_at)
  })

  test('seeds the official Knowledge Planet Plugin and additively migrates legacy Skill users', async (t) => {
    if (!pgAvailable) return t.skip('pg not available')
    const admin = await query<{ id: string }>(
      `INSERT INTO users(email, password_hash, email_verified, role)
       VALUES ('knowledge-planet-owner@test.local', 'x', TRUE, 'admin') RETURNING id::text`,
    )
    const user = await query<{ id: string }>(
      `INSERT INTO users(email, password_hash, email_verified)
       VALUES ('knowledge-planet-user@test.local', 'x', TRUE) RETURNING id::text`,
    )
    await query(
      `INSERT INTO marketplace_skill_listings(slug, owner_user_id, kind, state)
       VALUES ('zsxq-persistent-connector', $1, 'skill', 'active')`,
      [admin.rows[0]!.id],
    )
    const legacyVersion = await query<{ id: string }>(
      `INSERT INTO marketplace_skill_versions
         (slug, version, name, description, raw_skill_md, raw_artifact, artifact_hash,
          embedding_hash, submitted_by, status)
       VALUES ('zsxq-persistent-connector', '0.2.0', '知识星球旧版', 'legacy', '# legacy',
               '# legacy', 'legacy-zsxq-hash', 'legacy-zsxq-embedding', $1, 'approved')
       RETURNING id::text`,
      [admin.rows[0]!.id],
    )
    await query(
      `UPDATE marketplace_skill_listings SET current_approved_version_id = $2
        WHERE slug = 'zsxq-persistent-connector' AND owner_user_id = $1`,
      [admin.rows[0]!.id, legacyVersion.rows[0]!.id],
    )
    await query(
      `INSERT INTO marketplace_installs
         (user_id, slug, version_id, artifact_hash, install_source, installed_by, agent_ids)
       VALUES ($1, 'zsxq-persistent-connector', $2, 'legacy-zsxq-hash', 'web', $3,
               '["legacy-agent"]'::jsonb)`,
      [user.rows[0]!.id, legacyVersion.rows[0]!.id, admin.rows[0]!.id],
    )

    const previousKmsKey = process.env.OPENCLAUDE_KMS_KEY
    const previousChannel = process.env.OC_RUNTIME_CHANNEL
    const kms = randomBytes(32).toString('base64')
    process.env.OPENCLAUDE_KMS_KEY = kms
    process.env.OC_RUNTIME_CHANNEL = 'v5'
    try {
      await assert.rejects(
        publishSkillVersion({
          slug: KNOWLEDGE_PLANET_PLUGIN_SLUG,
          ownerUserId: Number(user.rows[0]!.id),
          version: KNOWLEDGE_PLANET_PLUGIN_VERSION,
          name: 'foreign exact copy',
          description: 'must not preclaim a platform slug',
          tags: [],
          rawSkillMd: null,
          rawArtifact: JSON.stringify(KNOWLEDGE_PLANET_PLUGIN_ARTIFACT),
          artifactHash: COMPILED_KNOWLEDGE_PLANET_PLUGIN.artifactHash,
          embeddingHash: COMPILED_KNOWLEDGE_PLANET_PLUGIN.artifactHash,
          riskFlags: [],
          policyVersion: 1,
          submittedBy: Number(user.rows[0]!.id),
          kind: 'connector',
          pluginType: 'managed-browser',
          queueAiReview: false,
        }),
        (error: unknown) =>
          error instanceof MarketplaceError && error.code === 'SLUG_OWNED_BY_OTHER',
      )
      assert.equal(
        (
          await query<{ count: string }>(
            'SELECT count(*)::text AS count FROM marketplace_skill_listings WHERE slug = $1',
            [KNOWLEDGE_PLANET_PLUGIN_SLUG],
          )
        ).rows[0]!.count,
        '0',
      )

      const seeded = await seedKnowledgePlanetPlugin({
        functionalVerified: true,
        ownerUserId: Number(admin.rows[0]!.id),
        env: process.env,
      })
      assert.equal(seeded.published, true)
      assert.equal(seeded.migratedUsers, 1)
      const trusted = await findApprovedKnowledgePlanetPlugin(process.env)
      assert.equal(trusted?.versionId, seeded.versionId)
      const detail = await getListingDetail(KNOWLEDGE_PLANET_PLUGIN_SLUG)
      assert.equal(detail?.official, true)
      assert.equal(detail?.preinstalled, false)
      const searchRow = (await listApprovedForSearch('connector')).find(
        (row) => row.slug === KNOWLEDGE_PLANET_PLUGIN_SLUG,
      )
      assert.equal(searchRow?.official, true)
      assert.equal(
        (await listMarketBrowseCatalog('connector')).some(
          (row) => row.slug === KNOWLEDGE_PLANET_PLUGIN_SLUG,
        ),
        true,
        '官方但非预装的知识星球必须保留在市场供恢复安装',
      )

      const installs = await query<{
        slug: string
        install_source: string
        installed_by: string
        agent_ids: unknown
        uninstalled_at: Date | null
      }>(
        `SELECT slug, install_source, installed_by::text, agent_ids, uninstalled_at
           FROM marketplace_installs
          WHERE user_id = $1 AND slug IN ('zsxq-persistent-connector', 'knowledge-planet')
          ORDER BY slug`,
        [user.rows[0]!.id],
      )
      assert.deepEqual(
        installs.rows.map((row) => ({
          slug: row.slug,
          source: row.install_source,
          installedBy: row.installed_by,
          agentIds: row.agent_ids,
          active: row.uninstalled_at === null,
        })),
        [
          {
            slug: 'knowledge-planet',
            source: 'migration:zsxq-persistent-connector:web',
            installedBy: admin.rows[0]!.id,
            agentIds: ['legacy-agent'],
            active: true,
          },
          {
            slug: 'zsxq-persistent-connector',
            source: 'web',
            installedBy: admin.rows[0]!.id,
            agentIds: ['legacy-agent'],
            active: true,
          },
        ],
      )
      await query("UPDATE users SET status = 'banned' WHERE id = $1", [admin.rows[0]!.id])
      await query(
        `INSERT INTO users(email, password_hash, email_verified, role)
         VALUES ('knowledge-planet-next-admin@test.local', 'x', TRUE, 'admin')`,
      )
      const repeated = await seedKnowledgePlanetPlugin({
        functionalVerified: true,
        env: process.env,
      })
      assert.equal(repeated.published, false)
      assert.equal(repeated.ownerUserId, Number(admin.rows[0]!.id))
      assert.equal(repeated.migratedUsers, 0)
      assert.equal(repeated.skippedExistingUsers, 1)

      assert.equal(
        await recordUninstall(Number(user.rows[0]!.id), KNOWLEDGE_PLANET_PLUGIN_SLUG),
        true,
      )
      const afterUninstallSeed = await seedKnowledgePlanetPlugin({
        functionalVerified: true,
        env: process.env,
      })
      assert.equal(afterUninstallSeed.migratedUsers, 0)
      assert.equal(afterUninstallSeed.skippedExistingUsers, 1)
      const afterUninstall = await query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM marketplace_installs
          WHERE user_id = $1 AND slug = $2 AND uninstalled_at IS NULL`,
        [user.rows[0]!.id, KNOWLEDGE_PLANET_PLUGIN_SLUG],
      )
      assert.equal(
        afterUninstall.rows[0]!.count,
        '0',
        '重复部署 seed 不得覆盖用户的 soft-uninstall 意图',
      )
      await installApprovedVersion({
        userId: Number(user.rows[0]!.id),
        versionId: seeded.versionId,
      })
      const recovered = await query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM marketplace_installs
          WHERE user_id = $1 AND slug = $2 AND uninstalled_at IS NULL`,
        [user.rows[0]!.id, KNOWLEDGE_PLANET_PLUGIN_SLUG],
      )
      assert.equal(recovered.rows[0]!.count, '1', 'soft-uninstall 后必须可从市场恢复安装')
    } finally {
      if (previousKmsKey === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_KMS_KEY')
      else process.env.OPENCLAUDE_KMS_KEY = previousKmsKey
      if (previousChannel === undefined) Reflect.deleteProperty(process.env, 'OC_RUNTIME_CHANNEL')
      else process.env.OC_RUNTIME_CHANNEL = previousChannel
    }
  })
})
