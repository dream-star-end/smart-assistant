/**
 * POST /internal/v3/cron-index —— 容器 gateway → master 上报「派生唤醒索引」。
 *
 * 方案权威源:docs/plans/v5-cron-master-wake-2026-07-07.md §2。
 *
 * 容器在 addJob/updateJob/removeJob 后 + CronScheduler.start 后 + tick 末尾(nextFire 变化时)
 * 上报本用户所有 enabled 任务里最早的下一次触发时刻(绝对瞬时)+ enabled 任务数。master 据此
 * upsert cron_wake_index(runtime_channel=当前),cronWake scheduler 到点唤醒。
 *
 * trust boundary(同 wechat-proactive / tool-failure):
 *   - uid 严格由 verifyContainerIdentity(容器双因子)推导,**绝不从 body 取身份**。
 *   - body 只带 { nextFireAt, enabledCount },都是派生数据(可被 rescan 从卷重算校正),
 *     即便被篡改也只影响该用户自己的唤醒时刻,不跨用户、不构成第二权威。
 *
 * fire-and-forget:容器侧上报失败静默(有兜底 rescan)。个人版无 master → 该端点不部署(no-op)。
 * nextFireAt 由容器 gateway 复用 cron.ts computeNextRun 计算(单一 cron 解析器,不写第二套)。
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import {
  ContainerIdentityError,
  verifyContainerIdentity,
  type ContainerIdentityRepo,
} from "../auth/containerIdentity.js";
import { rootLogger, type Logger } from "../logging/logger.js";
import { getRuntimeChannel } from "../runtimeChannel.js";
import { upsertCronWakeIndex, type CronWakeRunner } from "../agent-sandbox/cronWake.js";
import {
  HttpError,
  REQUEST_ID_HEADER,
  ensureRequestId,
  readJsonBody,
  sendError,
  sendJson,
  setSecurityHeaders,
} from "./util.js";

export { CRON_INDEX_PATH } from "@openclaude/protocol";

const BodySchema = z
  .object({
    // 最早下一次触发(绝对 ISO 瞬时);null = 无 enabled 任务。
    nextFireAt: z.union([z.string().datetime({ offset: true }), z.null()]),
    // enabled 任务数(0 合法);上限防脏数据(cron 配额远低于此)。
    enabledCount: z.number().int().min(0).max(100_000),
  })
  .strict();

export type CronIndexBody = z.infer<typeof BodySchema>;

export interface CronIndexHandlerDeps {
  identityRepo: ContainerIdentityRepo;
  runner: CronWakeRunner;
  logger?: Logger;
}

export interface CronIndexCtx {
  hostUuid: string;
  boundIp: string;
}

export type CronIndexHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: CronIndexCtx,
) => Promise<void>;

export function makeCronIndexHandler(deps: CronIndexHandlerDeps): CronIndexHandler {
  const log = (deps.logger ?? rootLogger).child({ subsys: "internalCronIndex" });
  return async function handle(req, res, ctx) {
    setSecurityHeaders(res);
    const requestId = ensureRequestId(req);
    res.setHeader(REQUEST_ID_HEADER, requestId);

    if (req.method !== "POST") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "POST required", requestId);
      return;
    }

    // 1) 容器身份 → uid(绝不从 body 取)。
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

    // 2) body 校验(ISO 时间 / 数值)。
    let body: CronIndexBody;
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

    // 3) upsert 派生索引(runtime_channel=当前实例 channel)。
    try {
      await upsertCronWakeIndex(deps.runner, {
        userId: identity.userId,
        runtimeChannel: getRuntimeChannel(),
        nextFireAt: body.nextFireAt ? new Date(body.nextFireAt) : null,
        jobsEnabled: body.enabledCount,
      });
    } catch (err) {
      log.error("upsert_failed", {
        uid: identity.userId,
        err: err instanceof Error ? err.message : String(err),
      });
      sendError(res, 500, "INTERNAL", "failed to record cron index", requestId);
      return;
    }

    sendJson(res, 200, { ok: true }, { [REQUEST_ID_HEADER]: requestId });
  };
}
