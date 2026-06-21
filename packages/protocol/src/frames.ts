import { type Static, Type } from '@sinclair/typebox'

// ───────────────────────────────────────────────
// Common
// ───────────────────────────────────────────────
export const Peer = Type.Object({
  id: Type.String(),
  kind: Type.Union([Type.Literal('dm'), Type.Literal('group')]),
  displayName: Type.Optional(Type.String()),
})
export type Peer = Static<typeof Peer>

export const MediaRef = Type.Object({
  kind: Type.Union([
    Type.Literal('image'),
    Type.Literal('audio'),
    Type.Literal('video'),
    Type.Literal('file'),
  ]),
  url: Type.Optional(Type.String()),
  base64: Type.Optional(Type.String()),
  mimeType: Type.Optional(Type.String()),
  filename: Type.Optional(Type.String()),
})
export type MediaRef = Static<typeof MediaRef>

// ───────────────────────────────────────────────
// Inbound (channel → gateway)
// ───────────────────────────────────────────────
export const InboundMessage = Type.Object({
  type: Type.Literal('inbound.message'),
  idempotencyKey: Type.String(),
  channel: Type.String(),
  peer: Peer,
  // 显式覆盖路由结果。如果提供,gateway 用这个 agent 而不是 router 计算的。
  agentId: Type.Optional(Type.String()),
  content: Type.Object({
    text: Type.Optional(Type.String()),
    media: Type.Optional(Type.Array(MediaRef)),
  }),
  replyToId: Type.Optional(Type.String()),
  // Effort/reasoning-depth override for this session (一般来自 Web 前端的思考深度选择器,低/中/高/极高/最高/多agent工作流)。
  //   - 字符串 ∈ EFFORT_LEVELS:CCB 写 --effort; Codex 写 model_reasoning_effort(支持的取值)
  //     'ultracode' 是复合档:runner 翻译成 --effort xhigh + ultracode 会话设置(xhigh + Workflow 编排),仅 claude 链路。
  //   - null:**显式清除** — 让 gateway 把已有 runner 的 effort env 复位到模型默认
  //   - 字段缺省 (undefined):什么也不做 (其他 channel 默认行为)
  // 区分 null 与缺省是为了让 Web 选择器的"回默认"能反向取消之前的 xhigh/max/ultracode,
  // 否则一旦升过档就回不去模型默认了。
  effortLevel: Type.Optional(
    Type.Union([
      Type.Null(),
      Type.Literal('low'),
      Type.Literal('medium'),
      Type.Literal('high'),
      Type.Literal('xhigh'),
      Type.Literal('max'),
      Type.Literal('ultracode'),
    ]),
  ),
  // Per-session model override (来自 Web 前端的模型选择器)。提供时 gateway 把已有
  // runner 切到该 model(setModel + recycle,与 effortLevel 同机制);缺省则用 agent
  // 默认 model。仅覆盖当前会话,不改 agents.yaml。取值由 config.models 列举,gateway
  // 不本地校验(交由官方 claude 的 --model 处理)。
  model: Type.Optional(Type.String()),
  // Codex-native app-server conversation mode. plan asks Codex to first
  // produce a reviewable plan; default runs the implementation turn.
  conversationMode: Type.Optional(Type.Union([Type.Literal('default'), Type.Literal('plan')])),
  // Simple Codex Goal toggle. true means this normal message should seed the
  // thread goal before the turn starts; omitted keeps ordinary chat behavior.
  goalMode: Type.Optional(Type.Boolean()),
  ts: Type.Number(),
})
export type InboundMessage = Static<typeof InboundMessage>

export const InboundControlStop = Type.Object({
  type: Type.Literal('inbound.control.stop'),
  sessionKey: Type.Optional(Type.String()),
  channel: Type.String(),
  peer: Peer,
  agentId: Type.Optional(Type.String()),
})
export type InboundControlStop = Static<typeof InboundControlStop>

