/**
 * OCV5-402 · 官方市场连接器 `bili` 端到端(真 PG + 受控上游,不出网)。
 *
 *   seedOfficialMarketConnector(实测 → pending 1.0.0 → 连接器审核签名上架)→ 幂等 noop
 *   → 只上市场不预装(未安装用户的目录里没有它)→ 安装 → 免填绑定(公开接口)→ 执行读动作;
 *   以及:非官方工件即便走同一审核事务,用 authMode none / builtin 也签不出契约(BUILTIN_PLATFORM_ONLY)。
 */

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, beforeEach, describe, test } from 'node:test'
import { fetch as undiciFetch } from 'undici'

process.env.OPENCLAUDE_KMS_KEY = randomBytes(32).toString('base64')
process.env.OC_RUNTIME_CHANNEL = 'v5'

import { __resetBilibiliWbiCacheForTests } from '../connectors/builtins/runtime.js'
import { ensureConnectorSeedPrincipals } from '../connectors/declarativeSeed.js'
import { bindDeclarativeConnector } from '../connectors/engine/bind.js'
import { listDeclarativeCatalog } from '../connectors/engine/catalog.js'
import type { EngineHttpDeps } from '../connectors/engine/driver.js'
import { executeDeclarativeAction } from '../connectors/engine/execute.js'
import { biliConnectorDecision, biliConnectorSpec } from '../connectors/official/bili.js'
import type { DnsResolver } from '../connectors/outboundPolicy.js'
import { canonicalBytes, canonicalSha256Hex } from '../connectors/spec/canonical.js'
import { ConnectorSpecError } from '../connectors/spec/types.js'
import { closePool, createPool, getPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query, tx } from '../db/queries.js'
import { approveMarketplaceConnectorVersionWithRunner } from '../marketplace/connectorReview.js'
import {
  MarketplaceError,
  installApprovedVersion,
  publishOfficialMarketConnectorVersion,
  publishSkillVersion,
} from '../marketplace/marketplaceDb.js'
import { seedOfficialMarketConnector } from '../marketplace/seedOfficialConnectors.js'
import { resetTestSchemaForTest } from './helpers/db.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'

let pgAvailable = false

// ─── 受控上游(只回放 B 站接口的形状) ─────────────────────────────────────────

const NAV = JSON.stringify({
  code: -101,
  data: {
    wbi_img: {
      img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
      sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
    },
  },
})
const SPI = JSON.stringify({ code: 0, data: { b_3: 'TEST-BUVID3-0000infoc', b_4: 'TEST-BUVID4' } })
const ARCHIVE = {
  aid: 170001,
  bvid: 'BV17x411w7KC',
  title: '测试视频',
  owner: { mid: 1, name: 'UP' },
  stat: { view: 10, danmaku: 2 },
}

function upstream(path: string): { status: number; body: string | Buffer; type?: string } {
  switch (path) {
    case '/x/web-interface/nav':
      return { status: 200, body: NAV }
    case '/x/frontend/finger/spi':
      return { status: 200, body: SPI }
    case '/x/web-interface/popular':
      return { status: 200, body: JSON.stringify({ code: 0, data: { list: [ARCHIVE] } }) }
    case '/x/web-interface/ranking':
      return { status: 200, body: JSON.stringify({ code: 0, data: { list: [ARCHIVE] } }) }
    case '/x/web-interface/wbi/search/type':
      return {
        status: 200,
        body: JSON.stringify({ code: 0, data: { result: [{ bvid: ARCHIVE.bvid, title: 't' }] } }),
      }
    case '/x/web-interface/wbi/view':
      return {
        status: 200,
        body: JSON.stringify({
          code: 0,
          data: { ...ARCHIVE, cid: 279786, pages: [{ cid: 279786, page: 1, part: 'P1' }] },
        }),
      }
    case '/x/v2/reply/wbi/main':
      return { status: 200, body: JSON.stringify({ code: 0, data: { replies: [] } }) }
    case '/x/v1/dm/list.so':
      return {
        status: 200,
        type: 'text/xml',
        body: '<i><chatid>279786</chatid><d p="1.5,1,25,1,1700000000">hi</d></i>',
      }
    default:
      return { status: 404, body: '{}' }
  }
}

let server: Server
let port = 0
const hits: string[] = []

function deps(): EngineHttpDeps {
  const resolver: DnsResolver = {
    resolve4: async () => ['93.184.216.34'],
    resolve6: async () => {
      const e = new Error('nodata') as NodeJS.ErrnoException
      e.code = 'ENODATA'
      throw e
    },
  }
  return {
    resolver,
    fetchImpl: async (input, init) => {
      const u = new URL(input)
      u.protocol = 'http:'
      u.hostname = '127.0.0.1'
      u.port = String(port)
      return undiciFetch(u.toString(), {
        method: init.method as string,
        headers: init.headers as Record<string, string> | undefined,
        redirect: 'error',
        signal: init.signal as AbortSignal | undefined,
      }) as unknown as Promise<Response>
    },
  }
}

