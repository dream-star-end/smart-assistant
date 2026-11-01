/** One Box account's saved logins as scheduling candidates. Shared by the Box model route
 * (BoxAccountResolver) and the interactive session route (BoxInteractiveLogins), so both apply
 * the same safety filter and read the same health. */
import { BOX_DEFAULT_PROFILE, boxProfileKey } from "./boxClaudeProfile.js";
import type { BoxProfileRow } from "./boxClaudeProfileStore.js";
import { BOX_PROFILE_MAX_COOLDOWN_MS, type BoxProfileHealth, type BoxProfileHealthState } from "./boxProfileHealth.js";
import type { BoxProfileCandidate } from "./boxProfileScheduler.js";

/** Weekly quota is spent (已用完), not merely near the 0.92 spill line. A reset
 * in the future is decisive. With no reset, trust a reading only for one weekly
 * window; older than that, the scalar utilization path already forgot it. */
function weeklyQuotaExhausted(prior: BoxProfileHealthState | undefined, durable: BoxProfileRow | undefined, nowMs: number): boolean {
  const durableAt = durable?.healthUpdatedAt?.getTime() ?? 0;
  const priorAt = prior?.updatedAtMs ?? 0;
  const memory = prior?.windows?.sevenDay;
  const useMemory = memory !== undefined && priorAt >= durableAt;
  const utilization = useMemory ? memory.utilization : durable?.quota7d;
  const resetsAt = useMemory ? memory.resetsAtMs : durable?.quota7dResetsAt?.getTime() ?? null;
  if (utilization === null || utilization === undefined || !(utilization >= 1)) return false;
  if (resetsAt !== null && resetsAt !== undefined) return resetsAt > nowMs;
  const updatedAt = useMemory ? priorAt : durableAt;
  if (!updatedAt) return false;
  return nowMs >= updatedAt && nowMs - updatedAt <= BOX_PROFILE_MAX_COOLDOWN_MS;
}

export function boxLoginCandidates(args: { accountId: bigint; weight: number;
  /** This account's saved rows (empty: it predates logins and runs its default login). */
  own: readonly BoxProfileRow[]; health: BoxProfileHealth; skip?: ReadonlySet<string>;
  /** Scheduler clock. Defaults to Date.now(); callers with a test clock must pass it. */
  nowMs?: number }): BoxProfileCandidate[] {
  const nowMs = args.nowMs ?? Date.now();
  const logins = args.own.length === 0
    ? [{ profile: BOX_DEFAULT_PROFILE, isDefault: true }]
    // Defence in depth behind the admin API: a row edited by hand can never route traffic to a
    // login that is logged out or whose projects dir is not the shared one (a developer dir).
    : args.own.filter((item) => item.enabled && item.loginState === "logged_in"
      && (item.projectsMode === "root" || item.projectsMode === "shared"))
      .map((item) => ({ profile: item.profile, isDefault: item.isDefault }));
  const candidates: BoxProfileCandidate[] = [];
  for (const login of logins) {
    const key = boxProfileKey(args.accountId, login.profile);
    if (args.skip?.has(key)) continue;
    const durable = args.own.find((item) => item.profile === login.profile);
    // load() replaces the whole state and drops in-memory weekly windows when the
    // durable row is newer. Read the live window first.
    const prior = args.health.get(key);
    if (durable?.healthUpdatedAt) {
      args.health.load(key, { utilization: durable.utilization,
        cooldownUntilMs: durable.cooldownUntil?.getTime() ?? null,
        lastReason: durable.lastReason, updatedAtMs: durable.healthUpdatedAt.getTime() });
    }
    const reason = args.health.get(key)?.lastReason;
    const hardBench = args.health.cooldownActive(key) &&
      (reason === "login_required" || reason === "profile_unsafe");
    let cooldownActive = args.health.cooldownActive(key);
    let cooldownQuotaOnly = reason === "quota_exhausted";
    if (weeklyQuotaExhausted(prior, durable, nowMs)) {
      cooldownActive = true;
      // A logged-out or unsafe login is not a quota last resort. Weekly-full
      // alone still is, so an all-exhausted pool can return the real refusal.
      if (!hardBench) cooldownQuotaOnly = true;
    }
    candidates.push({ accountId: args.accountId, profile: login.profile, isDefault: login.isDefault,
      weight: args.weight, utilization: args.health.utilization(key),
      cooldownActive, cooldownQuotaOnly,
      loginLoad: args.health.recentLaunches(key), boxLoad: 0 });
  }
  return candidates;
}
