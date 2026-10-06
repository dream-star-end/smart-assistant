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
  last_reason: string | null; health_updated_at: Date | null }

function map(row: RawRow): BoxProfileRow {
  return { accountId: BigInt(row.account_id), profile: row.profile, enabled: row.enabled,
    isDefault: row.is_default, loginState: row.login_state, projectsMode: row.projects_mode,
    emailHint: row.email_hint, accountFingerprint: row.account_fingerprint, orgType: row.org_type,
    lastSeenAt: row.last_seen_at, utilization: row.utilization, cooldownUntil: row.cooldown_until,
    lastReason: row.last_reason, healthUpdatedAt: row.health_updated_at };
}

function missingTable(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "42P01";
}

/** False in an edition/database without the 0299 table (the personal edition ships no commercial migrations). */
export async function boxProfilesAvailable(): Promise<boolean> {
  const r = await query<{ t: string | null }>("SELECT to_regclass('public.box_claude_profiles')::text AS t");
  return r.rows[0]?.t !== null && r.rows[0]?.t !== undefined;
}

export async function listBoxProfiles(accountIds?: readonly bigint[]): Promise<BoxProfileRow[]> {
  try {
    const result = accountIds === undefined
      ? await query<RawRow>(`SELECT ${COLUMNS} FROM box_claude_profiles ORDER BY account_id, profile`)
      : await query<RawRow>(`SELECT ${COLUMNS} FROM box_claude_profiles
          WHERE account_id = ANY($1::bigint[]) ORDER BY account_id, profile`,
        [accountIds.map((id) => id.toString())]);
    return result.rows.map(map);
  } catch (error) {
    if (missingTable(error)) return [];
    throw error;
  }
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
         cooldown_until = $4::timestamptz, last_reason = $5, health_updated_at = $6::timestamptz
       WHERE account_id = $1::bigint AND profile = $2 AND (health_updated_at IS NULL
         OR health_updated_at <= $6::timestamptz)`,
      [accountId.toString(), profile, state.utilization,
        state.cooldownUntilMs === null ? null : new Date(state.cooldownUntilMs).toISOString(),
        state.lastReason, new Date(state.updatedAtMs).toISOString()]);
  } catch (error) { if (!missingTable(error)) throw error; }
}
