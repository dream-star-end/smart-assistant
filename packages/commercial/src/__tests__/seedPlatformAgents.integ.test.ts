/**
 * Integ 测试:平台官方科研 agent 的幂等 seed(seedPlatformResearchAgents)。
 * PG-only;无测试库时跳过,除非 REQUIRE_TEST_DB=1。
 *
 * 验证:
 *  - seed → 单个端到端「科研助手」成为「已批准的 agent 类」市场 listing(可搜可装);
 *  - manifest 合法(validateAgentManifest 不报错)、persona 过静态扫描;
 *  - owner 自动取最早 active admin;
 *  - 幂等:重复 seed 不重复发布、仍保持 approved;
 *  - kind 隔离:只在 agent 目录,不混进 skill 目录(配合 search 默认 skill 防 v3 泄漏);
 *  - 废弃下架:旧的「科研分析师/写手」若存在会被 revoke。
 */
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'

import { closePool, createPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'
import { marketplaceArtifactHash, skillContentHash } from '@openclaude/storage'

import {
  MarketplaceError,
  approvePlatformVersion,
  installApprovedVersion,
  listActiveInstalledAgents,
  listApprovedForSearch,
  listInstalled,
  publishSkillVersion,
} from '../marketplace/marketplaceDb.js'
import {
  seedPlatformGeneralAgents,
  seedPlatformResearchAgents,
} from '../marketplace/seedPlatformAgents.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'

let pgAvailable = false

const listPublicModels = () => [
  { id: 'deepseek-v4-flash' },
  { id: 'MiniMax-M3' },
  { id: 'glm-5.2' },
  { id: 'glm-5.3' },
]

const EXPECTED_SLUGS = ['research-assistant']
const DEPRECATED_SLUGS = ['research-analyst', 'research-writer']

/** 模拟旧平台 agent(合并前)已 approved+active,用于验证 seed 会下架它。 */
async function seedLegacyAgent(slug: string, owner: number): Promise<void> {
  const name = slug
  const manifest = {
    name,
    description: `${slug} legacy`,
    tags: ['科研'],
    version: '1.0.0',
    model: 'deepseek-v4-flash',
    toolsets: ['core', 'research'],
    skillDeps: [],
    persona: `你是 ${slug}(旧版)。`,
  }
  const raw = JSON.stringify(manifest)
  await publishSkillVersion({
    slug,
    ownerUserId: owner,
    version: '1.0.0',
    name,
    description: manifest.description,
    tags: manifest.tags,
    rawSkillMd: null,
    rawArtifact: raw,
    manifest,
    kind: 'agent',
    artifactHash: marketplaceArtifactHash(raw),
    embeddingHash: skillContentHash({ name, description: manifest.description, tags: manifest.tags }),
    riskFlags: [],
    policyVersion: 1,
    submittedBy: owner,
  })
  await approvePlatformVersion(slug, '1.0.0', marketplaceArtifactHash(raw))
}

/** 模拟 Stage A 稳定版已批准的编程助手,用于验证升级与回滚重新指针。 */
async function seedHistoricalCodingAssistant(owner: number): Promise<string> {
  const manifest = {
    name: '编程助手',
    description: '编程助手历史版本',
    tags: ['编程', '代码'],
    version: '1.0.1',
    model: 'kimi-k2.7-code',
    toolsets: ['core'],
    skillDeps: [],
    persona: '你是编程助手。',
  }
  const raw = JSON.stringify(manifest)
  const artifactHash = marketplaceArtifactHash(raw)
  await publishSkillVersion({
    slug: 'coding-assistant',
    ownerUserId: owner,
    version: manifest.version,
    name: manifest.name,
    description: manifest.description,
    tags: manifest.tags,
    rawSkillMd: null,
    rawArtifact: raw,
    manifest,
    kind: 'agent',
    artifactHash,
    embeddingHash: skillContentHash({
      name: manifest.name,
      description: manifest.description,
      tags: manifest.tags,
    }),
    riskFlags: [],
    policyVersion: 1,
    submittedBy: owner,
  })
  await approvePlatformVersion('coding-assistant', manifest.version, artifactHash)
  return artifactHash
}

async function createAdmin(email: string): Promise<number> {
  const r = await query<{ id: string }>(
    "INSERT INTO users(email, password_hash, credits, role, status) VALUES ($1,'stub',0,'admin','active') RETURNING id::text AS id",
    [email],
  )
  return Number.parseInt(r.rows[0].id, 10)
}
async function createUser(email: string): Promise<number> {
  const r = await query<{ id: string }>(
    "INSERT INTO users(email, password_hash, credits, role, status) VALUES ($1,'stub',0,'user','active') RETURNING id::text AS id",
    [email],
  )
  return Number.parseInt(r.rows[0].id, 10)
}
async function listCurrentAgentDefaults(
  slugs: string[],
): Promise<Record<string, { version: string; model: string }>> {
  const r = await query<{ slug: string; version: string; model: string }>(
    `SELECT l.slug, v.version, v.manifest->>'model' AS model
       FROM marketplace_skill_listings l
       JOIN marketplace_skill_versions v ON v.id = l.current_approved_version_id
      WHERE l.kind = 'agent' AND l.slug = ANY($1::text[])
      ORDER BY l.slug`,
    [slugs],
  )
  return Object.fromEntries(
    r.rows.map((row) => [row.slug, { version: row.version, model: row.model }]),
  )
}

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
    } catch {}
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
    } catch {}
    await closePool()
  }
})
beforeEach(async () => {
  if (!pgAvailable) return
  await query(
    'TRUNCATE TABLE marketplace_installs, marketplace_skill_versions, marketplace_skill_listings, users RESTART IDENTITY CASCADE',
  )
})
function skip(t: { skip: (r: string) => void }): boolean {
  if (!pgAvailable) {
    t.skip('pg not running')
    return true
  }
  return false
}

