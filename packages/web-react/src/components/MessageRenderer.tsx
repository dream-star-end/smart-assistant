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
import { Info, Sparkles } from "lucide-react";
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
  UserCard,
} from "./chat/cards";
import { AgentGroupCard } from "./chat/AgentGroupCard";
import { TeamPanel } from "./chat/TeamPanel";
import { PermissionCard, type PermissionRespond } from "./chat/PermissionCard";
import { ToolCardSlot } from "./chat/toolCardSlot";
import { TurnActivity, type TurnActivityInfo } from "./chat/TurnActivity";
import { currentTurnStartIndex } from "./chat/turnSegment";
import { MessageBoundary } from "./MessageBoundary";
import { asStr, resolveToolInput } from "./tool/format";
import { researchToolCard } from "./tool/researchCards";
import { Alert, Avatar } from "./ui";

type RendererProps = {
  message: ChatMessage;
  /** 渲染签名（变更触发重渲；不变则 memo 跳过——防闪核心）。*/
  sig: string;
  isLast: boolean;
  sending: boolean;
  /** 是否属于「当前活跃段」(最后一条 user 消息之后)。判定收口在 chat/turnSegment.ts,
   *  与 PinnedTaskTracker 的任务源提取共用同一函数——决定 TodoWrite/plan 抑制还是渲染只读卡。*/
  inActiveTurn: boolean;
  /** 当前活跃会话的本轮活动快照（AssistantCard 流式空正文分支据此渲染阶段反馈）。透传，
   *  不进 memo 比较键——TurnActivity 自带 1s tick，无需靠父级重渲驱动秒数。 */
  turnActivity?: TurnActivityInfo | null;
  cb: CardCallbacks;
  onRespondPermission: PermissionRespond;
};

