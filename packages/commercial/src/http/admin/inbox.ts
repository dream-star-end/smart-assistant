/**
 * /api/admin/messages — 站内信(in-app inbox)admin 侧。
 *
 * 鉴权:
 *   GET  /api/admin/messages          → requireAdmin   (只读 JWT-only)
 *   POST /api/admin/messages          → requireAdminVerifyDb(写,DB 双校验)
 *   DELETE /api/admin/messages/:id    → requireAdminVerifyDb(写,DB 双校验)
 *
 * 审计:create / delete 成功后 best-effort writeAdminAudit
 *   action='inbox.create' / 'inbox.delete';target=`message:${id}`;
 *   before/after 含消息 snapshot(audience/title/level/user_id/expires_at)。
 *   audit 失败不阻断响应,与 accounts.ts / agent-containers.logs 同语义。
 *
 * S3 拆分自 http/admin.ts。serializer/audit-snapshot/handler 函数体逐字节等价
 * (plan §1.2 + §4.5 mechanical byte-equal gate)。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, sendJson, readJsonBody } from "../util.js";
import { requireAdmin, requireAdminVerifyDb } from "../../admin/requireAdmin.js";
import { writeAdminAudit } from "../../admin/audit.js";
import { getPool } from "../../db/index.js";
import type { CommercialHttpDeps, RequestContext } from "../handlers.js";
import {
  parsePositiveInt,
  parseNonNegativeInt,
  extractTailId,
} from "./_shared.js";

function serializeAdminInboxMessage(
  m: import("../../inbox/inbox.js").InboxMessage,
): Record<string, unknown> {
  return {
    id: m.id,
    audience: m.audience,
    user_id: m.user_id,
    title: m.title,
    body_md: m.body_md,
    level: m.level,
    created_by: m.created_by,
    created_at: m.created_at,
    expires_at: m.expires_at,
  };
}

/** audit 用的精简 snapshot —— 不写 body_md(可能 16KB)。 */
function inboxAuditSnapshot(
  m: import("../../inbox/inbox.js").InboxMessage,
): Record<string, unknown> {
  return {
    id: m.id,
    audience: m.audience,
    user_id: m.user_id,
    title: m.title,
    level: m.level,
    expires_at: m.expires_at,
    created_at: m.created_at,
  };
}

export async function handleAdminCreateInbox(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const body = (await readJsonBody(req)) ?? {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "VALIDATION", "request body must be JSON object");
  }
  const { createInboxMessage, InboxError } = await import("../../inbox/inbox.js");
  let created: import("../../inbox/inbox.js").InboxMessage;
  try {
    created = await createInboxMessage(admin.id, body);
  } catch (err) {
    if (err instanceof InboxError) {
      if (err.code === "VALIDATION") {
        // 把 zod issues 拍平成 HttpError issues({ path, message })
        const det = err.details as { issues?: Array<{ path?: unknown; message?: unknown }> } | undefined;
        const issues = (det?.issues ?? []).map((i) => ({
          path: Array.isArray(i.path) ? i.path.join(".") : String(i.path ?? ""),
          message: typeof i.message === "string" ? i.message : String(i.message ?? ""),
        }));
        throw new HttpError(400, "VALIDATION", err.message, { issues });
      }
      if (err.code === "USER_NOT_FOUND") {
        throw new HttpError(404, "USER_NOT_FOUND", err.message);
      }
    }
    throw err;
  }
  // best-effort audit
  try {
    await writeAdminAudit(getPool(), {
      adminId: admin.id,
      action: "inbox.create",
      target: `message:${created.id}`,
      before: null,
      after: inboxAuditSnapshot(created),
      ip: ctx.clientIp ?? null,
      userAgent: ctx.userAgent ?? null,
    });
  } catch { /* best-effort */ }
  sendJson(res, 201, { message: serializeAdminInboxMessage(created) });
}

export async function handleAdminListInbox(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const sp = url.searchParams;
  const limit = parsePositiveInt(sp.get("limit"), "limit", 100);
  const offset = parseNonNegativeInt(sp.get("offset"), "offset");
  const { adminListInbox } = await import("../../inbox/inbox.js");
  const r = await adminListInbox({ limit, offset });
  sendJson(res, 200, {
    messages: r.messages.map((m) => ({
      ...serializeAdminInboxMessage(m),
      read_count: m.read_count,
      recipients: m.recipients,
    })),
    total: r.total,
  });
}

export async function handleAdminDeleteInbox(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const id = extractTailId(url, "/api/admin/messages/");
  const { adminDeleteInbox, InboxError } = await import("../../inbox/inbox.js");
  let deleted: import("../../inbox/inbox.js").InboxMessage;
  try {
    deleted = await adminDeleteInbox(id);
  } catch (err) {
    if (err instanceof InboxError && err.code === "NOT_FOUND") {
      throw new HttpError(404, "NOT_FOUND", err.message);
    }
    throw err;
  }
  try {
    await writeAdminAudit(getPool(), {
      adminId: admin.id,
      action: "inbox.delete",
      target: `message:${deleted.id}`,
      before: inboxAuditSnapshot(deleted),
      after: null,
      ip: ctx.clientIp ?? null,
      userAgent: ctx.userAgent ?? null,
    });
  } catch { /* best-effort */ }
  sendJson(res, 200, { deleted: true });
}
