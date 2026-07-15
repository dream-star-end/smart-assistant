/**
 * Integration: skill marketplace data layer on real Postgres (migration 0087).
 *
 * Locks the security invariants the design depends on (and Codex flagged):
 *   1. publish creates an owner-locked listing + a pending version
 *   2. slug is owner-locked: a 2nd publisher of the same slug is refused
 *   3. duplicate (slug, version) is refused
 *   4. reviewer must differ from submitter by default; admin routes may opt in
 *      to self-review for administrator-owned submissions
 *   5. approve flips status + sets the listing's current_approved_version_id;
 *      it then appears in the searchable catalog; reject does not
 *   6. install pins (version_id, artifact_hash) and supersedes the prior active row
 *   7. installing a non-current / revoked version → NOT_INSTALLABLE (TOCTOU-safe)
 *   8. revoke is a kill-switch: listActiveInstalledArtifacts drops the skill
 *   9. a pinned-hash vs version-content divergence is excluded from the sync feed
 *  10. uninstall soft-deletes the active row
 *
 * PG-only (no Redis). Skips when no test DB is reachable unless REQUIRE_TEST_DB=1.
 */
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'

import { marketplaceArtifactHash, skillContentHash } from '@openclaude/storage'
import { closePool, createPool, getPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'
import { querySkillFeedbackRefs } from '../http/internalSkillFeedback.js'
import {
  MarketplaceError,
  getApprovedSkillVersions,
  getListingDetail,
  installApprovedVersion,
  listActiveInstalledAgents,
  listActiveInstalledArtifacts,
  listApprovedForSearch,
  listInstalled,
  listMyPublishes,
  listPendingVersions,
  ownerUnlistListing,
  publishSkillVersion,
  recordUninstall,
  reviewVersion,
  reviewVersions,
  revokeListing,
  setListingFeaturedRank,
  updateInstalledAgentScope,
  withdrawPublishVersion,
} from '../marketplace/marketplaceDb.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'

let pgAvailable = false

// Throwaway test DB: nuke the whole schema and let runMigrations rebuild it from
// scratch (a fixed DROP-TABLE subset leaves other migrated tables behind and the
// next run's migrations fail with "relation already exists").
async function resetSchema(): Promise<void> {
  await query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
}

async function probe(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 })
  try {
    await p.query('SELECT 1')
    await p.end()
    return true
  } catch {
    try {
      await p.end()
    } catch {
      /* ignore */
    }
    return false
  }
}

before(async () => {
  pgAvailable = await probe()
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error('Postgres test fixture required (REQUIRE_TEST_DB=1)')
    return
  }
  await resetPool()
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 10 }))
  await resetSchema()
  await runMigrations()
})

after(async () => {
  if (pgAvailable) {
    try {
      await resetSchema()
    } catch {
      /* ignore */
    }
    await closePool()
  }
})

beforeEach(async () => {
  if (!pgAvailable) return
  await query(
    'TRUNCATE TABLE marketplace_skill_usage_events, response_rating, marketplace_installs, marketplace_skill_versions, marketplace_skill_listings, admin_audit, users RESTART IDENTITY CASCADE',
  )
})

function skipIfNoPg(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) {
    t.skip('pg not running')
    return true
  }
  return false
}

async function createUser(email: string): Promise<number> {
  const r = await query<{ id: string }>(
    "INSERT INTO users(email, password_hash, credits, role) VALUES ($1, 'argon2$stub', 0, 'user') RETURNING id::text AS id",
    [email],
  )
  return Number.parseInt(r.rows[0].id, 10)
}

/** Build a canonical SKILL.md the same way the publish route does (name := slug). */
function buildPublish(slug: string, owner: number, version = '1.0.0', extraBody = '') {
  const name = slug
  const description = `${slug} 描述`
  const tags = ['t1']
  const rawSkillMd = `---\nname: ${slug}\ndescription: ${JSON.stringify(description)}\ntags: [${tags.join(', ')}]\nversion: ${version}\n---\n\n# ${slug}\n步骤${extraBody}\n`
  return {
    slug,
    ownerUserId: owner,
    version,
    name,
    description,
    tags,
    rawSkillMd,
    artifactHash: marketplaceArtifactHash(rawSkillMd),
    embeddingHash: skillContentHash({ name, description, tags }),
    riskFlags: [],
    policyVersion: 1,
    submittedBy: owner,
  }
}

/** Build an agent artifact (kind='agent', manifest, no SKILL.md) — M2 generalization. */
function buildPublishAgent(slug: string, owner: number, version = '1.0.0') {
  const name = slug
  const description = `${slug} 智能体`
  const tags = ['agent']
  const manifest = {
    model: 'glm-5.2',
    toolsets: ['assistant'],
    skillDeps: [],
    persona: '你是一个测试智能体。',
  }
  const rawArtifact = JSON.stringify(manifest, null, 2)
  return {
    slug,
    ownerUserId: owner,
    version,
    name,
    description,
    tags,
    rawSkillMd: null,
    rawArtifact,
    manifest,
    kind: 'agent' as const,
    artifactHash: marketplaceArtifactHash(rawArtifact),
    embeddingHash: skillContentHash({ name, description, tags }),
    riskFlags: [],
    policyVersion: 1,
    submittedBy: owner,
  }
}

async function expectMarketplaceError(fn: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(fn, (e: unknown) => {
    assert.ok(e instanceof MarketplaceError, `expected MarketplaceError, got ${e}`)
    assert.equal(e.code, code)
    return true
  })
}

let usageSeq = 0
/**
 * 直插一条使用事件(模拟容器 skillUsageReporter 落库)。
 *   ageDays 控制事件年龄以测 30 天窗口;layer 缺省 'hub'(测 layer 隔离时传 'user');
 *   sessionKey 缺省 null(测 skill-feedback 差评引用时传具体会话键)。
 */
