/**
 * Server-authored turn outcome persistence
 *
 * Moved verbatim out of sessionManager.ts (FINDINGS §7.6, OCV5-480); sessionManager.ts re-exports
 * these names, so importers are unchanged.
 */
import { appendServerAuthoredMessageDurable, getClientSession } from '@openclaude/storage'
import type {
  DurableRuntimeEvent,
  EngineBillingEvent,
  SegmentRecord,
  TurnToolEntry,
} from './engine/engineEvents.js'
import { getV3MasterSinkOrNull, type V3MasterSinkPayload } from './v3MasterSink.js'
import type { TurnWaiveReason, DurableAgentGroup } from '@openclaude/protocol'
import { log } from './sessionManagerLog.js'
import { isCommercialManagedRuntime } from './sessionManager.js'
import type { TapePersistResult } from './sessionManager.js'

/** server-authored turn 持久化三态(见 TapePersistResult):把 V3MasterSink /
 *  legacy 本地写的结果收敛成 acked|queued|dropped 的单一权威分类。 */
export function persistServerAuthoredTurnOutcome(args: {
  sessionKey: string
  peerId: string
  /** AgentSession.agentId — the agent that produced this turn (e.g. 'main',
   *  'codex', 'minimax2.7'). Folded into the persisted messageId so a chat
   *  that switches model mid-conversation doesn't collide on
   *  `srv-${peerId}-t1` (each AgentSession tracks its own `session.turns`
   *  starting at 0, so without this disambiguator turn 1 of codex and turn
   *  1 of main both stamp t1 and the client merges them — root cause of
   *  the 2026-05-13 "switched to deepseek, only thinking visible" bug).
   *  Required: every live caller is inside SessionManager and holds a
   *  populated `session.agentId`. */
  agentId: string
  /** From AgentSession.userId. Undefined on legacy/cron-pre-warm paths.
   *  Ignored on the v3 sink path (master derives it from identity). */
  userId: string | undefined
  turnIndex: number
  /** Exact browser user row that originated this webchat turn. Optional for
   * cron/legacy/retry-queue compatibility; materialized server rows carry it
   * as `_clientMessageId` for exact client reconciliation. */
  clientMessageId?: string
  turnKey?: string
  waiveReason?: TurnWaiveReason
  continuationOfTurnKey?: string
  /** RFC-v5-durable-turn-dispatch §3 — durable inbox 准入身份。仅本 turn 的**主
   *  tape**携带(continuation tape 恒不带);随 tape payload 入 hash,master ACK
   *  据此驱动 inbox row → terminal。 */
  dispatch?: { dispatchId: string; attemptNo: number }
  createdAt?: number
  text: string
  /** Optional full reasoning/thinking text for the same turn. Persisted as a
   *  separate `_source: 'server'` message with `role: 'thinking'`,
   *  ts = assistantTs - 1. v3 sink path: passed through to master in the
   *  same POST body; master writes both rows in two storage calls.
   *  Legacy/personal path: thinking is best-effort (its write is wrapped
   *  in try/catch, failures don't block the assistant write). */
  thinkingText?: string
  status: 'completed' | 'interrupted' | 'crashed'
  /** Plan §4.4 改动 7 — server-owned requestId (commercial proxy emits via
   *  `x-openclaude-request-id`; sessionManager forwards verbatim). v3 sink
   *  path requires this for assistant writes (master schema refine).
   *  Legacy / personal path ignores it. */
  requestId?: string
  /** CCB agent session id(= runner.sessionId,与 anthropicProxy 从 LLM
   *  metadata.session_id 提取的一致)。v3 sink 透传给 master,使 ccb 助手落库时按
   *  session 精确排空 pending costCredits(per-turn 精确,消除 by-user 跨会话归并)。
   *  Legacy/personal path 忽略。 */
  agentSessionId?: string
  goalId?: string
  goalStateRevision?: number
  /** Plan §4.4 改动 7 — token usage gathered at message_stop. Wire-only on
   *  the v3 sink path; legacy persists usage via the
   *  `outputs/usage_log` table separately. */
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
    totalTokens?: number
    model?: string
    turn?: number
    /** Master-owned per-turn canonical traceId (see V3MasterSinkWirePayload).
     *  Folded into messages[i].usage.traceId for the web UI's copyable
     *  "请求ID" + refresh-stable log correlation. */
    traceId?: string
  }
  /** Plan §4.4 改动 7 — refresh-stable status pills. */
  truncated?: boolean
  truncatedReason?: 'max_tokens' | 'pause_turn'
  errorCode?: string
  errorDetail?: string
  /** Top-level tool calls completed during this turn, captured by
   *  CcbMessageParser. v3 sink path: master writes each as a server-authored
   *  'tool' message so the durable copy survives refresh. Legacy/personal
   *  path ignores this field — local SQLite preserves client-authored tool
   *  rows already (no overwrite happens locally). */
  tools?: TurnToolEntry[]
  /** Fix B (2026-05-25) — per-text-segment durable rows. When non-empty,
   *  v3 sink path forwards to master which writes one assistant row per
   *  segment (`srv-...-tN-s${idx}`). Legacy/personal path keeps single-row
   *  behavior (only the live stream gets segment ids; refresh-recovery on
   *  personal version stays single-row). Plan §3.5.1. */
  assistantSegments?: SegmentRecord[]
  /** Fix B (2026-05-25) — same per-segment treatment for thinking rows. */
  thinkingSegments?: SegmentRecord[]
  /** P2 债A — completed delegations (team cards) for this turn, drained from
   *  the leader session's `_pendingAgentGroups` buffer. v3 sink path forwards
   *  to master which writes each as a server-authored `role: 'agent-group'`
   *  row. Legacy/personal path ignores it (team cards are client-owned there;
   *  no container→master sink). */
  agentGroups?: DurableAgentGroup[]
  /** Exact plan/goal block update stream emitted by the main agent. */
  structuredBlocks?: Array<Record<string, unknown>>
  runtimeEvents?: DurableRuntimeEvent[]
  /** Final usage from an engine-reported billing adapter (Codex). It is
   * co-located with the immutable turn tape so a bridge disconnect or
   * bounded outbound-ring eviction cannot erase the only settle evidence. */
  engineBilling?: EngineBillingEvent
  /** OCV5-180 B1 — fatal drop reason (stageDurable throw / 410 session_deleted). */
  onDroppedReason?: (reason: string) => void
}): Promise<TapePersistResult> {
  const sink = getV3MasterSinkOrNull()
  if (sink) {
    const payload: V3MasterSinkPayload = {
      sessionId: args.peerId,
      agentId: args.agentId,
      turnIndex: args.turnIndex,
      ...(args.clientMessageId ? { clientMessageId: args.clientMessageId } : {}),
      ...(args.turnKey ? { turnKey: args.turnKey } : {}),
      ...(args.waiveReason ? { waiveReason: args.waiveReason } : {}),
      ...(args.continuationOfTurnKey ? { continuationOfTurnKey: args.continuationOfTurnKey } : {}),
      // durable dispatch identity 只挂主 tape：continuation tape(post-terminal
      // Bash tail)绝不携带,避免非主内容触发 inbox terminal / 污染 dispatch 归属。
      ...(args.dispatch && !args.continuationOfTurnKey
        ? { dispatchId: args.dispatch.dispatchId, attemptNo: args.dispatch.attemptNo }
        : {}),
      status: args.status,
      text: args.text,
      ...(args.thinkingText && args.thinkingText.length > 0
        ? { thinkingText: args.thinkingText }
        : {}),
      createdAt: args.createdAt ?? Date.now(),
      // Plan §4.4 改动 7 — propagate requestId/usage/truncated/errorCode/
      // errorDetail to master. Master schema treats requestId as required
      // when text is non-empty (assistant write), optional otherwise
      // (thinking-only). Caller is responsible for supplying requestId on
      // the assistant path; we don't synthesize one here.
      ...(args.requestId !== undefined ? { requestId: args.requestId } : {}),
      ...(args.agentSessionId !== undefined ? { agentSessionId: args.agentSessionId } : {}),
      ...(args.goalId !== undefined ? { goalId: args.goalId } : {}),
      ...(args.goalStateRevision !== undefined
        ? { goalStateRevision: args.goalStateRevision }
        : {}),
      ...(args.usage !== undefined ? { usage: args.usage } : {}),
      ...(args.truncated ? { truncated: true } : {}),
      ...(args.truncatedReason ? { truncatedReason: args.truncatedReason } : {}),
      ...(args.errorCode !== undefined ? { errorCode: args.errorCode } : {}),
      ...(args.errorDetail !== undefined ? { errorDetail: args.errorDetail } : {}),
      ...(args.tools && args.tools.length > 0 ? { tools: args.tools } : {}),
      // Fix B (2026-05-25) — per-segment rows. Forward when non-empty;
      // master detects presence and writes one row per segment. Plan §3.5.1.
      ...(args.assistantSegments && args.assistantSegments.length > 0
        ? { assistantSegments: args.assistantSegments }
        : {}),
      ...(args.thinkingSegments && args.thinkingSegments.length > 0
        ? { thinkingSegments: args.thinkingSegments }
        : {}),
      // P2 债A — team cards. Forward when non-empty; master writes one
      // server-authored `role: 'agent-group'` row per delegation.
      ...(args.agentGroups && args.agentGroups.length > 0 ? { agentGroups: args.agentGroups } : {}),
      ...(args.structuredBlocks && args.structuredBlocks.length > 0
        ? { structuredBlocks: args.structuredBlocks }
        : {}),
      ...(args.runtimeEvents && args.runtimeEvents.length > 0
        ? { runtimeEvents: args.runtimeEvents }
        : {}),
      ...(args.engineBilling !== undefined
        ? { engineBilling: structuredClone(args.engineBilling) }
        : {}),
    }
    return sink
      .persistOrQueue(payload)
      .then((outcome): TapePersistResult => {
        if (outcome.ok) return 'acked'
        if (outcome.queued) {
          // stageDurable 已 fsync,重试队列会送达 —— 可靠排队,等同成功(见
          // TapePersistResult 'queued')。Already info-logged inside the sink.
          return 'queued'
        }
        // dropped — fatal classification (410 会话已删 / 4xx schema/method).
        // Surface at warn so ops sees the contract violation but not as
        // an error spike (fatal here means we have a bug, not a runtime
        // glitch the system can recover from).
        log.warn('v3 sink dropped server-authored payload', {
          sessionKey: args.sessionKey,
          peerId: args.peerId,
          turnIndex: args.turnIndex,
          status: args.status,
          reason: outcome.droppedReason,
        })
        args.onDroppedReason?.(outcome.droppedReason)
        return 'dropped'
      })
      .catch((err): TapePersistResult => {
        // persistOrQueue 只在**重试队列 I/O 失败(stageDurable 抛,如 ENOSPC)**时 throw
        // —— 此时帧根本没落盘,是真正的丢弃,记 'dropped'(非 queued)。
        log.error(
          'v3 sink persistOrQueue threw',
          {
            sessionKey: args.sessionKey,
            peerId: args.peerId,
            turnIndex: args.turnIndex,
            status: args.status,
          },
          err,
        )
        args.onDroppedReason?.(err instanceof Error ? err.message : String(err))
        return 'dropped'
      })
  }
  if (isCommercialManagedRuntime()) {
    throw new Error('LOSSLESS_SINK_UNAVAILABLE: commercial turn tape sink is not initialized')
  }
  // Legacy / personal-version path — local SQLite is authoritative.
  //
  // agentId is folded into the messageId for the same reason as the v3 sink
  // path (see args.agentId doc): a personal-version chat that rotates across
  // agents mid-conversation would otherwise collide on `srv-${peerId}-t1`.
  // No backward-compat shim needed: historical rows in SQLite keep their
  // pre-Fix-A ids; new rows use the disambiguated format. Client/server
  // agree because the same formula stamps OutboundContentBlock.messageId
  // at the runOneTurnWithRetry mint site below.
  const messageId = `srv-${args.peerId}-${args.agentId}-t${args.turnIndex}`
  const thinkingMessageId = `srv-${args.peerId}-${args.agentId}-t${args.turnIndex}-thinking`
  const directWrite = async () => {
    // OCV5-94: only the owner is needed here; the timeline view is page-bounded
    // while the default exact view hydrates every turn tape of the session.
    const uid =
      args.userId ?? (await getClientSession(args.peerId, undefined, { view: 'timeline' }))?.userId
    if (!uid) return undefined // cron-style pre-UI, no owner — skip.
    const baseTs = Date.now()
    // Best-effort thinking write: doesn't block assistant. Failures are
    // logged at warn (not error) because thinking is auxiliary debug
    // content; losing it is degraded but acceptable. Assistant text is
    // first-class and gets the structured outer .then result handling.
    if (args.thinkingText && args.thinkingText.length > 0) {
      try {
        const r = await appendServerAuthoredMessageDurable(args.peerId, uid, {
          id: thinkingMessageId,
          role: 'thinking',
          text: args.thinkingText,
          ts: baseTs - 1,
          status: args.status,
        })
        if (r && !r.applied && r.reason !== 'already_exists') {
          log.warn('legacy thinking persist degraded', {
            sessionKey: args.sessionKey,
            peerId: args.peerId,
            turnIndex: args.turnIndex,
            reason: r.reason,
          })
        }
      } catch (err) {
        log.warn(
          'legacy thinking persist threw — continuing assistant',
          {
            sessionKey: args.sessionKey,
            peerId: args.peerId,
            turnIndex: args.turnIndex,
          },
          err,
        )
      }
    }
    if (args.text && args.text.length > 0) {
      return appendServerAuthoredMessageDurable(args.peerId, uid, {
        id: messageId,
        role: 'assistant',
        text: args.text,
        ts: baseTs,
        status: args.status,
        ...(args.truncatedReason || args.truncated
          ? { _truncated: args.truncatedReason ?? 'max_tokens' }
          : {}),
      })
    }
    // thinking-only legacy turn — already logged inside the try/catch above.
    // Return undefined so outer .then's `if (!r) return` short-circuits.
    return undefined
  }
  return directWrite()
    .then((r): TapePersistResult => {
      // undefined = 没写任何东西(无 userId / thinking-only 空 text / runtimeEvents-only):
      // 未持久化但非失败 → 'skipped'(布尔层仍折 true,与改前 undefined→true 逐值一致)。
      if (!r) return 'skipped'
      if (r.applied) return 'acked'
      if (r.reason === 'already_exists') return 'acked'
      if (r.reason === 'queued_to_outbox') {
        // 'queued_to_outbox' is an expected degraded-mode outcome
        // (DB unavailable); the outbox replay loop delivers it — 可靠排队,
        // 等同成功(见 TapePersistResult 'queued')。log as warn not error.
        log.warn('server-authored message queued to outbox (DB unavailable)', {
          sessionKey: args.sessionKey,
          peerId: args.peerId,
          turnIndex: args.turnIndex,
          status: args.status,
          error: r.error,
        })
        return 'queued'
      }
      log.warn('server-authored message not persisted', {
        sessionKey: args.sessionKey,
        peerId: args.peerId,
        turnIndex: args.turnIndex,
        status: args.status,
        reason: r.reason,
      })
      return 'dropped'
    })
    .catch((err): TapePersistResult => {
      log.error(
        'appendServerAuthoredMessage failed',
        {
          sessionKey: args.sessionKey,
          peerId: args.peerId,
          turnIndex: args.turnIndex,
          status: args.status,
        },
        err as Error,
      )
      return 'dropped'
    })
}
