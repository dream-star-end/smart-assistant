/**
 * v3 file proxy — 容器 `/healthz.capabilities` 探测缓存。
 *
 * **用途**:转发 /api/file / /api/media/* 前,先探测目标容器的 /healthz 是否广播
 * 目标 capability(如 `file-proxy-v1`)。一次 /healthz 命中 → 60s 内不再重复探,
 * 降低每次下载都多一次 RTT 的开销。
 *
 * **多 host 路由**:
 *   - status.hostId === selfHostId(或 selfHostId 缺失)→ 直 fetch boundIp:port/healthz
 *   - status.hostId !== selfHostId → 必须走 node-agent tunnel(`tunnelFetchHealthz`),
 *     因为 docker bridge IP(172.30.x/16)只在 host 内可达,master 不可路由。
 *
 * **不含 invalidate**:r6 设计里有"容器 rotate 时主动清 cache",MVP 砍掉 —— 只要
 * TTL ≤ 60s,即便 containerId 复用也最多 1 分钟内返 OUTDATED 一次,用户刷新即恢复。
 * 换来的代码 / 测试量显著下降。
 *
 * **containerId echo 校验**:/healthz 返回里 `containerId` 必须等于 status.containerId
 * —— 防"bridge IP 被换给另一个容器,capability 仍在但绑定错"的边缘情况。不 echo 就
 * 视为缺 capability。
 */

import { Agent } from 'undici'
import type { V3ContainerStatus } from '../agent-sandbox/v3supervisor.js'

const CACHE_TTL_MS = 60_000
// 单次 healthz 探活超时。同时用作 connect / head read / body read 三段 budget
// (每段独立计时 — 不是总和)。
//
// 历史:v1.0.73 初版 1s,本机容器 (loopback fetch) 完全够;但 v1.0.75 实测远端
// host (master GCE Tokyo → boheyun-1 中国) 跨境 mTLS handshake 单独就 600-1200ms,
// head + body 后续各段共享 1s budget 时频繁 race 失败,导致 file-proxy 503 风暴。
// 改 5s — 本机容器 healthz 通常 <5ms 立即 resolve(timer 永不到期),无副作用;
// 远端容器 budget 充裕,handshake + head + body 各段独立 5s 远超实测峰值。
const HEALTHZ_TIMEOUT_MS = 5_000

// Gateway startup installs undici's EnvHttpProxyAgent globally when HTTP_PROXY is
// configured for outbound OAuth / upstream traffic. Container healthz probes are
// strictly bridge-local (`172.30.x.x`) control-plane calls and must never go
// through that residential proxy; EnvHttpProxyAgent/NO_PROXY CIDR handling is not
// reliable enough for this path and caused `/api/media-signed` downloads to fail
// with CONTAINER_OUTDATED even while the container's /healthz was healthy.
const directHealthzDispatcher = new Agent()

interface CacheEntry {
  caps: Set<string>
  exp: number
}

const cache = new Map<number, CacheEntry>()

export interface HealthzResponse {
  containerId?: string | null
  capabilities?: unknown
}

export type FetchHealthzFn = (
  boundIp: string,
  port: number,
  timeoutMs: number,
) => Promise<HealthzResponse>

/**
 * 远端 host healthz fetcher。
 *
 * `containerInternalId` 必须是 docker hex ID(node-agent tunnel `{cid}` 段),
 * 与 V3ContainerStatus.dockerContainerId 一致。
 */
export type TunnelFetchHealthzFn = (
  hostId: string,
  containerInternalId: string,
  timeoutMs: number,
) => Promise<HealthzResponse>

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
    method: 'GET',
    signal: AbortSignal.timeout(timeoutMs),
    dispatcher: directHealthzDispatcher,
  } as RequestInit & { dispatcher: Agent })
  if (!res.ok) throw new Error(`/healthz status=${res.status}`)
  return (await res.json()) as HealthzResponse
}

