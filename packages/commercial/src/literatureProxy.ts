/**
 * /v3/literature/search — container → master proxy → DeepXiv arxiv RAG。
 *
 * ### 拓扑
 *   container LLM
 *     → POST $ANTHROPIC_BASE_URL/v3/literature/search
 *     → master 18791(self-host plain)/ 18443(remote-host mTLS)
 *     → dispatchInternal 按 path 分流到本 handler
 *     → 双因子 verifyContainerIdentity(同 anthropicProxy)
 *     → 配额 + per-container limiter 闸门
 *     → fetch DeepXiv `<base>/arxiv/?type=retrieve&query=...&size=...`
 *     → JSON 回容器
 *
 * ### 不变量
 *   1. **Token 永远不进容器** — master 持有 DeepXiv token,本 handler 在 server fetch 时
 *      读 `getLiteratureConfig(false)` 拿明文,不通过任何 header 透传给容器。
 *   2. **域不混淆** — 本 handler 只接受 oc-v3.<containerId>.<secret> 容器 token,
 *      与 user API key 渠道严格分开;route 一旦绑死就不会被复用。
 *   3. **GET-then-INCR 原子配额** — Redis Lua 把"读 cap → 增 1 → 设 expire"做成
 *      一个 atomic step,counter 永不超 cap,不需要 DECR 回滚。
 *   4. **per-container in-memory 60req/5min** — 防个别 LLM 走 deepxiv 死循环把
 *      daily_cap 整光。LRU 上限 10000 entries,evict 走 oldest-first(进程重启即清 0,
 *      不持久化)。**已知技术债**:此 limiter 不跨进程,horizontal-scale 时需上 Redis。
 *
 * ### 错误映射(给容器看的 HTTP status)
 *   - 401 UNAUTHORIZED              身份双因子失败(同 anthropicProxy 语义)
 *   - 400 BAD_REQUEST               query 缺失 / size 越界
 *   - 429 RATE_LIMITED              per-container 触发(Retry-After 给秒数)
 *   - 429 DAILY_CAP_EXCEEDED        平台总闸触发(无 Retry-After,日切才恢复)
 *   - 503 SERVICE_DISABLED          admin 关闭了 enabled
 *   - 502 UPSTREAM_ERROR            DeepXiv 4xx/5xx 透传(不 leak 上游 body)
 *   - 504 UPSTREAM_TIMEOUT          配置 timeout_sec 内未返
 *   - 500 INTERNAL                  catch-all(主要是 redis_error)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ContainerIdentityError,
  type ContainerIdentityRepo,
  verifyContainerIdentity,
} from "./auth/containerIdentity.js";
import { getLiteratureConfig, type LiteratureDeepxivConfigRow } from "./admin/literatureConfig.js";

/**
 * 最小 redis 接口 — 只用到 EVAL。
 * 故意不依赖 ioredis 的 `Pick<Redis, "eval">`,后者有十多个 overload,
 * 测试 mock 没法逐一满足,反而把测试代码也污染掉。这里收敛到本模块需要的最窄签名。
 */
