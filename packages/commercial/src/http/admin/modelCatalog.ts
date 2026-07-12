/**
 * /api/admin/model-catalog —— 模型 catalog 状态机 admin 入口(方案 §7 步 5)。
 *
 *   GET    /api/admin/model-catalog                 列表(staged/active/disabled/retired + alias + 有无价格行)
 *   POST   /api/admin/model-catalog                 建 staged 行
 *   POST   /api/admin/model-catalog/switch          版本切换(fn_model_switch_version 单事务)
 *   POST   /api/admin/model-catalog/:id/activate    staged|disabled → active(服务端四条语义校验)
 *   POST   /api/admin/model-catalog/:id/disable     active → disabled
 *
 * 鉴权:**全部** requireAdminVerifyDb(读也验:catalog 泄露 provider 归属与上游模型名,
 * 且这是安全权威表;与 pricing.ts 的"读 requireAdmin / 写 requireAdminVerifyDb"分层不同 ——
 * 这里连读都按写档处理,因为列表本身就是攻击面测绘)。
 * 并发:lock_version 乐观锁(不符 → 409)。审计:全部同事务 tx 档(auditActions.ts 已登记)。
 *
 * 路由形态:exact `/api/admin/model-catalog`(GET/POST)+ prefix `/api/admin/model-catalog/`
 * (POST,handler 内按尾段派发 switch / :id/activate / :id/disable)。router.ts 的 matchRoute
 * 是 exact-first,故 exact 与 prefix 不互相吞噬。
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { HttpError, readJsonBody, sendJson } from "../util.js";
import { requireAdminVerifyDb } from "../../admin/requireAdmin.js";
import {
  CatalogConflictError,
  CatalogNotFoundError,
  CatalogValidationError,
  activateEntry,
  createStaged,
  disableEntry,
  listCatalog,
  switchVersion,
} from "../../admin/modelCatalogOps.js";
import type { CommercialHttpDeps, RequestContext } from "../handlers.js";
import { translateRangeError } from "./_shared.js";

/**
 * ops 层错误 → HTTP 错误(单一映射点:新增 ops 错误类型必须在这里显式落位)。
 *
 * **0135 trigger 的拒绝也要落位**:状态机/唯一索引是 DB 强制的(应用层校验只是前置的
 * 好错误信息),真正的并发竞态一定是被 DB 拦下的 —— 那些 PG 错误码必须翻成 409/422,
 * 而不是 500(500 = "服务器坏了",会误导运维去查 master,而其实是"你和别人抢同一行")。
 */
const PG_STATE_MACHINE_CODES: Record<string, string> = {
  "23505": "该 model 已有 live 行(staged/active 唯一)——先激活或退役它",
  "23514": "0135 状态机拒绝(非法状态转移 / active 行 execution 字段不可变 / retired 终态)",
  "23503": "0135 引用约束拒绝(被 alias 引用的行禁退休 / 无 live 行可切换)",
  // 0135 的 enabled 镜像是**双向 trigger**:catalog 写会回写 model_pricing,而 pricing 写
  // 会路由回 catalog —— 两个 admin 写并发时锁序相反,PG 可能判死锁。它是可重试的并发冲突,
  // 不是服务器故障:翻 409 让 admin 重试(500 会把人误导去查 master)。
  "40P01": "与另一处 admin 写(pricing / catalog)抢同一模型行,PG 判定死锁 —— 直接重试",
};

function translateCatalogError(err: unknown): never {
  if (err instanceof CatalogNotFoundError) throw new HttpError(404, "NOT_FOUND", err.message);
  if (err instanceof CatalogConflictError) throw new HttpError(409, "CONFLICT", err.message);
  if (err instanceof CatalogValidationError) {
    throw new HttpError(422, "CATALOG_VALIDATION", err.message, {
      issues: err.violations.map((v) => ({ path: "catalog", message: v })),
    });
  }
  if (err instanceof RangeError) translateRangeError(err);
  const code = (err as { code?: unknown })?.code;
  if (typeof code === "string" && PG_STATE_MACHINE_CODES[code]) {
    const detail = (err as { message?: string }).message ?? "";
    throw new HttpError(409, "CONFLICT", `${PG_STATE_MACHINE_CODES[code]}${detail ? `: ${detail}` : ""}`);
  }
  throw err;
}

function bodyObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new HttpError(400, "VALIDATION", "request body must be JSON object");
  }
  return raw as Record<string, unknown>;
}

/** lock_version 必传(乐观并发):缺失 = 客户端没读过当前状态,直接拒。 */
function requireLockVersion(b: Record<string, unknown>): number {
  const lv = b.lock_version;
  if (typeof lv !== "number" || !Number.isInteger(lv) || lv < 0) {
    throw new HttpError(400, "VALIDATION", "lock_version (integer) is required", {
      issues: [{ path: "lock_version", message: String(lv) }],
    });
  }
  return lv;
}

const ENTRY_ID_RE = /^[1-9][0-9]{0,18}$/;

// ─── GET /api/admin/model-catalog ────────────────────────────────────────────

export async function handleAdminListModelCatalog(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdminVerifyDb(req, deps.jwtSecret);
  sendJson(res, 200, await listCatalog());
}

// ─── POST /api/admin/model-catalog(建 staged)────────────────────────────────

export async function handleAdminCreateModelCatalogEntry(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const body = bodyObject(await readJsonBody(req));
  try {
    const out = await createStaged(body, {
      adminId: admin.id,
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
    sendJson(res, 201, { entry_id: out.entry_id, state: "staged" });
  } catch (err) {
    translateCatalogError(err);
  }
}

// ─── POST /api/admin/model-catalog/{switch,:id/activate,:id/disable} ─────────

const PREFIX = "/api/admin/model-catalog/";

export async function handleAdminModelCatalogAction(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const tail = url.pathname.slice(PREFIX.length);
  const body = bodyObject(await readJsonBody(req));
  const opsCtx = { adminId: admin.id, ip: ctx.clientIp, userAgent: ctx.userAgent };

  try {
    if (tail === "switch") {
      const out = await switchVersion(body, requireLockVersion(body), opsCtx);
      sendJson(res, 200, { entry_id: out.entry_id });
      return;
    }
    const m = /^([0-9]+)\/(activate|disable)$/.exec(tail);
    if (!m || !ENTRY_ID_RE.test(m[1]!)) {
      throw new HttpError(404, "NOT_FOUND", "unknown model-catalog action");
    }
    const [, entryId, action] = m as unknown as [string, string, "activate" | "disable"];
    const lockVersion = requireLockVersion(body);
    if (action === "activate") {
      await activateEntry(entryId, lockVersion, opsCtx);
    } else {
      await disableEntry(entryId, lockVersion, opsCtx);
    }
    sendJson(res, 200, { entry_id: entryId, state: action === "activate" ? "active" : "disabled" });
  } catch (err) {
    translateCatalogError(err);
  }
}
