/**
 * v5 连接器市场端到端数据契约（真 PostgreSQL）。
 *
 * 覆盖：用户发布、连接器专用原子审核、公开展示、精确版本安装、管理中心聚合、
 * 绑定阻止卸载、版本更新兼容旧 pin，以及 bind/uninstall/revoke 并发下的不变量。
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { after, before, beforeEach, describe, test } from 'node:test'

process.env.OPENCLAUDE_KMS_KEY = randomBytes(32).toString('base64')
process.env.OC_RUNTIME_CHANNEL = 'v5'

import { signAccess } from '../auth/jwt.js'
import { seedDefaultConnectors } from '../connectors/declarativeSeed.js'
import {
  insertDeclarativeConnection,
  revokeDeclarativeConnection,
} from '../connectors/engine/binding.js'
import { listDeclarativeCatalog, listDeclarativeManagement } from '../connectors/engine/catalog.js'
import {
  assertConnectorBindEntitlement,
  assertConnectorExecutionEntitlement,
} from '../connectors/entitlement.js'
import { ConnectorError } from '../connectors/errors.js'
import { compileSpec } from '../connectors/spec/compiler.js'
import { loadVerifiedContractWithMeta } from '../connectors/spec/review.js'
import { computeAccountKey } from '../connectors/store.js'
import { closePool, createPool, getPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'
import { HttpError } from '../http/util.js'
import { approveMarketplaceConnectorVersion } from '../marketplace/connectorReview.js'
import {
  MarketplaceError,
  getListingDetail,
  installApprovedVersion,
  listApprovedForSearch,
  listInstalled,
  listPendingVersions,
  recordUninstall,
  reviewVersion,
  revokeListing,
} from '../marketplace/marketplaceDb.js'
import { handleMarketplaceConnectorPublish } from '../marketplace/marketplaceRoutes.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'
const JWT_SECRET = 'connector-marketplace-integ-secret-0123456789abcdef'
const API_ORIGIN = 'https://api.connector-market.test:443'

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
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 12 }))
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
    // best-effort test cleanup
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
    [`connector-market-${seq}-${Date.now()}@t.local`, role],
  )
  return Number(r.rows[0]!.id)
}

function connectorSpec(slug: string, description = 'community connector'): Record<string, unknown> {
  return {
    id: slug,
    label: `Connector ${slug}`,
    description,
    authMode: 'static-token',
    auth: {
      apiCredentialPlacements: [{ source: 'access_token', placement: 'authorization-bearer' }],
    },
    originMode: 'fixed-reviewed',
    credentialPipeline: {
      nodes: [{ id: 'api-token', authMode: 'static-token', subject: 'user', audience: 'api' }],
    },
    actions: [
      {
        id: 'whoami',
        description: 'identity probe',
        request: { method: 'GET', pathTemplate: '/v1/me' },
        params: { type: 'object', additionalProperties: false },
        result: {
          type: 'object',
          additionalProperties: false,
          properties: { id: { type: 'string' }, name: { type: 'string' } },
        },
        usesSlot: 'api-token',
      },
      {
        id: 'list_items',
        description: 'list items',
        request: { method: 'GET', pathTemplate: '/v1/items' },
        params: { type: 'object', additionalProperties: false },
        result: { type: 'object', additionalProperties: false },
        usesSlot: 'api-token',
      },
    ],
    identity: {
      probeActionId: 'whoami',
      accountKeyPointer: '/id',
      accountHintPointer: '/name',
    },
  }
}

const securityDecision = {
  audience: {
    authorizationOrigins: [],
    tokenOrigins: [],
    apiOrigins: [API_ORIGIN],
    unauthenticatedUploadOrigins: [],
  },
  actions: {},
}

function makeRequest(body: unknown, bearer: string): IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')])
  Object.assign(req, {
    method: 'POST',
    url: '/api/marketplace/connector/publish',
    headers: { authorization: bearer, 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
  })
  return req as unknown as IncomingMessage
}

function makeResponse(): {
  res: ServerResponse
  output: { status: number; body: string }
} {
  const output = { status: 200, body: '' }
  const headers = new Map<string, string | number | readonly string[]>()
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string | number | readonly string[]) {
      headers.set(name.toLowerCase(), value)
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase())
    },
    end(chunk?: string | Buffer) {
      output.status = (this as { statusCode: number }).statusCode
      output.body = chunk == null ? '' : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
    },
  } as unknown as ServerResponse
  return { res, output }
}

async function publishViaRoute(args: {
  ownerUserId: number
  version: string
  spec: Record<string, unknown>
}): Promise<string> {
  const { token } = await signAccess({ sub: String(args.ownerUserId), role: 'user' }, JWT_SECRET)
  const { res, output } = makeResponse()
  await handleMarketplaceConnectorPublish(
    makeRequest(
      {
        version: args.version,
        spec: args.spec,
        securityDecision,
        tags: ['连接器', '测试'],
        category: 'daily-tools',
        useCases: ['连接外部服务并读取数据'],
        outcomeExamples: ['绑定账号后读取条目列表'],
        humanMd: '由社区发布，平台审核权限后可安装。',
      },
      `Bearer ${token}`,
    ),
    res,
    { jwtSecret: JWT_SECRET },
  )
  assert.equal(output.status, 200, output.body)
  const parsed = JSON.parse(output.body) as { versionId: string; status: string }
  assert.equal(parsed.status, 'pending')
  return parsed.versionId
}

async function approveConnector(args: {
  versionId: string
  reviewerUserId: number
  spec: Record<string, unknown>
}): Promise<void> {
  const compiled = compileSpec(args.spec, securityDecision)
  await approveMarketplaceConnectorVersion({
    versionId: args.versionId,
    reviewerUserId: args.reviewerUserId,
    securityDecision,
    expectedSpecHash: compiled.specHash,
    functionalVerified: true,
    note: '隔离账号验收通过',
    pool: getPool(),
  })
}

async function publishApproved(args: {
  ownerUserId: number
  reviewerUserId: number
  slug: string
  version?: string
  description?: string
}): Promise<{ versionId: string; spec: Record<string, unknown> }> {
  const spec = connectorSpec(args.slug, args.description)
  const versionId = await publishViaRoute({
    ownerUserId: args.ownerUserId,
    version: args.version ?? '1.0.0',
    spec,
  })
  await approveConnector({ versionId, reviewerUserId: args.reviewerUserId, spec })
  return { versionId, spec }
}

async function expectMarketplaceError(
  action: () => Promise<unknown>,
  code: MarketplaceError['code'],
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof MarketplaceError)
    assert.equal(error.code, code)
    return true
  })
}

async function expectConnectorError(
  action: () => Promise<unknown>,
  code: ConnectorError['code'],
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof ConnectorError)
    assert.equal(error.code, code)
    return true
  })
}

async function insertPinnedConnection(
  userId: number,
  versionId: string,
  suffix: string,
): Promise<string> {
  const meta = await loadVerifiedContractWithMeta(Number(versionId), getPool())
  const inserted = await insertDeclarativeConnection(
    {
      userId,
      slug: meta.slug,
      connectorVersionId: meta.versionId,
      specHashHex: meta.contract.spec_hash,
      execContractHashHex: meta.execContractHash,
      authContractVersion: meta.authContractVersion,
      accountKey: computeAccountKey(`${meta.slug}:account-${suffix}`),
      bag: { access_token: `token-${suffix}` },
      displayName: `account-${suffix}`,
    },
    getPool(),
  )
  return inserted.id
}

function startBarrier(): { wait: () => Promise<void>; release: () => void } {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return { wait: () => gate, release }
}

async function within<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`operation timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

describe('v5 connector marketplace', () => {
  test('平台默认连接器 slug 保留，用户不能抢占发布', async (t) => {
    if (skipIfNoDb(t)) return
    const owner = await createUser()
    const { token } = await signAccess({ sub: String(owner), role: 'user' }, JWT_SECRET)
    const { res } = makeResponse()
    await assert.rejects(
      handleMarketplaceConnectorPublish(
        makeRequest(
          {
            version: '1.0.0',
            spec: connectorSpec('notion'),
            securityDecision,
            category: 'daily-tools',
            useCases: ['尝试抢占平台默认连接器标识'],
          },
          `Bearer ${token}`,
        ),
        res,
        { jwtSecret: JWT_SECRET },
      ),
      (error: unknown) =>
        error instanceof HttpError && error.status === 403 && error.code === 'SLUG_OWNED_BY_OTHER',
    )
    const listing = await query('SELECT 1 FROM marketplace_skill_listings WHERE slug = $1', [
      'notion',
    ])
    assert.equal(listing.rowCount, 0)
  })

  test('发布→专审→公开展示→安装→管理→解绑后卸载', async (t) => {
    if (skipIfNoDb(t)) return
    const owner = await createUser()
    const reviewer = await createUser('admin')
    const user = await createUser()
    const slug = `community-${Date.now() % 1_000_000}`
    const spec = connectorSpec(slug)
    const versionId = await publishViaRoute({ ownerUserId: owner, version: '1.0.0', spec })

    const pending = (await listPendingVersions()).find((row) => row.versionId === versionId)
    assert.ok(pending)
    assert.equal(pending.kind, 'connector')
    assert.deepEqual(pending.manifest, {
      connector: true,
      proposedSecurityDecision: securityDecision,
    })
    assert.equal(pending.artifactHash, compileSpec(spec, securityDecision).specHash)
    const queued = await query<{ ai_review_state: string | null }>(
      'SELECT ai_review_state FROM marketplace_skill_versions WHERE id = $1',
      [versionId],
    )
    assert.equal(queued.rows[0]!.ai_review_state, null, '连接器不得进入通用 AI 自动审批')

    await expectMarketplaceError(
      () => reviewVersion({ versionId, reviewerUserId: reviewer, approve: true }),
      'KIND_MISMATCH',
    )
    await approveConnector({ versionId, reviewerUserId: reviewer, spec })

    const state = await query<{
      status: string
      security_review_state: string
      functional_verify_state: string
      exec_revoked_at: Date | null
      has_signature: boolean
      listing_state: string
      current_id: string | null
    }>(
      `SELECT v.status, v.security_review_state, v.functional_verify_state, v.exec_revoked_at,
              (v.signature IS NOT NULL) AS has_signature, l.state AS listing_state,
              l.current_approved_version_id::text AS current_id
         FROM marketplace_skill_versions v
         JOIN marketplace_skill_listings l ON l.slug = v.slug
        WHERE v.id = $1`,
      [versionId],
    )
    assert.deepEqual(state.rows[0], {
      status: 'approved',
      security_review_state: 'security_approved',
      functional_verify_state: 'verified',
      exec_revoked_at: null,
      has_signature: true,
      listing_state: 'active',
      current_id: versionId,
    })

    assert.equal(
      (await listApprovedForSearch('connector')).some((row) => row.slug === slug),
      true,
    )
    const detail = await getListingDetail(slug)
    assert.ok(detail)
    assert.equal(detail.kind, 'connector')
    assert.equal(detail.official, false)
    assert.equal(detail.manifest, null, '公开详情不得暴露发布者提议的安全决定')
    assert.deepEqual(detail.connectorContract, {
      authMode: 'static-token',
      approvedOrigins: [API_ORIGIN],
      actions: [
        { id: 'whoami', effect: 'read' },
        { id: 'list_items', effect: 'read' },
      ],
    })

    assert.equal(
      (await listDeclarativeCatalog(getPool(), user)).some((row) => row.slug === slug),
      false,
    )
    await installApprovedVersion({ userId: user, versionId })
    assert.equal(
      (await listInstalled(user)).some((row) => row.slug === slug),
      true,
    )
    assert.equal(
      (await listDeclarativeCatalog(getPool(), user)).some((row) => row.slug === slug),
      true,
    )

    await seedDefaultConnectors(getPool())
    const management = await listDeclarativeManagement(getPool(), user)
    const community = management.connectors.find((row) => row.slug === slug)
    assert.ok(community)
    assert.equal(community.installation, 'marketplace')
    assert.equal(community.canBind, true)
    const notion = management.connectors.find((row) => row.slug === 'notion')
    assert.ok(notion)
    assert.equal(notion.installation, 'default')
    assert.equal(notion.official, true)
    const notionVersion = await query<{ id: string }>(
      `SELECT current_approved_version_id::text AS id
         FROM marketplace_skill_listings WHERE slug = 'notion'`,
    )
    await expectMarketplaceError(
      () => installApprovedVersion({ userId: user, versionId: notionVersion.rows[0]!.id }),
      'NOT_INSTALLABLE',
    )

    const connectionId = await insertPinnedConnection(user, versionId, 'guard')
    await expectMarketplaceError(() => recordUninstall(user, slug), 'INSTALL_CONFLICT')
    assert.equal(await revokeDeclarativeConnection(connectionId, user, getPool()), true)
    assert.equal(await recordUninstall(user, slug), true)
    assert.equal(
      (await listInstalled(user)).some((row) => row.slug === slug),
      false,
    )
  })

  test('更新只允许绑定当前精确安装版本，旧连接 pin 在 listing 活跃时仍可执行', async (t) => {
    if (skipIfNoDb(t)) return
    const owner = await createUser()
    const reviewer = await createUser('admin')
    const user = await createUser()
    const slug = `upgrade-${Date.now() % 1_000_000}`
    const v1 = await publishApproved({ ownerUserId: owner, reviewerUserId: reviewer, slug })
    await installApprovedVersion({ userId: user, versionId: v1.versionId })
    await insertPinnedConnection(user, v1.versionId, 'v1')

    const v2 = await publishApproved({
      ownerUserId: owner,
      reviewerUserId: reviewer,
      slug,
      version: '2.0.0',
      description: 'community connector v2',
    })
    const managementBefore = await listDeclarativeManagement(getPool(), user)
    const rowBefore = managementBefore.connectors.find((row) => row.slug === slug)
    assert.ok(rowBefore)
    assert.equal(rowBefore.updateAvailable, true)
    assert.equal(rowBefore.canBind, false)

    await assertConnectorExecutionEntitlement(user, slug, v1.versionId, getPool())
    await expectConnectorError(
      () => assertConnectorBindEntitlement(user, v1.versionId, getPool()),
      'RELINK_REQUIRED',
    )
    await expectConnectorError(
      () => assertConnectorBindEntitlement(user, v2.versionId, getPool()),
      'CONNECTOR_NOT_INSTALLED',
    )

    await installApprovedVersion({ userId: user, versionId: v2.versionId })
    await assertConnectorBindEntitlement(user, v2.versionId, getPool())
    await assertConnectorExecutionEntitlement(user, slug, v1.versionId, getPool())
    const managementAfter = await listDeclarativeManagement(getPool(), user)
    const rowAfter = managementAfter.connectors.find((row) => row.slug === slug)
    assert.ok(rowAfter)
    assert.equal(rowAfter.updateAvailable, false)
    assert.equal(rowAfter.canBind, true)
    assert.equal(rowAfter.installedVersion, '2.0.0')
  })

  test('并发 bind/uninstall 串行化，不会产生“有连接但未安装”状态', async (t) => {
    if (skipIfNoDb(t)) return
    const owner = await createUser()
    const reviewer = await createUser('admin')
    const user = await createUser()
    const slug = `race-uninstall-${Date.now() % 1_000_000}`
    const { versionId } = await publishApproved({
      ownerUserId: owner,
      reviewerUserId: reviewer,
      slug,
    })
    await installApprovedVersion({ userId: user, versionId })

    const barrier = startBarrier()
    const bind = (async () => {
      await barrier.wait()
      return insertPinnedConnection(user, versionId, 'race-uninstall')
    })()
    const uninstall = (async () => {
      await barrier.wait()
      return recordUninstall(user, slug)
    })()
    barrier.release()
    const [bindResult, uninstallResult] = await within(Promise.allSettled([bind, uninstall]))

    assert.notEqual(bindResult.status, uninstallResult.status, '固定锁域下应恰有一个操作成功')
    const counts = await query<{ installs: string; bindings: string }>(
      `SELECT
         (SELECT count(*) FROM marketplace_installs
           WHERE user_id = $1 AND slug = $2 AND uninstalled_at IS NULL)::text AS installs,
         (SELECT count(*) FROM connections
           WHERE user_id = $1 AND provider = $2 AND revoked_at IS NULL)::text AS bindings`,
      [user, slug],
    )
    const installs = Number(counts.rows[0]!.installs)
    const bindings = Number(counts.rows[0]!.bindings)
    assert.ok(bindings === 0 || installs === 1)
    assert.deepEqual([installs, bindings], bindResult.status === 'fulfilled' ? [1, 1] : [0, 0])
  })

  test('并发 bind/revoke 无死锁，revoke 后任何已落连接都不可执行', async (t) => {
    if (skipIfNoDb(t)) return
    const owner = await createUser()
    const reviewer = await createUser('admin')
    const user = await createUser()
    const slug = `race-revoke-${Date.now() % 1_000_000}`
    const { versionId } = await publishApproved({
      ownerUserId: owner,
      reviewerUserId: reviewer,
      slug,
    })
    await installApprovedVersion({ userId: user, versionId })

    const barrier = startBarrier()
    const bind = (async () => {
      await barrier.wait()
      return insertPinnedConnection(user, versionId, 'race-revoke')
    })()
    const revoke = (async () => {
      await barrier.wait()
      return revokeListing(slug, 'security incident')
    })()
    barrier.release()
    const [bindResult, revokeResult] = await within(Promise.allSettled([bind, revoke]))
    assert.equal(revokeResult.status, 'fulfilled')

    const state = await query<{ listing_state: string; exec_revoked_at: Date | null }>(
      `SELECT l.state AS listing_state, v.exec_revoked_at
         FROM marketplace_skill_listings l
         JOIN marketplace_skill_versions v ON v.slug = l.slug
        WHERE v.id = $1`,
      [versionId],
    )
    assert.equal(state.rows[0]!.listing_state, 'revoked')
    assert.ok(state.rows[0]!.exec_revoked_at)
    await expectConnectorError(
      () => assertConnectorExecutionEntitlement(user, slug, versionId, getPool()),
      'RELINK_REQUIRED',
    )
    if (bindResult.status === 'fulfilled') {
      const active = await query('SELECT 1 FROM connections WHERE id = $1 AND revoked_at IS NULL', [
        bindResult.value,
      ])
      assert.equal(active.rowCount, 1, '先完成的绑定可留审计行，但授权闸已拒绝执行')
    }
  })

  test('非 v5 渠道关闭连接器发布入口', async (t) => {
    if (skipIfNoDb(t)) return
    const owner = await createUser()
    const { token } = await signAccess({ sub: String(owner), role: 'user' }, JWT_SECRET)
    const previous = process.env.OC_RUNTIME_CHANNEL
    process.env.OC_RUNTIME_CHANNEL = 'v3'
    try {
      const { res } = makeResponse()
      await assert.rejects(
        handleMarketplaceConnectorPublish(
          makeRequest(
            {
              version: '1.0.0',
              spec: connectorSpec('v3-hidden'),
              securityDecision,
              category: 'daily-tools',
              useCases: ['测试渠道隔离规则'],
            },
            `Bearer ${token}`,
          ),
          res,
          { jwtSecret: JWT_SECRET },
        ),
        (error: unknown) => error instanceof HttpError && error.status === 404,
      )
    } finally {
      process.env.OC_RUNTIME_CHANNEL = previous
    }
  })
})
