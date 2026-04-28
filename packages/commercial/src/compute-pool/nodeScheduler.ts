/**
 * nodeScheduler — 为新容器选择落点 host。
 *
 * 策略(M1 简单有效):
 *   1. sticky:同 userId 近期有容器存活 → 复用该 host(减少 IP/状态迁移)
 *   2. least-loaded:否则从 ready + activeContainers<max_containers 里挑 load 最少
 *   3. 并发下 bound_ip 分配原子性由 M1 全局 uniq_ac_bound_ip_active 保证(INSERT 冲突 retry)
 *      0031 drop 后走 per-host 唯一
 *
 * bridge IP 分配:
 *   - 给定 host.bridge_cidr(如 172.30.1.0/24),gateway=.1,可分配 .10~.250
 *   - 从 `agent_containers WHERE host_uuid=? AND state='active'` 中排除已占 IP
 *   - 落选策略:最低空闲数字
 *
 * 返回:{ hostId, hostHost, agentPort, boundIp } — 调用方按此创建容器
 */

import { getPool } from "../db/index.js";
import { rootLogger } from "../logging/logger.js";
import * as queries from "./queries.js";
import {
  NodePoolBusyError,
  NodePoolUnavailableError,
  type ComputeHostRow,
} from "./types.js";
import type { SchedulableHost } from "./queries.js";

const log = rootLogger.child({ subsys: "node-scheduler" });

export interface SchedulePlacement {
  hostId: string;
  hostHost: string;
  agentPort: number;
  boundIp: string;
  /** 该 host 的 bridge CIDR,供 master 侧需要的场景使用(日志/审计)。 */
  bridgeCidr: string | null;
}

export interface ScheduleOptions {
  /** 某 userId 的 session 创建新容器;允许 sticky 复用。 */
  userId?: number;
  /** 强制指定 hostId(admin debug 用)。 */
  requireHostId?: string;
}

/**
 * 在 DB 里查单 host 的 bridge_cidr 是一次多余字段取;M1 先简化,所有 non-self host
 * 的 bridge_cidr 存在 compute_hosts 表之外、由本表约定放在 host.host 对应的 name 上
 * 并通过统一环境(installBridge 时写)一致性保证。
 * 这里临时从 agent_containers 最多 1 条已有行的 bound_ip 反推 /24 前缀。
 */