async function insertUsage(
  userId: number,
  slug: string,
  opts: {
    traceId?: string | null
    eventId?: string
    ageDays?: number
    layer?: 'hub' | 'user'
    sessionKey?: string | null
  } = {},
): Promise<void> {
  const eventId = opts.eventId ?? `evt-${++usageSeq}`
  await query(
    `INSERT INTO marketplace_skill_usage_events
       (user_id, slug, agent_id, session_key, trace_id, event_id, layer, created_at)
     VALUES ($1, $2, 'main', $3, $4, $5, $6, NOW() - make_interval(days => $7))`,
    [
      userId,
      slug,
      opts.sessionKey ?? null,
      opts.traceId ?? null,
      eventId,
      opts.layer ?? 'hub',
      opts.ageDays ?? 0,
    ],
  )
}
/**
 * 直插一条响应评分(评分归因的另一端;按 trace_id 与使用事件关联)。
 *   ratedAgeDays 控制评分时刻年龄以测 skill-feedback 的 90 天窗口(窗口过滤的是 r.created_at)。
 */
async function insertRating(
  userId: number,
  messageId: string,
  traceId: string,
  rating: 'up' | 'down',
  ratedAgeDays = 0,
): Promise<void> {
  await query(
    `INSERT INTO response_rating (user_id, session_id, message_id, trace_id, rating, created_at)
     VALUES ($1, 's', $2, $3, $4, NOW() - make_interval(days => $5))`,
    [userId, messageId, traceId, rating, ratedAgeDays],
  )
}
/** 发布 + 批准一个技能,返回 slug(信号聚合测试的公共前置)。 */
async function publishApproved(slug: string, owner: number, admin: number): Promise<void> {
  const p = await publishSkillVersion(buildPublish(slug, owner))
  await reviewVersion({ versionId: p.versionId, reviewerUserId: admin, approve: true })
}

