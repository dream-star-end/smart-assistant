/**
 * V3 commercial — internal endpoint for container → master server-authored
 * message persistence. Co-resident with anthropicProxy on the same listener
 * (plain 18791 self-host + mTLS 18443 remote-host); routed by URL path.
 *
 * Why this exists:
 *   In v3 commercial, the per-session container runs an OpenClaude gateway with
 *   its own SQLite. But session rows live ONLY in master's SQLite (frontend
 *   PUT /api/sessions/:id writes there). Container's `client_sessions` is
 *   permanently empty for v3, so its `appendServerAuthoredMessageDurable`
 *   always returns session_not_found and dead-letters into msg-outbox.jsonl —
 *   then `replayMsgOutbox` permanently drops session_not_found entries on
 *   startup. Result: every turn's authoritative assistant text was lost.
 *
 *   This handler gives the container a path to persist server-authored
 *   messages directly to master's SQLite (where the session row exists).
 *   See packages/gateway/src/v3MasterSink.ts for the sender side.
 *
 * Trust boundary:
 *   - Auth via verifyContainerIdentity — same machinery as anthropicProxy
 *     (oc-v3.<containerId>.<secret> bearer + (host_uuid, bound_ip) row lookup).
 *   - userId is ALWAYS derived as `c:${identity.userId}` here. Body-supplied
 *     userId is rejected at the schema level (not present in schema). This
 *     prevents a compromised container from poisoning another user's session.
 *   - msgId is derived from `(sessionId, agentId, turnIndex)`:
 *       agentId present →  `srv-${sessionId}-${agentId}-t${turnIndex}`
 *       agentId absent  →  `srv-${sessionId}-t${turnIndex}` (legacy fallback)
 *     We do not accept client-controlled message ids. AgentId was added
 *     2026-05-13: a chat that switches model mid-conversation (e.g. codex
 *     → main) routes turn N+1 to a different AgentSession whose
 *     `session.turns` independently restarts at 0; without agentId, both
 *     agents would stamp `srv-${sessionId}-t1` and the client merges two
 *     answers into one row. AgentId remains optional on the wire to keep
 *     pre-Fix-A container images draining cleanly during the rolling
 *     upgrade — those images send no agentId and master falls back to the
 *     legacy id format for them. Charset is constrained to
 *     `[A-Za-z0-9_-]{1,64}` so the derived id is URL/log safe.
 *   - sessionId+userId scope is enforced by the SQL `WHERE id=? AND user_id=?`
 *     inside `appendServerAuthoredMessage`. Cross-tenant access is impossible
 *     from this endpoint.
 *
 * Idempotency:
 *   `appendServerAuthoredMessage` returns `already_exists` when the same msgId
 *   has been persisted already. We translate that to HTTP 200 with
 *   `{ ok: true, idempotent: true }` so retries-after-late-success are
 *   benign at the container side.
 *
 * 404 vs 410 semantics (split on 2026-05-07):
 *   - HTTP 404 SESSION_NOT_FOUND: master has NO row for (sessionId, userId).
 *     Current v2 retains and retries without an age limit because the
 *     frontend's debounced PUT may still be in flight.
 *   - HTTP 410 SESSION_DELETED: master HAS a row but it is soft-deleted
 *     (`deleted_at IS NOT NULL`). This is terminal: the user/admin removed
 *     the session, retrying will never make it writeable again. This explicit
 *     owner-deletion acknowledgement is the only response that permits the
 *     container to remove a valid v2 entry, preventing retry storms
 *     (historical incident: ~190K log lines from one user across 7
 *     successive container replacements draining the same dead session).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  LOSSLESS_TURN_TAPE_PART_BYTES,
  LOSSLESS_TURN_TAPE_SHA256_RE,
  LOSSLESS_TURN_TAPE_VERSION,
  type DurableCodexBilling,
  type LosslessTurnTapeFinalizeRequest,
  type LosslessTurnTapePartRequest,
  type LosslessTurnTapeVisibleRequest,
  type TurnWaiveReason,
} from "@openclaude/protocol";
import type { DispatchAdmissionBackend, LosslessTurnTapeStorage } from "../db/pgSessionsBackend.js";
import type { TurnWaiverInput, TurnWaiverResult } from "../billing/refund.js";
import { recordProviderHealthSample } from "./proxy/providerHealthSink.js";

import { rootLogger, type Logger } from "../logging/logger.js";
import { enqueueAlert } from "../admin/alertOutbox.js";
import { EVENTS } from "../admin/alertEvents.js";
import { writeCondition } from "../selfheal/conditions.js";
import { sessionOversizedKey } from "../selfheal/conditionKeys.js";
import {
  HttpError,
  REQUEST_ID_HEADER,
  ensureRequestId,
  setSecurityHeaders,
} from "./util.js";
import {
  ContainerIdentityError,
  verifyContainerIdentity,
  type ContainerIdentityRepo,
} from "../auth/containerIdentity.js";
import {
  incrV3SinkPersist,
  type V3SinkPersistOutcome,
  type V3SinkPersistRole,
} from "../admin/metrics.js";

/** Legacy-v1 request cap. Current v2 admits one fixed-size multipart envelope
 * per request and has no per-turn semantic content cap. */
const MAX_BODY_BYTES = 256 * 1024;
const LOSSLESS_TURN_TAPE_WIRE_MAX_BODY_BYTES = Math.ceil((LOSSLESS_TURN_TAPE_PART_BYTES * 4) / 3) + 16 * 1024;

/** Path the container's V3MasterSink POSTs to. Mounted on both the plain
 *  self-host listener and the mTLS remote-host listener. */
export const SERVER_AUTHORED_PATH = "/internal/v3/server-authored-message";
/** 容器 boot recovery 查 tape 三态(RFC §2.4 / §3):GET ?dispatchId=&attemptNo=。 */
export const TURN_TAPE_STATE_PATH = "/internal/v3/turn-tape-state";

/** Per-tool field caps. Container-side `_capToolEntry` already enforces
 *  these by UTF-8 byte budget; the schema caps are slightly looser char
 *  budgets to accommodate the trailing `…[truncated]` sentinel that
 *  pushes the encoded length a few chars past the byte cap. */
const SCHEMA_TOOL_OUTPUT_MAX_CHARS = 8 * 1024;
const SCHEMA_TOOL_INPUT_JSON_MAX_CHARS = 16 * 1024;
const SCHEMA_TOOL_INPUT_PREVIEW_MAX_CHARS = 2_000;
/** Defensive upper bound on number of tool entries one turn can carry. A
 *  Sonnet 4.6 turn realistically tops out around 12-15 tools (parallel
 *  Read/Grep fan-outs + a few Edits); 50 leaves plenty of headroom. */
const SCHEMA_TOOLS_MAX_LEN = 50;

/** Legacy-v1 only — defensive upper bound on per-turn text segments.
 *  Assistant segments normally follow tool boundaries, but Codex can emit
 *  more independent thinking segments than tools. Oversized segment arrays
 *  are degraded to their aggregate fallback before schema validation when
 *  doing so cannot discard the turn's only content. */
const SCHEMA_SEGMENTS_MAX_LEN = 64;

/** P2 债A — per-turn agent-group (team card) caps. A leader turn can fan out
 *  to several delegates; 50 mirrors SCHEMA_TOOLS_MAX_LEN and is well past any
 *  realistic team fan-out (bounded by delegate resource/concurrency gates).
 *  resultSummary is already truncated to ≤2KB at the gateway generation point;
 *  the schema cap here matches that budget (a few chars of headroom for the
 *  UTF-8 truncation sentinel). goal is user/leader-authored intent text —
 *  cap at 4KB so an unusually verbose delegation goal doesn't 400 the turn. */
const SCHEMA_AGENT_GROUPS_MAX_LEN = 50;
const SCHEMA_AGENT_GROUP_RESULT_MAX_CHARS = 2 * 1024;
const SCHEMA_AGENT_GROUP_GOAL_MAX_CHARS = 4 * 1024;
const SCHEMA_AGENT_GROUP_RUNID_MAX_CHARS = 128;
const SCHEMA_AGENT_GROUP_AGENTID_MAX_CHARS = 128;
const SCHEMA_PERMISSION_CARDS_MAX_LEN = 4;
const SCHEMA_PERMISSION_PATCHES_MAX_LEN = 4;
const SCHEMA_USER_ANSWER_MESSAGES_MAX_LEN = 4;
const ASK_USER_REQUEST_ID_RE = /^ask-user:[0-9a-f]{32}$/;
const ASK_USER_ANSWER_ID_RE = /^ask-ans-[A-Za-z0-9_-]{8,64}$/;

/** One completed tool call within the turn. Mirrors the gateway-side
 *  `TurnToolEntry` shape. Master persists each as a server-authored row
 *  with `role: 'tool'`, sandwiched between thinking and assistant by ts. */
const ToolEntrySchema = z
  .object({
    toolUseId: z.string().min(1).max(128),
    blockId: z.string().min(1).max(128),
    toolName: z.string().min(1).max(128),
    /** Tool input — structured object preferred; string allowed when the
     *  client's `_capToolEntry` truncated to a JSON-encoded sentinel string. */
    inputJson: z.unknown(),
    inputPreview: z.string().max(SCHEMA_TOOL_INPUT_PREVIEW_MAX_CHARS),
    output: z.string().max(SCHEMA_TOOL_OUTPUT_MAX_CHARS),
    isError: z.boolean(),
    durationMs: z.number().int().min(0),
    ts: z.number().int().min(0),
    /** Fix B (2026-05-25) — tool CARD APPEARANCE time (parser-stamped at the
     *  first observation of `tool_use`, not tool_result completion). When
     *  present, master prefers this as the persisted ts so parallel tools
     *  that complete out-of-order keep their original arrival sort. Falls
     *  back DIRECTLY to the offset-from-baseTs default (`baseTs - N + i`);
     *  wire `t.ts` is intentionally NOT in the priority chain so pre-Fix-B
     *  gateways (which only send `ts` = tool_result arrival) keep the
     *  legacy offset-derived ts and don't suddenly shift to result-arrival
     *  ordering on master upgrade.
     *  Plan: docs/wip/fixb-per-segment-row-id-PLAN.md §3.5.4. */
    arrivedAt: z.number().int().min(0).optional(),
    inputTruncated: z.boolean().optional(),
    outputTruncated: z.boolean().optional(),
  })
  .strict()
  .refine(
    (v) => {
      // inputJson size cap (post-decode). We're more lenient here than at
      // the parser side — the client already bounded UTF-8 bytes; we just
      // refuse anything wildly larger that would inflate the messages JSON
      // blob disproportionately.
      try {
        const s = typeof v.inputJson === "string"
          ? v.inputJson
          : JSON.stringify(v.inputJson ?? {});
        return s.length <= SCHEMA_TOOL_INPUT_JSON_MAX_CHARS;
      } catch {
        return false;
      }
    },
    { message: "inputJson exceeds size cap or is unserializable", path: ["inputJson"] },
  );

/** P2 债A — one completed delegation (team card) within the leader turn.
 *  Mirrors the gateway-side `DurableAgentGroup` wire shape
 *  (@openclaude/protocol teamCards.ts). Master persists each as a
 *  server-authored row with `role: 'agent-group'`, mapping the wire fields to
 *  the client display field names (`_delegateRunId` / `_delegateAgentId` /
 *  `_delegateGoal` / `_resultPreview` / `_delegateStatus` / `_isError`).
 *  ts = completedAt (real wall-clock) so it interleaves inside the turn.
 *
 *  Charsets: `runId` is embedded into the persisted messageId
 *  (`srv-…-agentgroup-${runId}`) so it must stay URL/log safe and bounded,
 *  same rationale as the top-level agentId. `agentId` is display-only (not in
 *  the id) so its charset is looser to accommodate v5 marketplace agent ids. */
const AgentGroupEntrySchema = z
  .object({
    runId: z
      .string()
      .min(1)
      .max(SCHEMA_AGENT_GROUP_RUNID_MAX_CHARS)
      .regex(/^[A-Za-z0-9_-]+$/, {
        message: "runId must match [A-Za-z0-9_-]{1,128}",
      }),
    agentId: z.string().min(1).max(SCHEMA_AGENT_GROUP_AGENTID_MAX_CHARS),
    goal: z.string().max(SCHEMA_AGENT_GROUP_GOAL_MAX_CHARS),
    status: z.enum(["ok", "failed", "timeout"]),
    resultSummary: z.string().max(SCHEMA_AGENT_GROUP_RESULT_MAX_CHARS).optional(),
    completedAt: z.number().int().positive(),
    // P2 债C — 隐藏审查员委派专属结构化裁决(与 @openclaude/protocol
    // teamCards.ts REVIEW_VERDICTS 手抄对齐,同 status 手抄 z.enum 风格)。仅审查员
    // 委派行携带,落库映射为 `_reviewVerdict`;普通成员委派恒 undefined。
    verdict: z.enum(["PASS", "NEEDS_FIX"]).optional(),
  })
  .strict();

/** Detached Cursor ask_user card. Master persists each as a server-authored
 *  `role: 'permission'` row using the gateway-generated requestId as the
 *  message id (`ask-user:<32 hex>`), so hydrate / full-sync merge by id.
 *  userId is NEVER accepted from the wire — derived from container identity. */
const PermissionCardSchema = z
  .object({
    requestId: z
      .string()
      .min(1)
      .max(64)
      .regex(ASK_USER_REQUEST_ID_RE, {
        message: "requestId must match ask-user:<32 hex>",
      }),
    questions: z.array(z.unknown()).min(1).max(4),
    sessionKey: z.string().min(1).max(256),
    expiresAt: z.number().int().positive(),
    ts: z.number().int().positive().optional(),
    channel: z.string().min(1).max(64).optional(),
    peer: z
      .object({
        id: z.string().min(1).max(80),
        kind: z.enum(["dm", "group"]),
      })
      .strict()
      .optional(),
  })
  .strict();

