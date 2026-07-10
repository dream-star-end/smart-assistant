import { type Static, Type } from '@sinclair/typebox'
import { PLATFORM_REASONING_EFFORTS } from './engineModels.js'

// ───────────────────────────────────────────────
// V3 S12e — trace id schema fragment
// ───────────────────────────────────────────────
// 同源真值在 `./traceId.ts` 的 TRACE_ID_REGEX。这里复用同一 pattern 字符串
// 让 TypeBox `Value.Check` 在 frames schema 测试里能拒非法值;运行时实际
// 校验全部走 `parseTraceIdCandidate()`(schema check 不在热路径上)。
// pattern 字段是 TypeBox 透传给 JSON Schema 的 `pattern`,Value.Check 会真校验。
const TRACE_ID_PATTERN = '^[A-Za-z0-9_-]{16,64}$'
const TraceIdString = Type.String({ pattern: TRACE_ID_PATTERN })

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
// Attachment count limit — 前后端单一权威源
// ───────────────────────────────────────────────
// 单条消息(inbound frame)最多携带的附件(MediaRef)个数。**前端(web-react
// Composer)与后端(gateway dispatchInbound 帧准入)共用本常量**,消除历史上
// 前端 8 / 后端 5 的漂移(用户挂 6-8 个上传成功却被后端拒"附件数量超过 5 个")。
// 这是纯粹的"件数"护栏,与字节体积无关:单文件体积由 MAX_UPLOAD_SINGLE(100MB)、
// 总体积由 MAX_UPLOAD_TOTAL(300MB)独立守护,故 8 件仍在总量预算内、无内存/帧
// 大小硬约束需要压回 5。取 8 保用户体验(boss 铁律:优化不得降低体验)。
export const MAX_ATTACHMENTS_PER_MESSAGE = 8

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
  // Effort/reasoning-depth override for this session (一般来自 Web 前端的"编码模式/科研模式/GPT思考深度" pill)。
  //   - 字符串 ∈ EFFORT_LEVELS:CCB 写 CLAUDE_CODE_EFFORT_LEVEL; Codex 写 model_reasoning_effort(支持的取值)
  //   - null:**显式清除** — 让 gateway 把已有 runner 的 effort env 复位到模型默认
  //   - 字段缺省 (undefined):什么也不做 (其他 channel 默认行为)
  // 区分 null 与缺省是为了让 Web pill 的"取消选中"能反向取消之前的 xhigh/max,
  // 否则一旦升过档就回不去模型默认了。
  effortLevel: Type.Optional(
    Type.Union([
      Type.Null(),
      ...PLATFORM_REASONING_EFFORTS.map((effort) => Type.Literal(effort)),
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
  // 团队模式(v5 轻量组队):main 队长收到此 flag 的 turn 会被鼓励按任务复杂度自主
  // delegate_task 给已安装 agent 组队,简单任务自己答。turn 级、可中途切,只对 main 生效。
  teamMode: Type.Optional(Type.Boolean()),
  // Codex-native app-server conversation mode. `plan` asks Codex to produce a
  // reviewable read-only plan; `default` runs the implementation turn. Omitted
  // means runner default (commercial UI normally omits this; autonomous plan
  // updates are driven by Codex developer instructions).
  conversationMode: Type.Optional(Type.Union([Type.Literal('default'), Type.Literal('plan')])),
  // PR2 v1.0.66 — server-owned per-turn 标识。商用版 master 在 inbound 落到容器
  // **之前**强制写入(忽略 client 提供的值);承担 codex 真扣费的 inflight 关联键:
  //   master.userChatBridge: ensureRequestIdServerSide → preCheck → 写 inflightCodexTurns[requestId]
  //   container gateway: 透传到 sessionManager.submit → CodexAppServerRunner queue entry
  //   container gateway: turn 结束在 outbound.codex_billing 帧里回带这个 requestId
  //   master.onContainerMessage: 截获 outbound.codex_billing,按 requestId 找 inflight 行 settle
  // 容器侧不验证、不生成、也不回退 — 不带就跳过 codex 真扣费链路。其它 agent
  // 路径完全不读这个字段,纯添加项,跟现有协议 100% 向后兼容。
  requestId: Type.Optional(Type.String()),
  // V3 S12e — 客户端可选 observation。master 收到后 `parseTraceIdCandidate`,
  // 合法值进 logger context 作 client 自有 trace 关联键(不影响 canonical),
  // 非法值 strip 后只记 `clientTraceIdIssue` 枚举(防 log injection)。
  // 不参与 turn-level canonical:master 永远 `newTraceId()` 重新生成。
  clientTraceId: Type.Optional(TraceIdString),
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
    // V3 v7 — canonical assistant row id minted server-side at turn start
    // (`srv-${peerId}-${agentId}-t${turnIndex}` on v3 commercial container
    // sink path; legacy/personal path keeps `srv-${peerId}-t${turnIndex}`).
    // The agentId segment was added 2026-05-13 to fix a pre-existing
    // namespace collision: a chat that switches model mid-conversation
    // routes turn N+1 to a *different* AgentSession (e.g. codex → main),
    // whose `session.turns` independently starts at 0, so both agents
    // would stamp `t1` and the client would merge two answers into a
    // single message row. Stamped on main-agent text blocks
    // (parentToolUseId empty) so client + server tape agree on row id
    // from the first chunk on, eliminating the m-* / srv-* dual-authority
    // pain that v5/v6 tried to paper over. Subagent text omits this field
    // — subagent content lives inside Agent card childBlocks, not as a
    // top-level row.
    messageId: Type.Optional(Type.String()),
  }),
  Type.Object({
    kind: Type.Literal('tool_use'),
    blockId: Type.Optional(Type.String()),
    toolName: Type.String(),
    summary: Type.Optional(Type.String()),
    inputPreview: Type.Optional(Type.String()),
    /** Parsed tool input object (available when partial=false) */
    inputJson: Type.Optional(Type.Unknown()),
    /**
     * Per-frame DELTA from Anthropic SSE `input_json_delta.partial_json` — the
     * new chars appended to the cumulative tool input JSON string by this one
     * event. Each partial tool_use frame carries exactly the delta produced
     * by that SDK event (no cumulative buffer is emitted on the wire — the
     * gateway keeps its own internal accumulator only for slicing the
     * 400-char `inputPreview`; see ccbMessageParser).
     *
     * Web side accumulates: `existing.partialJson += partialJsonDelta` (gated
     * by `partialJsonOffset` match — see below) and feeds the resulting buffer
     * into `parsePartialJson` to render Edit/Write/MultiEdit/NotebookEdit body
     * in real time, character by character, during tool input streaming.
     *
     * Append-only stream event semantics — each frame is an event, NOT a
     * state snapshot. A frame received out of order or twice will corrupt
     * the accumulator unless `partialJsonOffset` is consulted.
     *
     * Strictly ephemeral — never persisted (server-side or client-side).
     */
    partialJsonDelta: Type.Optional(Type.String()),
    /**
     * Cumulative length (JavaScript `string.length`, i.e. UTF-16 code units)
     * of accumulated `partialJsonDelta`s BEFORE this delta was appended —
     * the position into which `partialJsonDelta` should be spliced on the
     * web side. Used as a completeness check:
     *
     *   if (block.partialJsonOffset === (existing.partialJson || '').length) {
     *     existing.partialJson = (existing.partialJson || '') + block.partialJsonDelta
     *   } else {
     *     // dup / out-of-order / late-join: drop the accumulator and fall
     *     // back to inputPreview / final inputJson rather than splice in a
     *     // delta at the wrong position.
     *     delete existing.partialJson
     *   }
     *
     * Mitigates outboundRing replay overlap with live stream, and any future
     * non-FIFO transport. Always present on partial tool_use frames that
     * carry a `partialJsonDelta`.
     */
    partialJsonOffset: Type.Optional(Type.Integer({ minimum: 0 })),
    // streaming: false | true — if true, a follow-up update with final input is coming
    partial: Type.Optional(Type.Boolean()),
    parentToolUseId: Type.Optional(Type.String()),
    // V3 v7.1 — canonical tool row id minted server-side at turn start:
    // `srv-${peerId}-${agentId}-t${turnIndex}-tool-${blockId}` on the v3
    // commercial sink path; legacy/personal path keeps
    // `srv-${peerId}-t${turnIndex}-tool-${blockId}`. AgentId segment
    // added 2026-05-13 (see kind:'text' messageId rationale for the
    // mid-chat model-switch collision this fixes). Stamped on main-agent
    // top-level tool_use blocks (parentToolUseId empty) so client + server
    // tape agree on row id from the first partial onwards. Matches the id
    // format master writes via packages/commercial/src/http/internalServerAuthored.ts.
    // Subagent tool_use omits this — subagent tools live inside an Agent
    // card's childBlocks, not as a top-level row.
    messageId: Type.Optional(Type.String()),
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
    // V3 v7 — canonical thinking row id minted server-side at turn start:
    // `srv-${peerId}-${agentId}-t${turnIndex}-thinking` on v3 commercial
    // sink path; legacy/personal path keeps
    // `srv-${peerId}-t${turnIndex}-thinking`. Same rationale as the text
    // variant's `messageId` field (agentId added 2026-05-13 to disambiguate
    // mid-chat model switches). Subagent thinking omits this — it goes
    // into Agent card childBlocks not a top-level thinking row.
    messageId: Type.Optional(Type.String()),
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
    updatedAt: Type.Optional(Type.Number()),
    cleared: Type.Optional(Type.Boolean()),
    parentToolUseId: Type.Optional(Type.String()),
  }),
  // Live progress from the synchronous delegate_task bridge. These blocks are
  // rendered as a dedicated delegate-progress card on WebChat and are never
  // treated as assistant final-answer content.
  Type.Object({
    kind: Type.Literal('delegate_progress'),
    runId: Type.String(),
    agentId: Type.String(),
    phase: Type.Union([
      Type.Literal('start'),
      Type.Literal('text'),
      Type.Literal('thinking'),
      Type.Literal('plan'),
      Type.Literal('tool'),
      Type.Literal('done'),
      Type.Literal('error'),
    ]),
    text: Type.Optional(Type.String()),
    toolName: Type.Optional(Type.String()),
    isError: Type.Optional(Type.Boolean()),
    // 委派目标的原始 goal(仅 start 帧携带)。前端用 (agentId, goal) 把这个
    // 委派 run 唯一关联回队长那次 delegate_task 工具卡(把进度嵌进同一张
    // agent-group 卡,而非另起独立卡)。匹配不到则回退独立卡,向后兼容。
    goal: Type.Optional(Type.String()),
    // 完整子 agent block payload(text/thinking/tool_use/tool_result/tool_output_tail),
    // 供新前端复用主聊天富渲染。gateway 已 sanitize,前端按子块 kind 渲染;旧前端忽略此字段。
    block: Type.Optional(Type.Unknown()),
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
  // V3 S12e — per-turn canonical 由 master 生成、container gateway
  // `dispatchInbound` 在 wire 发送前 stamp 到 frame。Optional 是给老路径
  // (cron / control / 非 turn deliver)留向后兼容口子,这些路径走 S11c。
  traceId: Type.Optional(TraceIdString),
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
  // V3 S12e — 由 dispatchInbound stamp,标记触发本次 permission 的 turn。
  // permission_settled 是 cross-turn lifecycle 帧,**不在** S12e 范围。
  traceId: Type.Optional(TraceIdString),
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
  // V3 S12e — 跟随 outbound.message 同 turn 的 trace。
  traceId: Type.Optional(TraceIdString),
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
  /** M2(v5 codex 复活)— engine-reported 计费的稳定记账键。
   *
   *  值 = gateway engine/engineSessionId.ts 的 `engineSessionId(sessionKey)`
   *  (`'oceng-' + sha256(sessionKey).hex.slice(0,48)`,共 54 字符,唯一权威
   *  helper,禁止各处自行 hash)。master settle 落 usage_records.session_id 与
   *  容器 idle-timeout turn-waive 上报(masterTurnWaive)**必须同一值**,否则
   *  退款窗口(refund.refundSessionWindow 按 session_id 圈定)永远圈不到 codex
   *  记录 —— 钱安全红线。
   *
   *  Optional 仅为渐进部署兼容(旧容器镜像不带此字段);master 侧对缺失/形状
   *  非法的帧 fail-closed:不 settle 扣费,abort journal 免单 + 告警(宁可少收
   *  不可乱扣,对齐 usage 缺失的 fail-safe 策略)。 */
  engineSessionId: Type.Optional(Type.String({ pattern: '^oceng-[0-9a-f]{48}$' })),
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
  /** Issue A v1.0.108 — codex `account/rateLimits/updated` 通知 piggy-back 到本帧
   *  让 master.userChatBridge 落库到 claude_accounts.quota_5h_pct/quota_5h_resets_at/
   *  quota_7d_pct/quota_7d_resets_at,与 Anthropic 路径(M9 quota.ts)字段对齐。
   *
   *  字段语义:
   *    util5h/util7d  — 0..100 number(usedPercent),与 Anthropic header parseUtil 输出对齐
   *    reset5h/reset7d — ISO8601 string(epoch sec → toISOString 在 runner 完成),
   *                     bridge 不再二次解析
   *
   *  缺省语义:整体 Optional → 当前 turn 没有新 rateLimits notification 不带本字段;
   *  内部所有子字段也 Optional,允许只更新 5h 或只更新 7d(单窗口 plan 的常态)。
   *  下游 quota.ts COALESCE 兜底未传字段沿用旧值。 */
  rateLimits: Type.Optional(
    Type.Object({
      util5h: Type.Optional(Type.Number()),
      reset5h: Type.Optional(Type.String()),
      util7d: Type.Optional(Type.Number()),
      reset7d: Type.Optional(Type.String()),
    }),
  ),
  // V3 S12e — billing 帧标记触发 codex turn 的 trace,允许 master settleCodexUsageAndLedger
  // 把扣费日志 join 到同 turn 链路上(inflight 行已携同 trace,本字段更多是 redundant
  // 防丢观察值)。
  traceId: Type.Optional(TraceIdString),
})
export type OutboundCodexBilling = Static<typeof OutboundCodexBilling>

// ───────────────────────────────────────────────
// OutboundTurnStatus — 当前 turn 的 backend-side 非流式阶段状态。
//
// 用于告诉前端 "本 turn 现在不会产生 assistant token 但仍在工作",避免 UX
// 把长时间静默当成卡死。第一版只覆盖 `compacting`(CCB auto/manual compact
// 期间走单独 LLM 调用,可达数十秒 ~ 数分钟无 stream)。
//
// 协议边界(严格):
//   - 只承载当前 turn 的非内容流阶段状态,不带 assistant 内容
//   - 受控枚举,gateway 必须映射 CCB raw status,**不**透传任意 SDK status
//   - `null` 表示回到普通流式 / 空闲态(compact_end / abort / error)
//   - 前端只能用它调整 UX,不能作为业务完成信号(业务完成走 outbound.message
//     isFinal=true)
//   - **入** outboundRing(走 deliver() 默认路径),让短暂断网时 ring replay
//     自然覆盖;长 compact + ring eviction 的边角由 gateway session-level
//     cache(currentTurnStatus)在 autoResumeFromHello 补发兜底
//
// 来源:CCB stdout `{type:'system', subtype:'status', status:'compacting'|null}`
// (cli/print.ts:2214 + services/compact/compact.ts:414,763,819,1106)
// ───────────────────────────────────────────────
export const OutboundTurnStatus = Type.Object({
  type: Type.Literal('outbound.turn_status'),
  sessionKey: Type.String(),
  channel: Type.String(),
  peer: Peer,
  /** 当前 turn 的非流式阶段。null = 回到普通流式 / 空闲态。
   *  受控枚举,未来扩展(如 'restoring' / 'waiting_for_hook')必须由
   *  gateway 显式映射,不接受 CCB raw 字符串透传。 */
  status: Type.Union([
    Type.Literal('compacting'),
    Type.Null(),
  ]),
  // V3 S12e — 与 outbound.message / outbound.codex_billing 同 trace 语义,
  // 标记触发本帧的 turn。dispatchInbound stamp,仅观察用。
  traceId: Type.Optional(TraceIdString),
})
export type OutboundTurnStatus = Static<typeof OutboundTurnStatus>

// ───────────────────────────────────────────────
// SysContextRebuilt — 上下文重建提示帧(长会话热尾巴+归档,boss 硬指标 3)。
//
// 触发时机:引擎**无法原生续接**(切引擎 / 非原生 resume),gateway 走"最近 N
// 条历史"兜底注入(sessionManager 注入点,现有 log 'injected historical context
// for provider switch / non-native resume' 处)。注入成功后 gateway 发本帧,前端
// 插一条 client-owned 的 system 提示行告知用户"更早细节助手可能记不全"。
//
// 协议边界:
//   - **gateway-authored 观察帧**:不是底座上报的 engine event(与 turn_status
//     不同,后者源自 CCB stdout);由 gateway 注入决策直接产生 → deliver()。
//   - 走 deliver() 默认广播通道(WS + outboundRing),短暂断网靠 ring replay 兜底;
//     前端按 frameSeq/ts 幂等去重(同一 turn 重复帧只插一条 system 行)。
//   - sideband:无 .blocks,deliver() 跳过 adapter(与 turn_status 同,只走 WS);
//     容器 → master 经 userChatBridge passthrough 透传给 user(不进 billing 拦截)。
//   - `ts` 由 deliver() 落地时统一 stamp(与 turn_status/codex_billing 同 wire
//     stamp 模式),schema 里声明为 Optional 让 gateway 构造时不必预填。
//   - `traceId` 随 _inheritOutboundRouting 从主 out 继承(可选,观察用)。
//
// 前科提醒:sys.* 帧历史上漏补 TypeScript 类型(sys.frontend_build),故这里
// 显式建 TypeBox schema + Static 类型 + 进 AnyFrame 联合,不留裸字面量。
// ───────────────────────────────────────────────
export const SysContextRebuilt = Type.Object({
  type: Type.Literal('sys.context_rebuilt'),
  sessionKey: Type.String(),
  channel: Type.String(),
  peer: Peer,
  /** 本轮实际执行任务的 agent id(注入发生在哪个 agent 的 session)。 */
  agentId: Type.String(),
  /** 注入进 prompt 的历史消息条数(前端文案 "最近 {N} 条对话摘要")。 */
  messageCount: Type.Number(),
  /** deliver() 落地时 stamp 的服务端单调时间戳;construct 时可缺省。 */
  ts: Type.Optional(Type.Number()),
  // V3 S12e — 随 _inheritOutboundRouting 从主 out 继承的 turn trace(观察用)。
  traceId: Type.Optional(TraceIdString),
})
export type SysContextRebuilt = Static<typeof SysContextRebuilt>

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
  OutboundTurnStatus,
  SysContextRebuilt,
  ControlFrame,
])
export type AnyFrame = Static<typeof AnyFrame>
