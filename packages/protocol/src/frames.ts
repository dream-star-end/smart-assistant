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
  // CCB effort level override for this session (一般来自 Web 前端的"编码模式/科研模式" pill)。
  //   - 字符串 ∈ EFFORT_LEVELS:把 CLAUDE_CODE_EFFORT_LEVEL 设成该值
  //   - null:**显式清除** — 让 gateway 把已有 runner 的 effort env 复位到模型默认
  //   - 字段缺省 (undefined):什么也不做 (其他 channel 默认行为)
  // 区分 null 与缺省是为了让 Web pill 的"取消选中"能反向取消之前的 xhigh/max,
  // 否则一旦升过档就回不去模型默认了。
  effortLevel: Type.Optional(
    Type.Union([
      Type.Null(),
      Type.Literal('low'),
      Type.Literal('medium'),
      Type.Literal('high'),
      Type.Literal('xhigh'),
      Type.Literal('max'),
    ]),
  ),
  // CCB --model override for this session(2026-04-26 v1.0.4 起加;一般来自
  // Web 端 user_preferences.default_model)。
  //   - 字符串 (model id):把 CCB --model 设成该值;若与 runner.model 不同
  //     会触发 runner shutdown(下次 submit 自动 spawn 新模型)
  //   - 字段缺省 (undefined):不参与覆盖,沿用 agent.model / config.defaults.model
  // 不区分 null vs undefined —— 我们没有"清除回 agent 默认"的产品语义(用户
  // 在 pill 选了 sonnet 就一直 sonnet,直到主动选回 opus)。effortLevel 当年
  // 加 null 是为支持"取消选中"UI,这里没这个入口。
  // 实际接收方(gateway server.ts)会按静态 allowlist 过滤,无效 model 静默
  // 丢弃 —— 防止用户 prefs 里残留 admin 已 disable 的 model 把 CCB 启不起来。
  model: Type.Optional(Type.String()),
  // PR2 v1.0.66 — server-owned per-turn 标识。商用版 master 在 inbound 落到容器
  // **之前**强制写入(忽略 client 提供的值);承担 codex 真扣费的 inflight 关联键:
  //   master.userChatBridge: ensureRequestIdServerSide → preCheck → 写 inflightCodexTurns[requestId]
  //   container gateway: 透传到 sessionManager.submit → CodexAppServerRunner queue entry
  //   container gateway: turn 结束在 outbound.codex_billing 帧里回带这个 requestId
  //   master.onContainerMessage: 截获 outbound.codex_billing,按 requestId 找 inflight 行 settle
  // 容器侧不验证、不生成、也不回退 — 不带就跳过 codex 真扣费链路。其它 agent
  // 路径完全不读这个字段,纯添加项,跟现有协议 100% 向后兼容。
  requestId: Type.Optional(Type.String()),
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

export const InboundFrame = Type.Union([InboundMessage, InboundControlStop, InboundPermissionResponse])
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
    Type.Literal('buffer_miss'),          // Range exists but pruned (old / oversize).
    Type.Literal('no_buffer'),            // No ring buffer (server restarted).
    Type.Literal('sequence_mismatch'),    // Client seq ahead of server — bogus.
  ]),
})
export type OutboundResumeFailed = Static<typeof OutboundResumeFailed>

// ───────────────────────────────────────────────
// OutboundError — P1-3 流式错误专属帧。
//
// 双帧设计:此帧 isFinal=false(纯描述性 + 携带 code 给前端做 UX 分类),
// 紧随其后的 outbound.message {[error] ...} isFinal=true 才是 turn 终止器。
// 这样新客户端识别此帧渲染红色卡片 + CTA,同帧后的 [error] 文本被前端按
// frameSeq 抑制不重复渲染;旧客户端忽略此帧 type,只看到末尾 [error] 文本
// 文字气泡,降级 UX 但 turn 仍能正常关闭。
// ───────────────────────────────────────────────
export const OutboundError = Type.Object({
  type: Type.Literal('outbound.error'),
  sessionKey: Type.String(),
  channel: Type.String(),
  peer: Peer,
  /** 已识别错误分类。前端按 code 决定 UX(insufficient_credits → 给"去充值"CTA)。 */
  code: Type.Union([
    Type.Literal('insufficient_credits'),
    Type.Literal('rate_limited'),
    Type.Literal('upstream_failed'),
  ]),
  /** 简短人类文案,前端直接渲染。 */
  message: Type.String(),
  /** 折叠区显示的原始 error string,排查用。 */
  detail: Type.Optional(Type.String()),
  /** 故意 false:本帧不是 turn 终止器,后续紧跟一帧 outbound.message isFinal=true。 */
  isFinal: Type.Literal(false),
})
export type OutboundError = Static<typeof OutboundError>