export const InboundPermissionResponse = Type.Object({
  type: Type.Literal('inbound.permission_response'),
  channel: Type.String(),
  peer: Peer,
  agentId: Type.Optional(Type.String()),
  requestId: Type.String(),
  behavior: Type.Union([Type.Literal('allow'), Type.Literal('deny')]),
  /** Optional deny reason from user */
  message: Type.Optional(Type.String()),
  /** Optional client-supplied tool input override. Currently used only by
   *  the AskUserQuestion tool to carry `{ answers, annotations }` merged
   *  on top of the original pending input. The gateway runs
   *  `sanitizeAskUserQuestionUpdatedInput` (whitelist) before forwarding to
   *  CCB — any unknown top-level keys, unknown question texts, non-string
   *  answers, forged `annotations.preview` values, etc. are dropped.
   *  If nothing survives sanitization the gateway downgrades allow → deny. */
  updatedInput: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
})
export type InboundPermissionResponse = Static<typeof InboundPermissionResponse>

export const InboundGoalControl = Type.Object({
  type: Type.Literal('inbound.control.goal'),
  action: Type.Union([Type.Literal('get'), Type.Literal('set'), Type.Literal('clear')]),
  channel: Type.String(),
  peer: Peer,
  agentId: Type.Optional(Type.String()),
  objective: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  status: Type.Optional(
    Type.Union([
      Type.Literal('active'),
      Type.Literal('paused'),
      Type.Literal('budgetLimited'),
      Type.Literal('complete'),
      Type.Null(),
    ]),
  ),
  tokenBudget: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
})
export type InboundGoalControl = Static<typeof InboundGoalControl>

export const InboundFrame = Type.Union([
  InboundMessage,
  InboundControlStop,
  InboundPermissionResponse,
  InboundGoalControl,
])
export type InboundFrame = Static<typeof InboundFrame>

// ───────────────────────────────────────────────
// Outbound (gateway → channel)
// ───────────────────────────────────────────────
// `parentToolUseId` is the CCB Agent-tool `tool_use.id` that spawned the
// subagent this block came from. null / undefined → main-agent content;
// non-null → content produced by a subagent and must be routed into the
// corresponding Agent card's child list (not the main message stream).
// CCB emits this on every SDK message (see parent_tool_use_id in the CCB
// core schemas). Supports nesting naturally — grand-child subagents carry
// their direct parent's tool_use_id.
export const OutboundContentBlock = Type.Union([
  Type.Object({
    kind: Type.Literal('text'),
    text: Type.String(),
    parentToolUseId: Type.Optional(Type.String()),
  }),
  Type.Object({
    kind: Type.Literal('tool_use'),
    blockId: Type.Optional(Type.String()),
    toolName: Type.String(),
    summary: Type.Optional(Type.String()),
    inputPreview: Type.Optional(Type.String()),
    /** Parsed tool input object (available when partial=false) */
    inputJson: Type.Optional(Type.Unknown()),
    // streaming: false | true — if true, a follow-up update with final input is coming
    partial: Type.Optional(Type.Boolean()),
    parentToolUseId: Type.Optional(Type.String()),
  }),
  Type.Object({
    kind: Type.Literal('tool_result'),
    blockId: Type.Optional(Type.String()),
    /** The original tool_use blockId this result corresponds to */
    toolUseBlockId: Type.Optional(Type.String()),
    toolName: Type.String(),
    isError: Type.Boolean(),
    preview: Type.Optional(Type.String()),
    parentToolUseId: Type.Optional(Type.String()),
  }),
  Type.Object({
    kind: Type.Literal('thinking'),
    text: Type.String(),
    parentToolUseId: Type.Optional(Type.String()),
  }),
  Type.Object({
    kind: Type.Literal('plan'),
    blockId: Type.Optional(Type.String()),
    text: Type.Optional(Type.String()),
    explanation: Type.Optional(Type.String()),
    steps: Type.Optional(
      Type.Array(
        Type.Object({
          step: Type.String(),
          status: Type.Union([
            Type.Literal('pending'),
            Type.Literal('inProgress'),
            Type.Literal('completed'),
          ]),
        }),
      ),
    ),
    partial: Type.Optional(Type.Boolean()),
    parentToolUseId: Type.Optional(Type.String()),
  }),
  Type.Object({
    kind: Type.Literal('goal'),
    blockId: Type.Optional(Type.String()),
    objective: Type.Optional(Type.String()),
    status: Type.Optional(Type.String()),
    tokenBudget: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    tokensUsed: Type.Optional(Type.Number()),
    timeUsedSeconds: Type.Optional(Type.Number()),
    createdAt: Type.Optional(Type.Number()),
    updatedAt: Type.Optional(Type.Number()),
    cleared: Type.Optional(Type.Boolean()),
    parentToolUseId: Type.Optional(Type.String()),
  }),
  // Snapshot of a long-running bash command's tail output. Snapshot
  // semantics: the consumer REPLACES its prior tail buffer with `tail`
  // rather than appending — the polling cadence is deliberately lossy
  // on the head when output exceeds the tail window (~4 KB). Truncated
  // head is signalled by `truncatedHead`. Frames are throttled by the
  // gateway so the wire never floods even when output is dense.
  // `toolUseBlockId` MUST match the parent BashTool tool_use blockId so
  // the web side can locate the right card via _blockIdToMsgId.
  Type.Object({
    kind: Type.Literal('tool_output_tail'),
    /** The parent BashTool tool_use blockId — used for routing. */
    toolUseBlockId: Type.String(),
    tail: Type.String(),
    /** File size at capture time, in bytes. */
    totalBytes: Type.Number(),
    /** True when output exceeded the tail window and the head is missing. */
    truncatedHead: Type.Boolean(),
    parentToolUseId: Type.Optional(Type.String()),
  }),
])
export type OutboundContentBlock = Static<typeof OutboundContentBlock>

