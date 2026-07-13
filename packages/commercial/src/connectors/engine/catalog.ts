/**
 * 声明式连接器目录与管理聚合。
 *
 * catalog 只返回「官方默认 current + 当前用户精确安装 pin」的可绑定连接器；management
 * 额外并集活跃绑定，因此已下架/被撤销/已卸载但仍有历史绑定的条目不会从管理界面消失。
 */
import type { Pool } from 'pg'
import {
  DEFAULT_CONNECTOR_ARTIFACT_HASHES,
  DEFAULT_CONNECTOR_SLUGS,
  isDefaultConnectorArtifact,
} from '../defaults/index.js'
import { listPlatformOauthAppSlugs } from '../platformOauthApps.js'
import {
  type VerifiedContract,
  isAcceptedFunctionalVerificationState,
  loadVerifiedContractWithMeta,
} from '../spec/review.js'
import { listDeclarativeConnections } from './binding.js'
import { oauth2ClientProvisioning, requiredBindSources } from './credentialBag.js'

export interface CatalogEntry {
  versionId: number
  slug: string
  label: string
  description: string
  authMode: string
  requiredBindSources: string[]
  clientProvisioning?: 'byoa' | 'platform'
  actions: Array<{ id: string; effect: string }>
}

export interface ListCatalogOptions {
  query?: string
}

function projectContract(meta: VerifiedContract, name: string, description: string): CatalogEntry {
  const provisioning =
    meta.contract.authMode === 'oauth2-auth-code'
      ? oauth2ClientProvisioning(meta.contract)
      : undefined
  return {
    versionId: meta.versionId,
    slug: meta.slug,
    label: name,
    description,
    authMode: meta.contract.authMode,
    requiredBindSources: requiredBindSources(meta.contract),
    ...(provisioning !== undefined ? { clientProvisioning: provisioning } : {}),
    actions: meta.contract.actions.map((a) => ({ id: a.id, effect: a.effect })),
  }
}

/** 前端 REST 与 agent RPC 共用；第三方条目必须是该用户当前活跃 install 的精确 pin。 */
export async function listDeclarativeCatalog(
  pool: Pool,
  userId: number,
  opts: ListCatalogOptions = {},
): Promise<CatalogEntry[]> {
  const rows = await pool.query<{
    id: string
    slug: string
    name: string
    description: string
  }>(
    `SELECT v.id::text AS id, v.slug, v.name, v.description
       FROM marketplace_skill_versions v
       JOIN marketplace_skill_listings l ON l.slug = v.slug
      WHERE l.kind = 'connector'
        AND l.state = 'active'
        AND v.status = 'approved'
        AND l.current_approved_version_id = v.id
        AND v.security_review_state = 'security_approved'
        AND v.functional_verify_state IN ('verified','declarative_verified')
        AND v.exec_revoked_at IS NULL
        AND (
          EXISTS (
            SELECT 1
              FROM unnest($2::text[], $3::text[]) AS d(slug, artifact_hash)
             WHERE d.slug = v.slug AND d.artifact_hash = v.artifact_hash
          )
          OR EXISTS (
            SELECT 1 FROM marketplace_installs i
             WHERE i.user_id = $1 AND i.slug = v.slug AND i.version_id = v.id
               AND i.artifact_hash = v.artifact_hash AND i.uninstalled_at IS NULL
          )
        )
      ORDER BY v.slug`,
    [userId, DEFAULT_CONNECTOR_SLUGS, DEFAULT_CONNECTOR_ARTIFACT_HASHES],
  )
  const q = opts.query?.trim().toLowerCase()
  const catalog: CatalogEntry[] = []
  let provisionedSlugs: Set<string> | null = null
  for (const row of rows.rows) {
    try {
      const meta = await loadVerifiedContractWithMeta(Number(row.id), pool)
      const entry = projectContract(meta, row.name, row.description)
      if (entry.clientProvisioning === 'platform') {
        provisionedSlugs ??= await listPlatformOauthAppSlugs(pool)
        if (!provisionedSlugs.has(row.slug)) continue
      }
      if (q) {
        const hay = `${entry.slug}\n${entry.label}\n${entry.description}`.toLowerCase()
        if (!hay.includes(q)) continue
      }
      catalog.push(entry)
    } catch {
      // 单条 contract 不可信时 fail-closed 跳过，不拖垮目录。
    }
  }
  return catalog
}

export interface ManagementConnectorEntry {
  slug: string
  label: string
  description: string
  installation: 'default' | 'marketplace' | 'orphan'
  official: boolean
  available: boolean
  canBind: boolean
  listingState: string
  installedVersion: string | null
  installedVersionId: string | null
  latestVersion: string | null
  latestVersionId: string | null
  updateAvailable: boolean
  connectionCount: number
  contract: CatalogEntry | null
}

export interface DeclarativeManagement {
  connectors: ManagementConnectorEntry[]
  connections: Array<{
    id: string
    slug: string
    displayName: string
    connectorVersionId: string | null
    accountHint?: string
    createdAt: string
  }>
}

