// MiniMax Token Plan Web Search 的 master 侧内网代理 handler。
//
// 为什么走 master 代理而不是容器直连:MiniMax Token Plan 的订阅 key
// (MINIMAX_TOKEN_PLAN_KEY)是平台机密,绝不能注入用户可控的容器(会被扒走滥用额度)。
// 与模型路由(key 留 master、容器调内网代理)同一安全模型:容器的 CCB WebSearch adapter
// POST 到本 handler(经 ANTHROPIC_BASE_URL 内网代理,双因子容器身份校验),master 注 key
// 转发到 MiniMax /v1/coding_plan/search,只回原始 organic 结果。
//
// 计费:Token Plan 是订阅制(时间窗口限流,非按次计费),故本 handler 不做 per-call 扣费
// (与 mediaProxy 的媒体按次计费不同)。
//
// 结构镜像 mediaProxy.ts(identity 校验 + directEgressDispatcher 直连 + baseRespOk 检查),
// 但去掉媒体的 billing/download 复杂度。

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

export const MINIMAX_WEB_SEARCH_PATH = "/internal/v3/minimax-search";

const API_BASE = "https://api.minimaxi.com";
const SEARCH_PATH = "/v1/coding_plan/search";
const UPSTREAM_TIMEOUT_MS = 30_000;
/** MiniMax coding_plan/search 单次最多返 10 条;上限 organic 结果数防止巨包。 */
const MAX_RESULTS = 10;
/** 同 host 最多保留几条(超出折叠丢弃):提升来源多样性,防单站刷屏。 */
const MAX_PER_HOST = 3;
/** 解析上游 organic 的原始条数上界(上游本就 ≤10;防御性防巨包)。 */
const RAW_PARSE_CAP = 50;

// 每容器固定窗口限流:身份校验能保证"活跃容器",但挡不住某容器循环打本路由耗尽共享
// MINIMAX_TOKEN_PLAN_KEY 的搜索额度(media 走计费、literature 有 cap;本路由无按次计费,
// 故加此轻量护栏)。per-master-instance 内存态(v3/v5 单机 master,够用;多实例只是各自计数)。
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_CONTAINER = 40;
const rateState = new Map<string, { count: number; windowStart: number }>();

function allowSearch(containerKey: string, now: number): boolean {
  // 顺带清理过期窗口,防止 map 无界增长。
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
export function __resetWebSearchRateState(): void {
  rateState.clear();
}

type HandlerCtx = { hostUuid: string; boundIp: string };

const SearchRequestSchema = z
  .object({ q: z.string().min(1).max(1000) })
  .strict();

export interface MiniMaxWebSearchHandlerDeps {
  identityRepo: ContainerIdentityRepo;
  /** MINIMAX_TOKEN_PLAN_KEY —— 只在 master 侧,绝不下发容器。 */
  tokenPlanKey?: string;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

export type MiniMaxWebSearchHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerCtx,
) => Promise<void>;

function isObj(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === "object" && !Array.isArray(v));
}

/** MiniMax base_resp.status_code 非 0(且非缺省)即上游错误(与 mediaProxy 同约定)。 */
function baseRespOk(json: unknown): boolean {
  if (!isObj(json)) return true;
  const br = json.base_resp;
  if (!isObj(br)) return true;
  const code = br.status_code;
  return code === undefined || code === 0;
}

function baseRespMessage(json: unknown): string {
  if (isObj(json) && isObj(json.base_resp) && typeof json.base_resp.status_msg === "string") {
    return json.base_resp.status_msg.slice(0, 200);
  }
  return "upstream error";
}

type Organic = { title: string; url: string; snippet: string; date?: string };

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** 解析+裁字段(link→url,保留 title/snippet/date);不排序、不去重(交由后续步骤)。 */
function parseOrganic(json: unknown): Organic[] {
  const organic = isObj(json) && Array.isArray(json.organic) ? json.organic : [];
  const out: Organic[] = [];
  for (const item of organic) {
    if (out.length >= RAW_PARSE_CAP) break;
    if (!isObj(item)) continue;
    const url = typeof item.link === "string" ? item.link : "";
    if (!url) continue;
    out.push({
      title: typeof item.title === "string" ? item.title : "",
      url,
      snippet: typeof item.snippet === "string" ? item.snippet : "",
      ...(typeof item.date === "string" && item.date ? { date: item.date } : {}),
    });
  }
  return out;
}

/**
 * 时效前移分:有 date 且越新 → 越大正向前移(至多 3 档);无 date/无法解析 → 0
 * (**不惩罚**,保持相关性原位)。未来日期(上游异常)按最新档处理。
 */
