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
 * 选 host。
 * 不做 IP 分配,IP 由 pickBoundIp 单独调用(分两步便于测试)。
 */
export async function pickHost(opts: ScheduleOptions = {}): Promise<SchedulableHost> {
  if (opts.requireHostId) {
    const row = await queries.getHostById(opts.requireHostId);
    if (!row || row.status !== "ready") {
      throw new NodePoolUnavailableError(`host ${opts.requireHostId} not ready`);
    }
    const count = await queries.countActiveContainersOnHost(row.id);
    if (count >= row.max_containers) {
      throw new NodePoolBusyError(`host ${row.id} at capacity`);
    }
    return { row, activeContainers: count };
  }

  // sticky: user 最近的 host(status 必须 ready 且未满)
  if (typeof opts.userId === "number") {
    const sticky = await queries.findUserStickyHost(opts.userId);
    if (sticky) {
      const row = await queries.getHostById(sticky.hostUuid);
      if (row && row.status === "ready") {
        const count = await queries.countActiveContainersOnHost(row.id);
        if (count < row.max_containers) {
          log.debug("sticky host hit", { userId: opts.userId, hostId: row.id });
          return { row, activeContainers: count };
        }
      }
    }
  }

  // least-loaded
  const candidates = await queries.listSchedulableHosts();
  const ok = candidates.filter(
    (c) => c.activeContainers < c.row.max_containers,
  );
  if (ok.length === 0) {
    if (candidates.length === 0) {
      throw new NodePoolUnavailableError("no ready host");
    }
    throw new NodePoolBusyError("all ready hosts at capacity");
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
