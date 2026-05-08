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
 *   - msgId is ALWAYS derived as `srv-${sessionId}-t${turnIndex}` here. We
 *     do not accept client-controlled message ids.
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
 *     Container classifies this as `session_missing` and retries under a TTL —
 *     the frontend's debounced PUT may still be in flight when the first
 *     turn-end arrives, especially when a backgrounded tab wakes up.
 *     Eventually the PUT lands and the next retry succeeds; if it hasn't
 *     landed by the TTL expiry the entry is dropped.
 *   - HTTP 410 SESSION_DELETED: master HAS a row but it is soft-deleted
 *     (`deleted_at IS NOT NULL`). This is terminal: the user/admin removed
 *     the session, retrying will never make it writeable again. Container
 *     classifies this as `fatal` and drops the entry on first response,
 *     preventing 24h-TTL retry storms on stale durable-queue entries
 *     (historical incident: ~190K log lines from one user across 7
 *     successive container replacements draining the same dead session).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import { rootLogger, type Logger } from "../logging/logger.js";
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

/** Master persists assistant messages no larger than this. Conservative — a
 *  single chat turn rarely exceeds 64 KB; cap at 256 KB to leave headroom for
 *  unusually long codex outputs without enabling DoS-by-body. */
const MAX_BODY_BYTES = 256 * 1024;

/** Path the container's V3MasterSink POSTs to. Mounted on both the plain
 *  self-host listener and the mTLS remote-host listener. */
export const SERVER_AUTHORED_PATH = "/internal/v3/server-authored-message";

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
    /** Plan §4.3 改动 6 — token usage from gateway-side stream-finalizer.
     *  Persisted into `messages[i].usage`. costCredits joins later via
     *  `appendCostCredits` patch (which mutates this same usage object). */
    usage: z
      .object({
        inputTokens: z.number().int().min(0).optional(),
        outputTokens: z.number().int().min(0).optional(),
        cacheReadTokens: z.number().int().min(0).optional(),
        cacheCreationTokens: z.number().int().min(0).optional(),
        model: z.string().max(128).optional(),
        turn: z.number().int().min(0).optional(),
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
  })
  .strict()
  .refine(
    (v) =>
      v.text.length > 0 ||
      v.thinkingText !== undefined ||
      (v.tools !== undefined && v.tools.length > 0),
    { message: "either text, thinkingText, or tools[] must be non-empty" },
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
  role: "assistant" | "thinking" | "tool";
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
    model?: string;
    turn?: number;
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
}

export interface ServerAuthoredHandlerDeps {
  identityRepo: ContainerIdentityRepo;
  storage: ServerAuthoredStorage;
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
  const metric = deps.metric ?? incrV3SinkPersist;

