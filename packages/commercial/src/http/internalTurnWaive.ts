/**
 * Authenticated exact-turn waiver compatibility endpoint.
 *
 * The primary path carries `waiveReason` on the fsynced lossless turn tape so
 * terminal persistence, billing fence, refund and inbox receipt cannot drift.
 * This endpoint remains for rolling containers and audited repair operations.
 * Old `(engineSessionId,sinceTs)` reports are first resolved to one freshly
 * finalized timeout tape; refunds still use the same exact `(userId,turnKey)`
 * core and never debit/reverse a time window.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { LOSSLESS_TURN_TAPE_SHA256_RE, type TurnWaiveReason } from "@openclaude/protocol";
import type { Pool } from "pg";

import {
  ContainerIdentityError,
  type ContainerIdentityRepo,
  verifyContainerIdentity,
} from "../auth/containerIdentity.js";
import { applyTurnWaiver, ensurePendingTurnWaiver } from "../billing/refund.js";
import { type Logger, rootLogger } from "../logging/logger.js";
import { REQUEST_ID_HEADER, ensureRequestId, isObj, setSecurityHeaders } from "./util.js";

export const TURN_WAIVE_PATH = "/internal/v3/turn-waive";

const MAX_BODY_BYTES = 2 * 1024;
const LEGACY_MAX_WINDOW_AGE_MS = 24 * 60 * 60 * 1000;
const LEGACY_MAX_CLOCK_SKEW_MS = 60 * 1000;
const LEGACY_TERMINAL_LOOKBACK_MS = 5 * 60 * 1000;
const LEGACY_MAX_CANDIDATES = 8;
const LEGACY_MAX_TAPE_BYTES = 16 * 1024 * 1024;
const LEGACY_SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const WAIVE_REASONS = new Set<TurnWaiveReason>([
  "idle_timeout",
  "no_response",
  "platform_authority_expired",
  "turn_limit",
]);

type LegacyTapeCandidate = {
  turn_key: string;
  engine_billings: unknown;
  agent_session_id: string | null;
};

function billingCarriesEngineSession(value: unknown, engineSessionId: string): boolean {
  return Array.isArray(value) && value.some(
    (item) => isObj(item) && item.engineSessionId === engineSessionId,
  );
}

/** Resolve the old `(engine session,sinceTs)` report to one immutable tape.
 * This is rolling-deploy compatibility only: it never refunds a time window.
 * Candidate tapes must be freshly finalized timeout errors for this user and
 * carry the exact engine session either in durable billing or canonical tape. */
export async function resolveLegacyWaiverTurnKey(
  pool: Pool,
  input: {
    userId: bigint;
    engineSessionId: string;
    sinceMs: number;
    reason: "idle_timeout" | "no_response";
    nowMs?: number;
  },
): Promise<string | null> {
  const nowMs = input.nowMs ?? Date.now();
  const errorCodes = input.reason === "idle_timeout"
    ? ["LIVENESS_TIMEOUT", "IDLE_TIMEOUT"]
    : ["NO_RESPONSE", "PHANTOM_TURN"];
  const lowerBound = Math.max(input.sinceMs, nowMs - LEGACY_TERMINAL_LOOKBACK_MS);
  const candidates = await pool.query<LegacyTapeCandidate>(
    `SELECT t.turn_key,t.engine_billings,
            CASE WHEN t.total_bytes <= $6 THEN (
              SELECT convert_from(
                       string_agg(p.payload,''::bytea ORDER BY p.part_index),
                       'UTF8'
                     )::jsonb->>'agentSessionId'
                FROM client_session_turn_tape_parts p
               WHERE p.session_id=t.session_id AND p.user_id=t.user_id AND p.tape_id=t.tape_id
            ) ELSE NULL END AS agent_session_id
       FROM client_session_turn_tapes t
      WHERE t.user_id=$1 AND t.finalized_at IS NOT NULL
        AND t.status IN ('interrupted','crashed')
        AND t.created_at BETWEEN $2 AND $3
        AND EXISTS (
          SELECT 1 FROM client_session_turn_tape_records r
           WHERE r.session_id=t.session_id AND r.user_id=t.user_id AND r.tape_id=t.tape_id
             AND r.role='assistant'
             AND convert_from(r.payload,'UTF8')::jsonb->>'_errorCode'=ANY($4::text[])
        )
      ORDER BY t.created_at DESC,t.tape_id DESC
      LIMIT $5`,
    [
      `c:${input.userId.toString()}`,
      lowerBound,
      nowMs + LEGACY_MAX_CLOCK_SKEW_MS,
      errorCodes,
      LEGACY_MAX_CANDIDATES,
      LEGACY_MAX_TAPE_BYTES,
    ],
  );
  for (const candidate of candidates.rows) {
    if (!LOSSLESS_TURN_TAPE_SHA256_RE.test(candidate.turn_key)) continue;
    if (billingCarriesEngineSession(candidate.engine_billings, input.engineSessionId)) {
      return candidate.turn_key;
    }
    if (candidate.agent_session_id === input.engineSessionId) return candidate.turn_key;
  }
  return null;
}

