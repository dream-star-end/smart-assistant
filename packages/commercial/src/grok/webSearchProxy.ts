// Master-side fallback for CCB WebSearch when MiniMax search is down.
//
// The Grok subscription token stays on the master, same rule as the MiniMax
// search key: the container only presents its identity token. This handler
// borrows one active Grok account, calls the official CLI chat proxy's
// Responses API with the server-side web_search tool, and returns organic
// hits. It does not take a grok-build slot; it is the failure path, not the
// hot path.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Dispatcher } from "undici";
import { request as undiciRequest } from "undici";
import { z } from "zod";

import { directEgressDispatcher } from "../account-pool/egressDispatcher.js";
import { getFreshGrokAccessToken } from "../account-pool/grokOAuth.js";
import {
  ContainerIdentityError,
  verifyContainerIdentity,
  type ContainerIdentityRepo,
} from "../auth/containerIdentity.js";
import { query } from "../db/queries.js";
import { rootLogger, type Logger } from "../logging/logger.js";
import {
  ensureRequestId,
  HttpError,
  readJsonBody,
  REQUEST_ID_HEADER,
  sendError,
  sendJson,
  setSecurityHeaders,
} from "../http/util.js";
import { classifyGrokRelayStatus } from "../http/internalGrokRelay.js";

export const GROK_WEB_SEARCH_PATH = "/internal/v3/grok-search";
export const GROK_SEARCH_UPSTREAM = "https://cli-chat-proxy.grok.com/v1/responses";

const UPSTREAM_TIMEOUT_MS = 22_000;
const MAX_RESULTS = 8;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_CONTAINER = 8;
const rateState = new Map<string, { count: number; windowStart: number }>();

const SearchRequestSchema = z.object({ q: z.string().min(1).max(1000) }).strict();

export interface OrganicHit {
  title: string;
  url: string;
  snippet: string;
  date?: string;
}

type HandlerCtx = { hostUuid: string; boundIp: string };

type UpstreamResponse = {
  statusCode: number;
  body: { text: () => Promise<string> };
};

export interface GrokWebSearchHandlerDeps {
  identityRepo: ContainerIdentityRepo;
  logger?: Logger;
  pickAccountId?: () => Promise<bigint | null>;
  freshToken?: (accountId: bigint) => Promise<Buffer>;
  requestFn?: (
    url: string,
    init: {
      method: "POST";
      headers: Record<string, string>;
      body: string;
      dispatcher?: Dispatcher;
      headersTimeout: number;
      bodyTimeout: number;
    },
  ) => Promise<UpstreamResponse>;
  recordStatus?: (accountId: bigint, statusCode: number) => Promise<void>;
  now?: () => number;
}

export type GrokWebSearchHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerCtx,
) => Promise<void>;

function allowSearch(containerKey: string, now: number): boolean {
  if (rateState.size > 4096) {
    for (const [k, s] of rateState) if (now - s.windowStart >= RATE_WINDOW_MS) rateState.delete(k);
  }
  const s = rateState.get(containerKey);
  if (!s || now - s.windowStart >= RATE_WINDOW_MS) {
    rateState.set(containerKey, { count: 1, windowStart: now });
    return true;
  }
  if (s.count >= RATE_MAX_PER_CONTAINER) return false;
  s.count += 1;
  return true;
}

export function __resetGrokWebSearchRateState(): void {
  rateState.clear();
}

function isObj(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === "object" && !Array.isArray(v));
}

function httpUrl(value: unknown): string {
  return typeof value === "string" && /^https?:\/\//i.test(value) ? value : "";
}

function hitFromRecord(raw: Record<string, unknown>): OrganicHit | null {
  const url = httpUrl(raw.url) || httpUrl(raw.link);
  if (!url) return null;
  const date = typeof raw.date === "string" && raw.date ? raw.date : undefined;
  return {
    title: typeof raw.title === "string" ? raw.title : "",
    url,
    snippet: typeof raw.snippet === "string" ? raw.snippet : "",
    ...(date ? { date } : {}),
  };
}

