/**
 * /api/admin/settings — system_settings(超管运行时开关)。
 *
 * S3 拆分自 http/admin.ts。handler 函数体逐字节等价,只允许 import
 * 路径变化(plan §1.2 + §4.5 git diff 人工 review)。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, sendJson, readJsonBody } from "../util.js";
import { requireAdmin, requireAdminVerifyDb } from "../../admin/requireAdmin.js";
import {
  listSystemSettings,
  getSystemSetting,
  setSystemSetting,
  ALLOWED_KEYS,
  KEY_META,
  SystemSettingNotFoundError,
  SystemSettingValidationError,
  type SystemSettingKey,
  type SystemSettingRow,
} from "../../admin/systemSettings.js";
import type { CommercialHttpDeps, RequestContext } from "../handlers.js";

function serializeSetting(row: SystemSettingRow): Record<string, unknown> {
  return {
    key: row.key,
    value: row.value,
    description: row.description,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
    is_default: row.is_default,
    meta: KEY_META[row.key],
  };
}

function extractTailKey(url: URL, prefix: string): SystemSettingKey {
  // 路径段可能被前端编码,先 decode 再过 allowlist;decodeURIComponent 在
  // malformed % 序列时会抛 URIError → 当 400 处理。
  const rawTail = url.pathname.slice(prefix.length);
  let tail: string;
  try {
    tail = decodeURIComponent(rawTail);
  } catch {
    throw new HttpError(400, "VALIDATION", `malformed setting key: ${rawTail || "<empty>"}`, {
      issues: [{ path: "key", message: "malformed_uri_component" }],
    });
  }
  if (!(ALLOWED_KEYS as readonly string[]).includes(tail)) {
    // 未知 key 当输入校验失败处理,与 systemSettings.ts 模块文档一致("一律 400")。
    throw new HttpError(400, "VALIDATION", `unknown setting key: ${tail || "<empty>"}`, {
      issues: [{ path: "key", message: "not_in_allowlist" }],
    });
  }
  return tail as SystemSettingKey;
}

// ─── GET /api/admin/settings ──────────────────────────────────────
//
// 列全部 allowlist key 的当前值(行不存在 → DEFAULTS,is_default=true)。
export async function handleAdminListSettings(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const rows = await listSystemSettings();
  sendJson(res, 200, { rows: rows.map(serializeSetting) });
}

// ─── GET /api/admin/settings/:key ─────────────────────────────────

export async function handleAdminGetSetting(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const key = extractTailKey(url, "/api/admin/settings/");
  try {
    const row = await getSystemSetting(key);
    sendJson(res, 200, { setting: serializeSetting(row) });
  } catch (err) {
    if (err instanceof SystemSettingNotFoundError) {
      // 理论上 extractTailKey 已挡住未知 key,这里兜底:与 allowlist 失败一致 400。
      throw new HttpError(400, "VALIDATION", err.message, {
        issues: [{ path: "key", message: "not_in_allowlist" }],
      });
    }
    throw err;
  }
}

// ─── PUT /api/admin/settings/:key ─────────────────────────────────
//
// body: { value: <type-by-key>, description?: string | null }
export async function handleAdminPutSetting(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const key = extractTailKey(url, "/api/admin/settings/");

  const body = (await readJsonBody(req)) ?? {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "VALIDATION", "request body must be JSON object");
  }
  const b = body as Record<string, unknown>;
  if (!("value" in b)) {
    throw new HttpError(400, "VALIDATION", "value is required", {
      issues: [{ path: "value", message: "missing" }],
    });
  }
  let description: string | null | undefined;
  if (b.description !== undefined) {
    if (b.description !== null && typeof b.description !== "string") {
      throw new HttpError(400, "VALIDATION", "description must be string or null", {
        issues: [{ path: "description", message: String(b.description) }],
      });
    }
    description = b.description;
  }

  try {
    const row = await setSystemSetting(key, b.value, {
      adminId: admin.id,
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
      description,
    });
    sendJson(res, 200, { setting: serializeSetting(row) });
  } catch (err) {
    if (err instanceof SystemSettingNotFoundError) {
      // 理论上 extractTailKey 已挡住未知 key,这里兜底:与 allowlist 失败一致 400。
      throw new HttpError(400, "VALIDATION", err.message, {
        issues: [{ path: "key", message: "not_in_allowlist" }],
      });
    }
    if (err instanceof SystemSettingValidationError) {
      throw new HttpError(400, "VALIDATION", err.message, {
        issues: err.issues.map((m) => ({ path: "value", message: m })),
      });
    }
    throw err;
  }
}