const PermissionPatchSchema = z
  .object({
    requestId: z
      .string()
      .min(1)
      .max(64)
      .regex(ASK_USER_REQUEST_ID_RE, {
        message: "requestId must match ask-user:<32 hex>",
      }),
    behavior: z.enum(["allow", "deny"]),
    settledReason: z.enum(["remote", "already_settled", "disconnect", "timeout", "crashed"]),
    answers: z.record(z.string(), z.string().max(512)).optional(),
  })
  .strict();

const UserAnswerMessageSchema = z
  .object({
    id: z
      .string()
      .min(8)
      .max(80)
      .regex(ASK_USER_ANSWER_ID_RE, {
        message: "user answer id must match ask-ans-<token>",
      }),
    text: z.string().min(1).max(MAX_BODY_BYTES),
    ts: z.number().int().positive().optional(),
  })
  .strict();

/** Request body — strict, unknown keys rejected. peerId / userId / id / role
 *  are NOT accepted from the wire to keep the trust boundary tight.
 *
 *  `text` may be empty when the turn is thinking-only (Sonnet 4.6 ran out of
 *  output tokens before producing assistant text). The cross-field refine
 *  guarantees at least one of (text, thinkingText) is non-empty so we never
 *  write an empty assistant row. */
const BodySchema = z
  .object({
    sessionId: z.string().min(8).max(50),
    /** Disambiguator added 2026-05-13 to fix the mid-chat-model-switch
     *  collision (codex → main both stamping `srv-${sessionId}-t1`). When
     *  present, folded into the derived messageId as
     *  `srv-${sessionId}-${agentId}-t${turnIndex}`. Optional on the wire to
     *  keep pre-Fix-A container images sending no agentId drainable during
     *  rolling deploy — the handler falls back to the legacy id format
     *  (`srv-${sessionId}-t${turnIndex}`) when absent so those entries
     *  persist cleanly.
     *
     *  Charset `[A-Za-z0-9_-]{1,64}` so the embedded id stays URL/log safe
     *  and bounded; v3 commercial only runs agent ids `main` / `codex`
     *  today, well within this charset. Personal-version agent ids that
     *  use richer characters (e.g. `minimax2.7`) never hit this endpoint —
     *  they take the legacy local-SQLite path inside the gateway. */
    agentId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/, {
        message: "agentId must match [A-Za-z0-9_-]{1,64}",
      })
      .optional(),
    turnIndex: z.number().int().min(0),
    status: z.enum(["completed", "interrupted", "crashed"]),
    text: z.string().max(MAX_BODY_BYTES),
    /** Optional reasoning text for the same turn (capped client-side at
     *  MAX_THINKING_BUFFER_BYTES = 8 KB). Persisted as a separate
     *  `_source: 'server'` message with `role: 'thinking'`, ts = baseTs - 1
     *  so it sorts immediately before the assistant message. */
    thinkingText: z.string().min(1).max(MAX_BODY_BYTES).optional(),
    createdAt: z.number().int().positive().optional(),
    /** Plan §4.3 改动 6 — composite key with userId into
     *  `server_authored_request_map` so a deferred `appendCostCredits` call
     *  can find this row and patch `usage.costCredits` in-place.
     *
     *  Always optional on the wire. Two semantics by presence:
     *   - Provided (codex billing path / anthropicProxy path): handler routes
     *     the assistant write through `appendServerAuthoredMessageForRequest`
     *     to drain pending costCredits + record the request_map row.
     *   - Absent (ccb-spawn path: DeepSeek / non-codex Claude / etc.):
     *     gateway has already finalized token usage inline in `body.usage`;
     *     no late-cost-patch consumer exists, so the handler routes through
     *     plain `appendServerAuthoredMessage` (no map row, no pending drain).
     *
     *  This is asymmetric on purpose: only the codex/anthropic paths use
     *  `appendCostCredits`, so requiring requestId for non-codex assistant
     *  writes would just gate-fail valid payloads (historical bug 2026-05-08
     *  → 05-09: every DeepSeek V4 Pro turn was 400-rejected, fatal-dropped at
     *  the sink, and lost — refresh-recovery saw zero server-authored data). */
    requestId: z.string().min(8).max(128).optional(),
    /** CCB agent session id(= proxy 从 LLM metadata.session_id 提取、park 进
     *  pending.session_id 的同一 id)。ccb 助手落库时据此按 session 精确排空 pending
     *  costCredits;缺省 → 退回 by-user。extractSessionId 上限 256。 */
    agentSessionId: z.string().min(1).max(256).optional(),
    /** Plan §4.3 改动 6 — token usage from gateway-side stream-finalizer.
     *  Persisted into `messages[i].usage`. costCredits joins later via
     *  `appendCostCredits` patch (which mutates this same usage object). */
    usage: z
      .object({
        inputTokens: z.number().int().min(0).optional(),
        outputTokens: z.number().int().min(0).optional(),
        cacheReadTokens: z.number().int().min(0).optional(),
        cacheCreationTokens: z.number().int().min(0).optional(),
        totalTokens: z.number().int().min(0).optional(),
        model: z.string().max(128).optional(),
        turn: z.number().int().min(0).optional(),
        // Master-owned per-turn canonical traceId (gateway folds it in from
        // the inbound-stamped outbound frame). Persisted into
        // `messages[i].usage.traceId` and synced down server-authoritatively
        // so the web UI shows a copyable "请求ID" that survives refresh and
        // greps verbatim against master turn logs. Format mirrors
        // protocol/traceId.ts TRACE_ID_REGEX (alnum + - _, 1..64).
        traceId: z
          .string()
          .regex(/^[A-Za-z0-9_-]{1,64}$/)
          .optional(),
      })
      .strict()
      .optional(),
    /** Plan §4.3 改动 6 — turn was truncated (max_tokens etc.). Renders the
     *  red "已截断" pill on the assistant message after a refresh. */
    truncated: z.boolean().optional(),
    /** Plan §4.3 改动 6 — short error code for refresh-stable error pill
     *  (e.g. 'overloaded_error', 'service_unavailable'). Joins
     *  `_errorDetail` for the long form. */
    errorCode: z.string().max(64).optional(),
    errorDetail: z.string().max(2048).optional(),
    /** Top-level tool calls completed in this turn. Each persists as a
     *  separate `_source: 'server'` message with `role: 'tool'` between
     *  thinking and assistant of the same turn (ts < assistantTs). The
     *  durable copy is what survives refresh — replacing the ephemeral
     *  client-authored tool rows whose details are stripped on persist. */
    tools: z.array(ToolEntrySchema).max(SCHEMA_TOOLS_MAX_LEN).optional(),
    /** Fix B (2026-05-25) — per-text-segment payload. When present and
     *  non-empty, master writes ONE assistant row per segment (id
     *  `srv-${idPart}-t${turnIndex}-s${index}`) with the segment's own ts,
     *  so ts-sort interleaves correctly with the tool rows that punctuated
     *  them. The legacy `text` field is still required (schema-level) for
     *  rolling-deploy compat: old-master + new-container falls back to the
     *  single concatenated text row when this field arrives at a master
     *  predating Fix B. When BOTH are present and master is Fix-B-aware,
     *  master prefers `assistantSegments` and never persists `text` as a
     *  row. Plan §3.5.1. */
    assistantSegments: z
      .array(
        z
          .object({
            index: z.number().int().min(0).max(SCHEMA_SEGMENTS_MAX_LEN - 1),
            text: z.string().max(MAX_BODY_BYTES),
            ts: z.number().int().min(0),
          })
          .strict(),
      )
      .max(SCHEMA_SEGMENTS_MAX_LEN)
      .optional(),
    /** Fix B (2026-05-25) — same per-segment treatment for thinking. Row id
     *  `srv-${idPart}-t${turnIndex}-thinking-s${index}`. Parser-side cap
     *  MAX_THINKING_BUFFER_BYTES = 8 KB means each segment text is small. */
    thinkingSegments: z
      .array(
        z
          .object({
            index: z.number().int().min(0).max(SCHEMA_SEGMENTS_MAX_LEN - 1),
            text: z.string().max(MAX_BODY_BYTES),
            ts: z.number().int().min(0),
          })
          .strict(),
      )
      .max(SCHEMA_SEGMENTS_MAX_LEN)
      .optional(),
    /** P2 债A — completed delegations for this leader turn. Each persists as a
     *  server-authored `role: 'agent-group'` row (team card). Buffered on the
     *  parent session as delegates finish and drained with the turn-end
     *  persist. Included in the refine below as a content field: a
     *  delegation-only turn (leader crashed/interrupted after delegating,
     *  before producing text) must still persist its team cards rather than
     *  400-drop the whole POST. */
    agentGroups: z
      .array(AgentGroupEntrySchema)
      .max(SCHEMA_AGENT_GROUPS_MAX_LEN)
      .optional(),
    /** Detached ask_user cards. Optional; old containers never send this.
     *  A permission-only POST (empty text, no tools/thinking/groups) is how
     *  the container persists a 24h question card into master's hot tail. */
    permissionCards: z
      .array(PermissionCardSchema)
      .max(SCHEMA_PERMISSION_CARDS_MAX_LEN)
      .optional(),
    /** Resolved-state patches for previously persisted ask_user cards. */
    permissionPatches: z
      .array(PermissionPatchSchema)
      .max(SCHEMA_PERMISSION_PATCHES_MAX_LEN)
      .optional(),
    /** User-answer rows that accompany an allow settlement. */
    userAnswerMessages: z
      .array(UserAnswerMessageSchema)
      .max(SCHEMA_USER_ANSWER_MESSAGES_MAX_LEN)
      .optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.text.length > 0 ||
      v.thinkingText !== undefined ||
      (v.tools !== undefined && v.tools.length > 0) ||
      (v.assistantSegments !== undefined && v.assistantSegments.length > 0) ||
      (v.thinkingSegments !== undefined && v.thinkingSegments.length > 0) ||
      (v.agentGroups !== undefined && v.agentGroups.length > 0) ||
      (v.permissionCards !== undefined && v.permissionCards.length > 0) ||
      (v.permissionPatches !== undefined && v.permissionPatches.length > 0) ||
      (v.userAnswerMessages !== undefined && v.userAnswerMessages.length > 0),
    {
      message:
        "either text, thinkingText, tools[], assistantSegments[], thinkingSegments[], agentGroups[], permissionCards[], permissionPatches[], or userAnswerMessages[] must be non-empty",
    },
  );

export type ServerAuthoredBody = z.infer<typeof BodySchema>;

/** Server-authored message shape submitted to storage. Assistant writes may
 *  carry usage/_truncated/_errorCode/_errorDetail; thinking writes never do;
 *  tool writes carry the toolName/blockId/inputJson/output/error/durationMs
 *  cluster aligned with the frontend's `_buildToolCard` field reads. All
 *  fields except `id`, `role`, `text`, `ts` are optional and merged into
 *  the persisted message blob as-is. */
export type ServerAuthoredMessageInput = {
  id: string;
  /** 'thinking' for Phase 0.4 reasoning persistence; 'assistant' for the
   *  user-visible turn text; 'tool' for refresh-durable tool details
   *  (Phase 1 — replaces the ephemeral client-stripped tool rows). */
  role: "assistant" | "thinking" | "tool" | "agent-group" | "permission" | "user";
  text: string;
  ts: number;
  status: "completed" | "interrupted" | "crashed";
  /** Token usage from gateway-side stream finalizer. costCredits joins
   *  later via storage's `appendCostCredits` patch. Assistant role only. */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    totalTokens?: number;
    model?: string;
    turn?: number;
    /** Master-owned per-turn canonical traceId, folded into the persisted
     *  usage blob as-is and synced down to the web UI as a copyable "请求ID". */
    traceId?: string;
  };
  _truncated?: boolean;
  _errorCode?: string;
  _errorDetail?: string;
  // ── role: 'tool' fields ────────────────────────────────────────────
  // Field names align with the frontend's `_buildToolCard` reads
  // (msg.toolName / msg.blockId / msg.inputJson / msg.output / msg.error /
  // msg.durationMs / msg._completed). The wire schema uses `isError`
  // (Anthropic protocol convention); we translate to `error` here so the
  // stored blob renders identically to a client-authored tool message
  // after merge.
  toolName?: string;
  blockId?: string;
  inputJson?: unknown;
  inputPreview?: string;
  output?: string;
  error?: boolean;
  durationMs?: number;
  inputTruncated?: boolean;
  outputTruncated?: boolean;
  _completed?: boolean;
  // ── role: 'agent-group' fields (P2 债A team card) ───────────────────
  // Field names reuse the client display names authored in
  // @openclaude/protocol teamCards.ts TEAM_CARD_CLIENT_DISPLAY_FIELDS so the
  // server row renders through the frontend's existing AgentGroupCard/
  // TeamPanel readers with no client changes on the shared fields. `_delegate`
  // marks it a delegate_task card; `_delegateRunId` is the runId dedupe key;
  // `_delegateStatus` carries the ok/failed/timeout tristate (NEW field) while
  // `_isError` keeps the legacy boolean the current UI reads.
  _delegate?: boolean;
  _delegateRunId?: string;
  _delegateAgentId?: string;
  _delegateGoal?: string;
  _delegateStatus?: "ok" | "failed" | "timeout";
  _resultPreview?: string;
  _isError?: boolean;
  completedAt?: number;
  // P2 债C — 审查裁决展示字段(仅隐藏审查员委派行带);前端渲染 PASS/未通过。
  _reviewVerdict?: "PASS" | "NEEDS_FIX";
  // ── role: 'permission' fields (detached ask_user) ──────────────────
  requestId?: string;
  _resolved?: boolean;
  _detachedAskUser?: boolean;
  _askUserSessionKey?: string;
  _askUserExpiresAt?: number;
  _askUserUserId?: string;
  _askUserChannel?: string;
  _askUserPeer?: { id: string; kind: "dm" | "group" };
  _source?: "server";
};

export type ServerAuthoredStorageResult = {
  applied: boolean;
  reason?: "session_not_found" | "session_deleted" | "already_exists" | "malformed" | "oversized";
};

