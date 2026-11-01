/** Durable record of the Claude Code logins found on each Box account. The
 * scheduler works without it (an account with no rows runs its default login),
 * so every read here degrades to "no rows" if the table is missing. */
import { query, tx } from "../../db/queries.js";
import { BOX_DEFAULT_PROFILE, isBoxProfileName } from "./boxClaudeProfile.js";
import type { BoxProfileHealthState } from "./boxProfileHealth.js";

export type BoxProfileLoginState = "unknown" | "logged_in" | "logged_out";
export type BoxProfileProjectsMode = "unknown" | "root" | "shared" | "absent" | "own";

export interface BoxProfileRow {
  accountId: bigint;
  profile: string;
  enabled: boolean;
  isDefault: boolean;
  loginState: BoxProfileLoginState;
  projectsMode: BoxProfileProjectsMode;
  emailHint: string | null;
  accountFingerprint: string | null;
  orgType: string | null;
  lastSeenAt: Date | null;
  utilization: number | null;
  cooldownUntil: Date | null;
  lastReason: string | null;
  healthUpdatedAt: Date | null;
  /** Weekly window from migration 0309. Absent when that migration has not run. */
  quota7d?: number | null;
  quota7dResetsAt?: Date | null;
}

export interface BoxDiscoveredProfile {
  profile: string;
  loginState: BoxProfileLoginState;
  projectsMode: BoxProfileProjectsMode;
  emailHint: string | null;
  accountFingerprint: string | null;
  orgType: string | null;
}

const COLUMNS = `account_id::text AS account_id, profile, enabled, is_default, login_state,
  projects_mode, email_hint, account_fingerprint, org_type, last_seen_at,
  utilization::float8 AS utilization, cooldown_until, last_reason, health_updated_at`;

interface RawRow { account_id: string; profile: string; enabled: boolean; is_default: boolean;
  login_state: BoxProfileLoginState; projects_mode: BoxProfileProjectsMode;
  email_hint: string | null; account_fingerprint: string | null; org_type: string | null;
  last_seen_at: Date | null; utilization: number | null; cooldown_until: Date | null;
  last_reason: string | null; health_updated_at: Date | null;
  quota_7d?: number | null; quota_7d_resets_at?: Date | null }

function map(row: RawRow): BoxProfileRow {
  return { accountId: BigInt(row.account_id), profile: row.profile, enabled: row.enabled,
    isDefault: row.is_default, loginState: row.login_state, projectsMode: row.projects_mode,
    emailHint: row.email_hint, accountFingerprint: row.account_fingerprint, orgType: row.org_type,
    lastSeenAt: row.last_seen_at, utilization: row.utilization, cooldownUntil: row.cooldown_until,
    lastReason: row.last_reason, healthUpdatedAt: row.health_updated_at,
    ...("quota_7d" in row ? { quota7d: row.quota_7d ?? null, quota7dResetsAt: row.quota_7d_resets_at ?? null } : {}) };
}

function missingTable(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "42P01";
}

/** False in a database without the table (commercial migration 0299, personal 0303), e.g. before the migration ran. */
export async function boxProfilesAvailable(): Promise<boolean> {
  const r = await query<{ t: string | null }>("SELECT to_regclass('public.box_claude_profiles')::text AS t");
  return r.rows[0]?.t !== null && r.rows[0]?.t !== undefined;
}

function missingColumn(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "42703";
}

async function selectBoxProfiles(where: string, params: unknown[]): Promise<BoxProfileRow[]> {
  const order = "ORDER BY account_id, profile";
  const weekly = ", quota_7d::float8 AS quota_7d, quota_7d_resets_at";
  try {
    const result = await query<RawRow>(`SELECT ${COLUMNS}${weekly} FROM box_claude_profiles ${where} ${order}`, params);
    return result.rows.map(map);
  } catch (error) {
    if (missingTable(error)) return [];
    if (!missingColumn(error)) throw error;
  }
  // Personal databases that predate migration 0309 have no weekly columns.
  try {
    const result = await query<RawRow>(`SELECT ${COLUMNS} FROM box_claude_profiles ${where} ${order}`, params);
    return result.rows.map(map);
  } catch (error) {
    if (missingTable(error)) return [];
    throw error;
  }
}

