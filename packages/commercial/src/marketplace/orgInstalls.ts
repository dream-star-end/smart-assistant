/**
 * 企业版(P3.1)批次 C — org 维度已装技能数据层(org_installs,迁移 0113)。
 *
 * 与个人 marketplace_installs 平行:org admin 装一次 → sync 并入全 org 成员容器
 * (internalMarketplaceSync → listActiveInstalledArtifacts 的 org 分支)。本层负责:
 *   - installOrgSkill   : 事务内校验(approved+active+skill+本 org 可见)+ pin(version_id,
 *                         artifact_hash)快照 + supersede 既有活跃安装。语义完整搬自
 *                         marketplaceDb.installApprovedVersion(TOCTOU 再校验 + 版本快照)。
 *   - uninstallOrgSkill : 软删(uninstalled_at),下次 sync 差集比对从成员容器移除。
 *   - listOrgInstalls   : org 当前生效安装(JOIN listings/versions 出名称/版本/安装者/升级可见性)。
 *   - listOrgInstallCandidates : 可装候选(approved && (公开 || 本 org 私有)&& 未装)。
 *
 * 本期只做 **skill**(方案 §5):org_installs 硬约束 l.kind='skill'。agent 的 org 安装不在范围。
 * 可见性 = 公开(org_id IS NULL)∪ 本 org 私有(org_id = 本 org);不允许装他 org 私有技能。
 */

import type { PoolClient } from 'pg'
import { query, tx } from '../db/queries.js'
import {
  DEFAULT_INSTALL_AGENT_IDS,
  MarketplaceError,
  normalizeInstallAgentIds,
} from './marketplaceDb.js'

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505'
}

/**
 * org 安装一个技能。orgId 由 requireOrgRole('admin') 从 caller membership 推导(不接受客户端传)。
 * 按 slug 安装当前上架版本,pin version_id + artifact_hash 快照。
 *
 * 校验(与 installApprovedVersion 同事务、同 FOR UPDATE OF l,关 TOCTOU):
 *   - listing state='active' + current approved 版本存在 + kind='skill'
 *   - 可见性:公开(org_id IS NULL)或本 org 私有(org_id = orgId)——他 org 私有 → 视同不存在
 * 不满足 → NOT_INSTALLABLE(404)。重复活跃安装由 supersede(软删旧 + 插新)+ partial unique 兜底。
 */
export async function installOrgSkill(args: {
  orgId: string
  slug: string
  agentIds?: string[]
  installedBy: string | number
}): Promise<{ slug: string; version: string; name: string }> {
  const agentIds = normalizeInstallAgentIds(args.agentIds, DEFAULT_INSTALL_AGENT_IDS)
  return tx(async (c: PoolClient) => {
    const sel = await query<{
      version_id: string
      version: string
      name: string
      artifact_hash: string
    }>(
      `SELECT v.id::text AS version_id, v.version, v.name, v.artifact_hash
         FROM marketplace_skill_listings l
         JOIN marketplace_skill_versions v ON v.id = l.current_approved_version_id
        WHERE l.slug = $1 AND l.state = 'active' AND v.status = 'approved'
              AND l.kind = 'skill'
              AND (l.org_id IS NULL OR l.org_id = $2::bigint)
        FOR UPDATE OF l`,
      [args.slug, args.orgId],
      c,
    )
    const row = sel.rows[0]
    if (!row)
      throw new MarketplaceError(
        'NOT_INSTALLABLE',
        'skill 不可安装(未上架 / 已下架 / 非本组织可见 / 非技能类)',
      )

    // supersede:软删既有活跃安装(审计保留),再插新的 pin 快照。FOR UPDATE OF l 已按 slug
    // 串行化并发安装,partial unique(org_id,slug WHERE uninstalled_at IS NULL)是兜底。
    await query(
      `UPDATE org_installs SET uninstalled_at = NOW()
        WHERE org_id = $1::bigint AND slug = $2 AND uninstalled_at IS NULL`,
      [args.orgId, args.slug],
      c,
    )
    try {
      await query(
        `INSERT INTO org_installs (org_id, slug, version_id, artifact_hash, agent_ids, installed_by)
              VALUES ($1::bigint, $2, $3::bigint, $4, $5::jsonb, $6::bigint)`,
        [
          args.orgId,
          args.slug,
          row.version_id,
          row.artifact_hash,
          JSON.stringify(agentIds),
          String(args.installedBy),
        ],
        c,
      )
    } catch (err) {
      if (isUniqueViolation(err))
        throw new MarketplaceError('INSTALL_CONFLICT', '安装状态冲突,请重试')
      throw err
    }
    return { slug: args.slug, version: row.version, name: row.name }
  })
}