// ───────────────────────────────────────────────
// OutboundCodexBilling — PR2 v1.0.66 codex 真扣费侧信道。
//
// 容器 gateway 在 codex turn 终态时发一帧给 master(只去 master 不去 user);
// master.userChatBridge.onContainerMessage 拦截后:
//   1. 按 requestId 查 inflightCodexTurns 取 model/agentId/codexAccountId/journalRowId
//   2. 走 settleCodexUsageAndLedger(单 PG 事务:usage_records INSERT ON CONFLICT
//      DO NOTHING + ledger debit + journal CAS UPDATE WHERE state='inflight')
//   3. 不再 forward 到 user(billing 帧用户不可见;与 outbound.cost_charged 不同
//      的是后者是 master→user 已落账广播,这是 container→master 的内部协调)
//
// **master 不信 frame 里的 model / agentId / codexAccountId**:都从 inflight
// snapshot 取(B.4 plan)。这帧仅承载使用量 + 终态分类 + requestId 关联键,
// 防伪造改不了真实账单。
//
// status 只能是 success | error(PR2 范围)。partial 路径推到 PR3 不在本帧出现。
// ───────────────────────────────────────────────
export const OutboundCodexBilling = Type.Object({
  type: Type.Literal('outbound.codex_billing'),
  /** 路由三件套(与 outbound.message / outbound.error 同):container 侧 deliver()
   *  按 (userId, channel, peer.id) 计算 peerKey 派发 WS,master.userChatBridge 是
   *  这个 peerKey 上的唯一 ws client(v3 多租户:master ↔ container 单条 WS)。
   *  master 收到后从 frame.requestId 拿 inflight key,**不依赖**这三字段做 settle。 */
  sessionKey: Type.String(),
  channel: Type.String(),
  peer: Peer,
  /** master 写入的 server-owned id;container 必须原样回带。缺这个字段的帧
   *  master 会丢弃(无法定位 inflight 行)。 */
  requestId: Type.String(),
  /** PR2 范围:codex turn 终态分类。partial 路径在 PR3 加。 */
  status: Type.Union([Type.Literal('success'), Type.Literal('error')]),
  /** turn 实际墙钟时长(ms),codex app-server 报告的 durationMs。 */
  durationMs: Type.Number(),
  /** Anthropic-shape usage(codex 已映射好);可缺省(空 turn / 模型未调用)→
   *  master 视为零扣费但仍走 settle 路径关掉 inflight。 */
  usage: Type.Optional(
    Type.Object({
      input_tokens: Type.Optional(Type.Number()),
      output_tokens: Type.Optional(Type.Number()),
      cache_read_input_tokens: Type.Optional(Type.Number()),
      cache_creation_input_tokens: Type.Optional(Type.Number()),
      reasoning_output_tokens: Type.Optional(Type.Number()),
    }),
  ),
  /** error 状态下的简短原因(故障定位 / journal 落库),不返回给 user。 */
  errorReason: Type.Optional(Type.String()),
})
export type OutboundCodexBilling = Static<typeof OutboundCodexBilling>

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
  OutboundMessage,
  OutboundPermissionRequest,
  OutboundPermissionSettled,
  OutboundResumeFailed,
  OutboundError,
  OutboundCodexBilling,
  ControlFrame,
])
export type AnyFrame = Static<typeof AnyFrame>
