/**
 * Host lease-worker callback. Only the loopback control listener mounts this;
 * no container bearer or browser route can authorize it.
 */
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { CronOriginInjectInput, CronOriginInjectResult } from "../ws/userChatBridge.js";
import { HttpError, ensureRequestId, readJsonBody, sendError, sendJson, setSecurityHeaders } from "./util.js";

export const LEASE_CALLBACK_PATH = "/internal/v3/lease-callback";
export const LEASE_CALLBACK_VALIDATE_PATH = LEASE_CALLBACK_PATH + "/validate";
const IdentitySchema = z.object({
  uid: z.string().regex(/^[1-9][0-9]{0,18}$/),
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  agentId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
}).strict();
const BodySchema = IdentitySchema.extend({
  clientMessageId: z.string().regex(/^lsc-[A-Za-z0-9_-]{1,100}$/),
  text: z.string().trim().min(1).max(32_000),
}).strict();

export interface LeaseCallbackDeps {
  secret?: string;
  lookupSession: (uid: string, sessionId: string) => Promise<"owned" | "gone" | "foreign">;
  inject: (input: CronOriginInjectInput) => Promise<CronOriginInjectResult>;
}

export function makeLeaseCallbackHandler(deps: LeaseCallbackDeps) {
  return async (req: IncomingMessage, res: ServerResponse, validateOnly = false): Promise<void> => {
    setSecurityHeaders(res);
    const rid = ensureRequestId(req);
    const peer = req.socket?.remoteAddress;
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer ?? "") ||
        req.headers["x-v5-egress-peer-ip"] !== undefined) {
      sendError(res, 403, "HOST_ONLY", "direct loopback control request required", rid); return;
    }
    if (req.method !== "POST") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "POST required", rid); return;
    }
    if (!deps.secret) {
      sendError(res, 503, "LEASE_SECRET_UNSET", "lease callback is not configured", rid); return;
    }
    const supplied = req.headers["x-oc-lease-secret"];
    const want = Buffer.from(deps.secret);
    const got = Buffer.from(typeof supplied === "string" ? supplied : "");
    if (!got.length || got.length !== want.length || !timingSafeEqual(got, want)) {
      sendError(res, 401, "UNAUTHORIZED", "bad lease secret", rid); return;
    }
    try {
      const raw = await readJsonBody(req, 32 * 1024);
      const parsed = (validateOnly ? IdentitySchema : BodySchema).safeParse(raw);
      if (!parsed.success) {
        sendError(res, 400, "INVALID_BODY", "body schema rejected", rid); return;
      }
      const body = parsed.data;
      const owner = await deps.lookupSession(body.uid, body.sessionId);
      if (owner === "foreign") {
        sendError(res, 403, "SESSION_OWNER_MISMATCH", "session does not belong to uid", rid); return;
      }
      if (owner === "gone") {
        sendJson(res, 200, { kind: "gone" }); return;
      }
      if (validateOnly) {
        sendJson(res, 200, { kind: "validated" }); return;
      }
      const payload = BodySchema.parse(raw);
      const result = await deps.inject({ ...payload, uid: BigInt(payload.uid) });
      // Preserve the existing durable receipt/availability semantics. HTTP
      // success alone is NOT proof of delivery; worker must inspect kind.
      sendJson(res, 200, result);
    } catch (err) {
      if (err instanceof HttpError) {
        sendError(res, err.status, err.code, err.message, rid); return;
      }
      sendError(res, 503, "LEASE_CALLBACK_FAILED", "lease callback temporarily unavailable", rid);
    }
  };
}
