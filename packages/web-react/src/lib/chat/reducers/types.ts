/**
 * Shared types for chat frame reducers (leaf module — zero upward/sibling reducer imports).
 */
import type { OutboundContentBlock, OutboundMessageWire } from "../frames";
import type { ChatSession } from "../model";
import type { EmptyTurnDecision } from "../pure";
import type { UserError } from "../userErrorView";

export type ProblemCardPath =
  | "immediate"
  | "deferred"
  | "decision_timeout"
  | "adoption_timeout"
  | "decision_declined"
  | "recovery_skipped"
  | "stop_fenced"
  | "recovery_adopted";

export type ProblemCardMaterializeCause =
  | "decision_timeout"
  | "adoption_timeout"
  | "decision_declined"
  | "recovery_skipped"
  | "stop_fenced";

export type ProblemCardReport = {
  rootCmid: string;
  code: string;
  outcome: "pending" | "failed" | "recovered" | "cancelled";
  path: ProblemCardPath;
  presentation: "red" | "yellow" | "soft";
  reason?: string;
  attempts?: number;
  traceId?: string;
};

/**
 * 已归一化、可直接落卡的终态错误描述。`applyOutboundError` / `applyLegacyBridgeError` 先算出它,
 * 再决定「立即画红卡」还是「交给 socket 延后」;延后时 socket 原样保存,裁决为否 / 宽限超时后
 * 用同一份数据调 `paintDeferredTerminalError` 物化,保证两条路径画出的卡一字不差。
 */
export type DeferredTerminalErrorPaint = {
  normalized: string;
  text: string;
  detail?: string;
  /** 首次提交时的最终正文。已有快照后忽略。 */
  displayMessage?: string;
  clientMessageId?: string;
  traceId?: string;
  /** 错误帧带的人话错误;旧服务没有,渲染时按错误码查目录。 */
  userError?: UserError;
};

/** reducer 上交给 ChatSocket 的跨切面副作用。全部可选——纯模型测试可不传。*/
export type FrameEffects = {
  /** isFinal 到达（turn 收尾后）：socket 清 thinking-safety / 推进 drain / promote status。
   * `clientMessageId` 在 reducer 清 active turn 前捕获，异步 REST 对账必须按它精确合并。*/
  onFinal?: (
    sess: ChatSession,
    frame: OutboundMessageWire,
    isCronOrHeartbeat: boolean,
    clientMessageId?: string,
  ) => void;
  /** Terminal recoverable error: sync the finalized exact tape, then let the
   * socket attempt one safety-gated checkpoint/replay child turn. */
  scheduleAutomaticRecovery?: (sessId: string, clientMessageId?: string) => void;
  /**
   * Master 拥有自动恢复时,可恢复的终态错误**先不画红卡**:返回 true 表示 socket 已接管这条
   * 延后的错误(持 `sys.recovery_decision` / `outbound.ack{recovery}` / 宽限计时器三选一收口),
   * reducer 只把本轮保持在软状态「模型繁忙,正在重试中」。返回 false / 缺省 → 立即落红卡。
   */
  deferTerminalErrorForRecovery?: (sessId: string, paint: DeferredTerminalErrorPaint) => boolean;
  /** 后到的静默终态（重启/点停）丢掉尚未画上的延后卡，不准补画。 */
  discardDeferredTerminalError?: (sessId: string, clientMessageId?: string) => void;
  /** 点停围栏吞掉终态 outbound.error 时，同步收口对应的 `_stopSettlement` / controlQueue。 */
  settleCancelFencedStop?: (sess: ChatSession, clientMessageId?: string) => void;
  /** 非 final 且 in-flight：socket 重置 thinking-safety（证明后端活着）。*/
  onLiveFrame?: (sess: ChatSession) => void;
  /** 空轮 end_turn → deferred(setTimeout 0) 自动续写。*/
  scheduleAutoContinue?: (sessId: string, targetMsgId: string, cls: EmptyTurnDecision) => void;
  /** 商业版余额刷新（cost_charged / insufficient_credits）。*/
  refreshBalance?: () => void;
  /** 真 turn 失败自动上报（跳过预期业务态）。*/
  reportTurnError?: (p: { code: string; message: string; traceId?: string; sessionId?: string }) => void;
  /** resume_failed / reconcile：游标已推进后，读一次权威历史。*/
  forceSync?: (sessId: string, context?: { clientMessageId?: string }) => void;
  /** swarm_snapshot 遇到 missing_base 时，从活跃 view=units 补拉 SwarmBoard 基线（OCV5-867）。*/
  resyncSwarmUnits?: (sessId: string, clientMessageId?: string) => void;
  /** 跨 tab 收到未知活跃 clientMessageId 实时帧且本地缺对应 user 气泡时补拉一次历史（OCV5-868）。*/
  syncMissingTurnUser?: (sessId: string, clientMessageId: string) => void;
  /**
   * tape 提交后的合成 turn_completed 命中**正在流式**的本轮:返回 true 表示 socket 接管——宽限期内
   * 等 live 尾巴与真 final 自然收口,期满仍未收口再按 reconcile 收口。缺省/false → 立即收口(旧行为)。
   */
  deferTapeCommitFinal?: (sessId: string, frame: OutboundMessageWire) => boolean;
  /** 立即把会话快照落 IndexedDB（断点续传游标 durable）。 */
  persistSession?: (sessId: string) => void;
  /** 1008 前的 auth-control error：交给 close handler 续期，不渲染。*/
  onAuthControlError?: () => void;
  /** 用户看见问题卡 / 进入软状态 / 恢复收口时上报（历史水合路径不接）。*/
  reportProblemCard?: (sessId: string, p: ProblemCardReport) => void;
};

export type DelegateToolInfo = {
  agentId: string;
  goalRaw: string;
  goalKey: string;
  background?: boolean;
  model?: string;
};

export type DelegateProgressBlock = {
  kind: "delegate_progress";
  runId: string;
  agentId: string;
  phase: "start" | "text" | "thinking" | "plan" | "tool" | "usage" | "done" | "error";
  text?: string;
  toolName?: string;
  isError?: boolean;
  goal?: string;
  jobId?: string;
  block?: OutboundContentBlock;
  usageRunId?: string;
  usage?: NonNullable<ChatSession["_liveTurnUsage"]>["usage"];
};