describe('marketplaceDb (integ)', () => {
  test('publish creates owner-locked listing + pending version', async (t) => {
    if (skipIfNoPg(t)) return
    const owner = await createUser('owner@x.com')
    const { versionId } = await publishSkillVersion(buildPublish('pdf-helper', owner))
    assert.ok(versionId)
    const pending = await listPendingVersions()
    assert.equal(pending.length, 1)
    assert.equal(pending[0].slug, 'pdf-helper')
    assert.equal(pending[0].rawArtifact.includes('name: pdf-helper'), true)
    // not yet searchable
    assert.equal((await listApprovedForSearch()).length, 0)
  })

  test('slug is owner-locked: a different user cannot publish the same slug', async (t) => {
    if (skipIfNoPg(t)) return
    const a = await createUser('a@x.com')
    const b = await createUser('b@x.com')
    await publishSkillVersion(buildPublish('dup-slug', a))
    await expectMarketplaceError(
      () => publishSkillVersion(buildPublish('dup-slug', b, '2.0.0')),
      'SLUG_OWNED_BY_OTHER',
    )
  })

  test('duplicate (slug, version) is refused', async (t) => {
    if (skipIfNoPg(t)) return
    const a = await createUser('a@x.com')
    await publishSkillVersion(buildPublish('verdup', a, '1.0.0'))
    await expectMarketplaceError(
      () => publishSkillVersion(buildPublish('verdup', a, '1.0.0')),
      'DUPLICATE_VERSION',
    )
  })

  test('reviewer must differ from submitter', async (t) => {
    if (skipIfNoPg(t)) return
    const owner = await createUser('owner@x.com')
    const { versionId } = await publishSkillVersion(buildPublish('self-review', owner))
    await expectMarketplaceError(
      () => reviewVersion({ versionId, reviewerUserId: owner, approve: true }),
      'REVIEWER_IS_AUTHOR',
    )
  })

  test('admin route opt-in can approve self-submitted version', async (t) => {
    if (skipIfNoPg(t)) return
    const admin = await createUser('admin-self@x.com')
    const { versionId } = await publishSkillVersion(buildPublish('admin-self-review', admin))
    await reviewVersion({ versionId, reviewerUserId: admin, approve: true, allowSelfReview: true })
    const detail = await getListingDetail('admin-self-review')
    assert.ok(detail)
    assert.equal(detail.version, '1.0.0')
    assert.equal((await listApprovedForSearch()).some((x) => x.slug === 'admin-self-review'), true)
  })

  test('approve sets current + makes searchable; reject does not', async (t) => {
    if (skipIfNoPg(t)) return
    const owner = await createUser('owner@x.com')
    const admin = await createUser('admin@x.com')
    const ok = await publishSkillVersion(buildPublish('approve-me', owner))
    await reviewVersion({ versionId: ok.versionId, reviewerUserId: admin, approve: true })
    const cat = await listApprovedForSearch()
    assert.equal(cat.length, 1)
    assert.equal(cat[0].slug, 'approve-me')
    const detail = await getListingDetail('approve-me')
    assert.ok(detail)
    assert.equal(detail?.version, '1.0.0')
    assert.equal(detail?.reviewSource, 'manual')

    const rej = await publishSkillVersion(buildPublish('reject-me', owner))
    await reviewVersion({ versionId: rej.versionId, reviewerUserId: admin, approve: false })
    assert.equal(await getListingDetail('reject-me'), null)
  })

  test('benchmark 自报评测在搜索目录透出聚合值(有/无两分支)', async (t) => {
    if (skipIfNoPg(t)) return
    const owner = await createUser('bench-owner@x.com')
    const admin = await createUser('bench-admin@x.com')
    // 带 benchmark 发布 → 批准:listApprovedForSearch 应原样透出聚合值。
    const withB = await publishSkillVersion({
      ...buildPublish('bench-skill', owner),
      benchmark: { withPassRate: 0.91, withoutPassRate: 0.62, cases: 4 },
    })
    await reviewVersion({ versionId: withB.versionId, reviewerUserId: admin, approve: true })
    // 不带 benchmark 发布 → 批准:搜索行 benchmark 应为 null(卡片不渲染徽记)。
    const noB = await publishSkillVersion(buildPublish('plain-skill', owner))
    await reviewVersion({ versionId: noB.versionId, reviewerUserId: admin, approve: true })

    const cat = await listApprovedForSearch()
    const b = cat.find((c) => c.slug === 'bench-skill')
    assert.deepEqual(b?.benchmark, { withPassRate: 0.91, withoutPassRate: 0.62, cases: 4 })
    const p = cat.find((c) => c.slug === 'plain-skill')
    assert.equal(p?.benchmark, null)
    // 详情页口径一致(getListingDetail 早有 benchmark;此处只做交叉校验)。
    assert.deepEqual((await getListingDetail('bench-skill'))?.benchmark, {
      withPassRate: 0.91,
      withoutPassRate: 0.62,
      cases: 4,
    })
  })

  test('人向商品层元数据在 pending/search/detail 全链透出', async (t) => {
    if (skipIfNoPg(t)) return
    const owner = await createUser('human-owner@x.com')
    const admin = await createUser('human-admin@x.com')
    const p = await publishSkillVersion({
      ...buildPublish('human-skill', owner),
      category: 'office-docs',
      useCases: ['写周报月报', '做汇报 PPT'],
      outcomeExamples: ['给它要点→得到排版好的周报'],
      humanMd: '## 亮点\n一键出周报',
    })
    // pending 行透出全部新字段。
    const pending = (await listPendingVersions()).find((x) => x.slug === 'human-skill')
    assert.equal(pending?.category, 'office-docs')
    assert.deepEqual(pending?.useCases, ['写周报月报', '做汇报 PPT'])
    assert.deepEqual(pending?.outcomeExamples, ['给它要点→得到排版好的周报'])
    assert.equal(pending?.humanMd, '## 亮点\n一键出周报')

    await reviewVersion({ versionId: p.versionId, reviewerUserId: admin, approve: true })
    // 卡片(search)透出 category/useCases/featuredRank;不含 outcomeExamples/humanMd(卡片保持轻)。
    const card = (await listApprovedForSearch()).find((c) => c.slug === 'human-skill')
    assert.equal(card?.category, 'office-docs')
    assert.deepEqual(card?.useCases, ['写周报月报', '做汇报 PPT'])
    assert.equal(card?.featuredRank, null)
    assert.equal('outcomeExamples' in (card as object), false)
    assert.equal('humanMd' in (card as object), false)
    // detail 透出全部新字段。
    const detail = await getListingDetail('human-skill')
    assert.equal(detail?.category, 'office-docs')
    assert.deepEqual(detail?.useCases, ['写周报月报', '做汇报 PPT'])
    assert.deepEqual(detail?.outcomeExamples, ['给它要点→得到排版好的周报'])
    assert.equal(detail?.humanMd, '## 亮点\n一键出周报')
    assert.equal(detail?.featuredRank, null)
  })

  test('缺省人向元数据:category=null / useCases=[] / outcomeExamples=[] / humanMd=null', async (t) => {
    if (skipIfNoPg(t)) return
    const owner = await createUser('plain-owner@x.com')
    const admin = await createUser('plain-admin@x.com')
    const p = await publishSkillVersion(buildPublish('plain-human', owner))
    await reviewVersion({ versionId: p.versionId, reviewerUserId: admin, approve: true })
    const card = (await listApprovedForSearch()).find((c) => c.slug === 'plain-human')
    assert.equal(card?.category, null)
    assert.deepEqual(card?.useCases, [])
    const detail = await getListingDetail('plain-human')
    assert.equal(detail?.category, null)
    assert.deepEqual(detail?.useCases, [])
    assert.deepEqual(detail?.outcomeExamples, [])
    assert.equal(detail?.humanMd, null)
  })

  test('listApprovedForSearch 排序:平台精选(featured_rank)领衔 → 热度 → 新版本', async (t) => {
    if (skipIfNoPg(t)) return
    const owner = await createUser('order-owner@x.com')
    const admin = await createUser('order-admin@x.com')
    const installer = await createUser('order-inst@x.com')
    // 依次发布 A/B/C(id 递增),全部批准。默认序(无精选/无安装)= v.id DESC = C,B,A。
    const a = await publishSkillVersion(buildPublish('feat-a', owner))
    await reviewVersion({ versionId: a.versionId, reviewerUserId: admin, approve: true })
    const b = await publishSkillVersion(buildPublish('inst-b', owner))
    await reviewVersion({ versionId: b.versionId, reviewerUserId: admin, approve: true })
    const c = await publishSkillVersion(buildPublish('plain-c', owner))
    await reviewVersion({ versionId: c.versionId, reviewerUserId: admin, approve: true })

    // B 有 1 个活跃安装(热度高于 C);A 经 setListingFeaturedRank 设为平台精选(featured_rank=1)。
    await installApprovedVersion({ userId: installer, versionId: b.versionId })
    await setListingFeaturedRank('feat-a', 1)

    const order = (await listApprovedForSearch()).map((c2) => c2.slug)
    assert.deepEqual(order, ['feat-a', 'inst-b', 'plain-c'])
    const featA = (await listApprovedForSearch()).find((c2) => c2.slug === 'feat-a')
    assert.equal(featA?.featuredRank, 1)
  })

  test('setListingFeaturedRank:设置/取消/非 active 拒绝/不存在拒绝', async (t) => {
    if (skipIfNoPg(t)) return
    const owner = await createUser('feat-set-owner@x.com')
    const admin = await createUser('feat-set-admin@x.com')
    await publishApproved('feat-set', owner, admin)

    // 默认非精选。
    assert.equal(
      (await listApprovedForSearch()).find((c) => c.slug === 'feat-set')?.featuredRank,
      null,
    )
    // 设置 → 目录透出该 rank。
    await setListingFeaturedRank('feat-set', 3)
    assert.equal(
      (await listApprovedForSearch()).find((c) => c.slug === 'feat-set')?.featuredRank,
      3,
    )
    // 取消(null)→ 回到非精选。
    await setListingFeaturedRank('feat-set', null)
    assert.equal(
      (await listApprovedForSearch()).find((c) => c.slug === 'feat-set')?.featuredRank,
      null,
    )

    // 不存在的 slug → VERSION_NOT_FOUND。
    await expectMarketplaceError(() => setListingFeaturedRank('no-such-slug', 1), 'VERSION_NOT_FOUND')

    // 非 active(admin revoke 后 state='revoked')→ LISTING_REVOKED,拒绝设为精选。
    await revokeListing('feat-set', 'kill-switch')
    await expectMarketplaceError(() => setListingFeaturedRank('feat-set', 1), 'LISTING_REVOKED')

    // rank 越界(契约违背)→ 普通 Error(非 MarketplaceError,路由层另有 400 前置校验)。
    const owner2 = await createUser('feat-range-owner@x.com')
    const admin2 = await createUser('feat-range-admin@x.com')
    await publishApproved('feat-range', owner2, admin2)
    await assert.rejects(
      () => setListingFeaturedRank('feat-range', 0),
      (e: unknown) => e instanceof Error && !(e instanceof MarketplaceError),
    )
    await assert.rejects(
      () => setListingFeaturedRank('feat-range', 10000),
      (e: unknown) => e instanceof Error && !(e instanceof MarketplaceError),
    )
  })

  test('batch review approves multiple pending versions', async (t) => {
    if (skipIfNoPg(t)) return
    const owner = await createUser('batch-owner@x.com')
    const admin = await createUser('batch-admin@x.com')
    const a = await publishSkillVersion(buildPublish('batch-a', owner))
    const b = await publishSkillVersion(buildPublish('batch-b', owner))

    const results = await reviewVersions({
      versionIds: [a.versionId, b.versionId],
      reviewerUserId: admin,
      approve: true,
    })
    assert.deepEqual(results, [
      { versionId: a.versionId, ok: true },
      { versionId: b.versionId, ok: true },
    ])
    assert.equal((await listPendingVersions()).length, 0)
    const slugs = new Set((await listApprovedForSearch()).map((x) => x.slug))
    assert.equal(slugs.has('batch-a'), true)
    assert.equal(slugs.has('batch-b'), true)
  })

  test('batch review reports per-item failures and keeps processing', async (t) => {
    if (skipIfNoPg(t)) return
    const owner = await createUser('batch-partial-owner@x.com')
    const admin = await createUser('batch-partial-admin@x.com')
    const already = await publishSkillVersion(buildPublish('batch-already', owner))
    await reviewVersion({ versionId: already.versionId, reviewerUserId: admin, approve: true })
    const pending = await publishSkillVersion(buildPublish('batch-still-pending', owner))

    const results = await reviewVersions({
      versionIds: [already.versionId, pending.versionId],
      reviewerUserId: admin,
      approve: true,
    })
    assert.equal(results[0].ok, false)
    assert.equal(results[0].code, 'NOT_PENDING')
    assert.deepEqual(results[1], { versionId: pending.versionId, ok: true })
    assert.equal((await getListingDetail('batch-still-pending'))?.version, '1.0.0')
  })

  test('batch review rejects multiple pending versions with a shared note', async (t) => {
    if (skipIfNoPg(t)) return
    const owner = await createUser('batch-reject-owner@x.com')
    const admin = await createUser('batch-reject-admin@x.com')
    const a = await publishSkillVersion(buildPublish('batch-reject-a', owner))
    const b = await publishSkillVersion(buildPublish('batch-reject-b', owner))

    const results = await reviewVersions({
      versionIds: [a.versionId, b.versionId],
      reviewerUserId: admin,
      approve: false,
      note: '不符合发布规范',
    })
    assert.deepEqual(results, [
      { versionId: a.versionId, ok: true },
      { versionId: b.versionId, ok: true },
    ])
    const rows = await query<{ status: string; review_note: string | null }>(
      'SELECT status, review_note FROM marketplace_skill_versions ORDER BY id',
    )
    assert.deepEqual(
      rows.rows.map((r) => [r.status, r.review_note]),
      [
        ['rejected', '不符合发布规范'],
        ['rejected', '不符合发布规范'],
      ],
    )
    assert.equal((await listPendingVersions()).length, 0)
    assert.equal((await listApprovedForSearch()).length, 0)
  })

  test('M2: skill defaults kind=skill; detail/search expose kind + raw_artifact', async (t) => {
    if (skipIfNoPg(t)) return
    const owner = await createUser('m2skill@x.com')
    const admin = await createUser('m2sadmin@x.com')
    const p = await publishSkillVersion(buildPublish('m2-skill', owner))
    await reviewVersion({ versionId: p.versionId, reviewerUserId: admin, approve: true })
    const row = (await listApprovedForSearch()).find((c) => c.slug === 'm2-skill')
    assert.equal(row?.kind, 'skill')
    const detail = await getListingDetail('m2-skill')
    assert.equal(detail?.kind, 'skill')
    // raw_artifact backfilled == the SKILL.md for skills
    assert.ok(detail?.rawArtifact.includes('name: m2-skill'))
    assert.ok(detail?.rawSkillMd?.includes('name: m2-skill'))
    assert.equal(detail?.manifest, null)
  })

  test('M2: agent kind round-trips; kind filter + kind-lock', async (t) => {
    if (skipIfNoPg(t)) return
    const owner = await createUser('m2agent@x.com')
    const admin = await createUser('m2aadmin@x.com')
    const a = await publishSkillVersion(buildPublishAgent('m2-agent', owner))
    await reviewVersion({ versionId: a.versionId, reviewerUserId: admin, approve: true })

    // kind filter: 'agent' returns the agent and no skills
    const agents = await listApprovedForSearch('agent')
    assert.ok(agents.some((c) => c.slug === 'm2-agent'))
    assert.ok(agents.every((c) => c.kind === 'agent'))
    const skills = await listApprovedForSearch('skill')
    assert.ok(!skills.some((c) => c.slug === 'm2-agent'))

    // agent detail: rawArtifact = manifest text, rawSkillMd null, manifest present
    const detail = await getListingDetail('m2-agent')
    assert.equal(detail?.kind, 'agent')
    assert.equal(detail?.rawSkillMd, null)
    assert.ok(detail?.manifest)

    // slug is kind-locked: cannot republish an agent slug as a skill
    await expectMarketplaceError(
      () => publishSkillVersion(buildPublish('m2-agent', owner, '2.0.0')),
      'KIND_MISMATCH',
    )

    // M3: an approved agent IS installable; it surfaces via listActiveInstalledAgents
    // and is kind-scoped OUT of the skill sync feed.
    const installer = await createUser('m3installer@x.com')
    const inst = await installApprovedVersion({ userId: installer, versionId: a.versionId })
    assert.equal(inst.slug, 'm2-agent')
    const installedAgents = await listActiveInstalledAgents(installer)
    assert.equal(installedAgents.length, 1)
    assert.equal(installedAgents[0].slug, 'm2-agent')
    assert.ok(installedAgents[0].rawManifest.includes('"model"'))
    const skillFeed = await listActiveInstalledArtifacts(installer)
    assert.ok(!skillFeed.some((s) => s.slug === 'm2-agent'), 'agent must not leak into skill feed')
  })

  test('M3: getApprovedSkillVersions resolves approved skill slugs (for agent skillDeps)', async (t) => {
    if (skipIfNoPg(t)) return
    const owner = await createUser('m3deps@x.com')
    const admin = await createUser('m3depsadmin@x.com')
    const ok = await publishSkillVersion(buildPublish('dep-skill', owner))
    await reviewVersion({ versionId: ok.versionId, reviewerUserId: admin, approve: true })
    const pendingOnly = await publishSkillVersion(buildPublish('dep-pending', owner))
    void pendingOnly // left pending → must NOT resolve
    const map = await getApprovedSkillVersions(['dep-skill', 'dep-pending', 'nonexistent'])
    assert.ok(map.has('dep-skill'))
    assert.ok(!map.has('dep-pending'))
    assert.ok(!map.has('nonexistent'))
  })

  test('cannot re-review a non-pending version', async (t) => {
    if (skipIfNoPg(t)) return
    const owner = await createUser('owner@x.com')
    const admin = await createUser('admin@x.com')
    const { versionId } = await publishSkillVersion(buildPublish('once', owner))
    await reviewVersion({ versionId, reviewerUserId: admin, approve: true })
    await expectMarketplaceError(
      () => reviewVersion({ versionId, reviewerUserId: admin, approve: false }),
      'NOT_PENDING',
    )
  })

  test('install pins version+hash and supersedes the prior active row', async (t) => {
    if (skipIfNoPg(t)) return
    const owner = await createUser('owner@x.com')
    const admin = await createUser('admin@x.com')
    const installer = await createUser('inst@x.com')
    const p = buildPublish('inst-skill', owner)
    const { versionId } = await publishSkillVersion(p)
    await reviewVersion({ versionId, reviewerUserId: admin, approve: true })

    const r = await installApprovedVersion({ userId: installer, versionId })
    assert.equal(r.slug, 'inst-skill')
    const installed = await listInstalled(installer)
    assert.equal(installed.length, 1)
    assert.equal(installed[0].artifactHash, p.artifactHash)

    // re-install (same version) supersedes — still exactly one active row
    await installApprovedVersion({ userId: installer, versionId })
    assert.equal((await listInstalled(installer)).length, 1)
    const activeRows = await query<{ n: string }>(
      'SELECT count(*)::text AS n FROM marketplace_installs WHERE user_id = $1 AND uninstalled_at IS NULL',
      [installer],
    )
    assert.equal(activeRows.rows[0].n, '1')
  })

  test('skill install scope defaults to main, can replace, merge, and feeds sync', async (t) => {
    if (skipIfNoPg(t)) return
    const owner = await createUser('owner@x.com')
    const admin = await createUser('admin@x.com')
    const installer = await createUser('inst@x.com')
    const p = buildPublish('scoped-skill', owner)
    const { versionId } = await publishSkillVersion(p)
    await reviewVersion({ versionId, reviewerUserId: admin, approve: true })

    await installApprovedVersion({ userId: installer, versionId })
    assert.deepEqual((await listInstalled(installer))[0].agentIds, ['main'])
    assert.deepEqual((await listActiveInstalledArtifacts(installer))[0].agentIds, ['main'])

    await updateInstalledAgentScope(installer, 'scoped-skill', ['office-assistant'])
    assert.deepEqual((await listInstalled(installer))[0].agentIds, ['office-assistant'])
    assert.deepEqual((await listActiveInstalledArtifacts(installer))[0].agentIds, ['office-assistant'])

    await installApprovedVersion({
      userId: installer,
      versionId,
      agentIds: ['research-assistant'],
      scopeMode: 'merge',
    })
    assert.deepEqual((await listInstalled(installer))[0].agentIds, [
      'office-assistant',
      'research-assistant',
    ])

    await installApprovedVersion({
      userId: installer,
      versionId,
      agentIds: ['main'],
      scopeMode: 'replace',
    })
    assert.deepEqual((await listInstalled(installer))[0].agentIds, ['main'])
  })

  test('installing a superseded (non-current) version is refused', async (t) => {
    if (skipIfNoPg(t)) return
    const owner = await createUser('owner@x.com')
    const admin = await createUser('admin@x.com')
    const installer = await createUser('inst@x.com')
    const v1 = await publishSkillVersion(buildPublish('multi-ver', owner, '1.0.0'))
    await reviewVersion({ versionId: v1.versionId, reviewerUserId: admin, approve: true })
    const v2 = await publishSkillVersion(buildPublish('multi-ver', owner, '2.0.0'))
    await reviewVersion({ versionId: v2.versionId, reviewerUserId: admin, approve: true })
    // v1 is no longer the listing's current approved version
    await expectMarketplaceError(
      () => installApprovedVersion({ userId: installer, versionId: v1.versionId }),
      'NOT_INSTALLABLE',
    )
    // v2 (current) installs fine
    const r = await installApprovedVersion({ userId: installer, versionId: v2.versionId })
    assert.equal(r.version, '2.0.0')
  })

  test('revoke is a kill-switch: install drops out of the sync feed', async (t) => {
    if (skipIfNoPg(t)) return
    const owner = await createUser('owner@x.com')
    const admin = await createUser('admin@x.com')
    const installer = await createUser('inst@x.com')
    const p = buildPublish('kill-me', owner)
    const { versionId } = await publishSkillVersion(p)
    await reviewVersion({ versionId, reviewerUserId: admin, approve: true })
    await installApprovedVersion({ userId: installer, versionId })
    assert.equal((await listActiveInstalledArtifacts(installer)).length, 1)

    const affected = await revokeListing('kill-me', 'bad skill')
    assert.deepEqual(affected, [installer])
    // kill-switch: revoked listing no longer materializes in the container feed
    assert.equal((await listActiveInstalledArtifacts(installer)).length, 0)
    // and re-install of a revoked listing is refused
    await expectMarketplaceError(
      () => installApprovedVersion({ userId: installer, versionId }),
      'NOT_INSTALLABLE',
    )
  })

  test('owner unlist removes listing from catalog/install/sync but can relist via new approval', async (t) => {
    if (skipIfNoPg(t)) return
    const owner = await createUser('unlist-owner@x.com')
    const admin = await createUser('unlist-admin@x.com')
    const installer = await createUser('unlist-inst@x.com')
    const p = await publishSkillVersion(buildPublish('owner-unlist', owner))
    await reviewVersion({ versionId: p.versionId, reviewerUserId: admin, approve: true })
    await installApprovedVersion({ userId: installer, versionId: p.versionId })
    assert.ok((await getListingDetail('owner-unlist')) !== null)
    assert.equal((await listActiveInstalledArtifacts(installer)).length, 1)

    const affected = await ownerUnlistListing('owner-unlist', owner)
    assert.deepEqual(affected, [installer])
    assert.equal(await getListingDetail('owner-unlist'), null)
    assert.equal((await listApprovedForSearch()).some((x) => x.slug === 'owner-unlist'), false)
    assert.equal((await listActiveInstalledArtifacts(installer)).length, 0)
    await expectMarketplaceError(
      () => installApprovedVersion({ userId: installer, versionId: p.versionId }),
      'NOT_INSTALLABLE',
    )
    assert.equal((await listInstalled(installer))[0].listingState, 'unlisted')

    const v2 = await publishSkillVersion(buildPublish('owner-unlist', owner, '2.0.0'))
    await reviewVersion({ versionId: v2.versionId, reviewerUserId: admin, approve: true })
    const detail = await getListingDetail('owner-unlist')
    assert.equal(detail?.version, '2.0.0')
    const state = await query<{ state: string }>(
      'SELECT state FROM marketplace_skill_listings WHERE slug = $1',
      ['owner-unlist'],
    )
    assert.equal(state.rows[0].state, 'active')
  })

  test('owner unlist enforces owner and cannot undo admin revoke', async (t) => {
    if (skipIfNoPg(t)) return
    const owner = await createUser('unlist-guard-owner@x.com')
    const other = await createUser('unlist-guard-other@x.com')
    const admin = await createUser('unlist-guard-admin@x.com')
    const p = await publishSkillVersion(buildPublish('owner-unlist-guard', owner))
    await reviewVersion({ versionId: p.versionId, reviewerUserId: admin, approve: true })

    await expectMarketplaceError(
      () => ownerUnlistListing('owner-unlist-guard', other),
      'SLUG_OWNED_BY_OTHER',
    )
    await revokeListing('owner-unlist-guard', 'admin kill-switch')
    await expectMarketplaceError(
      () => ownerUnlistListing('owner-unlist-guard', owner),
      'LISTING_REVOKED',
    )
  })

  test('approved pending version cannot relist a revoked listing', async (t) => {
    if (skipIfNoPg(t)) return
    const owner = await createUser('revoked-relist-owner@x.com')
    const admin = await createUser('revoked-relist-admin@x.com')
    const v1 = await publishSkillVersion(buildPublish('revoked-relist', owner, '1.0.0'))
    await reviewVersion({ versionId: v1.versionId, reviewerUserId: admin, approve: true })
    const v2 = await publishSkillVersion(buildPublish('revoked-relist', owner, '2.0.0'))
    await revokeListing('revoked-relist', 'admin kill-switch')

    await expectMarketplaceError(
      () => reviewVersion({ versionId: v2.versionId, reviewerUserId: admin, approve: true }),
      'LISTING_REVOKED',
    )
    const state = await query<{ state: string; current_approved_version_id: string }>(
      'SELECT state, current_approved_version_id::text FROM marketplace_skill_listings WHERE slug = $1',
      ['revoked-relist'],
    )
    assert.equal(state.rows[0].state, 'revoked')
    assert.equal(state.rows[0].current_approved_version_id, v1.versionId)
  })

  test('publisher can withdraw pending version and only owner can do it', async (t) => {
    if (skipIfNoPg(t)) return
    const owner = await createUser('withdraw-owner@x.com')
    const other = await createUser('withdraw-other@x.com')
    const pending = await publishSkillVersion(buildPublish('withdraw-me', owner))

    await expectMarketplaceError(
      () => withdrawPublishVersion(pending.versionId, other),
      'SLUG_OWNED_BY_OTHER',
    )
    assert.equal((await listPendingVersions()).length, 1)

    await withdrawPublishVersion(pending.versionId, owner)
    assert.equal((await listPendingVersions()).length, 0)
    const mine = await listMyPublishes(owner)
    assert.equal(mine[0].status, 'rejected')
    assert.equal(mine[0].reviewNote, '作者撤销发布')
    await expectMarketplaceError(
      () => withdrawPublishVersion(pending.versionId, owner),
      'NOT_PENDING',
    )
  })

  test('pinned-vs-version artifact_hash divergence is excluded from the sync feed', async (t) => {
    if (skipIfNoPg(t)) return
    // This guards the master SQL `i.artifact_hash = v.artifact_hash` join condition:
    // if the version's recorded hash ever diverges from the hash pinned at install,
    // the row is not emitted to the container feed. (Content-vs-hash tampering of
    // raw_skill_md is a separate, container-side defense: marketplaceSync re-hashes
    // the body with marketplaceArtifactHash before writing.)
    const owner = await createUser('owner@x.com')
    const admin = await createUser('admin@x.com')
    const installer = await createUser('inst@x.com')
    const p = buildPublish('tamper', owner)
    const { versionId } = await publishSkillVersion(p)
    await reviewVersion({ versionId, reviewerUserId: admin, approve: true })
    await installApprovedVersion({ userId: installer, versionId })
    assert.equal((await listActiveInstalledArtifacts(installer)).length, 1)
    // simulate the version's recorded hash diverging from the install's pinned hash
    await query('UPDATE marketplace_skill_versions SET artifact_hash = $2 WHERE id = $1', [
      versionId,
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    ])
    assert.equal((await listActiveInstalledArtifacts(installer)).length, 0)
  })

  test('uninstall soft-deletes the active row', async (t) => {
    if (skipIfNoPg(t)) return
    const owner = await createUser('owner@x.com')
    const admin = await createUser('admin@x.com')
    const installer = await createUser('inst@x.com')
    const { versionId } = await publishSkillVersion(buildPublish('removable', owner))
    await reviewVersion({ versionId, reviewerUserId: admin, approve: true })
    await installApprovedVersion({ userId: installer, versionId })
    assert.equal(await recordUninstall(installer, 'removable'), true)
    assert.equal((await listInstalled(installer)).length, 0)
    // idempotent: a second uninstall reports no active row
    assert.equal(await recordUninstall(installer, 'removable'), false)
  })

  test('usage30d/users30d:30 天窗口 + distinct 用户;无事件=0;detail 同口径', async (t) => {
    if (skipIfNoPg(t)) return
    const owner = await createUser('sig-owner@x.com')
    const admin = await createUser('sig-admin@x.com')
    const uA = await createUser('sig-a@x.com')
    const uB = await createUser('sig-b@x.com')
    await publishApproved('sig-skill', owner, admin)
    await publishApproved('sig-empty', owner, admin)
    // uA:近 30 天 2 次 + 40 天前 1 次(窗口外);uB:近 30 天 1 次。
    await insertUsage(uA, 'sig-skill')
    await insertUsage(uA, 'sig-skill')
    await insertUsage(uA, 'sig-skill', { ageDays: 40 })
    await insertUsage(uB, 'sig-skill')

    const card = (await listApprovedForSearch()).find((c) => c.slug === 'sig-skill')
    assert.equal(card?.usage30d, 3, '窗口内 3 次(40 天前那次剔除)')
    assert.equal(card?.users30d, 2, 'distinct 用户 = uA,uB')
    const empty = (await listApprovedForSearch()).find((c) => c.slug === 'sig-empty')
    assert.equal(empty?.usage30d, 0)
    assert.equal(empty?.users30d, 0)
    // detail 与卡片同口径。
    const detail = await getListingDetail('sig-skill')
    assert.equal(detail?.usage30d, 3)
    assert.equal(detail?.users30d, 2)
    assert.equal((await getListingDetail('sig-empty'))?.usage30d, 0)
  })

  test('rating 归因:样本≥5 才透出 + 同 turn 同 slug 多次 view 去重', async (t) => {
    if (skipIfNoPg(t)) return
    const owner = await createUser('rate-owner@x.com')
    const admin = await createUser('rate-admin@x.com')
    const u = await createUser('rate-user@x.com')
    await publishApproved('rate-skill', owner, admin)
    // 5 个被评分的 turn:T1-T4 好评、T5 差评 → up=4/down=1(样本 5 ≥ 阈值)。
    // T1 有两条同 slug 使用事件(同 trace)→ 聚合 DISTINCT 应只算一次,不会把 up 抬到 5。
    for (let i = 1; i <= 5; i++) {
      const trace = `${'0'.repeat(31)}${i}` // 32 hex
      await insertUsage(u, 'rate-skill', { traceId: trace })
      if (i === 1) await insertUsage(u, 'rate-skill', { traceId: trace }) // 同 turn 重复 view
      await insertRating(u, `m${i}`, trace, i === 5 ? 'down' : 'up')
    }
    // 一条无评分的使用事件(不同 trace,无 response_rating)→ 不进 rating,但计入 usage。
    await insertUsage(u, 'rate-skill', { traceId: 'a'.repeat(32) })

    const card = (await listApprovedForSearch()).find((c) => c.slug === 'rate-skill')
    assert.deepEqual(card?.rating, { up: 4, down: 1 }, '去重后 up=4(非 5),down=1')
    assert.equal((await getListingDetail('rate-skill'))?.rating?.up, 4)
    assert.deepEqual((await getListingDetail('rate-skill'))?.rating, { up: 4, down: 1 })
  })

  test('rating 样本 <5 → 服务端返回 null(卡片/detail 一致)', async (t) => {
    if (skipIfNoPg(t)) return
    const owner = await createUser('low-owner@x.com')
    const admin = await createUser('low-admin@x.com')
    const u = await createUser('low-user@x.com')
    await publishApproved('rate-low', owner, admin)
    // 只有 4 个被评分 turn(<5)→ null。
    for (let i = 1; i <= 4; i++) {
      const trace = `${'b'.repeat(31)}${i}`
      await insertUsage(u, 'rate-low', { traceId: trace })
      await insertRating(u, `lm${i}`, trace, 'up')
    }
    const card = (await listApprovedForSearch()).find((c) => c.slug === 'rate-low')
    assert.equal(card?.rating, null, '样本不足阈值 → null')
    assert.equal((await getListingDetail('rate-low'))?.rating, null)
  })

  test('排序:featured → 30 天使用人数 → 安装数(users30d 压过安装数)', async (t) => {
    if (skipIfNoPg(t)) return
    const owner = await createUser('pop-owner@x.com')
    const admin = await createUser('pop-admin@x.com')
    const u1 = await createUser('pop-1@x.com')
    const u2 = await createUser('pop-2@x.com')
    const inst = await createUser('pop-inst@x.com')
    await publishApproved('pop-x', owner, admin) // 2 个 30 天使用人,0 安装
    await publishApproved('pop-y', owner, admin) // 0 使用,1 安装
    await insertUsage(u1, 'pop-x')
    await insertUsage(u2, 'pop-x')
    const yDetail = await getListingDetail('pop-y')
    await installApprovedVersion({ userId: inst, versionId: yDetail!.versionId })

    const order = (await listApprovedForSearch()).map((c) => c.slug)
    assert.deepEqual(order, ['pop-x', 'pop-y'], 'users30d(2) 排在安装数(1)之前')
  })

  test('正确性红线:layer=user 事件绝不进市场聚合(usage30d/users30d/rating)', async (t) => {
    if (skipIfNoPg(t)) return
    const owner = await createUser('layer-owner@x.com')
    const admin = await createUser('layer-admin@x.com')
    const uA = await createUser('layer-a@x.com')
    await publishApproved('layer-skill', owner, admin)
    // hub 层:1 次使用 + 1 个差评归因 turn(样本 1 <5 → rating 本应 null)。
    const hubTrace = `${'0'.repeat(31)}1`
    await insertUsage(uA, 'layer-skill', { traceId: hubTrace, layer: 'hub' })
    await insertRating(uA, 'mh', hubTrace, 'down')
    // user 层:**同 slug** 5 次使用 + 5 个 up 评分 turn(足以越过 rating 阈值)。
    // 若聚合未过滤 layer='hub',这些会把 usage30d 抬到 6、把 rating 抬成非 null 的 up 群 —— 全都必须被挡。
    for (let i = 1; i <= 5; i++) {
      const t2 = `${'2'.repeat(31)}${i}`
      await insertUsage(uA, 'layer-skill', { traceId: t2, layer: 'user' })
      await insertRating(uA, `mu${i}`, t2, 'up')
    }
    const card = (await listApprovedForSearch()).find((c) => c.slug === 'layer-skill')
    assert.equal(card?.usage30d, 1, 'user 层 5 次使用不得计入 usage30d')
    assert.equal(card?.users30d, 1)
    assert.equal(card?.rating, null, 'user 层 5 个 up 评分不得把样本抬过阈值/污染好评率')
    const detail = await getListingDetail('layer-skill')
    assert.equal(detail?.usage30d, 1, 'detail 与卡片同口径:user 层被过滤')
    assert.equal(detail?.users30d, 1)
    assert.equal(detail?.rating, null)
  })

  test('skill-feedback:差评引用 DISTINCT session_key、90 天窗口、layer/用户隔离、total 不截断', async (t) => {
    if (skipIfNoPg(t)) return
    const u = await createUser('fb-user@x.com')
    const other = await createUser('fb-other@x.com')
    const slug = 'fb-skill'
    // s1:同会话两条差评(t1a 较老、t1b 较新)→ DISTINCT ON 取最近一条(t1b)。
    const t1a = `${'1'.repeat(31)}a`
    const t1b = `${'1'.repeat(31)}b`
    await insertUsage(u, slug, { sessionKey: 's1', traceId: t1a, layer: 'hub' })
    await insertRating(u, 'm1a', t1a, 'down', 5)
    await insertUsage(u, slug, { sessionKey: 's1', traceId: t1b, layer: 'hub' })
    await insertRating(u, 'm1b', t1b, 'down', 2)
    // s2:一条差评(1 天前,比 s1 新 → 排序在前)。
    const t2 = `${'2'.repeat(31)}0`
    await insertUsage(u, slug, { sessionKey: 's2', traceId: t2, layer: 'hub' })
    await insertRating(u, 'm2', t2, 'down', 1)
    // s3:好评 → 不进差评引用。
    const t3 = `${'3'.repeat(31)}0`
    await insertUsage(u, slug, { sessionKey: 's3', traceId: t3, layer: 'hub' })
    await insertRating(u, 'm3', t3, 'up', 0)
    // s4:差评但评分在 100 天前(窗口外)→ 不进。
    const t4 = `${'4'.repeat(31)}0`
    await insertUsage(u, slug, { sessionKey: 's4', traceId: t4, layer: 'hub' })
    await insertRating(u, 'm4', t4, 'down', 100)
    // sNull:差评但 session_key=null(无法摘录)→ 不进。
    const tN = `${'5'.repeat(31)}0`
    await insertUsage(u, slug, { sessionKey: null, traceId: tN, layer: 'hub' })
    await insertRating(u, 'mN', tN, 'down', 0)
    // user 层:同用户同 slug 一条差评 → 只在 layer='user' 查询里出现,不进 hub 查询。
    const tU = `${'6'.repeat(31)}0`
    await insertUsage(u, slug, { sessionKey: 'su', traceId: tU, layer: 'user' })
    await insertRating(u, 'mU', tU, 'down', 0)
    // 别的用户:同 slug 差评 → 不进本用户查询(user_id 隔离)。
    const tO = `${'7'.repeat(31)}0`
    await insertUsage(other, slug, { sessionKey: 'so', traceId: tO, layer: 'hub' })
    await insertRating(other, 'mO', tO, 'down', 0)

    // hub 层:只应见 s1、s2 两个会话;s2(1 天前)排在 s1(2 天前)之前;s1 取新 trace t1b。
    const hub = await querySkillFeedbackRefs(getPool(), u, slug, 'hub')
    assert.equal(hub.total, 2, 'DISTINCT session_key 总数=2(不含好评/窗口外/null/user/他人)')
    assert.deepEqual(
      hub.refs.map((r) => r.sessionKey),
      ['s2', 's1'],
      '按差评时刻降序:s2 先于 s1',
    )
    assert.equal(hub.refs[1].traceId, t1b, 's1 同会话多差评取最近一条的 trace')
    assert.ok(hub.refs[0].at > hub.refs[1].at, 'at 单调降序')

    // user 层:只见 su 一条。
    const user = await querySkillFeedbackRefs(getPool(), u, slug, 'user')
    assert.equal(user.total, 1)
    assert.deepEqual(user.refs.map((r) => r.sessionKey), ['su'])

    // 空:不存在的 slug → refs:[] total:0。
    const empty = await querySkillFeedbackRefs(getPool(), u, 'no-such-skill', 'hub')
    assert.deepEqual(empty, { refs: [], total: 0 })
  })
})
