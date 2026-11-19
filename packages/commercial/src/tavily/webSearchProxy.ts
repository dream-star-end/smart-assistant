// Tavily Web Search 的 master 侧内网代理 handler。
//
// 安全模型同 minimax/webSearchProxy.ts:TAVILY_API_KEY 只留 master,
// 绝不注入容器。容器调用 /internal/v3/tavily-search(双因子容器身份校验),
// master 注入 key 转发到 https://api.tavily.com/search,只回标准化 organic 结果。

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Dispatcher } from "undici";
import { z } from "zod";

import { directEgressDispatcher } from "../account-pool/egressDispatcher.js";
import {
  ContainerIdentityError,
  verifyContainerIdentity,
  type ContainerIdentityRepo,
} from "../auth/containerIdentity.js";
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

export const TAVILY_WEB_SEARCH_PATH = "/internal/v3/tavily-search";

const API_URL = "https://api.tavily.com/search";
const UPSTREAM_TIMEOUT_MS = 20_000;
const MAX_RESULTS = 10;
const MAX_PER_HOST = 3;
const RAW_PARSE_CAP = 50;

const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_CONTAINER = 40;
const rateState = new Map<string, { count: number; windowStart: number }>();

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

/** 测试用:清空限流态。 */
export function __resetTavilyWebSearchRateState(): void {
  rateState.clear();
}

type HandlerCtx = { hostUuid: string; boundIp: string };

const SearchRequestSchema = z
  .object({ q: z.string().min(1).max(1000) })
  .strict();

export interface TavilyWebSearchHandlerDeps {
  identityRepo: ContainerIdentityRepo;
  /** TAVILY_API_KEY —— 只在 master 侧,绝不下发容器。 */
  apiKey?: string;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

export type TavilyWebSearchHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerCtx,
) => Promise<void>;

type Organic = { title: string; url: string; snippet: string; date?: string };

function isObj(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === "object" && !Array.isArray(v));
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function parseResults(json: unknown): Organic[] {
  const results = isObj(json) && Array.isArray(json.results) ? json.results : [];
  const out: Organic[] = [];
  for (const item of results) {
    if (out.length >= RAW_PARSE_CAP) break;
    if (!isObj(item)) continue;
    const url = typeof item.url === "string" ? item.url : "";
    if (!/^https?:\/\//i.test(url)) continue;
    const date =
      typeof item.published_date === "string" && item.published_date
        ? item.published_date
        : typeof item.date === "string" && item.date
          ? item.date
          : undefined;
    out.push({
      title: typeof item.title === "string" ? item.title : "",
      url,
      snippet: typeof item.content === "string" ? item.content : "",
      ...(date ? { date } : {}),
    });
  }
  return out;
}

function dedupeByHost(items: Organic[], maxPerHost: number): Organic[] {
  const seen = new Map<string, number>();
  const out: Organic[] = [];
  for (const it of items) {
    const h = hostOf(it.url);
    if (h === null) {
      out.push(it);
      continue;
    }
    const n = seen.get(h) ?? 0;
    if (n >= maxPerHost) continue;
    seen.set(h, n + 1);
    out.push(it);
  }
  return out;
}

function trimTavilyResults(json: unknown): Organic[] {
  return dedupeByHost(parseResults(json), MAX_PER_HOST).slice(0, MAX_RESULTS);
}

export const __internal_tavilySearch = {
  trimTavilyResults,
  dedupeByHost,
};

export function makeTavilyWebSearchHandler(
  deps: TavilyWebSearchHandlerDeps,
): TavilyWebSearchHandler {
  const log = (deps.logger ?? rootLogger).child({ subsys: "tavilyWebSearchProxy" });
  const fetchFn = deps.fetchImpl ?? fetch;

  return async function handle(req, res, ctx) {
    setSecurityHeaders(res);
    const requestId = ensureRequestId(req);
    res.setHeader(REQUEST_ID_HEADER, requestId);
    const reqLog = log.child({ requestId, hostUuid: ctx.hostUuid, boundIp: ctx.boundIp });

    if (req.method !== "POST") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "POST required", requestId);
      return;
    }
    if (!deps.apiKey) {
      sendError(res, 503, "TAVILY_NOT_CONFIGURED", "tavily search upstream not configured", requestId);
      return;
    }

    let verified: Awaited<ReturnType<typeof verifyContainerIdentity>>;
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

    if (!allowSearch(String(verified.containerId), Date.now())) {
      reqLog.warn("rate_limited", { containerId: String(verified.containerId) });
      sendError(res, 429, "RATE_LIMITED", "web search rate limit exceeded", requestId);
      return;
    }

    let query: string;
    try {
      const raw = await readJsonBody(req);
      const r = SearchRequestSchema.safeParse(raw);
      if (!r.success) {
        sendError(res, 400, "BAD_BODY", "invalid request body (expected {q})", requestId);
        return;
      }
      query = r.data.q;
    } catch (err) {
      if (err instanceof HttpError) {
        sendError(res, err.status, err.code, err.message, requestId);
        return;
      }
      throw err;
    }

    try {
      const upstream = await fetchFn(API_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${deps.apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          query,
          max_results: MAX_RESULTS,
          search_depth: "basic",
        }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        dispatcher: directEgressDispatcher(),
      } as RequestInit & { dispatcher: Dispatcher });

      const text = await upstream.text();
      if (!upstream.ok) {
        throw new HttpError(
          502,
          "TAVILY_UPSTREAM_ERROR",
          `tavily search upstream HTTP ${upstream.status}`,
        );
      }
      let json: unknown = {};
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          throw new HttpError(502, "TAVILY_BAD_RESPONSE", "tavily search returned invalid JSON");
        }
      }
      sendJson(res, 200, { organic: trimTavilyResults(json) });
    } catch (err) {
      if (err instanceof HttpError) {
        reqLog.warn("tavily_search_failed", { code: err.code, status: err.status });
        sendError(res, err.status, err.code, err.message, requestId);
        return;
      }
      if (err instanceof Error && err.name === "TimeoutError") {
        reqLog.warn("tavily_search_timeout");
        sendError(res, 504, "TAVILY_UPSTREAM_TIMEOUT", "tavily search timed out", requestId);
        return;
      }
      reqLog.warn("tavily_search_upstream_error", {
        err: err instanceof Error ? err.message : String(err),
      });
      sendError(res, 502, "TAVILY_UPSTREAM_ERROR", "tavily search upstream unreachable", requestId);
    }
  };
}