describe('seedPlatformResearchAgents (integ)', () => {
  test('无 admin → 跳过(不抛)', async (t) => {
    if (skip(t)) return
    const r = await seedPlatformResearchAgents({ listPublicModels })
    assert.equal(r.ownerUserId, null)
    assert.deepEqual(r.seeded, [])
    assert.ok(r.errors.some((e) => /no active admin/.test(e.error)))
  })

  test('无 pricing → 跳过(不抛)', async (t) => {
    if (skip(t)) return
    await createAdmin('a@x.com')
    const r = await seedPlatformResearchAgents({})
    assert.deepEqual(r.seeded, [])
    assert.ok(r.errors.some((e) => /no pricing/.test(e.error)))
  })

  test('seed → 科研助手成为已批准、可搜的 agent listing', async (t) => {
    if (skip(t)) return
    const admin = await createAdmin('admin@x.com')

    const r = await seedPlatformResearchAgents({ listPublicModels })
    assert.equal(r.ownerUserId, admin, 'owner 应为最早 active admin')
    assert.deepEqual(r.seeded.sort(), [...EXPECTED_SLUGS].sort(), 'manifest 合法 + 扫描通过 → seed')
    assert.deepEqual(r.errors, [], `不应有错误:${JSON.stringify(r.errors)}`)

    const agents = await listApprovedForSearch('agent')
    const slugs = agents.map((a) => a.slug).sort()
    assert.deepEqual(slugs, [...EXPECTED_SLUGS].sort(), '科研助手应可搜(approved + active)')

    // kind 隔离:不在 skill 目录(配合 search 默认 'skill' → v3 技能市场看不到)。
    const skills = await listApprovedForSearch('skill')
    assert.equal(
      skills.filter((s) => EXPECTED_SLUGS.includes(s.slug)).length,
      0,
      '科研 agent 不应出现在 skill 目录',
    )
  })

  test('废弃下架:旧的分析师/写手若存在 → seed 后被 revoke,只剩科研助手', async (t) => {
    if (skip(t)) return
    const admin = await createAdmin('admin@x.com')
    // 模拟合并前状态:两个旧 agent 已 approved+active。
    for (const slug of DEPRECATED_SLUGS) await seedLegacyAgent(slug, admin)
    assert.equal((await listApprovedForSearch('agent')).length, 2, '前置:两个旧 agent 在架')

    const r = await seedPlatformResearchAgents({ listPublicModels })
    assert.deepEqual(r.seeded, ['research-assistant'])
    assert.deepEqual(r.deprecated.sort(), [...DEPRECATED_SLUGS].sort(), '旧两个应被下架')

    const slugs = (await listApprovedForSearch('agent')).map((a) => a.slug).sort()
    assert.deepEqual(slugs, ['research-assistant'], '架上只剩科研助手(旧两个已 revoked)')
  })

  test('幂等:重复 seed 不重复发布,仍保持 approved', async (t) => {
    if (skip(t)) return
    await createAdmin('admin@x.com')

    const first = await seedPlatformResearchAgents({ listPublicModels })
    assert.deepEqual(first.seeded.sort(), [...EXPECTED_SLUGS].sort())

    const second = await seedPlatformResearchAgents({ listPublicModels })
    assert.deepEqual(second.seeded, [], '第二次不应重复发布')
    assert.deepEqual(second.skipped.sort(), [...EXPECTED_SLUGS].sort(), '第二次应全部 skip(已存在)')
    assert.deepEqual(second.errors, [])

    // 仍然只有一个 approved agent(没有重复 listing/version 残留)。
    const agents = await listApprovedForSearch('agent')
    assert.equal(agents.length, 1)
    const cnt = await query<{ n: string }>(
      "SELECT count(*)::text AS n FROM marketplace_skill_listings WHERE kind = 'agent' AND state = 'active'",
    )
    assert.equal(cnt.rows[0].n, '1')
  })

  test('channel 门控:agent 仅 v5 可装,v3 渠道拒装(NOT_INSTALLABLE)', async (t) => {
    if (skip(t)) return
    await createAdmin('admin@x.com')
    const installer = await createUser('inst@x.com')
    await seedPlatformResearchAgents({ listPublicModels })
    const agents = await listApprovedForSearch('agent')
    assert.equal(agents.length, 1)
    const versionId = agents[0].versionId

    const saved = process.env.OC_RUNTIME_CHANNEL
    try {
      // v3 渠道(或未设)→ agent 不可装。
      process.env.OC_RUNTIME_CHANNEL = 'v3'
      await assert.rejects(
        () => installApprovedVersion({ userId: installer, versionId }),
        (e: unknown) => e instanceof MarketplaceError && e.code === 'NOT_INSTALLABLE',
        'v3 渠道应拒装 agent',
      )
      // v5 渠道 → 可装。
      process.env.OC_RUNTIME_CHANNEL = 'v5'
      const r = await installApprovedVersion({ userId: installer, versionId })
      assert.equal(r.slug, agents[0].slug)
    } finally {
      // 还原(空串与未设在 marketplaceAgentsEnabled 下等价:都回落 'v3')。
      process.env.OC_RUNTIME_CHANNEL = saved ?? ''
    }
  })

  test('channel 门控读侧:v3 不返回已装 agent(防 my-agents/容器 sync 复活)', async (t) => {
    if (skip(t)) return
    await createAdmin('admin@x.com')
    const installer = await createUser('inst@x.com')
    await seedPlatformResearchAgents({ listPublicModels })
    const agents = await listApprovedForSearch('agent')
    const saved = process.env.OC_RUNTIME_CHANNEL
    try {
      // 在 v5 上装一个 agent。
      process.env.OC_RUNTIME_CHANNEL = 'v5'
      await installApprovedVersion({ userId: installer, versionId: agents[0].versionId })
      assert.equal((await listActiveInstalledAgents(installer)).length, 1, 'v5 应可见已装 agent')
      assert.equal(
        (await listInstalled(installer)).filter((r) => r.kind === 'agent').length,
        1,
        'v5 installed 应含 agent',
      )
      // 切到 v3:读侧应滤空(容器 sync reconcileAgents 不会复活、my-agents 不显示)。
      process.env.OC_RUNTIME_CHANNEL = 'v3'
      assert.equal(
        (await listActiveInstalledAgents(installer)).length,
        0,
        'v3 不应返回已装 agent(防容器复活)',
      )
      assert.equal(
        (await listInstalled(installer)).filter((r) => r.kind === 'agent').length,
        0,
        'v3 installed 应滤掉 agent',
      )
    } finally {
      process.env.OC_RUNTIME_CHANNEL = saved ?? ''
    }
  })

  test('model 不在 public 集 → 该 agent 报错跳过(不污染目录)', async (t) => {
    if (skip(t)) return
    await createAdmin('admin@x.com')
    // 不提供 deepseek-v4-flash → 科研助手的 model 不在白名单。
    const r = await seedPlatformResearchAgents({
      listPublicModels: () => [{ id: 'glm-5.2' }],
    })
    assert.deepEqual(r.seeded, [], 'model 不合法 → 不应 seed')
    assert.equal(r.errors.length, 1, '科研助手因 model 报错')
    assert.ok(r.errors.every((e) => /invalid manifest/.test(e.error)))
    const agents = await listApprovedForSearch('agent')
    assert.equal(agents.length, 0, '失败的 seed 不应留下任何 listing')
  })
})

