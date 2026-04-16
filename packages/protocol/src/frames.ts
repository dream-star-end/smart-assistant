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
})
export type InboundPermissionResponse = Static<typeof InboundPermissionResponse>

export const InboundFrame = Type.Union([InboundMessage, InboundControlStop, InboundPermissionResponse])
export type InboundFrame = Static<typeof InboundFrame>

// ───────────────────────────────────────────────
// Outbound (gateway → channel)
// ───────────────────────────────────────────────
export const OutboundContentBlock = Type.Union([
  Type.Object({ kind: Type.Literal('text'), text: Type.String() }),
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
  }),
  Type.Object({
    kind: Type.Literal('tool_result'),
    blockId: Type.Optional(Type.String()),
    /** The original tool_use blockId this result corresponds to */
    toolUseBlockId: Type.Optional(Type.String()),
    toolName: Type.String(),
    isError: Type.Boolean(),
    preview: Type.Optional(Type.String()),
  }),
  Type.Object({
    kind: Type.Literal('thinking'),
    text: Type.String(),
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
})
export type OutboundPermissionSettled = Static<typeof OutboundPermissionSettled>

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
  ControlFrame,
])
export type AnyFrame = Static<typeof AnyFrame>
