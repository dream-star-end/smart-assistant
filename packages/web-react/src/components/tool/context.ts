/**
 * ToolCard 的「上下文动作」可选回调。
 *
 * 现网 memory / scansci 工具卡带「打开记忆中心 / 技能库 / 定时任务」与论文「下载 PDF /
 * 生成引用」等动作按钮（vanilla 走全局 `_openMemoryModal?.()` 等可选钩子）。Aurora 把它们
 * 收敛成一个 React context：**有 provider 才渲染按钮，无则静默隐藏**。
 *
 * 这样 ToolCard 的数据契约保持纯净（只吃单个 tool 对象，见 ToolCard.tsx），交互能力按需
 * 由上层 App/MessageRenderer 注入，不污染 props，也不引入第二套传参机制。
 */
import { createContext, useContext } from "react";

export type ToolCardActions = {
  /** 打开记忆中心（memory / archival / session_search 类）。 */
  onOpenMemory?: () => void;
  /** 打开技能库（skill_* 类）。 */
  onOpenSkills?: () => void;
  /** 打开定时任务（create_reminder）。 */
  onOpenTasks?: () => void;
  /** 论文卡动作（scansci 下载 PDF / 生成引用）。 */
  onPaperAction?: (action: "download" | "citation", identifier: string) => void;
};

export const ToolCardActionsContext = createContext<ToolCardActions>({});

export function useToolCardActions(): ToolCardActions {
  return useContext(ToolCardActionsContext);
}
