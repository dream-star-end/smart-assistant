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
import { query, tx } from '../db/queries.js'
import type { PluginLeaseRedis } from '../plugins/accountLease.js'
import {
  COMPILED_KNOWLEDGE_PLANET_PLUGIN,
  KNOWLEDGE_PLANET_PLUGIN_ARTIFACT,
  KNOWLEDGE_PLANET_PLUGIN_SLUG,
  KNOWLEDGE_PLANET_PLUGIN_VERSION,
} from '../plugins/knowledgePlanetContract.js'
import {
  OFFICIAL_MANAGED_BROWSER_TRANSITION_GATE_REASON,
  openOfficialManagedBrowserPluginListingGate,
  transitionOfficialManagedBrowserPluginVersion,
} from '../plugins/officialManagedBrowserTransition.js'
import {
  approveOfficialRuntimePluginVersion,
  loadVerifiedRuntimePluginContract,
} from '../plugins/review.js'
import { lockMarketplaceListing, lockMarketplaceVersion } from './locking.js'
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
  '安全读取已授权知识星球的星球、主题、评论、动态、标签、专栏与打卡内容；用户主动开启并接受免责声明后，还可在逐次确认下发布纯文本主题和评论。账号状态加密保存，执行时使用隔离受管浏览器。'
const OFFICIAL_TAGS = ['知识星球', '社群内容', '知识检索', '内容发布']
const OFFICIAL_USE_CASES = [
  '查看已加入的知识星球与未读数量',
  '读取、筛选或搜索主题与评论',
  '汇总跨星球动态、标签和专栏内容',
  '读取打卡项目及其主题',
  '经账号开关和逐次确认发布纯文本主题或评论',
]

export interface SeedKnowledgePlanetPluginResult {
  ownerUserId: number
  versionId: string
  published: boolean
  migratedUsers: number
  skippedExistingUsers: number
  migratedPluginInstalls: number
  migratedPluginAccounts: number
  retiredLegacyListing: boolean
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
  revoked_reason: string | null
  current_approved_version_id: string | null
}