/** Storage interface — narrowed to just the calls we need so unit tests can
 *  inject a memory implementation. Real wiring uses both
 *  `appendServerAuthoredMessage` (thinking-only path, no requestId
 *  association) and `appendServerAuthoredMessageForRequest` (assistant path,
 *  drains pending costCredits + records request_map for late patches) from
 *  `@openclaude/storage`. */
export interface ServerAuthoredStorage {
  appendServerAuthoredMessage(
    sessId: string,
    userId: string,
    message: ServerAuthoredMessageInput,
  ): Promise<ServerAuthoredStorageResult>;
  appendServerAuthoredMessageForRequest(
    requestId: string,
    sessId: string,
    userId: string,
    message: ServerAuthoredMessageInput,
  ): Promise<
    | { applied: true }
    | { applied: false; reason: "session_not_found" | "session_deleted" | "already_exists" | "malformed" | "oversized" }
  >;
  /** ccb-spawn 助手路径(无 requestId):落库时按 user 排空 pending costCredits,使
   *  跨设备 reload 也能看到 per-response 积分(见 storage 同名函数的局限说明)。 */
  appendServerAuthoredMessageDrainByUser(
    sessId: string,
    userId: string,
    message: ServerAuthoredMessageInput,
    agentSessionId?: string | null,
  ): Promise<
    | { applied: true }
    | { applied: false; reason: "session_not_found" | "session_deleted" | "already_exists" | "malformed" | "oversized" }
  >;
  /** Fix A durable — 队长助手行落库后,把该 user 下 `parent_session_id = clientSessionId`
   *  的委派 pending 成本求和累加进该行(msgId)的 usage.costCredits。无委派成本 → 零副作用。
   *  与 requestId / by-agent-session drain 池 disjoint(委派行 session_id 池不相交),不重复计费。 */
  drainDelegateCostForClientSession(
    clientSessionId: string,
    userId: string,
    msgId: string,
  ): Promise<{ merged: string; drained: number }>;
  /** Optional: hydrate a previously persisted ask_user card (GET). */
  getClientSession?(
    sessId: string,
    userId: string,
  ): Promise<{ messages?: unknown[] } | null>;
  readArchivedMessages?(
    sessId: string,
    userId: string,
    beforeSeq?: number,
    limit?: number,
  ): Promise<{ messages: unknown[]; hasMore: boolean; oldestSeq: number | null }>;
  patchServerAuthoredMessage?(
    sessId: string,
    userId: string,
    msgId: string,
    patch: Record<string, unknown>,
  ): Promise<
    | { applied: true }
    | { applied: false; reason: "session_not_found" | "session_deleted" | "not_found" }
  >;
}

export interface ServerAuthoredHandlerDeps {
  identityRepo: ContainerIdentityRepo;
  storage: ServerAuthoredStorage;
  /** v5 PG-only lossless v2 tape store. v1 remains available for rolling old containers. */
  losslessTurnTapeStorage?: LosslessTurnTapeStorage;
  /** Durable billing fallback. Finalize is ACKed only after every billing
   * frame co-located with the immutable tape is settled or proven terminal. */
  settleCodexBilling?: (userId: bigint, billing: DurableCodexBilling) => Promise<void>;
  /** Exact refund + one targeted inbox receipt. A waived finalize is never
   * ACKed until this durable transaction succeeds. */
  applyTurnWaiver?: (input: TurnWaiverInput) => Promise<TurnWaiverResult>;
  /** Best-effort live projection after the durable receipt commits. */
  broadcastToUser?: (uid: bigint, payload: Record<string, unknown>) => void;
  /** Synchronous fire-and-forget signal hook; override only for tests. */
  recordProviderHealth?: (model: string, kind: "timeout") => void;
  logger?: Logger;
  /** Override only for tests; real callers use Date.now via default. */
  now?: () => number;
  /** Override only for tests so unit tests can assert metric outcome without
   *  touching the module-level Counter state. Real callers omit; default
   *  bridges to {@link incrV3SinkPersist}.
   *
   *  `role` is undefined for pre-role rejects (`reject_unauthorized` /
   *  `reject_bad_body` / `reject_method`) where the body hasn't been parsed
   *  yet, and either 'thinking' or 'assistant' for per-row outcomes. */
  metric?: (outcome: V3SinkPersistOutcome, role?: V3SinkPersistRole) => void;
  /** Stable, content-free product telemetry for the theoretically unreachable
   * post-spill hard limit. Optional so personal/test callers remain unchanged. */
  recordOversized?: (input: {
    userId: bigint;
    requestId: string;
    sessionId: string | null;
    role: V3SinkPersistRole | undefined;
  }) => void;
}

/** Same ctx shape as `AnthropicProxyHandler` — derived by listener wiring. */
export interface ServerAuthoredHandlerCtx {
  hostUuid: string;
  boundIp: string;
}

export type ServerAuthoredHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerAuthoredHandlerCtx,
) => Promise<void>;