export interface LiteratureRedis {
  eval(
    script: string,
    numKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
}

export const LITERATURE_SEARCH_PATH = "/v3/literature/search";

/** ────── In-memory per-container limiter ────────────────────────────
 *
 * 60 requests / 5 min sliding window,LRU 上限 10000 容器 entries。
 * 重启即清 0 — 接受这一缺点,反正只是辅助闸,daily_cap 才是真正硬上限。
 */
const PER_CONTAINER_WINDOW_MS = 5 * 60 * 1000;
const PER_CONTAINER_MAX = 60;
const PER_CONTAINER_LRU_SIZE = 10_000;

interface ContainerBucket {
  /** 升序时间戳数组(尾部最新)。push 后会 trim 掉 < now - WINDOW_MS 的 prefix。 */
  ts: number[];
  /** 最近一次操作时间,用于 LRU 淘汰。 */
  lastSeen: number;
}

export interface PerContainerLimiterCheck {
  ok: boolean;
  /** 当前窗口内已用次数(包括本次拒绝时不增) */
  used: number;
  /** ok=false 时,建议 Retry-After 秒数(向上取整);ok=true 时 0。 */
  retryAfterSec: number;
}

/**
 * Per-container limiter — 进程内 LRU。导出工厂以便测试注入 now()。
 */
export function makePerContainerLimiter(opts?: {
  now?: () => number;
  maxEntries?: number;
  windowMs?: number;
  maxInWindow?: number;
}) {
  const now = opts?.now ?? (() => Date.now());
  const maxEntries = opts?.maxEntries ?? PER_CONTAINER_LRU_SIZE;
  const windowMs = opts?.windowMs ?? PER_CONTAINER_WINDOW_MS;
  const maxInWindow = opts?.maxInWindow ?? PER_CONTAINER_MAX;
  const map = new Map<number, ContainerBucket>();

  function trim(bucket: ContainerBucket, t: number): void {
    const cutoff = t - windowMs;
    let i = 0;
    while (i < bucket.ts.length && bucket.ts[i] < cutoff) i++;
    if (i > 0) bucket.ts.splice(0, i);
  }

  return {
    /**
     * 尝试预占一次。
     * - 命中上限 → 返 ok:false + retryAfterSec(下一个最老时间 + window - now)
     * - 否则 → 返 ok:true,记录时间戳,used+1
     */
    check(containerId: number): PerContainerLimiterCheck {
      const t = now();
      let bucket = map.get(containerId);
      if (bucket) {
        // 触动 LRU 顺序:Map JS 保证插入序 — delete + set 把它推到末尾
        map.delete(containerId);
      } else {
        bucket = { ts: [], lastSeen: t };
        if (map.size >= maxEntries) {
          // 淘汰最 oldest 的 entry。Map 迭代顺序即插入顺序(或被 delete+set 推到尾)
          const firstKey = map.keys().next().value;
          if (firstKey !== undefined) map.delete(firstKey);
        }
      }
      trim(bucket, t);
      bucket.lastSeen = t;
      if (bucket.ts.length >= maxInWindow) {
        const oldest = bucket.ts[0];
        const retryAfterMs = oldest + windowMs - t;
        // 重新放回 map 末尾,即使被拒也算"刚活过",避免高频被拒容器立刻被 LRU 淘汰
        map.set(containerId, bucket);
        return {
          ok: false,
          used: bucket.ts.length,
          retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)),
        };
      }
      bucket.ts.push(t);
      map.set(containerId, bucket);
      return { ok: true, used: bucket.ts.length, retryAfterSec: 0 };
    },
    _size(): number {
      return map.size;
    },
  };
}

/** ────── Daily cap Lua(GET-then-INCR,atomic) ──────────────────────
 *
 * KEYS[1] = daily counter key(`deepxiv:daily:<UTC_YYYYMMDD>`)
 * ARGV[1] = cap(string,作 tonumber 处理)
 * ARGV[2] = TTL seconds(整数字符串,EXPIRE 用)
 *
 * 返回:
 *   - 当前已计数 n (>= 1) 表示放行,本次已 +1
 *   - -1 表示已达 cap,本次未 +1
 *
 * Why GET-then-INCR(not INCR-then-DECR):counter 永不超 cap,也不会因为
 * "DECR 失败"产生漂移;并且对监控更友好(看到 n=cap 就知道刚好闸住)。
 */
const DAILY_CAP_SCRIPT = `
local v = tonumber(redis.call('GET', KEYS[1]) or '0')
local cap = tonumber(ARGV[1])
if v >= cap then return -1 end
local n = redis.call('INCR', KEYS[1])
if n == 1 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
end
return n
`;

/** UTC YYYYMMDD;不能用本地时区,跨 host 计数必须一致。 */
export function utcDayKey(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `deepxiv:daily:${y}${m}${d}`;
}

/** EXPIRE 48h:跨夜过渡时让昨日 key 自然过期,避免 EXPIRE 漂移问题。 */
const DAILY_KEY_TTL_SEC = 48 * 3600;

/** ────── Metrics(进程内单值计数器) ────────────────────────────────
 *
 * 不上 prom-client(与项目其他模块对齐 — hostReqCounter 也是进程内)。
 * 提供 getMetricsSnapshot() 给 ops 端点读;后续若要接 Prometheus 再适配。
 */
export type LiteratureResult =
  | "allowed"
  | "rejected_per_container"
  | "rejected_daily_cap"
  | "disabled"
  | "auth_failed"
  | "upstream_4xx"
  | "upstream_5xx"
  | "upstream_body_too_large"
  | "timeout"
  | "redis_error"
  | "config_read_error"
  | "bad_input";