export async function listBoxProfiles(accountIds?: readonly bigint[]): Promise<BoxProfileRow[]> {
  if (accountIds === undefined) return selectBoxProfiles("", []);
  return selectBoxProfiles("WHERE account_id = ANY($1::bigint[])", [accountIds.map((id) => id.toString())]);
}

/** Merge a discovery pass into the table. New logins arrive disabled, except
 * that the first pass on an account turns its `default` login on and marks it
 * default (exactly what the account did before profiles existed). Existing
 * rows keep enabled/default; vanished rows are kept and flagged logged_out. */
export async function recordBoxDiscovery(accountId: bigint,
  found: readonly BoxDiscoveredProfile[]): Promise<BoxProfileRow[]> {
  const id = accountId.toString();
  await tx(async (client) => {
    // One discovery per account at a time: the first-pass seeding below must not race.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`box_claude_profiles:${id}`]);
    const existing = await client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM box_claude_profiles WHERE account_id = $1::bigint", [id]);
    const first = existing.rows[0]?.n === "0";
    for (const item of found) {
      if (!isBoxProfileName(item.profile)) continue;
      const seed = first && item.profile === BOX_DEFAULT_PROFILE && item.loginState === "logged_in";
      await client.query(
        `INSERT INTO box_claude_profiles (account_id, profile, enabled, is_default, login_state,
           projects_mode, email_hint, account_fingerprint, org_type, discovered_at, last_seen_at)
         VALUES ($1::bigint, $2, $3, $3, $4, $5, $6, $7, $8, NOW(), NOW())
         ON CONFLICT (account_id, profile) DO UPDATE SET login_state = EXCLUDED.login_state,
           projects_mode = EXCLUDED.projects_mode, email_hint = EXCLUDED.email_hint,
           account_fingerprint = EXCLUDED.account_fingerprint, org_type = EXCLUDED.org_type,
           last_seen_at = NOW(), updated_at = NOW()`,
        [id, item.profile, seed, item.loginState, item.projectsMode, item.emailHint,
          item.accountFingerprint, item.orgType]);
    }
    await client.query(
      `UPDATE box_claude_profiles SET login_state = 'logged_out', updated_at = NOW()
        WHERE account_id = $1::bigint AND NOT (profile = ANY($2::text[]))`,
      [id, found.map((item) => item.profile)]);
  });
  return listBoxProfiles([accountId]);
}

export class BoxProfileSelectionError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxProfileSelectionError"; }
}

/** Replace the enabled set and the default in one transaction. The default
 * must be one of the enabled logins; every enabled login must be usable (logged
 * in, projects shared/root). At least one login must stay enabled. */
export async function setBoxProfileSelection(accountId: bigint, input: {
  enabled: readonly string[]; defaultProfile: string; updatedBy: bigint | null;
}): Promise<BoxProfileRow[]> {
  const id = accountId.toString();
  const enabled = [...new Set(input.enabled)];
  if (enabled.length === 0) throw new BoxProfileSelectionError("BOX_PROFILE_NONE_ENABLED");
  if (!enabled.every(isBoxProfileName) || !enabled.includes(input.defaultProfile)) {
    throw new BoxProfileSelectionError("BOX_PROFILE_DEFAULT_NOT_ENABLED");
  }
  await tx(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`box_claude_profiles:${id}`]);
    const found = await client.query<RawRow>(
      `SELECT ${COLUMNS} FROM box_claude_profiles WHERE account_id = $1::bigint`, [id]);
    const rows = found.rows.map(map);
    for (const name of enabled) {
      const row = rows.find((candidate) => candidate.profile === name);
      if (!row) throw new BoxProfileSelectionError("BOX_PROFILE_UNKNOWN");
      if (row.loginState !== "logged_in") throw new BoxProfileSelectionError("BOX_PROFILE_NOT_LOGGED_IN");
      if (row.projectsMode !== "root" && row.projectsMode !== "shared") {
        throw new BoxProfileSelectionError("BOX_PROFILE_PROJECTS_NOT_SHARED");
      }
    }
    // The unique default index forbids a window with two defaults: clear first.
    await client.query(`UPDATE box_claude_profiles SET is_default = FALSE, updated_at = NOW()
        WHERE account_id = $1::bigint AND is_default`, [id]);
    await client.query(`UPDATE box_claude_profiles
        SET enabled = (profile = ANY($2::text[])), is_default = (profile = $3),
            updated_by = $4::bigint, updated_at = NOW()
      WHERE account_id = $1::bigint`,
      [id, enabled, input.defaultProfile,
        input.updatedBy === null ? null : input.updatedBy.toString()]);
  });
  return listBoxProfiles([accountId]);
}