export function makeServerAuthoredHandler(
  deps: ServerAuthoredHandlerDeps,
): ServerAuthoredHandler {
  const log = (deps.logger ?? rootLogger).child({
    subsys: "internalServerAuthored",
  });
  const now = deps.now ?? (() => Date.now());
  const baseMetric = deps.metric ?? incrV3SinkPersist;

  return async function handle(req, res, ctx) {
    setSecurityHeaders(res);
    const requestId = ensureRequestId(req);
    res.setHeader(REQUEST_ID_HEADER, requestId);

    // 单一权威拦截:所有 oversized 拒写(现在与未来任何站点)都经这一个 metric 口 →
    // 附带触发 system.session_oversized 告警 + selfheal condition(收尾批 B1)。
    // 热尾巴+归档上线后该结果理论不可达,命中即 bug(spill 未生效/单条超大消息),
    // 必须有人被通知而不是等翻日志。dedupe 按小时桶防风暴;enqueue/writeCondition
    // 失败只吞(告警不许拖垮持久化主路径)。sessionId 级细节在同点位的 error 日志里
    // (postSpillUnexpected 标记)。
    //
    // wrapper 是**请求级**闭包:身份/请求体解析成功后填 oversizedCtx,使 condition
    // 走 per-user key `system.session_oversized:<uid>`(latched,occurrence 累积;
    // snapshot.user_id 驱动定向收件人 materialize)。身份前的 reject 族不触发 oversized。
    const oversizedCtx: {
      uid?: string;
      sessionId?: string;
      bodyBytes?: number;
      lazyBytes?: () => number | null;
    } = {};
    const metric: typeof baseMetric = (outcome, kind) => {
      if (outcome === "reject_oversized") {
        const bucket = new Date(now()).toISOString().slice(0, 13);
        void enqueueAlert({
          event_type: EVENTS.SYSTEM_SESSION_OVERSIZED,
          severity: "critical",
          title: "会话行 oversized 拒写(spill 后理论不可达,命中即 bug)",
          body:
            `server-authored 持久化命中 MAX_SESSION_BYTES 硬闸(kind=${kind})。` +
            `热尾巴+归档上线后此路径不应触达 —— 排查 spill 是否失效或单条超大消息:` +
            "`grep -E 'postSpillUnexpected|_session_oversized' /var/log/openclaude-v5.log` 取 sessionId。",
          payload: { kind, bucket },
          dedupe_key: `${EVENTS.SYSTEM_SESSION_OVERSIZED}:${kind}:${bucket}`,
        }).catch(() => {});
        if (oversizedCtx.uid !== undefined) {
          if (oversizedCtx.bodyBytes === undefined && oversizedCtx.lazyBytes) {
            oversizedCtx.bodyBytes = oversizedCtx.lazyBytes() ?? undefined;
          }
          void writeCondition(sessionOversizedKey(oversizedCtx.uid), {
            mode: "latched",
            firing: true,
            level: "warning",
            snapshot: {
              kind: kind ?? null,
              bytes: oversizedCtx.bodyBytes ?? null,
              user_id: oversizedCtx.uid,
              session_id: oversizedCtx.sessionId ?? null,
            },
            occurrenceDelta: 1,
          }).catch(() => {});
          deps.recordOversized?.({
            userId: BigInt(oversizedCtx.uid),
            requestId,
            sessionId: oversizedCtx.sessionId ?? null,
            role: kind,
          });
        }
      }
      baseMetric(outcome, kind);
    };

    const reqLog = log.child({
      requestId,
      hostUuid: ctx.hostUuid,
      boundIp: ctx.boundIp,
      method: req.method ?? "GET",
    });

    // 0) Method whitelist — caller's path router has already matched the path.
    // POST writes a server-authored row; GET hydrates one previously persisted
    // detached ask_user card. Other methods are caller-routing bugs.
    if (req.method !== "POST" && req.method !== "GET") {
      sendJsonError(res, 405, "METHOD_NOT_ALLOWED", "POST or GET required", requestId);
      return;
    }

    // 1) Container identity (same double-factor as anthropicProxy)
    let identity;
    try {
      identity = await verifyContainerIdentity(
        deps.identityRepo,
        ctx,
        req.headers.authorization,
      );
    } catch (err) {
      if (err instanceof ContainerIdentityError) {
        reqLog.warn("identity_failed", { errcode: err.code });
        metric("reject_unauthorized");
        sendJsonError(
          res,
          401,
          "UNAUTHORIZED",
          "container identity verification failed",
          requestId,
        );
        return;
      }
      throw err;
    }
    const uid = identity.userId;
    const userId = `c:${uid}`;
    oversizedCtx.uid = String(uid);
    const userLog = reqLog.child({
      uid,
      containerId: identity.containerId,
    });

    if (req.method === "GET") {
      const url = new URL(req.url ?? "/", "http://internal");
      const sessionId = url.searchParams.get("sessionId") ?? "";
      const cardRequestId = url.searchParams.get("requestId") ?? "";
      if (sessionId.length < 8 || sessionId.length > 50) {
        sendJsonError(res, 400, "BAD_SESSION_ID", "sessionId must be 8-50 chars", requestId);
        return;
      }
      if (!ASK_USER_REQUEST_ID_RE.test(cardRequestId)) {
        sendJsonError(res, 400, "BAD_REQUEST_ID", "requestId must match ask-user:<32 hex>", requestId);
        return;
      }
      if (!deps.storage.getClientSession) {
        sendJsonError(res, 503, "LOOKUP_UNAVAILABLE", "session lookup is unavailable", requestId);
        return;
      }
      try {
        const sess = await deps.storage.getClientSession(sessionId, userId);
        if (!sess) {
          sendJsonError(res, 404, "SESSION_NOT_FOUND", "no client_sessions row for sessionId+userId", requestId);
          return;
        }
        let message = findPermissionCardInMessages(sess.messages, cardRequestId);
        if (!message && deps.storage.readArchivedMessages) {
          let beforeSeq = 0;
          for (let pageNo = 0; pageNo < 16 && !message; pageNo++) {
            const page = await deps.storage.readArchivedMessages(sessionId, userId, beforeSeq, 200);
            message = findPermissionCardInMessages(page.messages, cardRequestId);
            if (message) break;
            if (!page.hasMore || page.oldestSeq == null) break;
            beforeSeq = page.oldestSeq;
          }
        }
        if (!message) {
          sendJsonError(res, 404, "PERMISSION_NOT_FOUND", "ask_user card not found", requestId);
          return;
        }
        sendJsonOk(res, 200, { ok: true, message }, requestId);
      } catch (err) {
        userLog.error("ask_user_card_lookup_failed", { sessionId, requestId: cardRequestId, err: err as Error });
        sendJsonError(res, 500, "LOOKUP_ERROR", "ask_user card lookup failed", requestId);
      }
      return;
    }

    // 2) Read + schema-validate body
    let body: ServerAuthoredBody;
    try {
      const decoded = await readBoundedJson(req, LOSSLESS_TURN_TAPE_WIRE_MAX_BODY_BYTES);
      let raw = decoded.value;
      if (isLosslessTurnTapeWireBody(raw)) {
        await handleLosslessTurnTapeRequest({
          raw,
          userId,
          numericUserId: BigInt(uid),
          requestId,
          res,
          storage: deps.losslessTurnTapeStorage,
          settleCodexBilling: deps.settleCodexBilling,
          applyTurnWaiver: deps.applyTurnWaiver,
          broadcastToUser: deps.broadcastToUser,
          recordProviderHealth: deps.recordProviderHealth ?? recordProviderHealthSample,
          userLog,
          metric,
        });
        return;
      }
      if (decoded.bytes > MAX_BODY_BYTES) {
        throw new HttpError(
          413,
          "PAYLOAD_TOO_LARGE",
          `request body exceeds ${MAX_BODY_BYTES} bytes`,
        );
      }
      if (
        typeof raw === "object" &&
        raw !== null &&
        !Array.isArray(raw) &&
        Object.getPrototypeOf(raw) === Object.prototype
      ) {
        const normalized = { ...(raw as Record<string, unknown>) };
        const sessionId =
          typeof normalized.sessionId === "string" &&
          normalized.sessionId.length >= 8 &&
          normalized.sessionId.length <= 50
            ? normalized.sessionId
            : "<unparsed>";

        if (
          Array.isArray(normalized.assistantSegments) &&
          normalized.assistantSegments.length > SCHEMA_SEGMENTS_MAX_LEN &&
          typeof normalized.text === "string" &&
          normalized.text.length > 0
        ) {
          const count = normalized.assistantSegments.length;
          normalized.assistantSegments = undefined;
          userLog.warn("oversized_segments_degraded", {
            sessionId,
            field: "assistantSegments",
            count,
            cap: SCHEMA_SEGMENTS_MAX_LEN,
          });
        }

        if (
          Array.isArray(normalized.thinkingSegments) &&
          normalized.thinkingSegments.length > SCHEMA_SEGMENTS_MAX_LEN
        ) {
          const hasOtherPersistableContent =
            (typeof normalized.thinkingText === "string" &&
              normalized.thinkingText.length > 0) ||
            (typeof normalized.text === "string" && normalized.text.length > 0) ||
            (Array.isArray(normalized.assistantSegments) &&
              normalized.assistantSegments.length > 0) ||
            (Array.isArray(normalized.tools) && normalized.tools.length > 0) ||
            (Array.isArray(normalized.agentGroups) && normalized.agentGroups.length > 0);
          if (hasOtherPersistableContent) {
            const count = normalized.thinkingSegments.length;
            normalized.thinkingSegments = undefined;
            userLog.warn("oversized_segments_degraded", {
              sessionId,
              field: "thinkingSegments",
              count,
              cap: SCHEMA_SEGMENTS_MAX_LEN,
            });
          }
        }
        raw = normalized;
      }
      const parsed = BodySchema.safeParse(raw);
      if (!parsed.success) {
        userLog.warn("bad_body", { issues: parsed.error.issues });
        metric("reject_bad_body");
        sendJsonError(res, 400, "INVALID_BODY", "body schema rejected", requestId);
        return;
      }
      body = parsed.data;
    } catch (err) {
      if (err instanceof HttpError) {
        // 400/413 from readBoundedJson — bad body family.
        metric("reject_bad_body");
        sendJsonError(res, err.status, err.code, err.message, requestId);
        return;
      }
      throw err;
    }
    oversizedCtx.sessionId = body.sessionId;
    // bytes 惰性求值:只在真的命中 oversized(罕见路径)才序列化,不给热路径加成本。
    const capturedBody = body;
    oversizedCtx.bodyBytes = undefined;
    oversizedCtx.lazyBytes = () => {
      try {
        return Buffer.byteLength(JSON.stringify(capturedBody));
      } catch {
        return null;
      }
    };

    // 3) Persist
    //
    // Decision matrix (Phase 0.4 thinking durability + 2026-05-07
    // session_deleted split + Phase 1 tool durability):
    //
    //   Three optional sections per turn: thinking, tools[], assistant.
    //   Schema refine guarantees at least one is non-empty. Write order:
    //     thinking → tools[] → assistant
    //   so that ts ordering naturally sorts the same way (thinking ts <
    //   each tool ts < assistant ts), matching how the live stream shows
    //   them and what merge-preserving-server-authored expects.
    //
    //   Best-effort vs primary:
    //     - When hasAssistant: assistant write decides HTTP outcome;
    //       thinking + tools are best-effort (storage_threw logged +
    //       metric, never block assistant).
    //     - When !hasAssistant && hasThinking: thinking decides HTTP;
    //       tools are best-effort.
    //     - When !hasAssistant && !hasThinking (tools-only): first tool
    //       write decides HTTP; remaining tools are best-effort.
    //
    //   Outcomes (per primary section):
    //     - applied         → 200 ok
    //     - already_exists  → 200 idempotent
    //     - session_n_f     → 404 (sink retries under TTL — frontend's
    //                              debounced PUT may still be in flight)
    //     - session_deleted → 410 (sink fatal-drops; terminal)
    //     - storage_threw   → 500 (sink retries)
    //     - malformed       → 500 (master-side data issue)
    //
    // ts policy: assistantTs = body.createdAt ?? now(). Tools go at
    // `assistantTs - tools.length + i` (i = 0..N-1) so they sort
    // before assistant in arrival order. Thinking goes at
    // `assistantTs - tools.length - 1` so it sorts before all tools.
    // SQLite ts is integer ms; subtracting integer offsets keeps that
    // invariant (no decimal drift).
    const baseTs = body.createdAt ?? now();
    const tools = body.tools ?? [];
    const toolsCount = tools.length;
    const thinkingTs = baseTs - toolsCount - 1;
    const assistantTs = baseTs;
    // 2026-05-13 — agentId disambiguator: a chat that switches model
    // mid-conversation has TWO AgentSessions (e.g. codex + main), each
    // tracking `session.turns` independently from 0. Without agentId,
    // turn 1 of codex and turn 1 of main both serialize to
    // `srv-${sessionId}-t1` and the SQLite UPSERT path merges them into
    // one row. Fold agentId into the id when present. Absent agentId
    // means a pre-Fix-A container image is talking to us (rolling
    // deploy window) — fall back to the legacy id so those entries
    // still persist cleanly; once all containers are upgraded, every
    // request will carry agentId. Charset is enforced at the schema
    // level (BodySchema.agentId regex) so the id is safe to embed.
    const idPart = body.agentId
      ? `${body.sessionId}-${body.agentId}`
      : body.sessionId;
    const messageId = `srv-${idPart}-t${body.turnIndex}`;
    const thinkingMessageId = `srv-${idPart}-t${body.turnIndex}-thinking`;

    // Fix B (2026-05-25) — segment-aware presence flags. `hasAssistant` /
    // `hasThinking` collapse the legacy single-string path AND the new
    // segment-array path into one boolean for downstream branch decisions.
    // The cross-field refine guarantees at least one of them (or tools) is
    // non-empty. Plan §3.5.1.
    const hasAssistantSegments =
      body.assistantSegments !== undefined && body.assistantSegments.length > 0;
    const hasThinkingSegments =
      body.thinkingSegments !== undefined && body.thinkingSegments.length > 0;
    const hasAssistant = body.text.length > 0 || hasAssistantSegments;
    const hasThinking =
      (body.thinkingText !== undefined && body.thinkingText.length > 0) ||
      hasThinkingSegments;
    const hasTools = toolsCount > 0;

    // ── Write thinking first (if present) so its ts < tool ts < assistant ts ──
    //
    // Fix B (2026-05-25) — when thinkingSegments is present we write ONE row
    // per segment with the segment's own ts (parser-stamped wall-clock).
    // Each row id is `srv-${idPart}-t${turnIndex}-thinking-s${index}` so the
    // frontend's _findOrCreateStreamingRow's live-stream row (stamped by
    // gateway with the same -sN suffix) reuses it on refresh. Legacy
    // thinkingText path keeps the single-row form. Plan §3.5.1.
    type StorageResult = Awaited<
      ReturnType<ServerAuthoredStorage["appendServerAuthoredMessage"]>
    >;
    type PerRowOutcome = { id: string; result: StorageResult | null; threw: boolean };
    const thinkingOutcomes: PerRowOutcome[] = [];
    if (hasThinkingSegments) {
      for (const seg of body.thinkingSegments!) {
        const id = `srv-${idPart}-t${body.turnIndex}-thinking-s${seg.index}`;
        let result: StorageResult | null = null;
        let threw = false;
        try {
          result = await deps.storage.appendServerAuthoredMessage(
            body.sessionId,
            userId,
            {
              id,
              role: "thinking",
              text: seg.text,
              ts: seg.ts,
              status: body.status,
            },
          );
        } catch (err) {
          threw = true;
          userLog.error("thinking_storage_threw", {
            sessionId: body.sessionId,
            turnIndex: body.turnIndex,
            segmentIndex: seg.index,
            err: err as Error,
          });
        }
        thinkingOutcomes.push({ id, result, threw });
      }
    } else if (hasThinking) {
      let result: StorageResult | null = null;
      let threw = false;
      try {
        result = await deps.storage.appendServerAuthoredMessage(
          body.sessionId,
          userId,
          {
            id: thinkingMessageId,
            role: "thinking",
            text: body.thinkingText!,
            ts: thinkingTs,
            status: body.status,
          },
        );
      } catch (err) {
        threw = true;
        userLog.error("thinking_storage_threw", {
          sessionId: body.sessionId,
          turnIndex: body.turnIndex,
          err: err as Error,
        });
      }
      thinkingOutcomes.push({ id: thinkingMessageId, result, threw });
    }

    /** The LAST thinking outcome decides the no-assistant-path HTTP result.
     *  Earlier segments are best-effort; their failures are logged + metric'd
     *  but don't change HTTP outcome (the typical failure mode — session
     *  missing / deleted / oversized — affects every segment identically,
     *  so the last one's result is representative). */
    const lastThinkingOutcome: PerRowOutcome | null =
      thinkingOutcomes.length > 0
        ? thinkingOutcomes[thinkingOutcomes.length - 1]!
        : null;

    /** Emit the per-row thinking metric exactly once per request, covering
     *  every segment when segmented. */
    const emitThinkingMetric = (): void => {
      for (const o of thinkingOutcomes) {
        if (o.threw) {
          metric("error", "thinking");
          continue;
        }
        const r = o.result!;
        if (r.applied) metric("ok", "thinking");
        else if (r.reason === "already_exists") metric("deduped", "thinking");
        else if (r.reason === "session_not_found")
          metric("reject_session_missing", "thinking");
        else if (r.reason === "session_deleted")
          metric("reject_session_deleted", "thinking");
        else if (r.reason === "oversized")
          metric("reject_oversized", "thinking");
        else metric("error", "thinking"); // malformed
      }
    };

    // ── Write tools after thinking, before assistant ──
    //
    // Each tool gets a stable per-turn id `srv-${sessionId}-t${turnIndex}-tool-${blockId}`
    // (turnIndex included to avoid collision when the same blockId is
    // reused across turns, e.g. when a runner generates non-globally-unique
    // ids). When tools-only (!hasAssistant && !hasThinking), the first
    // tool's outcome is the primary; remaining are best-effort. Otherwise
    // ALL tool writes are best-effort.
    //
    // We always run all writes sequentially — parallel would need separate
    // SQLite transactions and risks `next_seq` contention; the per-write
    // latency is dominated by the messages JSON serialization, so a small
    // N-tool turn finishes in under ~5ms total.
    const toolResults: (StorageResult | null)[] = new Array(toolsCount).fill(null);
    const toolThrew: boolean[] = new Array(toolsCount).fill(false);
    const toolsOnlyDecidesHttp = !hasAssistant && !hasThinking && hasTools;
    for (let i = 0; i < toolsCount; i++) {
      const t = tools[i]!;
      // Same agentId fold-in as the assistant/thinking id above — see the
      // long comment near `idPart` for rationale.
      const toolMessageId = `srv-${idPart}-t${body.turnIndex}-tool-${t.blockId}`;
      // Fix B (2026-05-25) — ts priority chain: `arrivedAt` (parser-stamped
      // at first tool_use observation, NEW field) → computed offset (legacy
      // behavior preserved for pre-Fix-B gateways). The wire `t.ts` field
      // is intentionally NOT in the chain: historically master computed its
      // own ts and ignored `t.ts` (which is the tool_result completion
      // time, not arrival-ordered). Adding it would change behavior for
      // every pre-Fix-B gateway. Plan §3.5.4.
      const toolTs = t.arrivedAt ?? baseTs - toolsCount + i;
      try {
        toolResults[i] = await deps.storage.appendServerAuthoredMessage(
          body.sessionId,
          userId,
          {
            id: toolMessageId,
            role: "tool",
            // Storage stores `text` as a top-level field; mirror output here so
            // legacy renderers that fall back to msg.text still see content.
            // Frontend tool card prefers msg.output (set just below).
            text: t.output,
            ts: toolTs,
            status: body.status,
            toolName: t.toolName,
            blockId: t.blockId,
            inputJson: t.inputJson,
            inputPreview: t.inputPreview,
            output: t.output,
            // Wire field is `isError` (Anthropic convention); stored field is
            // `error` (matches frontend's `msg.error` reads in _buildToolCard).
            error: t.isError,
            durationMs: t.durationMs,
            ...(t.inputTruncated ? { inputTruncated: true } : {}),
            ...(t.outputTruncated ? { outputTruncated: true } : {}),
            _completed: true,
          },
        );
      } catch (err) {
        toolThrew[i] = true;
        userLog.error("tool_storage_threw", {
          sessionId: body.sessionId,
          turnIndex: body.turnIndex,
          toolBlockId: t.blockId,
          toolName: t.toolName,
          err: err as Error,
        });
        // First-tool throw on tools-only path — remaining writes still
        // attempted so we get them in best-effort, but HTTP outcome will
        // surface 500 below.
      }
    }

    /** Emit per-tool metrics once per request, mirroring emitThinkingMetric. */
    const emitToolsMetric = (): void => {
      for (let i = 0; i < toolsCount; i++) {
        if (toolThrew[i]) {
          metric("error", "tool");
          continue;
        }
        const r = toolResults[i];
        if (!r) {
          metric("error", "tool");
          continue;
        }
        if (r.applied) metric("ok", "tool");
        else if (r.reason === "already_exists") metric("deduped", "tool");
        else if (r.reason === "session_not_found")
          metric("reject_session_missing", "tool");
        else if (r.reason === "session_deleted")
          metric("reject_session_deleted", "tool");
        else if (r.reason === "oversized")
          metric("reject_oversized", "tool");
        else metric("error", "tool"); // malformed
      }
    };

    // ── Write agent-group (team card) rows — P2 债A ──
    //
    // Each completed delegation persists as a server-authored
    // `role: 'agent-group'` row with a stable per-(turn,run) id
    // `srv-${idPart}-t${turnIndex}-agentgroup-${runId}` (runId is
    // per-delegation unique → idempotent on sink retry). ts = completedAt
    // (the delegate's real completion wall-clock) so the card interleaves
    // inside the turn's thinking/tool/assistant rows by the same ts-sort.
    // Wire fields map to the client display names (see AgentGroupEntrySchema)
    // so the row renders through the frontend's existing AgentGroupCard /
    // TeamPanel readers. Storage's `mergePreservingServerAuthored` applies
    // agent-group **local-wins** (a same-runId client `m-*` row keeps its
    // childBlocks tree and this server row is dropped) — this row is what
    // fills the durability gap when the client row is absent (cross-device /
    // cleared cache / client PUT never landed). All writes are best-effort
    // EXCEPT the agentGroups-only path (Branch A) where the first row's
    // outcome decides HTTP, mirroring the tools-only treatment.
    const agentGroups = body.agentGroups ?? [];
    const agentGroupsCount = agentGroups.length;
    const hasAgentGroups = agentGroupsCount > 0;
    const agentGroupResults: (StorageResult | null)[] = new Array(agentGroupsCount).fill(null);
    const agentGroupThrew: boolean[] = new Array(agentGroupsCount).fill(false);
    for (let i = 0; i < agentGroupsCount; i++) {
      const ag = agentGroups[i]!;
      const agMessageId = `srv-${idPart}-t${body.turnIndex}-agentgroup-${ag.runId}`;
      try {
        agentGroupResults[i] = await deps.storage.appendServerAuthoredMessage(
          body.sessionId,
          userId,
          {
            id: agMessageId,
            role: "agent-group",
            // `text` carries the goal so legacy renderers reading msg.text (and
            // AgentGroupCard's `{msg.text || "子任务"}`) show the delegation goal.
            text: ag.goal,
            ts: ag.completedAt,
            status: body.status,
            _delegate: true,
            _delegateRunId: ag.runId,
            _delegateAgentId: ag.agentId,
            _delegateGoal: ag.goal,
            // Tristate (NEW display field) + legacy boolean the current UI reads.
            _delegateStatus: ag.status,
            _isError: ag.status !== "ok",
            _completed: true,
            completedAt: ag.completedAt,
            ...(ag.resultSummary !== undefined
              ? { _resultPreview: ag.resultSummary }
              : {}),
            // P2 债C — 审查裁决展示字段(仅审查员委派行带);前端据此渲染 PASS/未通过。
            ...(ag.verdict !== undefined ? { _reviewVerdict: ag.verdict } : {}),
          },
        );
      } catch (err) {
        agentGroupThrew[i] = true;
        userLog.error("agent_group_storage_threw", {
          sessionId: body.sessionId,
          turnIndex: body.turnIndex,
          runId: ag.runId,
          delegateAgentId: ag.agentId,
          err: err as Error,
        });
      }
    }

    // Emit per-agent-group metrics exactly once, inline (agent-group rows are
    // best-effort in every terminal path except agentGroups-only, where the
    // HTTP outcome is derived from the same results without re-emitting).
    for (let i = 0; i < agentGroupsCount; i++) {
      if (agentGroupThrew[i]) {
        metric("error", "agent-group");
        continue;
      }
      const r = agentGroupResults[i];
      if (!r) {
        metric("error", "agent-group");
        continue;
      }
      if (r.applied) metric("ok", "agent-group");
      else if (r.reason === "already_exists") metric("deduped", "agent-group");
      else if (r.reason === "session_not_found")
        metric("reject_session_missing", "agent-group");
      else if (r.reason === "session_deleted")
        metric("reject_session_deleted", "agent-group");
      else if (r.reason === "oversized")
        metric("reject_oversized", "agent-group");
      else metric("error", "agent-group"); // malformed
    }

    // ── Write detached ask_user permission cards ──
    //
    // Each card persists as a server-authored `role: 'permission'` row whose
    // id IS the gateway-generated requestId. That is the hydrate / full-sync
    // merge key. Unlike assistant/tool rows we do NOT derive srv-<session>-tN
    // ids here — those would collide with the in-flight turn tape.
    const permissionCards = body.permissionCards ?? [];
    const permissionCount = permissionCards.length;
    const hasPermissionCards = permissionCount > 0;
    const permissionResults: (StorageResult | null)[] = new Array(permissionCount).fill(null);
    const permissionThrew: boolean[] = new Array(permissionCount).fill(false);
    const nowMs = deps.now ?? Date.now;
    for (let i = 0; i < permissionCount; i++) {
      const card = permissionCards[i]!;
      const input = { questions: card.questions };
      try {
        permissionResults[i] = await deps.storage.appendServerAuthoredMessage(
          body.sessionId,
          userId,
          {
            id: card.requestId,
            role: "permission",
            text: "AskUserQuestion",
            ts: card.ts ?? body.createdAt ?? nowMs(),
            status: body.status,
            requestId: card.requestId,
            toolName: "AskUserQuestion",
            inputJson: input,
            inputPreview: JSON.stringify(input).slice(0, 400),
            _resolved: false,
            _detachedAskUser: true,
            _askUserSessionKey: card.sessionKey,
            _askUserExpiresAt: card.expiresAt,
            _askUserUserId: userId,
            _askUserChannel: card.channel ?? "webchat",
            ...(card.peer ? { _askUserPeer: card.peer } : {}),
            _source: "server",
          },
        );
      } catch (err) {
        permissionThrew[i] = true;
        userLog.error("permission_card_storage_threw", {
          sessionId: body.sessionId,
          requestId: card.requestId,
          err: err as Error,
        });
      }
    }
    for (let i = 0; i < permissionCount; i++) {
      if (permissionThrew[i]) {
        metric("error", "permission");
        continue;
      }
      const r = permissionResults[i];
      if (!r) {
        metric("error", "permission");
        continue;
      }
      if (r.applied) metric("ok", "permission");
      else if (r.reason === "already_exists") metric("deduped", "permission");
      else if (r.reason === "session_not_found")
        metric("reject_session_missing", "permission");
      else if (r.reason === "session_deleted")
        metric("reject_session_deleted", "permission");
      else if (r.reason === "oversized")
        metric("reject_oversized", "permission");
      else metric("error", "permission");
    }

    // ── Patch previously persisted ask_user cards as resolved ──
    const permissionPatches = body.permissionPatches ?? [];
    const patchCount = permissionPatches.length;
    const hasPermissionPatches = patchCount > 0;
    const patchResults: (StorageResult | null)[] = new Array(patchCount).fill(null);
    const patchThrew: boolean[] = new Array(patchCount).fill(false);
    for (let i = 0; i < patchCount; i++) {
      const patch = permissionPatches[i]!;
      try {
        if (!deps.storage.patchServerAuthoredMessage) {
          throw new Error("patchServerAuthoredMessage is unavailable");
        }
        const r = await deps.storage.patchServerAuthoredMessage(
          body.sessionId,
          userId,
          patch.requestId,
          {
            _resolved: true,
            _behavior: patch.behavior,
            _settledReason: patch.settledReason,
            ...(patch.answers ? { _answers: patch.answers } : {}),
          },
        );
        patchResults[i] = r.applied
          ? { applied: true }
          : {
              applied: false,
              reason: r.reason === "not_found" ? "session_not_found" : r.reason,
            };
      } catch (err) {
        patchThrew[i] = true;
        userLog.error("permission_patch_storage_threw", {
          sessionId: body.sessionId,
          requestId: patch.requestId,
          err: err as Error,
        });
      }
    }
    for (let i = 0; i < patchCount; i++) {
      if (patchThrew[i]) {
        metric("error", "permission");
        continue;
      }
      const r = patchResults[i];
      if (!r) {
        metric("error", "permission");
        continue;
      }
      if (r.applied) metric("ok", "permission");
      else if (r.reason === "session_not_found")
        metric("reject_session_missing", "permission");
      else if (r.reason === "session_deleted")
        metric("reject_session_deleted", "permission");
      else metric("error", "permission");
    }

    // ── Persist the user-answer row that accompanies an allow settlement ──
    const userAnswerMessages = body.userAnswerMessages ?? [];
    const userAnswerCount = userAnswerMessages.length;
    const hasUserAnswerMessages = userAnswerCount > 0;
    const userAnswerResults: (StorageResult | null)[] = new Array(userAnswerCount).fill(null);
    const userAnswerThrew: boolean[] = new Array(userAnswerCount).fill(false);
    for (let i = 0; i < userAnswerCount; i++) {
      const answer = userAnswerMessages[i]!;
      try {
        userAnswerResults[i] = await deps.storage.appendServerAuthoredMessage(
          body.sessionId,
          userId,
          {
            id: answer.id,
            role: "user",
            text: answer.text,
            ts: answer.ts ?? body.createdAt ?? nowMs(),
            status: body.status,
            _source: "server",
          },
        );
      } catch (err) {
        userAnswerThrew[i] = true;
        userLog.error("user_answer_storage_threw", {
          sessionId: body.sessionId,
          id: answer.id,
          err: err as Error,
        });
      }
    }
    for (let i = 0; i < userAnswerCount; i++) {
      if (userAnswerThrew[i]) {
        metric("error", "permission");
        continue;
      }
      const r = userAnswerResults[i];
      if (!r) {
        metric("error", "permission");
        continue;
      }
      if (r.applied) metric("ok", "permission");
      else if (r.reason === "already_exists") metric("deduped", "permission");
      else if (r.reason === "session_not_found")
        metric("reject_session_missing", "permission");
      else if (r.reason === "session_deleted")
        metric("reject_session_deleted", "permission");
      else if (r.reason === "oversized")
        metric("reject_oversized", "permission");
      else metric("error", "permission");
    }

    // ── Branch A: no-assistant path — thinking-only, tools-only,
    //    agentGroups-only, permission-only, or a mix ──
    //
    // HTTP outcome priority (highest-priority present content decides):
    //   hasThinking      → thinking decides HTTP; tools/agentGroups/permission best-effort.
    //   tools-only       → first tool decides HTTP; agentGroups/permission best-effort.
    //   agentGroups-only → first agent-group decides HTTP; permission best-effort.
    //   permission-only  → first permission card decides HTTP.
    if (!hasAssistant) {
      // Schema refine guarantees hasThinking || hasTools || hasAgentGroups || hasPermissionCards here.
      if (hasThinking) {
        // Fix B — emit per-segment metrics for non-last thinking writes
        // first (they're best-effort under the segment path); the last
        // outcome decides HTTP and is metric'd inline below.
        for (let i = 0; i < thinkingOutcomes.length - 1; i++) {
          const o = thinkingOutcomes[i]!;
          if (o.threw) metric("error", "thinking");
          else {
            const r = o.result!;
            if (r.applied) metric("ok", "thinking");
            else if (r.reason === "already_exists") metric("deduped", "thinking");
            else if (r.reason === "session_not_found")
              metric("reject_session_missing", "thinking");
            else if (r.reason === "session_deleted")
              metric("reject_session_deleted", "thinking");
            else if (r.reason === "oversized")
              metric("reject_oversized", "thinking");
            else metric("error", "thinking");
          }
        }
        const last = lastThinkingOutcome!;
        if (last.threw) {
          metric("error", "thinking");
          emitToolsMetric();
          sendJsonError(
            res,
            500,
            "STORAGE_ERROR",
            "storage write failed",
            requestId,
          );
          return;
        }
        const r = last.result!;
        if (r.applied) {
          metric("ok", "thinking");
          emitToolsMetric();
          sendJsonOk(res, 200, { ok: true }, requestId);
          return;
        }
        if (r.reason === "already_exists") {
          metric("deduped", "thinking");
          emitToolsMetric();
          sendJsonOk(res, 200, { ok: true, idempotent: true }, requestId);
          return;
        }
        if (r.reason === "session_not_found") {
          userLog.info("thinking_session_not_found", {
            sessionId: body.sessionId,
            turnIndex: body.turnIndex,
          });
          metric("reject_session_missing", "thinking");
          emitToolsMetric();
          sendJsonError(
            res,
            404,
            "SESSION_NOT_FOUND",
            "no client_sessions row for sessionId+userId",
            requestId,
          );
          return;
        }
        if (r.reason === "session_deleted") {
          userLog.info("thinking_session_deleted", {
            sessionId: body.sessionId,
            turnIndex: body.turnIndex,
          });
          metric("reject_session_deleted", "thinking");
          emitToolsMetric();
          sendJsonError(
            res,
            410,
            "SESSION_DELETED",
            "client_sessions row is soft-deleted",
            requestId,
          );
          return;
        }
        if (r.reason === "oversized") {
          // Master row is already past MAX_SESSION_BYTES; appending this
          // thinking row would push it further. 413 (vs 500) so the container's
          // anthropicProxy treats it as a give-up-don't-retry signal and drops
          // the entry from its sink queue rather than spinning on a row it can
          // never write.
          // 长会话热尾巴+归档上线后:写路径每次 merge 前都 spill,行体积恒有界,
          // MAX_SESSION_BYTES 4MB 只是最后防线 —— **理论不可达,命中即 bug**(spill
          // 没生效 / 单条超大消息)。故日志升 error 级 + postSpillUnexpected 标记便于
          // 告警定位(取代旧的"admin 跑 strip 脚本"人工兜底)。
          userLog.error("thinking_session_oversized", {
            sessionId: body.sessionId,
            turnIndex: body.turnIndex,
            postSpillUnexpected: true,
          });
          metric("reject_oversized", "thinking");
          emitToolsMetric();
          sendJsonError(
            res,
            413,
            "SESSION_OVERSIZED",
            "client_sessions row exceeds MAX_SESSION_BYTES; admin must strip before further writes",
            requestId,
          );
          return;
        }
        // malformed
        userLog.error("master_row_malformed_thinking", {
          sessionId: body.sessionId,
          turnIndex: body.turnIndex,
        });
        metric("error", "thinking");
        emitToolsMetric();
        sendJsonError(
          res,
          500,
          "ROW_MALFORMED",
          "master row data corrupt",
          requestId,
        );
        return;
      }

      // tools-only path — first tool's outcome decides HTTP. Remaining
      // tools' outcomes are still emitted via emitToolsMetric (which
      // covers index 0 too — counted exactly once). agentGroups (if any) are
      // best-effort here (metrics already emitted inline above).
      if (hasTools) {
      if (toolThrew[0]) {
        emitToolsMetric();
        sendJsonError(
          res,
          500,
          "STORAGE_ERROR",
          "storage write failed",
          requestId,
        );
        return;
      }
      const r0 = toolResults[0]!;
      if (r0.applied || r0.reason === "already_exists") {
        emitToolsMetric();
        sendJsonOk(
          res,
          200,
          r0.applied ? { ok: true } : { ok: true, idempotent: true },
          requestId,
        );
        return;
      }
      if (r0.reason === "session_not_found") {
        userLog.info("tools_only_session_not_found", {
          sessionId: body.sessionId,
          turnIndex: body.turnIndex,
        });
        emitToolsMetric();
        sendJsonError(
          res,
          404,
          "SESSION_NOT_FOUND",
          "no client_sessions row for sessionId+userId",
          requestId,
        );
        return;
      }
      if (r0.reason === "session_deleted") {
        userLog.info("tools_only_session_deleted", {
          sessionId: body.sessionId,
          turnIndex: body.turnIndex,
        });
        emitToolsMetric();
        sendJsonError(
          res,
          410,
          "SESSION_DELETED",
          "client_sessions row is soft-deleted",
          requestId,
        );
        return;
      }
      if (r0.reason === "oversized") {
        // 热尾巴+归档后理论不可达,命中即 bug(见 thinking 分支注释)→ error + 标记。
        userLog.error("tools_only_session_oversized", {
          sessionId: body.sessionId,
          turnIndex: body.turnIndex,
          postSpillUnexpected: true,
        });
        emitToolsMetric();
        sendJsonError(
          res,
          413,
          "SESSION_OVERSIZED",
          "client_sessions row exceeds MAX_SESSION_BYTES; admin must strip before further writes",
          requestId,
        );
        return;
      }
      // malformed
      userLog.error("master_row_malformed_tool", {
        sessionId: body.sessionId,
        turnIndex: body.turnIndex,
      });
      emitToolsMetric();
      sendJsonError(
        res,
        500,
        "ROW_MALFORMED",
        "master row data corrupt",
        requestId,
      );
      return;
      } else if (hasAgentGroups) {
        // agentGroups-only path — no assistant, no thinking, no tools (leader
        // crashed/interrupted after delegating, before producing text). Schema
        // refine guarantees hasAgentGroups here. First agent-group's outcome
        // decides HTTP; metrics already emitted inline above.
        if (agentGroupThrew[0]) {
          sendJsonError(res, 500, "STORAGE_ERROR", "storage write failed", requestId);
          return;
        }
        const ag0 = agentGroupResults[0]!;
        if (ag0.applied || ag0.reason === "already_exists") {
          sendJsonOk(
            res,
            200,
            ag0.applied ? { ok: true } : { ok: true, idempotent: true },
            requestId,
          );
          return;
        }
        if (ag0.reason === "session_not_found") {
          userLog.info("agent_group_only_session_not_found", {
            sessionId: body.sessionId,
            turnIndex: body.turnIndex,
          });
          sendJsonError(
            res,
            404,
            "SESSION_NOT_FOUND",
            "no client_sessions row for sessionId+userId",
            requestId,
          );
          return;
        }
        if (ag0.reason === "session_deleted") {
          userLog.info("agent_group_only_session_deleted", {
            sessionId: body.sessionId,
            turnIndex: body.turnIndex,
          });
          sendJsonError(
            res,
            410,
            "SESSION_DELETED",
            "client_sessions row is soft-deleted",
            requestId,
          );
          return;
        }
        if (ag0.reason === "oversized") {
          // 热尾巴+归档后理论不可达,命中即 bug(见 thinking 分支注释)→ error + 标记。
          userLog.error("agent_group_only_session_oversized", {
            sessionId: body.sessionId,
            turnIndex: body.turnIndex,
            postSpillUnexpected: true,
          });
          sendJsonError(
            res,
            413,
            "SESSION_OVERSIZED",
            "client_sessions row exceeds MAX_SESSION_BYTES; admin must strip before further writes",
            requestId,
          );
          return;
        }
        // malformed
        userLog.error("master_row_malformed_agent_group", {
          sessionId: body.sessionId,
          turnIndex: body.turnIndex,
        });
        sendJsonError(
          res,
          500,
          "ROW_MALFORMED",
          "master row data corrupt",
          requestId,
        );
        return;
      } else if (hasPermissionCards) {
        // permission-card-only path — detached ask_user create sidecar.
        if (permissionThrew[0]) {
          sendJsonError(res, 500, "STORAGE_ERROR", "storage write failed", requestId);
          return;
        }
        const p0 = permissionResults[0]!;
        if (p0.applied || p0.reason === "already_exists") {
          sendJsonOk(
            res,
            200,
            p0.applied ? { ok: true } : { ok: true, idempotent: true },
            requestId,
          );
          return;
        }
        if (p0.reason === "session_not_found") {
          userLog.info("permission_only_session_not_found", {
            sessionId: body.sessionId,
            requestId: permissionCards[0]?.requestId,
          });
          sendJsonError(
            res,
            404,
            "SESSION_NOT_FOUND",
            "no client_sessions row for sessionId+userId",
            requestId,
          );
          return;
        }
        if (p0.reason === "session_deleted") {
          userLog.info("permission_only_session_deleted", {
            sessionId: body.sessionId,
            requestId: permissionCards[0]?.requestId,
          });
          sendJsonError(
            res,
            410,
            "SESSION_DELETED",
            "client_sessions row is soft-deleted",
            requestId,
          );
          return;
        }
        if (p0.reason === "oversized") {
          userLog.error("permission_only_session_oversized", {
            sessionId: body.sessionId,
            postSpillUnexpected: true,
          });
          sendJsonError(
            res,
            413,
            "SESSION_OVERSIZED",
            "client_sessions row exceeds MAX_SESSION_BYTES; admin must strip before further writes",
            requestId,
          );
          return;
        }
        userLog.error("master_row_malformed_permission", {
          sessionId: body.sessionId,
        });
        sendJsonError(
          res,
          500,
          "ROW_MALFORMED",
          "master row data corrupt",
          requestId,
        );
        return;
      } else if (hasPermissionPatches) {
        if (patchThrew[0]) {
          sendJsonError(res, 500, "STORAGE_ERROR", "storage write failed", requestId);
          return;
        }
        const p0 = patchResults[0]!;
        if (p0.applied) {
          sendJsonOk(res, 200, { ok: true }, requestId);
          return;
        }
        if (p0.reason === "session_not_found") {
          sendJsonError(
            res,
            404,
            "SESSION_NOT_FOUND",
            "no client_sessions row or permission card for sessionId+userId",
            requestId,
          );
          return;
        }
        if (p0.reason === "session_deleted") {
          sendJsonError(
            res,
            410,
            "SESSION_DELETED",
            "client_sessions row is soft-deleted",
            requestId,
          );
          return;
        }
        sendJsonError(res, 500, "ROW_MALFORMED", "master row data corrupt", requestId);
        return;
      } else if (hasUserAnswerMessages) {
        // user-answer-only sidecar
        if (userAnswerThrew[0]) {
          sendJsonError(res, 500, "STORAGE_ERROR", "storage write failed", requestId);
          return;
        }
        const u0 = userAnswerResults[0]!;
        if (u0.applied || u0.reason === "already_exists") {
          sendJsonOk(
            res,
            200,
            u0.applied ? { ok: true } : { ok: true, idempotent: true },
            requestId,
          );
          return;
        }
        if (u0.reason === "session_not_found") {
          sendJsonError(
            res,
            404,
            "SESSION_NOT_FOUND",
            "no client_sessions row for sessionId+userId",
            requestId,
          );
          return;
        }
        if (u0.reason === "session_deleted") {
          sendJsonError(
            res,
            410,
            "SESSION_DELETED",
            "client_sessions row is soft-deleted",
            requestId,
          );
          return;
        }
        if (u0.reason === "oversized") {
          sendJsonError(
            res,
            413,
            "SESSION_OVERSIZED",
            "client_sessions row exceeds MAX_SESSION_BYTES; admin must strip before further writes",
            requestId,
          );
          return;
        }
        sendJsonError(res, 500, "ROW_MALFORMED", "master row data corrupt", requestId);
        return;
      }
    }

    // ── Branch B: has assistant (with optional thinking) ──
    //
    // Dispatch on requestId presence:
    //   - body.requestId set (codex billing path / anthropicProxy path):
    //     route through `appendServerAuthoredMessageForRequest`, which drains
    //     pending costCredits + records the request_map row so a deferred
    //     `appendCostCredits(requestId, userId, ...)` call can patch
    //     `messages[i].usage.costCredits` in-place.
    //   - body.requestId absent (ccb-spawn path: DeepSeek V4 Pro and other
    //     non-codex models): gateway already finalized token usage inline in
    //     `body.usage`; no `appendCostCredits` consumer ever fires for these
    //     turns, so the request_map row would be a dead key. Plain
    //     `appendServerAuthoredMessage` keeps the table small and the code
    //     symmetric with thinking/tools writes.
    //
    // Both paths write the same `assistantMsg` shape; the only difference is
    // whether we record the cost-late-patch join key.
    // Fix B (2026-05-25) — assistant writes.
    //
    // Single-row path (no assistantSegments): one write, exactly as before.
    // Multi-row path (assistantSegments present): one write per segment with
    // id `srv-${idPart}-t${turnIndex}-s${index}` and ts = segment.ts (the
    // wall-clock first-token arrival time, parser-stamped). Only the LAST
    // segment carries usage / _truncated / _errorCode / _errorDetail (those
    // are turn-level metadata; placing them on intermediate segments would
    // make refresh recovery double-render the pill); the same last segment
    // is also the one registered in `server_authored_request_map` so a
    // deferred `appendCostCredits(requestId, ...)` patches the segment that
    // visually closes the turn. Earlier segments use plain
    // `appendServerAuthoredMessage`. Plan §3.5.4.
    type AssistantWrite = { id: string; msg: ServerAuthoredMessageInput };
    const assistantWrites: AssistantWrite[] = hasAssistantSegments
      ? body.assistantSegments!.map((seg, i, arr) => {
          const isLast = i === arr.length - 1;
          const id = `srv-${idPart}-t${body.turnIndex}-s${seg.index}`;
          const msg: ServerAuthoredMessageInput = {
            id,
            role: "assistant",
            text: seg.text,
            ts: seg.ts,
            status: body.status,
            ...(isLast && body.usage ? { usage: body.usage } : {}),
            ...(isLast && body.truncated ? { _truncated: true } : {}),
            ...(isLast && body.errorCode ? { _errorCode: body.errorCode } : {}),
            ...(isLast && body.errorDetail ? { _errorDetail: body.errorDetail } : {}),
          };
          return { id, msg };
        })
      : [
          {
            id: messageId,
            msg: {
              id: messageId,
              role: "assistant",
              text: body.text,
              ts: assistantTs,
              status: body.status,
              ...(body.usage ? { usage: body.usage } : {}),
              ...(body.truncated ? { _truncated: true } : {}),
              ...(body.errorCode ? { _errorCode: body.errorCode } : {}),
              ...(body.errorDetail ? { _errorDetail: body.errorDetail } : {}),
            },
          },
        ];

    // Non-last assistant writes are best-effort: they don't register in
    // request_map (single requestId → single map row), don't carry usage,
    // and their failures are logged + metric'd without changing HTTP outcome.
    // Surface their throws so ops sees structural storage problems.
    for (let i = 0; i < assistantWrites.length - 1; i++) {
      const w = assistantWrites[i]!;
      try {
        const r = await deps.storage.appendServerAuthoredMessage(
          body.sessionId,
          userId,
          w.msg,
        );
        if (r.applied) metric("ok", "assistant");
        else if (r.reason === "already_exists") metric("deduped", "assistant");
        else if (r.reason === "session_not_found")
          metric("reject_session_missing", "assistant");
        else if (r.reason === "session_deleted")
          metric("reject_session_deleted", "assistant");
        else if (r.reason === "oversized")
          metric("reject_oversized", "assistant");
        else metric("error", "assistant");
      } catch (err) {
        userLog.error("assistant_segment_storage_threw", {
          sessionId: body.sessionId,
          turnIndex: body.turnIndex,
          segmentId: w.id,
          err: err as Error,
        });
        metric("error", "assistant");
      }
    }

    const lastAssistant = assistantWrites[assistantWrites.length - 1]!;
    let assistantResult: Awaited<
      ReturnType<ServerAuthoredStorage["appendServerAuthoredMessageForRequest"]>
    >;
    try {
      if (body.requestId !== undefined) {
        assistantResult = await deps.storage.appendServerAuthoredMessageForRequest(
          body.requestId,
          body.sessionId,
          userId,
          lastAssistant.msg,
        );
      } else {
        // ccb-spawn 路径(无 per-turn requestId):走 drain-by-user,把 anthropicProxy 异步算费
        // park 在 pending_usage_patches 的本轮 cost 合进这条助手消息的 usage.costCredits,
        // 使跨设备 reload(getSession)也能看到 per-response 积分(live 帧走 broadcastToUser 另算)。
        assistantResult = await deps.storage.appendServerAuthoredMessageDrainByUser(
          body.sessionId,
          userId,
          lastAssistant.msg,
          // 有 agentSessionId(新镜像)→ 按 session 精确排空;缺省(老镜像)→ by-user 兜底。
          body.agentSessionId,
        );
      }
    } catch (err) {
      userLog.error("assistant_storage_threw", {
        sessionId: body.sessionId,
        turnIndex: body.turnIndex,
        err: err as Error,
      });
      emitThinkingMetric();
      emitToolsMetric();
      metric("error", "assistant");
      sendJsonError(
        res,
        500,
        "STORAGE_ERROR",
        "storage write failed",
        requestId,
      );
      return;
    }

    // ── Fix A durable — 委派成本按父客户端会话归并(两条 sink 路径的统一收口)──
    //
    // 队长助手行落库后(requestId 路径 appendServerAuthoredMessageForRequest / drain-by-user
    // 路径 appendServerAuthoredMessageDrainByUser 都在此汇合),把该 user 下
    // parent_session_id = body.sessionId(父**客户端**会话 web-*,= 委派 pending park 时记录的
    // oc_parent_session_id 解析值)的委派 pending 成本**求和累加**进这条队长助手行
    // (lastAssistant.id)的 usage.costCredits。
    //
    // 触发条件 = applied || already_exists(行已存在、可 patch);无委派成本 → 零副作用
    // (drainDelegateCostForClientSession 内部 Σ=0 时不写库、不 bump _seq,普通 turn 不受影响)。
    //
    // **不重复计费**:委派 pending 行 parent_session_id 非空 / session_id 是委派子进程自己的引擎
    // 会话;队长自费走 requestId(其 pending parent_session_id=NULL)或 by-agent-session(WHERE
    // session_id=队长引擎会话)排空 —— 两池 disjoint,本 drain 只命中委派行,不碰队长自费行。
    //
    // best-effort:失败仅 log,不改 HTTP 结论(assistantResult 已定);pending 未排空的由下一
    // turn 队长行 drain 或 GC sweep 兜底。晚到的委派 pending(本轮 sink 之后到达)不在本次 SELECT
    // 里,留给下一 turn 归并(与既有 pending 语义一致)。
    if (assistantResult.applied || assistantResult.reason === "already_exists") {
      try {
        const drained = await deps.storage.drainDelegateCostForClientSession(
          body.sessionId,
          userId,
          lastAssistant.id,
        );
        if (drained.drained > 0) {
          userLog.info("delegate_cost_merged", {
            sessionId: body.sessionId,
            msgId: lastAssistant.id,
            merged: drained.merged,
            drainedRows: drained.drained,
          });
        }
      } catch (err) {
        userLog.warn("delegate_cost_drain_failed", {
          sessionId: body.sessionId,
          msgId: lastAssistant.id,
          err: err as Error,
        });
      }
    }

    if (assistantResult.applied) {
      emitThinkingMetric();
      emitToolsMetric();
      metric("ok", "assistant");
      sendJsonOk(res, 200, { ok: true }, requestId);
      return;
    }
    if (assistantResult.reason === "already_exists") {
      emitThinkingMetric();
      emitToolsMetric();
      metric("deduped", "assistant");
      sendJsonOk(res, 200, { ok: true, idempotent: true }, requestId);
      return;
    }
    if (assistantResult.reason === "session_not_found") {
      userLog.info("session_not_found", {
        sessionId: body.sessionId,
        turnIndex: body.turnIndex,
      });
      emitThinkingMetric();
      emitToolsMetric();
      metric("reject_session_missing", "assistant");
      sendJsonError(
        res,
        404,
        "SESSION_NOT_FOUND",
        "no client_sessions row for sessionId+userId",
        requestId,
      );
      return;
    }
    if (assistantResult.reason === "session_deleted") {
      userLog.info("session_deleted", {
        sessionId: body.sessionId,
        turnIndex: body.turnIndex,
      });
      emitThinkingMetric();
      emitToolsMetric();
      metric("reject_session_deleted", "assistant");
      sendJsonError(
        res,
        410,
        "SESSION_DELETED",
        "client_sessions row is soft-deleted",
        requestId,
      );
      return;
    }
    if (assistantResult.reason === "oversized") {
      // 热尾巴+归档后理论不可达,命中即 bug(见 thinking 分支注释)→ error + 标记。
      userLog.error("session_oversized", {
        sessionId: body.sessionId,
        turnIndex: body.turnIndex,
        postSpillUnexpected: true,
      });
      emitThinkingMetric();
      emitToolsMetric();
      metric("reject_oversized", "assistant");
      sendJsonError(
        res,
        413,
        "SESSION_OVERSIZED",
        "client_sessions row exceeds MAX_SESSION_BYTES; admin must strip before further writes",
        requestId,
      );
      return;
    }
    // 'malformed' — master row's messages JSON is corrupt. Master-side data
    // issue, not a container bug; 500 so the entry is queued for retry.
    userLog.error("master_row_malformed", {
      sessionId: body.sessionId,
      turnIndex: body.turnIndex,
    });
    emitThinkingMetric();
    emitToolsMetric();
    metric("error", "assistant");
    sendJsonError(res, 500, "ROW_MALFORMED", "master row data corrupt", requestId);
  };
}

