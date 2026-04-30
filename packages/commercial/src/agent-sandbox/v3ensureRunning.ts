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
import { safeEnqueueAlert } from "../admin/alertOutbox.js";
import { EVENTS } from "../admin/alertEvents.js";
import {
  waitContainerReady,
  DEFAULT_READINESS_TIMEOUT_MS,
  DEFAULT_READINESS_TIMEOUT_REMOTE_MS,
  DEFAULT_READINESS_INTERVAL_MS,
  DEFAULT_HTTP_PROBE_MS,
  DEFAULT_WS_PROBE_MS,
  type WaitContainerReadyOptions,
  type ReadinessEndpoint,
} from "./v3readiness.js";
import {
  schedule as schedulePlacement,
  markHostCooldown,
  type SchedulePlacement,
} from "../compute-pool/nodeScheduler.js";
import { NodePoolBusyError, NodePoolUnavailableError } from "../compute-pool/types.js";
import { getHostById, setQuarantined } from "../compute-pool/queries.js";
import { hostRowToTarget, type NodeAgentTarget } from "../compute-pool/nodeAgentClient.js";
import { promoteOnce } from "../compute-pool/imagePromote.js";
import { observeContainerEnsureDuration } from "../admin/metrics.js";
import { randomUUID } from "node:crypto";

/** 前端 retry-after 提示秒数(provision 中)。冷启平均 5-8s,5s 比较合理。 */
const RETRY_AFTER_PROVISIONING_SEC = 5;

/**
 * v1.0.7 — 远端 docker run 抛宿主级冲突("Address already in use" 等)时,
 * 把该 host 标 60s cooldown,下次用户 5s 重连时 nodeScheduler 跳过它。
 *
 * 60s 是经验值:
 *   - 大多数 IPAM/iptables 残留瞬态故障 60s 内自然清,过短会立刻又撞
 *   - 太长会压沉一台 host(集群只 3 台时尤其明显);60s 给两次重连机会
 */
const TRANSIENT_HOST_FAULT_COOLDOWN_MS = 60_000;

/** 前端 retry-after 提示秒数(stopped — 等 3F 清理)。短一点,避免用户等久。 */
const RETRY_AFTER_STOPPED_SEC = 3;

/**
 * V3 Phase 3I — host 容器达 MAX_RUNNING_CONTAINERS 的前端重试秒数。
 * 比 provision 慢,因为得等其他用户 idle sweep / GC 释放;但太长 UX 差。
 * 10s 与冷启动峰值一档,前端可平滑显示"系统繁忙"。
 */
const RETRY_AFTER_HOST_FULL_SEC = 10;

/**
 * Codex round 1 FAIL #4 修复 —— ImageNotFound 是配置/部署级故障,不是临时性
 * "再试 5s 就好了"的状态,容器 image tag 不存在时所有重试都会撞同一面墙。
 *
 * 选 300s(5min):足够长,前端会切到"系统配置异常,请联系管理员"叙事;同时
 * 不锁死,运维 docker pull 修好后 5min 内自动恢复。比"零重试 close 4500"温和,
 * 也比 5s 风暴友好得多。
 *
 * reason='image_missing' 让前端展示 distinct UX(不与一般 'provisioning' 重叠)。
 */
const RETRY_AFTER_IMAGE_MISSING_SEC = 300;

/**
 * Codex R2 修复 —— CcbBaselineMissing 也是部署级故障(rsync 漏了 baseline 或
 * 权限被改),不是"再试 5s 就好"的瞬态。走与 ImageNotFound 同等的长重试,
 * 避免前端每 5s 风暴重试放大运维噪声。运维补好 baseline 后 5min 内自恢复。
 *
 * reason='baseline_missing' 让前端/运维 dashboard 看见 distinct 信号。
 */
