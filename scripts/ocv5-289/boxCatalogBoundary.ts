/** Fixed selfhost endpoint for the two-role Box catalog operator. Credentials
 * must differ, but neither role may point at another DB/server. */
export function sameSelfhostCatalogEndpoint(appRaw: string,
  adminRaw: string): boolean {
  try {
    const app = new URL(appRaw), admin = new URL(adminRaw);
    const fixed = (u: URL): boolean => ["postgres:", "postgresql:"].includes(u.protocol)
      && u.hostname === "127.0.0.1" && u.port === "5432"
      && u.pathname === "/openclaude_v5_selfhost"
      && u.search === "" && u.hash === "" && u.username !== ""
      && u.password !== "";
    return fixed(app) && fixed(admin) && app.username !== admin.username;
  } catch { return false; }
}

/** The catalog state is authoritative; pricing.enabled is its trigger mirror.
 * Never flip pricing first, because that trigger would activate the model. */
export function boxCatalogActivationAction(state: string, pricingEnabled: boolean):
  "activate" | "already_active" {
  if ((state === "staged" || state === "disabled") && !pricingEnabled) return "activate";
  if (state === "active" && pricingEnabled) return "already_active";
  throw new Error("BOX_CATALOG_STATE_MIRROR_INVALID");
}
