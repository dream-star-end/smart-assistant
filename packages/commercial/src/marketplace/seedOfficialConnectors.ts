import { assertPluginAvailable, configurePluginCatalog } from '../plugins/catalogPolicy.js'
import { assertFlavorIdentity } from '../flavor/assertFlavor.js'
/**
 * 平台官方**市场**连接器的发布 seed(OCV5-402,首个是 `bili`)。只上 AI 市场、不预装。
 *
 * 走连接器审核流程,不旁路:
 *   ① 编译 spec + SecurityDecision(与审核签名同一个编译器),出权限摘要;
 *   ② 静态安全扫描:工件本身 + 商品页文案(与 prepareConnectorPublish 同一扫描器);
 *   ③ 实测(live functional verification):用刚编译出的契约,经引擎唯一 HTTP 出口把每个动作对真实上游
 *      跑一遍,全部 code=0 且有数据才算通过 —— 这就是人审路径要求的「隔离实测」证明,不是凭空打勾;
 *   ④ 以 pending 版本发布(版本号取代码常量,如 1.0.0;不进 AI 队列);
 *   ⑤ 系统审核员(active admin,≠ 作者)在一个事务里完成编译签名 + 功能验收留痕 + 上架。
 *
 * `dryRun` 只做 ①②③,不写库。重复执行:同一版本已上架则是 noop;库里同版本工件不同则 fail-closed。
 */

import { skillContentHash } from '@openclaude/storage'
import type { Pool } from 'pg'
import { ensureConnectorSeedPrincipals } from '../connectors/declarativeSeed.js'
import { type EngineHttpDeps, engineHttpRequest } from '../connectors/engine/driver.js'
import { validateDeclarativeParams } from '../connectors/engine/params.js'
import {
  OFFICIAL_MARKET_CONNECTORS,
  type OfficialMarketConnector,
} from '../connectors/official/index.js'
import { canonicalBytes } from '../connectors/spec/canonical.js'
import { compileSpec } from '../connectors/spec/compiler.js'
import type { ExecContractT } from '../connectors/spec/types.js'
import { getPool } from '../db/index.js'
import { tx } from '../db/queries.js'
import { approveMarketplaceConnectorVersionWithRunner } from './connectorReview.js'
import { MarketplaceError, publishOfficialMarketConnectorVersion } from './marketplaceDb.js'
import { humanMetaScanBody, parseHumanMeta } from './marketplaceMeta.js'
import { scanSkillArtifact } from './skillScanner.js'

export interface LiveCheck {
  action: string
  ok: boolean
  /** 只记录形状(条数、业务码),不记录内容。 */
  detail: string
}

export interface OfficialConnectorSeedReport {
  slug: string
  version: string
  artifactHash: string
  execContractHash: string
  permissionSummary: {
    authMode: string
    apiOrigins: string[]
    actions: Array<{ id: string; method: string; effect: string; builtins: string[] }>
  }
  scan: { blocked: boolean; flags: number; policyVersion: number }
  live: LiveCheck[]
  outcome: 'dry-run' | 'published' | 'noop'
  versionId?: string
}

/** 每个官方连接器的实测剧本:按顺序跑,后一步可以用前一步的结果拿参数。 */
type LivePlan = (
  run: (action: string, params: Record<string, unknown>) => Promise<unknown>,
) => Promise<LiveCheck[]>

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {}
}

function arrLen(v: unknown): number {
  return Array.isArray(v) ? v.length : -1
}

