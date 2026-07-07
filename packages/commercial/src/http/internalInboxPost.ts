/**
 * POST /internal/v3/inbox-post —— 容器 gateway → master「离线送达兜底写站内信」。
 *
 * 方案权威源:docs/plans/v5-cron-master-wake-2026-07-07.md §5。
 *
 * 场景:cron/提醒 turn 产出后,容器 onDeliver 发现 webchat 无任何在线客户端可送(广播落空)
 * 且 deliver≠local 时,兜底调本端点把结果写进用户站内信(离线也能事后看到)。保守起步:
 * 仅「送不出」时才推,避免「送达成功还推站内信」的通知重复(boss UX 铁律)。
 *
 * trust boundary(同 wechat-proactive / cron-index):
 *   - uid 严格由 verifyContainerIdentity 推导,**绝不从 body 取身份**(不接受 user_id 字段)。
 *   - audience 硬编码 'user' + user_id=推导 uid:compromised 容器只能给自己写,不能跨用户群发。
 *
 * 防滥用:
 *   - bodyMd 截断 4096 字符;title 截断 200(createInboxMessage zod 上限)。
 *   - 每 uid 限频 maxPerMin 条/分钟(内存滑窗);超限 → HTTP 200 {ok:false,reason:'rate_limited'}
 *     打日志**不写库**(容器据此不重试,避免 outbox 噪音)。
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import {
  ContainerIdentityError,
  verifyContainerIdentity,
  type ContainerIdentityRepo,
} from "../auth/containerIdentity.js";
import { rootLogger, type Logger } from "../logging/logger.js";
import {
  HttpError,
  REQUEST_ID_HEADER,
  ensureRequestId,
  readJsonBody,
  sendError,
  sendJson,
  setSecurityHeaders,
} from "./util.js";

export const INBOX_POST_PATH = "/internal/v3/inbox-post";

/** createInboxMessage zod 上限:title ≤ 200 / body_md ≤ 16384。本端点 body 再收紧到 4096。 */
const MAX_TITLE = 200;
const MAX_BODY = 4096;
const DEFAULT_MAX_PER_MIN = 6;
const WINDOW_MS = 60_000;

const BodySchema = z
  .object({
    title: z.string().min(1),
    bodyMd: z.string().min(1),
    // 离线兜底通知恒为信息级;仅接受 'info'(缺省即 'info'),不开放 notice/promo/warning。
    level: z.literal("info").optional(),
  })
  .strict();

export type InboxPostBody = z.infer<typeof BodySchema>;

export interface InboxPostMessage {
  title: string;
  bodyMd: string;
  level: "info";
}

export interface InboxPostHandlerDeps {
  identityRepo: ContainerIdentityRepo;
  /**
   * 写站内信(audience='user', user_id=uid)。默认在 index.ts wiring 里解析 system 发件人
   * (MIN active admin,同 onboarding)后调 createInboxMessage。抛错 → handler 500。
   */
  postMessage: (userId: number, msg: InboxPostMessage) => Promise<void>;
  now?: () => number;
  maxPerMin?: number;
  logger?: Logger;
}

export interface InboxPostCtx {
  hostUuid: string;
  boundIp: string;
}

export type InboxPostHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: InboxPostCtx,
) => Promise<void>;

/** 截断到 max 字符,尾部加省略号(仅当确有截断)。 */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

export function makeInboxPostHandler(deps: InboxPostHandlerDeps): InboxPostHandler {
  const log = (deps.logger ?? rootLogger).child({ subsys: "internalInboxPost" });
  const now = deps.now ?? (() => Date.now());
  const maxPerMin = Math.max(1, deps.maxPerMin ?? DEFAULT_MAX_PER_MIN);
  /** per-uid 最近一分钟内的写入时刻(ms 滑窗)。 */
  const hits = new Map<number, number[]>();

  /** 记一次尝试;返回 true=可放行,false=超限。放行时把 now 记入窗口。 */
  function allow(uid: number): boolean {
    const t = now();
    const arr = (hits.get(uid) ?? []).filter((ts) => t - ts < WINDOW_MS);
    if (arr.length >= maxPerMin) {
      hits.set(uid, arr); // 保留剪枝后的窗口
      return false;
    }
    arr.push(t);
    hits.set(uid, arr);
    return true;
  }

  return async function handle(req, res, ctx) {
    setSecurityHeaders(res);
    const requestId = ensureRequestId(req);
    res.setHeader(REQUEST_ID_HEADER, requestId);

    if (req.method !== "POST") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "POST required", requestId);
      return;
    }

    // 1) 容器身份 → uid。
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
    const uid = identity.userId;

    // 2) body 校验。
    let body: InboxPostBody;
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

    // 3) 限频:超限 → 200 {ok:false,reason:'rate_limited'},不写库、不重试。
    if (!allow(uid)) {
      log.warn("rate_limited", { uid });
      sendJson(res, 200, { ok: false, reason: "rate_limited" }, { [REQUEST_ID_HEADER]: requestId });
      return;
    }

    // 4) 写站内信(title/body 截断)。
    try {
      await deps.postMessage(uid, {
        title: truncate(body.title, MAX_TITLE),
        bodyMd: truncate(body.bodyMd, MAX_BODY),
        level: "info",
      });
    } catch (err) {
      log.error("post_failed", {
        uid,
        err: err instanceof Error ? err.message : String(err),
      });
      sendError(res, 500, "INTERNAL", "failed to write inbox message", requestId);
      return;
    }

    sendJson(res, 200, { ok: true }, { [REQUEST_ID_HEADER]: requestId });
  };
}
