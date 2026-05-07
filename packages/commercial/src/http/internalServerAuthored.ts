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
    /** Plan §4.3 改动 6 — assistant write only. Composite key with userId
     *  into `server_authored_request_map` so a deferred `appendCostCredits`
     *  call can find this row and patch `usage.costCredits` in-place.
     *
     *  Required when text is non-empty (assistant turn). Schema-level
     *  refine below skips the requirement on thinking-only turns. */
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
  })
  .strict()
  .refine(
    (v) => v.text.length > 0 || v.thinkingText !== undefined,
    { message: "either text or thinkingText must be non-empty" },
  )
  .refine(
    // requestId is required for assistant writes (text non-empty); on
    // thinking-only turns the cost path doesn't fire and requestId is
    // unused, so we relax the requirement there.
    (v) => v.text.length === 0 || typeof v.requestId === "string",
    { message: "requestId is required when text is non-empty", path: ["requestId"] },
  );

export type ServerAuthoredBody = z.infer<typeof BodySchema>;

/** Server-authored message shape submitted to storage. Assistant writes may
 *  carry usage/_truncated/_errorCode/_errorDetail; thinking writes never do.
 *  All fields except `id`, `role`, `text`, `ts` are optional and merged into
 *  the persisted message blob as-is. */
export type ServerAuthoredMessageInput = {
  id: string;
  /** 'thinking' for Phase 0.4 reasoning persistence; 'assistant' for the
   *  user-visible turn text. Same idempotency / session_not_found semantics
   *  for both. */
  role: "assistant" | "thinking";
  text: string;
  ts: number;
  status: "completed" | "interrupted" | "crashed";
  /** Token usage from gateway-side stream finalizer. costCredits joins
   *  later via storage's `appendCostCredits` patch. */
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
};

export type ServerAuthoredStorageResult = {
  applied: boolean;
  reason?: "session_not_found" | "session_deleted" | "already_exists" | "malformed";
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
    | { applied: false; reason: "session_not_found" | "session_deleted" | "already_exists" | "malformed" }
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
    // session_deleted split):
    //   thinking-only (text empty, thinkingText present):
    //     - thinking applied         → 200 ok
    //     - thinking already_exists  → 200 idempotent
    //     - thinking session_n_f     → 404 (sink retries under TTL)
    //     - thinking session_deleted → 410 (sink fatal-drops; terminal)
    //     - thinking storage_threw   → 500 (sink retries; thinking is the
    //                                       only data so we cannot drop it)
    //     - thinking malformed       → 500 (master-side data issue)
    //   has assistant (text non-empty, thinkingText optional):
    //     - thinking write best-effort: storage_threw is logged + metric
    //       'error'/thinking but does NOT block assistant write. degrade
    //       to "thinking dropped, assistant preserved" — same body that
    //       the sink already submitted; retrying the whole turn would
    //       just hit assistant `already_exists` and re-fail thinking.
    //     - assistant outcome decides HTTP status:
    //         applied         → 200 ok
    //         already_exists  → 200 idempotent
    //         session_n_f     → 404 (retryable race)
    //         session_deleted → 410 (terminal, sink fatal-drops)
    //         storage_threw   → 500
    //         malformed       → 500
    const baseTs = body.createdAt ?? now();
    const thinkingTs = baseTs - 1;
    const assistantTs = baseTs;
    const messageId = `srv-${body.sessionId}-t${body.turnIndex}`;
    const thinkingMessageId = `srv-${body.sessionId}-t${body.turnIndex}-thinking`;

    const hasAssistant = body.text.length > 0;
    const hasThinking =
      body.thinkingText !== undefined && body.thinkingText.length > 0;

    // ── Write thinking first (if present) so its ts < assistant ts ──
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
     *  helper so all 9+ exit paths in this handler can call it consistently. */
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
      else metric("error", "thinking"); // malformed
    };

    // ── Branch A: thinking-only — HTTP status driven by thinking result ──
    if (!hasAssistant) {
      // Schema refine guarantees hasThinking here.
      if (thinkingThrew) {
        metric("error", "thinking");
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
        sendJsonOk(res, 200, { ok: true }, requestId);
        return;
      }
      if (r.reason === "already_exists") {
        metric("deduped", "thinking");
        sendJsonOk(res, 200, { ok: true, idempotent: true }, requestId);
        return;
      }
      if (r.reason === "session_not_found") {
        userLog.info("thinking_session_not_found", {
          sessionId: body.sessionId,
          turnIndex: body.turnIndex,
        });
        metric("reject_session_missing", "thinking");
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
        sendJsonError(
          res,
          410,
          "SESSION_DELETED",
          "client_sessions row is soft-deleted",
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
    // Plan §4.3 改动 6:assistant write goes through the *ForRequest variant
    // so the storage layer can drain pending costCredits + record the
    // request_map row in a single SQLite transaction. requestId is required
    // by schema refine when text is non-empty, so the `!` is sound here.
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
      assistantResult = await deps.storage.appendServerAuthoredMessageForRequest(
        body.requestId!,
        body.sessionId,
        userId,
        assistantMsg,
      );
    } catch (err) {
      userLog.error("assistant_storage_threw", {
        sessionId: body.sessionId,
        turnIndex: body.turnIndex,
        err: err as Error,
      });
      emitThinkingMetric();
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
      metric("ok", "assistant");
      sendJsonOk(res, 200, { ok: true }, requestId);
      return;
    }
    if (assistantResult.reason === "already_exists") {
      emitThinkingMetric();
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
    // 'malformed' — master row's messages JSON is corrupt. Master-side data
    // issue, not a container bug; 500 so the entry is queued for retry.
    userLog.error("master_row_malformed", {
      sessionId: body.sessionId,
      turnIndex: body.turnIndex,
    });
    emitThinkingMetric();
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
