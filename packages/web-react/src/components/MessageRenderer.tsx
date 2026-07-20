/**
 * P5 会话渲染入口。
 *
 * MessageRenderer：按 role 分派单条 ChatMessage 到对应 Aurora 卡（tool 委托 ToolCardSlot）。
 * 经 messageSignature 做 memo —— reducer 就地 mutation（同对象引用）下，React.memo 浅比较
 * 会漏渲，故以「内容签名」为比较键：变才渲、不变则稳定（复刻现网 keyed-reconcile 防闪）。
 *
 * MessageList：把会话消息流渲成虚拟卡片列表 + 流式 typing 指示 + 向上历史分页。
 * 上层（App）只需把 WS 引擎产出的 ChatMessage[] 与回调传进来。
 */
import { Info, Sparkles } from "lucide-react";
import { memo, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Virtuoso, VirtuosoMockContext } from "react-virtuoso";
import type { ChatMessage } from "../lib/chat/model";
import {
  collectResolvedDispatchTurnIds,
  HIDDEN_REVIEWER_AGENT_ID,
  isTurnStatusSuppressedByTape,
  messageKind,
  messageSignature,
} from "../lib/chat/render";
import {
  AssistantCard,
  type CardCallbacks,
  TurnProcessCard,
  DelegateProgressCard,
  GoalCard,
  PlanCard,
  SystemCard,
  ThinkingCard,
  TurnStatusCard,
  UserCard,
} from "./chat/cards";
import { AgentGroupCard } from "./chat/AgentGroupCard";
import { GeneratingPlaceholderCard } from "./chat/GeneratingPlaceholderCard";
import { TeamPanel } from "./chat/TeamPanel";
import { PermissionCard, type PermissionRespond } from "./chat/PermissionCard";
import { ToolCardSlot } from "./chat/toolCardSlot";
import { ExactToolRecordDisclosure } from "./ToolCard";
import { TurnActivity, type TurnActivityInfo } from "./chat/TurnActivity";
import { currentTurnStartIndex, turnFinalAssistantFlags } from "./chat/turnSegment";
import { loadedArchivedMetrics } from "./chat/archivePaging";
import { MessageBoundary } from "./MessageBoundary";
import { asStr, resolveToolInput, stripShellWrapperForDisplay } from "./tool/format";
import { researchToolCard } from "./tool/researchCards";
import { Alert, Avatar, Spinner } from "./ui";

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
  /** 债D:agent-group 单卡(未成团的退化委派)本 turn 的委派成本(十进制大数字符串)。
   *  来自队长助手行 usage.delegates,按 _delegateAgentId 匹配;非 agent-group 行恒 undefined。
   *  值来自**别的行**(助手行)故不在 message sig 内,单列进 memo 比较器,成本后到时正常重渲。*/
  delegateCost?: string;
  /** 该行是否为「所在轮末条 assistant 正文」(评价反馈行只挂末条,轮内中间回复不出)。
   *  值随后续消息追加而翻转,**已编进 sig head**(messageSignature 的 turnFinalAssistant)→
   *  由 a.sig===b.sig 覆盖翻转重渲,无需单列进 memo 比较器。*/
  turnFinalAssistant?: boolean;
  cb: CardCallbacks;
  onRespondPermission: PermissionRespond;
  /** 只读会话查看：禁止权限/问答卡触发任何写动作。 */
  readOnly?: boolean;
};

