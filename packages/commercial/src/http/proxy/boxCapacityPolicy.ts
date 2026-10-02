/** OCV5-297 Box capacity policy. One source for the in-process invocation
 * registry, the durable journal admission cap, and the Box proxy pool.
 *
 * Commercial defaults keep the previous single-run behavior and add no Box
 * proxy pool. The selfhost flavor defaults to ten concurrent Box sessions per
 * account. Every knob can be overridden by env within a fixed ceiling; an
 * invalid value is reported and ignored so a typo cannot stop egress startup.
 */
import { rootLogger } from "../../logging/logger.js";

const log = rootLogger.child({ subsys: "box-capacity" });

/** Hard ceiling for runs per account / per user. Not an env knob. */
export const BOX_RUNS_CEILING = 16;
const PROXY_CONCURRENCY_CEILING = 64;
const RATE_MIN = 30;
const RATE_MAX = 1200;

export interface BoxRunCapacity {
  readonly maxRunsPerAccount: number;
  readonly maxRunsPerUser: number;
}

export interface BoxCapacityPolicy extends BoxRunCapacity {
  /** Concurrent Box proxy requests per uid. Null keeps Box on the shared pool. */
  readonly proxyConcurrency: number | null;
  /** Box proxy requests per uid per minute. Null keeps the shared rate limit. */
  readonly proxyRatePerMinute: number | null;
}

const COMMERCIAL: BoxCapacityPolicy = {
  maxRunsPerAccount: 1, maxRunsPerUser: 1, proxyConcurrency: null, proxyRatePerMinute: null,
};
const SELFHOST: BoxCapacityPolicy = {
  maxRunsPerAccount: 10, maxRunsPerUser: 10, proxyConcurrency: 20, proxyRatePerMinute: 120,
};

export function isSelfhostEgressFlavor(env: NodeJS.ProcessEnv): boolean {
  return env.SELFHOST_CURSOR_EGRESS === "1" || env.OC_SELFHOST_CURSOR_EGRESS === "1";
}

export function validRunCapacity(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1
    && (value as number) <= BOX_RUNS_CEILING;
}

function readInt(env: NodeJS.ProcessEnv, name: string, min: number, max: number,
  fallback: number | null): number | null {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = /^[0-9]{1,6}$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    log.error("box_capacity_env_invalid", { name, min, max, fallback });
    return fallback;
  }
  return value;
}

export function resolveBoxCapacityPolicy(env: NodeJS.ProcessEnv = process.env): BoxCapacityPolicy {
  const base = isSelfhostEgressFlavor(env) ? SELFHOST : COMMERCIAL;
  const maxRunsPerAccount = readInt(env, "OC_BOX_MAX_RUNS_PER_ACCOUNT", 1, BOX_RUNS_CEILING,
    base.maxRunsPerAccount)!;
  const maxRunsPerUser = readInt(env, "OC_BOX_MAX_RUNS_PER_USER", 1, BOX_RUNS_CEILING,
    base.maxRunsPerUser)!;
  const proxyConcurrency = readInt(env, "OC_BOX_PROXY_MAX_CONCURRENT", 1,
    PROXY_CONCURRENCY_CEILING, base.proxyConcurrency);
  const proxyRatePerMinute = readInt(env, "OC_BOX_PROXY_RATE_PER_MIN", RATE_MIN, RATE_MAX,
    base.proxyRatePerMinute);
  return { maxRunsPerAccount, maxRunsPerUser, proxyConcurrency, proxyRatePerMinute };
}
