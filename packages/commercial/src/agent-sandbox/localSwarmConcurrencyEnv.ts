/**
 * Container env `OC_MAX_CONCURRENT_LOCAL_SWARMS` single decision point
 * (master -> container gateway one-way injection).
 *
 * Background (OCV5-894): selfhost removed the default local Antigravity swarm
 * concurrency cap (`DEFAULT_MAX_CONCURRENT_LOCAL_SWARMS = 0`). On multi-tenant
 * commercial hosts, 4 GB user containers running >2 concurrent `agy` swarms
 * (0.43-1.00 GB RSS each) trigger cgroup OOM SIGKILL. Commercial flavor keeps
 * the proven cap of 2 unless explicitly overridden by operator env.
 *
 * Decision order (mirrors `taskboardEnv.ts`):
 *   1. Explicit master env `OC_MAX_CONCURRENT_LOCAL_SWARMS` (non-negative int or
 *      `unlimited`/`inf`/`infinity`) -> forward as-is.
 *   2. `flavor.manifest.json` resolves to `commercial` -> inject `=2`.
 *   3. `FlavorIdentityError` -> fail-closed inject `=2`.
 *   4. `selfhost` or no manifest (dev/test) -> inject nothing (container default `0`).
 */

import {
  type FlavorIdentity,
  FlavorIdentityError,
  resolveFlavorIdentity,
} from "../flavor/assertFlavor.js";

export const LOCAL_SWARM_CONCURRENCY_ENV = "OC_MAX_CONCURRENT_LOCAL_SWARMS";
export const COMMERCIAL_DEFAULT_MAX_CONCURRENT_LOCAL_SWARMS = 2;

const EXPLICIT_CAP_RE = /^(?:[0-9]+|unlimited|inf|infinity)$/i;

export interface LocalSwarmConcurrencyEnvOpts {
  env: NodeJS.ProcessEnv;
  /** Test seam; production uses real `resolveFlavorIdentity`. */
  identity?: () => FlavorIdentity;
}

export function localSwarmConcurrencyContainerEnv(
  opts: LocalSwarmConcurrencyEnvOpts,
): string[] {
  const explicit = opts.env[LOCAL_SWARM_CONCURRENCY_ENV]?.trim() ?? "";
  if (explicit && EXPLICIT_CAP_RE.test(explicit)) {
    return [`${LOCAL_SWARM_CONCURRENCY_ENV}=${explicit.toLowerCase()}`];
  }

  let identity: FlavorIdentity;
  try {
    identity = (opts.identity ?? resolveFlavorIdentity)();
  } catch (err) {
    if (err instanceof FlavorIdentityError) {
      return [`${LOCAL_SWARM_CONCURRENCY_ENV}=${COMMERCIAL_DEFAULT_MAX_CONCURRENT_LOCAL_SWARMS}`];
    }
    throw err;
  }
  if (identity.status === "ok" && identity.flavor === "commercial") {
    return [`${LOCAL_SWARM_CONCURRENCY_ENV}=${COMMERCIAL_DEFAULT_MAX_CONCURRENT_LOCAL_SWARMS}`];
  }
  return [];
}
