/**
 * v3 file proxy — 容器 `/healthz.capabilities` 探测缓存。
 *
 * **用途**:转发 /api/file / /api/media/* 前,先探测目标容器的 /healthz 是否广播
 * 目标 capability(如 `file-proxy-v1`)。一次 /healthz 命中 → 60s 内不再重复探,
 * 降低每次下载都多一次 RTT 的开销。
 *
 * **不含 invalidate**:r6 设计里有"容器 rotate 时主动清 cache",MVP 砍掉 —— 只要
 * TTL ≤ 60s,即便 containerId 复用也最多 1 分钟内返 OUTDATED 一次,用户刷新即恢复。
 * 换来的代码 / 测试量显著下降。
 *
 * **containerId echo 校验**:/healthz 返回里 `containerId` 必须等于 status.containerId
 * —— 防"bridge IP 被换给另一个容器,capability 仍在但绑定错"的边缘情况。不 echo 就
 * 视为缺 capability。
 */

import type { V3ContainerStatus } from "../agent-sandbox/v3supervisor.js";

const CACHE_TTL_MS = 60_000;
const HEALTHZ_TIMEOUT_MS = 1_000;

interface CacheEntry {
  caps: Set<string>;
  exp: number;
}

const cache = new Map<number, CacheEntry>();

export interface HealthzResponse {
  containerId?: string | null;
  capabilities?: unknown;
}

export type FetchHealthzFn = (
  boundIp: string,
  port: number,
  timeoutMs: number,
) => Promise<HealthzResponse>;

/**
 * 默认用 node:http 的 `fetch`(Bun / Node 18+ 都原生支持),1s timeout 靠 AbortSignal.timeout。
 * 测试可传 `fetchImpl` 注入 mock 避免开真 TCP。
 */
async function defaultFetchHealthz(
  boundIp: string,
  port: number,
  timeoutMs: number,
): Promise<HealthzResponse> {
  const res = await fetch(`http://${boundIp}:${port}/healthz`, {
    method: "GET",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`/healthz status=${res.status}`);
  return (await res.json()) as HealthzResponse;
}

export interface CapabilityProbeDeps {
  fetchHealthz?: FetchHealthzFn;
  /** 测试钩子:显式传入 "now" 毫秒 */
  nowMs?: () => number;
}

/**
 * 判断 status 指向的容器是否广播了所有 `capsRequired` 能力。
 *
 * - 缓存命中且未过期 → 直接判
 * - 缓存过期或不存在 → 探一次 /healthz,写入缓存;探失败或 containerId 不匹配 → 返 false
 */
export async function isContainerCapabilityReady(
  status: Pick<V3ContainerStatus, "containerId" | "boundIp" | "port">,
  capsRequired: readonly string[],
  deps: CapabilityProbeDeps = {},
): Promise<boolean> {
  const now = (deps.nowMs ?? Date.now)();
  const hit = cache.get(status.containerId);
  if (hit && hit.exp > now) {
    return capsRequired.every((c) => hit.caps.has(c));
  }
  const fetchImpl = deps.fetchHealthz ?? defaultFetchHealthz;
  let resp: HealthzResponse;
  try {
    resp = await fetchImpl(status.boundIp, status.port, HEALTHZ_TIMEOUT_MS);
  } catch {
    return false;
  }
  // containerId echo 匹配:防 bridge IP 复用给另一个容器
  if (String(resp.containerId ?? "") !== String(status.containerId)) {
    return false;
  }
  const caps = new Set<string>(
    Array.isArray(resp.capabilities)
      ? resp.capabilities.filter((x): x is string => typeof x === "string")
      : [],
  );
  cache.set(status.containerId, { caps, exp: now + CACHE_TTL_MS });
  return capsRequired.every((c) => caps.has(c));
}

/** 测试用:清空缓存(避免 test 间串扰) */
export function __resetCapabilityCacheForTest(): void {
  cache.clear();
}
