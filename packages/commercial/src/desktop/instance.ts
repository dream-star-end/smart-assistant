/**
 * Desktop process identity for the W-05 owner directory.
 *
 * Production MUST set OC_INSTANCE_ID to a stable slot identity (e.g. master-A)
 * so crash-restart can sweep leftover owner rows. hostname:pid is a local/dev
 * fallback; leftovers then age out via the 90s heartbeat stale window.
 */

import { hostname } from "node:os";

export function readDesktopInstanceId(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OC_INSTANCE_ID?.trim();
  if (explicit) return explicit;
  return `${hostname()}:${process.pid}`;
}

export function readDesktopInstanceAddr(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OC_INSTANCE_ADDR?.trim();
  if (explicit) return explicit;
  const bind = env.OC_DESKTOP_TLS_BIND?.trim() || "127.0.0.1";
  const port = Number(env.OC_DESKTOP_TLS_PORT ?? "18445");
  return `${bind}:${Number.isFinite(port) && port > 0 ? port : 18445}`;
}

/** Env flag off → owner-directory SQL must not run (W-05 / W-R03 docker path). */
export function isDesktopOwnerSqlEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OC_DESKTOP_VIRTUAL_CONTAINER === "1";
}
