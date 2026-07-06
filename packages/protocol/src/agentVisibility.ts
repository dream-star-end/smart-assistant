// ───────────────────────────────────────────────
// 隐藏系统 agent 可见性 —— 单一权威源
// ───────────────────────────────────────────────
// 平台保留的「系统 agent」(当前仅团队模式隐藏审查员 hidden-reviewer)只能被
// gateway 代码内部调度(delegate_task 硬编排),**绝不**出现在任何面向用户的
// 枚举/展示面(agent 管理列表、/v1/models、任务/定时/webhook 列表、协作成员、
// 技能作用域等)。
//
// 历史问题:`isHiddenSystemAgentId` 的黑名单散布在 gateway 30+ 处手工过滤里,
// 且 commercial 容器 entrypoint 还各持一份**手抄实现**(靠约定与 gateway 同步,
// 无编译期关联)。新增用户面枚举 agent 时忘插过滤就默认泄漏。
//
// 本模块把「哪些 id 是隐藏系统 agent」+「怎么把它们从用户视图里投影掉」收敛成
// 编译期单一权威:gateway `agentVisibility.ts` re-export 本模块;entrypoint 直接
// import 本模块(不再手抄)。判定/授权/执行面仍逐处用 `isHiddenSystemAgentId`
// predicate 看全量(枚举面看不见 ≠ 判定面不设防),枚举/展示面走下面的投影 helper。
//
// 设计边界(与包内其它权威模块一致):纯数据 + 纯函数,不依赖任何 gateway/storage
// 类型 —— 投影 helper 用最小结构类型(`{id?}` / `{agent?}`)约束,任何带这些字段的
// 数组都能复用。

/** 隐藏系统 agent id 集合(单一权威;新增系统 agent 只改这一处)。 */
export const HIDDEN_SYSTEM_AGENT_IDS = new Set<string>(['hidden-reviewer'])

/** 该 agent id 是否为平台保留的隐藏系统 agent。判定/授权/执行面用它看全量。 */
export function isHiddenSystemAgentId(agentId: string): boolean {
  return HIDDEN_SYSTEM_AGENT_IDS.has(agentId)
}

/** 从「agent 列表」投影掉隐藏系统 agent(按 `.id` 过滤)。 */
export function filterUserVisibleAgentsForManagement<T extends { id?: unknown }>(
  agents: readonly T[],
): T[] {
  return agents.filter((agent) => typeof agent.id !== 'string' || !isHiddenSystemAgentId(agent.id))
}

/**
 * 从「以 `.agent` 字段引用某 agent 的条目列表」投影掉指向隐藏系统 agent 的条目。
 * routes / tasks / cron jobs / webhooks 都是这种 `{agent}` 形状 —— 共用同一投影,
 * 语义 = 黑名单(仅剔除隐藏系统 agent,不隐藏指向已删除/未知 agent 的存量条目,
 * 与既有列表过滤零漂移)。新增此类列表面调用它即默认安全。
 */
export function filterUserVisibleByAgentField<T extends { agent?: unknown }>(
  items: readonly T[],
): T[] {
  return items.filter((item) => typeof item.agent !== 'string' || !isHiddenSystemAgentId(item.agent))
}

/** 从「路由列表」投影掉指向隐藏系统 agent 的路由(routes 即 `{agent}` 形状)。 */
export function filterUserVisibleRoutesForManagement<T extends { agent?: unknown }>(
  routes: readonly T[],
): T[] {
  return filterUserVisibleByAgentField(routes)
}

/** 把默认 agent 收敛到用户可见值:隐藏系统 agent(或非法值)一律回落 'main'。 */
export function userVisibleDefaultAgentId(defaultAgentId: unknown): string {
  return typeof defaultAgentId === 'string' && !isHiddenSystemAgentId(defaultAgentId)
    ? defaultAgentId
    : 'main'
}