// ─── private helpers ────────────────────────────────────────────────────────

const LosslessTapeBaseSchema = z.object({
  protocolVersion: z.literal(LOSSLESS_TURN_TAPE_VERSION),
  sessionId: z.string().min(8).max(50),
  agentId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  turnIndex: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  status: z.enum(["completed", "interrupted", "crashed"]),
  waiveReason: z.enum([
    "idle_timeout",
    "no_response",
    "platform_authority_expired",
    "turn_limit",
  ] satisfies readonly TurnWaiveReason[]).optional(),
  model: z.string().min(1).max(256).optional(),
  turnKey: z.string().regex(LOSSLESS_TURN_TAPE_SHA256_RE),
  tapeId: z.string().regex(LOSSLESS_TURN_TAPE_SHA256_RE),
  tapeSha256: z.string().regex(LOSSLESS_TURN_TAPE_SHA256_RE),
  totalBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  partCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  createdAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  // durable turn dispatch 身份(RFC §2.4):sink 首片带来 → 落 tape header。可选(legacy tape 无)。
  // 不改 protocol 线型:zod 在 master 边界接收,storage 从 parsed.data 单独取传入。
  dispatchId: z.string().uuid().optional(),
  attemptNo: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});

const LosslessTapeSettlementSchema = z.object({
  billingAnchorId: z.string().min(1).max(256),
  requestId: z.string().min(1).max(256).optional(),
  engineBillings: z.array(z.record(z.string(), z.unknown())).default([]),
  text: z.string(),
  ts: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  truncated: z.boolean().optional(),
  errorCode: z.string().min(1).max(256).optional(),
}).strict();