async function bridgeCidrFromExisting(hostId: string): Promise<string | null> {
  const r = await getPool().query<{ bound_ip: string }>(
    `SELECT bound_ip
       FROM agent_containers
      WHERE host_uuid = $1
        AND bound_ip IS NOT NULL
      LIMIT 1`,
    [hostId],
  );
  const ip = r.rows[0]?.bound_ip;
  if (!ip) return null;
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

/**
 * v1.0.7 — 进程内 host cooldown 注册表。
 *
 * 用途:某 host docker run 抛"Address already in use"等宿主级冲突时,
 * v3ensureRunning 调用 markHostCooldown(hostId, 60_000),60s 内 pickHost 跳过它,
 * 用户下一次 5s 重连自然会落到另一台 host。
 *
 * 设计取舍:
 *   - 进程内、不持久化:重启后清空可接受(失败 host 会被自然探测重新进 cooldown)
 *   - 不做指数退避:简单等量 60s 已经能避开大多数瞬态故障
 *   - 不影响 requireHostId 路径:admin 显式指定 host 时不应被 cooldown 拦
 *   - sticky 路径:fall-through 到 least-loaded(对用户而言不算降级,反正都是新挑)
 *
 * 测试用 _clearHostCooldownForTests 重置;生产代码不应调用。
 */
const hostCooldown = new Map<string, number>();

export function markHostCooldown(hostId: string, durationMs: number): void {
  if (!hostId || !Number.isFinite(durationMs) || durationMs <= 0) return;
  const expireAt = Date.now() + durationMs;
  // 同 host 重复标:取较晚的过期时间(stronger evidence wins)
  const prev = hostCooldown.get(hostId) ?? 0;
  if (expireAt > prev) hostCooldown.set(hostId, expireAt);
}

function isHostInCooldown(hostId: string): boolean {
  const expireAt = hostCooldown.get(hostId);
  if (expireAt === undefined) return false;
  if (Date.now() >= expireAt) {
    hostCooldown.delete(hostId);
    return false;
  }
  return true;
}

export function _clearHostCooldownForTests(): void {
  hostCooldown.clear();
}

/**
 * 选 host。
 * 不做 IP 分配,IP 由 pickBoundIp 单独调用(分两步便于测试)。
 */
export async function pickHost(opts: ScheduleOptions = {}): Promise<SchedulableHost> {
  if (opts.requireHostId) {
    // 显式指定 host:admin debug / 强制路径,**有意绕过 full placement gate**。
    // 仍要求 status='ready'(防止把 quarantined/broken host 喂给 admin)。
    // pinned/dataHost/least-loaded 三个非强制路径都经 full gate;requireHostId
    // 是唯一保留 status-only 入口,只暴露给 scheduler API/tests,不暴露给用户路径。
    const row = await queries.getHostById(opts.requireHostId);
    if (!row || row.status !== "ready") {
      throw new NodePoolUnavailableError(`host ${opts.requireHostId} not ready`);
    }
    const count = await queries.countActiveContainersOnHost(row.id);
    if (count >= row.max_containers) {
      throw new NodePoolBusyError(`host ${row.id} at capacity`);
    }
    log.warn("requireHostId path bypassing full placement gate", {
      hostId: row.id,
      reason: "admin/debug forced placement",
    });
    return { row, activeContainers: count };
  }

  // user-level pin: admin 把特定 user 钉到特定 host(QA/测试用)。
  // 命中条件: host 通过 full placement gate(loaded_image 对齐 + 三维度 fresh)
  // + 未满 + 不在 cooldown。任一不满足 → log.warn + fall-through 到 sticky/
  // least-loaded(避免 host 维护期把 pinned 用户全卡死)。
  // 优先级: requireHostId(admin debug) > pinned > sticky > least-loaded。
  if (typeof opts.userId === "number") {
    const pinnedHostId = await queries.getUserPinnedHost(opts.userId);
    if (pinnedHostId) {
      if (isHostInCooldown(pinnedHostId)) {
        log.warn("pinned host in cooldown, falling through", {
          userId: opts.userId,
          hostId: pinnedHostId,
        });
      } else {
        // plan v4 round-2:走 full gate(不再只看 status==='ready')。
        // gate fail = host 当前不可调度(status 非 ready / loaded_image 不对齐
        // / dim stale 等),fall-through 到 sticky/least-loaded。
        const sched = await queries.getSchedulableHostById(pinnedHostId);
        if (!sched) {
          log.warn("pinned host failed full placement gate, falling through", {
            userId: opts.userId,
            hostId: pinnedHostId,
          });
        } else if (sched.activeContainers >= sched.row.max_containers) {
          log.warn("pinned host at capacity, falling through", {
            userId: opts.userId,
            hostId: sched.row.id,
          });
        } else {
          log.debug("pinned host hit", { userId: opts.userId, hostId: sched.row.id });
          return sched;
        }
      }
    }
  }

  // v1.0.17 — data sticky: 用户的 docker named volume(`oc-v3-data-u<uid>` +
  // `oc-v3-proj-u<uid>`) 物理上是 host-local 的,跨 host 没有同步路径。所以
  // 必须把用户调度回**最近一次容器所在 host**(active 优先,vanished 其次),
  // 否则在新 host ensureVolume 幂等创建空 volume → 用户工作目录 + skills 全空。
  //
  // 优先级与 fall-through 策略(主动 vs 被动状态严格区分):
  //   - dataHost ready + 未满 + 非 cooldown → 命中,return(99% 路径)
  //   - dataHost ready + 满 → throw NodePoolBusyError(让 v3ensureRunning 翻
  //     ContainerUnreadyError(10s, "host_full"),客户端 host_full retry。
  //     **不 fallback**:fallback=空 volume,等同丢数据)
  //   - dataHost ready + cooldown → 同上抛 busy(60s 临时避让,可能马上恢复;
  //     此时 fallback 就会重现"空 volume"bug)
  //   - dataHost status=draining → 抛 busy。draining 是 admin **主动**状态
  //     (预备下架),数据 volume 仍在 host 本地,fall-through 会创建空 volume,
  //     完全是本次修复要避免的事。等 admin 完成迁移流程后再恢复
  //   - dataHost status=quarantined/broken 或 host 行 missing → fall through。
  //     这是**被动**故障状态(健康探针 3 连 fail / bootstrap 失败 / host 行被
  //     删的极罕见 race),host 真出问题,数据救不回来,优先让用户能登录。
  //     可用性 vs 数据完整性 trade-off,由运维介入 / R6.8 freeze+rsync 处理
  //   - dataHost status=bootstrapping(其他过渡态)→ fall through。host 还
  //     没就绪,fall-through 让用户先用别的 host;ready 后用户再回来时 sticky
  //     命中
  //   - dataHost 为 null (user 全新,从未 provision) → fall through 到
  //     least-loaded(首次落点不影响数据完整性,因为还没有数据)
  if (typeof opts.userId === "number") {
    const dataHost = await queries.findUserDataHost(opts.userId);
    if (dataHost) {
      const row = await queries.getHostById(dataHost.hostUuid);
      if (!row || row.status === "quarantined" || row.status === "broken") {
        // 被动故障 / host 行 missing(ON DELETE RESTRICT 下罕见)→ fall through
        log.warn("data host in passive failure, falling through (user volume may not load)", {
          userId: opts.userId,
          hostId: dataHost.hostUuid,
          status: row?.status ?? "missing",
          containerState: dataHost.containerState,
        });
        // fall through → least-loaded
      } else if (row.status === "draining") {
        // draining 不 fallback:admin 主动状态,数据仍在 host 本地。
        log.info("data host in draining, throwing busy to preserve user data", {
          userId: opts.userId,
          hostId: row.id,
          containerState: dataHost.containerState,
        });
        throw new NodePoolBusyError(
          `data host ${row.id} in draining for uid=${opts.userId}`,
        );
      } else if (row.status !== "ready") {
        // 兜底其他过渡态(bootstrapping)。
        log.warn("data host not ready, falling through", {
          userId: opts.userId,
          hostId: dataHost.hostUuid,
          status: row.status,
          containerState: dataHost.containerState,
        });
        // fall through → least-loaded
      } else if (isHostInCooldown(dataHost.hostUuid)) {
        // cooldown 不 fallback:host 通常 60s 后恢复,fallback 会写空 volume
        log.info("data host in cooldown, throwing busy to preserve user data", {
          userId: opts.userId,
          hostId: row.id,
          containerState: dataHost.containerState,
        });
        throw new NodePoolBusyError(
          `data host ${row.id} in cooldown for uid=${opts.userId}`,
        );
      } else {
        // plan v4 round-2:status='ready' 的 dataHost 仍要跑 full placement gate
        // (loaded_image 对齐 + 三维度 fresh)。gate fail = host 暂时不可调度
        // (新 image 还没 distribute / dim 还没就位),与 cooldown / capacity
        // 同档处理:throw NodePoolBusyError 让 client retry,**不 fall-through**
        // (fall-through 会落到 least-loaded → 写空 volume → 数据丢失)。
        // 与 dataHost 现行"数据优先"策略一致。
        const sched = await queries.getSchedulableHostById(row.id);
        if (!sched) {
          log.info("data host failed full placement gate, throwing busy to preserve user data", {
            userId: opts.userId,
            hostId: row.id,
            containerState: dataHost.containerState,
          });
          throw new NodePoolBusyError(
            `data host ${row.id} not schedulable (gate fail) for uid=${opts.userId}`,
          );
        }
        if (sched.activeContainers >= sched.row.max_containers) {
          // 满不 fallback:同样会写空 volume。让用户 host_full retry 等出空位
          log.info("data host at capacity, throwing busy to preserve user data", {
            userId: opts.userId,
            hostId: sched.row.id,
            activeContainers: sched.activeContainers,
            maxContainers: sched.row.max_containers,
            containerState: dataHost.containerState,
          });
          throw new NodePoolBusyError(
            `data host ${sched.row.id} at capacity for uid=${opts.userId}`,
          );
        }
        log.debug("data host hit", {
          userId: opts.userId,
          hostId: sched.row.id,
          containerState: dataHost.containerState,
        });
        return sched;
      }
    }
  }

  // least-loaded(剔除 cooldown 中的 host)
  const candidates = await queries.listSchedulableHosts();
  const ok = candidates.filter(
    (c) => c.activeContainers < c.row.max_containers && !isHostInCooldown(c.row.id),
  );
  if (ok.length === 0) {
    if (candidates.length === 0) {
      throw new NodePoolUnavailableError("no ready host");
    }
    // listSchedulableHosts 已在 SQL 层过滤掉 active >= max_containers 的 host,
    // 所以走到这里说明所有 ready host 都在 cooldown 中。沿用 NodePoolBusyError —
    // 让 v3ensureRunning 走 host_full retry(10s)路径,不污染日志。
    throw new NodePoolBusyError("all ready hosts in cooldown");
  }
  ok.sort((a, b) => a.activeContainers - b.activeContainers);
  return ok[0]!;
}

/**
 * 在选中的 host 上分配未占用的 bridge IP。
 * 从 .10 ~ .250 里找最低数字。竞争由调用方包在 DB INSERT 的 uniq 索引上兜底。
 */
export async function pickBoundIp(hostId: string): Promise<{ boundIp: string; cidr: string }> {
  const row = await queries.getHostById(hostId);
  if (!row) throw new NodePoolUnavailableError(`host ${hostId} not found`);
  // cidr 解析顺序:
  //   1) DB 列 compute_hosts.bridge_cidr(migration 0032 后的权威源)
  //   2) bridgeCidrFromExisting — 老数据兼容:从 agent_containers.bound_ip 反推
  //   3) 最终 fallback 公式 — 仅对 migration 前且无历史容器的行
  let cidr: string | null = row.bridge_cidr ?? null;
  if (!cidr) {
    cidr = await bridgeCidrFromExisting(hostId);
  }
  const used = new Set<string>();
  const r = await getPool().query<{ bound_ip: string }>(
    `SELECT bound_ip
       FROM agent_containers
      WHERE host_uuid = $1
        AND state = 'active'
        AND bound_ip IS NOT NULL`,
    [hostId],
  );
  for (const row of r.rows) used.add(row.bound_ip);

  let effectiveCidr = cidr;
  if (!effectiveCidr) {
    // fallback:用 host 在 listAllHosts 里的顺序(按 created_at)推 index 0..N
    const all = await queries.listAllHosts();
    const nonSelf = all
      .filter((h) => h.name !== "self")
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
    const selfIdx = all.findIndex((h) => h.name === "self");
    void selfIdx;
    const idx = nonSelf.findIndex((h) => h.id === hostId);
    if (idx < 0) {
      // 这是 self?
      if (row.name === "self") {
        effectiveCidr = "172.30.0.0/24";
      } else {
        throw new NodePoolUnavailableError("cannot determine host cidr");
      }
    } else {
      effectiveCidr = `172.30.${idx + 1}.0/24`;
    }
  }
  const prefix = effectiveCidr.split("/")[0]!.split(".").slice(0, 3).join(".");
  for (let last = 10; last <= 250; last++) {
    const ip = `${prefix}.${last}`;
    if (!used.has(ip)) {
      return { boundIp: ip, cidr: effectiveCidr };
    }
  }
  throw new NodePoolBusyError(`host ${hostId} has no free bridge IP`);
}

/** 一站式:挑 host + 分配 IP,返回 Placement。 */
export async function schedule(opts: ScheduleOptions = {}): Promise<SchedulePlacement> {
  const picked = await pickHost(opts);
  const { boundIp, cidr } = await pickBoundIp(picked.row.id);
  return {
    hostId: picked.row.id,
    hostHost: picked.row.host,
    agentPort: picked.row.agent_port,
    boundIp,
    bridgeCidr: cidr,
  };
}

export function _debugHostRow(row: ComputeHostRow): string {
  return `${row.id}[${row.name}]@${row.host}:${row.agent_port}`;
}