export const MessageRenderer = memo(
  function MessageRenderer({
    message,
    sig,
    isLast,
    sending,
    inActiveTurn,
    turnActivity,
    delegateCost,
    turnFinalAssistant,
    cb,
    onRespondPermission,
    readOnly = false,
  }: RendererProps) {
    const ctx = { isLast, sending, turnActivity, inActiveTurn, turnFinalAssistant };
    if (message._payloadDeferred) {
      return (
        <DeferredTapeRecordCard
          message={message}
          isLast={isLast}
          sending={sending}
          inActiveTurn={inActiveTurn}
          turnActivity={turnActivity}
          cb={cb}
          onRespondPermission={onRespondPermission}
          readOnly={readOnly}
        />
      );
    }
    // 过程控制不是 Agent 内容，只负责真实记录的惰性分页。
    if (message._turnTapeProcess) {
      return <TurnProcessCard msg={message} cb={cb} />;
    }
    if (message._turnStatusRecord) {
      return <TurnStatusCard msg={message} cb={cb} currentTurn={inActiveTurn} />;
    }
    if (message.role === "runtime-event") {
      return <RuntimeEventCard message={message} />;
    }
    switch (messageKind(message)) {
      case "user":
        return <UserCard msg={message} cb={cb} />;
      case "assistant":
        return <AssistantCard msg={message} ctx={ctx} cb={cb} />;
      case "thinking":
        // 单条兜底路径(直接经 MessageRenderer,如测试/非列表场景)。列表内的连续 thinking
        // 由 MessageList/coalesceTeam 合并成单张多段卡,不走这里。
        return (
          <TapeBackedCard>
            <ThinkingCard msgs={[message]} sig={sig} ctx={ctx} />
            <ExactTapeRecordDisclosure messages={[message]} label="思考" />
          </TapeBackedCard>
        );
      case "tool": {
        // 模型原生 imagegen(codex:imageGeneration)running → 生成占位卡(需求 C，粒子特效框);
        // 完成/失败回落 ToolCardSlot。running 判定语义与 bodies.tsx 一致(按 tool._completed/error
        // + input.status,不 import bodies 内部),保证两处对同一态的判断不漂移。
        if (message.toolName === "codex:imageGeneration") {
          const input = resolveToolInput(message);
          const failedStatus = /^(failed|error)$/i.test(asStr(input?.status)) || !!message.error;
          const running = !message._completed && !message.error && !failedStatus;
          if (running) {
            // native imagegen 不带目标比例 → 默认 1:1(规格 §36);startedAt = 工具行 mint 时刻。
            return <GeneratingPlaceholderCard aspect={1} status="running" startedAt={message.ts} />;
          }
        }
        // 任务列表(TodoWrite):当前活跃段且本轮进行中 → 由钉在输入框上方的 PinnedTaskTracker
        // (HUD)接管,inline 卡抑制避免上下重复;历史段(或 turn 已结束、HUD 隐藏后)渲染
        // 既有 TodoWrite 只读紧凑卡(含步骤与完成状态),翻旧会话仍能看到当时的计划。
        if (message.toolName === "TodoWrite") {
          if (inActiveTurn && sending) return null;
          return <ToolCardSlot message={message} />;
        }
        // oc-* 研究工具:直接渲染干净的专属卡片,**去掉"终端 + 命令"外壳**(boss 反馈套壳没必要)。
        // 命令出错时 researchToolCard 返回 null → 回落 ToolCardSlot 终端卡,保证报错可见。
        const ocCmd = stripShellWrapperForDisplay(asStr(resolveToolInput(message)?.command));
        if (ocCmd) {
          const ocCard = researchToolCard(ocCmd, message);
          if (ocCard) {
            return (
              <div className="px-0.5 py-1">
                {ocCard}
                <ExactToolRecordDisclosure message={message} />
              </div>
            );
          }
        }
        return <ToolCardSlot message={message} />;
      }
      case "plan":
        // structured plan steps:当前活跃段且本轮进行中 → 统一进 composer 上方的
        // PinnedTaskTracker,inline 抑制防同一计划上下重复两张卡;历史段渲染 PlanCard
        // 只读卡(含步骤与状态)。text-only plan(无 steps)恒走 inline 兜底。
        if ((message.steps?.length ?? 0) > 0 && inActiveTurn && sending) return null;
        return (
          <TapeBackedCard>
            <PlanCard msg={message} />
            <ExactTapeRecordDisclosure messages={[message]} label="计划" />
          </TapeBackedCard>
        );
      case "goal":
        return (
          <TapeBackedCard>
            <GoalCard msg={message} />
            <ExactTapeRecordDisclosure messages={[message]} label="目标" />
          </TapeBackedCard>
        );
      case "permission":
        return <PermissionCard msg={message} onRespond={onRespondPermission} readOnly={readOnly} />;
      case "agent-group":
        return <AgentGroupCard msg={message} delegateCost={delegateCost} />;
      case "delegate-progress":
        return <DelegateProgressCard msg={message} />;
      case "system":
        return <SystemCard msg={message} />;
      default:
        // Immutable tape rows must remain visible even when a newer engine
        // introduces a role this web build does not yet understand. Render
        // the exact raw record instead of silently dropping the event.
        return message._turnTapeId ? <RuntimeEventCard message={message} /> : null;
    }
  },
  (a, b) =>
    a.sig === b.sig &&
    // 段归属变化(新 user 消息推进边界)不体现在 sig 里,必须单独参与比较,
    // 否则上一轮的 TodoWrite/plan 卡在跨轮时不会从"抑制"切到"只读卡"。
    a.inActiveTurn === b.inActiveTurn &&
    // 债D 委派成本来自别的行(助手行 usage.delegates),不进 message sig,单列比较,
    // 否则成本在 agent-group 完成后才到达时 memo 会跳过重渲、单卡不显示「N 积分」。
    a.delegateCost === b.delegateCost &&
    a.readOnly === b.readOnly &&
    a.cb === b.cb &&
    a.onRespondPermission === b.onRespondPermission,
);

