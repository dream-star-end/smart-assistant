// Single authority for "which OTHER agents can this agent collaborate with / see".
//
// v5 纯市场模型:一个容器里，用户实际拥有的 agent = `main`(全能助手，无 source 标记)
// + 市场安装的 agent(由 syncMarketplaceHub 写入并打 `source:'marketplace'` 标记，见
// storage/marketplaceSync + config.ts AgentDef.source 注释)。历史平台预置的子 agent
// (researcher/scientist/... 无 source 标记)已退役;它们可能仍残留在存量容器的 agents.yaml
// 里，但**不该**再作为"用户的 agent"出现在任何面上(picker=master 市场安装权威、队长组队
// 引导、系统提示协作块)。
//
// 因此凡后端枚举"其它可协作 agent"处，都必须走这里的 marketplace-source 过滤，而不是裸
// `cfg.agents.filter(...)`——后者会把幽灵平台 seed 也算进来，造成与 picker 的数据分裂，且
// 对 seed 漂移不免疫。这是"可展示/可协作"视图层，**不是授权层**(委派准入另有硬强制)。

import type { AgentDef, AgentsConfig } from '@openclaude/storage'
import { isHiddenSystemAgentId } from './agentVisibility.js'

export interface CollaboratorScope {
  /** 当前 agent 自己的 id,结果里排除它。 */
  selfId: string
  /** 是否把 `main`(无 source)也算作可协作对象。队长组队引导用 false(main 是队长自己/
   *  不作为成员);子 agent 的系统提示协作块用 true(子 agent 仍可看见并回连 main)。 */
  includeMain: boolean
}

/**
 * 返回可展示/可协作的其它 agent = 市场安装集(source==='marketplace') [+ 可选 main]，
 * 排除 self、幽灵平台 seed 与隐藏系统 agent。顺序保持 agents.yaml 原顺序。
 */
export function listCollaboratorAgents(
  cfg: Pick<AgentsConfig, 'agents'>,
  scope: CollaboratorScope,
): AgentDef[] {
  const agents = Array.isArray(cfg.agents) ? cfg.agents : []
  return agents.filter(
    (a) =>
      a.id !== scope.selfId &&
      !isHiddenSystemAgentId(a.id) &&
      (a.source === 'marketplace' || (scope.includeMain && a.id === 'main')),
  )
}
