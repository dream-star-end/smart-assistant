import { assertPluginAvailable, configurePluginCatalog } from '../plugins/catalogPolicy.js'
/**
 * Idempotent version-controlled publication of the official Bilibili account Plugin (OCV5-402).
 *
 * Same publication path as the official Zhihu / Weibo plugins: static scan → pending version via the
 * narrow official publish bypass (exact slug + version + artifact hash, no AI queue) →
 * approveOfficialRuntimePluginVersion (signs; requires `functionalVerified: true`) →
 * transitionOfficialManagedBrowserPluginVersion (opens the listing). The caller must have run the
 * live read smoke with a real logged-in account first (scripts/seed-bili-account-plugin.ts
 * --verify-and-seed-user); this module never infers verification.
 */

import { skillContentHash } from '@openclaude/storage'

import { canonicalBytes } from '../connectors/spec/canonical.js'
import { getPool } from '../db/index.js'
import { query } from '../db/queries.js'
import { assertFlavorIdentity } from '../flavor/assertFlavor.js'
import {
  BILI_ACCOUNT_PLUGIN_ARTIFACT,
  BILI_ACCOUNT_PLUGIN_CONTRACT,
  BILI_ACCOUNT_PLUGIN_SLUG,
  BILI_ACCOUNT_PLUGIN_VERSION,
  COMPILED_BILI_ACCOUNT_PLUGIN,
} from '../plugins/biliAccountContract.js'
import { transitionOfficialManagedBrowserPluginVersion } from '../plugins/officialManagedBrowserTransition.js'
import {
  approveOfficialRuntimePluginVersion,
  loadVerifiedRuntimePluginContract,
} from '../plugins/review.js'
import { MarketplaceError, publishOfficialBiliAccountVersion } from './marketplaceDb.js'
import { scanSkillArtifact } from './skillScanner.js'

const OFFICIAL_NAME = '哔哩哔哩账号'
const OFFICIAL_DESCRIPTION =
  '扫码登录你的 B 站账号后，只读查看视频字幕（含 AI 字幕）、收藏夹和观看历史。公开数据（搜索、详情、排行、评论、弹幕）请用「哔哩哔哩」插件。登录状态加密保存；遇到风控立即停止。'
const OFFICIAL_TAGS = ['插件', 'B站', '视频', '字幕', '收藏']
const OFFICIAL_USE_CASES = [
  '把这个 B 站视频的字幕整理成要点',
  '看看我 B 站收藏夹里都收藏了什么',
  '我最近在 B 站看了哪些视频',
]
const OFFICIAL_OUTCOME_EXAMPLES = [
  '读取视频字幕（含 AI 字幕）并按时间轴整理',
  '列出收藏夹并分页读取收藏的视频',
  '读取最近的观看历史和观看进度',
]
const OFFICIAL_HUMAN_MD =
  '平台官方插件，只读。安装后用哔哩哔哩 App 扫码登录，登录状态加密保存在平台，绝不进入对话或你的容器。' +
  '插件在隔离的受管浏览器里打开 B 站网页，并以网页自身的身份读取字幕、收藏夹和观看历史；不点赞、不投币、不评论，不做任何写操作。' +
  '遇到 B 站风控或安全验证立即停止，绝不尝试绕过，也不会自动重试。\n\n' +
  '接口用法参考了 dream-star-end/agent-plugins 的 bili 插件（MIT 许可，Copyright (c) 2026 ths-plugin contributors）。'

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
  current_approved_version_id: string | null
}