export const MessageRenderer = memo(
  function MessageRenderer({ message, isLast, sending, inActiveTurn, turnActivity, cb, onRespondPermission }: RendererProps) {
    const ctx = { isLast, sending, turnActivity };
    switch (messageKind(message)) {
      case "user":
        return <UserCard msg={message} cb={cb} />;
      case "assistant":
        return <AssistantCard msg={message} ctx={ctx} cb={cb} />;
      case "thinking":
        return <ThinkingCard msg={message} ctx={ctx} />;
      case "tool": {
        // 任务列表(TodoWrite):当前活跃段且本轮进行中 → 由钉在输入框上方的 PinnedTaskTracker
        // (HUD)接管,inline 卡抑制避免上下重复;历史段(或 turn 已结束、HUD 隐藏后)渲染
        // 既有 TodoWrite 只读紧凑卡(含步骤与完成状态),翻旧会话仍能看到当时的计划。
        if (message.toolName === "TodoWrite") {
          if (inActiveTurn && sending) return null;
          return <ToolCardSlot message={message} />;
        }
        // oc-* 研究工具:直接渲染干净的专属卡片,**去掉"终端 + 命令"外壳**(boss 反馈套壳没必要)。
        // 命令出错时 researchToolCard 返回 null → 回落 ToolCardSlot 终端卡,保证报错可见。
        const ocCmd = asStr(resolveToolInput(message)?.command);
        if (ocCmd) {
          const ocCard = researchToolCard(ocCmd, message);
          if (ocCard) return <div className="px-0.5 py-1">{ocCard}</div>;
        }
        return <ToolCardSlot message={message} />;
      }
      case "plan":
        // structured plan steps:当前活跃段且本轮进行中 → 统一进 composer 上方的
        // PinnedTaskTracker,inline 抑制防同一计划上下重复两张卡;历史段渲染 PlanCard
        // 只读卡(含步骤与状态)。text-only plan(无 steps)恒走 inline 兜底。
        if ((message.steps?.length ?? 0) > 0 && inActiveTurn && sending) return null;
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
    a.sig === b.sig &&
    // 段归属变化(新 user 消息推进边界)不体现在 sig 里,必须单独参与比较,
    // 否则上一轮的 TodoWrite/plan 卡在跨轮时不会从"抑制"切到"只读卡"。
    a.inActiveTurn === b.inActiveTurn &&
    a.cb === b.cb &&
    a.onRespondPermission === b.onRespondPermission,
);

const LOAD_MORE_STEP = 100;

/** 渲染项:普通单条消息(idx 为全局下标,供活跃段归属判定),或"连续多个委派智能体聚成的团队"。 */
type RenderItem =
  | { kind: "single"; m: ChatMessage; isLast: boolean; idx: number }
  | { kind: "team"; members: ChatMessage[]; sig: string };

/**
 * 把「队长同一轮委派的多个 agent-group」聚成一个团队项(≥2 → TeamPanel;单个退化回
 * AgentGroupCard)。团队 sig = 各成员 messageSignature 拼接(任一成员变 → 面板重渲,防闪)。
 *
 * **按 turn 锚点归组**(取代旧"相邻连续行"启发式):一行的 turn 锚点 = 其前最近一条 user
 * 消息的下标——与 turnSegment.currentTurnStartIndex 同一"轮"定义(user 消息是唯一 turn
 * 边界,且 user 行客户端权威、server 从不以另一 id 重写/重排,是最稳定的归属标识)。同一
 * turn 的 agent-group 归一个面板,穿插的非 agent-group/非 user 行(队长文本、工具调用、
 * server-authored 与本地行混排)不再劈裂面板;新一轮 user 提问后的委派天然落到新锚点 →
 * 独立面板。无 user 消息(cron 会话)时全部锚点 = -1,归一段。
 *
 * 锚点用**完整 messages**(非仅渲染切片)计算:切片起点可能落在某轮中段,靠全量数组才能
 * 找到该轮真正的 user 边界。面板渲染在该轮**首个** agent-group 的位置,后续同轮成员被吸收;
 * 夹在成员之间的非 agent-group 行仍按各自位置渲染(可能落到面板之后,属可接受的次序取舍)。
 */
function coalesceTeam(messages: ChatMessage[], start: number, sending: boolean): RenderItem[] {
  const total = messages.length;
  const slice = messages.slice(start);
  // 全量前缀扫描:anchorOf[i] = 第 i 行之前(含自身若为 user)最近的 user 下标,无则 -1。
  const anchorOf: number[] = new Array(total);
  let lastUser = -1;
  for (let i = 0; i < total; i++) {
    if (messages[i]?.role === "user") lastUser = i;
    anchorOf[i] = lastUser;
  }
  // 每个锚点在**渲染切片内**的 agent-group 计数(≥2 才成团;切片外成员不计入本屏面板)。
  const teamCount = new Map<number, number>();
  for (let i = 0; i < slice.length; i++) {
    if (messageKind(slice[i]) === "agent-group") {
      const a = anchorOf[start + i];
      teamCount.set(a, (teamCount.get(a) ?? 0) + 1);
    }
  }
  const items: RenderItem[] = [];
  const emittedTeam = new Set<number>();
  for (let i = 0; i < slice.length; i++) {
    const m = slice[i];
    const absIdx = start + i;
    if (messageKind(m) === "agent-group") {
      const anchor = anchorOf[absIdx];
      if ((teamCount.get(anchor) ?? 0) >= 2) {
        if (emittedTeam.has(anchor)) continue; // 已并入该轮面板 → 吸收跳过
        emittedTeam.add(anchor);
        const members: ChatMessage[] = [];
        for (let j = 0; j < slice.length; j++) {
          if (messageKind(slice[j]) === "agent-group" && anchorOf[start + j] === anchor) {
            members.push(slice[j]);
          }
        }
        items.push({
          kind: "team",
          members,
          sig: members.map((mm) => messageSignature(mm, { isLast: false, sending })).join("||"),
        });
        continue;
      }
      items.push({ kind: "single", m, isLast: absIdx === total - 1, idx: absIdx });
      continue;
    }
    items.push({ kind: "single", m, isLast: absIdx === total - 1, idx: absIdx });
  }
  return items;
}

export function MessageList({
  messages,
  sending,
  turnActivity,
  transientNotice,
  cb,
  onRespondPermission,
}: {
  messages: ChatMessage[];
  sending: boolean;
  /** 本轮活动快照（TurnActivity 阶段反馈）；null=无活跃轮。*/
  turnActivity?: TurnActivityInfo | null;
  /** 会话级 transient 软提示（"较长时间未收到新内容…"，非消息卡片，末尾 info 条渲染）。*/
  transientNotice?: { text: string } | null;
  cb: CardCallbacks;
  onRespondPermission: PermissionRespond;
}) {
  // 溢出：默认只挂最近 LOAD_MORE_STEP 条，"加载更多历史"递增（长会话首屏不卡）。
  const [visible, setVisible] = useState(LOAD_MORE_STEP);
  const total = messages.length;
  const start = Math.max(0, total - visible);
  const last = messages[total - 1];
  // 当前活跃段起点(最后一条 user 消息之后)——TodoWrite/plan 的 HUD 抑制只作用于该段,
  // 与 PinnedTaskTracker 的任务源提取共用 turnSegment.ts 同一判定。
  const turnStart = currentTurnStartIndex(messages);
  // typing 指示：本轮进行中、且末条不是会自渲流式态的卡（assistant/thinking 自带光标，
  // permission 处于等待用户决策态）。
  const showTyping =
    sending &&
    !!last &&
    last.role !== "assistant" &&
    last.role !== "thinking" &&
    last.role !== "permission";

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-5 py-8">
      {start > 0 && (
        <button
          type="button"
          onClick={() => setVisible((v) => v + LOAD_MORE_STEP)}
          className="mx-auto rounded-full bg-hover px-3 py-1 text-xs text-muted hover:text-fg"
        >
          加载更多历史（还有 {start} 条）
        </button>
      )}
      {/* 每条消息(含团队面板)外包一层 MessageBoundary:单条渲染抛异常只降级该条,
          不让 React 卸载整棵树白屏。key 稳定在 boundary 上;memo 比较仍由内层组件承担。 */}
      {coalesceTeam(messages, start, sending).map((it) => {
        if (it.kind === "team") {
          return (
            <MessageBoundary key={it.members[0].id} messageId={it.members[0].id} sig={it.sig}>
              <TeamPanel members={it.members} sig={it.sig} />
            </MessageBoundary>
          );
        }
        const sig = messageSignature(it.m, { isLast: it.isLast, sending });
        return (
          <MessageBoundary key={it.m.id} messageId={it.m.id} sig={sig}>
            <MessageRenderer
              message={it.m}
              sig={sig}
              isLast={it.isLast}
              sending={sending}
              inActiveTurn={it.idx >= turnStart}
              turnActivity={turnActivity}
              cb={cb}
              onRespondPermission={onRespondPermission}
            />
          </MessageBoundary>
        );
      })}
      {/* 独立本轮活动指示（末条不是自渲流式态的卡时）：裸三个点 → 阶段反馈文案。 */}
      {showTyping && (
        <div className="flex gap-4 animate-in">
          {/* 与 AssistantCard 一致:移动端隐藏头像,窄屏正文占满宽度。 */}
          <Avatar tone="brand" className="mt-0.5 hidden shadow-sm sm:inline-flex">
            <Sparkles size={16} />
          </Avatar>
          <div className="min-w-0 flex-1">
            <TurnActivity info={turnActivity ?? { startedAt: null, agentName: "助手" }} />
          </div>
        </div>
      )}
      {/* 会话级 transient 软提示（超时软提示等，非消息卡片、不落库；刷新即消失，不与真内容矛盾）。 */}
      {transientNotice && (
        <Alert tone="info" icon={<Info size={16} />}>
          {transientNotice.text}
        </Alert>
      )}
    </div>
  );
}
