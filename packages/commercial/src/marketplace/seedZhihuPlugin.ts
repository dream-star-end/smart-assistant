/** Idempotent version-controlled publication of the official Zhihu Plugin. */

import { skillContentHash } from '@openclaude/storage'

import { canonicalBytes } from '../connectors/spec/canonical.js'
import { getPool } from '../db/index.js'
import { query } from '../db/queries.js'
import type { PluginLeaseRedis } from '../plugins/accountLease.js'
import {
  OFFICIAL_MANAGED_BROWSER_TRANSITION_GATE_REASON,
  type OfficialManagedBrowserTransitionScope,
  openOfficialManagedBrowserPluginListingGate,
  transitionOfficialManagedBrowserPluginVersion,
} from '../plugins/officialManagedBrowserTransition.js'
import {
  approveOfficialRuntimePluginVersion,
  loadVerifiedRuntimePluginContract,
} from '../plugins/review.js'
import {
  COMPILED_ZHIHU_PLUGIN,
  ZHIHU_PLUGIN_ARTIFACT,
  ZHIHU_PLUGIN_SLUG,
  ZHIHU_PLUGIN_VERSION,
} from '../plugins/zhihuContract.js'
import { MarketplaceError, publishOfficialZhihuVersion } from './marketplaceDb.js'
import { scanSkillArtifact } from './skillScanner.js'

const OFFICIAL_NAME = '知乎'
const OFFICIAL_DESCRIPTION =
  '通过隔离受管浏览器和知乎网页界面，搜索并读取问题、回答、文章、热榜、用户创作、收藏、通知和评论；开启写入后默认逐次确认，也可另行授权免确认执行提问、回答、文章、评论回复、编辑删除、赞同、收藏和关注。只读取用户可见 DOM，不读取或重放网页接口响应。扫码状态加密保存；遇到验证码或风控立即停止。该 Plugin 非知乎官方产品，网页自动化可能受知乎平台规则限制。'
const OFFICIAL_TAGS = ['知乎', '知识社区', '内容检索', '内容创作', '消息通知', '网页自动化']
const OFFICIAL_USE_CASES = [
  '搜索知乎问题、回答和文章，或查看当前热榜',
  '读取问题详情、回答正文、文章正文及分页评论',
  '读取指定用户公开资料和公开创作',
  '查看当前账号可见的收藏内容与通知',
  '默认逐次确认；账号单独授权后可提问、回答或发布文章',
  '默认逐次确认；账号单独授权后可编辑或永久删除自己的回答和文章',
  '默认逐次确认；账号单独授权后可评论、回复或永久删除自己的评论',
  '默认逐次确认；账号单独授权后可设置回答/评论赞同、回答/文章收藏及用户/问题关注状态',
]

interface LocatedVersion {
  id: string
  owner_user_id: string
  submitted_by: string
  status: string
  ai_review_state: string | null
  review_source: string | null
  kind: string
  plugin_type: string | null
  listing_state: string
  revoked_reason: string | null
  current_approved_version_id: string | null
}

export interface SeedZhihuPluginResult {
  ownerUserId: number
  versionId: string
  published: boolean
  migratedPluginInstalls: number
  migratedPluginAccounts: number
}

export function assertZhihuUpgradeVerificationScope(
  scope: OfficialManagedBrowserTransitionScope,
  verificationUserId: number,
  sourceArtifactHash: string,
  sourceExecContractHash: string,
): void {
  const currentVersionId = scope.currentVersionId
  const account = scope.accounts.find((row) => row.userId === verificationUserId)
  if (
    !currentVersionId ||
    scope.installs.length === 0 ||
    scope.accounts.length === 0 ||
    !scope.installs.some((row) => row.userId === verificationUserId) ||
    scope.installs.some(
      (row) => row.versionId !== currentVersionId || row.artifactHash !== sourceArtifactHash,
    ) ||
    !account ||
    scope.accounts.some(
      (row) =>
        row.versionId !== currentVersionId ||
        row.status !== 'active' ||
        row.specHash !== sourceArtifactHash ||
        row.execContractHash !== sourceExecContractHash,
    )
  )
    throw new Error(
      'Zhihu upgrade scope must contain exact current installs/accounts and the verified active account',
    )
}