/** 管理中心的统一读模型：defaults ∪ active installs ∪ active declarative bindings。 */
export async function listDeclarativeManagement(
  pool: Pool,
  userId: number,
): Promise<DeclarativeManagement> {
  const rows = await pool.query<{
    slug: string
    state: string | null
    latest_version_id: string | null
    latest_version: string | null
    latest_name: string | null
    latest_description: string | null
    latest_status: string | null
    latest_security_state: string | null
    latest_functional_state: string | null
    latest_exec_revoked_at: Date | null
    installed_version_id: string | null
    installed_version: string | null
    installed_artifact_hash: string | null
    latest_artifact_hash: string | null
    connection_count: string
  }>(
    `WITH wanted AS (
       SELECT unnest($2::text[]) AS slug
       UNION
       SELECT slug FROM marketplace_installs
        WHERE user_id = $1 AND uninstalled_at IS NULL
       UNION
       SELECT provider AS slug FROM connections
        WHERE user_id = $1 AND revoked_at IS NULL AND connector_version_id IS NOT NULL
     ), active_install AS (
       SELECT i.slug, i.version_id, i.artifact_hash
         FROM marketplace_installs i
        WHERE i.user_id = $1 AND i.uninstalled_at IS NULL
     ), binding_count AS (
       SELECT provider AS slug, count(*)::text AS n
         FROM connections
        WHERE user_id = $1 AND revoked_at IS NULL AND connector_version_id IS NOT NULL
        GROUP BY provider
     )
     SELECT w.slug, l.state,
            cv.id::text AS latest_version_id, cv.version AS latest_version,
            cv.name AS latest_name, cv.description AS latest_description,
            cv.status AS latest_status, cv.security_review_state AS latest_security_state,
            cv.functional_verify_state AS latest_functional_state,
            cv.exec_revoked_at AS latest_exec_revoked_at,
            iv.id::text AS installed_version_id, iv.version AS installed_version,
            ai.artifact_hash AS installed_artifact_hash, cv.artifact_hash AS latest_artifact_hash,
            COALESCE(bc.n, '0') AS connection_count
       FROM wanted w
       LEFT JOIN marketplace_skill_listings l ON l.slug = w.slug AND l.kind = 'connector'
       LEFT JOIN marketplace_skill_versions cv ON cv.id = l.current_approved_version_id
       LEFT JOIN active_install ai ON ai.slug = w.slug
       LEFT JOIN marketplace_skill_versions iv ON iv.id = ai.version_id
       LEFT JOIN binding_count bc ON bc.slug = w.slug
      ORDER BY w.slug`,
    [userId, DEFAULT_CONNECTOR_SLUGS],
  )

  let provisionedSlugs: Set<string> | null = null
  const connectors: ManagementConnectorEntry[] = []
  for (const row of rows.rows) {
    const official =
      row.latest_artifact_hash !== null &&
      isDefaultConnectorArtifact(row.slug, row.latest_artifact_hash)
    const hasInstall = row.installed_version_id !== null
    const exactInstall =
      hasInstall &&
      row.installed_version_id === row.latest_version_id &&
      row.installed_artifact_hash === row.latest_artifact_hash
    const executableLatest =
      row.state === 'active' &&
      row.latest_status === 'approved' &&
      row.latest_security_state === 'security_approved' &&
      isAcceptedFunctionalVerificationState(row.latest_functional_state ?? '') &&
      row.latest_exec_revoked_at === null
    let verifiedContract: CatalogEntry | null = null
    let verifiedLatest = false
    if (executableLatest && row.latest_version_id) {
      try {
        const meta = await loadVerifiedContractWithMeta(Number(row.latest_version_id), pool)
        verifiedContract = projectContract(
          meta,
          row.latest_name ?? row.slug,
          row.latest_description ?? '',
        )
        verifiedLatest = true
      } catch {
        // lifecycle 列通过但工件 hash / policy / key / signature 任一失效，管理面也标为不可用。
      }
    }
    const available = executableLatest && verifiedLatest
    let canBind = available && (official || exactInstall)
    let contract = canBind ? verifiedContract : null
    if (canBind && contract?.clientProvisioning === 'platform') {
      // loadVerifiedContractWithMeta 已保证 platform 模式只能是精确官方工件；这里再要求
      // 平台 App 已真实 provision，避免管理中心展示一个点了必失败的一键授权入口。
      try {
        provisionedSlugs ??= await listPlatformOauthAppSlugs(pool)
        if (!provisionedSlugs.has(row.slug)) {
          canBind = false
          contract = null
        }
      } catch {
        canBind = false
        contract = null
      }
    }
    connectors.push({
      slug: row.slug,
      label: row.latest_name ?? row.slug,
      description: row.latest_description ?? '',
      installation: official ? 'default' : hasInstall ? 'marketplace' : 'orphan',
      official,
      available,
      canBind,
      listingState: row.state ?? 'missing',
      installedVersion: official ? row.latest_version : row.installed_version,
      installedVersionId: official ? row.latest_version_id : row.installed_version_id,
      latestVersion: row.latest_version,
      latestVersionId: row.latest_version_id,
      updateAvailable:
        !official && hasInstall && row.latest_version_id !== null && !exactInstall && available,
      connectionCount: Number.parseInt(row.connection_count, 10) || 0,
      contract,
    })
  }

  const connectionRows = await listDeclarativeConnections(userId, pool)
  const connections = connectionRows.map((r) => ({
    id: r.id,
    slug: r.slug,
    displayName: r.displayName,
    connectorVersionId: r.connectorVersionId,
    ...(typeof r.meta.account_hint === 'string' ? { accountHint: r.meta.account_hint } : {}),
    createdAt: r.createdAt.toISOString(),
  }))
  return { connectors, connections }
}
