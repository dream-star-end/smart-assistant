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
import type { ConnectorConfirmationDetail, ConnectorDecisionResult } from "../../lib/connectors";

export type ToolCardActions = {
  /** 打开记忆中心（memory / archival / session_search 类）。 */
  onOpenMemory?: () => void;
  /** 打开技能库（skill_* 类）。 */
  onOpenSkills?: () => void;
  /** 打开定时任务（create_reminder）。 */
  onOpenTasks?: () => void;
  /** 论文卡动作（scansci 下载 PDF / 生成引用）。 */
  onPaperAction?: (action: "download" | "citation", identifier: string) => void;
  /**
   * 连接器写操作确认卡（oc-connect，human-in-the-loop）：详情拉取 + 批准/拒绝。
   * 需登录鉴权（Bearer），由 App 绑定 authRef 注入；无 provider（demo/未登录）时
   * 卡片降级为纯展示（同本 context 其余动作的哲学）。
   */
  connectorConfirm?: {
    getDetail: (id: string) => Promise<ConnectorConfirmationDetail>;
    decide: (id: string, decision: "approve" | "deny") => Promise<ConnectorDecisionResult>;
  };
};

export const ToolCardActionsContext = createContext<ToolCardActions>({});

export function useToolCardActions(): ToolCardActions {
  return useContext(ToolCardActionsContext);
}

/**
 * 对话交互 context —— 让消息渲染层的交互块(如 ```options 选择卡片)能替用户
 * 发送一条消息。与 ToolCardActions 同一注入哲学:有 provider 才可交互,无则降级
 * 为纯展示。busy = 正在流式/发送中,交互块应禁用点击。
 */
export type ChatInteraction = {
  sendUserText?: (text: string) => void;
  busy?: boolean;
};

export const ChatInteractionContext = createContext<ChatInteraction>({});

export function useChatInteraction(): ChatInteraction {
  return useContext(ChatInteractionContext);
}