async function locateVersion(): Promise<LocatedVersion | null> {
  const row = await query<LocatedVersion>(
    `SELECT v.id::text, l.owner_user_id::text, v.submitted_by::text,
            v.status, v.ai_review_state, v.review_source,
            l.kind, l.plugin_type, l.state AS listing_state, l.revoked_reason,
            l.current_approved_version_id::text
       FROM marketplace_skill_versions v
       JOIN marketplace_skill_listings l ON l.slug = v.slug
      WHERE v.slug = $1 AND v.version = $2
      LIMIT 1`,
    [ZHIHU_PLUGIN_SLUG, ZHIHU_PLUGIN_VERSION],
  )
  return row.rows[0] ?? null
}

function ownerFromLocatedVersion(row: LocatedVersion): number {
  const ownerUserId = Number(row.owner_user_id)
  if (
    !Number.isSafeInteger(ownerUserId) ||
    ownerUserId <= 0 ||
    row.submitted_by !== row.owner_user_id ||
    row.kind !== 'connector' ||
    row.plugin_type !== 'managed-browser' ||
    row.listing_state === 'revoked' ||
    !(
      (row.status === 'approved' && row.review_source === 'platform') ||
      (row.status === 'pending' && row.ai_review_state === null)
    )
  )
    throw new Error('Zhihu Plugin slug/version lacks platform seed provenance')
  return ownerUserId
}

function configuredOwner(env: NodeJS.ProcessEnv): number | null {
  const raw = env.OPENCLAUDE_PLATFORM_OWNER_USER_ID
  if (raw === undefined || raw === '') return null
  if (!/^\d{1,16}$/.test(raw)) throw new Error('OPENCLAUDE_PLATFORM_OWNER_USER_ID is invalid')
  const ownerUserId = Number(raw)
  if (!Number.isSafeInteger(ownerUserId) || ownerUserId <= 0)
    throw new Error('OPENCLAUDE_PLATFORM_OWNER_USER_ID is invalid')
  return ownerUserId
}

async function initialOwner(): Promise<number> {
  const row = await query<{ id: string }>(
    "SELECT id::text FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id ASC LIMIT 1",
  )
  const ownerUserId = Number(row.rows[0]?.id)
  if (!Number.isSafeInteger(ownerUserId) || ownerUserId <= 0)
    throw new Error('Zhihu Plugin seed requires an active admin owner')
  return ownerUserId
}

async function recordedListingOwner(env: NodeJS.ProcessEnv): Promise<number | null> {
  const row = await query<{
    owner_user_id: string
    kind: string
    plugin_type: string | null
    listing_state: string
    version_id: string | null
    version_status: string | null
    review_source: string | null
  }>(
    `SELECT l.owner_user_id::text, l.kind, l.plugin_type, l.state AS listing_state,
            v.id::text AS version_id, v.status AS version_status, v.review_source
       FROM marketplace_skill_listings l
       LEFT JOIN marketplace_skill_versions v ON v.id = l.current_approved_version_id
      WHERE l.slug = $1`,
    [ZHIHU_PLUGIN_SLUG],
  )
  const listing = row.rows[0]
  if (!listing) return null
  const ownerUserId = Number(listing.owner_user_id)
  if (
    !Number.isSafeInteger(ownerUserId) ||
    ownerUserId <= 0 ||
    listing.kind !== 'connector' ||
    listing.plugin_type !== 'managed-browser' ||
    !['active', 'unlisted'].includes(listing.listing_state) ||
    !listing.version_id ||
    listing.version_status !== 'approved' ||
    listing.review_source !== 'platform'
  )
    throw new Error('Zhihu Plugin slug is not a trusted platform listing')
  const verified = await loadVerifiedRuntimePluginContract(Number(listing.version_id), getPool(), {
    env,
    allowUnlisted: true,
  }).catch(() => null)
  if (!verified || verified.pluginType !== 'managed-browser' || verified.slug !== ZHIHU_PLUGIN_SLUG)
    throw new Error('Zhihu Plugin recorded owner trust verification failed')
  return ownerUserId
}

