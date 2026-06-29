/**
 * /v3/research/* — 容器 → master 科研能力 proxy(Phase 1:oc-lit + oc-cite)。
 *
 * 拓扑同 literatureProxy:container CLI → master 18791/18443 → dispatchInternal
 * → verifyContainerIdentity 双因子 → 配额闸 → master 侧执行(查 OpenAlex/Crossref/
 * arXiv;读 research_config 的 mailto/secrets)→ JSON 回容器。
 *
 * 路由:
 *   POST /v3/research/lit/search   {query, sources?, size?, yearMin?, lang?} → {sources, warnings}
 *   POST /v3/research/cite/verify  {identifiers: string[]} → {verdicts}
 *   POST /v3/research/cite/format  {identifier, style} → {verdict}
 *
 * 不变量:平台 secret(S2/Unpaywall 等)留 master,不进容器;enabled=false → 503;
 * 免费源无 key,降级时单源失败进 warnings(见 litSearch)。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ContainerIdentityError,
  type ContainerIdentityRepo,
  verifyContainerIdentity,
} from "../auth/containerIdentity.js";
import { ensureRequestId, REQUEST_ID_HEADER, setSecurityHeaders } from "../http/util.js";
import {
  type ResearchConfigPublic,
  type ResearchSecrets,
  getResearchConfigPublic,
  getResearchSecrets,
} from "../admin/researchConfig.js";
import type { FetchLike } from "./sources.js";
import { type LitSourceName, searchMultiSource } from "./litSearch.js";
import { formatRecord, verifyIdentifier, verifyIdentifiers } from "./cite.js";

export const RESEARCH_PREFIX = "/v3/research/";

const MAX_BODY_BYTES = 16 * 1024;

/** 最小 redis 接口(只用 EVAL),同 literatureProxy。 */
export interface ResearchRedis {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

// ─── per-container 限流(进程内滑窗;辅助闸,重启清零) ──────────────────
const PER_CONTAINER_WINDOW_MS = 60_000;
const PER_CONTAINER_MAX = 30; // 30 req/min/容器
const LRU_SIZE = 10_000;

interface Bucket {
  ts: number[];
  lastSeen: number;
}

export interface PerContainerLimiter {
  check(containerId: number, now: number): boolean;
}

export function makePerContainerLimiter(
  windowMs = PER_CONTAINER_WINDOW_MS,
  max = PER_CONTAINER_MAX,
): PerContainerLimiter {
  const buckets = new Map<number, Bucket>();
  return {
    check(containerId, now) {
      let b = buckets.get(containerId);
      if (!b) {
        b = { ts: [], lastSeen: now };
        buckets.set(containerId, b);
        if (buckets.size > LRU_SIZE) {
          // 淘汰最久未用
          let oldestK = -1;
          let oldestT = Number.POSITIVE_INFINITY;
          for (const [k, v] of buckets) {
            if (v.lastSeen < oldestT) {
              oldestT = v.lastSeen;
              oldestK = k;
            }
          }
          if (oldestK >= 0) buckets.delete(oldestK);
        }
      }
      b.lastSeen = now;
      const cutoff = now - windowMs;
      b.ts = b.ts.filter((t) => t > cutoff);
      if (b.ts.length >= max) return false;
      b.ts.push(now);
      return true;
    },
  };
}

const DAILY_CAP_SCRIPT = `
local v = tonumber(redis.call('GET', KEYS[1]) or '0')
local cap = tonumber(ARGV[1])
if v >= cap then return -1 end
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2])) end
return n
`;
const DAILY_KEY_TTL_SEC = 48 * 3600;

function utcDayKey(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `research:daily:${y}${m}${d}`;
}

// ─── handler ─────────────────────────────────────────────────────────

export interface ResearchProxyDeps {
  identityRepo: ContainerIdentityRepo;
  redis?: ResearchRedis | null;
  // 测试 hooks
  readConfig?: () => Promise<ResearchConfigPublic>;
  readSecrets?: () => Promise<ResearchSecrets>;
  fetchImpl?: FetchLike;
  limiter?: PerContainerLimiter;
  now?: () => number;
  log?: (level: "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;
}

export interface ResearchProxyHandlerCtx {
  hostUuid: string;
  boundIp: string;
}

export type ResearchProxyHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ResearchProxyHandlerCtx,
) => Promise<void>;

async function readBoundedJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > maxBytes) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  if (total === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res: ServerResponse, status: number, body: unknown, requestId: string): void {
  if (res.headersSent) return;
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    [REQUEST_ID_HEADER]: requestId,
  });
  res.end(json);
}

