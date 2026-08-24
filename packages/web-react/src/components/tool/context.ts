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
import type { ToolLike } from "./format";

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

/**
 * 产物详情列(inspector)—— Codex 桌面版式的第三列:点击会话中的产物
 * (工具卡/diff/输出等)在主消息流右侧弹出详情面板,展示未截断的完整内容。
 *
 * 注入哲学同上:App 提供 open 回调才渲染入口,无 provider(测试/独立挂载)静默降级。
 * target 持消息对象引用 —— reducer 就地 mutate 同一对象,App 随 version 重渲时
 * 面板自然读到最新字段,无需订阅第二套状态。
 */
export type ArtifactInspectTarget = { kind: "tool"; message: ToolLike };

export type ArtifactInspect = {
  open?: (target: ArtifactInspectTarget) => void;
};

export const ArtifactInspectContext = createContext<ArtifactInspect>({});

export function useArtifactInspect(): ArtifactInspect {
  return useContext(ArtifactInspectContext);
}

/**
 * 卡内截断视图 → 「查看全文」的逐卡回调。由 ToolCard 绑定自己的 message 后提供,
 * DiffView/OutputBlock 等截断点消费;详情面板内不提供(全文模式无需再跳)。
 */
export const ToolInspectOpenContext = createContext<(() => void) | null>(null);

/**
 * 全文渲染模式:详情面板置 true,工具体各截断上限(diff 行数/输出长度/max-height)
 * 放开。消息流内保持 false,卡片依旧紧凑。
 */
export const ToolBodyFullContext = createContext<boolean>(false);