describe('seedPlatformGeneralAgents (integ) — 办公助手 + 编程助手', () => {
  const GENERAL_SLUGS = ['coding-assistant', 'office-assistant']

  test('seed → 通用 agent(办公+编程)成为已批准、可搜的 agent listing(无条件,不依赖 research_config)', async (t) => {
    if (skip(t)) return
    const admin = await createAdmin('admin@x.com')
    const r = await seedPlatformGeneralAgents({ listPublicModels })
    assert.equal(r.ownerUserId, admin, 'owner 应为最早 active admin')
    assert.deepEqual(r.seeded.sort(), [...GENERAL_SLUGS].sort(), 'manifest 合法 + 扫描通过 → seed')
    assert.deepEqual(r.errors, [], `不应有错误:${JSON.stringify(r.errors)}`)

    const agents = await listApprovedForSearch('agent')
    assert.deepEqual(
      agents.map((a) => a.slug).sort(),
      [...GENERAL_SLUGS].sort(),
      '通用 agent(办公+编程)应可搜',
    )
    assert.deepEqual(
      await listCurrentAgentDefaults(GENERAL_SLUGS),
      {
        'coding-assistant': { version: '1.0.3', model: 'glm-5.3' },
        'office-assistant': { version: '1.0.1', model: 'MiniMax-M3' },
      },
      '当前 approved 版本应体现不同助手的默认模型(办公 MiniMax,编程 GLM-5.3 Coding Plan)',
    )

    // kind 隔离:通用 agent 不进 skill 目录。
    const skills = await listApprovedForSearch('skill')
    assert.equal(
      skills.filter((s) => GENERAL_SLUGS.includes(s.slug)).length,
      0,
      '通用 agent 不应出现在 skill 目录',
    )
  })

  test('幂等:重复 seed 不重复发布,仍保持 approved', async (t) => {
    if (skip(t)) return
    await createAdmin('admin@x.com')
    const first = await seedPlatformGeneralAgents({ listPublicModels })
    assert.deepEqual(first.seeded.sort(), [...GENERAL_SLUGS].sort())
    const second = await seedPlatformGeneralAgents({ listPublicModels })
    assert.deepEqual(second.seeded, [], '第二次不应重复发布')
    assert.deepEqual(second.skipped.sort(), [...GENERAL_SLUGS].sort(), '第二次应全部 skip')
    assert.deepEqual(second.errors, [])
  })

  test('领导者重新 seed 会走完整幂等路径把 current 指回自身版本', async (t) => {
    if (skip(t)) return
    const admin = await createAdmin('admin@x.com')
    const historicalHash = await seedHistoricalCodingAssistant(admin)
    assert.deepEqual(await listCurrentAgentDefaults(['coding-assistant']), {
      'coding-assistant': { version: '1.0.1', model: 'kimi-k2.7-code' },
    })

    const upgraded = await seedPlatformGeneralAgents({ listPublicModels })
    assert.deepEqual(upgraded.errors, [])
    assert.deepEqual(await listCurrentAgentDefaults(['coding-assistant']), {
      'coding-assistant': { version: '1.0.3', model: 'glm-5.3' },
    })

    const versionsAfterUpgrade = await query<{ version: string; status: string }>(
      `SELECT version, status
         FROM marketplace_skill_versions
        WHERE slug = 'coding-assistant'
        ORDER BY version`,
    )
    assert.deepEqual(versionsAfterUpgrade.rows, [
      { version: '1.0.1', status: 'approved' },
      { version: '1.0.3', status: 'approved' },
    ])

    // 模拟另一 release 取得领导权并把共享 current 指向自己的版本；随后重新调用当前 release
    // 的真实 seed 入口，覆盖 validate/scan/DUPLICATE_VERSION/approve 全链，而非直接重指回来。
    await approvePlatformVersion('coding-assistant', '1.0.1', historicalHash)
    assert.deepEqual(await listCurrentAgentDefaults(['coding-assistant']), {
      'coding-assistant': { version: '1.0.1', model: 'kimi-k2.7-code' },
    })

    const reacquired = await seedPlatformGeneralAgents({ listPublicModels })
    assert.deepEqual(reacquired.errors, [])
    assert.ok(reacquired.skipped.includes('coding-assistant'), '已存在版本应走 DUPLICATE 幂等分支')
    assert.deepEqual(await listCurrentAgentDefaults(['coding-assistant']), {
      'coding-assistant': { version: '1.0.3', model: 'glm-5.3' },
    })
    assert.equal(
      (
        await query<{ n: string }>(
          "SELECT count(*)::text AS n FROM marketplace_skill_versions WHERE slug = 'coding-assistant'",
        )
      ).rows[0].n,
      '2',
      '重新 seed 只重指 current,两个不可变版本都应保留',
    )
  })

  test('两条入口叠加:市场同时有科研助手 + 办公助手 + 编程助手(互不干扰)', async (t) => {
    if (skip(t)) return
    await createAdmin('admin@x.com')
    await seedPlatformResearchAgents({ listPublicModels })
    await seedPlatformGeneralAgents({ listPublicModels })
    const slugs = (await listApprovedForSearch('agent')).map((a) => a.slug).sort()
    assert.deepEqual(
      slugs,
      ['coding-assistant', 'office-assistant', 'research-assistant'],
      '三类平台 agent 应并存',
    )
  })
})
