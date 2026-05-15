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
 * 返回完整 messages 含 tool_use / tool_result blocks:
 *   - admin = boss 本人(single-admin personal platform),诊断需要完整对话脉络
 *   - storage 层 MAX_SESSION_BYTES=4MB 已经兜底体积上限,无需后端再做 sanitize
 *   - 如果未来 admin 角色扩散到多人,再加 ?include_tools=0 默认开关
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
  const s = await getClientSession(sessionId, scopedUserId);
  if (!s) throw new HttpError(404, "NOT_FOUND", "session not found");
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
      messages: s.messages,
    },
  });
}