export const OutboundMessage = Type.Object({
  type: Type.Literal('outbound.message'),
  sessionKey: Type.String(),
  channel: Type.String(),
  peer: Peer,
  blocks: Type.Array(OutboundContentBlock),
  isFinal: Type.Boolean(),
  meta: Type.Optional(
    Type.Object({
      cost: Type.Optional(Type.Number()),
      inputTokens: Type.Optional(Type.Number()),
      outputTokens: Type.Optional(Type.Number()),
      cacheReadTokens: Type.Optional(Type.Number()),
      cacheCreationTokens: Type.Optional(Type.Number()),
      totalCost: Type.Optional(Type.Number()),
      turn: Type.Optional(Type.Number()),
      // Anthropic stop_reason, extracted from CCB result row. Used by the
      // frontend to pick a precise empty-turn notice instead of the old
      // generic "模型本轮未输出新内容" fallback.
      stopReason: Type.Optional(Type.String()),
    }),
  ),
})
export type OutboundMessage = Static<typeof OutboundMessage>

// ───────────────────────────────────────────────
// Permission prompt (gateway → channel)
// ───────────────────────────────────────────────
export const OutboundPermissionRequest = Type.Object({
  type: Type.Literal('outbound.permission_request'),
  sessionKey: Type.String(),
  channel: Type.String(),
  peer: Peer,
  requestId: Type.String(),
  toolName: Type.String(),
  toolUseId: Type.Optional(Type.String()),
  inputPreview: Type.Optional(Type.String()),
  inputJson: Type.Optional(Type.Unknown()),
})
export type OutboundPermissionRequest = Static<typeof OutboundPermissionRequest>

// ───────────────────────────────────────────────
// Permission settlement broadcast (gateway → ALL tabs at peerKey)
// Emitted after any permission request is resolved — by user click, timeout,
// disconnect, or displacement. Tabs other than the one that sent the
// response rely on this to dismiss their modal; otherwise a second tab
// would show a stuck "pending" UI for a request already consumed server-side.
//
// `reason` lets the UI distinguish a local response echo from a remote
// settlement (e.g. "another tab clicked Allow") so it can render a subtler
// "resolved elsewhere" state instead of the local resolved state.
// ───────────────────────────────────────────────
export const OutboundPermissionSettled = Type.Object({
  type: Type.Literal('outbound.permission_settled'),
  sessionKey: Type.String(),
  channel: Type.String(),
  peer: Peer,
  requestId: Type.String(),
  behavior: Type.Union([Type.Literal('allow'), Type.Literal('deny')]),
  /** Explanation for the UI: 'remote' = settled by another tab,
   *  'already_settled' = duplicate response arrived after first consumer won,
   *  'disconnect' = auto-denied by server on peer disconnect,
   *  'timeout' = auto-denied after exceeding max wait time (janitor),
   *  'crashed' = auto-denied because the CCB subprocess died */
  reason: Type.Optional(
    Type.Union([
      Type.Literal('remote'),
      Type.Literal('already_settled'),
      Type.Literal('disconnect'),
      Type.Literal('timeout'),
      Type.Literal('crashed'),
    ]),
  ),
  /** Present only for AskUserQuestion allow settlements. Carries the
   *  sanitized `{ questionText: answer }` map so tabs that didn't submit
   *  the answer themselves (or arrive late via already_settled replay)
   *  can populate the resolved permission card without making the user
   *  re-enter anything. The gateway never forwards arbitrary client
   *  fields here — values are whitelisted by sanitizeAskUserQuestionUpdatedInput. */
  answers: Type.Optional(Type.Record(Type.String(), Type.String())),
})
export type OutboundPermissionSettled = Static<typeof OutboundPermissionSettled>