async function locateVersion(): Promise<LocatedOfficialVersion | null> {
  const row = await query<LocatedOfficialVersion>(
    `SELECT v.id::text, l.owner_user_id::text, v.submitted_by::text,
            v.status, v.ai_review_state, v.review_source,
            l.kind, l.plugin_type, l.state AS listing_state, l.revoked_reason,
            l.current_approved_version_id::text
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
    !['active', 'unlisted'].includes(listing.listing_state) ||
    !listing.version_id ||
    listing.version_status !== 'approved' ||
    listing.review_source !== 'platform'
  )
    throw new Error('Knowledge Planet Plugin slug is not a trusted platform listing')
  const verified = await loadVerifiedRuntimePluginContract(Number(listing.version_id), getPool(), {
    env,
    // Deploy closes the current version before publishing its replacement. This
    // is an internal exact-version trust read, not a public catalog/runtime read.
    allowUnlisted: true,
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
  if (row.current_approved_version_id !== row.id) return null
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

/**
 * Deploy-only exact approval lookup used while the global listing gate is
 * intentionally closed. Public catalog/runtime callers must keep using the
 * active-only lookup above.
 */
export async function findApprovedKnowledgePlanetPluginForDeploy(
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
    verified.slug !== KNOWLEDGE_PLANET_PLUGIN_SLUG ||
    verified.artifactHash !== COMPILED_KNOWLEDGE_PLANET_PLUGIN.artifactHash ||
    verified.execContractHash !== COMPILED_KNOWLEDGE_PLANET_PLUGIN.execContractHash
  )
    throw new Error('Knowledge Planet Plugin deploy approval trust mismatch')
  return { versionId: row.id, ownerUserId: ownerFromLocatedVersion(row) }
}

async function migrateLegacySkillInstalls(versionId: string): Promise<{
  migrated: number
  skippedExisting: number
}> {
  // 任意历史 Plugin 安装记录都代表迁移已发生；soft-uninstall 是用户意图，后续 deploy seed
  // 不得因旧 Skill 仍 active 而静默恢复。用户仍可从市场显式重装同一版本。
  const rows = await query<{
    user_id: string
    agent_ids: unknown
    install_source: string
    installed_by: string
    already_migrated: boolean
  }>(
    `SELECT old.user_id::text, old.agent_ids, old.install_source,
            old.installed_by::text,
            EXISTS (
              SELECT 1 FROM marketplace_installs current
               WHERE current.user_id = old.user_id AND current.slug = $2
            ) AS already_migrated
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
    if (row.already_migrated) {
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

/**
 * Retire the legacy self-hosted Skill as the last migration step. Historical
 * installs and audit rows are retained, but the duplicate market entry and its
 * self-host/write-capable instructions can no longer be newly installed or fed
 * to Agents. The final listing lock closes the install race: if a personal
 * install appeared after the migration census, retirement fails and the next
 * idempotent seed migrates it before retrying. Org Skill installs cannot be
 * represented by the per-user managed-browser Plugin and therefore fail closed
 * instead of silently removing an org capability.
 */
async function retireLegacyKnowledgePlanetSkillListing(): Promise<boolean> {
  const pool = getPool()
  return tx(async (client) => {
    const located = await client.query<{ version_id: string | null }>(
      `SELECT current_approved_version_id::text AS version_id
         FROM marketplace_skill_listings WHERE slug = $1`,
      [LEGACY_KNOWLEDGE_PLANET_SKILL],
    )
    const versionId = located.rows[0]?.version_id ?? null
    if (!versionId) return false
    const version = await lockMarketplaceVersion(client, versionId)
    const listing = await lockMarketplaceListing(client, LEGACY_KNOWLEDGE_PLANET_SKILL)
    if (
      !version ||
      !listing ||
      version.slug !== LEGACY_KNOWLEDGE_PLANET_SKILL ||
      listing.currentApprovedVersionId !== version.id ||
      listing.kind !== 'skill' ||
      listing.pluginType !== null ||
      version.status !== 'approved' ||
      version.submittedBy !== listing.ownerUserId
    )
      throw new Error('legacy Knowledge Planet Skill retirement trust mismatch')
    if (listing.state === 'unlisted' || listing.state === 'revoked') return false
    if (listing.state !== 'active')
      throw new Error('legacy Knowledge Planet Skill is in an unexpected listing state')

    const blockers = await client.query<{
      personal_without_plugin: string
      active_org_installs: string
    }>(
      `SELECT
         (SELECT count(*)::text
            FROM marketplace_installs legacy
           WHERE legacy.slug = $1 AND legacy.uninstalled_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM marketplace_installs plugin
                WHERE plugin.user_id = legacy.user_id AND plugin.slug = $2
             )) AS personal_without_plugin,
         (SELECT count(*)::text
            FROM org_installs legacy_org
           WHERE legacy_org.slug = $1 AND legacy_org.uninstalled_at IS NULL
         ) AS active_org_installs`,
      [LEGACY_KNOWLEDGE_PLANET_SKILL, KNOWLEDGE_PLANET_PLUGIN_SLUG],
    )
    const blocker = blockers.rows[0]
    if (blocker?.personal_without_plugin !== '0')
      throw new Error('legacy Knowledge Planet Skill still has unmigrated personal installs')
    if (blocker?.active_org_installs !== '0')
      throw new Error('legacy Knowledge Planet Skill still has active org installs')

    const retired = await client.query(
      `UPDATE marketplace_skill_listings
          SET state = 'unlisted',
              revoked_reason = 'migrated to official knowledge-planet Plugin',
              updated_at = NOW()
        WHERE slug = $1 AND state = 'active'
          AND current_approved_version_id = $2::bigint`,
      [LEGACY_KNOWLEDGE_PLANET_SKILL, versionId],
    )
    if (retired.rowCount !== 1)
      throw new Error('legacy Knowledge Planet Skill retirement CAS failed')
    return true
  }, pool)
}

export async function seedKnowledgePlanetPlugin(input: {
  /** The deploy gate sets this only after exact-image QR and authenticated action verification. */
  functionalVerified: true
  ownerUserId?: number
  env?: NodeJS.ProcessEnv
  leaseRedis?: PluginLeaseRedis | null
  migrateLegacyInstalls?: boolean
  /** Runs after account/install pins move while the listing remains unlisted. */
  beforeListingOpen?: (target: { versionId: string }) => Promise<void>
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
          '列出账号已加入的星球和未读数，并以结构化结果供 Agent 继续处理',
          '按星球、标签、专栏或打卡项目读取主题，再读取指定主题的正文与评论',
          '汇总所有星球的最近动态并继续做检索、归纳或内容分析',
          '在用户开启写入并确认本次操作后，发布一条纯文本主题或评论',
        ],
        humanMd:
          '平台官方 Plugin。安装后会自动进入微信扫码授权；扫码成功后默认仅开放读取能力。发布主题和评论默认关闭，只有用户在插件账号页接受免责声明并开启后才会向 Agent 显示，而且每一次写入仍需用户在确认卡中单独批准。账号状态加密保存；不支持自动重试、点赞、编辑或删除。',
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
    activateListing: false,
    env,
    pool: getPool(),
  })
  const versionTransition = await transitionOfficialManagedBrowserPluginVersion({
    slug: KNOWLEDGE_PLANET_PLUGIN_SLUG,
    targetVersionId: located.id,
    expectedArtifactHash: COMPILED_KNOWLEDGE_PLANET_PLUGIN.artifactHash,
    expectedExecContractHash: COMPILED_KNOWLEDGE_PLANET_PLUGIN.execContractHash,
    ownerUserId,
    env,
    pool: getPool(),
    redis: input.leaseRedis,
    ...(input.beforeListingOpen ? { openListingAtCommit: false } : {}),
  })
  if (input.beforeListingOpen) {
    await input.beforeListingOpen({ versionId: located.id })
    await openOfficialManagedBrowserPluginListingGate({
      slug: KNOWLEDGE_PLANET_PLUGIN_SLUG,
      expectedVersionId: located.id,
      expectedArtifactHash: COMPILED_KNOWLEDGE_PLANET_PLUGIN.artifactHash,
      expectedExecContractHash: COMPILED_KNOWLEDGE_PLANET_PLUGIN.execContractHash,
      env,
      pool: getPool(),
    })
  }
  const trusted = await findApprovedKnowledgePlanetPlugin(env)
  if (!trusted || trusted.versionId !== located.id || trusted.ownerUserId !== ownerUserId)
    throw new Error('Knowledge Planet Plugin approval failed exact trust verification')

  const migration =
    input.migrateLegacyInstalls === false
      ? { migrated: 0, skippedExisting: 0 }
      : await migrateLegacySkillInstalls(located.id)
  const retiredLegacyListing =
    input.migrateLegacyInstalls === false ? false : await retireLegacyKnowledgePlanetSkillListing()
  return {
    ownerUserId,
    versionId: located.id,
    published,
    migratedUsers: migration.migrated,
    skippedExistingUsers: migration.skippedExisting,
    migratedPluginInstalls: versionTransition.migratedInstalls,
    migratedPluginAccounts: versionTransition.migratedAccounts,
    retiredLegacyListing,
  }
}
