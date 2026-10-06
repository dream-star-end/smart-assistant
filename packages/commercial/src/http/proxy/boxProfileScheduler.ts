/** Picks the Box account + Claude login for one request.
 *
 * Affinity first: a user keeps landing on the same login (prompt cache,
 * session continuity) via weighted rendezvous hashing over the *enabled*
 * logins, which needs no stored assignment and moves only the users of a
 * login that dropped out. Load, quota and health are the fallback: a login
 * that is benched, out of quota, over its launch budget, or whose Box is busy
 * is skipped in favour of the user's next-ranked login, so a switch is
 * deterministic and returns when the login recovers. */
import { createHash } from "node:crypto";

export interface BoxProfileCandidate {
  accountId: bigint;
  profile: string;
  isDefault: boolean;
  /** Static weight (Cursor slot weight): must not drift with load, or affinity would. */
  weight: number;
  utilization: number | null;
  cooldownActive: boolean;
  /** Launches on this login in the recent window. */
  loginLoad: number;
  /** Launches on the whole Box (all its logins) in the recent window. */
  boxLoad: number;
}

export interface BoxProfilePolicy {
  /** Utilization at or above this skips a login while another is below it. */
  utilizationCeiling: number;
  /** Launches per 90s window a login takes before spilling (about 6 concurrent runs at 30s each,
   * the per-account cap of the commercial route). */
  loginSpillLoad: number;
  /** Launches per recent window a Box takes before spilling. */
  boxSpillLoad: number;
  /** Rank bonus for the default login (still hash-spread over users). */
  defaultBonus: number;
}

export const BOX_PROFILE_POLICY: BoxProfilePolicy = {
  utilizationCeiling: 0.92, loginSpillLoad: 10, boxSpillLoad: 14, defaultBonus: 1.5 };

export type BoxProfilePickReason = "affinity" | "spill_unhealthy" | "spill_load" | "last_resort";
export interface BoxProfilePick { candidate: BoxProfileCandidate; reason: BoxProfilePickReason }

function unitHash(parts: string[]): number {
  const digest = createHash("sha256").update(parts.join("\u0000")).digest();
  // 52 bits -> (0,1): never 0 or 1, so -ln is finite and positive.
  const n = Number(digest.readBigUInt64BE(0) >> 12n);
  return (n + 0.5) / 2 ** 52;
}

/** Highest first. Weighted rendezvous: score = weight / -ln(u). */
export function rankBoxProfiles(candidates: readonly BoxProfileCandidate[], affinityKey: string,
  policy: BoxProfilePolicy = BOX_PROFILE_POLICY): BoxProfileCandidate[] {
  return candidates.map((c) => {
    const weight = Math.max(c.weight, 0.0001) * (c.isDefault ? policy.defaultBonus : 1);
    const u = unitHash([affinityKey, c.accountId.toString(), c.profile]);
    return { c, score: weight / -Math.log(u) };
  }).sort((a, b) => b.score - a.score
    || (a.c.accountId < b.c.accountId ? -1 : a.c.accountId > b.c.accountId ? 1 : 0)
    || a.c.profile.localeCompare(b.c.profile)).map((x) => x.c);
}

export function pickBoxProfile(args: { candidates: readonly BoxProfileCandidate[];
  /** Stable per user (uid); a request without one spreads on its request id. */
  affinityKey: string; policy?: BoxProfilePolicy }): BoxProfilePick | null {
  const policy = args.policy ?? BOX_PROFILE_POLICY;
  const usable = args.candidates.filter((c) => !c.cooldownActive);
  if (usable.length === 0) return null;
  const ranked = rankBoxProfiles(usable, args.affinityKey, policy);
  const roomy = (c: BoxProfileCandidate): boolean => c.loginLoad < policy.loginSpillLoad
    && c.boxLoad < policy.boxSpillLoad;
  const healthy = (c: BoxProfileCandidate): boolean => c.utilization === null
    || c.utilization < policy.utilizationCeiling;
  const top = ranked[0]!;
  const first = ranked.find((c) => healthy(c) && roomy(c));
  if (first) {
    return { candidate: first, reason: first === top ? "affinity"
      : !healthy(top) ? "spill_unhealthy" : "spill_load" };
  }
  // Everything is hot: stay on healthy logins by least load, else least used quota.
  const pool = ranked.filter(healthy);
  const last = (pool.length > 0 ? pool : ranked).slice().sort((a, b) =>
    (pool.length > 0 ? a.loginLoad - b.loginLoad : (a.utilization ?? 0) - (b.utilization ?? 0)))[0]!;
  return { candidate: last, reason: "last_resort" };
}
