/**
 * V3 Phase 3D — userChatBridge ↔ v3 supervisor 接入层。
 *
 * 见 docs/v3/02-DEVELOPMENT-PLAN.md §9.3 Task 3D。
 *
 * 单 host 单进程,**不做 ACK 屏障**(R6.11 P1+ 才上)。语义是简单的:
 *
 *   bridge(uid) ────▶ ensureRunning(uid)
 *                      │
 *                      ├─ 1. status = getV3ContainerStatus(uid)
 *                      ├─ 2. if status == null  → provisionV3Container(uid)
 *                      ├─ 2. if status.state == 'missing' → stopAndRemove + provision
 *                      ├─ 2. if status.state == 'stopped' → 抛 ContainerUnreadyError(5,"stopped")
 *                      │     (3F idle sweep 会走 stopAndRemove,3D MVP 不主动 startStopped;
 *                      │      MVP 先把"已 stop 的 active 行"当成异常,等 3F 把它清掉)
 *                      ├─ 3. await waitHealthz(boundIp, port)  (默认 10s 超时,200ms 间隔)
 *                      └─ 4. return { host: boundIp, port }
 *
 * 抛 `ContainerUnreadyError(retryAfterSec, reason)` → bridge close 4503,前端按 retryAfter 重试。
 * 任何其他 error → bridge 兜底 close 1011 + 不外泄根因。
 *
 * 不在本文件管:
 *   - readiness probe 的 WebSocket upgrade 探活 → 3E 单独加(MVP 先用 HTTP /healthz 即可)
 *   - idle sweep / orphan reconcile → 3F / 3H
 *   - volume GC → 3G
 *   - resource cap MAX_RUNNING_CONTAINERS → 3I
 *
 * uid 类型转换:bridge 给 bigint(JWT sub 解析得来),supervisor 用 number。
 * MVP 单库 < 2^53 个用户(实际 ≪ 1k),Number(uid) 不会丢精度;但仍然显式 guard。
 */

import { ContainerUnreadyError } from "../ws/userChatBridge.js";
import { SupervisorError } from "./types.js";
import {
  getV3ContainerStatus,
  markV3ContainerActivity,
  provisionV3Container,
  stopAndRemoveV3Container,
  V3_CONTAINER_PORT,
  type V3SupervisorDeps,
  type V3ContainerStatus,
} from "./v3supervisor.js";
import {
  waitContainerReady,
  DEFAULT_READINESS_TIMEOUT_MS,
  DEFAULT_READINESS_INTERVAL_MS,
  DEFAULT_HTTP_PROBE_MS,
  DEFAULT_WS_PROBE_MS,
  type WaitContainerReadyOptions,
} from "./v3readiness.js";

/** 前端 retry-after 提示秒数(provision 中)。冷启平均 5-8s,5s 比较合理。 */
const RETRY_AFTER_PROVISIONING_SEC = 5;

/** 前端 retry-after 提示秒数(stopped — 等 3F 清理)。短一点,避免用户等久。 */
const RETRY_AFTER_STOPPED_SEC = 3;

/**
 * V3 Phase 3I — host 容器达 MAX_RUNNING_CONTAINERS 的前端重试秒数。
 * 比 provision 慢,因为得等其他用户 idle sweep / GC 释放;但太长 UX 差。
 * 10s 与冷启动峰值一档,前端可平滑显示"系统繁忙"。
 */
const RETRY_AFTER_HOST_FULL_SEC = 10;

/**
 * ensureRunning 注入项 — 测试可以覆盖 readiness 探活实现。
 *
 * 字段沿用 3D 命名(向后兼容),但语义已改为 §3E 的 readiness:HTTP /healthz +
 * WS upgrade probe 双过 才算 ready。
 */
export interface EnsureRunningOptions {
  /** readiness 总超时,默认 10s(对应 §9.3 task 3E) */
  healthzTimeoutMs?: number;
  /** 轮询间隔,默认 200ms */
  healthzIntervalMs?: number;
  /** 单次 HTTP /healthz probe 超时,默认 1s */
  healthzProbeMs?: number;
  /** 单次 WS upgrade probe 超时,默认 1.5s(3E 新增) */
  wsProbeMs?: number;
  /** 测试钩子:覆盖 HTTP /healthz 探活 */
  probeHealthz?: (host: string, port: number) => Promise<boolean>;
  /** 测试钩子:覆盖 WS upgrade 探活(3E 新增) */
  probeWsUpgrade?: (host: string, port: number) => Promise<boolean>;
  /** 测试钩子:覆盖 setTimeout(主要给 fake-timer/排测试) */
  sleep?: (ms: number) => Promise<void>;
  /** 测试钩子:可注入"现在是几号"用于 timeout 计算 */
  now?: () => number;
}

function buildReadinessOpts(opts: EnsureRunningOptions): WaitContainerReadyOptions {
  const out: WaitContainerReadyOptions = {
    timeoutMs: opts.healthzTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
    intervalMs: opts.healthzIntervalMs ?? DEFAULT_READINESS_INTERVAL_MS,
    httpProbeMs: opts.healthzProbeMs ?? DEFAULT_HTTP_PROBE_MS,
    wsProbeMs: opts.wsProbeMs ?? DEFAULT_WS_PROBE_MS,
  };
  if (opts.probeHealthz) out.probeHttp = opts.probeHealthz;
  if (opts.probeWsUpgrade) out.probeWs = opts.probeWsUpgrade;
  if (opts.sleep) out.sleep = opts.sleep;
  if (opts.now) out.now = opts.now;
  return out;
}

