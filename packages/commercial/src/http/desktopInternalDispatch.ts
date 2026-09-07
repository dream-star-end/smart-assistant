/**
 * 18445 pathname whitelist (design v2 §6.3). Unlisted → 404.
 * Non-CCB relay prefixes are 404 on this TLS face; ENGINE_NOT_ENABLED 403 is
 * reserved for the user-turn admission gate (W-01).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  MODEL_CATALOG_EPOCH_PATH,
  MODEL_CATALOG_PATH,
  SERVER_AUTHORED_PATH,
  TURN_LEASE_RENEW_PATH,
  TURN_TAPE_STATE_PATH,
} from "@openclaude/protocol";
import { HttpError, sendJson } from "./util.js";

export const DESKTOP_ENGINE_NOT_ENABLED = "ENGINE_NOT_ENABLED";

export const DESKTOP_TOKEN_MINT_PATH = "/api/desktop/token";
export const DESKTOP_TOKEN_REFRESH_PATH = "/api/desktop/token/refresh";
export const DESKTOP_RUNTIME_MANIFEST_PATH = "/api/desktop/runtime-manifest";

export const DESKTOP_ALLOWED_PATHS = {
  messages: { method: "POST", path: "/v1/messages" },
  serverAuthored: { method: "POST", path: SERVER_AUTHORED_PATH },
  turnTape: { method: "GET", path: TURN_TAPE_STATE_PATH },
  turnLease: { method: "POST", path: TURN_LEASE_RENEW_PATH },
  catalog: { method: "GET", path: MODEL_CATALOG_PATH },
  catalogEpoch: { method: "GET", path: MODEL_CATALOG_EPOCH_PATH },
  tokenMint: { method: "POST", path: DESKTOP_TOKEN_MINT_PATH },
  tokenRefresh: { method: "POST", path: DESKTOP_TOKEN_REFRESH_PATH },
  runtimeManifest: { method: "GET", path: DESKTOP_RUNTIME_MANIFEST_PATH },
} as const;

export type DesktopDispatchTarget =
  | "messages"
  | "serverAuthored"
  | "turnTape"
  | "turnLease"
  | "catalog"
  | "catalogEpoch"
  | "tokenMint"
  | "tokenRefresh"
  | "runtimeManifest";

export function classifyDesktopPath(method: string, pathname: string): DesktopDispatchTarget | "engine_disabled" | "not_found" {
  const m = method.toUpperCase();
  if (m === "POST" && pathname === "/v1/messages") return "messages";
  if (m === "POST" && pathname === SERVER_AUTHORED_PATH) return "serverAuthored";
  if (m === "GET" && pathname === TURN_TAPE_STATE_PATH) return "turnTape";
  if (m === "POST" && pathname === TURN_LEASE_RENEW_PATH) return "turnLease";
  if (m === "GET" && pathname === MODEL_CATALOG_PATH) return "catalog";
  if (m === "GET" && pathname === MODEL_CATALOG_EPOCH_PATH) return "catalogEpoch";
  if (m === "POST" && pathname === DESKTOP_TOKEN_MINT_PATH) return "tokenMint";
  if (m === "POST" && pathname === DESKTOP_TOKEN_REFRESH_PATH) return "tokenRefresh";
  if (m === "GET" && pathname === DESKTOP_RUNTIME_MANIFEST_PATH) return "runtimeManifest";
  return "not_found";
}

export function sendDesktopEngineDisabled(res: ServerResponse): void {
  sendJson(res, 403, { error: { code: DESKTOP_ENGINE_NOT_ENABLED, message: "engine not enabled on desktop" } });
}

export function sendDesktopNotFound(res: ServerResponse): void {
  sendJson(res, 404, { error: { code: "NOT_FOUND", message: "not found" } });
}

export function assertDesktopWhitelisted(method: string, pathname: string): DesktopDispatchTarget {
  const c = classifyDesktopPath(method, pathname);
  if (c === "engine_disabled") throw new HttpError(403, DESKTOP_ENGINE_NOT_ENABLED, "engine not enabled on desktop");
  if (c === "not_found") throw new HttpError(404, "NOT_FOUND", "not found");
  return c;
}

export function pathnameOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? "/", "http://desktop.invalid").pathname;
  } catch {
    return "/";
  }
}

/** Token mint/refresh belong on master 18445 (same process as register). Egress 404s them. */
export function desktopTokenAction(role: "master" | "egress", kind: DesktopDispatchTarget | "engine_disabled" | "not_found"): "handle" | "not_found" {
  if (kind !== "tokenMint" && kind !== "tokenRefresh") return "not_found";
  return role === "egress" ? "not_found" : "handle";
}

/** Runtime manifest is master 18445 only. Egress 404s it. Public 443 uses the commercial router JWT path. */
export function desktopRuntimeManifestAction(role: "master" | "egress", kind: DesktopDispatchTarget | "engine_disabled" | "not_found"): "handle" | "not_found" {
  if (kind !== "runtimeManifest") return "not_found";
  return role === "egress" ? "not_found" : "handle";
}
