/**
 * /api/admin/literature — DeepXiv 文献检索配置(平台级,单例)。
 *
 * 端点:
 *   GET   /api/admin/literature        返回 mask 视图(token 永不明文)
 *   PATCH /api/admin/literature        修改;token 用 {action:'keep'|'set'|'clear'} 显式协议
 *   POST  /api/admin/literature/test   实际 probe DeepXiv(query=transformers, size=1)
 *
 * GET 用 requireAdmin;PATCH/POST 用 requireAdminVerifyDb(DB 二次校验)。
 *
 * test 端点不消耗 daily_cap(那是业务通道的计数;admin 自检挤掉用户配额就荒谬了),
 * 但配 per-admin 10s 进程内冷却防 admin 连点把上游打瘫。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, sendJson, readJsonBody } from "../util.js";
import { requireAdmin, requireAdminVerifyDb } from "../../admin/requireAdmin.js";
import {
  getLiteratureConfig,
  patchLiteratureConfig,
  testLiteratureConfig,
  type PatchLiteratureConfigInput,
  type TokenPatch,
} from "../../admin/literatureConfig.js";
import type { CommercialHttpDeps, RequestContext } from "../handlers.js";
import { translateRangeError } from "./_shared.js";

// Per-admin test 冷却 — 防连点。进程内 Map,重启即清。10s 已经够 admin "改 → 立刻测"。
const TEST_COOLDOWN_MS = 10_000;
const lastTestByAdmin = new Map<string, number>();

function checkTestCooldown(adminId: string | number | bigint): number {
  const key = String(adminId);
  const last = lastTestByAdmin.get(key);
  const now = Date.now();
  if (last !== undefined && now - last < TEST_COOLDOWN_MS) {
    return Math.ceil((TEST_COOLDOWN_MS - (now - last)) / 1000);
  }
  lastTestByAdmin.set(key, now);
  // 简单 GC:每次写入时,若 Map 过大(>1000 admin)清掉最老的 100 个
  if (lastTestByAdmin.size > 1000) {
    let i = 0;
    for (const k of lastTestByAdmin.keys()) {
      lastTestByAdmin.delete(k);
      i++;
      if (i >= 100) break;
    }
  }
  return 0;
}

// ─── GET /api/admin/literature ─────────────────────────────────────

export async function handleAdminGetLiterature(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const view = await getLiteratureConfig(true);
  sendJson(res, 200, { config: view });
}

// ─── PATCH /api/admin/literature ───────────────────────────────────

function parseTokenPatch(v: unknown): TokenPatch | undefined {
  if (v === undefined) return undefined;
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new HttpError(400, "VALIDATION", "token must be an object with {action}");
  }
  const o = v as Record<string, unknown>;
  if (o.action === "keep") return { action: "keep" };
  if (o.action === "clear") return { action: "clear" };
  if (o.action === "set") {
    if (typeof o.value !== "string") {
      throw new HttpError(400, "VALIDATION", "token.value must be a string for action=set");
    }
    return { action: "set", value: o.value };
  }
  throw new HttpError(400, "VALIDATION", "token.action must be 'keep' | 'set' | 'clear'");
}

export async function handleAdminPatchLiterature(
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
  const b = body as Record<string, unknown>;
  const patch: PatchLiteratureConfigInput = {};
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean") {
      throw new HttpError(400, "VALIDATION", "enabled must be boolean");
    }
    patch.enabled = b.enabled;
  }
  if (b.base_url !== undefined) {
    if (typeof b.base_url !== "string") {
      throw new HttpError(400, "VALIDATION", "base_url must be string");
    }
    patch.base_url = b.base_url;
  }
  const tokenPatch = parseTokenPatch(b.token);
  if (tokenPatch !== undefined) patch.token = tokenPatch;
  if (b.daily_cap !== undefined) {
    if (typeof b.daily_cap !== "number") {
      throw new HttpError(400, "VALIDATION", "daily_cap must be number");
    }
    patch.daily_cap = b.daily_cap;
  }
  if (b.default_size !== undefined) {
    if (typeof b.default_size !== "number") {
      throw new HttpError(400, "VALIDATION", "default_size must be number");
    }
    patch.default_size = b.default_size;
  }
  if (b.timeout_sec !== undefined) {
    if (typeof b.timeout_sec !== "number") {
      throw new HttpError(400, "VALIDATION", "timeout_sec must be number");
    }
    patch.timeout_sec = b.timeout_sec;
  }

  try {
    const view = await patchLiteratureConfig(patch, {
      adminId: admin.id,
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
    sendJson(res, 200, { config: view });
  } catch (err) {
    if (err instanceof RangeError) translateRangeError(err);
    throw err;
  }
}

// ─── POST /api/admin/literature/test ───────────────────────────────

export async function handleAdminTestLiterature(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const wait = checkTestCooldown(admin.id);
  if (wait > 0) {
    res.setHeader("Retry-After", String(wait));
    throw new HttpError(429, "RATE_LIMITED", `please wait ${wait}s before re-testing`);
  }
  const result = await testLiteratureConfig();
  sendJson(res, 200, { result });
}
