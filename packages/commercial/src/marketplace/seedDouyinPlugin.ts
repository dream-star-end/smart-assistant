/**
 * Idempotent version-controlled publication of the official Douyin Plugin (OCV5-553).
 *
 * Same publication path as the official Zhihu / Weibo plugins: static scan → pending version via the
 * narrow official publish bypass (exact slug + version + artifact hash, no AI queue) →
 * approveOfficialRuntimePluginVersion (signs; requires `functionalVerified: true`) →
 * transitionOfficialManagedBrowserPluginVersion (opens the listing). The caller must have run the
 * live read smoke with a real logged-in account first (scripts/seed-douyin-plugin.ts
 * --verify-and-seed-user); this module never infers verification.
 */

import { skillContentHash } from '@openclaude/storage'

import { canonicalBytes } from '../connectors/spec/canonical.js'
import { getPool } from '../db/index.js'
import { query } from '../db/queries.js'
import { assertFlavorIdentity } from '../flavor/assertFlavor.js'
import {
  COMPILED_DOUYIN_PLUGIN,
  DOUYIN_PLUGIN_ARTIFACT,
  DOUYIN_PLUGIN_CONTRACT,
  DOUYIN_PLUGIN_SLUG,
  DOUYIN_PLUGIN_VERSION,
} from '../plugins/douyinContract.js'
import { transitionOfficialManagedBrowserPluginVersion } from '../plugins/officialManagedBrowserTransition.js'
import {
  approveOfficialRuntimePluginVersion,
  loadVerifiedRuntimePluginContract,
} from '../plugins/review.js'
import { MarketplaceError, publishOfficialDouyinVersion } from './marketplaceDb.js'
import { scanSkillArtifact } from './skillScanner.js'

const OFFICIAL_NAME = '抖音'
const OFFICIAL_DESCRIPTION =
  '用抖音 App 扫码登录你的个人抖音账号。当前版本可确认登录身份并读取账号概况；作品、评论、搜索与发布等能力将在后续版本提供。登录状态加密保存；遇到风控或验证立即停止。自动化操作有账号风控风险。'
const OFFICIAL_TAGS = ['插件', '抖音', '短视频', '账号']
const OFFICIAL_USE_CASES = ['看看我的抖音账号现在登录的是谁', '我的抖音有多少粉丝和作品']
const OFFICIAL_OUTCOME_EXAMPLES = [
  '读取当前登录的抖音昵称和账号 ID',
  '读取粉丝数、关注数、作品数和获赞数',
]
const OFFICIAL_HUMAN_MD =
  '平台官方插件。安装后用抖音 App 扫码登录你的**个人抖音账号**，登录状态加密保存在平台，绝不进入对话或你的容器。' +
  '插件在隔离的受管浏览器里打开抖音创作者服务平台（creator.douyin.com），并以网页自身的身份读取账号信息；当前版本只读，不发布、不评论、不点赞。\n\n' +
  '**风险提示**：插件以浏览器自动化方式使用你的真实账号，这种方式不在抖音官方开放能力之内，可能触发抖音风控，严重时限制或封禁账号，风险由你本人承担。' +
  '遇到验证码、滑块或要求本人验证时立即停止，绝不尝试绕过，也不会自动重试；需要本人验证时请在手机抖音完成后重新扫码。'

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
    [DOUYIN_PLUGIN_SLUG, DOUYIN_PLUGIN_VERSION],
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
    throw new Error('Douyin Plugin slug/version lacks platform seed provenance')
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
    throw new Error('Douyin Plugin seed requires an active admin owner')
  return ownerUserId
}