/** org 卸载:软删活跃安装。下次 sync 差集比对从成员容器移除。无活跃安装 → false。 */
export async function uninstallOrgSkill(orgId: string, slug: string): Promise<boolean> {
  const r = await query(
    `UPDATE org_installs SET uninstalled_at = NOW()
      WHERE org_id = $1::bigint AND slug = $2 AND uninstalled_at IS NULL`,
    [orgId, slug],
  )
  return (r.rowCount ?? 0) > 0
}

export interface OrgInstalledRow {
  slug: string
  name: string
  /** 安装时 pin 的版本(升级可见性:latestVersionId ≠ versionId 即"可更新")。 */
  version: string
  versionId: string
  installedBy: string
  installedAt: string
  agentIds: string[]
  /** listing 状态(active/revoked/unlisted)——被平台下架时 admin 可见。 */
  listingState: string
  /** listing 当前上架版本(无 approved 版本时为 null)。 */
  latestVersion: string | null
  latestVersionId: string | null
}

/** org 当前生效安装(活跃 org_installs JOIN listings/versions)。 */
export async function listOrgInstalls(orgId: string): Promise<OrgInstalledRow[]> {
  const r = await query<{
    slug: string
    name: string
    version: string
    version_id: string
    installed_by: string
    installed_at: string
    agent_ids: unknown
    state: string
    latest_version: string | null
    latest_version_id: string | null
  }>(
    `SELECT oi.slug, v.name, v.version, oi.version_id::text AS version_id,
            oi.installed_by::text AS installed_by, oi.installed_at::text AS installed_at,
            oi.agent_ids, l.state,
            cv.version AS latest_version, cv.id::text AS latest_version_id
       FROM org_installs oi
       JOIN marketplace_skill_versions v ON v.id = oi.version_id
       JOIN marketplace_skill_listings l ON l.slug = oi.slug
       LEFT JOIN marketplace_skill_versions cv ON cv.id = l.current_approved_version_id
      WHERE oi.org_id = $1::bigint AND oi.uninstalled_at IS NULL
      ORDER BY oi.installed_at DESC`,
    [orgId],
  )
  return r.rows.map((x) => ({
    slug: x.slug,
    name: x.name,
    version: x.version,
    versionId: x.version_id,
    installedBy: x.installed_by,
    installedAt: x.installed_at,
    agentIds: normalizeInstallAgentIds(x.agent_ids, DEFAULT_INSTALL_AGENT_IDS),
    listingState: x.state,
    latestVersion: x.latest_version,
    latestVersionId: x.latest_version_id,
  }))
}

export interface OrgInstallCandidate {
  slug: string
  name: string
  description: string
  version: string
  versionId: string
  /** public = 公开可装;org = 本组织私有技能。前端据此标注可见范围徽记。 */
  visibility: 'public' | 'org'
}

/** 候选目录硬上限(同 SEARCH_CATALOG_CAP 理由:全量拉回 + 前端过滤,增长线性劣化)。 */
const ORG_CANDIDATE_CAP = 500

/**
 * org 可装候选:approved 且 kind='skill' 且(公开 ∪ 本 org 私有)且**尚未** org 安装的 listing。
 * 已 org 安装的 slug 由 NOT EXISTS 排除(避免"发现→重复安装"歧义;更新走 listOrgInstalls 的升级可见性)。
 */
export async function listOrgInstallCandidates(orgId: string): Promise<OrgInstallCandidate[]> {
  const r = await query<{
    slug: string
    name: string
    description: string
    version: string
    version_id: string
    is_public: boolean
  }>(
    `SELECT l.slug, v.name, v.description, v.version, v.id::text AS version_id,
            (l.org_id IS NULL) AS is_public
       FROM marketplace_skill_listings l
       JOIN marketplace_skill_versions v ON v.id = l.current_approved_version_id
      WHERE l.state = 'active' AND v.status = 'approved' AND l.kind = 'skill'
            AND (l.org_id IS NULL OR l.org_id = $1::bigint)
            AND NOT EXISTS (
              SELECT 1 FROM org_installs oi
               WHERE oi.org_id = $1::bigint AND oi.slug = l.slug AND oi.uninstalled_at IS NULL
            )
      ORDER BY v.id DESC
      LIMIT ${ORG_CANDIDATE_CAP}`,
    [orgId],
  )
  return r.rows.map((x) => ({
    slug: x.slug,
    name: x.name,
    description: x.description,
    version: x.version,
    versionId: x.version_id,
    visibility: x.is_public ? 'public' : 'org',
  }))
}