function parseModelJson(text: string): OrganicHit[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  const rows = isObj(parsed) && Array.isArray(parsed.results) ? parsed.results : [];
  const out: OrganicHit[] = [];
  for (const row of rows) {
    if (!isObj(row)) continue;
    const hit = hitFromRecord(row);
    if (hit) out.push(hit);
  }
  return out;
}

function dedupe(items: OrganicHit[]): OrganicHit[] {
  const seen = new Set<string>();
  const out: OrganicHit[] = [];
  for (const item of items) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    out.push(item);
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

/** Prefer the model's titled JSON. Fall back to raw search-call URLs. */
export function organicFromGrokResponse(json: unknown): OrganicHit[] {
  const output = isObj(json) && Array.isArray(json.output) ? json.output : [];
  const fromJson: OrganicHit[] = [];
  const fromSources: OrganicHit[] = [];
  for (const item of output) {
    if (!isObj(item)) continue;
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const block of item.content) {
        if (isObj(block) && typeof block.text === "string") fromJson.push(...parseModelJson(block.text));
      }
    }
    if (item.type !== "web_search_call" || !isObj(item.action)) continue;
    const sources = Array.isArray(item.action.sources) ? item.action.sources : [];
    for (const source of sources) {
      if (!isObj(source)) continue;
      const url = httpUrl(source.url);
      if (url) fromSources.push({ title: "", url, snippet: "" });
    }
  }
  return dedupe(fromJson.length > 0 ? fromJson : fromSources);
}

function searchBody(query: string): string {
  return JSON.stringify({
    model: "grok-4.7",
    input: [
      {
        role: "user",
        content:
          `只用网页搜索一次。查询：${query}\n` +
          '只输出 JSON：{"results":[{"title":"","url":"","snippet":""}]}，最多 5 条，不要解释。',
      },
    ],
    tools: [{ type: "web_search" }],
    reasoning: { effort: "low" },
    max_output_tokens: 700,
    max_tool_calls: 1,
    store: false,
  });
}

async function defaultPickAccountId(): Promise<bigint | null> {
  const result = await query<{ id: string }>(
    `SELECT id::text AS id
       FROM claude_accounts
      WHERE provider = 'grok' AND status = 'active'
      ORDER BY last_used_at ASC NULLS FIRST
      LIMIT 1`,
  );
  const id = result.rows[0]?.id;
  return id ? BigInt(id) : null;
}

async function defaultRecordStatus(accountId: bigint, statusCode: number): Promise<void> {
  const outcome = classifyGrokRelayStatus(statusCode);
  // 5xx is the provider, not this account. Do not bump fail_count for it.
  if (outcome === "client_error" || outcome === "upstream") return;
  if (outcome === "success") {
    await query(
      `UPDATE claude_accounts
          SET success_count = success_count + 1, last_used_at = NOW(), last_error = NULL, updated_at = NOW()
        WHERE id = $1 AND provider = 'grok'`,
      [String(accountId)],
    );
    return;
  }
  await query(
    `UPDATE claude_accounts
        SET fail_count = fail_count + 1, last_used_at = NOW(), last_error = $2, updated_at = NOW()
      WHERE id = $1 AND provider = 'grok'`,
    [String(accountId), `grok_search_http_${statusCode}`],
  );
}