function sendErr(res: ServerResponse, status: number, code: string, message: string, requestId: string): void {
  sendJson(res, status, { error: { code, message }, request_id: requestId }, requestId);
}

export function makeResearchProxyHandler(deps: ResearchProxyDeps): ResearchProxyHandler {
  const limiter = deps.limiter ?? makePerContainerLimiter();
  const readConfig = deps.readConfig ?? getResearchConfigPublic;
  const readSecrets = deps.readSecrets ?? getResearchSecrets;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});

  return async function handle(req, res, ctx) {
    setSecurityHeaders(res);
    const requestId = ensureRequestId(req);
    res.setHeader(REQUEST_ID_HEADER, requestId);

    if (req.method !== "POST") {
      sendErr(res, 405, "METHOD_NOT_ALLOWED", "POST required", requestId);
      return;
    }

    // 1) 身份双因子
    let identity: { containerId: number; userId: number };
    try {
      identity = await verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization);
    } catch (err) {
      if (err instanceof ContainerIdentityError) {
        sendErr(res, 401, "UNAUTHORIZED", "container identity verification failed", requestId);
        return;
      }
      throw err;
    }

    // 2) 配置闸
    let cfg: ResearchConfigPublic;
    try {
      cfg = await readConfig();
    } catch (err) {
      log("error", "config_read_failed", { err: String(err) });
      sendErr(res, 500, "INTERNAL", "config read failed", requestId);
      return;
    }
    if (!cfg.enabled) {
      sendErr(res, 503, "SERVICE_DISABLED", "research capability disabled", requestId);
      return;
    }

    // 3) per-container 限流
    if (!limiter.check(identity.containerId, now())) {
      res.setHeader("Retry-After", "10");
      sendErr(res, 429, "RATE_LIMITED", "too many requests for this container", requestId);
      return;
    }

    // 4) daily cap(可选:redis + config.limits.dailyCap)
    const dailyCap = cfg.config.limits.dailyCap;
    if (deps.redis && typeof dailyCap === "number" && dailyCap > 0) {
      try {
        const n = (await deps.redis.eval(
          DAILY_CAP_SCRIPT,
          1,
          utcDayKey(new Date(now())),
          dailyCap,
          DAILY_KEY_TTL_SEC,
        )) as number;
        if (n === -1) {
          sendErr(res, 429, "DAILY_CAP_EXCEEDED", "platform daily research cap reached", requestId);
          return;
        }
      } catch (err) {
        // redis 抖动不阻断(daily cap 是软上限),记日志放行
        log("warn", "daily_cap_redis_error", { err: String(err) });
      }
    }

    // 5) body + 路由
    const path = (req.url ?? "/").split("?")[0];
    let body: Record<string, unknown>;
    try {
      const parsed = await readBoundedJson(req, MAX_BODY_BYTES);
      body = (parsed ?? {}) as Record<string, unknown>;
    } catch (err) {
      const tooBig = err instanceof Error && err.message === "body_too_large";
      sendErr(res, tooBig ? 413 : 400, tooBig ? "BODY_TOO_LARGE" : "BAD_REQUEST", "invalid request body", requestId);
      return;
    }

    try {
      if (path === `${RESEARCH_PREFIX}lit/search`) {
        await handleLitSearch(res, body, cfg, readSecrets, deps.fetchImpl, requestId);
        return;
      }
      if (path === `${RESEARCH_PREFIX}cite/verify`) {
        await handleCiteVerify(res, body, cfg, deps.fetchImpl, requestId);
        return;
      }
      if (path === `${RESEARCH_PREFIX}cite/format`) {
        await handleCiteFormat(res, body, cfg, deps.fetchImpl, requestId);
        return;
      }
      sendErr(res, 404, "NOT_FOUND", `unknown research route ${path}`, requestId);
    } catch (err) {
      log("error", "research_handler_failed", { path, err: String(err) });
      sendErr(res, 500, "INTERNAL", "research op failed", requestId);
    }
  };
}

