/**
 * 连接器平台 · 声明式目录(可绑连接器)单一权威。
 *
 * "有哪些可装的连接器"这一读面被**两处消费**:前端管理界面(declarativeHandlers.handleCatalog)
 * 与 agent 容器 RPC(rpc.ts catalog op,供 AI 发现/搜索)。查询+投影逻辑收口在此,避免两处漂移。
 *
 * 只读、不含任何凭据:目录条目=已 security_approved 且未 revoke 的 kind='connector' 版本,
 * 投影出 slug/label/description/authMode/需填凭据字段(requiredBindSources)/动作(id+effect)。
 * 载入失败(被 revoke/篡改)的版本跳过,不阻塞整目录。
 *
 * **platform 模式 oauth2 连接器的 fail-closed 过滤**(见下 listDeclarativeCatalog):平台未
 * provision OAuth App 的条目直接不进目录 —— 用户不该看见一个"点了必报 503"的连接器,
 * AI 也不该把它推荐出去。判据与 oauth/start 的 503 完全同源(平台表有没有那一行)。
 */

import type { Pool } from 'pg'
import { listPlatformOauthAppSlugs } from '../platformOauthApps.js'
import { loadVerifiedContractWithMeta } from '../spec/review.js'
import { oauth2ClientProvisioning, requiredBindSources } from './credentialBag.js'

/** 目录里的一个可绑连接器(前端 + agent 共用形状)。 */
export interface CatalogEntry {
  versionId: number
  slug: string
  label: string
  description: string
  authMode: string
  /** bind 时用户要填的凭据字段名(source 名);凭据永不进容器,由用户在管理界面填写。 */
  requiredBindSources: string[]
  /**
   * 仅 authMode='oauth2-auth-code' 时存在:client 供给模式。
   *   'platform' → **一键授权**(平台已 provision App;能出现在目录里就意味着已 provision,
   *                见下方 fail-closed 过滤)。前端渲染"直接授权"按钮,零表单字段。
   *   'byoa'     → 用户自带 App:前端渲染 client_id/client_secret 表单(= requiredBindSources)。
   * **显式给出**,而不是让前端从 `requiredBindSources.length === 0` 反推 —— 那是隐式契约,
   * 将来任何一个 authMode 的必填字段变空都会让前端误判成"一键授权"。
   */
  clientProvisioning?: 'byoa' | 'platform'
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
        AND v.functional_verify_state = 'verified'
        AND v.exec_revoked_at IS NULL
      ORDER BY v.slug`,
  )
  const q = opts.query?.trim().toLowerCase()
  const catalog: CatalogEntry[] = []
  /**
   * 已 provision 的平台 OAuth App slug 集合。**懒加载 + 全表一次**:
   *   - 懒:目录里一个 platform 条目都没有(当前默认连接器全是 static-token/token-exchange)→ 零额外查询;
   *   - 一次:遇到第一个 platform 条目就一把捞全集缓存进闭包,后续条目查内存 Set —— 不是 N+1。
   * (表规模 = 平台自建 OAuth App 数,几十条量级,全量取回代价可忽略。)
   */
  let provisionedSlugs: Set<string> | null = null
  for (const row of rows.rows) {
    try {
      const meta = await loadVerifiedContractWithMeta(Number(row.id), pool)
      // fail-closed:platform 模式但平台没 provision → 该条目根本不进目录(与 oauth/start 503 同源判据)。
      const provisioning =
        meta.contract.authMode === 'oauth2-auth-code'
          ? oauth2ClientProvisioning(meta.contract)
          : undefined
      if (provisioning === 'platform') {
        provisionedSlugs ??= await listPlatformOauthAppSlugs(pool)
        if (!provisionedSlugs.has(row.slug)) continue
      }
      const entry: CatalogEntry = {
        versionId: Number(row.id),
        slug: row.slug,
        label: row.name,
        description: row.description,
        authMode: meta.contract.authMode,
        requiredBindSources: requiredBindSources(meta.contract),
        ...(provisioning !== undefined ? { clientProvisioning: provisioning } : {}),
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
