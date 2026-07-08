/**
 * GET /api/admin/response-ratings —— v5-only 响应评分统计(超管)。
 *
 * 返回两部分,让"持续优化"真正可用:
 *   1. stats  —— 按模型的 up/down 计数与好评率 + overall / 近 7d / 近 30d 三窗口趋势。
 *   2. down_ratings —— 最近的差评明细(rating='down',带评论 / trace_id),复合游标分页,
 *      仿 admin/feedback.ts 列表。运维据此按模型 / 标签 / 评论定位待优化点,并可拿 trace_id
 *      反查该轮全链路日志。
 *
 * 鉴权:requireAdmin(与其它 admin 只读端点一致的 JWT role 校验)。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../util.js";
import { requireAdmin } from "../../admin/requireAdmin.js";
import type { CommercialHttpDeps, RequestContext } from "../handlers.js";
import { parseBigintIdParam, parseIsoTimestamp, parsePositiveInt } from "./_shared.js";
import { getResponseRatingStats, listDownRatings } from "../../responseRatings.js";

const DOWN_MAX_LIMIT = 200;

export async function handleAdminResponseRatings(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const beforeCreatedAt = parseIsoTimestamp(
    url.searchParams.get("before_created_at"),
    "before_created_at",
  );
  const beforeId = parseBigintIdParam(url.searchParams.get("before_id"), "before_id");
  const limit = parsePositiveInt(url.searchParams.get("limit"), "limit", DOWN_MAX_LIMIT);

  const [stats, down] = await Promise.all([
    getResponseRatingStats(),
    listDownRatings({
      before_created_at: beforeCreatedAt,
      before_id: beforeId,
      limit,
    }),
  ]);

  sendJson(res, 200, {
    stats,
    down_ratings: {
      rows: down.rows,
      next_before_created_at: down.next_before_created_at,
      next_before_id: down.next_before_id,
    },
  });
}
