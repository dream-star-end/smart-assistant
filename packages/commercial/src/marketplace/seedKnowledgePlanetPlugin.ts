/**
 * Idempotent version-controlled publication of the official Knowledge Planet Plugin.
 *
 * The deploy lane calls this only after a real exact-image QR smoke. Historical
 * Knowledge Planet Skills remain installed; migration is additive and only grants
 * the new Plugin entitlement to users who still have the legacy persistent Skill.
 */

import { skillContentHash } from '@openclaude/storage'

import { canonicalBytes } from '../connectors/spec/canonical.js'
import { getPool } from '../db/index.js'
import { query } from '../db/queries.js'
import {
  COMPILED_KNOWLEDGE_PLANET_PLUGIN,
  KNOWLEDGE_PLANET_PLUGIN_ARTIFACT,
  KNOWLEDGE_PLANET_PLUGIN_SLUG,
  KNOWLEDGE_PLANET_PLUGIN_VERSION,
} from '../plugins/knowledgePlanetContract.js'
import {
  approveOfficialRuntimePluginVersion,
  loadVerifiedRuntimePluginContract,
} from '../plugins/review.js'
import {
  MarketplaceError,
  installApprovedVersion,
  normalizeInstallAgentIds,
  publishOfficialKnowledgePlanetVersion,
} from './marketplaceDb.js'
import { scanSkillArtifact } from './skillScanner.js'

const LEGACY_KNOWLEDGE_PLANET_SKILL = 'zsxq-persistent-connector'
const OFFICIAL_NAME = '知识星球'
const OFFICIAL_DESCRIPTION =
  '安全读取已授权知识星球的星球、主题与评论；账号凭据加密保存，执行时使用隔离的只读受管浏览器。'
const OFFICIAL_TAGS = ['知识星球', '社群内容', '只读插件']
const OFFICIAL_USE_CASES = ['查看已加入的知识星球', '读取星球主题与评论', '在指定星球内搜索内容']

export interface SeedKnowledgePlanetPluginResult {
  ownerUserId: number
  versionId: string
  published: boolean
  migratedUsers: number
  skippedExistingUsers: number
}

async function resolveInitialOfficialOwner(): Promise<number> {
  const row = await query<{ id: string }>(
    "SELECT id::text FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id ASC LIMIT 1",
  )
  const ownerUserId = Number(row.rows[0]?.id)
  if (!Number.isSafeInteger(ownerUserId) || ownerUserId <= 0)
    throw new Error('Knowledge Planet Plugin seed requires an active admin owner')
  return ownerUserId
}

interface LocatedOfficialVersion {
  id: string
  owner_user_id: string
  submitted_by: string
  status: string
  ai_review_state: string | null
  review_source: string | null
  kind: string
  plugin_type: string | null
  listing_state: string
}

async function locateVersion(): Promise<LocatedOfficialVersion | null> {
  const row = await query<LocatedOfficialVersion>(
    `SELECT v.id::text, l.owner_user_id::text, v.submitted_by::text,
            v.status, v.ai_review_state, v.review_source,
            l.kind, l.plugin_type, l.state AS listing_state
       FROM marketplace_skill_versions v
       JOIN marketplace_skill_listings l ON l.slug = v.slug
      WHERE v.slug = $1 AND v.version = $2
      LIMIT 1`,
    [KNOWLEDGE_PLANET_PLUGIN_SLUG, KNOWLEDGE_PLANET_PLUGIN_VERSION],
  )
  return row.rows[0] ?? null
}

function ownerFromLocatedVersion(row: LocatedOfficialVersion): number {
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
    throw new Error('Knowledge Planet Plugin slug/version lacks platform seed provenance')
  return ownerUserId
}

