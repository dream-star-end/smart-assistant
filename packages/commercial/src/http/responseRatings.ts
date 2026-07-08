/**
 * /api/response-rating —— v5-only 每条响应满意度评分(用户侧)。
 *
 *   POST /api/response-rating          → upsert 一条评分(👍/👎 + 可选标签 + 可选评论)
 *   GET  /api/response-rating?sessionId → 回读该用户在该会话下所有评分(前端"已评状态"恢复)
 *
 * 设计:
 *   - **必须登录**(与 feedback / client-errors 的"匿名也收"不同):评分要按 user 去重
 *     (UNIQUE(user_id, message_id))且要能回读用户自己的已评状态,匿名无 upsert 主体。
 *     故走 requireAuth —— 未登录 / token 失效直接 401。
 *   - 限流:responseRating(60/min/user)。比 feedback(5/min)宽 —— 评分是逐条响应的高频
 *     信号,用户可能快速给多条打分或反复 toggle;按 user 维度(非 IP)精确到人。
 *   - 所有字符串字段硬上限截断(语义无损),不因超长而拒;唯 messageId 非空、rating 白名单
 *     才硬拒(它们是 upsert 主键 / 业务必填)。comment **无最小长度**(轻量信号)。
 *
 * 语义边界:这不是 feedback(自由文本问题上报);详见迁移 0121 头注释。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, readJsonBody, sendJson } from "./util.js";
import { requireAuth } from "./auth.js";
import {
  DEFAULT_RATE_LIMITS,
  enforceRateLimit,
  type CommercialHttpDeps,
  type RequestContext,
} from "./handlers.js";
import { listSessionRatings, upsertResponseRating } from "../responseRatings.js";

const RATING_VALUES = new Set(["up", "down"]);
const MAX_MESSAGE_ID = 256;
const MAX_SESSION_ID = 128;
const MAX_TRACE_ID = 128;
const MAX_MODEL = 128;
const MAX_TAGS = 8;
const MAX_TAG_LEN = 32;
const MAX_COMMENT = 500;

/** 截断而不抛错:超长语义无损,截断后照常入库。空串 / 非字符串 → null。 */
function clampStr(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  return t.length <= max ? t : t.slice(0, max);
}

/** 归一化 tags:去空、去重、逐个截断 ≤32 字符、最多 8 个。非数组 → 空数组。 */
function normalizeTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (typeof raw !== "string") continue;
    const t = raw.trim();
    if (!t) continue;
    const clamped = t.length <= MAX_TAG_LEN ? t : t.slice(0, MAX_TAG_LEN);
    if (seen.has(clamped)) continue;
    seen.add(clamped);
    out.push(clamped);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

// ─── POST /api/response-rating ──────────────────────────────────────

export async function handlePostResponseRating(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  // 未登录 / token 失效 → 401(requireAuth 内抛)。
  const user = await requireAuth(req, deps.jwtSecret);

  const cfg = deps.rateLimits?.responseRating ?? DEFAULT_RATE_LIMITS.responseRating;
  await enforceRateLimit(deps, cfg, `u:${user.id}`);

  const body = (await readJsonBody(req)) as Record<string, unknown> | undefined;
  if (!body || typeof body !== "object") {
    throw new HttpError(400, "VALIDATION", "invalid body");
  }

  const rating = typeof body.rating === "string" ? body.rating : "";
  if (!RATING_VALUES.has(rating)) {
    throw new HttpError(400, "VALIDATION", "rating must be 'up' or 'down'", {
      issues: [{ path: "rating", message: String(body.rating) }],
    });
  }

  const messageIdRaw = typeof body.messageId === "string" ? body.messageId.trim() : "";
  if (!messageIdRaw) {
    throw new HttpError(400, "VALIDATION", "messageId is required", {
      issues: [{ path: "messageId", message: "empty" }],
    });
  }
  const messageId = messageIdRaw.slice(0, MAX_MESSAGE_ID);

  await upsertResponseRating({
    userId: user.id,
    sessionId: clampStr(body.sessionId, MAX_SESSION_ID),
    messageId,
    traceId: clampStr(body.traceId, MAX_TRACE_ID),
    model: clampStr(body.model, MAX_MODEL),
    rating: rating as "up" | "down",
    tags: normalizeTags(body.tags),
    comment: clampStr(body.comment, MAX_COMMENT),
  });

  // 不记 comment(可能含敏感上下文);仅关联 user + rating + model + 标签数量。
  ctx.log.info("response_rating_submitted", {
    user_id: user.id,
    rating,
    model: clampStr(body.model, MAX_MODEL),
  });
  sendJson(res, 200, { ok: true });
}

// ─── GET /api/response-rating?sessionId=XXX ─────────────────────────

export async function handleGetResponseRatings(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const sessionIdRaw = url.searchParams.get("sessionId");
  const sessionId = sessionIdRaw ? sessionIdRaw.trim() : "";
  // 无 sessionId(会话尚未物化)→ 返回空表,前端无已评状态可恢复,不视作错误。
  if (!sessionId) {
    sendJson(res, 200, { ratings: {} });
    return;
  }

  const ratings = await listSessionRatings(user.id, sessionId.slice(0, MAX_SESSION_ID));
  sendJson(res, 200, { ratings });
}
