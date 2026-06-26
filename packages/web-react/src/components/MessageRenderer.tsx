/**
 * P5 会话渲染入口。
 *
 * MessageRenderer：按 role 分派单条 ChatMessage 到对应 Aurora 卡（tool 委托 ToolCardSlot）。
 * 经 messageSignature 做 memo —— reducer 就地 mutation（同对象引用）下，React.memo 浅比较
 * 会漏渲，故以「内容签名」为比较键：变才渲、不变则稳定（复刻现网 keyed-reconcile 防闪）。
 *
 * MessageList：把会话消息流渲成卡片列表 + 流式 typing 指示 + 溢出 load-more（>100 条）。
 * 上层（App）只需把 WS 引擎产出的 ChatMessage[] 与回调传进来。
 */
import { Sparkles } from "lucide-react";
import { memo, useState } from "react";
import type { ChatMessage } from "../lib/chat/model";
import { messageKind, messageSignature } from "../lib/chat/render";
import {
  AssistantCard,
  type CardCallbacks,
  DelegateProgressCard,
  PlanCard,
  SystemCard,
  ThinkingCard,
  TypingDots,
  UserCard,
} from "./chat/cards";
import { AgentGroupCard } from "./chat/AgentGroupCard";
import { PermissionCard, type PermissionRespond } from "./chat/PermissionCard";
import { ToolCardSlot } from "./chat/toolCardSlot";
import { Avatar } from "./ui";

type RendererProps = {
  message: ChatMessage;
  /** 渲染签名（变更触发重渲；不变则 memo 跳过——防闪核心）。*/
  sig: string;
  isLast: boolean;
  sending: boolean;
  cb: CardCallbacks;
  onRespondPermission: PermissionRespond;
};

export const MessageRenderer = memo(
  function MessageRenderer({ message, isLast, sending, cb, onRespondPermission }: RendererProps) {
    const ctx = { isLast, sending };
    switch (messageKind(message)) {
      case "user":
        return <UserCard msg={message} />;
      case "assistant":
        return <AssistantCard msg={message} ctx={ctx} cb={cb} />;
      case "thinking":
        return <ThinkingCard msg={message} ctx={ctx} />;
      case "tool":
        return <ToolCardSlot message={message} />;
      case "plan":
        return <PlanCard msg={message} />;
      case "permission":
        return <PermissionCard msg={message} onRespond={onRespondPermission} />;
      case "agent-group":
        return <AgentGroupCard msg={message} />;
      case "delegate-progress":
        return <DelegateProgressCard msg={message} />;
      case "system":
        return <SystemCard msg={message} />;
      default:
        // 'unknown'（含 v5 不实现的 goal/codex）——静默跳过，不出空卡。
        return null;
    }
  },
  (a, b) =>
    a.sig === b.sig && a.cb === b.cb && a.onRespondPermission === b.onRespondPermission,
);

const LOAD_MORE_STEP = 100;

export function MessageList({
  messages,
  sending,
  cb,
  onRespondPermission,
}: {
  messages: ChatMessage[];
  sending: boolean;
  cb: CardCallbacks;
  onRespondPermission: PermissionRespond;
}) {
  // 溢出：默认只挂最近 LOAD_MORE_STEP 条，"加载更多历史"递增（长会话首屏不卡）。
  const [visible, setVisible] = useState(LOAD_MORE_STEP);
  const total = messages.length;
  const start = Math.max(0, total - visible);
  const slice = messages.slice(start);
  const last = messages[total - 1];
  // typing 指示：本轮进行中、且末条不是会自渲流式态的卡（assistant/thinking 自带光标，
  // permission 处于等待用户决策态）。
  const showTyping =
    sending &&
    !!last &&
    last.role !== "assistant" &&
    last.role !== "thinking" &&
    last.role !== "permission";

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-7 px-5 py-8">
      {start > 0 && (
        <button
          type="button"
          onClick={() => setVisible((v) => v + LOAD_MORE_STEP)}
          className="mx-auto rounded-full bg-hover px-3 py-1 text-xs text-muted hover:text-fg"
        >
          加载更多历史（还有 {start} 条）
        </button>
      )}
      {slice.map((m, i) => {
        const isLast = start + i === total - 1;
        return (
          <MessageRenderer
            key={m.id}
            message={m}
            sig={messageSignature(m, { isLast, sending })}
            isLast={isLast}
            sending={sending}
            cb={cb}
            onRespondPermission={onRespondPermission}
          />
        );
      })}
      {showTyping && (
        <div className="flex gap-4 animate-in">
          <Avatar tone="brand" className="mt-0.5 shadow-sm">
            <Sparkles size={16} />
          </Avatar>
          <div className="min-w-0 flex-1">
            <TypingDots />
          </div>
        </div>
      )}
    </div>
  );
}