const metrics: Record<LiteratureResult, number> = {
  allowed: 0,
  rejected_per_container: 0,
  rejected_daily_cap: 0,
  disabled: 0,
  auth_failed: 0,
  upstream_4xx: 0,
  upstream_5xx: 0,
  upstream_body_too_large: 0,
  timeout: 0,
  redis_error: 0,
  config_read_error: 0,
  bad_input: 0,
};

function incMetric(k: LiteratureResult): void {
  metrics[k] += 1;
}

export function getMetricsSnapshot(): Record<LiteratureResult, number> {
  return { ...metrics };
}

/** Tests only — 不在 prod 调用。 */
export function _resetMetricsForTest(): void {
  for (const k of Object.keys(metrics) as LiteratureResult[]) metrics[k] = 0;
}

// ─── Handler factory ───────────────────────────────────────────────

export interface LiteratureProxyDeps {
  identityRepo: ContainerIdentityRepo;
  /** ioredis client(与 commercial 主进程共用一个) */
  redis: LiteratureRedis;
  /** 读取最新配置。默认走 DB;promptSlot 已有缓存,但 proxy 走真权威源更稳。
   *  调用一次/请求 — 单行 indexed SELECT,< 1ms。不再加一层缓存:与 admin 改动后
   *  即时生效更对齐(NOTIFY 自动 + 主动 SELECT 兜底)。 */
  readConfig?: () => Promise<LiteratureDeepxivConfigRow>;
  /** fetchImpl 注入(测试用)。生产用 globalThis.fetch。 */
  fetchImpl?: typeof fetch;
  /** Per-container limiter 注入(测试用)。 */
  limiter?: ReturnType<typeof makePerContainerLimiter>;
  /** 服务端日志,默认 console.warn,失败路径用。生产把 rootLogger 传进来。 */
  log?: (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;
}

export interface LiteratureProxyHandlerCtx {
  hostUuid: string;
  boundIp: string;
}

export type LiteratureProxyHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: LiteratureProxyHandlerCtx,
) => Promise<void>;

const MAX_BODY_BYTES = 4 * 1024;
const MAX_QUERY_LEN = 512;
/**
 * 上游响应封顶 2 MiB。DeepXiv `?type=retrieve&size≤100` 单次返回理论上是几十 KB 量级
 * (每篇 metadata + abstract),2 MiB 给充足的 headroom 但能拦截"上游异常往死打"。
 * 超限 → 直接断开 stream + 502,绝不把超量数据 buffer 到内存里。
 */
const MAX_UPSTREAM_BYTES = 2 * 1024 * 1024;

interface SearchRequestBody {
  query: string;
  size?: number;
}

async function readBoundedJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > maxBytes) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  if (total === 0) return null;
  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw);
}

/**
 * 从 fetch Response.body 流式读取,**字节超限即立刻 cancel** 并抛错。
 * 比 `await res.json()` 安全:后者会无界 buffer 整 body,上游若返回 1 GB JSON
 * 会把 master 进程拖崩。这里硬上限 `maxBytes`,超过即 cancel(让 fetch 释放连接)+ 抛。
 *
 * 错误用 `Error("upstream_body_too_large")` 区分,handler 映射到 502 + metric。
 */
async function readUpstreamJson(res: Response, maxBytes: number): Promise<unknown> {
  const body = res.body;
  if (body === null) {
    // 上游空 body,JSON.parse('') 会抛 — 统一走 bad_json 路径
    throw new Error("upstream_bad_json");
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        // 取消 stream,让 fetch 关闭底层连接;reader 关闭由 finally 兜底
        await reader.cancel().catch(() => {});
        throw new Error("upstream_body_too_large");
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released after cancel */ }
  }
  if (total === 0) throw new Error("upstream_bad_json");
  // Buffer.concat 接受 Uint8Array;Node Buffer 兼容
  const raw = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("upstream_bad_json");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (headers) {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  }
  res.end(JSON.stringify(body));
}

function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  extra?: Record<string, string>,
): void {
  sendJson(res, status, { error: { code, message } }, extra);
}

/**
 * 构造 handler。所有依赖通过 deps 注入便于单测。
 */
