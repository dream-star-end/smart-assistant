/**
 * 系统级(平台内置、管理 API 不可见)agent 的静态显示名 —— 单一共享映射。
 *
 * 背景:团队模式队长可委派 hidden-reviewer 等系统 agent,聊天流有实时委派卡,但管理 API
 * 对这类 agent 做了 404 隐藏 → 前端解析不到 displayName,卡片会露出裸 id。凡展示委派
 * 目标 agent 名称的位置(TeamPanel 队员行 / 工具卡摘要等)统一经 agentDisplayName 解析:
 * 先查本映射,查不到回退裸 id(用户级 agent id 本身可读)。新增系统 agent 只需补一行,
 * 不许在组件里各写一份。
 */
export const SYSTEM_AGENT_DISPLAY_NAMES: Record<string, string> = {
  "hidden-reviewer": "质量审查员",
};

/** 解析 agent 显示名:系统映射优先,查不到回退裸 id;空值返回 ""(由调用方兜底)。 */
export function agentDisplayName(agentId: string | undefined | null): string {
  const id = (agentId ?? "").trim();
  if (!id) return "";
  return SYSTEM_AGENT_DISPLAY_NAMES[id] ?? id;
}