const LosslessTapePartSchema = LosslessTapeBaseSchema.extend({
  action: z.literal("part"),
  partIndex: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  partSha256: z.string().regex(LOSSLESS_TURN_TAPE_SHA256_RE),
  data: z.string().min(1),
  // Rolling compatibility for gateways that accidentally copied the finalize-only
  // settlement object onto each part. It is strictly validated and discarded below;
  // only visible/finalize may hand settlement authority to storage/billing.
  settlement: LosslessTapeSettlementSchema.optional(),
}).strict();

const LosslessTapeVisibleSchema = LosslessTapeBaseSchema.extend({
  action: z.literal("visible"),
  settlement: LosslessTapeSettlementSchema,
}).strict();

const LosslessTapeFinalizeSchema = LosslessTapeBaseSchema.extend({
  action: z.literal("finalize"),
  settlement: LosslessTapeSettlementSchema.optional(),
}).strict();

function isLosslessTurnTapeWireBody(raw: unknown): boolean {
  return !!raw && typeof raw === "object" && !Array.isArray(raw)
    && (raw as Record<string, unknown>).protocolVersion === LOSSLESS_TURN_TAPE_VERSION;
}

/**
 * turn tape 落库错误的**瞬态 vs 永久**判定(止血批 A · A3)。
 *
 * part/finalize 若因 PG **瞬态**故障失败(statement timeout / 连接类 / 死锁 / 锁不可得 /
 * 服务重启),必须回 **503 + TURN_TAPE_RETRYABLE**,让容器侧 fsync 队列**幂等重试**;绝不能
 * 回 409 —— 409 语义=永久不可变冲突(别重试),会让本可重试的 part/finalize 永久丢失。
 * 409(TURN_TAPE_CONFLICT)只留给真正的 immutable 冲突(同 index 不同 sha、聚合/校验失败等,
 * 重试也不会变的确定性错误)。
 *
 * 判据:PG SQLSTATE(node-pg 挂在 err.code,仓内既有惯例即直读 .code,见 plugins/accounts.ts
 * 的 '23505' 判定)+ message 兜底(socket 级错误可能无 code)。
 *   57014 query_canceled(statement timeout) · 40001 serialization_failure ·
 *   40P01 deadlock_detected · 55P03 lock_not_available ·
 *   08*  连接异常类 · 57P0* 服务 shutdown / cannot_connect_now。
 */