const RETRY_AFTER_BASELINE_MISSING_SEC = 300;

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
  probeHealthz?: () => Promise<boolean>;
  /** 测试钩子:覆盖 WS upgrade 探活(3E 新增) */
  probeWsUpgrade?: () => Promise<boolean>;
  /** 测试钩子:覆盖 setTimeout(主要给 fake-timer/排测试) */
  sleep?: (ms: number) => Promise<void>;
  /** 测试钩子:可注入"现在是几号"用于 timeout 计算 */
  now?: () => number;
  /**
   * 测试钩子:跨 host 路径下用 hostId hydrate NodeAgentTarget(给 bridge 用)。
   * 默认实现:`getHostById` + `hostRowToTarget`。生产代码不必传。
   *
   * 重要:这个 target 的 psk 由 caller(bridge)持有,**不能**复用 readiness 那个
   * (waitContainerReady 在 finally 段 fill(0))。所以这里每次都现 hydrate 新 target。
   */
  resolveBridgeTunnelTarget?: (hostId: string) => Promise<NodeAgentTarget>;
}

/**
 * 容器是否在 remote host(非自己) — readiness + bridge 共用判定,SSOT。
 *
 *   - hostId 为 null(单机 MVP 遗留行)→ false
 *   - selfHostId 未注入(MVP 部署)→ false(即使 hostId 非 null,也只能按本机处理)
 *   - hostId === selfHostId → false
 *   - 其余 → true
 */
function isRemoteHost(hostId: string | null, selfHostId: string | undefined): boolean {
  return !!(hostId && selfHostId && hostId !== selfHostId);
}

/**
 * B.4:根据 hostId vs selfHostId 选 direct / node-tunnel readiness endpoint。
 */
function chooseReadinessEndpoint(
  hostId: string | null,
  selfHostId: string | undefined,
  boundIp: string,
  port: number,
  containerInternalId: string,
): ReadinessEndpoint {
  if (isRemoteHost(hostId, selfHostId)) {
    return { kind: "node-tunnel", hostId: hostId as string, containerInternalId };
  }
  return { kind: "direct", host: boundIp, port };
}

/**
 * 跨 host 容器:为 bridge hydrate 一份新 NodeAgentTarget。同 host / 单机直连 → undefined。
 *
 * 失败语义:
 *   - host 行从 DB 消失(extreme race)→ ContainerUnreadyError("host_gone"),前端短重试
 *   - resolveTarget 抛(典型:psk 解密失败)→ 透传,被 bridge 兜底为 1011
 *
 * caller(bridge)拿到 NodeAgentTarget 后立即用于 createTunnelContainerSocket;
 * 那个工厂内部 .toString("hex") 拷一份给 ws header,然后 fill(0) 清原 Buffer
 * (匹配 readiness finally 的清零模式)。本函数不做 cleanup。
 */
async function buildBridgeTunnelIfRemote(
  hostId: string | null,
  selfHostId: string | undefined,
  containerInternalId: string,
  resolveTarget: (hostId: string) => Promise<NodeAgentTarget>,
): Promise<{ hostId: string; containerInternalId: string; nodeAgent: NodeAgentTarget } | undefined> {
  if (!isRemoteHost(hostId, selfHostId)) return undefined;
  const id = hostId as string;
  const nodeAgent = await resolveTarget(id);
  return { hostId: id, containerInternalId, nodeAgent };
}

/** 默认 bridge tunnel target resolver:DB 查 + 解密 psk。 */
async function defaultResolveBridgeTunnelTarget(hostId: string): Promise<NodeAgentTarget> {
  const row = await getHostById(hostId);
  if (!row) {
    throw new ContainerUnreadyError(RETRY_AFTER_PROVISIONING_SEC, "host_gone");
  }
  return hostRowToTarget(row);
}

/**
 * @internal exported for regression test only。
 *
 * 注意:不 eager 填 timeoutMs(self/remote 默认值不同,由 waitContainerReady 按
 * endpoint kind 决策)。caller 显式传 healthzTimeoutMs 时才透传。本约定靠
 * v3EnsureRunning.test.ts 的 buildReadinessOpts 用例守门 — 历史上有人把 eager
 * default 加回来会让 remote 默认 25s 退化回 10s,该测试会 fail。
 */