async function locateVersion(): Promise<LocatedVersion | null> {
  const row = await query<LocatedVersion>(
    `SELECT v.id::text, l.owner_user_id::text, v.submitted_by::text,
            v.status, v.ai_review_state, v.review_source,
            l.kind, l.plugin_type, l.state AS listing_state,
            l.current_approved_version_id::text
       FROM marketplace_skill_versions v
       JOIN marketplace_skill_listings l ON l.slug = v.slug
      WHERE v.slug = $1 AND v.version = $2
      LIMIT 1`,
    [BILI_ACCOUNT_PLUGIN_SLUG, BILI_ACCOUNT_PLUGIN_VERSION],
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
    throw new Error('Bilibili account Plugin slug/version lacks platform seed provenance')
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
    throw new Error('Bilibili account Plugin seed requires an active admin owner')
  return ownerUserId
}

/** Read-only by construction: the contract has no write action, and the smoke refuses any. */
export function biliAccountSmokeActionIds(): string[] {
  const ids = BILI_ACCOUNT_PLUGIN_CONTRACT.actions.map((action) => action.id)
  if (BILI_ACCOUNT_PLUGIN_CONTRACT.actions.some((action) => action.effect !== 'read'))
    throw new Error('Bilibili account contract must stay read-only')
  return ids
}

/**
 * 登录 worker 必须干净结束(Codex r1 P1):worker 的完成检查(协议、退出码、容器清理)失败时,即便之前
 * 已经收到 authenticated 状态也不能继续实测和上架。返回唯一可用的登录状态,否则抛错。
 */
export function requireCleanLogin<T>(input: {
  state: T | null
  failure: string | null
  doneError: unknown
}): T {
  if (input.doneError !== undefined && input.doneError !== null)
    throw new Error('login worker did not finish cleanly')
  if (input.failure !== null) throw new Error(`login did not complete: ${input.failure}`)
  if (input.state === null) throw new Error('login did not complete: no state')
  return input.state
}

export const BILI_ACCOUNT_SEED_CLI_USAGE =
  'usage: seed-bili-account-plugin.ts --advisory-status | (--verify-only | --verify-and-seed-user=ID) --qr-out=/root/<file>.png [--subtitle-bvid=BV…]'

export type BiliAccountSeedCli =
  | { mode: 'advisory-status' }
  /** 真实扫码 + 逐动作实测,不写库、不上架(上架前检查)。 */
  | { mode: 'verify-only'; qrOut: string; subtitleBvid: string | null }
  | { mode: 'verify-and-seed'; userId: number; qrOut: string; subtitleBvid: string | null }

export function parseBiliAccountSeedCliArgs(argv: readonly string[]): BiliAccountSeedCli {
  if (argv.length === 1 && argv[0] === '--advisory-status') return { mode: 'advisory-status' }
  let userId: number | null = null
  let verifyOnly = false
  let qrOut: string | null = null
  let subtitleBvid: string | null = null
  for (const arg of argv) {
    const user = /^--verify-and-seed-user=(\d{1,16})$/.exec(arg)
    const qr = /^--qr-out=(\/root\/[A-Za-z0-9._-]{1,64}\.png)$/.exec(arg)
    const bvid = /^--subtitle-bvid=(BV[0-9A-Za-z]{10})$/.exec(arg)
    if (user && userId === null && !verifyOnly) userId = Number(user[1])
    else if (arg === '--verify-only' && !verifyOnly && userId === null) verifyOnly = true
    else if (qr && qrOut === null && !qr[1]!.includes('..')) qrOut = qr[1]!
    else if (bvid && subtitleBvid === null) subtitleBvid = bvid[1]!
    else throw new Error(BILI_ACCOUNT_SEED_CLI_USAGE)
  }
  if (qrOut === null) throw new Error(BILI_ACCOUNT_SEED_CLI_USAGE)
  if (verifyOnly) return { mode: 'verify-only', qrOut, subtitleBvid }
  if (userId === null || !Number.isSafeInteger(userId) || userId <= 0)
    throw new Error(BILI_ACCOUNT_SEED_CLI_USAGE)
  return { mode: 'verify-and-seed', userId, qrOut, subtitleBvid }
}

export async function findApprovedBiliAccountPlugin(
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
    verified.slug !== BILI_ACCOUNT_PLUGIN_SLUG ||
    verified.artifactHash !== COMPILED_BILI_ACCOUNT_PLUGIN.artifactHash ||
    verified.execContractHash !== COMPILED_BILI_ACCOUNT_PLUGIN.execContractHash
  )
    return null
  return { versionId: row.id, ownerUserId: ownerFromLocatedVersion(row) }
}

export interface SeedBiliAccountPluginResult {
  ownerUserId: number
  versionId: string
  published: boolean
}