// ───────────────────────────────────────────────
// Resume-failed notification (gateway → client)
//
// Emitted when a reconnecting client's hello frame carries a `lastFrameSeq`
// that the server's outbound ring buffer can no longer satisfy (pruned by
// size / age limits, or server restarted since last_seq). The client treats
// this as "you missed frames you can no longer replay — force a full REST
// sync of the session." Phase 0.3 durability guard rail.
// ───────────────────────────────────────────────
export const OutboundResumeFailed = Type.Object({
  type: Type.Literal('outbound.resume_failed'),
  sessionKey: Type.String(),
  channel: Type.String(),
  peer: Peer,
  /** Client's last-seen frameSeq from hello. */
  from: Type.Number(),
  /** Server's current frameSeq at time of resume attempt. */
  to: Type.Number(),
  /** Why replay couldn't be served. */
  reason: Type.Union([
    Type.Literal('buffer_miss'), // Range exists but pruned (old / oversize).
    Type.Literal('no_buffer'), // No ring buffer (server restarted).
    Type.Literal('sequence_mismatch'), // Client seq ahead of server — bogus.
  ]),
})
export type OutboundResumeFailed = Static<typeof OutboundResumeFailed>

export const OutboundGoalStatus = Type.Object({
  type: Type.Literal('outbound.goal_status'),
  sessionKey: Type.String(),
  channel: Type.String(),
  peer: Peer,
  action: Type.Union([Type.Literal('get'), Type.Literal('set'), Type.Literal('clear')]),
  ok: Type.Boolean(),
  error: Type.Optional(Type.String()),
  goal: Type.Optional(
    Type.Object({
      objective: Type.Optional(Type.String()),
      status: Type.Optional(Type.String()),
      tokenBudget: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
      tokensUsed: Type.Optional(Type.Number()),
      timeUsedSeconds: Type.Optional(Type.Number()),
      createdAt: Type.Optional(Type.Number()),
      updatedAt: Type.Optional(Type.Number()),
      cleared: Type.Optional(Type.Boolean()),
    }),
  ),
})
export type OutboundGoalStatus = Static<typeof OutboundGoalStatus>

// ───────────────────────────────────────────────
// Control plane
// ───────────────────────────────────────────────
export const ControlListSessions = Type.Object({
  type: Type.Literal('control.session.list'),
})
export const ControlHealth = Type.Object({ type: Type.Literal('control.health') })
export const ControlCompact = Type.Object({
  type: Type.Literal('control.session.compact'),
  sessionKey: Type.String(),
})
export const ControlFrame = Type.Union([ControlListSessions, ControlHealth, ControlCompact])
export type ControlFrame = Static<typeof ControlFrame>

// ───────────────────────────────────────────────
// Top-level frame
// ───────────────────────────────────────────────
export const AnyFrame = Type.Union([
  InboundMessage,
  InboundPermissionResponse,
  InboundGoalControl,
  OutboundMessage,
  OutboundPermissionRequest,
  OutboundPermissionSettled,
  OutboundResumeFailed,
  OutboundGoalStatus,
  ControlFrame,
])
export type AnyFrame = Static<typeof AnyFrame>