const BILI_LIVE_PLAN: LivePlan = async (run) => {
  const checks: LiveCheck[] = []
  const check = (action: string, ok: boolean, detail: string) => {
    checks.push({ action, ok, detail })
    return ok
  }
  const pop = asRecord(await run('popular', { ps: 3 }))
  const popList = asRecord(pop.data).list
  check('popular', pop.code === 0 && arrLen(popList) > 0, `code=${pop.code} n=${arrLen(popList)}`)
  const first = asRecord(Array.isArray(popList) ? popList[0] : undefined)
  const bvid = typeof first.bvid === 'string' ? first.bvid : ''

  const rank = asRecord(await run('rank', {}))
  const rankList = asRecord(rank.data).list
  check('rank', rank.code === 0 && arrLen(rankList) > 0, `code=${rank.code} n=${arrLen(rankList)}`)

  const search = asRecord(await run('search', { keyword: '科技' }))
  const hits = asRecord(search.data).result
  check('search', search.code === 0 && arrLen(hits) > 0, `code=${search.code} n=${arrLen(hits)}`)

  const video = asRecord(await run('video', { bvid }))
  const vd = asRecord(video.data)
  check(
    'video',
    video.code === 0 && typeof vd.aid === 'number' && typeof vd.cid === 'number',
    `code=${video.code} pages=${arrLen(vd.pages)}`,
  )

  const comments = asRecord(await run('comments', { oid: vd.aid, mode: 3 }))
  const replies = asRecord(comments.data).replies
  check(
    'comments',
    comments.code === 0 && arrLen(replies) >= 0,
    `code=${comments.code} n=${arrLen(replies)}`,
  )

  const dm = asRecord(await run('danmaku', { cid: vd.cid }))
  check(
    'danmaku',
    dm.code === 0 && dm.cid === vd.cid && typeof dm.total === 'number' && arrLen(dm.density) >= 0,
    `code=${dm.code} total=${String(dm.total)} n=${arrLen(dm.items)}`,
  )
  return checks
}

const LIVE_PLANS: Readonly<Record<string, LivePlan>> = { bili: BILI_LIVE_PLAN }

function soleOrigin(contract: ExecContractT): string {
  const origins = contract.credentialAudiencePolicy.apiOrigins
  if (origins.length !== 1) throw new Error('official connector must have exactly one api origin')
  return origins[0]!
}

async function liveVerify(
  official: OfficialMarketConnector,
  contract: ExecContractT,
  deps: EngineHttpDeps | undefined,
): Promise<LiveCheck[]> {
  const plan = LIVE_PLANS[official.slug]
  if (plan === undefined) throw new Error(`no live verification plan for ${official.slug}`)
  const targetOrigin = soleOrigin(contract)
  const covered = new Set<string>()
  const checks = await plan(async (actionId, params) => {
    const action = contract.actions.find((a) => a.id === actionId)
    if (action === undefined) throw new Error(`live plan references unknown action ${actionId}`)
    covered.add(actionId)
    return engineHttpRequest({
      contract,
      action,
      credentialAudience: 'api',
      targetOrigin,
      resolvedCreds: {},
      params: validateDeclarativeParams(action, params),
      deps,
    })
  })
  // 每个动作都必须被实测覆盖,少一个就不算验证过。
  for (const a of contract.actions)
    if (!covered.has(a.id)) checks.push({ action: a.id, ok: false, detail: 'not exercised' })
  return checks
}

export interface SeedOfficialConnectorOptions {
  slug: string
  dryRun?: boolean
  deps?: EngineHttpDeps
  env?: NodeJS.ProcessEnv
  pool?: Pool
}

