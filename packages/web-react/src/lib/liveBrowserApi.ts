/**
 * Live cloud browser workbench API client (OCV5-813 / OCV5-857).
 *
 * Strictly lazy-imported by LiveBrowserStage so it stays outside the first-screen JS bundle.
 * Routes through `/api/agents/:id/browser/{live,action,stream-ticket}` using the standard
 * Bearer + singleflight refresh transport (`callWithRefresh` + `jsonOrThrow`).
 */
import type {
  LiveBrowserDialogInfo,
  LiveBrowserMouseButton,
  LiveBrowserStreamTicketResponse,
  LiveBrowserTab,
  LiveBrowserViewport,
} from "@openclaude/protocol/browser";
import { bearerHeaders, callWithRefresh, jsonOrThrow } from "./api/http";
import type { AuthSession } from "./types";

export type { LiveBrowserDialogInfo, LiveBrowserMouseButton, LiveBrowserStreamTicketResponse, LiveBrowserViewport };

export interface LiveBrowserTabInfo extends LiveBrowserTab {}

export interface LiveBrowserState {
  available: boolean;
  active: boolean;
  agentBusy?: boolean;
  humanTakeover?: boolean;
  takeoverToken?: string;
  loading?: boolean;
  reason?: string;
  url?: string;
  origin?: string;
  targetId?: string;
  navGen?: number;
  cdpAvailable?: boolean;
  streamAvailable?: boolean;
  title?: string;
  viewport?: LiveBrowserViewport;
  tabs?: LiveBrowserTabInfo[];
  dialog?: LiveBrowserDialogInfo | null;
  imageBase64?: string;
  mimeType?: "image/jpeg" | "image/png";
  capturedAt?: number;
}

export type LiveBrowserActionPayload =
  | { action: "open"; url?: string; ifIdle?: boolean }
  | { action: "goto"; url: string }
  | { action: "back" }
  | { action: "forward" }
  | { action: "reload" }
  | { action: "stop" }
  | { action: "close" }
  | { action: "takeover"; active: boolean; token?: string }
  | {
      action: "click";
      x: number;
      y: number;
      normalized?: boolean;
      button?: LiveBrowserMouseButton;
      expectedOrigin?: string;
    }
  | { action: "dblclick"; x: number; y: number; normalized?: boolean; expectedOrigin?: string }
  | { action: "hover"; x: number; y: number; normalized?: boolean; expectedOrigin?: string }
  | {
      action: "drag";
      fromX: number;
      fromY: number;
      toX: number;
      toY: number;
      normalized?: boolean;
      expectedOrigin?: string;
    }
  | {
      action: "wheel";
      x?: number;
      y?: number;
      normalized?: boolean;
      deltaX: number;
      deltaY: number;
      expectedOrigin?: string;
    }
  | { action: "type"; text: string; submit?: boolean; expectedOrigin?: string }
  | { action: "paste"; text: string; expectedOrigin?: string }
  | { action: "press"; key: string; expectedOrigin?: string }
  | { action: "dialog"; accept: boolean; promptText?: string }
  | { action: "resize"; width: number; height: number }
  | { action: "tab_select"; index: number }
  | { action: "tab_new"; url?: string }
  | { action: "tab_close"; index?: number };

export const DEFAULT_ACTION_TIMEOUT_MS = 15_000;
export const DEFAULT_TICKET_TIMEOUT_MS = 10_000;

function browserBaseUrl(agentId: string): string {
  return `/api/agents/${encodeURIComponent(agentId)}/browser`;
}

/** Combine an optional external AbortSignal with a hard timeout so requests never deadlock. */
function createTimeoutController(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; didTimeout: () => boolean; cleanup: () => void } {
  const ctrl = new AbortController();
  let timedOut = false;

  const onExternalAbort = () => {
    ctrl.abort(externalSignal?.reason);
  };
  if (externalSignal) {
    if (externalSignal.aborted) {
      ctrl.abort(externalSignal.reason);
    } else {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  const timer =
    timeoutMs > 0 && Number.isFinite(timeoutMs)
      ? globalThis.setTimeout(() => {
          timedOut = true;
          ctrl.abort();
        }, timeoutMs)
      : null;

  const cleanup = () => {
    if (timer !== null) globalThis.clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
  };

  return { signal: ctrl.signal, didTimeout: () => timedOut, cleanup };
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

async function browserPostJson<T>(
  auth: AuthSession,
  url: string,
  body: string,
  signal?: AbortSignal,
  keepalive?: boolean,
): Promise<T> {
  return jsonOrThrow<T>(
    callWithRefresh(auth, (token) =>
      fetch(url, {
        method: "POST",
        credentials: "include",
        headers: bearerHeaders(token, true),
        body,
        signal,
        ...(keepalive ? { keepalive: true } : {}),
      }),
    ),
  );
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

export async function requestLiveBrowserStreamTicket(
  auth: AuthSession,
  agentId: string,
  signal?: AbortSignal,
): Promise<LiveBrowserStreamTicketResponse> {
  const url = `${browserBaseUrl(agentId)}/stream-ticket`;
  const timeout = createTimeoutController(signal, DEFAULT_TICKET_TIMEOUT_MS);
  try {
    return await browserPostJson<LiveBrowserStreamTicketResponse>(auth, url, "{}", timeout.signal);
  } catch (err) {
    if (timeout.didTimeout()) {
      throw new Error("申请实时浏览器连接票据超时");
    }
    throw err;
  } finally {
    timeout.cleanup();
  }
}

export async function sendLiveBrowserAction(
  auth: AuthSession,
  agentId: string,
  payload: LiveBrowserActionPayload,
  opts?: { signal?: AbortSignal; timeoutMs?: number; keepalive?: boolean },
): Promise<LiveBrowserState> {
  const url = `${browserBaseUrl(agentId)}/action`;
  const timeout = createTimeoutController(opts?.signal, opts?.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS);
  try {
    return await browserPostJson<LiveBrowserState>(
      auth,
      url,
      JSON.stringify(payload),
      timeout.signal,
      opts?.keepalive,
    );
  } catch (err) {
    if (timeout.didTimeout()) {
      throw new Error("云端浏览器操作超时，请重试");
    }
    throw err;
  } finally {
    timeout.cleanup();
  }
}
