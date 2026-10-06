/**
 * /api/admin/box-claude-profiles — the Claude Code logins on a Box account.
 *
 *   GET  ?account_id=N                 saved logins with live health
 *   POST /discover  {account_id}       list the Box's CLAUDE_CONFIG_DIR logins, link
 *                                      logged-in ones to the shared projects dir, save
 *   PUT            {account_id, enabled[], default}   choose what takes part in scheduling
 *
 * Reads: requireAdmin. Writes: requireAdminVerifyDb. Nothing here ever returns
 * a credential: the Box script emits a masked email hint and a one-way fingerprint.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, sendJson, readJsonBody } from "../util.js";
import { requireAdmin, requireAdminVerifyDb } from "../../admin/requireAdmin.js";
import { writeAdminAuditBestEffort } from "../../admin/audit.js";
import { getAccount } from "../../account-pool/store.js";
import type { CommercialHttpDeps, RequestContext } from "../handlers.js";
import { BoxAccountResolverError, createProductionBoxAccountResolver,
  type BoxAccountResolver } from "../proxy/boxAccountResolver.js";
import { BOX_API_RESOLVE_MODEL } from "../proxy/boxApiResolveModel.js";
import { boxProfileDir } from "../proxy/boxClaudeProfile.js";
import { BoxProfileSelectionError, boxProfilesAvailable, listBoxProfiles, recordBoxDiscovery, setBoxProfileSelection,
  type BoxProfileRow } from "../proxy/boxClaudeProfileStore.js";
import { BOX_PROFILE_POLICY } from "../proxy/boxProfileScheduler.js";
import { BoxProfileDiscoveryError, boxProfileUsable, isMaskedEmail, makeBoxProfileDiscover, makeBoxProfilePrepare,
  parseBoxProfileDiscovery } from "../proxy/boxProfileDiscovery.js";

let resolver: BoxAccountResolver | null = null;
const boxResolver = (): BoxAccountResolver => resolver ??= createProductionBoxAccountResolver();
/** Test seam: the production resolver talks to a real Box. */
export function setBoxClaudeProfilesResolverForTest(value: BoxAccountResolver | null): void { resolver = value; }

function accountIdFrom(raw: unknown): bigint {
  if (typeof raw !== "string" || !/^[1-9][0-9]{0,18}$/.test(raw)) {
    throw new HttpError(400, "VALIDATION", "account_id must be a numeric string");
  }
  return BigInt(raw);
}

async function requireBoxAccount(id: bigint): Promise<void> {
  const account = await getAccount(id);
  if (!account || account.provider !== "cursor") {
    throw new HttpError(404, "NOT_FOUND", "Cursor Box account not found");
  }
}

export function serializeBoxProfile(row: BoxProfileRow, all: readonly BoxProfileRow[], nowMs = Date.now()) {
  const cooling = row.cooldownUntil !== null && row.cooldownUntil.getTime() > nowMs;
  return {
    profile: row.profile,
    config_dir: boxProfileDir(row.profile),
    enabled: row.enabled,
    is_default: row.isDefault,
    login_state: row.loginState,
    projects_mode: row.projectsMode,
    /** May be ticked: logged in and sharing the product's projects dir. */
    selectable: boxProfileUsable({ loginState: row.loginState, projectsMode: row.projectsMode }),
    // Re-checked on the way out: a hand-edited row must not leak a full address.
    email_hint: isMaskedEmail(row.emailHint) ? row.emailHint : null,
    org_type: row.orgType,
    /** Another login on this Box is the same Claude account: ticking both adds no quota. */
    duplicate_of: row.accountFingerprint === null ? null
      : all.find((other) => other.profile !== row.profile
        && other.accountFingerprint === row.accountFingerprint)?.profile ?? null,
    utilization: row.utilization,
    cooldown_until: cooling ? row.cooldownUntil!.toISOString() : null,
    cooldown_reason: cooling ? row.lastReason : null,
    last_seen_at: row.lastSeenAt?.toISOString() ?? null,
  };
}

async function requireProfilesTable(): Promise<void> {
  if (!(await boxProfilesAvailable())) {
    throw new HttpError(501, "NOT_AVAILABLE", "Box Claude Code profiles are not available in this edition");
  }
}