  return async function handle(req, res, ctx) {
    setSecurityHeaders(res);
    const requestId = ensureRequestId(req);
    res.setHeader(REQUEST_ID_HEADER, requestId);

    const reqLog = log.child({
      requestId,
      hostUuid: ctx.hostUuid,
      boundIp: ctx.boundIp,
      method: req.method ?? "GET",
    });

    // 0) Method whitelist — caller's path router has already matched the path.
    if (req.method !== "POST") {
      // Method violations are caller-routing bugs, not container persist
      // attempts. Don't pollute the persist metric.
      sendJsonError(res, 405, "METHOD_NOT_ALLOWED", "POST required", requestId);
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
    const userLog = reqLog.child({
      uid,
      containerId: identity.containerId,
    });

    // 2) Read + schema-validate body
    let body: ServerAuthoredBody;
    try {
      const raw = await readBoundedJson(req, MAX_BODY_BYTES);
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
    const messageId = `srv-${body.sessionId}-t${body.turnIndex}`;
    const thinkingMessageId = `srv-${body.sessionId}-t${body.turnIndex}-thinking`;

    const hasAssistant = body.text.length > 0;
    const hasThinking =
      body.thinkingText !== undefined && body.thinkingText.length > 0;
    const hasTools = toolsCount > 0;

    // ── Write thinking first (if present) so its ts < tool ts < assistant ts ──
    type StorageResult = Awaited<
      ReturnType<ServerAuthoredStorage["appendServerAuthoredMessage"]>
    >;
    let thinkingResult: StorageResult | null = null;
    let thinkingThrew = false;
    if (hasThinking) {
      try {
        thinkingResult = await deps.storage.appendServerAuthoredMessage(
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
        thinkingThrew = true;
        userLog.error("thinking_storage_threw", {
          sessionId: body.sessionId,
          turnIndex: body.turnIndex,
          err: err as Error,
        });
      }
    }

    /** Emit the per-role thinking metric exactly once per request. Pull-out
     *  helper so all exit paths in this handler can call it consistently. */
    const emitThinkingMetric = (): void => {
      if (!hasThinking) return;
      if (thinkingThrew) {
        metric("error", "thinking");
        return;
      }
      const r = thinkingResult!;
      if (r.applied) metric("ok", "thinking");
      else if (r.reason === "already_exists") metric("deduped", "thinking");
      else if (r.reason === "session_not_found")
        metric("reject_session_missing", "thinking");
      else if (r.reason === "session_deleted")
        metric("reject_session_deleted", "thinking");
      else if (r.reason === "oversized")
        metric("reject_oversized", "thinking");
      else metric("error", "thinking"); // malformed
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
      const toolMessageId = `srv-${body.sessionId}-t${body.turnIndex}-tool-${t.blockId}`;
      const toolTs = baseTs - toolsCount + i;
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

    // ── Branch A: no-assistant path — thinking-only, tools-only, or both ──
    //
    // HTTP outcome priority:
    //   hasThinking → thinking decides HTTP, tools are best-effort.
    //   tools-only  → first tool decides HTTP, remaining tools best-effort.
    if (!hasAssistant) {
      // Schema refine guarantees hasThinking || hasTools here.
      if (hasThinking) {
        if (thinkingThrew) {
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
        const r = thinkingResult!;
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
          // thinking row would push it further. Terminal — admin must run
          // the strip-attachments script before this turn can be persisted.
          // 413 (vs 500) so the container's anthropicProxy treats it as a
          // give-up-don't-retry signal and drops the entry from its sink
          // queue rather than spinning on a row it can never write.
          userLog.warn("thinking_session_oversized", {
            sessionId: body.sessionId,
            turnIndex: body.turnIndex,
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
      // covers index 0 too — counted exactly once).
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
        userLog.warn("tools_only_session_oversized", {
          sessionId: body.sessionId,
          turnIndex: body.turnIndex,
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
    const assistantMsg: ServerAuthoredMessageInput = {
      id: messageId,
      role: "assistant",
      text: body.text,
      ts: assistantTs,
      status: body.status,
      ...(body.usage ? { usage: body.usage } : {}),
      ...(body.truncated ? { _truncated: true } : {}),
      ...(body.errorCode ? { _errorCode: body.errorCode } : {}),
      ...(body.errorDetail ? { _errorDetail: body.errorDetail } : {}),
    };
    let assistantResult: Awaited<
      ReturnType<ServerAuthoredStorage["appendServerAuthoredMessageForRequest"]>
    >;
    try {
      if (body.requestId !== undefined) {
        assistantResult = await deps.storage.appendServerAuthoredMessageForRequest(
          body.requestId,
          body.sessionId,
          userId,
          assistantMsg,
        );
      } else {
        const r = await deps.storage.appendServerAuthoredMessage(
          body.sessionId,
          userId,
          assistantMsg,
        );
        assistantResult = r.applied
          ? { applied: true }
          : { applied: false, reason: r.reason! };
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
      userLog.warn("session_oversized", {
        sessionId: body.sessionId,
        turnIndex: body.turnIndex,
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

async function readBoundedJson(
  req: IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
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
    return JSON.parse(text);
  } catch (err) {
    throw new HttpError(
      400,
      "INVALID_JSON",
      `body is not valid JSON: ${(err as Error).message}`,
    );
  }
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
