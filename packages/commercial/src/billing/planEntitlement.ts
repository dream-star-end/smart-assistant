/**
 * Subscription floor for catalog models (e.g. Opus/Fable require Max+).
 *
 * Personal `user_subscriptions.tier` is compared to the model's
 * `min_plan_code` (user-scope). Org Max/Ultra count as meeting user Max.
 */
export const USER_MAX_PLAN_CODE = "max";
export const ORG_CODES_MEETING_USER_MAX: ReadonlySet<string> = new Set([
  "org-max",
  "org-ultra",
]);

export function meetsMinPlan(args: {
  minPlanCode?: string | null;
  minPlanTier?: number | null;
  userPlanTier?: number | null;
  orgPlanCode?: string | null;
}): boolean {
  const minCode = args.minPlanCode ?? null;
  if (!minCode) return true;
  const userTier = args.userPlanTier;
  const minTier = args.minPlanTier;
  if (userTier != null && minTier != null && userTier >= minTier) return true;
  if (minCode === USER_MAX_PLAN_CODE && args.orgPlanCode && ORG_CODES_MEETING_USER_MAX.has(args.orgPlanCode)) {
    return true;
  }
  return false;
}
