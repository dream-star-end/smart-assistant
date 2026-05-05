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
 * 404 semantics:
 *   When master has no row for (sessionId, userId), we return HTTP 404 with
 *   body `{ error: 'session_not_found' }`. Container side classifies this as
 *   `session_missing` and retries under a TTL — the frontend's debounced PUT
 *   may still be in flight when the first turn-end arrives, especially when
 *   a backgrounded tab wakes up. Eventually the PUT lands and the next retry
 *   succeeds; if it hasn't landed by the TTL expiry the entry is dropped.
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
} from "../admin/metrics.js";

/** Master persists assistant messages no larger than this. Conservative — a
 *  single chat turn rarely exceeds 64 KB; cap at 256 KB to leave headroom for
 *  unusually long codex outputs without enabling DoS-by-body. */
const MAX_BODY_BYTES = 256 * 1024;

/** Path the container's V3MasterSink POSTs to. Mounted on both the plain
 *  self-host listener and the mTLS remote-host listener. */
export const SERVER_AUTHORED_PATH = "/internal/v3/server-authored-message";

/** Request body — strict, unknown keys rejected. peerId / userId / id are NOT
 *  accepted from the wire to keep the trust boundary tight. */
const BodySchema = z
  .object({
    sessionId: z.string().min(8).max(50),
    turnIndex: z.number().int().min(0),
    status: z.enum(["completed", "interrupted", "crashed"]),
    text: z.string().max(MAX_BODY_BYTES),
    createdAt: z.number().int().positive().optional(),
  })
  .strict();

export type ServerAuthoredBody = z.infer<typeof BodySchema>;

/** Storage interface — narrowed to just the call we need so unit tests can
 *  inject a memory implementation. Real wiring uses
 *  `appendServerAuthoredMessage` from `@openclaude/storage`. */
export interface ServerAuthoredStorage {
  appendServerAuthoredMessage(
    sessId: string,
    userId: string,
    message: {
      id: string;
      role: "assistant";
      text: string;
      ts: number;
      status: "completed" | "interrupted" | "crashed";
    },
  ): Promise<{
    applied: boolean;
    reason?: "session_not_found" | "already_exists" | "malformed";
  }>;
}

export interface ServerAuthoredHandlerDeps {
  identityRepo: ContainerIdentityRepo;
  storage: ServerAuthoredStorage;
  logger?: Logger;
  /** Override only for tests; real callers use Date.now via default. */
  now?: () => number;
  /** Override only for tests so unit tests can assert metric outcome without
   *  touching the module-level Counter state. Real callers omit; default
   *  bridges to {@link incrV3SinkPersist}. */
  metric?: (outcome: V3SinkPersistOutcome) => void;
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
    const messageId = `srv-${body.sessionId}-t${body.turnIndex}`;
    const ts = body.createdAt ?? now();
    let result: Awaited<
      ReturnType<ServerAuthoredStorage["appendServerAuthoredMessage"]>
    >;
    try {
      result = await deps.storage.appendServerAuthoredMessage(
        body.sessionId,
        userId,
        {
          id: messageId,
          role: "assistant",
          text: body.text,
          ts,
          status: body.status,
        },
      );
    } catch (err) {
      // Storage layer threw — likely disk-full / SQLITE_BUSY / corruption.
      // Returning 5xx makes the container queue this for retry, which is
      // exactly what we want.
      userLog.error("storage_threw", {
        sessionId: body.sessionId,
        turnIndex: body.turnIndex,
        err: err as Error,
      });
      metric("error");
      sendJsonError(res, 500, "STORAGE_ERROR", "storage write failed", requestId);
      return;
    }

    if (result.applied) {
      metric("ok");
      sendJsonOk(res, 200, { ok: true }, requestId);
      return;
    }
    if (result.reason === "already_exists") {
      // Idempotent retry — first call succeeded, this one is a no-op. Return
      // 200 so the sender drops the entry from its queue.
      metric("deduped");
      sendJsonOk(res, 200, { ok: true, idempotent: true }, requestId);
      return;
    }
    if (result.reason === "session_not_found") {
      // Retryable on container side under TTL — not a permanent drop.
      userLog.info("session_not_found", {
        sessionId: body.sessionId,
        turnIndex: body.turnIndex,
      });
      metric("reject_session_missing");
      sendJsonError(
        res,
        404,
        "SESSION_NOT_FOUND",
        "no client_sessions row for sessionId+userId",
        requestId,
      );
      return;
    }
    // 'malformed' — master row's messages JSON is corrupt. This is a master-
    // side data issue, not a container bug; surface as 500 so the entry is
    // queued for retry (in case this is transient parser misbehavior; if it
    // persists, the entry will TTL out and ops will see it in the metrics).
    userLog.error("master_row_malformed", {
      sessionId: body.sessionId,
      turnIndex: body.turnIndex,
    });
    metric("error");
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