function view(rows: BoxProfileRow[], available = true) {
  return { available, profiles: rows.map((row) => serializeBoxProfile(row, rows)),
    // An account with no saved logins still runs its default one.
    implicit_default: rows.length === 0,
    policy: { utilization_ceiling: BOX_PROFILE_POLICY.utilizationCeiling } };
}

export async function handleAdminBoxClaudeProfilesList(req: IncomingMessage, res: ServerResponse,
  _ctx: RequestContext, deps: CommercialHttpDeps): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const id = accountIdFrom(url.searchParams.get("account_id"));
  await requireBoxAccount(id);
  const available = await boxProfilesAvailable();
  sendJson(res, 200, view(available ? await listBoxProfiles([id]) : [], available));
}

export async function handleAdminBoxClaudeProfilesDiscover(req: IncomingMessage, res: ServerResponse,
  ctx: RequestContext, deps: CommercialHttpDeps): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const body = (await readJsonBody(req)) as { account_id?: unknown } | null;
  const id = accountIdFrom(body?.account_id);
  await requireBoxAccount(id);
  await requireProfilesTable();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 60_000);
  try {
    const target = await boxResolver().resolve({ uid: BigInt(admin.id), sessionId: null,
      requestId: `admin-discover-${id}`, upstreamModel: BOX_API_RESOLVE_MODEL, signal: abort.signal,
      allowWakeIfHibernated: true, requiredAccountId: id, adminProbe: true });
    try {
      const run = async (request: ReturnType<typeof makeBoxProfileDiscover>) =>
        (await target.exec.run(request, { timeoutMs: 20_000, maxResponseBytes: 65_536,
          signal: abort.signal })).stdout;
      let found = parseBoxProfileDiscovery(await run(makeBoxProfileDiscover()));
      // A logged-in login whose projects dir does not exist yet is linked to the
      // shared one so the model route can stage history for it.
      const toPrepare = found.filter((item) => item.loginState === "logged_in" && item.projectsMode === "absent");
      for (const item of toPrepare) await run(makeBoxProfilePrepare(item.profile));
      if (toPrepare.length > 0) found = parseBoxProfileDiscovery(await run(makeBoxProfileDiscover()));
      const rows = await recordBoxDiscovery(id, found);
      await writeAdminAuditBestEffort({ adminId: admin.id, ip: ctx.clientIp, userAgent: ctx.userAgent },
        "box_claude_profiles.discover", `account:${id}`, undefined,
        { found: found.map((item) => item.profile), prepared: toPrepare.map((item) => item.profile) });
      sendJson(res, 200, view(rows));
    } finally { await target.dispose?.(); }
  } catch (error) {
    if (error instanceof BoxAccountResolverError) {
      throw new HttpError(409, "BOX_UNAVAILABLE", `Box not reachable: ${error.code}`);
    }
    if (error instanceof BoxProfileDiscoveryError) throw new HttpError(502, "BOX_DISCOVERY_INVALID", error.code);
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "BOX_DISCOVERY_FAILED", "Box discovery failed");
  } finally { clearTimeout(timer); }
}

export async function handleAdminBoxClaudeProfilesSelect(req: IncomingMessage, res: ServerResponse,
  ctx: RequestContext, deps: CommercialHttpDeps): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const body = (await readJsonBody(req)) as { account_id?: unknown; enabled?: unknown; default?: unknown } | null;
  const id = accountIdFrom(body?.account_id);
  if (!Array.isArray(body?.enabled) || body!.enabled.length > 32
    || !body!.enabled.every((item) => typeof item === "string") || typeof body?.default !== "string") {
    throw new HttpError(400, "VALIDATION", "enabled must be a list of profile names and default a name");
  }
  await requireBoxAccount(id);
  await requireProfilesTable();
  try {
    const rows = await setBoxProfileSelection(id, { enabled: body!.enabled as string[],
      defaultProfile: body!.default, updatedBy: BigInt(admin.id) });
    await writeAdminAuditBestEffort({ adminId: admin.id, ip: ctx.clientIp, userAgent: ctx.userAgent },
      "box_claude_profiles.select", `account:${id}`, undefined,
      { enabled: body!.enabled, default: body!.default });
    sendJson(res, 200, view(rows));
  } catch (error) {
    if (error instanceof BoxProfileSelectionError) throw new HttpError(400, "VALIDATION", error.code);
    throw error;
  }
}
