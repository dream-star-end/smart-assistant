/**
 * T-54 - GET /api/admin/agent-audit
 *
 * 超管查 agent_audit。非 admin → 403。
 *
 * Query 参数:
 *   - user_id: 可选,过滤用户
 *   - tool:    可选,过滤工具名
 *   - before:  可选,keyset 游标
 *   - limit:   可选,1..200,默认 50
 *
 * 响应:
 *   {
 *     rows: [...],
 *     next_before: "123" | null
 *   }
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, sendJson } from "./util.js";
import { requireAdmin } from "../admin/requireAdmin.js";
import {
  listAgentAudit,
  AGENT_AUDIT_MAX_LIMIT,
  type AgentAuditRowView,
} from "../admin/agentAudit.js";
import type { CommercialHttpDeps, RequestContext } from "./handlers.js";

function parseLimit(raw: string | null): number | undefined {
  if (raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > AGENT_AUDIT_MAX_LIMIT) {
    throw new HttpError(400, "VALIDATION", `limit must be 1..${AGENT_AUDIT_MAX_LIMIT}`, {
      issues: [{ path: "limit", message: raw }],
    });
  }
  return n;
}

function serializeRow(r: AgentAuditRowView): Record<string, unknown> {
  return {
    id: r.id,
    user_id: r.user_id,
    session_id: r.session_id,
    tool: r.tool,
    input_meta: r.input_meta,
    input_hash: r.input_hash,
    output_hash: r.output_hash,
    duration_ms: r.duration_ms,
    success: r.success,
    error_msg: r.error_msg,
    created_at: r.created_at.toISOString(),
  };
}

export async function handleAdminAgentAudit(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const sp = url.searchParams;
  const userIdRaw = sp.get("user_id");
  const toolRaw = sp.get("tool");
  const beforeRaw = sp.get("before");
  const limit = parseLimit(sp.get("limit"));

  let result;
  try {
    result = await listAgentAudit({
      userId: userIdRaw === null || userIdRaw === "" ? undefined : userIdRaw,
      tool: toolRaw === null || toolRaw === "" ? undefined : toolRaw,
      before: beforeRaw === null || beforeRaw === "" ? undefined : beforeRaw,
      limit,
    });
  } catch (err) {
    if (err instanceof RangeError) {
      // listAgentAudit 的 invalid_xxx 一律 400
      const path = err.message.replace(/^invalid_/, "");
      throw new HttpError(400, "VALIDATION", `invalid ${path}`, {
        issues: [{ path, message: sp.get(path) ?? "" }],
      });
    }
    throw err;
  }

  sendJson(res, 200, {
    rows: result.rows.map(serializeRow),
    next_before: result.next_before,
  });
}
