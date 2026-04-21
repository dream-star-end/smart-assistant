/**
 * 2026-04-21 安全审计 HIGH#5 — chat 路径绑账号 egress_proxy。
 *
 * 背景:`claude_accounts.egress_proxy` 给每个 OAuth 账号绑定一个固定出口
 * 代理(format `http(s)://[user:pass@]host[:port]`,见 0010 migration),目的是
 * 让 Anthropic 反 abuse 系统看到每个账号的 source IP 都稳定 —— 否则同一 token
 * 一会儿从 docker host A 出去,一会儿从 host B 出去,触发 anti-abuse 风控会被
 * 临时封号。
 *
 * 现状(HIGH#5 之前):`scheduler.pick()` 已经把 egress_proxy 字段一路带到了
 * `anthropicProxy` 主函数,但 `fetchInit.dispatcher` 那里有个 "Phase 3 supervisor
 * 集成时再补" 的 TODO,实际从未被设置 —— 上游 fetch 直接走 host 默认路由,
 * 整套 per-account 稳定 IP 设计形同虚设。refresh.ts 已经支持 dispatcher 透传
 * 了(`RefreshDeps.dispatcher`),所以这层只需要把"按 account 派发 ProxyAgent"
 * 集中起来。
 *
 * 设计:
 *   - undici 的 `ProxyAgent` 是 Dispatcher 子类,本身有 connection pool;一个
 *     account 只需要一个长寿命 dispatcher,大量请求复用,**不是**每次都 new。
 *   - cache key = `${accountId}|${proxyUrl}`:proxy URL 由 admin 经
 *     `PATCH /admin/accounts/:id` 改,改了就要新 dispatcher;account_id 单独
 *     入 key 是为了"两账号配同一 proxy 时共用 0 个 dispatcher 还是各持 1 个"
 *     这种事简单,直接各持 1 个,connection pool 各算各的,排查问题更可控。
 *   - 改 proxy URL → close 老 dispatcher。`ProxyAgent.close()` 在底层 SSE socket
 *     仍然持有时会 hang(见 account-pool/proxy.ts:253 注释),所以用
 *     `Promise.race` + 5s timeout —— 兜底丢资源换不阻塞 admin 改配置。
 *   - LRU 上限 64:防 admin 反复改配置 / 大量短命账号导致 dispatcher 累积漏 FD。
 *   - `null / 空字符串 / undefined` proxyUrl → 返 undefined(走默认 dispatcher)。
 *
 * 安全:
 *   - undici proxy 默认 CONNECT(对 HTTPS 上游),proxy 看到的只是 TLS 密文,
 *     看不到 Authorization / refresh_token。所以代理本身被穿透不会泄露 OAuth。
 *   - URL 里如带 user:pass,validateEgressProxy(store.ts) 已要求 `new URL()`
 *     可解析 → 此处直接 trust raw string 传给 ProxyAgent({ uri }),undici 会
 *     正确处理 userinfo。我们不在 log 里打 raw url(可能含密码),只打 host。
 */

import { ProxyAgent, type Dispatcher } from "undici";
import { rootLogger } from "../logging/logger.js";

/** LRU 上限。一个商用部署的活跃账号一般 < 20 个,64 留余量。 */
export const EGRESS_DISPATCHER_CACHE_MAX = 64;

/** close ProxyAgent 的超时。SSE 持流时 close 会等到流结束;超时丢资源。 */
export const EGRESS_DISPATCHER_CLOSE_TIMEOUT_MS = 5_000;

interface CacheEntry {
  key: string;
  proxyUrl: string;
  dispatcher: Dispatcher;
  /** lru:每次命中刷新 lastUsed,evict 取最小。 */
  lastUsed: number;
}

const _cache = new Map<string, CacheEntry>();

/** key = `${accountId}|${proxyUrl}`,允许同 account 切代理时共存一瞬间。 */
function _cacheKey(accountId: bigint | string, proxyUrl: string): string {
  return `${String(accountId)}|${proxyUrl}`;
}

/** 仅暴露 host(去 userinfo + path),用于 log,不打密码。 */
function _proxyHostForLog(proxyUrl: string): string {
  try {
    const u = new URL(proxyUrl);
    return `${u.protocol}//${u.hostname}${u.port ? ":" + u.port : ""}`;
  } catch {
    return "<malformed>";
  }
}