/** Best-effort mirror of the in-process health (see BoxProfileHealth). */
export async function writeBoxProfileHealth(accountId: bigint, profile: string,
  state: BoxProfileHealthState): Promise<void> {
  try {
    await query(
      `UPDATE box_claude_profiles SET utilization = $3::real,
         cooldown_until = $4::timestamptz, last_reason = $5, health_updated_at = $6::timestamptz,
         cooldown_reason = $7, backoff_level = $8
       WHERE account_id = $1::bigint AND profile = $2 AND (health_updated_at IS NULL
         OR health_updated_at < $6::timestamptz)`,
      [accountId.toString(), profile, state.utilization,
        state.cooldownUntilMs === null ? null : new Date(state.cooldownUntilMs).toISOString(),
        state.lastReason, new Date(state.updatedAtMs).toISOString(),
        state.cooldownReason ?? null, Math.min(30, Math.max(0, state.backoffLevel ?? 0))]);
  } catch (error) { if (!missingTable(error)) throw error; }
  if (state.windows?.fiveHour || state.windows?.sevenDay) await writeBoxProfileQuotaWindows(accountId, profile, state);
}

const iso = (ms: number | null | undefined): string | null => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

/**
 * OCV5-424: per-window quota for the admin 服务池 page (migration 0309). Separate
 * and best-effort: a database without the columns (or the table) skips it, so the
 * scheduling write above is never affected. Windows not reported keep their value;
 * a report older than the row's last health write is dropped, like that write.
 */
async function writeBoxProfileQuotaWindows(accountId: bigint, profile: string, state: BoxProfileHealthState): Promise<void> {
  const w = state.windows ?? {};
  try {
    await query(
      `UPDATE box_claude_profiles SET
         quota_5h = COALESCE($3::real, quota_5h), quota_5h_resets_at = CASE WHEN $3::real IS NULL THEN quota_5h_resets_at ELSE $4::timestamptz END,
         quota_7d = COALESCE($5::real, quota_7d), quota_7d_resets_at = CASE WHEN $5::real IS NULL THEN quota_7d_resets_at ELSE $6::timestamptz END
       WHERE account_id = $1::bigint AND profile = $2
         AND (health_updated_at IS NULL OR health_updated_at <= $7::timestamptz)`,
      [accountId.toString(), profile,
        w.fiveHour?.utilization ?? null, iso(w.fiveHour?.resetsAtMs),
        w.sevenDay?.utilization ?? null, iso(w.sevenDay?.resetsAtMs), iso(state.updatedAtMs)]);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code !== "42P01" && code !== "42703") throw error;
  }
}

/** One login's 5-hour / weekly quota as last reported (null when never reported or not migrated). */
export interface BoxProfileQuota {
  accountId: bigint;
  profile: string;
  quota5h: number | null;
  quota5hResetsAt: Date | null;
  quota7d: number | null;
  quota7dResetsAt: Date | null;
}

/** Admin read of the per-window columns; empty when the database predates 0309. */
export async function listBoxProfileQuotas(): Promise<BoxProfileQuota[]> {
  try {
    const r = await query<{ account_id: string; profile: string; quota_5h: number | null; quota_5h_resets_at: Date | null; quota_7d: number | null; quota_7d_resets_at: Date | null }>(
      `SELECT account_id::text AS account_id, profile, quota_5h::float8 AS quota_5h, quota_5h_resets_at,
              quota_7d::float8 AS quota_7d, quota_7d_resets_at FROM box_claude_profiles ORDER BY account_id, profile`);
    return r.rows.map((x) => ({ accountId: BigInt(x.account_id), profile: x.profile, quota5h: x.quota_5h,
      quota5hResetsAt: x.quota_5h_resets_at, quota7d: x.quota_7d, quota7dResetsAt: x.quota_7d_resets_at }));
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "42P01" || code === "42703") return [];
    throw error;
  }
}