export interface TurnWaiveHandlerDeps {
  identityRepo: ContainerIdentityRepo;
  pgPool: Pool;
  /** Live projection only; refund and targeted inbox are already committed. */
  broadcastToUser?: (uid: bigint, payload: Record<string, unknown>) => void;
  logger?: Logger;
}

export interface TurnWaiveHandlerCtx {
  hostUuid: string;
  boundIp: string;
}

export type TurnWaiveHandler = (req: IncomingMessage, res: ServerResponse, ctx: TurnWaiveHandlerCtx) => Promise<void>;

export function makeTurnWaiveHandler(deps: TurnWaiveHandlerDeps): TurnWaiveHandler {
  const log = (deps.logger ?? rootLogger).child({ subsys: "internalTurnWaive" });

  return async function handle(req, res, ctx) {
    setSecurityHeaders(res);
    const requestId = ensureRequestId(req);
    res.setHeader(REQUEST_ID_HEADER, requestId);
    const reqLog = log.child({ requestId, hostUuid: ctx.hostUuid, boundIp: ctx.boundIp });

    if (req.method !== "POST") {
      sendJson(res, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "POST required" } });
      return;
    }

    let userId: bigint;
    try {
      const identity = await verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization);
      userId = BigInt(identity.userId);
    } catch (err) {
      if (err instanceof ContainerIdentityError) {
        reqLog.warn("identity_failed", { errcode: err.code });
        sendJson(res, 401, {
          error: { code: "UNAUTHORIZED", message: "container identity verification failed" },
        });
        return;
      }
      throw err;
    }

    let body: unknown;
    try {
      body = await readBoundedJson(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, 400, { error: { code: "INVALID_BODY", message: (err as Error).message } });
      return;
    }
    if (!isObj(body)) {
      sendJson(res, 400, { error: { code: "INVALID_BODY", message: "object body required" } });
      return;
    }
    const reason = body.reason;
    const sessionId = body.sessionId;
    if (typeof reason !== "string" || !WAIVE_REASONS.has(reason as TurnWaiveReason)) {
      sendJson(res, 400, { error: { code: "INVALID_BODY", message: "reason not allowed" } });
      return;
    }
    if (sessionId !== undefined && (typeof sessionId !== "string" || !LEGACY_SESSION_ID_RE.test(sessionId))) {
      sendJson(res, 400, { error: { code: "INVALID_BODY", message: "sessionId malformed" } });
      return;
    }

    const waiveReason = reason as TurnWaiveReason;
    let turnKey: string;
    let legacyResolved = false;
    if (body.turnKey !== undefined) {
      if (typeof body.turnKey !== "string" || !LOSSLESS_TURN_TAPE_SHA256_RE.test(body.turnKey)) {
        sendJson(res, 400, { error: { code: "INVALID_BODY", message: "turnKey malformed" } });
        return;
      }
      turnKey = body.turnKey;
    } else {
      const sinceTs = body.sinceTs;
      if (
        typeof sessionId !== "string" ||
        typeof sinceTs !== "number" ||
        !Number.isFinite(sinceTs) ||
        (waiveReason !== "idle_timeout" && waiveReason !== "no_response")
      ) {
        sendJson(res, 400, { error: { code: "INVALID_BODY", message: "legacy waive report malformed" } });
        return;
      }
      const now = Date.now();
      if (sinceTs < now - LEGACY_MAX_WINDOW_AGE_MS || sinceTs > now + LEGACY_MAX_CLOCK_SKEW_MS) {
        sendJson(res, 400, { error: { code: "WINDOW_OUT_OF_RANGE", message: "sinceTs outside allowed window" } });
        return;
      }
      try {
        const resolved = await resolveLegacyWaiverTurnKey(deps.pgPool, {
          userId,
          engineSessionId: sessionId,
          sinceMs: sinceTs,
          reason: waiveReason,
          nowMs: now,
        });
        if (!resolved) {
          sendJson(res, 503, {
            error: { code: "LEGACY_TURN_NOT_READY", message: "exact timeout tape not ready; retry" },
          });
          return;
        }
        turnKey = resolved;
        legacyResolved = true;
      } catch (err) {
        reqLog.warn("legacy_turn_waive_resolve_failed", { err: err as Error, sessionId });
        sendJson(res, 503, {
          error: { code: "LEGACY_TURN_NOT_READY", message: "exact timeout tape not ready; retry" },
        });
        return;
      }
    }
    try {
      // Commit the settlement fence first. `applyTurnWaiver` repeats this
      // idempotently and then atomically performs refund + inbox receipt.
      await ensurePendingTurnWaiver(deps.pgPool, { userId, turnKey, reason: waiveReason });
      const result = await applyTurnWaiver(deps.pgPool, {
        userId,
        turnKey,
        reason: waiveReason,
        logger: reqLog,
      });
      if (result.newlyApplied) {
        try {
          deps.broadcastToUser?.(userId, {
            type: "outbound.cost_waived",
            ...(typeof sessionId === "string" ? { sessionId } : {}),
            turnKey,
            refundedCredits: result.refundedCredits.toString(),
            balanceAfter: result.totalAfter === null ? null : result.totalAfter.toString(),
            reason: waiveReason,
            inboxMessageId: result.inboxMessageId,
          });
        } catch (err) {
          reqLog.warn("turn_waive_broadcast_failed", { err: err as Error, turnKey });
        }
      }
      reqLog.info("turn_waive_handled", {
        userId: userId.toString(),
        turnKey,
        reason: waiveReason,
        refundedCredits: result.refundedCredits.toString(),
        recordCount: result.recordCount,
        inboxMessageId: result.inboxMessageId,
        legacyResolved,
      });
      sendJson(res, 200, {
        ok: true,
        refundedCredits: result.refundedCredits.toString(),
        recordCount: result.recordCount,
        inboxMessageId: result.inboxMessageId,
      });
    } catch (err) {
      reqLog.error("turn_waive_failed", { err: err as Error, turnKey });
      sendJson(res, 503, {
        error: { code: "TURN_WAIVER_PENDING", message: "exact refund and receipt pending" },
      });
    }
  };
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function readBoundedJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = chunk instanceof Buffer ? chunk : Buffer.from(chunk as string);
    total += bytes.length;
    if (total > maxBytes) throw new Error(`body exceeds ${maxBytes} bytes`);
    chunks.push(bytes);
  }
  if (total === 0) throw new Error("empty body");
  return JSON.parse(Buffer.concat(chunks, total).toString("utf-8"));
}