export async function seedOfficialMarketConnector(
  opts: SeedOfficialConnectorOptions,
): Promise<OfficialConnectorSeedReport> {
  configurePluginCatalog(assertFlavorIdentity())
  assertPluginAvailable(opts.slug)
  const official = OFFICIAL_MARKET_CONNECTORS.find((c) => c.slug === opts.slug)
  if (official === undefined) throw new Error(`unknown official connector ${opts.slug}`)

  // ① 编译 + 权限摘要
  const compiled = compileSpec(official.spec, official.decision)
  const contract = compiled.execContract
  const permissionSummary = {
    authMode: contract.authMode,
    apiOrigins: [...contract.credentialAudiencePolicy.apiOrigins],
    actions: contract.actions.map((a) => ({
      id: a.id,
      method: a.request.method,
      effect: a.effect,
      builtins: [a.requestTransform, a.resultTransform].filter((x): x is string => !!x),
    })),
  }

  // ② 静态扫描(工件 + 商品页文案)
  const humanMeta = parseHumanMeta({
    category: official.listing.category,
    useCases: [...official.listing.useCases],
    outcomeExamples: [...official.listing.outcomeExamples],
    humanMd: official.listing.humanMd,
  })
  const rawArtifact = canonicalBytes(official.spec).toString('utf8')
  const tags = [...official.listing.tags]
  const scan = scanSkillArtifact({
    name: official.listing.name,
    description: official.listing.description,
    tags,
    body: rawArtifact,
  })
  const metaScan = scanSkillArtifact({
    name: official.listing.name,
    description: '',
    tags: [],
    body: humanMetaScanBody(humanMeta),
  })
  const scanSummary = {
    blocked: scan.blocked || metaScan.blocked,
    flags: scan.flags.length + metaScan.flags.length,
    policyVersion: scan.policyVersion,
  }
  const base = {
    slug: official.slug,
    version: official.version,
    artifactHash: compiled.specHash,
    execContractHash: compiled.execContractHash,
    permissionSummary,
    scan: scanSummary,
  }
  if (scanSummary.blocked) throw new Error(`static scan blocked ${official.slug}`)

  // ③ 实测
  const live = await liveVerify(official, contract, opts.deps)
  if (live.some((c) => !c.ok)) {
    const failed = live.filter((c) => !c.ok).map((c) => `${c.action}(${c.detail})`)
    throw new Error(`live verification failed: ${failed.join(', ')}`)
  }
  if (opts.dryRun) return { ...base, live, outcome: 'dry-run' }

  // ④ 发布 pending 版本 + ⑤ 审核上架
  const pool = opts.pool ?? getPool()
  const { author, reviewer } = await ensureConnectorSeedPrincipals(pool)
  let versionId: string
  try {
    versionId = (
      await publishOfficialMarketConnectorVersion({
        slug: official.slug,
        version: official.version,
        ownerUserId: author,
        name: official.listing.name,
        description: official.listing.description,
        tags,
        rawSkillMd: null,
        rawArtifact,
        artifactHash: compiled.specHash,
        embeddingHash: skillContentHash({
          name: official.listing.name,
          description: official.listing.description,
          tags,
          use_cases: humanMeta.useCases,
        }),
        riskFlags: [...scan.flags, ...metaScan.flags],
        policyVersion: scan.policyVersion,
        submittedBy: author,
        kind: 'connector',
        pluginType: 'declarative-http',
        category: humanMeta.category,
        useCases: humanMeta.useCases,
        outcomeExamples: humanMeta.outcomeExamples,
        humanMd: humanMeta.humanMd,
        queueAiReview: false,
      })
    ).versionId
  } catch (e) {
    if (!(e instanceof MarketplaceError && e.code === 'DUPLICATE_VERSION')) throw e
    const r = await pool.query<{ id: string; artifact_hash: string; submitted_by: string }>(
      `SELECT id::text, artifact_hash, submitted_by::text
         FROM marketplace_skill_versions WHERE slug = $1 AND version = $2`,
      [official.slug, official.version],
    )
    const row = r.rows[0]
    if (!row || row.artifact_hash !== compiled.specHash || Number(row.submitted_by) !== author)
      throw new Error(`official connector seed collision: ${official.slug}@${official.version}`)
    versionId = row.id
  }

  const before = await pool.query<{ status: string; current: string | null; state: string }>(
    `SELECT v.status, l.current_approved_version_id::text AS current, l.state
       FROM marketplace_skill_versions v JOIN marketplace_skill_listings l ON l.slug = v.slug
      WHERE v.id = $1`,
    [versionId],
  )
  const b = before.rows[0]
  const alreadyLive = b?.status === 'approved' && b.current === versionId && b.state === 'active'

  await tx(async (client) => {
    await approveMarketplaceConnectorVersionWithRunner(
      {
        versionId,
        reviewerUserId: reviewer,
        securityDecision: official.decision,
        expectedSpecHash: compiled.specHash,
        functionalVerified: true,
        functionalVerificationMode: 'live',
        note: `official market connector seed; live verification ${live
          .map((c) => `${c.action}:${c.detail}`)
          .join('; ')}`.slice(0, 1000),
        source: 'human',
        env: opts.env,
      },
      client,
    )
  }, pool)

  return { ...base, live, outcome: alreadyLive ? 'noop' : 'published', versionId }
}