async function mkUser(): Promise<number> {
  const r = await query<{ id: string }>(
    `INSERT INTO users(email, password_hash, email_verified, role)
     VALUES ($1,'x',TRUE,'user') RETURNING id::text AS id`,
    [`bili-u-${Date.now()}-${Math.floor(Math.random() * 1e6)}@t.local`],
  )
  return Number(r.rows[0]!.id)
}

before(async () => {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 })
  try {
    await p.query('SELECT 1')
    pgAvailable = true
  } catch {
    pgAvailable = false
  }
  await p.end().catch(() => {})
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error('Postgres test fixture required')
    return
  }
  await resetPool()
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 10 }))
  await resetTestSchemaForTest()
  await runMigrations()
  await new Promise<void>((resolve) => {
    server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1')
      hits.push(u.pathname)
      const out = upstream(u.pathname)
      res.statusCode = out.status
      res.setHeader('content-type', out.type ?? 'application/json')
      res.end(out.body)
    })
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port
      resolve()
    })
  })
})

after(async () => {
  if (!pgAvailable) return
  await new Promise<void>((r) => server.close(() => r()))
  try {
    await resetTestSchemaForTest()
  } catch {
    /* */
  }
  await closePool()
})

beforeEach(() => {
  __resetBilibiliWbiCacheForTests()
})

function skip(t: { skip: (r: string) => void }): boolean {
  if (!pgAvailable) {
    t.skip('pg not available')
    return true
  }
  return false
}

