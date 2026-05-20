/**
 * /api/admin/envelope-prefix-templates — V3 envv2 Phase 2(2026-05-21)。
 *
 * 两个端点:
 *   GET /api/admin/envelope-prefix-templates              列出三行 active
 *   PUT /api/admin/envelope-prefix-templates/:variant     in-place 替换 text
 *
 * 鉴权:GET requireAdmin;PUT requireAdminVerifyDb(同 pricing.ts 抽象 — 写操作走
 * DB-verify 而不是只信 JWT)。
 *
 * 设计要点:
 *   - PUT 后**显式** await reloadPrefixTemplateCache() 做本进程 read-your-write
 *     (Codex Phase 2 plan-review 采纳)。其它 commercial 进程靠 LISTEN/NOTIFY
 *     收敛(trigger 在 0071)。reload 失败不回滚 DB 写入也不让 client 看 500 ——
 *     DB 已写入是事实,只是本进程 cache 暂未更新,返回时附 reload_warning 让
 *     admin 看到。
 *   - 不暴露 active 切换;PR 只支持 in-place text UPDATE(plan YAGNI)。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, sendJson, readJsonBody } from "../util.js";
import { requireAdmin, requireAdminVerifyDb } from "../../admin/requireAdmin.js";
import {
  listEnvelopePrefixTemplates,
  updateEnvelopePrefixTemplate,
  isPrefixVariant,
  normalizePrefixText,
  PrefixTemplateNotFoundError,
  type EnvelopePrefixTemplateRowView,
} from "../../admin/envelopePrefixTemplates.js";
import { reloadPrefixTemplateCache } from "../../envelope/prefixTemplateCache.js";
import type { CommercialHttpDeps, RequestContext } from "../handlers.js";
import { translateRangeError } from "./_shared.js";

function serialize(r: EnvelopePrefixTemplateRowView): Record<string, unknown> {
  return {
    variant: r.variant,
    text: r.text,
    active: r.active,
    updated_at: r.updated_at.toISOString(),
    updated_by: r.updated_by,
  };
}

// ─── GET /api/admin/envelope-prefix-templates ──────────────────────

export async function handleAdminListEnvelopePrefixTemplates(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const rows = await listEnvelopePrefixTemplates();
  sendJson(res, 200, { rows: rows.map(serialize) });
}

// ─── PUT /api/admin/envelope-prefix-templates/:variant ─────────────

/**
 * 提取 URL 尾部 variant。不复用 extractTailSlug —— variant 是闭合枚举,直接 type guard,
 * 比正则更精确(新增 variant 一处改 PREFIX_VARIANTS 数组,handler 自动跟上)。
 */
function extractVariant(url: URL): string {
  const prefix = "/api/admin/envelope-prefix-templates/";
  const tail = url.pathname.slice(prefix.length);
  // 基本 sanity:长度上限 + 字符集白名单,挡明显恶意 URL
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(tail)) {
    throw new HttpError(400, "VALIDATION", "invalid variant in URL", {
      issues: [{ path: "variant", message: tail }],
    });
  }
  return tail;
}

export async function handleAdminPutEnvelopePrefixTemplate(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const variantRaw = extractVariant(url);
  if (!isPrefixVariant(variantRaw)) {
    throw new HttpError(404, "NOT_FOUND", `unknown variant: ${variantRaw}`);
  }
  const variant = variantRaw;

  const body = (await readJsonBody(req)) ?? {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "VALIDATION", "request body must be JSON object");
  }
  const b = body as Record<string, unknown>;
  if (b.text === undefined) {
    throw new HttpError(400, "VALIDATION", "text is required", {
      issues: [{ path: "text", message: "missing" }],
    });
  }
  let textNorm: string;
  try {
    textNorm = normalizePrefixText(b.text);
  } catch (err) {
    if (err instanceof RangeError) translateRangeError(err);
    throw err;
  }

  let row: EnvelopePrefixTemplateRowView;
  try {
    row = await updateEnvelopePrefixTemplate(variant, textNorm, {
      adminId: admin.id,
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
  } catch (err) {
    if (err instanceof PrefixTemplateNotFoundError) {
      throw new HttpError(404, "NOT_FOUND", err.message);
    }
    throw err;
  }

  // Read-your-write:本进程 cache 显式 reload(其它进程靠 NOTIFY 收敛)。
  // DB 已写入是不可回滚的事实;reload 失败只是本进程暂时还没看到新值,把 warning
  // 写进 response 让 admin 自查 — 不抛 500 误导 client 以为整个 PUT 失败。
  let reloadWarning: string | null = null;
  try {
    await reloadPrefixTemplateCache();
  } catch (err) {
    reloadWarning = err instanceof Error ? err.message : String(err);
  }

  sendJson(res, 200, {
    template: serialize(row),
    ...(reloadWarning !== null ? { reload_warning: reloadWarning } : {}),
  });
}