export function buildReadinessOpts(opts: EnsureRunningOptions): WaitContainerReadyOptions {
  const out: WaitContainerReadyOptions = {
    intervalMs: opts.healthzIntervalMs ?? DEFAULT_READINESS_INTERVAL_MS,
    httpProbeMs: opts.healthzProbeMs ?? DEFAULT_HTTP_PROBE_MS,
    wsProbeMs: opts.wsProbeMs ?? DEFAULT_WS_PROBE_MS,
  };
  if (opts.healthzTimeoutMs !== undefined) out.timeoutMs = opts.healthzTimeoutMs;
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
): (uid: bigint) => Promise<{
  host: string;
  port: number;
  containerId: number;
  /**
   * 本次 ensureRunning 是否走了 provision 分支。
   * - true:容器在本次调用中被 provision(冷启)
   * - false:命中 status='running',直接复用
   *
   * 注意:这是"本次调用"语义,**不是**"用户是否经历过冷启"。
   * 例如 provision 成功但 readiness 超时 → 4503 → 用户重连 → 本次 ensure 命中 running
   * 这种情况下 coldStart=false,但用户实际经历了冷启(漏标 trade-off,见
   * admin/metrics.ts wsBridgeTtft help 文档)。
   */
  coldStart: boolean;
  tunnel?: { hostId: string; containerInternalId: string; nodeAgent: NodeAgentTarget };
}> {
  const readinessOpts = buildReadinessOpts(options);
  const resolveBridgeTunnelTarget =
    options.resolveBridgeTunnelTarget ?? defaultResolveBridgeTunnelTarget;

  return async function ensureRunning(uidBig: bigint): Promise<{
    host: string;
    port: number;
    containerId: number;
    coldStart: boolean;
    tunnel?: { hostId: string; containerInternalId: string; nodeAgent: NodeAgentTarget };
  }> {
    // metrics:成功 return 时 observe;throw 路径不计(避免拉偏 latency 分布)。
    const ensureStartedAt = Date.now();
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
      const endpoint = chooseReadinessEndpoint(
        status.hostId,
        deps.selfHostId,
        status.boundIp,
        status.port,
        status.dockerContainerId,
      );
      const ready = await waitContainerReady(endpoint, readinessOpts);
      if (!ready) throw new ContainerUnreadyError(RETRY_AFTER_PROVISIONING_SEC, "starting");
      // 3F: 用户重连即视作活跃 — 刷新 last_ws_activity,推迟 idle sweep。
      // 不 await 失败、也不阻塞 caller(markV3ContainerActivity 自吞错)。
      void markV3ContainerActivity(deps, status.containerId);
      // 跨 host 容器:为 bridge hydrate 一份 NodeAgentTarget(readiness 那份 psk 已被 fill(0))。
      const tunnel = await buildBridgeTunnelIfRemote(
        status.hostId,
        deps.selfHostId,
        status.dockerContainerId,
        resolveBridgeTunnelTarget,
      );
      observeContainerEnsureDuration("warm", (Date.now() - ensureStartedAt) / 1000);
      return {
        host: status.boundIp,
        port: status.port,
        containerId: status.containerId,
        coldStart: false,
        ...(tunnel ? { tunnel } : {}),
      };
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
    // B.4:注入了 containerService → 走 scheduler 挑 host + 分 IP;否则走单机 MVP(randomIp)
    let placement: SchedulePlacement | undefined;
    if (deps.containerService) {
      try {
        placement = await schedulePlacement({ userId: uid });
      } catch (err) {
        if (err instanceof NodePoolBusyError || err instanceof NodePoolUnavailableError) {
          throw new ContainerUnreadyError(RETRY_AFTER_HOST_FULL_SEC, "host_full");
        }
        throw new ContainerUnreadyError(RETRY_AFTER_PROVISIONING_SEC, "supervisor_error");
      }
    }

    let provisioned;
    try {
      provisioned = await provisionV3Container(
        deps,
        uid,
        placement?.hostId,
        placement?.boundIp,
        placement?.bridgeCidr,
      );
    } catch (err) {
      // V3 Phase 3I — host 满 cap 走专用 reason + 长 retryAfter,前端显示"系统繁忙"
      if (err instanceof SupervisorError && err.code === "HostFull") {
        // 告警:host 达 MAX_RUNNING_CONTAINERS — 容量规划问题,critical。
        // dedupe 按分钟桶避免风暴;运维扩容后自然解除。
        safeEnqueueAlert({
          event_type: EVENTS.CONTAINER_PROVISION_FAILED,
          severity: "critical",
          title: "容器 provision 失败 — 宿主容量满",
          body: `uid=${uid} provision 被拒:宿主达到 MAX_RUNNING_CONTAINERS。需扩容或触发 idle sweep。`,
          payload: { uid, reason: "host_full" },
          dedupe_key: `container.provision_failed:host_full:${new Date().toISOString().slice(0, 16)}`,
        });
        throw new ContainerUnreadyError(RETRY_AFTER_HOST_FULL_SEC, "host_full");
      }
      // Codex round 1 FAIL #4 fix:ImageNotFound 是部署级故障 — 5s 重试只会风暴
      if (err instanceof SupervisorError && err.code === "ImageNotFound") {
        // 2026-04-26 enrich:加 host_id/host_name/image,dedup 升级到
        //   image_missing:<host>:<image>:<hour-bucket> —— 原 hour-only dedup 太粗,
        //   同小时内 host A + host B 都缺镜像只会发 1 条,丢第 2 host 信号。
        //
        // host_name 查 DB 是 best-effort:catch 路径不是热路径,1 次额外查可接受;
        // 失败也不能改变控制流(否则把 ImageNotFound 变成别的异常)。
        const hostId = placement?.hostId ?? "unknown-host";
        let hostName: string = hostId;
        if (placement?.hostId) {
          try {
            const row = await getHostById(placement.hostId);
            if (row?.name) hostName = row.name;
          } catch {
            // 静默吞;hostName 退回 hostId 已经能表达
          }
        }
        const imageRef = deps.image;
        safeEnqueueAlert({
          event_type: EVENTS.CONTAINER_PROVISION_FAILED,
          severity: "critical",
          title: `容器 provision 失败 — 镜像缺失 [${hostName}]`,
          body: `uid=${uid} 在 host=${hostName}(${hostId})上 provision 失败:image=\`${imageRef}\` 不存在。部署级故障,placement gate 已自动 quarantine 该 host,后台 imagePromote 会异步重分发。`,
          payload: { uid, reason: "image_missing", host_id: hostId, host_name: hostName, image: imageRef },
          dedupe_key: `container.provision_failed:image_missing:${hostId}:${imageRef}:${new Date().toISOString().slice(0, 13)}`,
        });
        // Plan v4:host 报告 image 已加载但 runtime 实际拉容器时撞 ImageNotFound
        // → 立即 hard quarantine(reason='runtime-image-missing'),关 placement gate,
        //   后续用户被 schedule 到其它 host;同时 fire-and-forget 一轮 promoteOnce 异步重分发,
        //   若成功 imagePromote 会清掉 quarantine 让 host 重回 ready。
        if (placement?.hostId) {
          const operationId = randomUUID();
          await setQuarantined(placement.hostId, {
            reason: "runtime-image-missing",
            detail: `runtime ImageNotFound: ${imageRef}`,
            operationId,
            actor: "system:v3ensureRunning",
          }).catch(() => {
            // 静默吞;quarantine 失败也不能改变控制流(throw 仍按 ImageNotFound 走)
          });
          // 不 await,避免阻塞 user-facing throw。
          // plan v4 round-2:把同一 operationId 透给 promoteOnce,使
          // setQuarantined → distribute → clearQuarantineByReason 三段审计行
          // 通过 operation_id 索引串起来,运维追溯一次故障只需一次查询。
          void promoteOnce({ imageTag: imageRef, operationId }).catch(() => undefined);
        }
        throw new ContainerUnreadyError(RETRY_AFTER_IMAGE_MISSING_SEC, "image_missing");
      }
      // Codex R2 fix:CcbBaselineMissing 同为部署级故障 — baseline rsync 漏了
      // 或权限被改。走长重试避免风暴,留给运维修基线。
      if (err instanceof SupervisorError && err.code === "CcbBaselineMissing") {
        safeEnqueueAlert({
          event_type: EVENTS.CONTAINER_PROVISION_FAILED,
          severity: "critical",
          title: "容器 provision 失败 — baseline 缺失",
          body: `uid=${uid} provision 失败:claude-code-best baseline 目录不存在或权限错。需人工 rsync 修复。`,
          payload: { uid, reason: "baseline_missing" },
          dedupe_key: `container.provision_failed:baseline_missing:${new Date().toISOString().slice(0, 13)}`,
        });
        throw new ContainerUnreadyError(RETRY_AFTER_BASELINE_MISSING_SEC, "baseline_missing");
      }
      // NameConflict(同 uid 并发 provision)/ IP 池满 都让前端短重试 — 不告警。
      // 2026-04-25 v1.0.2:之前这里完全吞错,uid=28 12 分钟死循环里 0 条 stack 可查,
      // 排障只能瞎猜。补 console.warn 落 /var/log/openclaude.log,行为不变,只加观测。
      // v1.0.7:加 host_uuid / bound_ip 字段,排障时能直接定位是哪台 host 出问题。
      const errCode =
        err instanceof SupervisorError ? err.code : (err as { code?: string } | null)?.code;
      const errMsg = err instanceof Error ? err.message : String(err);
      // v1.0.7:TransientHostFault(远端 docker run "Address already in use" 类) →
      // 把 host 标 cooldown,下次 5s 重连 nodeScheduler 自然换台。
      // 单进程内存即可,不持久化(重启自然清,失败 host 会被自然探测重新进 cooldown)。
      // v1.0.8:扩到 RemoteContractViolation(node-agent 协议违约 — 同 host
      // 60s 内必然继续撞)。VOL_CREATE_FAIL 由 wrapDockerError 已归为
      // TransientHostFault,无需在此重复列出。
      if (
        err instanceof SupervisorError &&
        (err.code === "TransientHostFault" || err.code === "RemoteContractViolation") &&
        placement?.hostId
      ) {
        markHostCooldown(placement.hostId, TRANSIENT_HOST_FAULT_COOLDOWN_MS);
      }
      // eslint-disable-next-line no-console
      console.warn("[v3ensureRunning] provision failed (catch-all)", {
        uid,
        errCode,
        errMsg,
        hostId: placement?.hostId,
        boundIp: placement?.boundIp,
      });
      throw new ContainerUnreadyError(RETRY_AFTER_PROVISIONING_SEC, "provisioning");
    }

    // 4) waitContainerReady —— 容器内 OpenClaude 起来需要 3-8s,HTTP+WS 双过才算 ready
    const endpoint = chooseReadinessEndpoint(
      provisioned.hostId,
      deps.selfHostId,
      provisioned.boundIp,
      provisioned.port,
      provisioned.dockerContainerId,
    );
    const ready = await waitContainerReady(endpoint, readinessOpts);
    if (!ready) {
      // 起来了但 readiness 没通 — 前端按 retryAfter 重连(下次再调本 ensureRunning,
      // 那时 status='running',probe 可能已经 ok)
      throw new ContainerUnreadyError(RETRY_AFTER_PROVISIONING_SEC, "starting");
    }

    // 跨 host 容器:为 bridge hydrate 一份 NodeAgentTarget(同 running 路径)。
    const tunnel = await buildBridgeTunnelIfRemote(
      provisioned.hostId,
      deps.selfHostId,
      provisioned.dockerContainerId,
      resolveBridgeTunnelTarget,
    );
    observeContainerEnsureDuration("cold", (Date.now() - ensureStartedAt) / 1000);
    return {
      host: provisioned.boundIp,
      port: provisioned.port,
      containerId: provisioned.containerId,
      coldStart: true,
      ...(tunnel ? { tunnel } : {}),
    };
  };
}

// 给测试用的 default constants(也作为 wrapper 默认值的 SSOT,改这里要同步)
export const ENSURE_RUNNING_DEFAULTS = Object.freeze({
  /** self-host(direct) readiness 默认总超时 */
  HEALTHZ_TIMEOUT_MS: DEFAULT_READINESS_TIMEOUT_MS,
  /** remote host(node-tunnel) readiness 默认总超时 — 比 self 长,吸收 mTLS RTT */
  HEALTHZ_TIMEOUT_REMOTE_MS: DEFAULT_READINESS_TIMEOUT_REMOTE_MS,
  HEALTHZ_INTERVAL_MS: DEFAULT_READINESS_INTERVAL_MS,
  HEALTHZ_PROBE_MS: DEFAULT_HTTP_PROBE_MS,
  WS_PROBE_MS: DEFAULT_WS_PROBE_MS,
  RETRY_AFTER_PROVISIONING_SEC,
  RETRY_AFTER_STOPPED_SEC,
  RETRY_AFTER_HOST_FULL_SEC,
  RETRY_AFTER_IMAGE_MISSING_SEC,
  RETRY_AFTER_BASELINE_MISSING_SEC,
  CONTAINER_PORT: V3_CONTAINER_PORT,
});
