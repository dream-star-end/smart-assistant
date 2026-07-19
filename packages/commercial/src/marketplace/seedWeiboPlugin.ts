/** Idempotent version-controlled publication of the official Weibo Plugin. */

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
  COMPILED_WEIBO_PLUGIN,
  WEIBO_PLUGIN_ARTIFACT,
  WEIBO_PLUGIN_SLUG,
  WEIBO_PLUGIN_VERSION,
} from '../plugins/weiboContract.js'
import { MarketplaceError, publishOfficialWeiboVersion } from './marketplaceDb.js'
import { scanSkillArtifact } from './skillScanner.js'

const OFFICIAL_NAME = '微博'
const OFFICIAL_DESCRIPTION =
  '通过隔离受管浏览器和微博公开网页界面，读取账号资料、首页与用户微博、正文、评论和搜索结果；开启写入后默认逐次确认，也可由用户另行接受账号级高风险声明后免确认执行发布、编辑、删除、评论、回复、转发、点赞和关注。无需购买微博开放平台套餐，不读取或重放网页接口响应。扫码登录状态加密保存；遇到验证码或风控立即停止。'
const OFFICIAL_TAGS = ['微博', '社交媒体', '内容检索', '内容发布', '网页自动化']
const OFFICIAL_USE_CASES = [
  '读取当前账号、指定用户资料与主页微博',
  '查看首页时间线、微博正文和当前页面评论',
  '按关键词搜索公开微博',
  '默认逐次确认；账号单独授权后可发布文字或最多九张图片的微博',
  '默认逐次确认；账号单独授权后可编辑或永久删除自己发布的微博',
  '默认逐次确认；账号单独授权后可评论、回复或删除自己的评论与回复',
  '默认逐次确认；账号单独授权后可转发微博并设置点赞或关注的目标状态',
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

export interface SeedWeiboPluginResult {
  ownerUserId: number
  versionId: string
  published: boolean
  migratedPluginInstalls: number
  migratedPluginAccounts: number
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
    [WEIBO_PLUGIN_SLUG, WEIBO_PLUGIN_VERSION],
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
    throw new Error('Weibo Plugin slug/version lacks platform seed provenance')
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
    throw new Error('Weibo Plugin seed requires an active admin owner')
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
    [WEIBO_PLUGIN_SLUG],
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
    throw new Error('Weibo Plugin slug is not a trusted platform listing')
  const verified = await loadVerifiedRuntimePluginContract(Number(listing.version_id), getPool(), {
    env,
    allowUnlisted: true,
  }).catch(() => null)
  if (!verified || verified.pluginType !== 'managed-browser' || verified.slug !== WEIBO_PLUGIN_SLUG)
    throw new Error('Weibo Plugin recorded owner trust verification failed')
  return ownerUserId
}

export async function findApprovedWeiboPlugin(
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
    verified.slug !== WEIBO_PLUGIN_SLUG ||
    verified.artifactHash !== COMPILED_WEIBO_PLUGIN.artifactHash ||
    verified.execContractHash !== COMPILED_WEIBO_PLUGIN.execContractHash
  )
    return null
  return { versionId: row.id, ownerUserId: ownerFromLocatedVersion(row) }
}