function isTransientTurnTapeStorageError(err: unknown): boolean {
  if (
    err && typeof err === "object" &&
    (err as { retryable?: unknown }).retryable === true
  ) {
    return true;
  }
  const code =
    err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : "";
  if (
    code === "57014" || code === "40001" || code === "40P01" || code === "55P03"
    || code.startsWith("08") || code.startsWith("57P")
  ) {
    return true;
  }
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /statement timeout|canceling statement due to|connection terminated|terminating connection|server closed the connection|ECONNRESET|ETIMEDOUT|EPIPE/i.test(
    msg,
  );
}

async function handleLosslessTurnTapeRequest(args: {
  raw: unknown;
  userId: string;
  numericUserId: bigint;
  requestId: string;
  res: ServerResponse;
  storage?: LosslessTurnTapeStorage;
  settleCodexBilling?: (userId: bigint, billing: DurableCodexBilling) => Promise<void>;
  applyTurnWaiver?: (input: TurnWaiverInput) => Promise<TurnWaiverResult>;
  broadcastToUser?: (uid: bigint, payload: Record<string, unknown>) => void;
  recordProviderHealth?: (model: string, kind: "timeout") => void;
  userLog: Logger;
  metric: (outcome: V3SinkPersistOutcome, role?: V3SinkPersistRole) => void;
}): Promise<void> {
  if (!args.storage) {
    sendJsonError(args.res, 503, "TURN_TAPE_UNAVAILABLE", "lossless turn tape store unavailable", args.requestId);
    return;
  }
  const action = (args.raw as Record<string, unknown>).action;
  if (action === "visible") {
    const parsed = LosslessTapeVisibleSchema.safeParse(args.raw);
    if (!parsed.success) {
      args.metric("reject_bad_body");
      sendJsonError(args.res, 400, "INVALID_TURN_TAPE_VISIBLE", "turn tape visible schema rejected", args.requestId);
      return;
    }
    if (!args.storage.commitVisibleLosslessTurnTape) {
      sendJsonError(args.res, 503, "TURN_TAPE_VISIBLE_UNAVAILABLE", "visible commit store unavailable", args.requestId);
      return;
    }
    const body = parsed.data as unknown as LosslessTurnTapeVisibleRequest;
    if (body.partCount !== Math.ceil(body.totalBytes / LOSSLESS_TURN_TAPE_PART_BYTES)) {
      args.metric("reject_bad_body");
      sendJsonError(args.res, 400, "INVALID_TURN_TAPE_LAYOUT", "turn tape visible layout rejected", args.requestId);
      return;
    }
    try {
      const result = await args.storage.commitVisibleLosslessTurnTape(args.userId, body);
      if (result.applied === "session_not_found") {
        sendJsonError(args.res, 404, "SESSION_NOT_FOUND", "no client_sessions row for sessionId+userId", args.requestId);
        return;
      }
      if (result.applied === "session_deleted") {
        sendJsonError(args.res, 410, "SESSION_DELETED", "client_sessions row is soft-deleted", args.requestId);
        return;
      }
      if (result.applied !== "finalized" && result.applied !== "idempotent") {
        throw new Error("visible commit failed to create immutable tape header");
      }
      if (result.newlyVisible && result.clientMessageId && !result.dispatchLateTape) {
        args.broadcastToUser?.(args.numericUserId, {
          type: "outbound.message",
          channel: "webchat",
          peer: { id: body.sessionId, kind: "dm" },
          agentId: body.agentId,
          clientMessageId: result.clientMessageId,
          blocks: [],
          isFinal: true,
          meta: {
            reconcile: body.status === "completed" ? "turn_completed" : "interrupted",
            clientMessageId: result.clientMessageId,
          },
          ts: Date.now(),
        });
      }
      args.metric(result.applied === "idempotent" ? "deduped" : "ok", "assistant");
      sendJsonOk(args.res, 200, {
        ok: true,
        idempotent: result.applied === "idempotent",
        visible: true,
        settlementHandoff: true,
      }, args.requestId);
      return;
    } catch (err) {
      const transient = isTransientTurnTapeStorageError(err);
      args.userLog.error("lossless_turn_tape_visible_failed", {
        tapeId: body.tapeId,
        transient,
        err: err as Error,
      });
      sendJsonError(
        args.res,
        transient ? 503 : 409,
        transient ? "TURN_TAPE_RETRYABLE" : "TURN_TAPE_CONFLICT",
        transient ? "turn tape visible storage transient failure" : "turn tape visible immutable conflict",
        args.requestId,
      );
      return;
    }
  }
  if (action === "part") {
    const parsed = LosslessTapePartSchema.safeParse(args.raw);
    if (!parsed.success) {
      args.metric("reject_bad_body");
      sendJsonError(args.res, 400, "INVALID_TURN_TAPE_PART", "turn tape part schema rejected", args.requestId);
      return;
    }
    const { settlement: _ignoredFinalizeOnlySettlement, ...partData } = parsed.data;
    const body = partData as LosslessTurnTapePartRequest;
    if (
      body.partCount !== Math.ceil(body.totalBytes / LOSSLESS_TURN_TAPE_PART_BYTES)
      || body.partIndex >= body.partCount
    ) {
      args.metric("reject_bad_body");
      sendJsonError(args.res, 400, "INVALID_TURN_TAPE_LAYOUT", "turn tape part layout rejected", args.requestId);
      return;
    }
    const bytes = Buffer.from(body.data, "base64");
    const expectedBytes = body.partIndex === body.partCount - 1
      ? body.totalBytes - LOSSLESS_TURN_TAPE_PART_BYTES * (body.partCount - 1)
      : LOSSLESS_TURN_TAPE_PART_BYTES;
    const canonicalBase64 = bytes.toString("base64");
    const actualSha = createHash("sha256").update(bytes).digest("hex");
    if (canonicalBase64 !== body.data || bytes.length !== expectedBytes || actualSha !== body.partSha256) {
      args.metric("reject_bad_body");
      sendJsonError(args.res, 400, "INVALID_TURN_TAPE_PART", "turn tape part bytes rejected", args.requestId);
      return;
    }
    const partDispatchIdentity = parsed.data.dispatchId !== undefined
      ? { dispatchId: parsed.data.dispatchId, attemptNo: parsed.data.attemptNo ?? 1 }
      : undefined;
    try {
      const result = await args.storage.stageLosslessTurnTapePart(args.userId, body, bytes, partDispatchIdentity);
      if (result.applied === "session_not_found") {
        sendJsonError(args.res, 404, "SESSION_NOT_FOUND", "no client_sessions row for sessionId+userId", args.requestId);
        return;
      }
      if (result.applied === "session_deleted") {
        sendJsonError(args.res, 410, "SESSION_DELETED", "client_sessions row is soft-deleted", args.requestId);
        return;
      }
      sendJsonOk(args.res, 200, { ok: true, idempotent: result.applied === "idempotent" }, args.requestId);
      return;
    } catch (err) {
      const transient = isTransientTurnTapeStorageError(err);
      args.userLog.error("lossless_turn_tape_part_failed", {
        tapeId: body.tapeId,
        partIndex: body.partIndex,
        transient,
        err: err as Error,
      });
      if (transient) {
        // 瞬态落库故障(statement timeout / 连接 / 死锁…)→ 503,让容器 fsync 队列幂等重试,
        // 别误报永久冲突(part 可重放,数据无损)。
        sendJsonError(args.res, 503, "TURN_TAPE_RETRYABLE", "turn tape part storage transient failure", args.requestId);
        return;
      }
      sendJsonError(args.res, 409, "TURN_TAPE_CONFLICT", "turn tape immutable data conflict", args.requestId);
      return;
    }
  }

  if (action === "finalize") {
    const parsed = LosslessTapeFinalizeSchema.safeParse(args.raw);
    if (!parsed.success) {
      args.metric("reject_bad_body");
      sendJsonError(args.res, 400, "INVALID_TURN_TAPE_FINALIZE", "turn tape finalize schema rejected", args.requestId);
      return;
    }
    const body = parsed.data as LosslessTurnTapeFinalizeRequest;
    if (body.partCount !== Math.ceil(body.totalBytes / LOSSLESS_TURN_TAPE_PART_BYTES)) {
      args.metric("reject_bad_body");
      sendJsonError(args.res, 400, "INVALID_TURN_TAPE_LAYOUT", "turn tape finalize layout rejected", args.requestId);
      return;
    }
    try {
      const result = await args.storage.finalizeLosslessTurnTape(args.userId, body, { materialize: false });
      if (result.applied === "session_not_found") {
        sendJsonError(args.res, 404, "SESSION_NOT_FOUND", "no client_sessions row for sessionId+userId", args.requestId);
        return;
      }
      if (result.applied === "session_deleted") {
        sendJsonError(args.res, 410, "SESSION_DELETED", "client_sessions row is soft-deleted", args.requestId);
        return;
      }
      if (result.applied === "incomplete") {
        sendJsonError(args.res, 409, "TURN_TAPE_INCOMPLETE", "turn tape is not fully staged", args.requestId);
        return;
      }
      if (result.applied !== "finalized" && result.applied !== "idempotent") {
        throw new Error("unexpected lossless turn tape finalize result");
      }
      // Egress correctly classifies a downstream client abort as `aborted`
      // (excluded from provider judgement). Only the gateway's exact
      // LIVENESS_TIMEOUT waiver proves that this abort was actually caused by
      // a silent upstream. Record once at the first immutable finalize; broad
      // `no_response` and ordinary user cancellation remain excluded.
      if (
        result.applied === "finalized" &&
        body.waiveReason === "idle_timeout" &&
        body.model
      ) {
        args.recordProviderHealth?.(body.model, "timeout");
      }
      // late true tape(RFC §2.4):reconciler 已宣告 not_accepted、error 卡已投影,tape 迟到。
      // storage 已在同一 tx 撤 projection + 转 dispatch → manual_reconcile,内容仍完整 materialize
      // (钱安全)。这里发一条 critical 告警交人工核对(已告知用户失败却又计费产出内容)。
      if (result.dispatchLateTape) {
        void enqueueAlert({
          event_type: EVENTS.OPS_INCIDENT_OPENED,
          severity: "critical",
          title: "late turn tape 迟到(已告知失败却又产出计费内容)",
          body:
            `session \`${body.sessionId}\` tape \`${body.tapeId}\`:reconciler 已宣告该 turn ` +
            `not_accepted 并向用户展示终态 error 卡,tape 随后到达。内容已完整 materialize(钱安全 I5),` +
            `dispatch 已转 manual_reconcile、error 卡已撤销。请人工核对计费与用户告知一致性。`,
          payload: { source: "losslessTurnTapeFinalize", kind: "late_tape", session_id: body.sessionId, tape_id: body.tapeId },
          dedupe_key: `${EVENTS.OPS_INCIDENT_OPENED}:late_tape:${body.tapeId}`,
        }).catch(() => {});
      }
      const settlementHandoff = result.settlementHandoff === true
        || result.settlementHeld === true
        || (result.engineBillings.length === 0 && body.waiveReason === undefined);
      const skipSyncSettle = result.settlementHandoff === true || result.settlementHeld === true;
      if (!skipSyncSettle && result.engineBillings.length > 0) {
        if (!args.settleCodexBilling) {
          if (!settlementHandoff) {
            sendJsonError(
              args.res,
              503,
              "TURN_TAPE_BILLING_UNAVAILABLE",
              "durable codex billing settlement unavailable",
              args.requestId,
            );
            return;
          }
        } else {
          try {
            for (const billing of result.engineBillings) {
              await args.settleCodexBilling(args.numericUserId, billing);
            }
          } catch (err) {
            args.userLog.error("lossless_turn_tape_billing_settle_failed", {
              tapeId: body.tapeId,
              err: err as Error,
            });
            if (!settlementHandoff) {
              sendJsonError(
                args.res,
                503,
                "TURN_TAPE_BILLING_PENDING",
                "durable codex billing settlement pending",
                args.requestId,
              );
              return;
            }
          }
        }
      }
      let waiverResult: TurnWaiverResult | undefined;
      if (!skipSyncSettle && body.waiveReason !== undefined) {
        if (!args.applyTurnWaiver) {
          if (!settlementHandoff) {
            sendJsonError(args.res, 503, "TURN_WAIVER_UNAVAILABLE", "exact turn waiver unavailable", args.requestId);
            return;
          }
        } else {
        try {
          waiverResult = await args.applyTurnWaiver({
            userId: args.numericUserId,
            turnKey: body.turnKey,
            reason: body.waiveReason,
            logger: args.userLog,
          });
        } catch (err) {
          args.userLog.error("lossless_turn_waiver_apply_failed", {
            tapeId: body.tapeId,
            turnKey: body.turnKey,
            reason: body.waiveReason,
            err: err as Error,
          });
          if (!settlementHandoff) {
            sendJsonError(args.res, 503, "TURN_WAIVER_PENDING", "exact refund and receipt pending", args.requestId);
            return;
          }
        }
        }
        // ACK-loss retries re-enter this block after refund+receipt committed;
        // only the applying transaction emits the best-effort live projection.
        // The durable targeted inbox receipt remains the source of truth.
        if (waiverResult?.newlyApplied) {
          try {
            args.broadcastToUser?.(args.numericUserId, {
              type: "outbound.cost_waived",
              sessionId: body.sessionId,
              turnKey: body.turnKey,
              refundedCredits: waiverResult.refundedCredits.toString(),
              balanceAfter: waiverResult.totalAfter === null ? null : waiverResult.totalAfter.toString(),
              reason: body.waiveReason,
              inboxMessageId: waiverResult.inboxMessageId,
            });
          } catch (err) {
            args.userLog.warn("lossless_turn_waiver_broadcast_failed", {
              turnKey: body.turnKey,
              err: err as Error,
            });
          }
        }
      }
      if (result.newlyVisible && result.clientMessageId && !result.dispatchLateTape) {
        args.broadcastToUser?.(args.numericUserId, {
          type: "outbound.message",
          channel: "webchat",
          peer: { id: body.sessionId, kind: "dm" },
          agentId: body.agentId,
          clientMessageId: result.clientMessageId,
          blocks: [],
          isFinal: true,
          meta: {
            reconcile: body.status === "completed" ? "turn_completed" : "interrupted",
            clientMessageId: result.clientMessageId,
          },
          ts: Date.now(),
        });
      }
      args.metric(result.applied === "idempotent" ? "deduped" : "ok", "assistant");
      sendJsonOk(args.res, 200, {
        ok: true,
        idempotent: result.applied === "idempotent",
        recordCount: result.recordCount,
        ...(settlementHandoff ? { settlementHandoff: true } : {}),
        ...(waiverResult
          ? {
              waived: true,
              refundedCredits: waiverResult.refundedCredits.toString(),
              inboxMessageId: waiverResult.inboxMessageId,
            }
          : {}),
      }, args.requestId);
      return;
    } catch (err) {
      const transient = isTransientTurnTapeStorageError(err);
      args.userLog.error("lossless_turn_tape_finalize_failed", {
        tapeId: body.tapeId,
        transient,
        err: err as Error,
      });
      if (transient) {
        // 瞬态落库故障 → 503,让幂等 finalize 重试;409 只留给校验/物化的永久冲突。
        sendJsonError(args.res, 503, "TURN_TAPE_RETRYABLE", "turn tape finalize storage transient failure", args.requestId);
        return;
      }
      sendJsonError(args.res, 409, "TURN_TAPE_CONFLICT", "turn tape verification or materialization failed", args.requestId);
      return;
    }
  }

  args.metric("reject_bad_body");
  sendJsonError(args.res, 400, "INVALID_TURN_TAPE_ACTION", "turn tape action rejected", args.requestId);
}