/**
 * Phase 3D 主入口 — bridge 注入这个 lambda 给 resolveContainerEndpoint。
 *
 * 闭包持 V3SupervisorDeps + EnsureRunningOptions。返回的函数签名严格匹配
 * `ResolveContainerEndpoint = (uid: bigint) => Promise<{host, port}>`。
 *
 * 行为分支(bridge 看到的结果):
 *   - active + running + healthz ok        → return {host, port}
 *   - active + running + healthz timeout   → throw ContainerUnreadyError(5, "starting")
 *   - active + stopped                     → throw ContainerUnreadyError(3, "stopped")
 *                                            (3F idle sweep 会清,前端短重试)
 *   - active + missing(docker 容器消失)   → stopAndRemove (vanished) + provision + waitHealthz
 *   - 无 active 行                         → provision + waitHealthz
 *   - provision 抛 NameConflict / IP 池满  → ContainerUnreadyError(5, "provisioning")
 *
 * 设计取舍:
 *   - 不做 retry / backoff(bridge 自己 close 4503,前端按 retryAfter 重连)
 *   - 不做 lock / mutex(单 host 单进程,DB uniq + INSERT race 已经够;P1 多 host 才需要)
 */
export function makeV3EnsureRunning(
  deps: V3SupervisorDeps,
  options: EnsureRunningOptions = {},
): (uid: bigint) => Promise<{ host: string; port: number }> {
  const readinessOpts = buildReadinessOpts(options);

  return async function ensureRunning(uidBig: bigint): Promise<{ host: string; port: number }> {
    // bigint → number,显式 guard(>2^53 不会发生,MVP 用户量 < 1k,但守住)
    if (uidBig <= 0n || uidBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ContainerUnreadyError(60, "invalid_uid");
    }
    const uid = Number(uidBig);

    // 1) 当前态
    let status: V3ContainerStatus | null;
    try {
      status = await getV3ContainerStatus(deps, uid);
    } catch {
      // DB 错 / docker daemon 不可达 — caller 可重试;不暴露根因
      throw new ContainerUnreadyError(RETRY_AFTER_PROVISIONING_SEC, "supervisor_error");
    }

    // 2a) running 直接进 readiness 探活(HTTP /healthz + WS upgrade)
    if (status && status.state === "running") {
      const ready = await waitContainerReady(status.boundIp, status.port, readinessOpts);
      if (!ready) throw new ContainerUnreadyError(RETRY_AFTER_PROVISIONING_SEC, "starting");
      // 3F: 用户重连即视作活跃 — 刷新 last_ws_activity,推迟 idle sweep。
      // 不 await 失败、也不阻塞 caller(markV3ContainerActivity 自吞错)。
      void markV3ContainerActivity(deps, status.containerId);
      return { host: status.boundIp, port: status.port };
    }

    // 2b) stopped(active 行 + container_internal_id 已写但容器没 Running)
    //     MVP 不主动 start;让 3F idle sweep 走 stopAndRemove + 用户下次 ws 重连时 provision
    if (status && status.state === "stopped") {
      throw new ContainerUnreadyError(RETRY_AFTER_STOPPED_SEC, "stopped");
    }

    // 2c) missing(active 行,但 docker inspect 404 — 容器被外力删了)
    //     必须先把行标 vanished(stopAndRemove 内部会做),再走 provision 路径
    if (status && status.state === "missing") {
      try {
        await stopAndRemoveV3Container(deps, {
          id: status.containerId,
          container_internal_id: status.dockerContainerId || null,
        });
      } catch {
        throw new ContainerUnreadyError(RETRY_AFTER_PROVISIONING_SEC, "supervisor_error");
      }
    }

    // 3) provision 新容器(无 active 行 OR 刚清掉 missing 行)
    let provisioned;
    try {
      provisioned = await provisionV3Container(deps, uid);
    } catch (err) {
      // V3 Phase 3I — host 满 cap 走专用 reason + 长 retryAfter,前端显示"系统繁忙"
      if (err instanceof SupervisorError && err.code === "HostFull") {
        throw new ContainerUnreadyError(RETRY_AFTER_HOST_FULL_SEC, "host_full");
      }
      // NameConflict(同 uid 并发 provision)/ ImagePull / IP 池满 都让前端短重试
      throw new ContainerUnreadyError(RETRY_AFTER_PROVISIONING_SEC, "provisioning");
    }

    // 4) waitContainerReady —— 容器内 OpenClaude 起来需要 3-8s,HTTP+WS 双过才算 ready
    const ready = await waitContainerReady(provisioned.boundIp, provisioned.port, readinessOpts);
    if (!ready) {
      // 起来了但 readiness 没通 — 前端按 retryAfter 重连(下次再调本 ensureRunning,
      // 那时 status='running',probe 可能已经 ok)
      throw new ContainerUnreadyError(RETRY_AFTER_PROVISIONING_SEC, "starting");
    }

    return { host: provisioned.boundIp, port: provisioned.port };
  };
}

// 给测试用的 default constants(也作为 wrapper 默认值的 SSOT,改这里要同步)
export const ENSURE_RUNNING_DEFAULTS = Object.freeze({
  HEALTHZ_TIMEOUT_MS: DEFAULT_READINESS_TIMEOUT_MS,
  HEALTHZ_INTERVAL_MS: DEFAULT_READINESS_INTERVAL_MS,
  HEALTHZ_PROBE_MS: DEFAULT_HTTP_PROBE_MS,
  WS_PROBE_MS: DEFAULT_WS_PROBE_MS,
  RETRY_AFTER_PROVISIONING_SEC,
  RETRY_AFTER_STOPPED_SEC,
  RETRY_AFTER_HOST_FULL_SEC,
  CONTAINER_PORT: V3_CONTAINER_PORT,
});
