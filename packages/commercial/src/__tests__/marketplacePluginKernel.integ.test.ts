import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import { listDeclarativeConnections } from '../connectors/engine/binding.js'
import { ConnectorError } from '../connectors/errors.js'
import { approveConfirmation, getLedgerRow } from '../connectors/ledger.js'
import { listConnections } from '../connectors/store.js'
import { closePool, createPool, getPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query, tx } from '../db/queries.js'
import { resetTestSchemaForTest } from './helpers/db.js'
import {
  MarketplaceError,
  getListingDetail,
  installApprovedVersion,
  listActiveInstalledArtifacts,
  listApprovedForSearch,
  publishSkillVersion,
  recordUninstall,
} from '../marketplace/marketplaceDb.js'
import { listMarketBrowseCatalog } from '../marketplace/platformPresets.js'
import {
  findApprovedKnowledgePlanetPlugin,
  findApprovedKnowledgePlanetPluginForDeploy,
  seedKnowledgePlanetPlugin,
} from '../marketplace/seedKnowledgePlanetPlugin.js'
import { acquirePluginAccountLease } from '../plugins/accountLease.js'
import {
  bindManagedBrowserPluginAccount,
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
  OFFICIAL_MANAGED_BROWSER_TRANSITION_GATE_REASON,
  closeOfficialManagedBrowserPluginListingGate,
  openOfficialManagedBrowserPluginListingGate,
  readOfficialManagedBrowserTransitionCensus,
  transitionOfficialManagedBrowserPluginVersion,
} from '../plugins/officialManagedBrowserTransition.js'
import {
  approveOfficialRuntimePluginVersion,
  approveRuntimePluginVersion,
  loadVerifiedRuntimePluginContract,
} from '../plugins/review.js'
import { PluginRuntimeFacade, PluginRuntimeFacadeError } from '../plugins/runtime.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'
let pgAvailable = false

