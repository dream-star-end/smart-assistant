/**
 * v5 WS wire 帧类型 —— 唯一权威是 packages/protocol/src/frames.ts。
 *
 * 这里**不另起一套帧枚举**：出/入站帧的结构定义全部 type-only 复用
 * `@openclaude/protocol/frames`（typebox 在 type-only import 下被构建期擦除，
 * 不进浏览器 bundle）。本文件只做两件 protocol 没覆盖、但运行期真实存在的事：
 *
 *  1. **runtime augmentation**：gateway 在 wire 上额外盖了几个 typebox schema 里
 *     没声明的字段——`frameSeq`（per-session 单调去重序号）、`ts`（server 时间戳，
 *     stale-final 守卫用）、`cronJob`（cron/task 推送标记）、以及 `meta.interrupted`
 *     （service_restart 合成 final 标记）。这些是消费侧不变量的硬依赖（见 §3/§7/§11），
 *     在类型层 augment 出来，避免散落的 `(frame as any)`。
 *  2. **聚合判别联合**：把消费侧 onmessage 分发表（websocket.js:2376-2419）需要识别的
 *     帧聚成一个 `InboundWire` / `OutboundWire` 判别联合，外加 v5 仍可能到达但 protocol
 *     未建模的轻量控制帧（pong / ack / cost_charged / cold_start / repo_status）。
 *
 * codex 帧（outbound.codex_billing / conversationMode:'plan'）v5 P1f 已删、不会到达，
 * 故这里不纳入消费联合；inbound 仍保留 protocol 的 model/effortLevel 顶层字段语义。
 */
import type {
  InboundControlStop,
  InboundMessage,
  InboundPermissionResponse,
  MediaRef,
  OutboundContentBlock,
  OutboundError,
  OutboundMessage,
  OutboundPermissionRequest,
  OutboundPermissionSettled,
  OutboundResumeFailed,
  OutboundTurnStatus,
  Peer,
} from "@openclaude/protocol/frames";

export type { MediaRef, OutboundContentBlock, Peer };

// ─── runtime-augmented 公共片段 ──────────────────────────────────────
/**
 * gateway 在每个 session-scoped outbound 帧上盖的运行期字段，protocol typebox
 * schema 未声明但 wire 必有/可能有：
 *  - frameSeq：per-sessionKey 单调序号，去重游标用（§3）。可能缺省（legacy/无序帧）。
 *  - ts：server 时间戳（ms），stale-final 跨时钟域守卫用（§11）。
 *  - sessionKey：protocol 多数帧已声明；这里冗余以兼容偶发缺省。
 */
export type WireRuntimeFields = {
  frameSeq?: number;
  ts?: number;
  sessionKey?: string;
};

/** cron/task 后台推送标记（无 peer 或落当前会话时带）。*/
export type CronPushMeta = {
  heartbeat?: boolean;
  label?: string;
};

/** outbound.message.meta + 运行期 interrupted 标记（service_restart 合成 final）。*/
export type OutboundMessageMeta = NonNullable<OutboundMessage["meta"]> & {
  /** 'service_restart' = 重连期 gateway 推的带外清理 final（§11）。*/
  interrupted?: string;
};

// ─── 出站帧（gateway → client，消费侧）───────────────────────────────
export type OutboundMessageWire = Omit<OutboundMessage, "meta"> &
  WireRuntimeFields & {
    meta?: OutboundMessageMeta;
    /** cron/task 推送（个人版语义，v5 商业版基本不触发，保留兜底分支）。*/
    cronJob?: CronPushMeta;
  };

export type OutboundErrorWire = OutboundError & WireRuntimeFields;
export type OutboundPermissionRequestWire = OutboundPermissionRequest & WireRuntimeFields;
export type OutboundPermissionSettledWire = OutboundPermissionSettled & WireRuntimeFields;
export type OutboundResumeFailedWire = OutboundResumeFailed & WireRuntimeFields;
export type OutboundTurnStatusWire = OutboundTurnStatus & WireRuntimeFields;

/** legacy bridge error 帧（`type:'error'`，protocol 未建模）。*/
export type LegacyBridgeErrorWire = {
  type: "error";
  peer?: Peer;
  code?: string;
  message?: string;
  traceId?: string;
} & WireRuntimeFields;

/** 商业版扣费广播（master→user）。**不进 frameSeq 去重**（§3）。*/
export type CostChargedWire = {
  type: "outbound.cost_charged";
  sessionId?: string;
  balanceAfter?: string | null;
  costCredits?: string | null;
};

/** 容器冷启提示（typing-indicator 加 “容器首次加载中” 后缀）。*/
export type ColdStartWire = { type: "sys.cold_start"; peer?: Peer };

/** bridge↔容器 relay 真建立的就绪信号（containerWs open，冷暖都发）。readiness 单一权威：
 *  前端据此立即排空离线队列（冷启时 ws.onopen 早于 relay 就绪，期间消息排队等此信号）。*/
export type RelayReadyWire = { type: "sys.relay_ready"; peer?: Peer };

/** server 已去重的 ack（drain 对账 + auto-continue 对账）。*/
export type AckWire = {
  type: "outbound.ack";
  deduplicated?: boolean;
  idempotencyKey?: string;
};

/** keepalive pong（按 id 匹配，先于一切 session handler 处理）。*/
export type PongWire = { type: "pong"; id?: number };

/** 消费侧能识别的全部出站帧判别联合。*/
export type OutboundWire =
  | OutboundMessageWire
  | OutboundErrorWire
  | OutboundPermissionRequestWire
  | OutboundPermissionSettledWire
  | OutboundResumeFailedWire
  | OutboundTurnStatusWire
  | LegacyBridgeErrorWire
  | CostChargedWire
  | ColdStartWire
  | RelayReadyWire
  | AckWire
  | PongWire;

// ─── 入站帧（client → gateway，发送侧）───────────────────────────────
export type { InboundControlStop, InboundMessage, InboundPermissionResponse };

/** client 起手 hello（autoResume：每 peer 带 lastFrameSeq）。protocol 未建模。*/
export type InboundHelloWire = {
  type: "inbound.hello";
  channel: "webchat";
  peers: Array<{
    peerId: string;
    agentId: string;
    inFlight: boolean;
    lastFrameSeq: number;
  }>;
};

/** keepalive ping。*/
export type InboundPingWire = { type: "ping"; id: number };

export type InboundWire =
  | InboundMessage
  | InboundControlStop
  | InboundPermissionResponse
  | InboundHelloWire
  | InboundPingWire;

// ─── narrowing 守卫（onmessage 分发用）────────────────────────────────
export function isOutboundFrame(f: unknown): f is OutboundWire {
  return !!f && typeof (f as { type?: unknown }).type === "string";
}