/** Read-only by construction: the contract has no write action, and the smoke refuses any. */
export function douyinSmokeActionIds(): string[] {
  const ids = DOUYIN_PLUGIN_CONTRACT.actions.map((action) => action.id)
  if (DOUYIN_PLUGIN_CONTRACT.actions.some((action) => action.effect !== 'read'))
    throw new Error('Douyin contract must stay read-only')
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

export const DOUYIN_SEED_CLI_USAGE =
  'usage: seed-douyin-plugin.ts --advisory-status | (--verify-only | --verify-and-seed-user=ID) --qr-out=/root/<file>.png --sms-code-file=/root/<file>'

export type DouyinSeedCli =
  | { mode: 'advisory-status' }
  /** 真实扫码 + 逐动作实测,不写库、不上架(上架前检查)。 */
  | { mode: 'verify-only'; qrOut: string; smsCodeFile: string }
  | { mode: 'verify-and-seed'; userId: number; qrOut: string; smsCodeFile: string }

/**
 * --sms-code-file:扫码后抖音要求本人短信验证(设计 4.3.C),操作员把手机收到的验证码写进这个 root-only 文件;
 * 脚本每秒轮询,读到就删,只交给登录 worker,不打印。
 */
export function parseDouyinSeedCliArgs(argv: readonly string[]): DouyinSeedCli {
  if (argv.length === 1 && argv[0] === '--advisory-status') return { mode: 'advisory-status' }
  let userId: number | null = null
  let verifyOnly = false
  let qrOut: string | null = null
  let smsCodeFile: string | null = null
  for (const arg of argv) {
    const user = /^--verify-and-seed-user=(\d{1,16})$/.exec(arg)
    const qr = /^--qr-out=(\/root\/[A-Za-z0-9._-]{1,64}\.png)$/.exec(arg)
    const sms = /^--sms-code-file=(\/root\/[A-Za-z0-9._-]{1,64})$/.exec(arg)
    if (user && userId === null && !verifyOnly) userId = Number(user[1])
    else if (arg === '--verify-only' && !verifyOnly && userId === null) verifyOnly = true
    else if (qr && qrOut === null && !qr[1]!.includes('..')) qrOut = qr[1]!
    else if (sms && smsCodeFile === null && !sms[1]!.includes('..')) smsCodeFile = sms[1]!
    else throw new Error(DOUYIN_SEED_CLI_USAGE)
  }
  if (qrOut === null || smsCodeFile === null || smsCodeFile === qrOut)
    throw new Error(DOUYIN_SEED_CLI_USAGE)
  if (verifyOnly) return { mode: 'verify-only', qrOut, smsCodeFile }
  if (userId === null || !Number.isSafeInteger(userId) || userId <= 0)
    throw new Error(DOUYIN_SEED_CLI_USAGE)
  return { mode: 'verify-and-seed', userId, qrOut, smsCodeFile }
}

export async function findApprovedDouyinPlugin(
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
    verified.slug !== DOUYIN_PLUGIN_SLUG ||
    verified.artifactHash !== COMPILED_DOUYIN_PLUGIN.artifactHash ||
    verified.execContractHash !== COMPILED_DOUYIN_PLUGIN.execContractHash
  )
    return null
  return { versionId: row.id, ownerUserId: ownerFromLocatedVersion(row) }
}

export interface SeedDouyinPluginResult {
  ownerUserId: number
  versionId: string
  published: boolean
}

export async function seedDouyinPlugin(input: {
  functionalVerified: true
  ownerUserId?: number
  env?: NodeJS.ProcessEnv
}): Promise<SeedDouyinPluginResult> {
  const env = input.env ?? process.env
  assertFlavorIdentity({ env })
  if (input.functionalVerified !== true)
    throw new Error('Douyin Plugin requires live functional verification')
  let located = await locateVersion()
  const requestedOwner = input.ownerUserId ?? configuredOwner(env)
  const recordedOwner = located ? ownerFromLocatedVersion(located) : null
  if (recordedOwner !== null && requestedOwner !== null && recordedOwner !== requestedOwner)
    throw new Error('Douyin Plugin platform owner configuration drifted')
  const ownerUserId = recordedOwner ?? requestedOwner ?? (await initialOwner())
  const rawArtifact = canonicalBytes(DOUYIN_PLUGIN_ARTIFACT).toString('utf8')
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
  if (scan.blocked || metaScan.blocked) throw new Error('official Douyin Plugin failed static scan')

  let published = false
  if (!located) {
    try {
      const created = await publishOfficialDouyinVersion({
        slug: DOUYIN_PLUGIN_SLUG,
        ownerUserId,
        version: DOUYIN_PLUGIN_VERSION,
        name: OFFICIAL_NAME,
        description: OFFICIAL_DESCRIPTION,
        tags: OFFICIAL_TAGS,
        rawSkillMd: null,
        rawArtifact,
        artifactHash: COMPILED_DOUYIN_PLUGIN.artifactHash,
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
        throw new Error('Douyin Plugin published version lookup drifted')
      published = true
    } catch (error) {
      if (!(error instanceof MarketplaceError && error.code === 'DUPLICATE_VERSION')) throw error
      located = await locateVersion()
    }
  }
  if (!located || ownerFromLocatedVersion(located) !== ownerUserId)
    throw new Error('Douyin Plugin seed target is missing or foreign')

  await approveOfficialRuntimePluginVersion({
    versionId: located.id,
    ownerUserId,
    expectedArtifactHash: COMPILED_DOUYIN_PLUGIN.artifactHash,
    functionalVerified: true,
    activateListing: false,
    env,
    pool: getPool(),
  })
  await transitionOfficialManagedBrowserPluginVersion({
    slug: DOUYIN_PLUGIN_SLUG,
    targetVersionId: located.id,
    expectedArtifactHash: COMPILED_DOUYIN_PLUGIN.artifactHash,
    expectedExecContractHash: COMPILED_DOUYIN_PLUGIN.execContractHash,
    ownerUserId,
    env,
    pool: getPool(),
  })
  const trusted = await findApprovedDouyinPlugin(env)
  if (!trusted || trusted.versionId !== located.id || trusted.ownerUserId !== ownerUserId)
    throw new Error('Douyin Plugin approval failed exact trust verification')
  return { ownerUserId, versionId: located.id, published }
}
