/**
 * platformContextLoader — 在 VolumeContextReader 之上加缓存层。
 *
 * 见 docs/V3_CC_EXTERNAL_ENDPOINT_PHASE5_PLAN_2026-05-21.md §3.7。
 *
 * 缓存语义:
 *   - LRU 1000 条目 — Map insertion-order 实现,每次命中 delete+set 重排
 *   - 60s soft TTL — 过期后下次 load 返 stale + 触发后台 refresh,不阻塞 hot path
 *   - 600s hard expiry — stale 太久(后台 refresh 一直挂)就强制同步 refresh
 *   - Negative cache 30s — reader 返 null(volume 不存在)也缓存,避免反复打读盘
 *   - mtime invalidation — refresh 时如果新 mtime 与旧 mtime 不同,自然替换(隐式实现)
 *
 * 错误处理:
 *   - reader 抛错(网络/cert/IO)→ loader swallow + 日志,返 null(stale 缓存可用时返 stale)
 *   - 这样设计是为保 H1:envelope rewrite 在 hot path,任何 RPC 故障都不能让外接 API 挂
 *   - builder 层拿 null 视为"空 platform context",在 system[N+1] 写最小 attribution
 *
 * 并发 dedupe:
 *   - 同一 userId 并行 refresh 通过 inflight Promise map 合并,只发一次 reader.read
 */

import { rootLogger } from "../logging/logger.js";
import type {
  PlatformContext,
  VolumeContextReader,
} from "./volumeContextReader.js";

const log = rootLogger.child({ subsys: "platform-context-loader" });

const DEFAULT_LRU_MAX = 1000;
const DEFAULT_SOFT_TTL_MS = 60_000;
const DEFAULT_NEGATIVE_TTL_MS = 30_000;
/**
 * stale 超过此值即强制同步 refresh。
 * 用于兜底 "后台 refresh 一直挂、stale 永远不更新" 的退化场景。
 */
const DEFAULT_HARD_EXPIRY_MS = 600_000;

export interface PlatformContextLoader {
  /**
   * 读取用户 platform context。
   *
   * 返 null 的情形(语义统一为 "没有可注入的 attribution"):
   *   - 用户从未启过容器(reader 返 null,negative cache 命中)
   *   - reader 调用失败(网络 / cert / fs IO)且无可用 stale 缓存
   *
   * 永不抛错:caller 在外接 API hot path 里,任何故障都用 null 兜底以保 H1。
   */
  load(userId: bigint): Promise<PlatformContext | null>;

  /**
   * 主动失效。caller 在已知用户 USER.md/MEMORY.md 写入后调用(future Phase 5.2 用)。
   * 当前 plan 不接 hook,但暴露此 API 便于 unit test 和未来接入。
   */
  invalidate(userId: bigint): void;
}

interface CacheEntry {
  /** "ctx" = 有效 platform context;"absent" = volume 不存在(negative cache)。 */
  kind: "ctx" | "absent";
  ctx: PlatformContext | null; // kind=absent 时为 null
  fetchedAt: number;
}

export interface PlatformContextLoaderDeps {
  reader: VolumeContextReader;
  /** 测试 hook;默认 Date.now。 */
  now?: () => number;
  lruMax?: number;
  softTtlMs?: number;
  negativeTtlMs?: number;
  hardExpiryMs?: number;
}

export function makePlatformContextLoader(
  deps: PlatformContextLoaderDeps,
): PlatformContextLoader {
  const reader = deps.reader;
  const now = deps.now ?? (() => Date.now());
  const lruMax = deps.lruMax ?? DEFAULT_LRU_MAX;
  const softTtl = deps.softTtlMs ?? DEFAULT_SOFT_TTL_MS;
  const negativeTtl = deps.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
  const hardExpiry = deps.hardExpiryMs ?? DEFAULT_HARD_EXPIRY_MS;

  // Map insertion-order = LRU:get 命中即 delete+set 重排到尾部
  const cache = new Map<string, CacheEntry>();
  // 并发 dedupe:同一 userId 的 refresh 只一发,其它 caller 复用同一 Promise
  const inflight = new Map<string, Promise<CacheEntry | null>>();

  function touch(key: string, e: CacheEntry): void {
    cache.delete(key);
    cache.set(key, e);
  }

  function evictIfFull(): void {
    while (cache.size >= lruMax) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  function isStale(e: CacheEntry): boolean {
    const ttl = e.kind === "absent" ? negativeTtl : softTtl;
    return now() - e.fetchedAt >= ttl;
  }

  function isHardExpired(e: CacheEntry): boolean {
    return now() - e.fetchedAt >= hardExpiry;
  }

  /**
   * 实际打 reader 拿数据 + 写缓存。同一 key 并发调用通过 inflight map 合并。
   * reader 失败 → 返 null;caller 决定是不是用 stale 兜底。
   */
  async function fetchAndCache(key: string): Promise<CacheEntry | null> {
    const existing = inflight.get(key);
    if (existing) return existing;

    const p = (async () => {
      try {
        const userId = BigInt(key);
        const ctx = await reader.read(userId);
        const entry: CacheEntry =
          ctx === null
            ? { kind: "absent", ctx: null, fetchedAt: now() }
            : { kind: "ctx", ctx, fetchedAt: now() };
        evictIfFull();
        cache.delete(key);
        cache.set(key, entry);
        return entry;
      } catch (err) {
        log.warn("platform-context fetch failed", {
          userId: key,
          err: errToObj(err),
        });
        return null;
      }
    })();

    inflight.set(key, p);
    try {
      return await p;
    } finally {
      inflight.delete(key);
    }
  }

  return {
    async load(userId) {
      if (userId <= 0n) {
        // 防御性:builder 层有 userId 校验,这里只是兜底
        log.warn("platform-context load: invalid userId", { userId: userId.toString() });
        return null;
      }
      const key = userId.toString();
      const entry = cache.get(key);

      if (entry && !isHardExpired(entry)) {
        // 命中,LRU 重排
        touch(key, entry);
        if (isStale(entry)) {
          // 后台 refresh,不 await — caller 立刻拿 stale 数据
          void fetchAndCache(key).catch((err) => {
            // fetchAndCache 已内部 catch,这里理论永不触发;留作 defense in depth
            log.error("platform-context background refresh threw", { err: errToObj(err) });
          });
        }
        return entry.kind === "absent" ? null : entry.ctx;
      }

      // miss 或 hard-expired:同步 fetch
      const fresh = await fetchAndCache(key);
      if (fresh === null) {
        // fetch 失败且没缓存(hard-expired 也会走到这,因为我们没 fallback 到 stale)
        // 注:hard-expired 情形 entry 还在 map 里,但 isHardExpired 已判 true 不返。
        // 真要兜底可以返 stale,但 plan 没要求,保持简单。
        return null;
      }
      return fresh.kind === "absent" ? null : fresh.ctx;
    },

    invalidate(userId) {
      const key = userId.toString();
      cache.delete(key);
    },
  };
}

function errToObj(err: unknown): { name?: string; message?: string; code?: string } {
  if (err instanceof Error) {
    const out: { name?: string; message?: string; code?: string } = {
      name: err.name,
      message: err.message,
    };
    const maybeCode = (err as { code?: unknown }).code;
    if (typeof maybeCode === "string") out.code = maybeCode;
    return out;
  }
  return { message: String(err) };
}