export async function seedWeiboPlugin(input: {
  functionalVerified: true
  ownerUserId?: number
  env?: NodeJS.ProcessEnv
  leaseRedis?: PluginLeaseRedis | null
  /** Upgrade-only scope proven by exact-image read smoke; never inferred by the seed itself. */
  expectedScope?: OfficialManagedBrowserTransitionScope
  beforeListingOpen?: (target: { versionId: string }) => Promise<void>
}): Promise<SeedWeiboPluginResult> {
  if (input.functionalVerified !== true)
    throw new Error('Weibo Plugin requires live functional verification')
  const env = input.env ?? process.env
  let located = await locateVersion()
  const recordedOwner = located ? ownerFromLocatedVersion(located) : await recordedListingOwner(env)
  const requestedOwner = input.ownerUserId ?? configuredOwner(env)
  if (recordedOwner !== null && requestedOwner !== null && recordedOwner !== requestedOwner)
    throw new Error('Weibo Plugin platform owner configuration drifted')
  const ownerUserId = recordedOwner ?? requestedOwner ?? (await initialOwner())
  const rawArtifact = canonicalBytes(WEIBO_PLUGIN_ARTIFACT).toString('utf8')
  const scan = scanSkillArtifact({
    name: OFFICIAL_NAME,
    description: OFFICIAL_DESCRIPTION,
    tags: OFFICIAL_TAGS,
    body: rawArtifact,
  })
  if (scan.blocked) throw new Error('official Weibo Plugin failed static scan')

  let published = false
  if (located && BigInt(located.owner_user_id) !== BigInt(ownerUserId))
    throw new Error('Weibo Plugin slug/version is owned by another user')
  if (!located) {
    try {
      const created = await publishOfficialWeiboVersion({
        slug: WEIBO_PLUGIN_SLUG,
        ownerUserId,
        version: WEIBO_PLUGIN_VERSION,
        name: OFFICIAL_NAME,
        description: OFFICIAL_DESCRIPTION,
        tags: OFFICIAL_TAGS,
        rawSkillMd: null,
        rawArtifact,
        artifactHash: COMPILED_WEIBO_PLUGIN.artifactHash,
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
          '汇总首页时间线或指定用户的近期微博并继续分析',
          '按关键词搜索公开微博，再读取指定正文和评论',
          '默认经逐次确认发布图文微博，或编辑、删除自己的微博；账号单独授权后可免确认',
          '默认经逐次确认评论、回复、转发、点赞或关注；账号单独授权后可免确认并保留写入账本',
        ],
        humanMd:
          '平台官方 Plugin。它只操纵微博公开网页界面，不调用开放平台付费接口，也不读取、解析、记录或重放网页接口响应。安装后使用微博扫码登录，账号状态加密保存。默认只读；写入须先开启账号写能力，且默认每一次写操作都在对话确认卡中单独批准。用户可另行接受独立的账号级高风险声明后开启免逐次确认；该授权默认关闭，关闭写入也会使它失效。编辑和删除只允许当前账号自己的内容，并在点击前复核摘要；点赞和关注按目标状态执行。所有写入都保留加密账本和派发围栏。网页出现验证码、风控或身份异常时立即停止，绝不尝试绕过；结果不明确时绝不自动重试。',
        queueAiReview: false,
      })
      located = await locateVersion()
      if (located?.id !== created.versionId)
        throw new Error('Weibo Plugin published version lookup drifted')
      published = true
    } catch (error) {
      if (!(error instanceof MarketplaceError && error.code === 'DUPLICATE_VERSION')) throw error
      located = await locateVersion()
    }
  }
  if (!located || ownerFromLocatedVersion(located) !== ownerUserId)
    throw new Error('Weibo Plugin seed target is missing or foreign')

  await approveOfficialRuntimePluginVersion({
    versionId: located.id,
    ownerUserId,
    expectedArtifactHash: COMPILED_WEIBO_PLUGIN.artifactHash,
    functionalVerified: true,
    activateListing: false,
    env,
    pool: getPool(),
  })
  const transition = await transitionOfficialManagedBrowserPluginVersion({
    slug: WEIBO_PLUGIN_SLUG,
    targetVersionId: located.id,
    expectedArtifactHash: COMPILED_WEIBO_PLUGIN.artifactHash,
    expectedExecContractHash: COMPILED_WEIBO_PLUGIN.execContractHash,
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
      slug: WEIBO_PLUGIN_SLUG,
      expectedVersionId: located.id,
      expectedArtifactHash: COMPILED_WEIBO_PLUGIN.artifactHash,
      expectedExecContractHash: COMPILED_WEIBO_PLUGIN.execContractHash,
      env,
      pool: getPool(),
    })
  }
  const trusted = await findApprovedWeiboPlugin(env)
  if (!trusted || trusted.versionId !== located.id || trusted.ownerUserId !== ownerUserId)
    throw new Error('Weibo Plugin approval failed exact trust verification')
  return {
    ownerUserId,
    versionId: located.id,
    published,
    migratedPluginInstalls: transition.migratedInstalls,
    migratedPluginAccounts: transition.migratedAccounts,
  }
}

export async function findApprovedWeiboPluginForDeploy(
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
    verified.slug !== WEIBO_PLUGIN_SLUG ||
    verified.artifactHash !== COMPILED_WEIBO_PLUGIN.artifactHash ||
    verified.execContractHash !== COMPILED_WEIBO_PLUGIN.execContractHash
  )
    throw new Error('Weibo Plugin deploy approval trust mismatch')
  return { versionId: row.id, ownerUserId: ownerFromLocatedVersion(row) }
}
