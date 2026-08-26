/**
 * POST /internal/v3/cron-origin-inject
 *
 * 容器 origin-session cron 到点：master 受理原 webchat 会话（user_id=c:{uid}），
 * 再经已 attest 的 container WS 走 durable dispatch，禁止裸 HTTP dispatchInbound。
 *
 * uid 只从 verifyContainerIdentity 推导，body 不得带 userId。
 */

import { CRON_ORIGIN_INJECT_PATH } from "@openclaude/protocol";
import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import {
  ContainerIdentityError,
  verifyContainerIdentity,
  type ContainerIdentityRepo,
} from "../auth/containerIdentity.js";
import { rootLogger, type Logger } from "../logging/logger.js";
import type {
  CronOriginInjectInput,
  CronOriginInjectResult,
} from "../ws/userChatBridge.js";
import {
  HttpError,
  REQUEST_ID_HEADER,
  ensureRequestId,
  readJsonBody,
  sendError,
  sendJson,
  setSecurityHeaders,
} from "./util.js";

export { CRON_ORIGIN_INJECT_PATH };

const BodySchema = z
  .object({
    sessionId: z.string().min(1).max(128),
    text: z.string().min(1).max(32_000),
    clientMessageId: z.string().min(1).max(128),
    agentId: z.string().min(1).max(64).default("main"),
  })
  .strict();

export type CronOriginInjectBody = z.infer<typeof BodySchema>;

export interface CronOriginInjectHandlerDeps {
  identityRepo: ContainerIdentityRepo;
  inject: (input: CronOriginInjectInput) => Promise<CronOriginInjectResult>;
  logger?: Logger;
}

export interface CronOriginInjectCtx {
  hostUuid: string;
  boundIp: string;
}

export type CronOriginInjectHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: CronOriginInjectCtx,
) => Promise<void>;

export function makeCronOriginInjectHandler(
  deps: CronOriginInjectHandlerDeps,
): CronOriginInjectHandler {
  const log = (deps.logger ?? rootLogger).child({ subsys: "internalCronOriginInject" });
  return async function handle(req, res, ctx) {
    setSecurityHeaders(res);
    const requestId = ensureRequestId(req);
    res.setHeader(REQUEST_ID_HEADER, requestId);

    if (req.method !== "POST") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "POST required", requestId);
      return;
    }

    let identity;
    try {
      identity = await verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization);
    } catch (err) {
      if (err instanceof ContainerIdentityError) {
        sendError(res, 401, "UNAUTHORIZED", "container identity verification failed", requestId);
        return;
      }
      throw err;
    }

    let body: CronOriginInjectBody;
    try {
      const parsed = BodySchema.safeParse(await readJsonBody(req));
      if (!parsed.success) {
        sendError(res, 400, "INVALID_BODY", "body schema rejected", requestId);
        return;
      }
      body = parsed.data;
    } catch (err) {
      if (err instanceof HttpError) {
        sendError(res, err.status, err.code, err.message, requestId);
        return;
      }
      throw err;
    }

    let result: CronOriginInjectResult;
    try {
      result = await deps.inject({
        uid: BigInt(identity.userId),
        sessionId: body.sessionId,
        text: body.text,
        clientMessageId: body.clientMessageId,
        agentId: body.agentId,
      });
    } catch (err) {
      log.warn("cron-origin-inject failed", {
        uid: identity.userId,
        sessionId: body.sessionId,
        err,
      });
      sendError(res, 503, "INJECT_FAILED", "origin inject failed", requestId);
      return;
    }

    if (result.kind === "injected") {
      sendJson(res, 200, { ok: true, requestId });
      return;
    }
    if (result.kind === "gone") {
      sendError(res, 404, "SESSION_GONE", "origin session missing or deleted", requestId);
      return;
    }
    if (result.kind === "in_flight") {
      sendError(res, 409, "TURN_IN_FLIGHT", "origin session has another open turn", requestId);
      return;
    }
    if (result.kind === "no_transport") {
      sendError(res, 503, "NO_TRANSPORT", "no attested container bridge", requestId);
      return;
    }
    sendError(res, 503, "INJECT_FAILED", result.reason, requestId);
  };
}