function leaseRedis() {
  const values = new Map<string, string>()
  return {
    async eval(script: string, _numKeys: number, ...args: Array<string | number>) {
      const key = String(args[0])
      const token = String(args[1])
      if (script.includes("redis.call('SET'")) {
        if (values.has(key)) return 0
        values.set(key, token)
        return 1
      }
      if (script.includes("redis.call('PEXPIRE'")) return values.get(key) === token ? 1 : 0
      if (script.includes("redis.call('DEL'")) {
        if (values.get(key) !== token) return 0
        values.delete(key)
        return 1
      }
      return values.get(key) === token ? 1 : 0
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
  await resetTestSchemaForTest()
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
    const facade = new PluginRuntimeFacade({
      pool: getPool(),
      redis: null,
      env,
      browserRuntime: { supportsContract: () => true } as never,
    })
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
    const unsupportedFacade = new PluginRuntimeFacade({
      pool: getPool(),
      redis: null,
      env,
      browserRuntime: { supportsContract: () => false } as never,
    })
    assert.equal(
      await unsupportedFacade.classifyTarget(Number(author.rows[0]!.id), account.id),
      null,
    )
    assert.deepEqual(await unsupportedFacade.catalog(Number(author.rows[0]!.id)), [])
    assert.deepEqual(await unsupportedFacade.list(Number(author.rows[0]!.id)), [])
    const unsupportedManagement = await unsupportedFacade.management(Number(author.rows[0]!.id))
    assert.equal(unsupportedManagement.catalog.length, 1)
    assert.deepEqual(
      unsupportedManagement.accounts.map((item) => ({ id: item.id, executable: item.executable })),
      [{ id: account.id, executable: false }],
    )
    await assert.rejects(
      unsupportedFacade.call({
        userId: Number(author.rows[0]!.id),
        targetId: account.id,
        actionId: 'read',
        params: {},
      }),
      (error: unknown) =>
        error instanceof PluginRuntimeFacadeError && error.code === 'RUNTIME_UNAVAILABLE',
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
        supportsContract() {
          return true
        },
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
    const transitionUsers = await query<{ id: string; email: string }>(
      `INSERT INTO users(email, password_hash, email_verified)
       VALUES
         ('knowledge-planet-active@test.local', 'x', TRUE),
         ('knowledge-planet-error@test.local', 'x', TRUE),
         ('knowledge-planet-no-account@test.local', 'x', TRUE),
         ('knowledge-planet-mutation@test.local', 'x', TRUE),
         ('knowledge-planet-soft@test.local', 'x', TRUE),
         ('knowledge-planet-orphan@test.local', 'x', TRUE),
         ('knowledge-planet-partial@test.local', 'x', TRUE),
         ('knowledge-planet-phantom@test.local', 'x', TRUE)
       RETURNING id::text, email`,
    )
    const transitionUserId = (email: string) => {
      const id = transitionUsers.rows.find((row) => row.email === email)?.id
      if (!id) throw new Error(`missing transition test user: ${email}`)
      return Number(id)
    }
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
    const partialUserId = transitionUserId('knowledge-planet-partial@test.local')
    await query(
      `INSERT INTO marketplace_installs
         (user_id, slug, version_id, artifact_hash, install_source, installed_by, agent_ids)
       VALUES ($1, 'zsxq-persistent-connector', $2, 'legacy-zsxq-hash', 'web', $3,
               '["main"]'::jsonb)`,
      [partialUserId, legacyVersion.rows[0]!.id, admin.rows[0]!.id],
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

      // Model a real already-published 1.0 release. Deploy closes this listing
      // before the 1.1 source is activated, so the seed must be able to verify
      // the recorded platform owner while the public runtime gate is unlisted.
      const oldArtifact = {
        ...KNOWLEDGE_PLANET_PLUGIN_ARTIFACT,
        version: '1.0.0',
        driver: { id: 'knowledge-planet-integration-v1', version: '1.0.0' },
        actions: KNOWLEDGE_PLANET_PLUGIN_ARTIFACT.actions.slice(0, 4),
      }
      const oldCompiled = compileRuntimePluginArtifact(oldArtifact)
      await query(
        `INSERT INTO marketplace_skill_listings
           (slug, owner_user_id, kind, plugin_type, state)
         VALUES ($1, $2, 'connector', 'managed-browser', 'unlisted')`,
        [KNOWLEDGE_PLANET_PLUGIN_SLUG, admin.rows[0]!.id],
      )
      const oldVersion = await query<{ id: string }>(
        `INSERT INTO marketplace_skill_versions
           (slug, version, name, description, raw_artifact, artifact_hash,
            embedding_hash, submitted_by)
         VALUES ($1, '1.0.0', '知识星球 1.0', 'legacy official Plugin', $2, $3, $3, $4)
         RETURNING id::text`,
        [
          KNOWLEDGE_PLANET_PLUGIN_SLUG,
          JSON.stringify(oldArtifact),
          oldCompiled.artifactHash,
          admin.rows[0]!.id,
        ],
      )
      await approveOfficialRuntimePluginVersion({
        versionId: oldVersion.rows[0]!.id,
        ownerUserId: Number(admin.rows[0]!.id),
        expectedArtifactHash: oldCompiled.artifactHash,
        functionalVerified: true,
        env: process.env,
        pool: getPool(),
      })

      const activeUserId = transitionUserId('knowledge-planet-active@test.local')
      const errorUserId = transitionUserId('knowledge-planet-error@test.local')
      const noAccountUserId = transitionUserId('knowledge-planet-no-account@test.local')
      const mutationUserId = transitionUserId('knowledge-planet-mutation@test.local')
      const softUserId = transitionUserId('knowledge-planet-soft@test.local')
      const orphanUserId = transitionUserId('knowledge-planet-orphan@test.local')
      const phantomUserId = transitionUserId('knowledge-planet-phantom@test.local')
      for (const userId of [
        activeUserId,
        errorUserId,
        noAccountUserId,
        mutationUserId,
        softUserId,
        orphanUserId,
        partialUserId,
      ])
        await installApprovedVersion({
          userId,
          versionId: oldVersion.rows[0]!.id,
          agentIds: ['main', `user-${userId}`],
          scopeMode: 'replace',
        })

      const storageState = (name: string) => ({
        cookies: [
          {
            name,
            value: `secret-${name}`,
            domain: '.zsxq.com',
            path: '/',
            expires: -1,
            httpOnly: true,
            secure: true,
            sameSite: 'Lax',
          },
        ],
        origins: [],
      })
      const activeAccount = await createManagedBrowserPluginAccount({
        userId: activeUserId,
        versionId: Number(oldVersion.rows[0]!.id),
        displayName: 'Active Knowledge Planet',
        accountHint: 'active',
        storageState: storageState('active'),
        env: process.env,
      })
      const errorAccount = await createManagedBrowserPluginAccount({
        userId: errorUserId,
        versionId: Number(oldVersion.rows[0]!.id),
        displayName: 'Expired Knowledge Planet',
        accountHint: 'error',
        storageState: storageState('error'),
        env: process.env,
      })
      await query(
        `UPDATE connections
            SET status = 'error', last_error_code = 'RELINK_REQUIRED'
          WHERE id = $1`,
        [errorAccount.id],
      )
      const orphanAccount = await createManagedBrowserPluginAccount({
        userId: orphanUserId,
        versionId: Number(oldVersion.rows[0]!.id),
        displayName: 'Orphan Knowledge Planet',
        accountHint: 'orphan',
        storageState: storageState('orphan'),
        env: process.env,
      })
      assert.equal(await recordUninstall(softUserId, KNOWLEDGE_PLANET_PLUGIN_SLUG), true)
      // Historical/partially migrated data can contain an orphan account even
      // though the current UI correctly requires unlink-before-uninstall.
      await query(
        `UPDATE marketplace_installs SET uninstalled_at = NOW()
          WHERE user_id = $1 AND slug = $2 AND uninstalled_at IS NULL`,
        [orphanUserId, KNOWLEDGE_PLANET_PLUGIN_SLUG],
      )
      assert.equal(
        (await listActiveInstalledArtifacts(partialUserId)).some(
          (item) => item.slug === 'zsxq-persistent-connector',
        ),
        true,
        '部分迁移或补偿期间旧 listing 仍 active 时不得按用户 Plugin 历史提前屏蔽旧 Skill',
      )

      const oldActiveRow = await getPluginAccount(activeAccount.id, activeUserId, getPool(), {
        includeError: true,
      })
      const oldErrorRow = await getPluginAccount(errorAccount.id, errorUserId, getPool(), {
        includeError: true,
      })
      const oldOrphanRow = await getPluginAccount(orphanAccount.id, orphanUserId, getPool(), {
        includeError: true,
      })
      assert.ok(oldActiveRow && oldErrorRow && oldOrphanRow)
      const oldVerified = await loadVerifiedRuntimePluginContract(
        Number(oldVersion.rows[0]!.id),
        getPool(),
        { env: process.env },
      )
      assert.equal(oldVerified.pluginType, 'managed-browser')
      if (oldVerified.pluginType !== 'managed-browser') throw new Error('unexpected old subtype')
      const oldActiveEnvelope = decryptPluginAccountEnvelope(
        oldActiveRow,
        oldVerified.contract,
        process.env,
      )
      const oldErrorEnvelope = decryptPluginAccountEnvelope(
        oldErrorRow,
        oldVerified.contract,
        process.env,
      )
      const transitionRedis = leaseRedis()
      await closeOfficialManagedBrowserPluginListingGate({
        slug: KNOWLEDGE_PLANET_PLUGIN_SLUG,
        env: process.env,
      })
      const guardedScope = await readOfficialManagedBrowserTransitionCensus(
        KNOWLEDGE_PLANET_PLUGIN_SLUG,
      )
      await assert.rejects(
        transitionOfficialManagedBrowserPluginVersion({
          slug: KNOWLEDGE_PLANET_PLUGIN_SLUG,
          targetVersionId: oldVersion.rows[0]!.id,
          expectedArtifactHash: oldCompiled.artifactHash,
          expectedExecContractHash: oldCompiled.execContractHash,
          ownerUserId: Number(admin.rows[0]!.id),
          env: process.env,
          redis: transitionRedis,
          openListingAtCommit: false,
          expectedScope: {
            ...guardedScope,
            installs: [
              ...guardedScope.installs,
              { ...guardedScope.installs[0]!, id: '999999999999999999' },
            ],
          },
        }),
        /transition scope changed/,
      )
      await query("UPDATE connections SET status = 'error' WHERE id = $1::bigint", [
        activeAccount.id,
      ])
      await assert.rejects(
        transitionOfficialManagedBrowserPluginVersion({
          slug: KNOWLEDGE_PLANET_PLUGIN_SLUG,
          targetVersionId: oldVersion.rows[0]!.id,
          expectedArtifactHash: oldCompiled.artifactHash,
          expectedExecContractHash: oldCompiled.execContractHash,
          ownerUserId: Number(admin.rows[0]!.id),
          env: process.env,
          redis: transitionRedis,
          openListingAtCommit: false,
          expectedScope: guardedScope,
        }),
        /transition scope changed/,
        'same account id with a changed status must fail the verified census fence',
      )
      await query("UPDATE connections SET status = 'active' WHERE id = $1::bigint", [
        activeAccount.id,
      ])

      const initialHandoffBinds: Array<
        Awaited<ReturnType<typeof bindManagedBrowserPluginAccount>>
      > = []
      const refreshedHandoffBinds: Array<
        Awaited<ReturnType<typeof bindManagedBrowserPluginAccount>>
      > = []
      const replacementHandoffBinds: Array<
        Awaited<ReturnType<typeof bindManagedBrowserPluginAccount>>
      > = []
      const initialHandoffState = storageState('verified-handoff-initial')
      const verifiedHandoffState = storageState('verified-handoff-refreshed')
      const relinkedHandoffState = storageState('verified-handoff-relinked')
      const relinkedAccountInstanceId = '10000000-0000-4000-8000-000000000001'
      const seeded = await seedKnowledgePlanetPlugin({
        functionalVerified: true,
        ownerUserId: Number(admin.rows[0]!.id),
        env: process.env,
        leaseRedis: transitionRedis,
        beforeListingOpen: async ({ versionId }) => {
          const gate = await query<{ state: string }>(
            'SELECT state FROM marketplace_skill_listings WHERE slug = $1',
            [KNOWLEDGE_PLANET_PLUGIN_SLUG],
          )
          assert.equal(gate.rows[0]?.state, 'unlisted')
          initialHandoffBinds.push(
            await bindManagedBrowserPluginAccount({
              userId: noAccountUserId,
              versionId: Number(versionId),
              displayName: 'Verified Knowledge Planet',
              accountHint: 'one scan',
              storageState: initialHandoffState,
              existing: 'reuse-identical',
              unlistedGateReason: OFFICIAL_MANAGED_BROWSER_TRANSITION_GATE_REASON,
              env: process.env,
            }),
          )
          await assert.rejects(
            bindManagedBrowserPluginAccount({
              userId: noAccountUserId,
              versionId: Number(versionId),
              storageState: verifiedHandoffState,
              existing: 'reuse-identical',
              expectedExistingAccountInstanceId: initialHandoffBinds[0]!.accountInstanceId,
              unlistedGateReason: OFFICIAL_MANAGED_BROWSER_TRANSITION_GATE_REASON,
              env: process.env,
            }),
            /differs from verified state/,
          )
          await assert.rejects(
            bindManagedBrowserPluginAccount({
              userId: noAccountUserId,
              versionId: Number(versionId),
              storageState: verifiedHandoffState,
              existing: 'refresh-fenced',
              expectedExistingAccountInstanceId: '00000000-0000-4000-8000-000000000001',
              unlistedGateReason: OFFICIAL_MANAGED_BROWSER_TRANSITION_GATE_REASON,
              env: process.env,
            }),
            /handoff account identity changed/,
          )
          refreshedHandoffBinds.push(
            await bindManagedBrowserPluginAccount({
              userId: noAccountUserId,
              versionId: Number(versionId),
              displayName: 'Verified Knowledge Planet',
              accountHint: 'refreshed during action smoke',
              storageState: verifiedHandoffState,
              existing: 'refresh-fenced',
              expectedExistingAccountInstanceId: initialHandoffBinds[0]!.accountInstanceId,
              unlistedGateReason: OFFICIAL_MANAGED_BROWSER_TRANSITION_GATE_REASON,
              env: process.env,
            }),
          )
          assert.equal(
            refreshedHandoffBinds[0]!.accountInstanceId,
            initialHandoffBinds[0]!.accountInstanceId,
          )
          const refreshedRow = await getPluginAccount(
            refreshedHandoffBinds[0]!.id,
            noAccountUserId,
            getPool(),
            { includeError: true },
          )
          const refreshedVerified = await loadVerifiedRuntimePluginContract(
            Number(versionId),
            getPool(),
            { env: process.env, allowUnlisted: true },
          )
          assert.ok(refreshedRow && refreshedVerified.pluginType === 'managed-browser')
          if (!refreshedRow || refreshedVerified.pluginType !== 'managed-browser')
            throw new Error('unexpected refreshed handoff account')
          assert.deepEqual(
            decryptPluginAccountEnvelope(refreshedRow, refreshedVerified.contract, process.env)
              .storageState,
            verifiedHandoffState,
          )
          await assert.rejects(
            bindManagedBrowserPluginAccount({
              userId: noAccountUserId,
              versionId: Number(versionId),
              storageState: relinkedHandoffState,
              existing: 'replace',
              expectedExistingAccountInstanceId: '00000000-0000-4000-8000-000000000001',
              replacementAccountInstanceId: relinkedAccountInstanceId,
              unlistedGateReason: OFFICIAL_MANAGED_BROWSER_TRANSITION_GATE_REASON,
              env: process.env,
            }),
            /handoff account identity changed/,
          )
          replacementHandoffBinds.push(
            await bindManagedBrowserPluginAccount({
              userId: noAccountUserId,
              versionId: Number(versionId),
              displayName: 'Verified Knowledge Planet',
              accountHint: 'relinked after expiry',
              storageState: relinkedHandoffState,
              existing: 'replace',
              expectedExistingAccountInstanceId: refreshedHandoffBinds[0]!.accountInstanceId,
              replacementAccountInstanceId: relinkedAccountInstanceId,
              unlistedGateReason: OFFICIAL_MANAGED_BROWSER_TRANSITION_GATE_REASON,
              env: process.env,
            }),
          )
        },
      })
      assert.equal(seeded.published, true)
      assert.equal(seeded.migratedUsers, 1)
      assert.equal(seeded.skippedExistingUsers, 1)
      assert.equal(seeded.migratedPluginInstalls, 5)
      assert.equal(seeded.migratedPluginAccounts, 2)
      assert.equal(seeded.retiredLegacyListing, true)
      assert.equal(initialHandoffBinds[0]?.outcome, 'created')
      assert.equal(refreshedHandoffBinds[0]?.outcome, 'refreshed')
      assert.equal(replacementHandoffBinds[0]?.outcome, 'replaced')
      assert.equal(replacementHandoffBinds[0]?.accountInstanceId, relinkedAccountInstanceId)

      await closeOfficialManagedBrowserPluginListingGate({
        slug: KNOWLEDGE_PLANET_PLUGIN_SLUG,
        env: process.env,
      })
      await assert.rejects(
        seedKnowledgePlanetPlugin({
          functionalVerified: true,
          env: process.env,
          leaseRedis: transitionRedis,
          beforeListingOpen: async () => {
            throw new Error('simulated crash after transition before handoff bind')
          },
        }),
        /simulated crash/,
      )
      const closedAfterCrash = await query<{ state: string }>(
        'SELECT state FROM marketplace_skill_listings WHERE slug = $1',
        [KNOWLEDGE_PLANET_PLUGIN_SLUG],
      )
      assert.equal(closedAfterCrash.rows[0]?.state, 'unlisted')
      const retryHandoffBinds: Array<Awaited<ReturnType<typeof bindManagedBrowserPluginAccount>>> =
        []
      await seedKnowledgePlanetPlugin({
        functionalVerified: true,
        env: process.env,
        leaseRedis: transitionRedis,
        beforeListingOpen: async ({ versionId }) => {
          retryHandoffBinds.push(
            await bindManagedBrowserPluginAccount({
              userId: noAccountUserId,
              versionId: Number(versionId),
              displayName: 'Verified Knowledge Planet',
              accountHint: 'one scan',
              storageState: relinkedHandoffState,
              existing: 'reuse-identical',
              expectedExistingAccountInstanceId: replacementHandoffBinds[0]!.accountInstanceId,
              unlistedGateReason: OFFICIAL_MANAGED_BROWSER_TRANSITION_GATE_REASON,
              env: process.env,
            }),
          )
        },
      })
      assert.equal(retryHandoffBinds[0]?.outcome, 'reused')

      const crashReplacementState = storageState('verified-handoff-crash-replacement')
      const crashReplacementAccountInstanceId = '10000000-0000-4000-8000-000000000002'
      const crashReplacementBinds: Array<
        Awaited<ReturnType<typeof bindManagedBrowserPluginAccount>>
      > = []
      await closeOfficialManagedBrowserPluginListingGate({
        slug: KNOWLEDGE_PLANET_PLUGIN_SLUG,
        env: process.env,
      })
      await assert.rejects(
        seedKnowledgePlanetPlugin({
          functionalVerified: true,
          env: process.env,
          leaseRedis: transitionRedis,
          beforeListingOpen: async ({ versionId }) => {
            crashReplacementBinds.push(
              await bindManagedBrowserPluginAccount({
                userId: noAccountUserId,
                versionId: Number(versionId),
                displayName: 'Verified Knowledge Planet',
                accountHint: 'replacement committed before crash',
                storageState: crashReplacementState,
                existing: 'replace',
                expectedExistingAccountInstanceId: relinkedAccountInstanceId,
                replacementAccountInstanceId: crashReplacementAccountInstanceId,
                unlistedGateReason: OFFICIAL_MANAGED_BROWSER_TRANSITION_GATE_REASON,
                env: process.env,
              }),
            )
            throw new Error('simulated crash after handoff replacement before listing open')
          },
        }),
        /simulated crash after handoff replacement/,
      )
      assert.equal(crashReplacementBinds[0]?.outcome, 'replaced')
      assert.equal(crashReplacementBinds[0]?.accountInstanceId, crashReplacementAccountInstanceId)
      const closedAfterReplacementCrash = await query<{ state: string }>(
        'SELECT state FROM marketplace_skill_listings WHERE slug = $1',
        [KNOWLEDGE_PLANET_PLUGIN_SLUG],
      )
      assert.equal(closedAfterReplacementCrash.rows[0]?.state, 'unlisted')
      const replayedReplacementBinds: Array<
        Awaited<ReturnType<typeof bindManagedBrowserPluginAccount>>
      > = []
      await seedKnowledgePlanetPlugin({
        functionalVerified: true,
        env: process.env,
        leaseRedis: transitionRedis,
        beforeListingOpen: async ({ versionId }) => {
          replayedReplacementBinds.push(
            await bindManagedBrowserPluginAccount({
              userId: noAccountUserId,
              versionId: Number(versionId),
              displayName: 'Verified Knowledge Planet',
              accountHint: 'replacement replay',
              storageState: crashReplacementState,
              existing: 'replace',
              expectedExistingAccountInstanceId: relinkedAccountInstanceId,
              replacementAccountInstanceId: crashReplacementAccountInstanceId,
              unlistedGateReason: OFFICIAL_MANAGED_BROWSER_TRANSITION_GATE_REASON,
              env: process.env,
            }),
          )
        },
      })
      assert.equal(replayedReplacementBinds[0]?.outcome, 'reused')
      assert.equal(
        replayedReplacementBinds[0]?.accountInstanceId,
        crashReplacementAccountInstanceId,
      )
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
      assert.equal(
        (await listApprovedForSearch('skill')).some(
          (row) => row.slug === 'zsxq-persistent-connector',
        ),
        false,
        '旧自托管知识星球 Skill 迁移完成后不得继续出现在市场或允许新装',
      )
      const legacyListing = await query<{ state: string; revoked_reason: string | null }>(
        `SELECT state, revoked_reason FROM marketplace_skill_listings
          WHERE slug = 'zsxq-persistent-connector'`,
      )
      assert.deepEqual(legacyListing.rows[0], {
        state: 'unlisted',
        revoked_reason: 'migrated to official knowledge-planet Plugin',
      })

      const migratedActive = await getPluginAccount(activeAccount.id, activeUserId, getPool(), {
        includeError: true,
      })
      const migratedError = await getPluginAccount(errorAccount.id, errorUserId, getPool(), {
        includeError: true,
      })
      const unchangedOrphan = await getPluginAccount(orphanAccount.id, orphanUserId, getPool(), {
        includeError: true,
      })
      assert.ok(migratedActive && migratedError && unchangedOrphan)
      assert.equal(migratedActive.connector_version_id, seeded.versionId)
      assert.equal(migratedActive.revision, oldActiveRow.revision + 1)
      assert.equal(
        BigInt(migratedActive.secret_generation),
        BigInt(oldActiveRow.secret_generation) + 1n,
      )
      assert.equal(migratedError.connector_version_id, seeded.versionId)
      assert.equal(migratedError.status, 'error')
      assert.equal(migratedError.revision, oldErrorRow.revision + 1)
      assert.equal(unchangedOrphan.connector_version_id, oldVersion.rows[0]!.id)
      assert.equal(unchangedOrphan.revision, oldOrphanRow.revision)
      assert.equal(unchangedOrphan.secret_generation, oldOrphanRow.secret_generation)
      const newVerified = await loadVerifiedRuntimePluginContract(
        Number(seeded.versionId),
        getPool(),
        { env: process.env },
      )
      assert.equal(newVerified.pluginType, 'managed-browser')
      if (newVerified.pluginType !== 'managed-browser') throw new Error('unexpected new subtype')
      const migratedActiveEnvelope = decryptPluginAccountEnvelope(
        migratedActive,
        newVerified.contract,
        process.env,
      )
      const migratedErrorEnvelope = decryptPluginAccountEnvelope(
        migratedError,
        newVerified.contract,
        process.env,
      )
      assert.equal(migratedActiveEnvelope.accountInstanceId, oldActiveEnvelope.accountInstanceId)
      assert.deepEqual(migratedActiveEnvelope.storageState, oldActiveEnvelope.storageState)
      assert.equal(migratedErrorEnvelope.accountInstanceId, oldErrorEnvelope.accountInstanceId)
      assert.deepEqual(migratedErrorEnvelope.storageState, oldErrorEnvelope.storageState)
      const noAccountInstall = await query<{
        version_id: string
        agent_ids: unknown
        uninstalled_at: Date | null
      }>(
        `SELECT version_id::text, agent_ids, uninstalled_at
           FROM marketplace_installs
          WHERE user_id = $1 AND slug = $2 ORDER BY id DESC LIMIT 1`,
        [noAccountUserId, KNOWLEDGE_PLANET_PLUGIN_SLUG],
      )
      assert.deepEqual(noAccountInstall.rows[0], {
        version_id: seeded.versionId,
        agent_ids: ['main', `user-${noAccountUserId}`],
        uninstalled_at: null,
      })
      const handoffAccount = await query<{ id: string }>(
        `SELECT id::text AS id FROM connections
          WHERE user_id = $1 AND provider = $2 AND revoked_at IS NULL`,
        [noAccountUserId, KNOWLEDGE_PLANET_PLUGIN_SLUG],
      )
      assert.equal(handoffAccount.rowCount, 1)
      const handoffRow = await getPluginAccount(
        handoffAccount.rows[0]!.id,
        noAccountUserId,
        getPool(),
        { includeError: true },
      )
      assert.ok(handoffRow)
      assert.deepEqual(
        decryptPluginAccountEnvelope(handoffRow, newVerified.contract, process.env).storageState,
        crashReplacementState,
      )
      const untouchedInstalls = await query<{
        user_id: number
        version_id: string
        uninstalled_at: Date | null
      }>(
        `SELECT user_id::int, version_id::text, uninstalled_at
           FROM marketplace_installs
          WHERE user_id = ANY($1::bigint[]) AND slug = $2
          ORDER BY user_id, id DESC`,
        [[softUserId, orphanUserId], KNOWLEDGE_PLANET_PLUGIN_SLUG],
      )
      assert.equal(untouchedInstalls.rows.length, 2)
      assert.ok(
        untouchedInstalls.rows.every(
          (row) => row.version_id === oldVersion.rows[0]!.id && row.uninstalled_at !== null,
        ),
      )

      const facade = new PluginRuntimeFacade({
        pool: getPool(),
        redis: transitionRedis,
        env: process.env,
        browserRuntime: { supportsContract: () => true } as never,
      })
      assert.equal(
        (await facade.catalog(activeUserId))[0]?.actions.length,
        KNOWLEDGE_PLANET_PLUGIN_ARTIFACT.actions.length,
      )
      const offTarget = (await facade.list(activeUserId)).find(
        (target) => target.id === activeAccount.id,
      )
      assert.ok(offTarget)
      assert.equal(
        offTarget.actions.length,
        KNOWLEDGE_PLANET_PLUGIN_ARTIFACT.actions.filter((action) => action.effect === 'read')
          .length,
      )
      assert.equal(
        offTarget.actions.some((action) => !action.readOnly),
        false,
      )
      const offManagement = await facade.management(activeUserId)
      const offControl = offManagement.accounts.find(
        (account) => account.id === activeAccount.id,
      )?.writeControl
      assert.ok(offControl)
      assert.deepEqual(
        {
          available: offControl.available,
          enabled: offControl.enabled,
          acceptedVersion: offControl.acceptedVersion,
          acceptedAt: offControl.acceptedAt,
        },
        { available: true, enabled: false, acceptedVersion: null, acceptedAt: null },
      )
      assert.match(offControl.disclaimerText, /真实知识星球身份/)
      assert.match(offControl.disclaimerText, /每一次操作仍须由你在对话确认卡中单独批准/)
      assert.match(offControl.disclaimerText, /不会自动重试/)
      assert.equal(offControl.preapproval.available, true)
      assert.equal(offControl.preapproval.enabled, false)
      assert.equal(offControl.preapproval.acceptedVersion, null)
      assert.match(offControl.preapproval.disclaimerText ?? '', /免逐次确认/)
      await assert.rejects(
        facade.proposeWrite({
          userId: activeUserId,
          targetId: activeAccount.id,
          actionId: 'create_topic',
          params: { groupId: '123456', text: 'default-off probe' },
        }),
        (error: unknown) =>
          error instanceof PluginRuntimeFacadeError && error.code === 'WRITE_DISABLED',
      )
      await assert.rejects(
        facade.call({
          userId: activeUserId,
          targetId: activeAccount.id,
          actionId: 'create_topic',
          params: { groupId: '123456', text: 'must confirm' },
        }),
        (error: unknown) =>
          error instanceof PluginRuntimeFacadeError && error.code === 'WRITE_REQUIRES_CONFIRMATION',
      )

      const enabledControl = await facade.setManagedAccountWriteAccess({
        userId: activeUserId,
        targetId: activeAccount.id,
        enabled: true,
        accepted: true,
        disclaimerVersion: offControl.disclaimerVersion,
      })
      assert.equal(enabledControl.enabled, true)
      assert.equal(enabledControl.acceptedVersion, offControl.disclaimerVersion)
      assert.ok(enabledControl.acceptedAt)
      const onTarget = (await facade.list(activeUserId)).find(
        (target) => target.id === activeAccount.id,
      )
      assert.ok(onTarget)
      assert.equal(onTarget.actions.length, KNOWLEDGE_PLANET_PLUGIN_ARTIFACT.actions.length)
      assert.deepEqual(
        onTarget.actions.filter((action) => !action.readOnly).map((action) => action.id),
        [
          'create_topic',
          'create_comment',
          'edit_topic',
          'delete_topic',
          'delete_comment',
          'set_topic_like',
          'set_comment_like',
        ],
      )

      const staleProposal = await facade.proposeWrite({
        userId: activeUserId,
        targetId: activeAccount.id,
        actionId: 'create_topic',
        params: { groupId: '123456', text: 'disable-before-arm probe' },
      })
      await approveConfirmation(staleProposal.confirmId, activeUserId, getPool())
      await facade.setManagedAccountWriteAccess({
        userId: activeUserId,
        targetId: activeAccount.id,
        enabled: false,
      })
      await assert.rejects(
        facade.executeConfirmedWrite({
          userId: activeUserId,
          targetId: activeAccount.id,
          confirmId: staleProposal.confirmId,
        }),
        (error: unknown) => error instanceof ConnectorError && error.code === 'REVISION_MISMATCH',
      )
      const staleLedger = await getLedgerRow(staleProposal.confirmId, activeUserId, getPool())
      assert.equal(staleLedger?.dispatch_fence_required, true)
      assert.equal(staleLedger?.status, 'failed')
      assert.equal(staleLedger?.dispatch_armed_at, null)

      await facade.setManagedAccountWriteAccess({
        userId: activeUserId,
        targetId: activeAccount.id,
        enabled: true,
        accepted: true,
        disclaimerVersion: offControl.disclaimerVersion,
      })
      const preapprovedControl = await facade.setManagedAccountWritePreapproval({
        userId: activeUserId,
        targetId: activeAccount.id,
        enabled: true,
        accepted: true,
        disclaimerVersion: enabledControl.preapproval.disclaimerVersion!,
      })
      assert.equal(preapprovedControl.preapproval.enabled, true)
      assert.ok(preapprovedControl.preapproval.acceptedAt)
      const preapprovedProposal = await facade.proposeWrite({
        userId: activeUserId,
        targetId: activeAccount.id,
        actionId: 'set_topic_like',
        params: { topicId: '987654', liked: true },
      })
      assert.equal(preapprovedProposal.approvalMode, 'account_preapproval')
      const preapprovedLedger = await getLedgerRow(
        preapprovedProposal.confirmId,
        activeUserId,
        getPool(),
      )
      assert.equal(preapprovedLedger?.status, 'approved')
      assert.equal(preapprovedLedger?.approval_source, 'account_preapproval')
      assert.equal(
        preapprovedLedger?.approval_policy_version,
        enabledControl.preapproval.disclaimerVersion,
      )
      let preapprovedDispatches = 0
      const preapprovedFacade = new PluginRuntimeFacade({
        pool: getPool(),
        redis: transitionRedis,
        env: process.env,
        browserRuntime: {
          supportsContract: () => true,
          async runAction(input: {
            storageState: unknown
            beforeDispatch: () => Promise<void>
          }) {
            await input.beforeDispatch()
            preapprovedDispatches += 1
            return { result: { liked: true }, storageState: input.storageState }
          },
        } as never,
      })
      assert.deepEqual(
        await preapprovedFacade.executeConfirmedWrite({
          userId: activeUserId,
          targetId: activeAccount.id,
          confirmId: preapprovedProposal.confirmId,
        }),
        { kind: 'result', result: { liked: true } },
      )
      assert.equal(preapprovedDispatches, 1)
      assert.equal(
        (await getLedgerRow(preapprovedProposal.confirmId, activeUserId, getPool()))?.status,
        'succeeded',
      )
      const disableRaceProposal = await preapprovedFacade.proposeWrite({
        userId: activeUserId,
        targetId: activeAccount.id,
        actionId: 'set_topic_like',
        params: { topicId: '987654', liked: false },
      })
      await facade.setManagedAccountWritePreapproval({
        userId: activeUserId,
        targetId: activeAccount.id,
        enabled: false,
      })
      await assert.rejects(
        facade.executeConfirmedWrite({
          userId: activeUserId,
          targetId: activeAccount.id,
          confirmId: disableRaceProposal.confirmId,
        }),
        (error: unknown) => error instanceof ConnectorError && error.code === 'REVISION_MISMATCH',
      )
      const uncertainProposal = await facade.proposeWrite({
        userId: activeUserId,
        targetId: activeAccount.id,
        actionId: 'create_comment',
        params: { topicId: '987654', text: 'post-arm uncertainty probe' },
      })
      await approveConfirmation(uncertainProposal.confirmId, activeUserId, getPool())
      let dispatches = 0
      const failingFacade = new PluginRuntimeFacade({
        pool: getPool(),
        redis: transitionRedis,
        env: process.env,
        browserRuntime: {
          supportsContract: () => true,
          async runAction(input: { beforeDispatch: () => Promise<void> }) {
            await input.beforeDispatch()
            dispatches += 1
            throw new Error('ambiguous worker exit')
          },
        } as never,
      })
      const uncertain = await failingFacade.executeConfirmedWrite({
        userId: activeUserId,
        targetId: activeAccount.id,
        confirmId: uncertainProposal.confirmId,
      })
      assert.deepEqual(uncertain, {
        kind: 'replay',
        status: 'unknown',
        errorCode: 'INTERNAL',
        resultDigest: null,
      })
      const uncertainLedger = await getLedgerRow(
        uncertainProposal.confirmId,
        activeUserId,
        getPool(),
      )
      assert.equal(uncertainLedger?.status, 'unknown')
      assert.equal(uncertainLedger?.dispatch_fence_required, true)
      assert.ok(uncertainLedger?.dispatch_armed_at)
      assert.equal(uncertainLedger?.params_enc, null)
      assert.equal(uncertainLedger?.params_nonce, null)
      assert.deepEqual(
        await failingFacade.executeConfirmedWrite({
          userId: activeUserId,
          targetId: activeAccount.id,
          confirmId: uncertainProposal.confirmId,
        }),
        uncertain,
      )
      assert.equal(dispatches, 1, 'unknown replay must never dispatch or retry again')
      await facade.setManagedAccountWriteAccess({
        userId: activeUserId,
        targetId: activeAccount.id,
        enabled: false,
      })
      const orphanManagement = await facade.management(orphanUserId)
      assert.deepEqual(
        orphanManagement.accounts.map((account) => ({
          id: account.id,
          versionId: account.versionId,
          executable: account.executable,
        })),
        [{ id: orphanAccount.id, versionId: oldVersion.rows[0]!.id, executable: false }],
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
      assert.equal(
        (await listActiveInstalledArtifacts(Number(user.rows[0]!.id))).some(
          (item) => item.slug === 'zsxq-persistent-connector',
        ),
        false,
        '迁移后 Agent skill menu 不得继续下发旧自托管/写操作说明',
      )

      // Real release choreography: gate first, transaction rollback on an
      // injected mid-transition failure, concurrent invoke lease/install
      // mutation, downgrade, then upgrade back without reauthorization.
      await closeOfficialManagedBrowserPluginListingGate({
        slug: KNOWLEDGE_PLANET_PLUGIN_SLUG,
        env: process.env,
      })
      assert.equal(await findApprovedKnowledgePlanetPlugin(process.env), null)
      assert.equal(
        (await findApprovedKnowledgePlanetPluginForDeploy(process.env))?.versionId,
        seeded.versionId,
      )
      assert.deepEqual(await facade.catalog(activeUserId), [])
      assert.equal(await facade.classifyTarget(activeUserId, activeAccount.id), null)
      await assert.rejects(
        installApprovedVersion({ userId: softUserId, versionId: seeded.versionId }),
        (error: unknown) => error instanceof MarketplaceError && error.code === 'NOT_INSTALLABLE',
      )
      await assert.rejects(
        createManagedBrowserPluginAccount({
          userId: noAccountUserId,
          versionId: Number(seeded.versionId),
          storageState: storageState('blocked-setup'),
          env: process.env,
        }),
      )

      const livePool = getPool()
      const connectFailurePool = {
        query: livePool.query.bind(livePool),
        async connect() {
          throw new Error('injected pool connect failure')
        },
      } as unknown as ReturnType<typeof getPool>
      await assert.rejects(
        transitionOfficialManagedBrowserPluginVersion({
          slug: KNOWLEDGE_PLANET_PLUGIN_SLUG,
          targetVersionId: oldVersion.rows[0]!.id,
          expectedArtifactHash: oldCompiled.artifactHash,
          expectedExecContractHash: oldCompiled.execContractHash,
          ownerUserId: Number(admin.rows[0]!.id),
          env: process.env,
          pool: connectFailurePool,
          redis: transitionRedis,
          openListingAtCommit: false,
        }),
        /injected pool connect failure/,
      )
      for (const accountId of [activeAccount.id, errorAccount.id]) {
        const releasedLease = await acquirePluginAccountLease(transitionRedis, accountId, {
          hardTimeoutMs: 5_000,
          renewalIntervalMs: 1_000,
        })
        await releasedLease.release()
      }

      const beforeFailedTransition = await getPluginAccount(
        activeAccount.id,
        activeUserId,
        getPool(),
        { includeError: true },
      )
      assert.ok(beforeFailedTransition)
      await assert.rejects(
        transitionOfficialManagedBrowserPluginVersion({
          slug: KNOWLEDGE_PLANET_PLUGIN_SLUG,
          targetVersionId: oldVersion.rows[0]!.id,
          expectedArtifactHash: oldCompiled.artifactHash,
          expectedExecContractHash: oldCompiled.execContractHash,
          ownerUserId: Number(admin.rows[0]!.id),
          env: process.env,
          redis: transitionRedis,
          openListingAtCommit: false,
          failureInjector(point) {
            if (point === 'after-accounts') throw new Error('injected transition failure')
          },
        }),
        /injected transition failure/,
      )
      const afterFailedTransition = await getPluginAccount(
        activeAccount.id,
        activeUserId,
        getPool(),
        { includeError: true },
      )
      assert.deepEqual(afterFailedTransition, beforeFailedTransition)
      const failedPointer = await query<{ version_id: string; state: string }>(
        `SELECT current_approved_version_id::text AS version_id, state
           FROM marketplace_skill_listings WHERE slug = $1`,
        [KNOWLEDGE_PLANET_PLUGIN_SLUG],
      )
      assert.deepEqual(failedPointer.rows[0], { version_id: seeded.versionId, state: 'unlisted' })

      const heldInvocationLease = await acquirePluginAccountLease(
        transitionRedis,
        activeAccount.id,
        { hardTimeoutMs: 5_000, renewalIntervalMs: 1_000 },
      )
      const downgradePromise = transitionOfficialManagedBrowserPluginVersion({
        slug: KNOWLEDGE_PLANET_PLUGIN_SLUG,
        targetVersionId: oldVersion.rows[0]!.id,
        expectedArtifactHash: oldCompiled.artifactHash,
        expectedExecContractHash: oldCompiled.execContractHash,
        ownerUserId: Number(admin.rows[0]!.id),
        env: process.env,
        redis: transitionRedis,
        openListingAtCommit: false,
      })
      await new Promise((resolve) => setTimeout(resolve, 300))
      assert.equal(await recordUninstall(mutationUserId, KNOWLEDGE_PLANET_PLUGIN_SLUG), true)
      await heldInvocationLease.release()
      const downgraded = await downgradePromise
      assert.equal(downgraded.targetVersionId, oldVersion.rows[0]!.id)
      await openOfficialManagedBrowserPluginListingGate({
        slug: KNOWLEDGE_PLANET_PLUGIN_SLUG,
        expectedVersionId: oldVersion.rows[0]!.id,
        expectedArtifactHash: oldCompiled.artifactHash,
        expectedExecContractHash: oldCompiled.execContractHash,
        env: process.env,
      })
      assert.equal((await facade.catalog(activeUserId))[0]?.actions.length, 4)
      await installApprovedVersion({
        userId: mutationUserId,
        versionId: oldVersion.rows[0]!.id,
        agentIds: ['main', `user-${mutationUserId}`],
        scopeMode: 'replace',
      })

      await closeOfficialManagedBrowserPluginListingGate({
        slug: KNOWLEDGE_PLANET_PLUGIN_SLUG,
        env: process.env,
      })
      const upgradeScope = await readOfficialManagedBrowserTransitionCensus(
        KNOWLEDGE_PLANET_PLUGIN_SLUG,
      )
      let lockedCensusReachedResolve!: () => void
      const lockedCensusReached = new Promise<void>((resolve) => {
        lockedCensusReachedResolve = resolve
      })
      let releaseLockedCensusResolve!: () => void
      const holdLockedCensus = new Promise<void>((resolve) => {
        releaseLockedCensusResolve = resolve
      })
      const upgradedAgainPromise = transitionOfficialManagedBrowserPluginVersion({
        slug: KNOWLEDGE_PLANET_PLUGIN_SLUG,
        targetVersionId: seeded.versionId,
        expectedArtifactHash: COMPILED_KNOWLEDGE_PLANET_PLUGIN.artifactHash,
        expectedExecContractHash: COMPILED_KNOWLEDGE_PLANET_PLUGIN.execContractHash,
        ownerUserId: Number(admin.rows[0]!.id),
        env: process.env,
        redis: transitionRedis,
        openListingAtCommit: false,
        expectedScope: upgradeScope,
        failureInjector(point) {
          if (point !== 'after-locked-census') return
          lockedCensusReachedResolve()
          return holdLockedCensus
        },
      })
      let lockedCensusTimeout: NodeJS.Timeout | undefined
      try {
        await Promise.race([
          lockedCensusReached,
          new Promise<never>((_resolve, reject) => {
            lockedCensusTimeout = setTimeout(
              () => reject(new Error('transition did not reach locked census')),
              5_000,
            )
          }),
        ])
      } catch (error) {
        releaseLockedCensusResolve()
        throw error
      } finally {
        if (lockedCensusTimeout) clearTimeout(lockedCensusTimeout)
      }
      let concurrentInstallSettled = false
      const concurrentInstall = installApprovedVersion({
        userId: phantomUserId,
        versionId: oldVersion.rows[0]!.id,
      }).then(
        (value) => {
          concurrentInstallSettled = true
          return { ok: true as const, value }
        },
        (error: unknown) => {
          concurrentInstallSettled = true
          return { ok: false as const, error }
        },
      )
      await new Promise((resolve) => setTimeout(resolve, 150))
      assert.equal(
        concurrentInstallSettled,
        false,
        'new install must block behind transition locks',
      )
      releaseLockedCensusResolve()
      const upgradedAgain = await upgradedAgainPromise
      const concurrentInstallResult = await concurrentInstall
      assert.equal(concurrentInstallResult.ok, false)
      assert.ok(
        !concurrentInstallResult.ok &&
          concurrentInstallResult.error instanceof MarketplaceError &&
          concurrentInstallResult.error.code === 'NOT_INSTALLABLE',
      )
      assert.equal(
        (
          await query<{ count: string }>(
            `SELECT count(*)::text AS count FROM marketplace_installs
              WHERE user_id = $1 AND slug = $2 AND uninstalled_at IS NULL`,
            [phantomUserId, KNOWLEDGE_PLANET_PLUGIN_SLUG],
          )
        ).rows[0]?.count,
        '0',
      )
      assert.equal(upgradedAgain.targetVersionId, seeded.versionId)
      await openOfficialManagedBrowserPluginListingGate({
        slug: KNOWLEDGE_PLANET_PLUGIN_SLUG,
        expectedVersionId: seeded.versionId,
        expectedArtifactHash: COMPILED_KNOWLEDGE_PLANET_PLUGIN.artifactHash,
        expectedExecContractHash: COMPILED_KNOWLEDGE_PLANET_PLUGIN.execContractHash,
        env: process.env,
      })
      assert.equal(
        (await facade.catalog(activeUserId))[0]?.actions.length,
        KNOWLEDGE_PLANET_PLUGIN_ARTIFACT.actions.length,
      )
      const twiceMigratedActive = await getPluginAccount(
        activeAccount.id,
        activeUserId,
        getPool(),
        { includeError: true },
      )
      assert.ok(twiceMigratedActive)
      const twiceMigratedEnvelope = decryptPluginAccountEnvelope(
        twiceMigratedActive,
        newVerified.contract,
        process.env,
      )
      assert.equal(twiceMigratedEnvelope.accountInstanceId, oldActiveEnvelope.accountInstanceId)
      assert.deepEqual(twiceMigratedEnvelope.storageState, oldActiveEnvelope.storageState)

      await query(
        `UPDATE marketplace_skill_listings
            SET state = 'unlisted', revoked_reason = 'manual incident isolation'
          WHERE slug = $1`,
        [KNOWLEDGE_PLANET_PLUGIN_SLUG],
      )
      assert.equal(await findApprovedKnowledgePlanetPluginForDeploy(process.env), null)
      await assert.rejects(
        closeOfficialManagedBrowserPluginListingGate({
          slug: KNOWLEDGE_PLANET_PLUGIN_SLUG,
          env: process.env,
        }),
        /independently unlisted/,
      )
      await assert.rejects(
        openOfficialManagedBrowserPluginListingGate({
          slug: KNOWLEDGE_PLANET_PLUGIN_SLUG,
          expectedVersionId: seeded.versionId,
          expectedArtifactHash: COMPILED_KNOWLEDGE_PLANET_PLUGIN.artifactHash,
          expectedExecContractHash: COMPILED_KNOWLEDGE_PLANET_PLUGIN.execContractHash,
          env: process.env,
        }),
        /not closed by deploy/,
      )
      await query(
        `UPDATE marketplace_skill_listings
            SET state = 'active', revoked_reason = NULL
          WHERE slug = $1 AND state = 'unlisted'
            AND revoked_reason = 'manual incident isolation'`,
        [KNOWLEDGE_PLANET_PLUGIN_SLUG],
      )

      await query("UPDATE users SET status = 'banned' WHERE id = $1", [admin.rows[0]!.id])
      await query(
        `INSERT INTO users(email, password_hash, email_verified, role)
         VALUES ('knowledge-planet-next-admin@test.local', 'x', TRUE, 'admin')`,
      )
      await closeOfficialManagedBrowserPluginListingGate({
        slug: KNOWLEDGE_PLANET_PLUGIN_SLUG,
        env: process.env,
      })
      const repeated = await seedKnowledgePlanetPlugin({
        functionalVerified: true,
        env: process.env,
        leaseRedis: transitionRedis,
      })
      assert.equal(repeated.published, false)
      assert.equal(repeated.ownerUserId, Number(admin.rows[0]!.id))
      assert.equal(repeated.migratedUsers, 0)
      assert.equal(repeated.skippedExistingUsers, 2)
      assert.equal(repeated.retiredLegacyListing, false)

      assert.equal(
        await recordUninstall(Number(user.rows[0]!.id), KNOWLEDGE_PLANET_PLUGIN_SLUG),
        true,
      )
      await closeOfficialManagedBrowserPluginListingGate({
        slug: KNOWLEDGE_PLANET_PLUGIN_SLUG,
        env: process.env,
      })
      const afterUninstallSeed = await seedKnowledgePlanetPlugin({
        functionalVerified: true,
        env: process.env,
        leaseRedis: transitionRedis,
      })
      assert.equal(afterUninstallSeed.migratedUsers, 0)
      assert.equal(afterUninstallSeed.skippedExistingUsers, 2)
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