function recencyBonus(date: string | undefined, now: number): number {
  if (!date) return 0;
  const t = Date.parse(date);
  if (Number.isNaN(t)) return 0;
  const ageDays = (now - t) / 86_400_000;
  if (ageDays <= 7) return 3; // 一周内
  if (ageDays <= 30) return 2; // 一月内
  if (ageDays <= 180) return 1; // 半年内
  if (ageDays <= 365) return 0.5; // 一年内
  return 0; // 更旧不惩罚(与无 date 同)
}

/**
 * 时效重排:effectiveRank = 原始名次 − recencyBonus。有 date 的新结果适度前移(至多 3 位),
 * 无 date 不惩罚(bonus=0 → 保持原位基准)。稳定:tie 用原始名次(相关性)兜底。
 */
function rerankByRecency(items: Organic[], now: number): Organic[] {
  return items
    .map((it, idx) => ({ it, idx, eff: idx - recencyBonus(it.date, now) }))
    .sort((a, b) => a.eff - b.eff || a.idx - b.idx)
    .map((x) => x.it);
}

/**
 * 同 host 折叠:按当前顺序遍历,每 host 至多留 maxPerHost 条,超出丢弃
 * (无法解析 host 的不折叠,原样保留)。
 */
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

/**
 * 裁剪 organic → CCB adapter 需要的字段,并做:①时效加权重排(新结果适度前移,无 date
 * 不惩罚)②同 host 去重(超 MAX_PER_HOST 条折叠)③截断 MAX_RESULTS。字段透传
 * title/url/snippet/date。now 可注入(测试用),线上取 Date.now()。
 */
function trimOrganic(json: unknown, now: number = Date.now()): Organic[] {
  const parsed = parseOrganic(json);
  const reranked = rerankByRecency(parsed, now);
  const deduped = dedupeByHost(reranked, MAX_PER_HOST);
  return deduped.slice(0, MAX_RESULTS);
}

/** Test-only surface (mirrors mediaProxy's `__internal_*`). */
export const __internal_minimaxSearch = {
  trimOrganic,
  baseRespOk,
  recencyBonus,
  rerankByRecency,
  dedupeByHost,
};

export function makeMiniMaxWebSearchHandler(deps: MiniMaxWebSearchHandlerDeps): MiniMaxWebSearchHandler {
  const log = (deps.logger ?? rootLogger).child({ subsys: "minimaxWebSearchProxy" });
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
    if (!deps.tokenPlanKey) {
      reqLog.warn("minimax_search_not_configured");
      sendError(res, 503, "MINIMAX_NOT_CONFIGURED", "minimax search upstream not configured", requestId);
      return;
    }

    // 双因子容器身份校验(与 media/server-authored 同一 verifyContainerIdentity)。
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

    // 每容器限流护栏(见 rateState 注释)。用 containerId 作 key。
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
      const upstream = await fetchFn(`${API_BASE}${SEARCH_PATH}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${deps.tokenPlanKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ q: query }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        // minimaxi.com 是国内/亚洲端点:显式直连,绕开 gateway 全局给 Anthropic 出海用的日本代理
        // (否则海外→日本→中国双重跨境,易半路断)。理由同 mediaProxy.postJson。
        dispatcher: directEgressDispatcher(),
      } as RequestInit & { dispatcher: Dispatcher });

      const text = await upstream.text();
      let json: unknown = {};
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          throw new HttpError(502, "MINIMAX_BAD_RESPONSE", "minimax search returned invalid JSON");
        }
      }
      if (!upstream.ok || !baseRespOk(json)) {
        throw new HttpError(502, "MINIMAX_UPSTREAM_ERROR", baseRespMessage(json));
      }
      sendJson(res, 200, { organic: trimOrganic(json) });
    } catch (err) {
      if (err instanceof HttpError) {
        reqLog.warn("minimax_search_failed", { code: err.code, status: err.status });
        sendError(res, err.status, err.code, err.message, requestId);
        return;
      }
      // AbortSignal.timeout() 触发 → DOMException/Error name=TimeoutError → 504。
      if (err instanceof Error && err.name === "TimeoutError") {
        reqLog.warn("minimax_search_timeout");
        sendError(res, 504, "MINIMAX_UPSTREAM_TIMEOUT", "minimax search timed out", requestId);
        return;
      }
      // 其余 fetch 层错误(连接/DNS/reset:TypeError "fetch failed")当上游不可达 502,
      // 而非 master 内部 500 —— 这段 try 只包 upstream I/O。
      reqLog.warn("minimax_search_upstream_error", {
        err: err instanceof Error ? err.message : String(err),
      });
      sendError(res, 502, "MINIMAX_UPSTREAM_ERROR", "minimax search upstream unreachable", requestId);
    }
  };
}
