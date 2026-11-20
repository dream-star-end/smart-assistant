/**
 * Live cloud browser workbench API client (OCV5-813).
 *
 * Strictly lazy-imported by LiveBrowserStage so it stays outside the first-screen JS bundle.
 * Routes through `/api/agents/:id/browser/{live,action}` using the standard Bearer + singleflight
 * refresh transport (`callWithRefresh` + `jsonOrThrow`).
 */
import { bearerHeaders, callWithRefresh, jsonOrThrow } from "./api/http";
import type { AuthSession } from "./types";

export interface LiveBrowserTabInfo {
  index: number;
  title: string;
  url: string;
  active: boolean;
}

export interface LiveBrowserState {
  available: boolean;
  active: boolean;
  agentBusy?: boolean;
  reason?: string;
  url?: string;
  title?: string;
  viewport?: { width: number; height: number };
  tabs?: LiveBrowserTabInfo[];
  imageBase64?: string;
  mimeType?: "image/jpeg" | "image/png";
  capturedAt?: number;
}

export type LiveBrowserActionPayload =
  | { action: "open"; url?: string }
  | { action: "goto"; url: string }
  | { action: "back" }
  | { action: "forward" }
  | { action: "reload" }
  | { action: "close" }
  | { action: "click"; x: number; y: number; normalized?: boolean; button?: "left" | "right" }
  | { action: "dblclick"; x: number; y: number; normalized?: boolean }
  | { action: "wheel"; x?: number; y?: number; normalized?: boolean; deltaX: number; deltaY: number }
  | { action: "type"; text: string; submit?: boolean }
  | { action: "press"; key: string }
  | { action: "tab_select"; index: number }
  | { action: "tab_new"; url?: string }
  | { action: "tab_close"; index?: number };

function browserBaseUrl(agentId: string): string {
  return `/api/agents/${encodeURIComponent(agentId)}/browser`;
}

/** Normalize user-typed address bar input into a valid http(s) URL (or null if unsafe). */
export function normalizeBrowserUrlInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export async function fetchLiveBrowserState(
  auth: AuthSession,
  agentId: string,
  opts?: { includeFrame?: boolean; quality?: number; signal?: AbortSignal },
): Promise<LiveBrowserState> {
  const params = new URLSearchParams();
  if (opts?.includeFrame === false) params.set("frame", "0");
  if (typeof opts?.quality === "number") params.set("quality", String(Math.round(opts.quality)));
  const qs = params.toString();
  const url = `${browserBaseUrl(agentId)}/live${qs ? `?${qs}` : ""}`;
  return jsonOrThrow<LiveBrowserState>(
    callWithRefresh(auth, (token) =>
      fetch(url, {
        method: "GET",
        credentials: "include",
        headers: bearerHeaders(token),
        signal: opts?.signal,
      }),
    ),
  );
}

export async function sendLiveBrowserAction(
  auth: AuthSession,
  agentId: string,
  payload: LiveBrowserActionPayload,
  opts?: { signal?: AbortSignal },
): Promise<LiveBrowserState> {
  const url = `${browserBaseUrl(agentId)}/action`;
  return jsonOrThrow<LiveBrowserState>(
    callWithRefresh(auth, (token) =>
      fetch(url, {
        method: "POST",
        credentials: "include",
        headers: bearerHeaders(token, true),
        body: JSON.stringify(payload),
        signal: opts?.signal,
      }),
    ),
  );
}
