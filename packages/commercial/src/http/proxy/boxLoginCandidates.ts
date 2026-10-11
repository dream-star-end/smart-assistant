/** One Box account's saved logins as scheduling candidates. Shared by the Box model route
 * (BoxAccountResolver) and the interactive session route (BoxInteractiveLogins), so both apply
 * the same safety filter and read the same health. */
import { BOX_DEFAULT_PROFILE, boxProfileKey } from "./boxClaudeProfile.js";
import type { BoxProfileRow } from "./boxClaudeProfileStore.js";
import type { BoxProfileHealth } from "./boxProfileHealth.js";
import type { BoxProfileCandidate } from "./boxProfileScheduler.js";

export function boxLoginCandidates(args: { accountId: bigint; weight: number;
  /** This account's saved rows (empty: it predates logins and runs its default login). */
  own: readonly BoxProfileRow[]; health: BoxProfileHealth; skip?: ReadonlySet<string> }): BoxProfileCandidate[] {
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
    if (durable?.healthUpdatedAt) {
      args.health.load(key, { utilization: durable.utilization,
        cooldownUntilMs: durable.cooldownUntil?.getTime() ?? null,
        lastReason: durable.lastReason, updatedAtMs: durable.healthUpdatedAt.getTime() });
    }
    candidates.push({ accountId: args.accountId, profile: login.profile, isDefault: login.isDefault,
      weight: args.weight, utilization: args.health.utilization(key),
      cooldownActive: args.health.cooldownActive(key),
      cooldownQuotaOnly: args.health.get(key)?.lastReason === "quota_exhausted",
      loginLoad: args.health.recentLaunches(key), boxLoad: 0 });
  }
  return candidates;
}