describe('official market connector bili', () => {
  test('seed:实测全部动作 → 1.0.0 经连接器审核上架;再次执行是 noop', async (t) => {
    if (skip(t)) return
    hits.length = 0
    const first = await seedOfficialMarketConnector({ slug: 'bili', deps: deps() })
    assert.equal(first.outcome, 'published')
    assert.equal(first.version, '1.0.0')
    assert.deepEqual(first.live.map((c) => c.action).sort(), [
      'comments',
      'danmaku',
      'popular',
      'rank',
      'search',
      'video',
    ])
    assert.ok(first.live.every((c) => c.ok))
    // 实测真的打到了每个接口(含签名所需的 nav / spi)。
    for (const p of [
      '/x/web-interface/nav',
      '/x/frontend/finger/spi',
      '/x/web-interface/wbi/search/type',
      '/x/web-interface/wbi/view',
      '/x/v2/reply/wbi/main',
      '/x/v1/dm/list.so',
    ])
      assert.ok(hits.includes(p), `live verification hit ${p}`)

    const row = await query<{
      version: string
      status: string
      security_review_state: string
      functional_verify_state: string
      plugin_type: string
      state: string
      current: string
      id: string
      ai_review_state: string | null
    }>(
      `SELECT v.id::text, v.version, v.status, v.security_review_state, v.functional_verify_state,
              v.ai_review_state, l.plugin_type, l.state, l.current_approved_version_id::text AS current
         FROM marketplace_skill_versions v JOIN marketplace_skill_listings l ON l.slug = v.slug
        WHERE v.slug = 'bili'`,
    )
    assert.equal(row.rows.length, 1)
    const r = row.rows[0]!
    assert.equal(r.version, '1.0.0')
    assert.equal(r.status, 'approved')
    assert.equal(r.security_review_state, 'security_approved')
    assert.equal(r.functional_verify_state, 'verified')
    assert.equal(r.plugin_type, 'declarative-http')
    assert.equal(r.state, 'active')
    assert.equal(r.current, r.id)
    assert.equal(r.ai_review_state, null)

    const again = await seedOfficialMarketConnector({ slug: 'bili', deps: deps() })
    assert.equal(again.outcome, 'noop')
    assert.equal(again.versionId, r.id)
  })

  test('只上市场不预装:未安装看不到;安装后免填绑定、可执行', async (t) => {
    if (skip(t)) return
    const user = await mkUser()
    const before = await listDeclarativeCatalog(getPool(), user)
    assert.equal(
      before.some((c) => c.slug === 'bili'),
      false,
    )

    const v = await query<{ id: string }>(
      `SELECT id::text FROM marketplace_skill_versions WHERE slug='bili' AND version='1.0.0'`,
    )
    const versionId = v.rows[0]!.id
    await installApprovedVersion({ userId: user, versionId })
    const afterInstall = await listDeclarativeCatalog(getPool(), user)
    const entry = afterInstall.find((c) => c.slug === 'bili')
    assert.ok(entry)
    assert.equal(entry.authMode, 'none')
    assert.deepEqual(entry.requiredBindSources, [])

    const bound = await bindDeclarativeConnector(
      { userId: user, connectorVersionId: Number(versionId), secrets: {}, deps: deps() },
      getPool(),
    )
    assert.equal(bound.accountHint, '公开接口')
    const rebound = await bindDeclarativeConnector(
      { userId: user, connectorVersionId: Number(versionId), secrets: {}, deps: deps() },
      getPool(),
    )
    // 再次启用 = 撤销旧行换新行(同一 account_key),任何时候只有一条活跃连接。
    assert.equal(rebound.rebound, true)
    const active = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM connections
        WHERE user_id = $1 AND provider = 'bili' AND revoked_at IS NULL`,
      [user],
    )
    assert.equal(active.rows[0]!.n, '1')

    // 免填绑定不接受任何凭据字段。
    await assert.rejects(
      bindDeclarativeConnector(
        {
          userId: user,
          connectorVersionId: Number(versionId),
          secrets: { access_token: 'x' },
          deps: deps(),
        },
        getPool(),
      ),
    )

    const out = (await executeDeclarativeAction(
      {
        connectionId: rebound.connectionId,
        userId: user,
        actionId: 'video',
        params: { bvid: 'BV17x411w7KC' },
        deps: deps(),
      },
      getPool(),
    )) as { code: number; data: { cid: number } }
    assert.equal(out.code, 0)
    assert.equal(out.data.cid, 279786)
  })

  test('保留 slug:普通发布拒;官方发布口只认代码里的精确工件', async (t) => {
    if (skip(t)) return
    const { author } = await ensureConnectorSeedPrincipals(getPool())
    const tampered = { ...structuredClone(biliConnectorSpec), description: '改过的说明' }
    const base = {
      slug: 'bili',
      version: '1.0.1',
      ownerUserId: author,
      name: 'x',
      description: 'x',
      tags: [],
      rawSkillMd: null,
      rawArtifact: canonicalBytes(tampered).toString('utf8'),
      artifactHash: canonicalSha256Hex(tampered),
      embeddingHash: 'e'.repeat(64),
      riskFlags: [],
      policyVersion: 1,
      submittedBy: author,
      kind: 'connector' as const,
      pluginType: 'declarative-http' as const,
      queueAiReview: false,
    }
    await assert.rejects(
      publishSkillVersion(base),
      (e: unknown) => e instanceof MarketplaceError && e.code === 'SLUG_OWNED_BY_OTHER',
    )
    await assert.rejects(
      publishOfficialMarketConnectorVersion(base),
      (e: unknown) => e instanceof MarketplaceError && e.code === 'ARTIFACT_MISMATCH',
    )
  })

  test('非官方工件走同一审核事务:authMode none / builtin 签不出契约', async (t) => {
    if (skip(t)) return
    const { author, reviewer } = await ensureConnectorSeedPrincipals(getPool())
    const copy = { ...structuredClone(biliConnectorSpec), id: 'bili-copy' }
    const hash = canonicalSha256Hex(copy)
    // 绕开发布管线,直接造一个 pending 版本(模拟库里出现了一份不是官方的工件)。
    await query(
      `INSERT INTO marketplace_skill_listings (slug, owner_user_id, kind, plugin_type)
         VALUES ('bili-copy', $1, 'connector', 'declarative-http')`,
      [author],
    )
    const v = await query<{ id: string }>(
      `INSERT INTO marketplace_skill_versions
         (slug, version, name, description, tags, raw_artifact, artifact_hash, embedding_hash,
          submitted_by, status, ai_review_state, use_cases, outcome_examples)
       VALUES ('bili-copy','1.0.0','x','x','[]'::jsonb,$1,$2,$2,$3,'pending',NULL,'[]'::jsonb,'[]'::jsonb)
       RETURNING id::text`,
      [canonicalBytes(copy).toString('utf8'), hash, author],
    )
    await assert.rejects(
      tx(async (client) => {
        await approveMarketplaceConnectorVersionWithRunner(
          {
            versionId: v.rows[0]!.id,
            reviewerUserId: reviewer,
            securityDecision: structuredClone(biliConnectorDecision),
            expectedSpecHash: hash,
            functionalVerified: true,
            note: 'should fail',
          },
          client,
        )
      }, getPool()),
      (e: unknown) => e instanceof ConnectorSpecError && e.code === 'BUILTIN_PLATFORM_ONLY',
    )
    const after = await query<{ security_review_state: string; status: string }>(
      'SELECT security_review_state, status FROM marketplace_skill_versions WHERE id = $1',
      [v.rows[0]!.id],
    )
    assert.equal(after.rows[0]!.security_review_state, 'draft')
    assert.equal(after.rows[0]!.status, 'pending')
  })
})
