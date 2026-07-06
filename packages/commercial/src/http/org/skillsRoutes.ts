/**
 * `/api/org/*` 技能路由(批次 C — 方案 §4)。org 维度共享技能(marketplace 扩 org)。
 *
 *   - GET    /api/org/skills          (member) → { installed, candidates }
 *   - POST   /api/org/skills/install  (admin)  → 写 org_installs(pin version+hash)
 *   - DELETE /api/org/skills/:slug    (admin)  → 软删 uninstalled_at
 *
 * 鉴权由 routes.ts 分发器统一先跑 requireOrgRole(minRole);org 从 auth.orgId 推导
 * (不接受客户端传 org_id,防 IDOR)。org suspended 时 requireOrgRole 已 403,本层不重复判。
 * org install/uninstall 是 skill-only(方案 §5);agent 的 org 安装不在本期范围。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, sendJson, readJsonBody } from "../util.js";
import type { CommercialHttpDeps, RequestContext } from "../handlers.js";
import { MarketplaceError } from "../../marketplace/marketplaceDb.js";
import {
  installOrgSkill,
  uninstallOrgSkill,
  listOrgInstalls,
  listOrgInstallCandidates,
} from "../../marketplace/orgInstalls.js";
import type { OrgRoute, OrgRouteAuth } from "./routeTypes.js";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const AGENT_ID_RE = /^[A-Za-z0-9_-]+$/;

/** 收窄出必有 org 上下文的 gated 视图(minRole != null 分发器保证非空;漏配则 500 fail-closed)。 */
function gated(auth: OrgRouteAuth): { userId: string; orgId: string } {
  if (auth.orgId === undefined) {
    throw new HttpError(500, "INTERNAL", "missing org auth context");
  }
  return { userId: auth.userId, orgId: auth.orgId };
}

/** MarketplaceError → HttpError 统一映射(与 marketplaceRoutes.mapMarketplaceError 同口径)。 */
function throwMarketplace(e: unknown): never {
  if (e instanceof MarketplaceError) {
    const status =
      e.code === "NOT_INSTALLABLE" || e.code === "VERSION_NOT_FOUND"
        ? 404
        : e.code === "INSTALL_CONFLICT" || e.code === "LISTING_REVOKED"
          ? 409
          : 400;
    throw new HttpError(status, e.code, e.message);
  }
  throw e;
}

/**
 * agent_ids 格式校验(与个人 install 同语义:非空、合法 id、去重)。缺省 = ['main']。
 * org install 会 sync 到全体成员容器,agent 归属只在存在该 agent 的成员容器生效('main' 恒存在);
 * 不做跨成员"可分配 agent"校验(各成员已装 agent 各异),V1 由格式校验兜底。
 */
function asAgentIds(v: unknown): string[] {
  if (v === undefined || v === null) return ["main"];
  if (!Array.isArray(v)) throw new HttpError(400, "BAD_AGENT_SCOPE", "agent_ids must be an array");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    if (typeof item !== "string")
      throw new HttpError(400, "BAD_AGENT_SCOPE", "agent_ids must be strings");
    const id = item.trim();
    if (!id || !AGENT_ID_RE.test(id))
      throw new HttpError(400, "BAD_AGENT_SCOPE", `invalid agentId: ${id}`);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  if (out.length === 0) throw new HttpError(400, "BAD_AGENT_SCOPE", "至少选择一个智能体");
  return out;
}

function asObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

// ─── GET /api/org/skills(member)—— 当前安装 + 可装候选 ───────────────

async function handleListOrgSkills(
  _req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  _deps: CommercialHttpDeps,
  auth: OrgRouteAuth,
): Promise<void> {
  const { orgId } = gated(auth);
  const [installed, candidates] = await Promise.all([
    listOrgInstalls(orgId),
    listOrgInstallCandidates(orgId),
  ]);
  sendJson(res, 200, { installed, candidates });
}

// ─── POST /api/org/skills/install(admin)────────────────────────────

async function handleInstallOrgSkill(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  _deps: CommercialHttpDeps,
  auth: OrgRouteAuth,
): Promise<void> {
  const { orgId, userId } = gated(auth);
  const b = asObject(await readJsonBody(req));
  const slug = typeof b.slug === "string" ? b.slug.trim() : "";
  if (!SLUG_RE.test(slug)) throw new HttpError(400, "BAD_SLUG", "invalid slug");
  const agentIds = asAgentIds(b.agent_ids);
  try {
    const r = await installOrgSkill({ orgId, slug, agentIds, installedBy: userId });
    sendJson(res, 200, {
      ok: true,
      slug: r.slug,
      version: r.version,
      name: r.name,
      note: "已为组织安装,成员的下一次会话中对 AI 可用。",
    });
  } catch (e) {
    throwMarketplace(e);
  }
}

// ─── DELETE /api/org/skills/:slug(admin)────────────────────────────

async function handleUninstallOrgSkill(
  _req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  _deps: CommercialHttpDeps,
  auth: OrgRouteAuth,
  params: Record<string, string>,
): Promise<void> {
  const { orgId } = gated(auth);
  const slug = params.slug ?? "";
  if (!SLUG_RE.test(slug)) throw new HttpError(400, "BAD_SLUG", "invalid slug");
  const ok = await uninstallOrgSkill(orgId, slug);
  if (!ok) throw new HttpError(404, "NOT_FOUND", "该组织未安装此技能");
  sendJson(res, 200, { ok: true, slug });
}

// ─── 路由表 ────────────────────────────────────────────────────────

export const skillsRoutes: OrgRoute[] = [
  { method: "GET", pattern: "/api/org/skills", minRole: "member", handler: handleListOrgSkills },
  { method: "POST", pattern: "/api/org/skills/install", minRole: "admin", handler: handleInstallOrgSkill },
  { method: "DELETE", pattern: "/api/org/skills/:slug", minRole: "admin", handler: handleUninstallOrgSkill },
];