export interface CapabilityProbeDeps {
  fetchHealthz?: FetchHealthzFn
  /** 远端 host 走 node-agent tunnel 的 fetcher;远端容器必须注入,否则视为不可达 */
  tunnelFetchHealthz?: TunnelFetchHealthzFn
  /** 本机 host UUID。缺失 = 单机 monolith,所有容器走本地 fetch 分支 */
  selfHostId?: string
  /** 测试钩子:显式传入 "now" 毫秒 */
  nowMs?: () => number
}

/**
 * 判断 status 指向的容器是否广播了所有 `capsRequired` 能力。
 *
 * - 缓存命中且未过期 → 直接判
 * - 缓存过期或不存在:按 hostId 选本地 / tunnel 分支探一次 → 写缓存
 * - 探失败、containerId echo 不匹配、远端但 tunnelFetchHealthz 缺失 → 返 false
 */
export async function isContainerCapabilityReady(
  status: Pick<
    V3ContainerStatus,
    'containerId' | 'boundIp' | 'port' | 'hostId' | 'dockerContainerId'
  >,
  capsRequired: readonly string[],
  deps: CapabilityProbeDeps = {},
): Promise<boolean> {
  const now = (deps.nowMs ?? Date.now)()
  const hit = cache.get(status.containerId)
  if (hit && hit.exp > now) {
    return capsRequired.every((c) => hit.caps.has(c))
  }
  const isRemote =
    typeof deps.selfHostId === 'string' &&
    typeof status.hostId === 'string' &&
    status.hostId !== deps.selfHostId

  let resp: HealthzResponse
  try {
    if (isRemote) {
      // 远端必须注入 tunnel fetcher;漏注入 = 配置 bug,fail-closed
      if (!deps.tunnelFetchHealthz) {
        // diag: 临时排查 v1.0.73 上线后 user 7 持续 503 — 是否 wiring 没注入
        console.warn(
          JSON.stringify({
            msg: 'capability_probe_no_tunnel_fetch',
            containerId: status.containerId,
            hostId: status.hostId,
            selfHostId: deps.selfHostId,
          }),
        )
        return false
      }
      // dockerContainerId 必须存在;空 = DB 行 inconsistency,fail-closed
      if (!status.dockerContainerId) {
        console.warn(
          JSON.stringify({
            msg: 'capability_probe_no_docker_id',
            containerId: status.containerId,
            hostId: status.hostId,
          }),
        )
        return false
      }
      resp = await deps.tunnelFetchHealthz(
        status.hostId!,
        status.dockerContainerId,
        HEALTHZ_TIMEOUT_MS,
      )
    } else {
      const fetchImpl = deps.fetchHealthz ?? defaultFetchHealthz
      resp = await fetchImpl(status.boundIp, status.port, HEALTHZ_TIMEOUT_MS)
    }
  } catch (err) {
    console.warn(
      JSON.stringify({
        msg: 'capability_probe_throw',
        containerId: status.containerId,
        hostId: status.hostId,
        isRemote,
        err: (err as Error)?.message ?? String(err),
      }),
    )
    return false
  }
  // containerId echo 匹配:防 bridge IP 复用给另一个容器
  if (String(resp.containerId ?? '') !== String(status.containerId)) {
    console.warn(
      JSON.stringify({
        msg: 'capability_probe_id_mismatch',
        expected: status.containerId,
        got: resp.containerId,
        hostId: status.hostId,
      }),
    )
    return false
  }
  const caps = new Set<string>(
    Array.isArray(resp.capabilities)
      ? resp.capabilities.filter((x): x is string => typeof x === 'string')
      : [],
  )
  cache.set(status.containerId, { caps, exp: now + CACHE_TTL_MS })
  return capsRequired.every((c) => caps.has(c))
}

/** 测试用:清空缓存(避免 test 间串扰) */
export function __resetCapabilityCacheForTest(): void {
  cache.clear()
}
