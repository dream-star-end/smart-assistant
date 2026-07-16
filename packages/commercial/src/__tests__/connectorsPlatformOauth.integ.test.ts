/**
 * 平台 OAuth App 存储与官方身份边界（真 PostgreSQL）。
 *
 * 社区 OAuth2 连接器只能 BYOA。`clientProvisioning='platform'` 仅保留给代码内置的
 * 精确默认工件；本文件验证低层密钥存储仍安全，以及专用审核、载入、目录、安装、
 * entitlement 都不能被“遗留签名行 + 任意 provisioning 行”绕过。
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, beforeEach, describe, test } from 'node:test'

process.env.OPENCLAUDE_KMS_KEY = randomBytes(32).toString('base64')
process.env.OC_RUNTIME_CHANNEL = 'v5'

import { listDeclarativeCatalog, listDeclarativeManagement } from '../connectors/engine/catalog.js'
import { assertConnectorBindEntitlement } from '../connectors/entitlement.js'
import { ConnectorError } from '../connectors/errors.js'
import {
  deletePlatformOauthApp,
  getPlatformOauthApp,
  hasPlatformOauthApp,
  listPlatformOauthApps,
  upsertPlatformOauthApp,
} from '../connectors/platformOauthApps.js'
import { canonicalSha256Hex } from '../connectors/spec/canonical.js'
import {
  loadVerifiedContractWithMeta,
  markFunctionalVerified,
  securityApprove,
} from '../connectors/spec/review.js'
import { ConnectorSpecError } from '../connectors/spec/types.js'
import { closePool, createPool, getPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'
import { approveMarketplaceConnectorVersion } from '../marketplace/connectorReview.js'
import {
  MarketplaceError,
  getListingDetail,
  installApprovedVersion,
  listApprovedForSearch,
  publishSkillVersion,
} from '../marketplace/marketplaceDb.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'
const PLATFORM_CLIENT_SECRET = 'PS-CANARY-4c9e12b7-DO-NOT-LEAK-ffeeddccbbaa9988'
const PLATFORM_CLIENT_ID = 'platform-cid-xyz789'
const AUTHZ_ORIGIN = 'https://auth.platoauth.test:443'
const TOKEN_ORIGIN = 'https://token.platoauth.test:443'
const API_ORIGIN = 'https://api.platoauth.test:443'

let pgAvailable = false
let seq = 0

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
  await query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
}

before(async () => {
  pgAvailable = await probePg()
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error('Postgres test fixture required')
    return
  }
  await resetPool()
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 8 }))
  await resetSchema()
  await runMigrations()
})

beforeEach(async () => {
  if (!pgAvailable) return
  await query(
    `TRUNCATE TABLE connector_platform_oauth_apps, connections, marketplace_installs,
       marketplace_skill_versions, marketplace_skill_listings, users
       RESTART IDENTITY CASCADE`,
  )
})

after(async () => {
  if (!pgAvailable) return
  try {
    await resetSchema()
  } catch {
    // best effort
  }
  await closePool()
})

function skipIfNoDb(t: { skip: (reason: string) => void }): boolean {
  if (pgAvailable) return false
  t.skip('pg not available')
  return true
}

async function createUser(role: 'user' | 'admin' = 'user'): Promise<number> {
  seq += 1
  const r = await query<{ id: string }>(
    `INSERT INTO users(email, password_hash, email_verified, role)
     VALUES ($1, 'x', TRUE, $2) RETURNING id::text AS id`,
    [`platform-boundary-${seq}-${Date.now()}@t.local`, role],
  )
  return Number(r.rows[0]!.id)
}

function platformOauthSpec(slug: string): Record<string, unknown> {
  return {
    id: slug,
    label: `Platform OAuth ${slug}`,
    description: 'community connector requesting a platform-managed OAuth app',
    authMode: 'oauth2-auth-code',
    auth: {
      authorizeEndpoint: `${AUTHZ_ORIGIN}/oauth/authorize`,
      tokenEndpoint: `${TOKEN_ORIGIN}/oauth/token`,
      clientProvisioning: 'platform',
      clientAuth: 'form',
      scopeSeparator: ' ',
      scopes: ['read:user'],
      refreshRotation: false,
      refreshEncoding: 'form',
      pkce: 'required',
      tokenOutputs: {
        accessToken: '/access_token',
        refreshToken: '/refresh_token',
        expiresIn: '/expires_in',
      },
      apiCredentialPlacements: [{ source: 'access_token', placement: 'authorization-bearer' }],
    },
    originMode: 'fixed-reviewed',
    credentialPipeline: {
      nodes: [{ id: 'api-token', authMode: 'oauth2-auth-code', subject: 'user', audience: 'api' }],
    },
    actions: [
      {
        id: 'whoami',
        description: 'identity probe',
        request: { method: 'GET', pathTemplate: '/user' },
        params: { type: 'object', additionalProperties: false },
        result: {
          type: 'object',
          additionalProperties: false,
          properties: { id: { type: 'string' }, login: { type: 'string' } },
        },
        usesSlot: 'api-token',
      },
    ],
    identity: { probeActionId: 'whoami', accountKeyPointer: '/id', accountHintPointer: '/login' },
  }
}

const platformDecision = {
  audience: {
    authorizationOrigins: [AUTHZ_ORIGIN],
    tokenOrigins: [TOKEN_ORIGIN],
    apiOrigins: [API_ORIGIN],
    unauthenticatedUploadOrigins: [],
  },
  actions: {},
}

async function publishPlatformConnector(slug: string): Promise<{
  versionId: string
  owner: number
  reviewer: number
  specHash: string
}> {
  const owner = await createUser()
  const reviewer = await createUser('admin')
  const spec = platformOauthSpec(slug)
  const specHash = canonicalSha256Hex(spec)
  const published = await publishSkillVersion({
    slug,
    ownerUserId: owner,
    version: '1.0.0',
    name: String(spec.label),
    description: String(spec.description),
    tags: ['连接器', 'OAuth'],
    rawSkillMd: null,
    rawArtifact: JSON.stringify(spec),
    manifest: { connector: true, proposedSecurityDecision: platformDecision },
    artifactHash: specHash,
    embeddingHash: specHash,
    riskFlags: [],
    policyVersion: 1,
    submittedBy: owner,
    kind: 'connector',
    pluginType: 'declarative-http',
    queueAiReview: false,
  })
  return { versionId: published.versionId, owner, reviewer, specHash }
}

describe('platformOauthApps · 低层存储', () => {
  test('加解密 roundtrip、密文不含 secret、列表不投影 secret、删除幂等', async (t) => {
    if (skipIfNoDb(t)) return
    const admin = await createUser('admin')
    const slug = `store-app-${Date.now() % 1_000_000}`

    assert.equal(await hasPlatformOauthApp(slug), false)
    await upsertPlatformOauthApp(
      {
        slug,
        clientId: PLATFORM_CLIENT_ID,
        clientSecret: PLATFORM_CLIENT_SECRET,
        updatedBy: admin,
      },
      getPool(),
    )
    assert.deepEqual(await getPlatformOauthApp(slug), {
      clientId: PLATFORM_CLIENT_ID,
      clientSecret: PLATFORM_CLIENT_SECRET,
    })

    const row = await query<{ client_secret_enc: Buffer; client_secret_nonce: Buffer }>(
      `SELECT client_secret_enc, client_secret_nonce
         FROM connector_platform_oauth_apps WHERE slug = $1`,
      [slug],
    )
    assert.equal(
      row.rows[0]!.client_secret_enc.toString('latin1').includes(PLATFORM_CLIENT_SECRET),
      false,
    )
    assert.equal(row.rows[0]!.client_secret_nonce.length, 12)
    const summary = (await listPlatformOauthApps()).find((item) => item.slug === slug)
    assert.ok(summary)
    assert.deepEqual(Object.keys(summary).sort(), ['clientId', 'slug', 'updatedAt'])
    assert.equal(JSON.stringify(summary).includes(PLATFORM_CLIENT_SECRET), false)

    assert.equal(await deletePlatformOauthApp(slug), true)
    assert.equal(await deletePlatformOauthApp(slug), false)
  })

  test('AAD 绑定 slug，跨行移植密文后解密失败', async (t) => {
    if (skipIfNoDb(t)) return
    const a = `aad-a-${Date.now() % 1_000_000}`
    const b = `aad-b-${Date.now() % 1_000_000}`
    await upsertPlatformOauthApp({ slug: a, clientId: 'cid-a', clientSecret: 'secret-a' })
    await upsertPlatformOauthApp({ slug: b, clientId: 'cid-b', clientSecret: 'secret-b' })
    await query(
      `UPDATE connector_platform_oauth_apps SET
         client_secret_enc = src.client_secret_enc,
         client_secret_nonce = src.client_secret_nonce,
         aad_seed = src.aad_seed
       FROM (SELECT client_secret_enc, client_secret_nonce, aad_seed
               FROM connector_platform_oauth_apps WHERE slug = $1) src
       WHERE connector_platform_oauth_apps.slug = $2`,
      [a, b],
    )
    await assert.rejects(getPlatformOauthApp(b), (error: unknown) => error instanceof Error)
  })
})

describe('platform OAuth · 仅精确官方工件', () => {
  test('社区 connector 的专用审核原子回滚，不产生签名或 approved 状态', async (t) => {
    if (skipIfNoDb(t)) return
    const slug = `community-platform-${Date.now() % 1_000_000}`
    const published = await publishPlatformConnector(slug)

    await assert.rejects(
      approveMarketplaceConnectorVersion({
        versionId: published.versionId,
        reviewerUserId: published.reviewer,
        securityDecision: platformDecision,
        expectedSpecHash: published.specHash,
        functionalVerified: true,
        pool: getPool(),
      }),
      (error: unknown) =>
        error instanceof ConnectorSpecError && error.code === 'PLATFORM_OAUTH_FORBIDDEN',
    )
    const state = await query<{
      status: string
      security_review_state: string
      signature: Buffer | null
      current_id: string | null
    }>(
      `SELECT v.status, v.security_review_state, v.signature,
              l.current_approved_version_id::text AS current_id
         FROM marketplace_skill_versions v
         JOIN marketplace_skill_listings l ON l.slug = v.slug
        WHERE v.id = $1`,
      [published.versionId],
    )
    assert.deepEqual(state.rows[0], {
      status: 'pending',
      security_review_state: 'draft',
      signature: null,
      current_id: null,
    })
  })

  test('遗留签名行即使有 platform 凭据与安装，也不能展示、安装或绑定', async (t) => {
    if (skipIfNoDb(t)) return
    const slug = `legacy-platform-${Date.now() % 1_000_000}`
    const published = await publishPlatformConnector(slug)
    const existingUser = await createUser()
    const newUser = await createUser()

    // 模拟旧版本曾绕过市场专审：低层安全内核签名 + 功能标记 + 手工市场指针。
    await securityApprove({
      versionId: Number(published.versionId),
      reviewerUserId: published.reviewer,
      securityDecision: platformDecision,
      expectedSpecHash: published.specHash,
      pool: getPool(),
    })
    await markFunctionalVerified(Number(published.versionId), published.reviewer, getPool())
    await query(
      `UPDATE marketplace_skill_versions SET status = 'approved', reviewed_by = $2,
              reviewed_at = NOW() WHERE id = $1`,
      [published.versionId, published.reviewer],
    )
    await query(
      `UPDATE marketplace_skill_listings SET state = 'active',
              current_approved_version_id = $2 WHERE slug = $1`,
      [slug, published.versionId],
    )
    await upsertPlatformOauthApp({
      slug,
      clientId: PLATFORM_CLIENT_ID,
      clientSecret: PLATFORM_CLIENT_SECRET,
    })
    await query(
      `INSERT INTO marketplace_installs
         (user_id, slug, version_id, artifact_hash, installed_by, agent_ids)
       VALUES ($1, $2, $3, $4, $1, '["main"]'::jsonb)`,
      [existingUser, slug, published.versionId, published.specHash],
    )

    await assert.rejects(
      loadVerifiedContractWithMeta(Number(published.versionId), getPool()),
      (error: unknown) =>
        error instanceof ConnectorSpecError && error.code === 'PLATFORM_OAUTH_FORBIDDEN',
    )
    assert.equal(
      (await listApprovedForSearch('connector')).some((row) => row.slug === slug),
      false,
    )
    assert.equal(await getListingDetail(slug), null)
    await assert.rejects(
      installApprovedVersion({ userId: newUser, versionId: published.versionId }),
      (error: unknown) => error instanceof MarketplaceError && error.code === 'NOT_INSTALLABLE',
    )
    assert.equal(
      (await listDeclarativeCatalog(getPool(), existingUser)).some((row) => row.slug === slug),
      false,
    )
    const managed = (await listDeclarativeManagement(getPool(), existingUser)).connectors.find(
      (row) => row.slug === slug,
    )
    assert.ok(managed)
    assert.equal(managed.available, false)
    assert.equal(managed.canBind, false)
    await assert.rejects(
      assertConnectorBindEntitlement(existingUser, published.versionId, getPool()),
      (error: unknown) => error instanceof ConnectorError && error.code === 'RELINK_REQUIRED',
    )
  })
})
