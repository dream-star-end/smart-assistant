/**
 * 平台预设 agent —— 「和全能助手一样开箱即用」的官方助手集合(编程/办公/科研)。
 *
 * 语义(单一权威,my-agents 与容器 sync 共用):
 *   - 预设 = 无需安装:my-agents 恒返回、容器 sync 恒下发 listing 的 **current approved**
 *     版本(evergreen,平台改版即全员生效,不 pin 旧版);
 *   - 不可卸载(uninstall 对预设 slug 400),与全能助手一致;
 *   - kill-switch 优先:listing 被 revoke / 无 approved 版本 → 自动退出预设集合;
 *   - 科研预设受 research_config 门控(与 seed 同一门:关闭时科研 CLI 503,预设只会坏);
 *   - 整体受 marketplaceAgentsEnabled(v5 渠道)门控,v3 恒为空集。
 *
 * slug 权威 = seedPlatformAgents 的定义(同源导出),不在此重复列举。
 */
import { getResearchConfigPublic } from '../admin/researchConfig.js'
import { isDefaultConnectorArtifact } from '../connectors/defaults/index.js'
import {
  type ApprovedSearchRow,
  type ArtifactKind,
  type CallerOrgId,
  listApprovedForSearch,
  marketplaceAgentsEnabled,
} from './marketplaceDb.js'
import {
  PLATFORM_GENERAL_AGENT_SLUGS,
  PLATFORM_RESEARCH_AGENT_SLUGS,
} from './seedPlatformAgents.js'

/** 当前生效的平台预设 agent slug 集(含渠道与科研门控;fail-soft:研究配置读失败按关闭算)。 */
export async function platformPresetAgentSlugs(): Promise<string[]> {
  if (!marketplaceAgentsEnabled()) return []
  const slugs = [...PLATFORM_GENERAL_AGENT_SLUGS]
  try {
    const rc = await getResearchConfigPublic()
    if (rc.enabled) slugs.push(...PLATFORM_RESEARCH_AGENT_SLUGS)
  } catch {
    /* research config 不可读 → 视为关闭,只出通用预设 */
  }
  return slugs
}

/** 同步版判定(不含科研门控信息时不可用;调用方持有 slugs 集时用 Set 判断)。 */
export function isPresetCandidateSlug(slug: string): boolean {
  return PLATFORM_GENERAL_AGENT_SLUGS.includes(slug) || PLATFORM_RESEARCH_AGENT_SLUGS.includes(slug)
}

/**
 * 市场浏览/搜索目录的**单一权威**:approved catalog 去掉无需安装的平台预置能力。
 *
 * 平台预设 agent(编程/办公/科研)与默认 Plugin 都是"免安装、开箱即用"的,不该出现在
 * 市场发现里(与"发现→安装"语义冲突 + 冗余)。默认 Plugin 必须按 slug + artifactHash
 * 精确判断；`official` 还包括知识星球等需要用户安装的官方 Plugin，不能拿来过滤。
 * 市场有两个搜索面——浏览器 `/api/marketplace/search`(BrowsePanel)与容器 AI
 * `/internal/v3/marketplace/agent/search`(oc-market skill)——**都走此函数**,保证一处收口；
 * 以后再加市场搜索端点复用它即可,不会漏过滤。
 *
 * 注意与 `listApprovedForSearch`(=全部 approved,含预设)语义区分:后者是"上架事实"
 * (seed/install/detail 依赖它,预设本就在架),此函数是"市场对外可见目录"。
 * skill 原样透传；connector 只剔除精确默认工件，官方但非预装的 Plugin 仍可发现/安装。
 *
 * callerOrgId(企业版 P3.1):透传给 listApprovedForSearch 做 org 可见性收口——org-private
 * listing 只对本 org 成员出现在浏览/搜索目录。null = 仅公开(v3 及无 org 归属者)。
 */
export async function listMarketBrowseCatalog(
  kind: ArtifactKind,
  callerOrgId: CallerOrgId = null,
): Promise<ApprovedSearchRow[]> {
  const rows = await listApprovedForSearch(kind, callerOrgId)
  if (kind === 'connector')
    return rows.filter((row) => !isDefaultConnectorArtifact(row.slug, row.artifactHash))
  if (kind !== 'agent') return rows
  const presetSet = new Set(await platformPresetAgentSlugs())
  return presetSet.size > 0 ? rows.filter((r) => !presetSet.has(r.slug)) : rows
}