async function readBoundedJson(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ value: unknown; bytes: number }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const b = chunk instanceof Buffer ? chunk : Buffer.from(chunk as string);
    total += b.length;
    if (total > maxBytes) {
      throw new HttpError(
        413,
        "PAYLOAD_TOO_LARGE",
        `request body exceeds ${maxBytes} bytes`,
      );
    }
    chunks.push(b);
  }
  if (total === 0) {
    throw new HttpError(400, "EMPTY_BODY", "request body is empty");
  }
  const text = Buffer.concat(chunks, total).toString("utf-8");
  try {
    return { value: JSON.parse(text), bytes: total };
  } catch (err) {
    // Preserve the legacy endpoint's 256 KiB body contract even though this
    // reader also admits one base64-encoded v2 tape part. An invalid payload
    // cannot identify itself as v2, so oversized invalid JSON remains 413.
    if (total > MAX_BODY_BYTES) {
      throw new HttpError(
        413,
        "PAYLOAD_TOO_LARGE",
        `request body exceeds ${MAX_BODY_BYTES} bytes`,
      );
    }
    throw new HttpError(
      400,
      "INVALID_JSON",
      `body is not valid JSON: ${(err as Error).message}`,
    );
  }
}

function findPermissionCardInMessages(
  messages: unknown,
  requestId: string,
): Record<string, unknown> | undefined {
  if (!Array.isArray(messages)) return undefined;
  return messages.find((m) => {
    if (!m || typeof m !== "object" || Array.isArray(m)) return false;
    const row = m as Record<string, unknown>;
    if (row.role !== "permission") return false;
    return row.id === requestId || row.requestId === requestId;
  }) as Record<string, unknown> | undefined;
}

function sendJsonOk(
  res: ServerResponse,
  status: number,
  payload: Record<string, unknown>,
  requestId: string,
): void {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body, "utf-8")),
    [REQUEST_ID_HEADER]: requestId,
  });
  res.end(body);
}

function sendJsonError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  requestId: string,
): void {
  if (res.headersSent) return;
  const body = JSON.stringify({
    error: { code, message },
    request_id: requestId,
  });
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body, "utf-8")),
    [REQUEST_ID_HEADER]: requestId,
  });
  res.end(body);
}

// ─── GET /internal/v3/turn-tape-state ────────────────────────────────────────
// 容器 boot recovery 用(RFC §2.4 / §3):按 dispatch 身份问 master「这条 turn 的 tape 落到哪了」。
// 三态:none(无 header)/ partial(有 header 未 finalize)/ finalized。容器据此决定
// recovery 分支(finalized→terminal;partial→sink_stage_failed+manual;none→构造 synthetic crashed)。
// 同 server-authored 的容器身份双因子(bearer + host/ip),GET + query 参数。

const DISPATCH_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface TurnTapeStateHandlerDeps {
  identityRepo: ContainerIdentityRepo;
  /** pgSessionsBackend(DispatchAdmissionBackend);缺省 → 503。 */
  storage?: Pick<DispatchAdmissionBackend, "getTurnTapeStateByDispatch">;
  logger?: Logger;
}

export function makeTurnTapeStateHandler(deps: TurnTapeStateHandlerDeps): ServerAuthoredHandler {
  const log = (deps.logger ?? rootLogger).child({ subsys: "internalTurnTapeState" });
  return async function handle(req, res, ctx) {
    setSecurityHeaders(res);
    const requestId = ensureRequestId(req);
    res.setHeader(REQUEST_ID_HEADER, requestId);

    if (req.method !== "GET") {
      sendJsonError(res, 405, "METHOD_NOT_ALLOWED", "GET required", requestId);
      return;
    }
    let identity;
    try {
      identity = await verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization);
    } catch (err) {
      if (err instanceof ContainerIdentityError) {
        sendJsonError(res, 401, "UNAUTHORIZED", "container identity verification failed", requestId);
        return;
      }
      throw err;
    }
    if (!deps.storage) {
      sendJsonError(res, 503, "TURN_TAPE_STATE_UNAVAILABLE", "turn tape state store unavailable", requestId);
      return;
    }
    const url = new URL(req.url ?? "/", "http://internal");
    const dispatchId = url.searchParams.get("dispatchId") ?? "";
    if (!DISPATCH_UUID_RE.test(dispatchId)) {
      sendJsonError(res, 400, "BAD_DISPATCH_ID", "dispatchId must be a uuid", requestId);
      return;
    }
    const attemptNo = Number(url.searchParams.get("attemptNo") ?? "1");
    if (!Number.isInteger(attemptNo) || attemptNo < 1) {
      sendJsonError(res, 400, "BAD_ATTEMPT_NO", "attemptNo must be a positive integer", requestId);
      return;
    }
    const userId = `c:${identity.userId}`;
    try {
      const result = await deps.storage.getTurnTapeStateByDispatch(userId, dispatchId, attemptNo);
      // state/status 与 dispatch lease 来自同一 PG statement snapshot。none
      // 分支的 lease boolean 是 gateway 恢复协议的滚动兼容能力证据。
      sendJsonOk(res, 200, {
        state: result.state,
        status: result.status,
        dispatchLeaseActive: result.dispatchLeaseActive,
        gatewayShutdownEvidence: result.gatewayShutdownEvidence === true,
      }, requestId);
    } catch (err) {
      log.error("turn_tape_state_read_failed", { dispatchId, attemptNo, err: err as Error });
      sendJsonError(res, 500, "TURN_TAPE_STATE_ERROR", "turn tape state read failed", requestId);
    }
  };
}