/**
 * 取/建账号专属出口 dispatcher。
 *   - proxyUrl 空 → undefined(caller 透传给 fetch,等于走默认出口)
 *   - 命中 cache → 复用(刷 lastUsed)
 *   - 同 account 不同 proxyUrl → close 老的,建新
 *   - cache 满 → evict LRU,close 之
 *
 * 失败(URL 解析挂)→ 返 undefined 并 warn。**不抛**:chat 路径不应因为
 * "你 admin 配错了 proxy" 直接 502;退化到默认出口让请求过,Anthropic 看到
 * 异常 IP 自然会触发 health 扣分。
 */
export function getDispatcherForAccount(
  accountId: bigint | string,
  proxyUrl: string | null | undefined,
): Dispatcher | undefined {
  if (proxyUrl == null || proxyUrl.length === 0) {
    // 切回 "无代理":如果之前同 account 缓存了 dispatcher,清掉防漏 FD
    _evictByAccount(accountId);
    return undefined;
  }
  const key = _cacheKey(accountId, proxyUrl);
  const hit = _cache.get(key);
  if (hit) {
    hit.lastUsed = Date.now();
    return hit.dispatcher;
  }
  // 同 account 但 URL 变了 → 干掉旧 entry(close 异步,不阻塞)
  _evictByAccount(accountId);

  let dispatcher: Dispatcher;
  try {
    dispatcher = new ProxyAgent({ uri: proxyUrl });
  } catch (err) {
    rootLogger.child({ subsys: "egressDispatcher" }).warn("egress_proxy_invalid", {
      accountId: String(accountId),
      proxyHost: _proxyHostForLog(proxyUrl),
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
  _cache.set(key, { key, proxyUrl, dispatcher, lastUsed: Date.now() });
  if (_cache.size > EGRESS_DISPATCHER_CACHE_MAX) {
    _evictLruOnce();
  }
  return dispatcher;
}

/** 同 account 任一 proxyUrl 的 dispatcher 都干掉。close 异步 fire-and-forget。 */
function _evictByAccount(accountId: bigint | string): void {
  const prefix = `${String(accountId)}|`;
  for (const [k, entry] of _cache) {
    if (k.startsWith(prefix)) {
      _cache.delete(k);
      _scheduleClose(entry);
    }
  }
}

function _evictLruOnce(): void {
  let oldestKey: string | null = null;
  let oldestTs = Number.POSITIVE_INFINITY;
  for (const [k, entry] of _cache) {
    if (entry.lastUsed < oldestTs) {
      oldestTs = entry.lastUsed;
      oldestKey = k;
    }
  }
  if (oldestKey == null) return;
  const evicted = _cache.get(oldestKey)!;
  _cache.delete(oldestKey);
  _scheduleClose(evicted);
}

function _scheduleClose(entry: CacheEntry): void {
  // close 可能 hang(SSE 流未结束),用 Promise.race + timeout 保护
  const closePromise = (async () => {
    try {
      await entry.dispatcher.close();
    } catch {
      /* ignore — 已 closed / errored */
    }
  })();
  const timeoutPromise = new Promise<void>((resolve) => {
    setTimeout(resolve, EGRESS_DISPATCHER_CLOSE_TIMEOUT_MS).unref();
  });
  void Promise.race([closePromise, timeoutPromise]);
}

/** gateway shutdown 时调:把所有 dispatcher 都关掉 + 清缓存。 */
export async function closeAllEgressDispatchers(): Promise<void> {
  const entries = [...(_cache.values())];
  _cache.clear();
  await Promise.all(
    entries.map(async (entry) => {
      try {
        await Promise.race([
          entry.dispatcher.close(),
          new Promise<void>((resolve) => setTimeout(resolve, EGRESS_DISPATCHER_CLOSE_TIMEOUT_MS).unref()),
        ]);
      } catch {
        /* ignore */
      }
    }),
  );
}

/** 仅供测试:不 close,直接清 cache(close ProxyAgent 在 jest/node:test 进程后期会卡住)。 */
export function _clearEgressDispatcherCacheForTest(): void {
  _cache.clear();
}

/** 仅供测试:cache 大小。 */
export function _egressDispatcherCacheSizeForTest(): number {
  return _cache.size;
}