const RUNTIME_TEXT_STEP = 32 * 1024;

function TapeBackedCard({ children }: { children: ReactNode }) {
  return <div className="space-y-1">{children}</div>;
}

/** Readable cards retain their pre-direct-timeline UX, while the immutable
 * source remains reachable byte-for-byte instead of being replaced by the
 * formatted view. Serialization and mounting happen only after the click. */
function ExactTapeRecordDisclosure({
  messages,
  label,
}: {
  messages: ChatMessage[];
  label: string;
}) {
  const exactMessages = messages.filter((message) => !!message._turnTapeId);
  const [open, setOpen] = useState(false);
  const [visibleChars, setVisibleChars] = useState(RUNTIME_TEXT_STEP);
  if (exactMessages.length === 0) return null;

  const raw = exactMessages.length === 1
    ? exactMessages[0]._eventHistory ?? exactMessages[0]
    : exactMessages.map((message) => message._eventHistory ?? message);
  const serialized = open ? JSON.stringify(raw, null, 2) ?? String(raw) : "";

  return (
    <div className="px-1">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="text-[11px] text-faint hover:text-muted"
      >
        {open ? `收起原始${label}记录` : `查看原始${label}记录`}
      </button>
      {open && (
        <div className="mt-1 rounded-md border border-border bg-surface px-3 py-2">
          <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-muted">
            {serialized.slice(0, visibleChars)}
          </pre>
          {visibleChars < serialized.length && (
            <button
              type="button"
              onClick={() => setVisibleChars((value) => value + RUNTIME_TEXT_STEP)}
              className="mt-2 rounded-full bg-hover px-2.5 py-1 text-[11px] text-muted hover:text-fg"
            >
              继续显示原始记录
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Every persisted runtime event remains inspectable. The JSON body is
 * progressively mounted so a multi-megabyte event never blocks a frame. */
function RuntimeEventCard({ message }: { message: ChatMessage }) {
  const raw = message._runtimeEvent ?? message;
  const event = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const eventLabel = [event.type, event.subtype].filter((part) => typeof part === "string").join(" · ");
  const label = eventLabel || (message.role === "runtime-event"
    ? "运行事件"
    : `原始 Agent 记录 · ${message.role || "unknown"}`);
  const [open, setOpen] = useState(false);
  const [visibleChars, setVisibleChars] = useState(RUNTIME_TEXT_STEP);
  const serialized = open ? JSON.stringify(raw, null, 2) : "";
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface animate-in">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-[12.5px] hover:bg-hover"
      >
        <span className="size-1.5 shrink-0 rounded-full bg-faint" />
        <span className="min-w-0 flex-1 truncate text-muted">{label}</span>
        {message._runtimeSource && <span className="shrink-0 text-[11px] text-faint">{message._runtimeSource}</span>}
        <span className="text-faint">{open ? "收起" : "查看原始记录"}</span>
      </button>
      {open && (
        <div className="border-t border-border px-3.5 py-2.5">
          <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-muted">
            {serialized.slice(0, visibleChars)}
          </pre>
          {visibleChars < serialized.length && (
            <button
              type="button"
              onClick={() => setVisibleChars((value) => value + RUNTIME_TEXT_STEP)}
              className="mt-2 rounded-full bg-hover px-2.5 py-1 text-[11px] text-muted hover:text-fg"
            >
              继续显示原始记录
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function DeferredTapeRecordCard({
  message,
  isLast,
  sending,
  inActiveTurn,
  turnActivity,
  cb,
  onRespondPermission,
  readOnly,
}: Omit<RendererProps, "sig" | "delegateCost" | "turnFinalAssistant">) {
  const ref = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const [records, setRecords] = useState<ChatMessage[] | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    if (started.current || !cb.onFetchTapeRecordPayload) return;
    const tapeId = message._turnTapeId;
    const ordinal = message._recordOrdinal;
    const sha256 = message._payloadSha256;
    if (!tapeId || typeof ordinal !== "number") return;
    started.current = true;
    setFailed(false);
    const loaded = await cb.onFetchTapeRecordPayload(tapeId, ordinal, {
      recordId: message.id,
      role: message.role,
      ...(sha256 ? { contentSha256: sha256 } : {}),
    });
    if (!loaded) {
      started.current = false;
      setFailed(true);
      return;
    }
    setRecords(loaded.map((record) => ({
      ...record,
      _turnTapeId: tapeId,
      _turnTapeSha256: message._turnTapeSha256,
      _turnTapeOrdinal: ordinal,
      _recordOrdinal: ordinal,
      _turnTapeComplete: true,
      _turnTapeProcessLoadedFrom: message._turnTapeProcessLoadedFrom,
      _seq: message._seq,
      _orderSeq: message._orderSeq,
      _clientMessageId: record._clientMessageId ?? message._clientMessageId,
    })));
  }, [cb, message]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      void load();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          void load();
        }
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [load]);

  if (records) {
    return (
      <div className="space-y-3">
        {records.map((record, index) => {
          const final = isLast && index === records.length - 1;
          const recordSig = messageSignature(record, { isLast: final, sending, turnFinalAssistant: false });
          return (
            <MessageRenderer
              key={record.id}
              message={record}
              sig={recordSig}
              isLast={final}
              sending={sending}
              inActiveTurn={inActiveTurn}
              turnActivity={turnActivity}
              cb={cb}
              onRespondPermission={onRespondPermission}
              readOnly={readOnly}
            />
          );
        })}
      </div>
    );
  }
  return (
    <div ref={ref} className="rounded-lg border border-dashed border-border bg-surface px-3.5 py-3 text-xs text-muted">
      {failed ? (
        <button type="button" onClick={() => void load()} className="text-danger hover:underline">
          真实记录加载失败，点击重试
        </button>
      ) : (
        <span>正在读取真实 Agent 记录…</span>
      )}
    </div>
  );
}

/** 渲染项:普通单条消息(idx 为全局下标,供活跃段归属判定),或"连续多个委派智能体聚成的团队",
 *  或"连续多个 role=thinking 行合并成的单张多段思考卡"。
 *  delegateCost / delegateCosts = 债D per-delegate 成本(见 coalesceTeam)。 */
type RenderItem =
  | { kind: "single"; m: ChatMessage; isLast: boolean; idx: number; delegateCost?: string }
  | { kind: "team"; members: ChatMessage[]; sig: string; delegateCosts?: Record<string, string> }
  | { kind: "thinking"; members: ChatMessage[]; sig: string; isLast: boolean; idx: number };

/**
 * 把「队长**同一并行批次**委派的多个 agent-group」聚成一个团队项(≥2 → TeamPanel;单个
 * 退化回 AgentGroupCard)。团队 sig = 各成员 messageSignature 拼接(任一成员变 → 面板重渲,防闪)。
 *
 * **按 (turn 锚点, 叙事阶段) 归组**(2026-07-07,boss 时序反直觉反馈):
 *   - turn 锚点 = 其前最近一条 user 消息下标(与 turnSegment 同一"轮"定义,user 行客户端
 *     权威、server 从不重写/重排,最稳定)。
 *   - 叙事阶段 = 同 turn 内被**队长 assistant 叙事文本行**(非空 text)切开的段序号。聚天线
 *     只允许"同时并行"的委派共面板;队长叙事之后才启动的阶段(如 hidden-reviewer 审查)
 *     属于新阶段 → **按时间顺序独立出现在叙事之后**,绝不吸回上方旧面板(旧行为把审查卡
 *     塞回面板,造成"上面又动了/会话早就结束了"的错觉)。
 *   - 隐藏审查员(hidden-reviewer)卡**永不入面板**:它语义上是编排阶段而非并行队员,恒走
 *     单卡按时序渲染。
 *   - 只有 assistant 叙事行断组;工具行/thinking/server-authored 骨架混排**不隔断**——保留
 *     turn 锚点方案修掉的"混排劈裂面板"抗性(这是当年放弃纯相邻启发式的原因,勿回退)。
 *
 * 锚点/阶段用**完整 messages**(非仅渲染切片)计算:切片起点可能落在某轮中段,靠全量数组
 * 才能找到该轮真正的边界。面板渲染在该批次**首个** agent-group 的位置,后续同批成员被吸收;
 * 夹在成员之间的非 agent-group 行仍按各自位置渲染(可能落到面板之后,属可接受的次序取舍)。
 */
function coalesceTeam(messages: ChatMessage[], start: number, sending: boolean): RenderItem[] {
  const total = messages.length;
  const slice = messages.slice(start);
  // 全量前缀扫描:anchorOf[i] = 第 i 行之前(含自身若为 user)最近的 user 下标,无则 -1;
  // stageOf[i] = 该行在本 turn 内的叙事阶段序号(assistant 非空文本行使**后续**行阶段 +1,
  // user 行重置为 0)。
  const anchorOf: number[] = new Array(total);
  const stageOf: number[] = new Array(total);
  let lastUser = -1;
  let stage = 0;
  for (let i = 0; i < total; i++) {
    const row = messages[i];
    if (row?.role === "user") {
      lastUser = i;
      stage = 0;
    }
    anchorOf[i] = lastUser;
    stageOf[i] = stage;
    if (row?.role === "assistant" && typeof row.text === "string" && row.text.trim().length > 0) {
      stage++;
    }
  }
  // 面板成员资格:agent-group 且非隐藏审查员(审查卡恒单卡,按时序独立渲染)。
  const isPanelMember = (m: ChatMessage | undefined): boolean =>
    !!m && messageKind(m) === "agent-group" && m._delegateAgentId !== HIDDEN_REVIEWER_AGENT_ID;
  const batchKeyOf = (absIdx: number): string => `${anchorOf[absIdx]}:${stageOf[absIdx]}`;
  // 债D per-delegate 成本:队长**助手行**(role 'assistant',同一 turn 的最终答复)的
  // usage.delegates 已由 master 按 agentId 分组求和。按 turn 锚点归拢成 anchor → {agentId:
  // costCredits},供该轮团队卡/委派卡按 `_delegateAgentId` 匹配显示「· N 积分」。同一 agentId
  // 一轮被多次委派(如审查跑 2 轮)时是合计值 → 多张同名卡显示相同合计,已知可接受粒度。
  const delegateCostByAnchor = new Map<number, Record<string, string>>();
  for (let i = 0; i < total; i++) {
    const mm = messages[i];
    if (mm?.role !== "assistant" || !mm.usage?.delegates?.length) continue;
    const rec = delegateCostByAnchor.get(anchorOf[i]) ?? {};
    for (const d of mm.usage.delegates) {
      // 同 turn 若多条助手行都带 delegates,后者(最终答复行)胜。
      if (d && typeof d.agentId === "string" && typeof d.costCredits === "string") {
        rec[d.agentId] = d.costCredits;
      }
    }
    delegateCostByAnchor.set(anchorOf[i], rec);
  }
  const costFor = (absIdx: number, m: ChatMessage): string | undefined =>
    delegateCostByAnchor.get(anchorOf[absIdx])?.[m._delegateAgentId ?? ""];
  // 每个批次键在**渲染切片内**的可入面板 agent-group 计数(≥2 才成团;切片外成员不计入本屏面板)。
  const teamCount = new Map<string, number>();
  for (let i = 0; i < slice.length; i++) {
    if (isPanelMember(slice[i])) {
      const k = batchKeyOf(start + i);
      teamCount.set(k, (teamCount.get(k) ?? 0) + 1);
    }
  }
  const items: RenderItem[] = [];
  const emittedTeam = new Set<string>();
  // 连续 thinking 行合并:被吸收进某组的 thinking 行(首条除外)记入此集,外层循环跳过它们。
  const consumedThinking = new Set<number>();
  for (let i = 0; i < slice.length; i++) {
    const m = slice[i];
    const absIdx = start + i;
    if (consumedThinking.has(absIdx)) continue; // 已并入上方某思考卡 → 吸收跳过
    if (isPanelMember(m)) {
      const batchKey = batchKeyOf(absIdx);
      if ((teamCount.get(batchKey) ?? 0) >= 2) {
        if (emittedTeam.has(batchKey)) continue; // 已并入该批次面板 → 吸收跳过
        emittedTeam.add(batchKey);
        const members: ChatMessage[] = [];
        const memberIdx: number[] = [];
        for (let j = 0; j < slice.length; j++) {
          if (isPanelMember(slice[j]) && batchKeyOf(start + j) === batchKey) {
            members.push(slice[j]);
            memberIdx.push(start + j);
          }
        }
        const delegateCosts = delegateCostByAnchor.get(anchorOf[absIdx]);
        items.push({
          kind: "team",
          members,
          // 成本值取自别的行(助手行),不在成员 message sig 内 → 折进团队 sig(每成员 cost 拼入),
          // 否则成本后到时 TeamPanel 的 sig-only memo 会跳过重渲(见 TeamPanel 尾 memo 注释)。
          sig: members
            .map(
              (mm, k) =>
                `${messageSignature(mm, { isLast: false, sending })}|c:${costFor(memberIdx[k], mm) ?? ""}`,
            )
            .join("||"),
          delegateCosts,
        });
        continue;
      }
      items.push({ kind: "single", m, isLast: absIdx === total - 1, idx: absIdx, delegateCost: costFor(absIdx, m) });
      continue;
    }
    if (messageKind(m) === "agent-group") {
      // 面板外的 agent-group(隐藏审查员卡/独居成员):单卡按时序渲染,委派成本徽记照常。
      items.push({ kind: "single", m, isLast: absIdx === total - 1, idx: absIdx, delegateCost: costFor(absIdx, m) });
      continue;
    }
    if (messageKind(m) === "thinking") {
      // 连续 thinking 行合并成单张多段卡(codex 一轮产十几条空正文标题卡)。中间夹**被跳过/
      // 不渲染的行**(messageKind==='unknown',渲染层本就静默)透明跳过不断组;任何会渲染的
      // 非 thinking 行(assistant/tool/agent-group 等)断组。参考 render.ts unknown 跳过 + 上方
      // coalesceTeam 混排不劈裂先例。
      const members: ChatMessage[] = [];
      let lastAbs = absIdx;
      for (let j = i; j < slice.length; j++) {
        const kj = messageKind(slice[j]);
        if (kj === "thinking") {
          members.push(slice[j]);
          consumedThinking.add(start + j);
          lastAbs = start + j;
        } else if (kj === "unknown") {
          continue; // 透明跳过(不打断连续性;该行仍会被外层循环按原位渲染成 null)
        } else {
          break;
        }
      }
      // 组"live"取决于末条 thinking 是否为全列表末行且本轮在流(thinking isLive 语义)。
      const groupIsLast = lastAbs === total - 1;
      // 组 sig = 各成员签名拼接(仅末条按 groupIsLast 参与 isLast;文本 + 流式态都编进,
      // 后到成员/流式完成时 memo 正常重渲防漏渲)。key 用首条成员 id → 流式追加成员时稳定不重挂。
      const sig = members
        .map((mm, k) => messageSignature(mm, { isLast: groupIsLast && k === members.length - 1, sending }))
        .join("||");
      items.push({ kind: "thinking", members, sig, isLast: groupIsLast, idx: absIdx });
      continue;
    }
    items.push({ kind: "single", m, isLast: absIdx === total - 1, idx: absIdx });
  }
  return items;
}

/**
 * 会话归档分页上下文(§4/§5)。App 从 chat.getSession 读会话归档水位/计数,并接线 Agent C 的
 * loadOlderHistory + 视口保持。未传(如 demo / 老测试)时按「无归档、仅本地翻页」退化,行为不变。
 */
export type MessageListArchive = {
  /** 会话归档总条数(client_sessions.archived_count 透传);0 = 无归档。 */
  archivedCount: number;
  /** 归档水位线 _seq(≤ 此值的行已 spill 到归档表);判定 messages 里哪些是已拉回的归档行。 */
  archivedThroughSeq: number;
  /** 云端加载进行中(按钮转 loading 态、禁用)。 */
  loading: boolean;
  /** 上次云端加载失败(按钮转「加载失败，点击重试」,点击即重试)。 */
  error: boolean;
  /** 拉更早一页归档(App 接线 loadOlderHistory + 前插后视口保持)。 */
  onLoadOlder: () => void;
};

export function MessageList({
  messages,
  sending,
  turnActivity,
  transientNotice,
  archive,
  cb,
  onRespondPermission,
  readOnly = false,
  scrollParent,
}: {
  messages: ChatMessage[];
  sending: boolean;
  /** 本轮活动快照（TurnActivity 阶段反馈）；null=无活跃轮。*/
  turnActivity?: TurnActivityInfo | null;
  /** 会话级 transient 软提示（"较长时间未收到新内容…"，非消息卡片，末尾 info 条渲染）。*/
  transientNotice?: { text: string } | null;
  /** 归档分页上下文；缺省=无归档(仅本地翻页)。*/
  archive?: MessageListArchive | null;
  cb: CardCallbacks;
  onRespondPermission: PermissionRespond;
  /** 管理端等只读 surface；默认 false，用户端行为不变。 */
  readOnly?: boolean;
  /** Existing chat scroller. When present, only viewport-adjacent rows mount. */
  scrollParent?: HTMLElement | null;
}) {
  // Drop only legacy substitute rows already present in an old IndexedDB
  // cache. Runtime events from the immutable tape are first-class renderable
  // records and must never be filtered out.
  const resolvedDispatchTurnIds = collectResolvedDispatchTurnIds(messages);
  const renderableMessages = messages.filter(
    (m) =>
      !(m as ChatMessage & { _historyProjection?: unknown })._historyProjection &&
      !m.id.startsWith("projection-") &&
      !m.id.startsWith("oc-dispatch-err:") &&
      !isTurnStatusSuppressedByTape(m, resolvedDispatchTurnIds),
  );
  const total = renderableMessages.length;
  const archivedThroughSeq = archive?.archivedThroughSeq ?? 0;
  const archivedAnchors = archive
    ? loadedArchivedMetrics(messages, archivedThroughSeq).anchors
    : 0;
  const archivedRemaining = Math.max(0, (archive?.archivedCount ?? 0) - archivedAnchors);
  const last = renderableMessages[total - 1];
  // 当前活跃段起点(最后一条 user 消息之后)——TodoWrite/plan 的 HUD 抑制只作用于该段,
  // 与 PinnedTaskTracker 的任务源提取共用 turnSegment.ts 同一判定。
  const turnStart = currentTurnStartIndex(renderableMessages);
  // 每条消息是否为「所在轮末条 assistant 正文」(评价反馈行唯一可见位)。按全量 messages 下标对齐,
  // 单一权威在 turnSegment.ts(与 turnStart / coalesceTeam 同源的 user=轮边界判定,不另造第二套)。
  const ratingFinal = turnFinalAssistantFlags(renderableMessages);
  // typing 指示：本轮进行中、且末条不是会自渲流式态的卡（assistant/thinking 自带光标，
  // permission 处于等待用户决策态）。
  const showTyping =
    sending &&
    !!last &&
    last.role !== "assistant" &&
    last.role !== "thinking" &&
    last.role !== "permission" &&
    // 生成占位卡本身即进度指示器(粒子框 + 角标),末条是占位时不再叠裸 typing 三点。
    !last._genPlaceholder;
  const renderItems = coalesceTeam(renderableMessages, 0, sending);
  const itemKey = (item: RenderItem) => item.kind === "single" ? item.m.id : item.members[0].id;
  const renderItem = (it: RenderItem) => {
    if (it.kind === "single" && it.m._genPlaceholder) {
      const gp = it.m._genPlaceholder;
      const placeholderSig = `genph|${it.m.id}|${gp.status}|${gp.startedAt}|${gp.aspect}`;
      return (
        <MessageBoundary messageId={it.m.id} sig={placeholderSig}>
          <GeneratingPlaceholderCard
            aspect={gp.aspect}
            status={gp.status}
            startedAt={gp.startedAt}
            reason={gp.reason}
          />
        </MessageBoundary>
      );
    }
    if (it.kind === "team") {
      return (
        <MessageBoundary messageId={it.members[0].id} sig={it.sig}>
          <TeamPanel members={it.members} sig={it.sig} delegateCosts={it.delegateCosts} />
        </MessageBoundary>
      );
    }
    if (it.kind === "thinking") {
      return (
        <MessageBoundary messageId={it.members[0].id} sig={it.sig}>
          <TapeBackedCard>
            <ThinkingCard msgs={it.members} sig={it.sig} ctx={{ isLast: it.isLast, sending }} />
            <ExactTapeRecordDisclosure messages={it.members} label="思考" />
          </TapeBackedCard>
        </MessageBoundary>
      );
    }
    const turnFinalAssistant = ratingFinal[it.idx] ?? false;
    const rowSig = messageSignature(it.m, { isLast: it.isLast, sending, turnFinalAssistant });
    return (
      <MessageBoundary messageId={it.m.id} sig={rowSig}>
        <MessageRenderer
          message={it.m}
          sig={rowSig}
          isLast={it.isLast}
          sending={sending}
          inActiveTurn={it.idx >= turnStart}
          turnActivity={turnActivity}
          delegateCost={it.delegateCost}
          turnFinalAssistant={turnFinalAssistant}
          cb={cb}
          onRespondPermission={onRespondPermission}
          readOnly={readOnly}
        />
      </MessageBoundary>
    );
  };
  const historyControl = archivedRemaining > 0 && archive ? (
    <div className="mx-auto flex max-w-3xl justify-center px-5 pb-4 pt-8">
        <button
          type="button"
          onClick={archive.onLoadOlder}
          disabled={archive.loading}
          aria-busy={archive.loading}
          className="mx-auto inline-flex items-center gap-1.5 rounded-full bg-hover px-3 py-1 text-xs text-muted transition-colors hover:text-fg disabled:cursor-default disabled:opacity-60 [@media(hover:none)]:min-h-11 [@media(hover:none)]:py-2.5"
        >
          {archive.loading ? (
            <>
              <Spinner size={12} /> 加载中…
            </>
          ) : archive.error ? (
            <span className="text-danger">加载失败，点击重试</span>
          ) : (
            `向上滚动加载更早历史（还有 ${archivedRemaining} 条）`
          )}
        </button>
    </div>
  ) : null;
  const footer = (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-5 pb-8 pt-4">
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

  // App/admin pass an explicit null during the callback-ref's first commit.
  // Mounting the non-virtual fallback in that one frame would still build the
  // entire long transcript before Virtuoso can take over. Omitted/undefined
  // remains the lightweight test/non-scroll surface contract.
  if (scrollParent === null) {
    return (
      <div className="mx-auto flex max-w-3xl items-center justify-center px-5 py-8 text-muted" role="status">
        <Spinner size={14} />
        <span className="ml-2 text-xs">正在准备会话…</span>
      </div>
    );
  }

  if (scrollParent) {
    const virtualList = (
      <Virtuoso
        customScrollParent={scrollParent}
        data={renderItems}
        computeItemKey={(_index, item) => itemKey(item)}
        itemContent={(_index, item) => (
          <div className="mx-auto max-w-3xl px-5 pb-4">{renderItem(item)}</div>
        )}
        initialTopMostItemIndex={Math.max(0, renderItems.length - 1)}
        increaseViewportBy={{ top: 800, bottom: 1200 }}
        overscan={400}
        followOutput={sending ? "auto" : false}
        startReached={() => {
          if (archive && archivedRemaining > 0 && !archive.loading) archive.onLoadOlder();
        }}
        components={{
          Header: () => historyControl,
          Footer: () => footer,
        }}
      />
    );
    // jsdom has no layout engine, so Virtuoso cannot infer a viewport from the
    // real scroll parent during App integration tests. Its official mock
    // context supplies dimensions while preserving the same virtualized data,
    // keying and initial-tail behavior. Vite removes this branch from builds.
    return import.meta.env.MODE === "test" ? (
      <VirtuosoMockContext.Provider value={{ viewportHeight: 768, itemHeight: 96 }}>
        {virtualList}
      </VirtuosoMockContext.Provider>
    ) : virtualList;
  }

  // Tests/non-scroll surfaces keep a simple tree; production chat uses the
  // virtualized branch above.
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-5 py-8">
      {historyControl}
      {renderItems.map((item) => <div key={itemKey(item)}>{renderItem(item)}</div>)}
      {footer}
    </div>
  );
}