export async function findApprovedZhihuPlugin(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ versionId: string; ownerUserId: number } | null> {
  const row = await locateVersion()
  if (
    !row ||
    row.status !== 'approved' ||
    row.review_source !== 'platform' ||
    row.listing_state !== 'active' ||
    row.current_approved_version_id !== row.id
  )
    return null
  const verified = await loadVerifiedRuntimePluginContract(Number(row.id), getPool(), {
    env,
  }).catch(() => null)
  if (
    !verified ||
    verified.pluginType !== 'managed-browser' ||
    verified.slug !== ZHIHU_PLUGIN_SLUG ||
    verified.artifactHash !== COMPILED_ZHIHU_PLUGIN.artifactHash ||
    verified.execContractHash !== COMPILED_ZHIHU_PLUGIN.execContractHash
  )
    return null
  return { versionId: row.id, ownerUserId: ownerFromLocatedVersion(row) }
}

export async function seedZhihuPlugin(input: {
  functionalVerified: true
  ownerUserId?: number
  env?: NodeJS.ProcessEnv
  leaseRedis?: PluginLeaseRedis | null
  /** Upgrade-only scope proven by exact-image read smoke; never inferred by the seed itself. */
  expectedScope?: OfficialManagedBrowserTransitionScope
  beforeListingOpen?: (target: { versionId: string }) => Promise<void>
}): Promise<SeedZhihuPluginResult> {
  if (input.functionalVerified !== true)
    throw new Error('Zhihu Plugin requires live functional verification')
  const env = input.env ?? process.env
  let located = await locateVersion()
  const recordedOwner = located ? ownerFromLocatedVersion(located) : await recordedListingOwner(env)
  const requestedOwner = input.ownerUserId ?? configuredOwner(env)
  if (recordedOwner !== null && requestedOwner !== null && recordedOwner !== requestedOwner)
    throw new Error('Zhihu Plugin platform owner configuration drifted')
  const ownerUserId = recordedOwner ?? requestedOwner ?? (await initialOwner())
  const rawArtifact = canonicalBytes(ZHIHU_PLUGIN_ARTIFACT).toString('utf8')
  const scan = scanSkillArtifact({
    name: OFFICIAL_NAME,
    description: OFFICIAL_DESCRIPTION,
    tags: OFFICIAL_TAGS,
    body: rawArtifact,
  })
  if (scan.blocked) throw new Error('official Zhihu Plugin failed static scan')

  let published = false
  if (located && BigInt(located.owner_user_id) !== BigInt(ownerUserId))
    throw new Error('Zhihu Plugin slug/version is owned by another user')
  if (!located) {
    try {
      const created = await publishOfficialZhihuVersion({
        slug: ZHIHU_PLUGIN_SLUG,
        ownerUserId,
        version: ZHIHU_PLUGIN_VERSION,
        name: OFFICIAL_NAME,
        description: OFFICIAL_DESCRIPTION,
        tags: OFFICIAL_TAGS,
        rawSkillMd: null,
        rawArtifact,
        artifactHash: COMPILED_ZHIHU_PLUGIN.artifactHash,
        embeddingHash: skillContentHash({
          name: OFFICIAL_NAME,
          description: OFFICIAL_DESCRIPTION,
          tags: OFFICIAL_TAGS,
          use_cases: OFFICIAL_USE_CASES,
        }),
        riskFlags: scan.flags,
        policyVersion: scan.policyVersion,
        submittedBy: ownerUserId,
        kind: 'connector',
        pluginType: 'managed-browser',
        category: 'daily-tools',
        useCases: OFFICIAL_USE_CASES,
        outcomeExamples: [
          '按关键词搜索知乎问题、回答和文章，再读取指定正文与评论',
          '汇总知乎热榜或指定用户近期公开创作并继续分析',
          '分页查看当前账号收藏内容和通知，不以摘要替代真实条目',
          '默认经逐次确认提问、回答或发布文章；账号单独授权后可免确认',
          '默认经逐次确认编辑或永久删除自己的回答、文章和评论，并在点击前复核目标快照',
          '默认经逐次确认评论、回复、赞同、收藏或关注；账号单独授权后可免确认并保留写入账本',
        ],
        humanMd:
          '平台提供的知乎网页自动化 Plugin，但不是知乎官方产品。它只操纵浏览器中用户可见的知乎 DOM，不调用开放接口，不读取、解析、记录或重放网页接口响应。安装后使用知乎 App 扫码登录，账号状态加密保存。收藏、通知等账号内数据可能并非公开信息，只按用户请求返回并视为不可信外部内容。默认只读；写入须先开启账号写能力，且默认每一次写操作都在对话确认卡中单独批准。用户可另行接受独立的账号级高风险声明后开启免逐次确认；该授权默认关闭，关闭写入也会使它失效。编辑、删除和回复使用服务端封存的精确目标快照，并在首次不可逆点击前重新读取复核；赞同、收藏和关注按目标状态执行。所有写入都保留加密账本和派发围栏。网页出现验证码、风控或身份异常时立即停止，绝不尝试绕过；结果不明确时绝不自动重试。知乎现行服务协议或平台规则可能限制自动化访问，使用者应自行确认有权使用并承担相关账号风险。',
        queueAiReview: false,
      })
      located = await locateVersion()
      if (located?.id !== created.versionId)
        throw new Error('Zhihu Plugin published version lookup drifted')
      published = true
    } catch (error) {
      if (!(error instanceof MarketplaceError && error.code === 'DUPLICATE_VERSION')) throw error
      located = await locateVersion()
    }
  }
  if (!located || ownerFromLocatedVersion(located) !== ownerUserId)
    throw new Error('Zhihu Plugin seed target is missing or foreign')

  await approveOfficialRuntimePluginVersion({
    versionId: located.id,
    ownerUserId,
    expectedArtifactHash: COMPILED_ZHIHU_PLUGIN.artifactHash,
    functionalVerified: true,
    activateListing: false,
    env,
    pool: getPool(),
  })
  const transition = await transitionOfficialManagedBrowserPluginVersion({
    slug: ZHIHU_PLUGIN_SLUG,
    targetVersionId: located.id,
    expectedArtifactHash: COMPILED_ZHIHU_PLUGIN.artifactHash,
    expectedExecContractHash: COMPILED_ZHIHU_PLUGIN.execContractHash,
    ownerUserId,
    env,
    pool: getPool(),
    redis: input.leaseRedis,
    ...(input.expectedScope ? { expectedScope: input.expectedScope } : {}),
    ...(input.beforeListingOpen ? { openListingAtCommit: false } : {}),
  })
  if (input.beforeListingOpen) {
    await input.beforeListingOpen({ versionId: located.id })
    await openOfficialManagedBrowserPluginListingGate({
      slug: ZHIHU_PLUGIN_SLUG,
      expectedVersionId: located.id,
      expectedArtifactHash: COMPILED_ZHIHU_PLUGIN.artifactHash,
      expectedExecContractHash: COMPILED_ZHIHU_PLUGIN.execContractHash,
      env,
      pool: getPool(),
    })
  }
  const trusted = await findApprovedZhihuPlugin(env)
  if (!trusted || trusted.versionId !== located.id || trusted.ownerUserId !== ownerUserId)
    throw new Error('Zhihu Plugin approval failed exact trust verification')
  return {
    ownerUserId,
    versionId: located.id,
    published,
    migratedPluginInstalls: transition.migratedInstalls,
    migratedPluginAccounts: transition.migratedAccounts,
  }
}

export async function findApprovedZhihuPluginForDeploy(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ versionId: string; ownerUserId: number } | null> {
  const row = await locateVersion()
  if (!row) return null
  if (
    row.status !== 'approved' ||
    row.review_source !== 'platform' ||
    row.current_approved_version_id !== row.id ||
    !(
      row.listing_state === 'active' ||
      (row.listing_state === 'unlisted' &&
        row.revoked_reason === OFFICIAL_MANAGED_BROWSER_TRANSITION_GATE_REASON)
    )
  )
    return null
  const verified = await loadVerifiedRuntimePluginContract(Number(row.id), getPool(), {
    env,
    allowUnlisted: true,
  })
  if (
    verified.pluginType !== 'managed-browser' ||
    verified.slug !== ZHIHU_PLUGIN_SLUG ||
    verified.artifactHash !== COMPILED_ZHIHU_PLUGIN.artifactHash ||
    verified.execContractHash !== COMPILED_ZHIHU_PLUGIN.execContractHash
  )
    throw new Error('Zhihu Plugin deploy approval trust mismatch')
  return { versionId: row.id, ownerUserId: ownerFromLocatedVersion(row) }
}
