// Candidate schema is only for bootstrap, never recovery/manual leases.
import { loadConfig } from "../../packages/commercial/src/config.js";
try {
  const env = { ...process.env, NODE_ENV: "production" };
  const cfg = loadConfig(env);
  const requireField = (ok: unknown) => { if (!ok) throw new Error("incomplete bootstrap"); };
  requireField(cfg.COMMERCIAL_ENABLED);
  requireField(env.OC_RUNTIME_CHANNEL?.trim() === "v5");
  requireField(cfg.OC_RUNTIME_IMAGE);
  requireField(env.COMMERCIAL_JWT_SECRET ?? env.JWT_SECRET);
  requireField(!env.AGENT_IMAGE && env.WECHAT_BROKER_ENABLED !== "1");
  // This first-install entry follows the official split=1 template. It does not
  // impose new constraints on legacy/non-split deploy or repair lanes.
  requireField(env.OC_EGRESS_SPLIT === "1");
  requireField(cfg.INTERNAL_CONTROL_BIND && cfg.INTERNAL_CONTROL_PORT && cfg.OC_EGRESS_SECRET);
} catch {
  // Never echo Zod enum errors (which may contain input values) or secrets.
  console.error("bootstrap: candidate production runtime env is incomplete or invalid");
  process.exitCode = 79;
}
