/**
 * Idempotent version-controlled publication of the official Literature DB Plugin (OCV5-524).
 */
import { skillContentHash } from '@openclaude/storage'

import { canonicalBytes } from '../connectors/spec/canonical.js'
import { getPool } from '../db/index.js'
import { query } from '../db/queries.js'
import { assertFlavorIdentity } from '../flavor/assertFlavor.js'
import {
  LITERATURE_PLUGIN_ARTIFACT,
  LITERATURE_PLUGIN_SLUG,
  LITERATURE_PLUGIN_VERSION,
} from '../plugins/literatureDb/builtinArtifact.js'
import {
  COMPILED_LITERATURE_PLUGIN,
  LITERATURE_PLUGIN_CONTRACT,
} from '../plugins/literatureDb/builtinContract.js'
import { transitionOfficialManagedBrowserPluginVersion } from '../plugins/officialManagedBrowserTransition.js'
import {
  approveOfficialRuntimePluginVersion,
  loadVerifiedRuntimePluginContract,
} from '../plugins/review.js'
import { MarketplaceError, publishOfficialLiteratureVersion } from './marketplaceDb.js'
import { scanSkillArtifact } from './skillScanner.js'

const OFFICIAL_NAME = '文献数据库'
const OFFICIAL_DESCRIPTION =
  '授权绑定你的解忧图书馆会员账号后，只读检索中英文学术文献（中文万方数据库、英文 Nature 数据库）并下载经过隔离校验的 PDF 全文产物。账号凭据与会话状态全链路加密保存，绝不进入对话或用户容器。'
const OFFICIAL_TAGS = ['插件', '文献', '学术检索', '万方', 'Nature', 'PDF下载']
const OFFICIAL_USE_CASES = [
  '检索中文学术论文并下载 PDF 全文',
  '检索英文 Nature 期刊论文并下载 PDF 全文',
  '按关键词分页检索文献标题、作者、年份、期刊与摘要片段',
]
const OFFICIAL_OUTCOME_EXAMPLES = [
  '检索中文或英文文献并返回可下载的私有文献编号',
  '下载指定文献并生成经隔离 PDF 结构校验的平台文件编号供浏览器保存',
]
const OFFICIAL_HUMAN_MD =
  '平台官方只读插件。安装后在设置页输入你的解忧图书馆会员账号完成私有绑定，账号密码与登录会话全链路使用平台密钥加密保存，绝不进入模型上下文、终端日志或用户容器。' +
  '插件在平台服务端通过受控 HTTP 通道检索中文（万方）与英文（Nature/Springer）文献数据库，下载的 PDF 全文先在隔离工作线程完成结构校验，再发布为绑定当前用户与账号实例的短期平台文件编号，仅可由当前登录用户在浏览器中下载保存。' +
  'search 返回的 documentId 有效期为 24 小时；若编号过期（报 DOCUMENT_EXPIRED），请先重新调用 search 获取新编号后再 download。下载得到的 PDF 在平台暂存约 30 分钟，请及时在文献卡片上保存；过期后可用同一编号重新下载。需要下载多篇文献或遇到 RATE_LIMITED 时，请一篇一篇串行下载，每篇间隔 20-30 秒。'

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
    [LITERATURE_PLUGIN_SLUG, LITERATURE_PLUGIN_VERSION],
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
    throw new Error('Literature DB Plugin slug/version lacks platform seed provenance')
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
    throw new Error('Literature DB Plugin seed requires an active admin owner')
  return ownerUserId
}

export function literatureSmokeActionIds(): string[] {
  const ids = LITERATURE_PLUGIN_CONTRACT.actions.map((action) => action.id)
  if (LITERATURE_PLUGIN_CONTRACT.actions.some((action) => action.effect !== 'read'))
    throw new Error('Literature DB contract must stay read-only')
  return ids
}

