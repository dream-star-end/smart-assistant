import type { FlavorIdentity } from "./assertFlavor.js";

export type MultiTenantCommercialScheduler =
  | "tutorialModeration"
  | "marketplaceAiReview"
  | "pendingOrdersExpirer";

export function isSelfhostFlavor(flavorIdentity: FlavorIdentity): boolean {
  return flavorIdentity.status === "ok" && flavorIdentity.flavor === "selfhost";
}

/**
 * Gate multi-tenant commercial background schedulers so single-tenant `selfhost`
 * deployments do not waste PG connections or emit timeout alerts on unused
 * commercial tables.
 *
 * `pendingOrdersExpirer` follows payment enablement (`paymentEnabled`) in
 * selfhost so enabling payments still enforces pending-order expiry without
 * needing to toggle all commercial schedulers.
 *
 * Commercial deployments (`flavor === "commercial"`) and legacy/dev runs without
 * a flavor manifest (`status === "skipped"`) retain default behavior untouched.
 */
export function shouldStartCommercialScheduler(
  scheduler: MultiTenantCommercialScheduler,
  args: {
    flavorIdentity: FlavorIdentity;
    runtimeChannel: string;
    paymentEnabled?: boolean;
    env?: NodeJS.ProcessEnv;
  },
): boolean {
  const env = args.env ?? process.env;
  const selfhost = isSelfhostFlavor(args.flavorIdentity);
  const forceAll = env.OC_SELFHOST_RUN_COMMERCIAL_SCHEDULERS === "1";
  if (scheduler === "pendingOrdersExpirer") {
    if (env.COMMERCIAL_PENDING_ORDERS_EXPIRER_DISABLED === "1") return false;
    if (selfhost && !forceAll) return args.paymentEnabled === true;
    return true;
  }
  if (selfhost && !forceAll) return false;
  switch (scheduler) {
    case "tutorialModeration":
      return args.runtimeChannel === "v5";
    case "marketplaceAiReview":
      return args.runtimeChannel === "v5" && env.OC_MARKETPLACE_AI_REVIEW_DISABLED !== "1";
  }
}
