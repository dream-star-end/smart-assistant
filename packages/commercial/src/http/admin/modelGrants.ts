/**
 * /api/admin/users/:id/model-grants — 用户模型授权(P3-7)。
 *
 * S3 拆分自 http/admin.ts。3 handler + 2 matcher + 2 route regex,
 * 函数体 / 正则字面量逐字节等价(plan §1.2 + §4.5 mechanical byte-equal)。
 *
 * 路径分发同 /api/admin/users/:id/credits 的风格(共用 /api/admin/users/ prefix
 * 在 router.ts dispatch,这里 handler 自抽 :id 与可选 :model_id 子段)。
 * 三个动作:
 *   GET    /api/admin/users/:id/model-grants            → 列出该 user 已授权列表
 *   POST   /api/admin/users/:id/model-grants            → body { model_id } 添加
 *   DELETE /api/admin/users/:id/model-grants/:model_id  → 撤销
 *
 * 全部走 requireAdminVerifyDb(写路径 + GET 也强 DB 校验,grants 信息能间接暴露
 * 哪些用户被开通了内部模型,Read-too 走严格路线避免被降权 admin 用 24h 旧 token 偷看)。
 *
 * 内部 dispatch 耦合(plan §3.2 备注):
 *   handleAdminGetUser     → handleAdminListUserModelGrants
 *   handleAdminAdjustCredits → handleAdminAddUserModelGrant
 * users.ts 终局合并完成后(§6.2),这两条 dispatch 仍是 cross-file import,
 * 不再 ESM cycle(users → modelGrants 单向依赖)。
 *
 * 动态 import 保留:`await import("../../admin/modelGrants.js")` 走运行时
 * 解析,与原 admin.ts 内同写法等价(原文件路径 ../admin/modelGrants.js,本
 * 文件位置深一层 → 路径 substitution 加一层 ../;见 plan §4.5 path 规则)。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, sendJson, readJsonBody } from "../util.js";
import { requireAdminVerifyDb } from "../../admin/requireAdmin.js";
import type { CommercialHttpDeps, RequestContext } from "../handlers.js";

const USER_MODEL_GRANTS_LIST_RE =
  /^\/api\/admin\/users\/([1-9][0-9]{0,19})\/model-grants$/;
const USER_MODEL_GRANTS_ITEM_RE =
  /^\/api\/admin\/users\/([1-9][0-9]{0,19})\/model-grants\/([A-Za-z0-9._-]{1,64})$/;

export function matchUserModelGrantsList(url: URL): { userId: string } | null {
  const m = USER_MODEL_GRANTS_LIST_RE.exec(url.pathname);
  return m ? { userId: m[1] } : null;
}

function matchUserModelGrantsItem(url: URL): { userId: string; modelId: string } | null {
  const m = USER_MODEL_GRANTS_ITEM_RE.exec(url.pathname);
  return m ? { userId: m[1], modelId: m[2] } : null;
}

export async function handleAdminListUserModelGrants(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const m = matchUserModelGrantsList(url);
  if (!m) throw new HttpError(404, "NOT_FOUND", "endpoint not found");
  const { listGrantsForUser } = await import("../../admin/modelGrants.js");
  const rows = await listGrantsForUser(m.userId);
  sendJson(res, 200, {
    rows: rows.map((r) => ({
      user_id: r.user_id,
      model_id: r.model_id,
      granted_at: r.granted_at.toISOString(),
      granted_by: r.granted_by,
    })),
  });
}

export async function handleAdminAddUserModelGrant(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const m = matchUserModelGrantsList(url);
  if (!m) throw new HttpError(404, "NOT_FOUND", "endpoint not found");

  const body = (await readJsonBody(req)) ?? {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "VALIDATION", "request body must be JSON object");
  }
  const b = body as Record<string, unknown>;
  if (typeof b.model_id !== "string") {
    throw new HttpError(400, "VALIDATION", "model_id must be string");
  }

  const {
    addGrant,
    GrantInvalidInputError,
    GrantUserNotFoundError,
    GrantModelNotFoundError,
  } = await import("../../admin/modelGrants.js");
  try {
    const out = await addGrant(m.userId, b.model_id, {
      adminId: admin.id,
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
    sendJson(res, out.inserted ? 201 : 200, {
      inserted: out.inserted,
      grant: {
        user_id: out.row.user_id,
        model_id: out.row.model_id,
        granted_at: out.row.granted_at.toISOString(),
        granted_by: out.row.granted_by,
      },
    });
  } catch (err) {
    if (err instanceof GrantInvalidInputError) {
      throw new HttpError(400, "VALIDATION", `invalid ${err.message.replace(/^invalid_/, "")}`, {
        issues: [{ path: err.message.replace(/^invalid_/, ""), message: err.message }],
      });
    }
    if (err instanceof GrantUserNotFoundError) {
      throw new HttpError(404, "NOT_FOUND", "user not found");
    }
    if (err instanceof GrantModelNotFoundError) {
      throw new HttpError(404, "NOT_FOUND", "model not found");
    }
    throw err;
  }
}

export async function handleAdminRemoveUserModelGrant(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const m = matchUserModelGrantsItem(url);
  if (!m) throw new HttpError(404, "NOT_FOUND", "endpoint not found");

  const { removeGrant, GrantInvalidInputError } = await import(
    "../../admin/modelGrants.js"
  );
  try {
    const out = await removeGrant(m.userId, m.modelId, {
      adminId: admin.id,
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
    sendJson(res, 200, { deleted: out.deleted });
  } catch (err) {
    if (err instanceof GrantInvalidInputError) {
      throw new HttpError(400, "VALIDATION", `invalid ${err.message.replace(/^invalid_/, "")}`, {
        issues: [{ path: err.message.replace(/^invalid_/, ""), message: err.message }],
      });
    }
    throw err;
  }
}