async function resolveRecordedListingOwner(env: NodeJS.ProcessEnv): Promise<number | null> {
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
    [KNOWLEDGE_PLANET_PLUGIN_SLUG],
  )
  const listing = row.rows[0]
  if (!listing) return null
  const ownerUserId = Number(listing.owner_user_id)
  if (
    !Number.isSafeInteger(ownerUserId) ||
    ownerUserId <= 0 ||
    listing.kind !== 'connector' ||
    listing.plugin_type !== 'managed-browser' ||
    listing.listing_state === 'revoked' ||
    !listing.version_id ||
    listing.version_status !== 'approved' ||
    listing.review_source !== 'platform'
  )
    throw new Error('Knowledge Planet Plugin slug is not a trusted platform listing')
  const verified = await loadVerifiedRuntimePluginContract(Number(listing.version_id), getPool(), {
    env,
  }).catch(() => null)
  if (
    !verified ||
    verified.pluginType !== 'managed-browser' ||
    verified.slug !== KNOWLEDGE_PLANET_PLUGIN_SLUG
  )
    throw new Error('Knowledge Planet Plugin recorded owner trust verification failed')
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

export async function findApprovedKnowledgePlanetPlugin(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ versionId: string; ownerUserId: number } | null> {
  const row = await locateVersion()
  if (!row) return null
  if (row.status !== 'approved' || row.review_source !== 'platform') return null
  const verified = await loadVerifiedRuntimePluginContract(Number(row.id), getPool(), {
    env,
  }).catch(() => null)
  if (
    !verified ||
    verified.pluginType !== 'managed-browser' ||
    verified.slug !== KNOWLEDGE_PLANET_PLUGIN_SLUG ||
    verified.artifactHash !== COMPILED_KNOWLEDGE_PLANET_PLUGIN.artifactHash ||
    verified.execContractHash !== COMPILED_KNOWLEDGE_PLANET_PLUGIN.execContractHash
  )
    return null
  const ownerUserId = ownerFromLocatedVersion(row)
  return { versionId: row.id, ownerUserId }
}

async function migrateLegacySkillInstalls(versionId: string): Promise<{
  migrated: number
  skippedExisting: number
}> {
  const rows = await query<{
    user_id: string
    agent_ids: unknown
    install_source: string
    installed_by: string
    already_installed: boolean
  }>(
    `SELECT old.user_id::text, old.agent_ids, old.install_source,
            old.installed_by::text,
            EXISTS (
              SELECT 1 FROM marketplace_installs current
               WHERE current.user_id = old.user_id AND current.slug = $2
                 AND current.uninstalled_at IS NULL
            ) AS already_installed
       FROM marketplace_installs old
       JOIN marketplace_skill_listings legacy
         ON legacy.slug = old.slug AND legacy.kind = 'skill'
      WHERE old.slug = $1 AND old.uninstalled_at IS NULL
      ORDER BY old.user_id`,
    [LEGACY_KNOWLEDGE_PLANET_SKILL, KNOWLEDGE_PLANET_PLUGIN_SLUG],
  )
  let migrated = 0
  let skippedExisting = 0
  for (const row of rows.rows) {
    if (row.already_installed) {
      skippedExisting++
      continue
    }
    const userId = Number(row.user_id)
    const installedBy = Number(row.installed_by)
    if (!Number.isSafeInteger(userId) || userId <= 0)
      throw new Error('legacy Knowledge Planet install has an invalid user')
    if (!Number.isSafeInteger(installedBy) || installedBy <= 0)
      throw new Error('legacy Knowledge Planet install has invalid provenance')
    const provenance = `migration:${LEGACY_KNOWLEDGE_PLANET_SKILL}:${row.install_source}`.slice(
      0,
      128,
    )
    await installApprovedVersion({
      userId,
      versionId,
      agentIds: normalizeInstallAgentIds(row.agent_ids),
      scopeMode: 'replace',
      installAudit: { source: provenance, installedBy },
    })
    migrated++
  }
  return { migrated, skippedExisting }
}

