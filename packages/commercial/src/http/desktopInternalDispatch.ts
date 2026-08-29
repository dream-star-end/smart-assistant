/**
 * 18445 pathname whitelist (design v2 §6.3). Unlisted → 404.
 * Grok/Codex/ZCode prefixes return 403 ENGINE_NOT_ENABLED without registering relays.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  CODEX_RELAY_PREFIX,
  GROK_RELAY_PREFIX,
  MODEL_CATALOG_EPOCH_PATH,
  MODEL_CATALOG_PATH,
  SERVER_AUTHORED_PATH,
  TURN_LEASE_RENEW_PATH,
  TURN_TAPE_STATE_PATH,
  ZCODE_RELAY_PREFIX,
} from "@openclaude/protocol";
import { HttpError, sendJson } from "./util.js";

export const DESKTOP_ENGINE_NOT_ENABLED = "ENGINE_NOT_ENABLED";

export const DESKTOP_ALLOWED_PATHS = {
  messages: { method: "POST", path: "/v1/messages" },
  serverAuthored: { method: "POST", path: SERVER_AUTHORED_PATH },
  turnTape: { method: "GET", path: TURN_TAPE_STATE_PATH },
  turnLease: { method: "POST", path: TURN_LEASE_RENEW_PATH },
  catalog: { method: "GET", path: MODEL_CATALOG_PATH },
  catalogEpoch: { method: "GET", path: MODEL_CATALOG_EPOCH_PATH },
} as const;

const RELAY_PREFIXES = [GROK_RELAY_PREFIX, CODEX_RELAY_PREFIX, ZCODE_RELAY_PREFIX];

export type DesktopDispatchTarget =
  | "messages"
  | "serverAuthored"
  | "turnTape"
  | "turnLease"
  | "catalog"
  | "catalogEpoch";

export function classifyDesktopPath(method: string, pathname: string): DesktopDispatchTarget | "engine_disabled" | "not_found" {
  const m = method.toUpperCase();
  if (m === "POST" && pathname === "/v1/messages") return "messages";
  if (m === "POST" && pathname === SERVER_AUTHORED_PATH) return "serverAuthored";
  if (m === "GET" && pathname === TURN_TAPE_STATE_PATH) return "turnTape";
  if (m === "POST" && pathname === TURN_LEASE_RENEW_PATH) return "turnLease";
  if (m === "GET" && pathname === MODEL_CATALOG_PATH) return "catalog";
  if (m === "GET" && pathname === MODEL_CATALOG_EPOCH_PATH) return "catalogEpoch";
  if (RELAY_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return "engine_disabled";
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