export function makeGrokWebSearchHandler(deps: GrokWebSearchHandlerDeps): GrokWebSearchHandler {
  const log = (deps.logger ?? rootLogger).child({ subsys: "grokWebSearchProxy" });
  const pickAccountId = deps.pickAccountId ?? defaultPickAccountId;
  const freshToken = deps.freshToken ?? ((id: bigint) => getFreshGrokAccessToken(id));
  const requestFn = deps.requestFn ?? ((url, init) => undiciRequest(url, init));
  const recordStatus = deps.recordStatus ?? defaultRecordStatus;
  const now = deps.now ?? Date.now;

  return async function handle(req, res, ctx) {
    setSecurityHeaders(res);
    const requestId = ensureRequestId(req);
    res.setHeader(REQUEST_ID_HEADER, requestId);
    const reqLog = log.child({ requestId, hostUuid: ctx.hostUuid, boundIp: ctx.boundIp });

    if (req.method !== "POST") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "POST required", requestId);
      return;
    }

    let verified;
    try {
      verified = await verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization);
    } catch (err) {
      if (err instanceof ContainerIdentityError) {
        reqLog.warn("identity_failed", { errcode: err.code });
        sendError(res, 401, "UNAUTHORIZED", "container identity verification failed", requestId);
        return;
      }
      throw err;
    }

    if (!allowSearch(String(verified.containerId), now())) {
      reqLog.warn("rate_limited", { containerId: String(verified.containerId) });
      sendError(res, 429, "RATE_LIMITED", "grok search rate limit exceeded", requestId);
      return;
    }

    let searchQuery: string;
    try {
      const raw = await readJsonBody(req);
      const parsed = SearchRequestSchema.safeParse(raw);
      if (!parsed.success) {
        sendError(res, 400, "BAD_BODY", "invalid request body (expected {q})", requestId);
        return;
      }
      searchQuery = parsed.data.q;
    } catch (err) {
      if (err instanceof HttpError) {
        sendError(res, err.status, err.code, err.message, requestId);
        return;
      }
      throw err;
    }

    let accountId: bigint | null;
    try {
      accountId = await pickAccountId();
    } catch (err) {
      reqLog.warn("grok_account_pick_failed", { err: err instanceof Error ? err.message : String(err) });
      sendError(res, 503, "GROK_SEARCH_NOT_CONFIGURED", "grok search account lookup failed", requestId);
      return;
    }
    if (accountId === null) {
      sendError(res, 503, "GROK_SEARCH_NOT_CONFIGURED", "no active grok account", requestId);
      return;
    }

    let accessToken: Buffer | null = null;
    try {
      accessToken = await freshToken(accountId);
      const bearer = accessToken.toString("utf8");
      const upstream = await requestFn(GROK_SEARCH_UPSTREAM, {
        method: "POST",
        dispatcher: directEgressDispatcher(),
        headersTimeout: UPSTREAM_TIMEOUT_MS,
        bodyTimeout: UPSTREAM_TIMEOUT_MS,
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
          accept: "application/json",
          "x-xai-token-auth": "xai-grok-cli",
          "x-authenticateresponse": "authenticate-response",
          "x-grok-model-override": "grok-build",
          "x-grok-client-mode": "headless",
          "x-grok-client-version": "1.0.5",
          "x-grok-client-identifier": "openclaude-search",
        },
        body: searchBody(searchQuery),
      });
      const text = await upstream.body.text();
      void recordStatus(accountId, upstream.statusCode).catch(() => {});
      if (upstream.statusCode >= 400) {
        throw new HttpError(502, "GROK_UPSTREAM_ERROR", "grok search upstream rejected the request");
      }
      let json: unknown = {};
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          throw new HttpError(502, "GROK_BAD_RESPONSE", "grok search returned invalid JSON");
        }
      }
      const organic = organicFromGrokResponse(json);
      if (organic.length === 0 && !text.includes("web_search_call") && !text.includes('"results"')) {
        throw new HttpError(502, "GROK_BAD_RESPONSE", "grok search returned no results");
      }
      sendJson(res, 200, { organic });
    } catch (err) {
      if (err instanceof HttpError) {
        reqLog.warn("grok_search_failed", { code: err.code, status: err.status });
        sendError(res, err.status, err.code, err.message, requestId);
        return;
      }
      const name = err instanceof Error ? err.name : "";
      if (name === "TimeoutError" || name === "HeadersTimeoutError" || name === "BodyTimeoutError") {
        reqLog.warn("grok_search_timeout");
        sendError(res, 504, "GROK_UPSTREAM_TIMEOUT", "grok search timed out", requestId);
        return;
      }
      reqLog.warn("grok_search_upstream_error", {
        err: err instanceof Error ? err.message : String(err),
      });
      sendError(res, 502, "GROK_UPSTREAM_ERROR", "grok search upstream unreachable", requestId);
    } finally {
      accessToken?.fill(0);
    }
  };
}
