/**
 * 连接器平台 · 声明式目录(可绑连接器)单一权威。
 *
 * "有哪些可装的连接器"这一读面被**两处消费**:前端管理界面(declarativeHandlers.handleCatalog)
 * 与 agent 容器 RPC(rpc.ts catalog op,供 AI 发现/搜索)。查询+投影逻辑收口在此,避免两处漂移。
 *
 * 只读、不含任何凭据:目录条目=已 security_approved 且未 revoke 的 kind='connector' 版本,
 * 投影出 slug/label/description/authMode/需填凭据字段(requiredBindSources)/动作(id+effect)。
 * 载入失败(被 revoke/篡改)的版本跳过,不阻塞整目录。
 */

import type { Pool } from 'pg'
import { requiredBindSources } from './credentialBag.js'
import { loadVerifiedContractWithMeta } from '../spec/review.js'

/** 目录里的一个可绑连接器(前端 + agent 共用形状)。 */
export interface CatalogEntry {
  versionId: number
  slug: string
  label: string
  description: string
  authMode: string
  /** bind 时用户要填的凭据字段名(source 名);凭据永不进容器,由用户在管理界面填写。 */
  requiredBindSources: string[]
  actions: Array<{ id: string; effect: string }>
}

export interface ListCatalogOptions {
  /** 可选子串过滤(agent "搜索":对 slug/label/description 大小写不敏感匹配)。 */
  query?: string
}

/** 已审可绑连接器目录(可选子串搜索)。单一权威:前端 REST 与 agent RPC 共用。 */
export async function listDeclarativeCatalog(
  pool: Pool,
  opts: ListCatalogOptions = {},
): Promise<CatalogEntry[]> {
  const rows = await pool.query<{ id: string; slug: string; name: string; description: string }>(
    `SELECT v.id::text AS id, v.slug, v.name, v.description
       FROM marketplace_skill_versions v
       JOIN marketplace_skill_listings l ON l.slug = v.slug
      WHERE l.kind = 'connector'
        AND v.security_review_state = 'security_approved'
        AND v.exec_revoked_at IS NULL
      ORDER BY v.slug`,
  )
  const q = opts.query?.trim().toLowerCase()
  const catalog: CatalogEntry[] = []
  for (const row of rows.rows) {
    try {
      const meta = await loadVerifiedContractWithMeta(Number(row.id), pool)
      const entry: CatalogEntry = {
        versionId: Number(row.id),
        slug: row.slug,
        label: row.name,
        description: row.description,
        authMode: meta.contract.authMode,
        requiredBindSources: requiredBindSources(meta.contract),
        actions: meta.contract.actions.map((a) => ({ id: a.id, effect: a.effect })),
      }
      // 子串搜索:命中 slug/label/description 任一即保留(空 query → 全量)。
      if (q) {
        const hay = `${entry.slug}\n${entry.label}\n${entry.description}`.toLowerCase()
        if (!hay.includes(q)) continue
      }
      catalog.push(entry)
    } catch {
      // 某版本载入失败(被 revoke/篡改)→ 跳过,不阻塞整目录。
    }
  }
  return catalog
}