export async function findApprovedLiteraturePlugin(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ versionId: string; ownerUserId: number } | null> {
  const row = await locateVersion()
  if (!row) return null
  if (
    row.status !== 'approved' ||
    row.review_source !== 'platform' ||
    row.listing_state !== 'active' ||
    row.current_approved_version_id !== row.id
  )
    return null
  const verified = await loadVerifiedRuntimePluginContract(Number(row.id), getPool(), { env })
  if (
    verified.pluginType !== 'managed-browser' ||
    verified.slug !== LITERATURE_PLUGIN_SLUG ||
    verified.artifactHash !== COMPILED_LITERATURE_PLUGIN.artifactHash ||
    verified.execContractHash !== COMPILED_LITERATURE_PLUGIN.execContractHash
  )
    return null
  return { versionId: row.id, ownerUserId: ownerFromLocatedVersion(row) }
}

export interface SeedLiteraturePluginResult {
  ownerUserId: number
  versionId: string
  published: boolean
}

export async function seedLiteraturePlugin(input: {
  functionalVerified: true
  ownerUserId?: number
  env?: NodeJS.ProcessEnv
}): Promise<SeedLiteraturePluginResult> {
  const env = input.env ?? process.env
  assertFlavorIdentity({ env })
  if (input.functionalVerified !== true)
    throw new Error('Literature DB Plugin requires live functional verification')
  let located = await locateVersion()
  const requestedOwner = input.ownerUserId ?? configuredOwner(env)
  const recordedOwner = located ? ownerFromLocatedVersion(located) : null
  if (recordedOwner !== null && requestedOwner !== null && recordedOwner !== requestedOwner)
    throw new Error('Literature DB Plugin platform owner configuration drifted')
  const ownerUserId = recordedOwner ?? requestedOwner ?? (await initialOwner())
  const rawArtifact = canonicalBytes(LITERATURE_PLUGIN_ARTIFACT).toString('utf8')
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
    throw new Error('official Literature DB Plugin failed static scan')

  let published = false
  if (!located) {
    try {
      const created = await publishOfficialLiteratureVersion({
        slug: LITERATURE_PLUGIN_SLUG,
        ownerUserId,
        version: LITERATURE_PLUGIN_VERSION,
        name: OFFICIAL_NAME,
        description: OFFICIAL_DESCRIPTION,
        tags: OFFICIAL_TAGS,
        rawSkillMd: null,
        rawArtifact,
        artifactHash: COMPILED_LITERATURE_PLUGIN.artifactHash,
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
        category: 'research-academic',
        useCases: OFFICIAL_USE_CASES,
        outcomeExamples: OFFICIAL_OUTCOME_EXAMPLES,
        humanMd: OFFICIAL_HUMAN_MD,
        queueAiReview: false,
      })
      located = await locateVersion()
      if (located?.id !== created.versionId)
        throw new Error('Literature DB Plugin published version lookup drifted')
      published = true
    } catch (error) {
      if (!(error instanceof MarketplaceError && error.code === 'DUPLICATE_VERSION')) throw error
      located = await locateVersion()
    }
  }
  if (!located || ownerFromLocatedVersion(located) !== ownerUserId)
    throw new Error('Literature DB Plugin seed target is missing or foreign')

  await approveOfficialRuntimePluginVersion({
    versionId: located.id,
    ownerUserId,
    expectedArtifactHash: COMPILED_LITERATURE_PLUGIN.artifactHash,
    functionalVerified: true,
    activateListing: false,
    env,
    pool: getPool(),
  })
  await transitionOfficialManagedBrowserPluginVersion({
    slug: LITERATURE_PLUGIN_SLUG,
    targetVersionId: located.id,
    expectedArtifactHash: COMPILED_LITERATURE_PLUGIN.artifactHash,
    expectedExecContractHash: COMPILED_LITERATURE_PLUGIN.execContractHash,
    ownerUserId,
    env,
    pool: getPool(),
  })
  const trusted = await findApprovedLiteraturePlugin(env)
  if (!trusted || trusted.versionId !== located.id || trusted.ownerUserId !== ownerUserId)
    throw new Error('Literature DB Plugin approval failed exact trust verification')
  return { ownerUserId, versionId: located.id, published }
}
