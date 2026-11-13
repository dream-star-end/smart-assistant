/**
 * OCV5-424 — /api/admin/pools: every service pool (subscription accounts and API
 * keys) under the one shared scheduling policy.
 *
 *   GET   /api/admin/pools                        all pools, members, policy constants
 *   POST  /api/admin/pools/keys                   {service, api_key, label?, tier?, weight?} add an API key
 *   PATCH /api/admin/pools/keys/:id               {status: 'active'|'disabled'}  admin enable/disable
 *
 * Reads: requireAdmin. Writes: requireAdminVerifyDb + admin_audit. No credential is
 * ever returned: API keys show a fingerprint prefix and the last 4 characters.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { writeAdminAuditBestEffort } from "../../admin/audit.js";
import { requireAdmin, requireAdminVerifyDb } from "../../admin/requireAdmin.js";
import { API_KEY_SERVICE_RE, setApiKeyAdminStatus, upsertApiKey } from "../../account-pool/apiKeyPool.js";
import { DEFAULT_POLICY } from "../../account-pool/policy/decide.js";
import { listPoolAdapters, type PoolMemberView } from "../../account-pool/policy/registry.js";
import { affinityCounts } from "../../account-pool/policy/affinity.js";
import { collectBoxClaude } from "./boxClaudePool.js";
import { STATIC_PROVIDER_META } from "../proxy/staticProviderMeta.js";
import type { CommercialHttpDeps, RequestContext } from "../handlers.js";
import { HttpError, readJsonBody, sendJson } from "../util.js";

/** Services that take API keys in pool_api_keys. */
export function apiKeyServices(): string[] {
  return ["claude", "gemini", "openai", ...Object.keys(STATIC_PROVIDER_META)];
}

/** Display order of the pools on the admin page. */
const SERVICE_ORDER = ["claude", "codex", "grok", "box", "gemini"];

export interface PoolView {
  service: string;
  accepts_api_keys: boolean;
  members: PoolMemberView[];
  counts: { active: number; cooldown: number; disabled: number; total: number };
}

/** Affinity key a member's bindings live under (policy/affinity callers). */
function affinityServiceOf(m: PoolMemberView): string {
  if (m.memberKind === "api_key") return `apikey:${m.service}`;
  if (m.memberKind === "account" && m.service === "gemini") return "antigravity";
  return m.service;
}

export async function collectPools(): Promise<PoolView[]> {
  const members: PoolMemberView[] = [];
  for (const adapter of listPoolAdapters()) {
    if (adapter.listMembers) members.push(...(await adapter.listMembers()));
  }
  // OCV5-424 user affinity: live bound users per member (shown as "绑定 N 人").
  try {
    const bound = await affinityCounts();
    for (const m of members) {
      const n = bound.get(`${affinityServiceOf(m)}:${m.memberKind}:${m.id}`);
      if (n !== undefined) m.hints = { ...m.hints, bound_users: n };
    }
  } catch {
    /* counts are informational */
  }
  const keyServices = new Set(apiKeyServices());
  const services = new Set<string>([...SERVICE_ORDER, ...keyServices, ...members.map((m) => m.service)]);
  const order = (s: string): number => {
    const i = SERVICE_ORDER.indexOf(s);
    return i === -1 ? SERVICE_ORDER.length : i;
  };
  return [...services]
    .sort((a, b) => order(a) - order(b) || a.localeCompare(b))
    .map((service) => {
      const list = members.filter((m) => m.service === service);
      const count = (st: string): number => list.filter((m) => m.status === st).length;
      return {
        service,
        accepts_api_keys: keyServices.has(service),
        members: list,
        counts: {
          active: count("active"),
          cooldown: count("cooldown"),
          disabled: list.filter((m) => m.status === "disabled" || m.status === "banned").length,
          total: list.length,
        },
      };
    });
}

function policySummary() {
  return {
    fail_threshold: DEFAULT_POLICY.failThreshold,
    rate_limit_ms: [DEFAULT_POLICY.rateLimitMinMs, DEFAULT_POLICY.rateLimitMaxMs],
    auth_backoff_ms: [DEFAULT_POLICY.authBaseMs, DEFAULT_POLICY.authMaxMs],
    credential_backoff_ms: [DEFAULT_POLICY.credentialBaseMs, DEFAULT_POLICY.credentialMaxMs],
    upstream_backoff_ms: [DEFAULT_POLICY.upstreamBaseMs, DEFAULT_POLICY.upstreamMaxMs],
    quota_default_ms: DEFAULT_POLICY.quotaDefaultMs,
  };
}

export async function handleAdminPoolsList(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const [pools, boxClaude] = await Promise.all([collectPools(), collectBoxClaude().catch(() => null)]);
  sendJson(res, 200, { pools, policy: policySummary(), box_claude: boxClaude });
}

export async function handleAdminPoolKeyCreate(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const body = (await readJsonBody(req)) as {
    service?: unknown;
    api_key?: unknown;
    label?: unknown;
    tier?: unknown;
    weight?: unknown;
  } | null;
  const service = typeof body?.service === "string" ? body.service.trim() : "";
  if (!API_KEY_SERVICE_RE.test(service) || !apiKeyServices().includes(service)) {
    throw new HttpError(400, "VALIDATION", "service does not take API keys");
  }
  if (typeof body?.api_key !== "string") throw new HttpError(400, "VALIDATION", "api_key required");
  const label = typeof body.label === "string" ? body.label : "";
  const tier = body.tier === undefined ? undefined : Number(body.tier);
  const weight = body.weight === undefined ? undefined : Number(body.weight);
  if (tier !== undefined && !(Number.isInteger(tier) && tier >= 0 && tier <= 9)) {
    throw new HttpError(400, "VALIDATION", "tier must be 0-9");
  }
  if (weight !== undefined && !(Number.isInteger(weight) && weight >= 1 && weight <= 1000)) {
    throw new HttpError(400, "VALIDATION", "weight must be 1-1000");
  }
  let created: { id: string; created: boolean };
  try {
    created = await upsertApiKey({ service, apiKey: body.api_key, label, source: "admin", tier, weight });
  } catch (err) {
    if (err instanceof RangeError) throw new HttpError(400, "VALIDATION", err.message);
    throw err;
  }
  await writeAdminAuditBestEffort(
    { adminId: admin.id, ip: ctx.clientIp, userAgent: ctx.userAgent },
    "pool_key.create",
    `pool_key:${created.id}`,
    null,
    { service, label, tier: tier ?? null, weight: weight ?? null, created: created.created },
  );
  sendJson(res, created.created ? 201 : 200, { id: created.id, created: created.created });
}

export async function handleAdminPoolKeyPatch(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const m = /^\/api\/admin\/pools\/keys\/([1-9][0-9]{0,18})$/.exec(url.pathname);
  if (!m) throw new HttpError(404, "NOT_FOUND", "not found");
  const body = (await readJsonBody(req)) as { status?: unknown } | null;
  if (body?.status !== "active" && body?.status !== "disabled") {
    throw new HttpError(400, "VALIDATION", "status must be active or disabled");
  }
  const row = await setApiKeyAdminStatus(m[1], body.status);
  if (!row) throw new HttpError(404, "NOT_FOUND", "key not found");
  await writeAdminAuditBestEffort(
    { adminId: admin.id, ip: ctx.clientIp, userAgent: ctx.userAgent },
    "pool_key.patch",
    `pool_key:${row.id}`,
    null,
    { status: row.status, service: row.service },
  );
  sendJson(res, 200, { id: row.id, status: row.status });
}
