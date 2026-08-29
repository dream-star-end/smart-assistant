/**
 * 右栏模块注册表（PR3 扩展点契约）。
 *
 * PR8（`feat/v5-workspace-git-stat`，容器 git stat / 文件树）只允许：
 * 1. 向 `CONTEXT_RAIL_MODULE_IDS` 追加稳定 id（发布后不得改名）
 * 2. 在 App 注入的 `renderers` 字典为该 id 提供节点；`null` = 无数据，不渲染
 * 3. 全部模块 `null` 时 `ContextRail` 返回 `null`，DOM 不占宽
 * 4. 禁止画假 git 数字 / 假文件树；禁止把 AgentGate / PermissionCard 登记进来
 * 5. 不得改单实例卸载（中栏 RepoPill / PinnedTaskTracker 与右栏互斥）
 *
 * 本文件是模块清单的单一权威。壳只按数组顺序遍历，不写死两个模块。
 */
export const CONTEXT_RAIL_MODULE_IDS = ["bound-repo", "pinned-tasks"] as const;

export type ContextRailModuleId = (typeof CONTEXT_RAIL_MODULE_IDS)[number];

export const CONTEXT_RAIL_MODULES: readonly { id: ContextRailModuleId }[] =
  CONTEXT_RAIL_MODULE_IDS.map((id) => ({ id }));