const VALID_SOURCES: LitSourceName[] = ["openalex", "crossref", "arxiv"];

async function handleLitSearch(
  res: ServerResponse,
  body: Record<string, unknown>,
  cfg: ResearchConfigPublic,
  readSecrets: () => Promise<ResearchSecrets>,
  fetchImpl: FetchLike | undefined,
  requestId: string,
): Promise<void> {
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) {
    sendErr(res, 400, "BAD_REQUEST", "query required", requestId);
    return;
  }
  const sources = Array.isArray(body.sources)
    ? (body.sources.filter((s) => VALID_SOURCES.includes(s as LitSourceName)) as LitSourceName[])
    : undefined;
  const size = typeof body.size === "number" ? body.size : undefined;
  const yearMin = typeof body.yearMin === "number" ? body.yearMin : undefined;
  const lang = body.lang === "zh" || body.lang === "en" ? body.lang : undefined;

  // secrets 仅在需要(目前 unpaywall email 在 config 非密;S2 key 是 secret,Phase 1 未接 S2 源)
  await readSecrets().catch(() => ({}));

  const result = await searchMultiSource(
    { query, sources, size, yearMin, lang },
    {
      mailto: cfg.config.litSources.crossrefMailto ?? cfg.config.litSources.openalexMailto,
      unpaywallEmail: cfg.config.litSources.unpaywallEmail,
      fetchImpl,
    },
  );
  sendJson(res, 200, result, requestId);
}

async function handleCiteVerify(
  res: ServerResponse,
  body: Record<string, unknown>,
  cfg: ResearchConfigPublic,
  fetchImpl: FetchLike | undefined,
  requestId: string,
): Promise<void> {
  const ids = Array.isArray(body.identifiers)
    ? body.identifiers.filter((x): x is string => typeof x === "string").slice(0, 50)
    : [];
  if (ids.length === 0) {
    sendErr(res, 400, "BAD_REQUEST", "identifiers[] required", requestId);
    return;
  }
  const verdicts = await verifyIdentifiers(ids, {
    mailto: cfg.config.litSources.crossrefMailto,
    fetchImpl,
  });
  sendJson(res, 200, { verdicts }, requestId);
}

async function handleCiteFormat(
  res: ServerResponse,
  body: Record<string, unknown>,
  cfg: ResearchConfigPublic,
  fetchImpl: FetchLike | undefined,
  requestId: string,
): Promise<void> {
  const identifier = typeof body.identifier === "string" ? body.identifier : "";
  const style =
    body.style === "bibtex" || body.style === "apa" || body.style === "gb-t-7714-2015"
      ? body.style
      : "gb-t-7714-2015";
  if (!identifier) {
    sendErr(res, 400, "BAD_REQUEST", "identifier required", requestId);
    return;
  }
  const verdict = await verifyIdentifier(identifier, { mailto: cfg.config.litSources.crossrefMailto, fetchImpl });
  if (!verdict.resolved || !verdict.record) {
    sendJson(res, 200, { verdict }, requestId);
    return;
  }
  sendJson(res, 200, { verdict: { ...verdict, formatted: formatRecord(verdict.record, style) } }, requestId);
}
