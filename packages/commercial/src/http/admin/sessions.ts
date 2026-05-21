/**
 * /api/admin/sessions — admin 侧只读查看用户会话内容。
 *
 * 入口: GET /api/admin/sessions/:id[?user_id=:userId]
 *
 * 鉴权:
 *   - requireAdminVerifyDb(每次 DB 复核 admin 角色)
 *   - 比普通 list 接口更严: 这个接口暴露用户完整对话内容,
 *     不能仅靠 JWT TTL 内还有效就放行 —— 万一 admin 已被降权,
 *     必须靠 DB 反查拦截
 *
 * 审计语义("3 不留痕"):
 *   - **不写 admin_audit 表** (boss 明确指示)
 *   - 仅保留 nginx access log / request_id 这类基础 trace
 *   - 不打 message 内容到 logger
 *
 * user_id scope:
 *   - 不带 ?user_id= → admin override,任何 session 都能拿
 *   - 带 ?user_id=N → cross-check sessionUserId === `c:N`,不匹配返回 404
 *     (避免前端从用户详情页点 row 却显示别人的会话,混淆)
 *   注意:URL 上 user_id 是裸 bigint(例如 ?user_id=1),内部转 `c:1` 再喂
 *   storage 层 —— commercial namespace 在 master SQLite 里始终带 c: 前缀
 *   (见 handlers.ts:1592 / internalServerAuthored.ts:400 的同款 inline 约定)。
 *   忘加前缀会让 session_id 即便对了 user_id 也永远 0 行 → 404。
 *
 * 返回 messages 含 tool_use / tool_result blocks:
 *   - admin = boss 本人(single-admin personal platform),诊断需要完整对话脉络
 *   - storage 层 MAX_SESSION_BYTES=4MB 已经兜底体积上限,无需后端再做 sanitize
 *   - 如果未来 admin 角色扩散到多人,再加 ?include_tools=0 默认开关
 *
 * Response-level 分页(?offset & ?limit):
 *   - 目的:大会话(数百条消息 + tool_result blob)一次性塞进前端会拖死浏览器
 *     渲染。前端在 modal 内分批拉,首屏 50 条 + "加载更多" 累加。
 *   - **这不是 storage-level pagination** —— SQLite client_sessions.messages 是
 *     单 JSON TEXT,DB 必然全行读;切片只发生在 handler return 前。省的是网络
 *     和前端 JSON parse + DOM,不是磁盘 IO。如果未来要真增量,需另立 message-level
 *     schema(本次不做)。
 *   - offset 默认 0,limit 默认 50。**越界直接 400**(不 silent clamp):
 *     offset ∉ [0, 100000] / limit ∉ [1, 200] 都按 VALIDATION 报错,
 *     避免 boss 调试时非法参数被悄悄替换成默认值反而难定位。
 *   - 返回里附 total_messages / offset / limit / has_more 供前端推 nextOffset。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, sendJson } from "../util.js";
import { requireAdminVerifyDb } from "../../admin/requireAdmin.js";
import type { CommercialHttpDeps, RequestContext } from "../handlers.js";
import { getClientSession } from "@openclaude/storage";
import { parseBigintIdParam } from "./_shared.js";

// session id 在 client_sessions 表是 TEXT PRIMARY KEY,
// 实际格式有 UUID / web-... / nanoid 等,统一收口为字母数字 + '-_',
// 1..128 字符。bigint extractTailId 不适用。
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function parseSessionIdFromUrl(url: URL): string {
  const tail = url.pathname.slice("/api/admin/sessions/".length);
  if (!SESSION_ID_RE.test(tail)) {
    throw new HttpError(400, "VALIDATION", "invalid session id in URL", {
      issues: [{ path: "id", message: tail }],
    });
  }
  return tail;
}

/** offset / limit 解析,失败抛 400 VALIDATION。 */
function parsePagingParams(url: URL): { offset: number; limit: number } {
  const offRaw = url.searchParams.get("offset");
  const limRaw = url.searchParams.get("limit");
  let offset = 0;
  let limit = 50;
  if (offRaw != null) {
    const n = Number(offRaw);
    if (!Number.isInteger(n) || n < 0 || n > 100_000) {
      throw new HttpError(400, "VALIDATION", "offset must be integer in [0, 100000]", {
        issues: [{ path: "offset", message: offRaw }],
      });
    }
    offset = n;
  }
  if (limRaw != null) {
    const n = Number(limRaw);
    if (!Number.isInteger(n) || n < 1 || n > 200) {
      throw new HttpError(400, "VALIDATION", "limit must be integer in [1, 200]", {
        issues: [{ path: "limit", message: limRaw }],
      });
    }
    limit = n;
  }
  return { offset, limit };
}

export async function handleAdminGetSession(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const sessionId = parseSessionIdFromUrl(url);
  // 可选 user_id scope —— 带就走 cross-check 路径(避免点 A 用户行看到 B 用户 session)。
  // 注意 namespace:URL 接收裸 bigint,内部拼 `c:${id}` 喂 storage(避免 `c:undefined`,
  // 不带 user_id 仍走 admin override = getClientSession 的 userId 形参 undefined 分支)。
  const userId = parseBigintIdParam(url.searchParams.get("user_id"), "user_id");
  const scopedUserId = userId ? `c:${userId}` : undefined;
  const { offset, limit } = parsePagingParams(url);
  const s = await getClientSession(sessionId, scopedUserId);
  if (!s) throw new HttpError(404, "NOT_FOUND", "session not found");
  // Response-level slicing —— storage 层已全读,这里只控网络/前端体积。
  const allMessages = Array.isArray(s.messages) ? s.messages : [];
  const total = allMessages.length;
  // offset >= total 时返回空数组 + has_more=false,不报错(前端"加载更多"竞争 + 临界 50 等场景需要友好兜底)
  const slice = offset >= total ? [] : allMessages.slice(offset, offset + limit);
  const has_more = offset + slice.length < total;
  sendJson(res, 200, {
    session: {
      id: s.id,
      user_id: s.userId,
      agent_id: s.agentId,
      title: s.title,
      pinned: s.pinned,
      created_at: s.createdAt,
      last_at: s.lastAt,
      updated_at: s.updatedAt,
      messages: slice,
      total_messages: total,
      offset,
      limit,
      has_more,
    },
  });
}
