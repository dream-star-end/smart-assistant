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
 * Commercial deployments (`flavor === "commercial"`) and legacy/dev runs without
 * a flavor manifest (`status === "skipped"`) retain default behavior untouched.
 */
export function shouldStartCommercialScheduler(
  scheduler: MultiTenantCommercialScheduler,
  args: {
    flavorIdentity: FlavorIdentity;
    runtimeChannel: string;
    env?: NodeJS.ProcessEnv;
  },
): boolean {
  const env = args.env ?? process.env;
  if (isSelfhostFlavor(args.flavorIdentity) && env.OC_SELFHOST_RUN_COMMERCIAL_SCHEDULERS !== "1") {
    return false;
  }
  switch (scheduler) {
    case "pendingOrdersExpirer":
      return env.COMMERCIAL_PENDING_ORDERS_EXPIRER_DISABLED !== "1";
    case "tutorialModeration":
      return args.runtimeChannel === "v5";
    case "marketplaceAiReview":
      return args.runtimeChannel === "v5" && env.OC_MARKETPLACE_AI_REVIEW_DISABLED !== "1";
  }
}
