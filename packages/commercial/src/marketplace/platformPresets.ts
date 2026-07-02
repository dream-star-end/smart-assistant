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
import { marketplaceAgentsEnabled } from './marketplaceDb.js'
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