export async function seedBiliAccountPlugin(input: {
  functionalVerified: true
  ownerUserId?: number
  env?: NodeJS.ProcessEnv
}): Promise<SeedBiliAccountPluginResult> {
  const env = input.env ?? process.env
  configurePluginCatalog(assertFlavorIdentity({ env }))
  assertPluginAvailable(BILI_ACCOUNT_PLUGIN_SLUG)
  if (input.functionalVerified !== true)
    throw new Error('Bilibili account Plugin requires live functional verification')
  let located = await locateVersion()
  const requestedOwner = input.ownerUserId ?? configuredOwner(env)
  const recordedOwner = located ? ownerFromLocatedVersion(located) : null
  if (recordedOwner !== null && requestedOwner !== null && recordedOwner !== requestedOwner)
    throw new Error('Bilibili account Plugin platform owner configuration drifted')
  const ownerUserId = recordedOwner ?? requestedOwner ?? (await initialOwner())
  const rawArtifact = canonicalBytes(BILI_ACCOUNT_PLUGIN_ARTIFACT).toString('utf8')
  const scan = scanSkillArtifact({
    name: OFFICIAL_NAME,
    description: OFFICIAL_DESCRIPTION,
    tags: OFFICIAL_TAGS,
    body: rawArtifact,
  })
  const metaScan = scanSkillArtifact({
    name: OFFICIAL_NAME,
    description: '',
    tags: [],
    body: [...OFFICIAL_USE_CASES, ...OFFICIAL_OUTCOME_EXAMPLES, OFFICIAL_HUMAN_MD].join('\n'),
  })
  if (scan.blocked || metaScan.blocked)
    throw new Error('official Bilibili account Plugin failed static scan')

  let published = false
  if (!located) {
    try {
      const created = await publishOfficialBiliAccountVersion({
        slug: BILI_ACCOUNT_PLUGIN_SLUG,
        ownerUserId,
        version: BILI_ACCOUNT_PLUGIN_VERSION,
        name: OFFICIAL_NAME,
        description: OFFICIAL_DESCRIPTION,
        tags: OFFICIAL_TAGS,
        rawSkillMd: null,
        rawArtifact,
        artifactHash: COMPILED_BILI_ACCOUNT_PLUGIN.artifactHash,
        embeddingHash: skillContentHash({
          name: OFFICIAL_NAME,
          description: OFFICIAL_DESCRIPTION,
          tags: OFFICIAL_TAGS,
          use_cases: OFFICIAL_USE_CASES,
        }),
        riskFlags: [...scan.flags, ...metaScan.flags],
        policyVersion: scan.policyVersion,
        submittedBy: ownerUserId,
        kind: 'connector',
        pluginType: 'managed-browser',
        category: 'daily-tools',
        useCases: OFFICIAL_USE_CASES,
        outcomeExamples: OFFICIAL_OUTCOME_EXAMPLES,
        humanMd: OFFICIAL_HUMAN_MD,
        queueAiReview: false,
      })
      located = await locateVersion()
      if (located?.id !== created.versionId)
        throw new Error('Bilibili account Plugin published version lookup drifted')
      published = true
    } catch (error) {
      if (!(error instanceof MarketplaceError && error.code === 'DUPLICATE_VERSION')) throw error
      located = await locateVersion()
    }
  }
  if (!located || ownerFromLocatedVersion(located) !== ownerUserId)
    throw new Error('Bilibili account Plugin seed target is missing or foreign')

  await approveOfficialRuntimePluginVersion({
    versionId: located.id,
    ownerUserId,
    expectedArtifactHash: COMPILED_BILI_ACCOUNT_PLUGIN.artifactHash,
    functionalVerified: true,
    activateListing: false,
    env,
    pool: getPool(),
  })
  await transitionOfficialManagedBrowserPluginVersion({
    slug: BILI_ACCOUNT_PLUGIN_SLUG,
    targetVersionId: located.id,
    expectedArtifactHash: COMPILED_BILI_ACCOUNT_PLUGIN.artifactHash,
    expectedExecContractHash: COMPILED_BILI_ACCOUNT_PLUGIN.execContractHash,
    ownerUserId,
    env,
    pool: getPool(),
  })
  const trusted = await findApprovedBiliAccountPlugin(env)
  if (!trusted || trusted.versionId !== located.id || trusted.ownerUserId !== ownerUserId)
    throw new Error('Bilibili account Plugin approval failed exact trust verification')
  return { ownerUserId, versionId: located.id, published }
}