export async function seedKnowledgePlanetPlugin(input: {
  /** The deploy gate sets this only after exercising the exact image and QR flow. */
  functionalVerified: true
  ownerUserId?: number
  env?: NodeJS.ProcessEnv
  migrateLegacyInstalls?: boolean
}): Promise<SeedKnowledgePlanetPluginResult> {
  if (input.functionalVerified !== true)
    throw new Error('Knowledge Planet Plugin requires live functional verification')
  const env = input.env ?? process.env
  let located = await locateVersion()
  const recordedOwner = located
    ? ownerFromLocatedVersion(located)
    : await resolveRecordedListingOwner(env)
  const requestedOwner = input.ownerUserId ?? configuredOwner(env)
  if (recordedOwner !== null && requestedOwner !== null && recordedOwner !== requestedOwner)
    throw new Error('Knowledge Planet Plugin platform owner configuration drifted')
  const ownerUserId = recordedOwner ?? requestedOwner ?? (await resolveInitialOfficialOwner())
  const rawArtifact = canonicalBytes(KNOWLEDGE_PLANET_PLUGIN_ARTIFACT).toString('utf8')
  const scan = scanSkillArtifact({
    name: OFFICIAL_NAME,
    description: OFFICIAL_DESCRIPTION,
    tags: OFFICIAL_TAGS,
    body: rawArtifact,
  })
  if (scan.blocked) throw new Error('official Knowledge Planet Plugin failed static scan')

  let published = false
  if (located && BigInt(located.owner_user_id) !== BigInt(ownerUserId))
    throw new Error('Knowledge Planet Plugin slug/version is owned by another user')
  if (!located) {
    try {
      const created = await publishOfficialKnowledgePlanetVersion({
        slug: KNOWLEDGE_PLANET_PLUGIN_SLUG,
        ownerUserId,
        version: KNOWLEDGE_PLANET_PLUGIN_VERSION,
        name: OFFICIAL_NAME,
        description: OFFICIAL_DESCRIPTION,
        tags: OFFICIAL_TAGS,
        rawSkillMd: null,
        rawArtifact,
        artifactHash: COMPILED_KNOWLEDGE_PLANET_PLUGIN.artifactHash,
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
          '列出账号已加入的星球，并以结构化结果供 Agent 继续处理',
          '按星球读取或搜索主题，再读取指定主题的评论',
        ],
        humanMd:
          '平台官方只读 Plugin。授权时使用微信扫码；账号状态加密保存，调用仅允许访问签名契约内的知识星球读取接口。',
        queueAiReview: false,
      })
      located = await locateVersion()
      if (located?.id !== created.versionId)
        throw new Error('Knowledge Planet Plugin published version lookup drifted')
      published = true
    } catch (error) {
      if (!(error instanceof MarketplaceError && error.code === 'DUPLICATE_VERSION')) throw error
      located = await locateVersion()
    }
  }
  if (
    !located ||
    ownerFromLocatedVersion(located) !== ownerUserId ||
    BigInt(located.owner_user_id) !== BigInt(ownerUserId)
  )
    throw new Error('Knowledge Planet Plugin seed target is missing or foreign')

  await approveOfficialRuntimePluginVersion({
    versionId: located.id,
    ownerUserId,
    expectedArtifactHash: COMPILED_KNOWLEDGE_PLANET_PLUGIN.artifactHash,
    functionalVerified: true,
    env,
    pool: getPool(),
  })
  const trusted = await findApprovedKnowledgePlanetPlugin(env)
  if (!trusted || trusted.versionId !== located.id || trusted.ownerUserId !== ownerUserId)
    throw new Error('Knowledge Planet Plugin approval failed exact trust verification')

  const migration =
    input.migrateLegacyInstalls === false
      ? { migrated: 0, skippedExisting: 0 }
      : await migrateLegacySkillInstalls(located.id)
  return {
    ownerUserId,
    versionId: located.id,
    published,
    migratedUsers: migration.migrated,
    skippedExistingUsers: migration.skippedExisting,
  }
}