export function makeLiteratureProxyHandler(deps: LiteratureProxyDeps): LiteratureProxyHandler {
  const fetchFn = deps.fetchImpl ?? globalThis.fetch;
  const readConfig = deps.readConfig ?? (() => getLiteratureConfig(false));
  const limiter = deps.limiter ?? makePerContainerLimiter();
  const log =
    deps.log ??
    ((level, msg, fields) => {
      // eslint-disable-next-line no-console
      console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
        `[literatureProxy] ${msg}`,
        fields ?? "",
      );
    });

  return async function handle(req, res, ctx) {
    if (req.method !== "POST") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "POST required");
      return;
    }

    // 1) 容器身份双因子(同 anthropicProxy)
    let identity: Awaited<ReturnType<typeof verifyContainerIdentity>>;
    try {
      identity = await verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization);
    } catch (err) {
      incMetric("auth_failed");
      if (err instanceof ContainerIdentityError) {
        log("warn", "identity_failed", { errcode: err.code, hostUuid: ctx.hostUuid, boundIp: ctx.boundIp });
        sendError(res, 401, "UNAUTHORIZED", "container identity verification failed");
        return;
      }
      log("error", "identity_threw", { err: (err as Error)?.message });
      sendError(res, 500, "INTERNAL", "identity check failed");
      return;
    }

    // 2) Body 解析
    let parsed: unknown;
    try {
      parsed = await readBoundedJson(req, MAX_BODY_BYTES);
    } catch (err) {
      incMetric("bad_input");
      const msg = (err as Error)?.message ?? "";
      if (msg === "body_too_large") {
        sendError(res, 413, "BODY_TOO_LARGE", "request body exceeds 4KB");
        return;
      }
      sendError(res, 400, "BAD_REQUEST", "request body must be valid JSON");
      return;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      incMetric("bad_input");
      sendError(res, 400, "BAD_REQUEST", "request body must be a JSON object");
      return;
    }
    const body = parsed as Record<string, unknown>;
    const queryRaw = body.query;
    if (typeof queryRaw !== "string") {
      incMetric("bad_input");
      sendError(res, 400, "BAD_REQUEST", "field 'query' must be a string");
      return;
    }
    const query = queryRaw.trim();
    if (query === "" || query.length > MAX_QUERY_LEN) {
      incMetric("bad_input");
      sendError(res, 400, "BAD_REQUEST", `field 'query' must be 1..${MAX_QUERY_LEN} chars`);
      return;
    }
    let sizeOpt: number | undefined;
    if (body.size !== undefined) {
      if (typeof body.size !== "number" || !Number.isInteger(body.size) || body.size <= 0 || body.size > 100) {
        incMetric("bad_input");
        sendError(res, 400, "BAD_REQUEST", "field 'size' must be integer 1..100");
        return;
      }
      sizeOpt = body.size;
    }

    // 3) 读配置(权威源 DB,单行 SELECT)
    let cfg: LiteratureDeepxivConfigRow;
    try {
      cfg = await readConfig();
    } catch (err) {
      log("error", "read_config_failed", { err: (err as Error)?.message });
      // 分离自 redis_error:这里覆盖 DB 不可达 / AeadError(KMS key 错配或密文损坏)
      incMetric("config_read_error");
      sendError(res, 500, "INTERNAL", "config read failed");
      return;
    }
    if (!cfg.enabled) {
      incMetric("disabled");
      sendError(res, 503, "SERVICE_DISABLED", "literature search is disabled by admin");
      return;
    }
    if (!cfg.token) {
      // enabled=true 但 token 空:配置半成品,等价 disabled
      incMetric("disabled");
      log("warn", "enabled_without_token");
      sendError(res, 503, "SERVICE_DISABLED", "literature search is not configured");
      return;
    }
    const size = sizeOpt ?? cfg.default_size;

    // 4) Per-container in-memory limiter
    const lim = limiter.check(identity.containerId);
    if (!lim.ok) {
      incMetric("rejected_per_container");
      log("info", "rejected_per_container", {
        containerId: identity.containerId,
        used: lim.used,
        retryAfter: lim.retryAfterSec,
      });
      sendError(
        res,
        429,
        "RATE_LIMITED",
        `per-container rate limit exceeded (${PER_CONTAINER_MAX}/5min)`,
        { "Retry-After": String(lim.retryAfterSec) },
      );
      return;
    }

    // 5) 每日总闸 Redis Lua(GET-then-INCR atomic)
    let dailyResult: number;
    try {
      dailyResult = (await deps.redis.eval(
        DAILY_CAP_SCRIPT,
        1,
        utcDayKey(),
        String(cfg.daily_cap),
        String(DAILY_KEY_TTL_SEC),
      )) as number;
    } catch (err) {
      incMetric("redis_error");
      log("error", "redis_eval_failed", { err: (err as Error)?.message });
      // Redis 挂时 fail-closed:拒绝放行,容器看到 500
      sendError(res, 500, "INTERNAL", "rate limiter unavailable");
      return;
    }
    if (dailyResult < 0) {
      incMetric("rejected_daily_cap");
      log("info", "rejected_daily_cap", { cap: cfg.daily_cap });
      sendError(res, 429, "DAILY_CAP_EXCEEDED", `platform daily cap (${cfg.daily_cap}) exhausted, retry tomorrow UTC`);
      return;
    }

    // 6) 调上游
    //
    // **timeout 必须覆盖 headers + body 读取整阶段**,不能在 fetch 拿到 headers 就清。
    // 慢 body / 不结束 body 是真实的反向 slowloris;只挡 2 MiB cap 是不够的。
    // 同时非 2xx 分支必须显式 cancel body —— undici 不主动 drain 时连接资源会滞留,
    // 反复 5xx 会放大占用。
    const url = `${cfg.base_url}/arxiv/?type=retrieve&query=${encodeURIComponent(query)}&size=${size}`;
    const ctrl = new AbortController();
    const timeoutMs = cfg.timeout_sec * 1000;
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    const isAbort = (err: unknown): boolean => (err as { name?: string })?.name === "AbortError";
    try {
      let upstreamRes: Response;
      try {
        upstreamRes = await fetchFn(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${cfg.token}` },
          signal: ctrl.signal,
        });
      } catch (err) {
        if (isAbort(err)) {
          incMetric("timeout");
          log("warn", "upstream_timeout", {
            containerId: identity.containerId,
            timeout_sec: cfg.timeout_sec,
            phase: "headers",
          });
          sendError(res, 504, "UPSTREAM_TIMEOUT", `deepxiv upstream timed out after ${cfg.timeout_sec}s`);
        } else {
          incMetric("upstream_5xx");
          log("error", "upstream_fetch_threw", { err: (err as Error)?.message });
          sendError(res, 502, "UPSTREAM_ERROR", "deepxiv upstream unreachable");
        }
        return;
      }

      if (!upstreamRes.ok) {
        // 透传 status code 大类,但不 leak body
        if (upstreamRes.status >= 500) incMetric("upstream_5xx");
        else incMetric("upstream_4xx");
        log("warn", "upstream_non_2xx", { status: upstreamRes.status });
        // 给容器一个 502(无论 4xx/5xx 都是"上游异常",容器不该重试身份/参数)
        // 显式 cancel body 让 undici 释放连接,catch 兜底防 cancel 本身抛
        await upstreamRes.body?.cancel().catch(() => { /* already errored / consumed */ });
        sendError(res, 502, "UPSTREAM_ERROR", `deepxiv upstream returned ${upstreamRes.status}`);
        return;
      }

      let json: unknown;
      try {
        json = await readUpstreamJson(upstreamRes, MAX_UPSTREAM_BYTES);
      } catch (err) {
        const msg = (err as Error)?.message ?? "";
        if (isAbort(err)) {
          // body 读取阶段被 timeout abort,与 headers 阶段同样归 timeout
          incMetric("timeout");
          log("warn", "upstream_timeout", {
            containerId: identity.containerId,
            timeout_sec: cfg.timeout_sec,
            phase: "body",
          });
          sendError(res, 504, "UPSTREAM_TIMEOUT", `deepxiv upstream timed out after ${cfg.timeout_sec}s`);
        } else if (msg === "upstream_body_too_large") {
          incMetric("upstream_body_too_large");
          log("warn", "upstream_body_too_large", { containerId: identity.containerId, cap: MAX_UPSTREAM_BYTES });
          sendError(res, 502, "UPSTREAM_ERROR", "deepxiv upstream response too large");
        } else {
          // bad JSON 或读 stream 中断(非 abort 非 size 类)
          incMetric("upstream_5xx");
          log("warn", "upstream_bad_json", { reason: msg });
          sendError(res, 502, "UPSTREAM_ERROR", "deepxiv upstream returned non-JSON");
        }
        return;
      }

      incMetric("allowed");
      sendJson(res, 200, json);
    } finally {
      // 兜底:任何分支退出都清 timer(避免 setTimeout 留下未触发的 abort 影响后续请求)
      clearTimeout(to);
    }
  };
}
