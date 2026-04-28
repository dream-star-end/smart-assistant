/**
 * V3 D.5 — compute-pool/nodeScheduler.ts 单测。
 *
 * 覆盖:
 *   pickHost:
 *     - requireHostId: 强制落单机(ready + 未满 → 返;非 ready → 抛)
 *     - dataHost(v1.0.17):用户最近一次容器(active 或 vanished)所在 host 命中
 *     - dataHost ready + 满 → NodePoolBusyError(不 fallback,数据完整性优先)
 *     - dataHost ready + cooldown → NodePoolBusyError(同上)
 *     - dataHost status=draining → NodePoolBusyError(admin 主动状态,数据仍在)
 *     - dataHost status=quarantined/broken → fall through(被动故障,host 真坏)
 *     - dataHost status=bootstrapping → fall through(过渡态)
 *     - vanished 命中(idle sweep 后重连场景)
 *     - 多个 host 都有 vanished → 取最近一次 created_at
 *     - 最少负载选择(多 host 从 activeContainers 最少挑)
 *     - 全部满 → NodePoolBusyError / 无 ready host → NodePoolUnavailableError
 *
 *   pickBoundIp:
 *     - 已有容器时,从 [.10, .250] 取最低未占用
 *     - 全部占用 → NodePoolBusyError
 *     - 未分配过容器的 host → fallback 172.30.<idx+1>.0/24
 *     - self host fallback 172.30.0.0/24
 *
 * 不测的(归 integ):
 *   - 真 PG
 *   - bound_ip uniq 冲突重试(INSERT 侧由 containerService 处理)
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";

import {
  pickHost,
  pickBoundIp,
  schedule,
  markHostCooldown,
  _clearHostCooldownForTests,
} from "../compute-pool/nodeScheduler.js";
import {
  NodePoolBusyError,
  NodePoolUnavailableError,
  type ComputeHostRow,
  type ComputeHostStatus,
} from "../compute-pool/types.js";
import { setPoolOverride, resetPool } from "../db/index.js";

// ───────────────────────────────────────────────────────────────────────
//  FakePool —— 按 SQL 关键字路由到内存数据。保持最小实现,只覆盖
//  nodeScheduler 真正用到的几条 query(getHostById / listSchedulableHosts /
//  countActiveContainersOnHost / findUserStickyHost / listAllHosts /
//  pickBoundIp 内联 SELECT bound_ip + bridgeCidrFromExisting)。
// ───────────────────────────────────────────────────────────────────────

interface FakeContainer {
  id: number;
  user_id: number;
  host_uuid: string;
  bound_ip: string;
  state: "active" | "vanished";
  /** v1.0.17 — findUserDataHost ORDER BY created_at DESC tie-break */
  created_at: Date;
}

function mkHost(
  opts: Partial<ComputeHostRow> & { id: string; name: string; status: ComputeHostStatus },
): ComputeHostRow {
  const now = new Date();
  return {
    id: opts.id,
    name: opts.name,
    host: opts.host ?? `${opts.name}.example.com`,
    ssh_port: opts.ssh_port ?? 22,
    ssh_user: opts.ssh_user ?? "root",
    agent_port: opts.agent_port ?? 9443,
    ssh_password_nonce: opts.ssh_password_nonce ?? null,
    ssh_password_ct: opts.ssh_password_ct ?? null,
    ssh_fingerprint: opts.ssh_fingerprint ?? null,
    agent_psk_nonce: opts.agent_psk_nonce ?? null,
    agent_psk_ct: opts.agent_psk_ct ?? null,
    agent_cert_pem: opts.agent_cert_pem ?? null,
    agent_cert_fingerprint_sha256: opts.agent_cert_fingerprint_sha256 ?? null,
    agent_cert_not_before: opts.agent_cert_not_before ?? null,
    agent_cert_not_after: opts.agent_cert_not_after ?? null,
    status: opts.status,
    last_bootstrap_at: opts.last_bootstrap_at ?? null,
    last_bootstrap_err: opts.last_bootstrap_err ?? null,
    last_health_at: opts.last_health_at ?? null,
    last_health_ok: opts.last_health_ok ?? null,
    last_health_err: opts.last_health_err ?? null,
    consecutive_health_fail: opts.consecutive_health_fail ?? 0,
    consecutive_health_ok: opts.consecutive_health_ok ?? 0,
    max_containers: opts.max_containers ?? 3,
    // bridge_cidr: migration 0032 新列。测试默认 null → pickBoundIp 走 fallback 路径,
    // 可单测显式传入 "172.30.x.0/24" 覆盖 DB 走源。
    bridge_cidr: opts.bridge_cidr ?? null,
    expires_at: opts.expires_at ?? null,
    created_at: opts.created_at ?? now,
    updated_at: opts.updated_at ?? now,
  } as ComputeHostRow;
}

class FakePool {
  hosts: ComputeHostRow[] = [];
  containers: FakeContainer[] = [];
  // pinnedByUser: 模拟 users.pinned_host_uuid 列(0040 migration)。
  // 不在测试里实例化整张 users 表,只存调度器需要的 user→host 映射。
  pinnedByUser = new Map<number, string | null>();
  nextContainerId = 1;
  // plan v4 round-2 — 让特定 host 在 placement gate 维度 fail。
  // 模拟 getSchedulableHostById / listSchedulableHosts 返 NULL/空集 的场景
  // (image-mismatch / dim stale 等)。仅影响 *Schedulable* 路径,getHostById
  // 仍按 status 字段返。
  gateFailHostIds = new Set<string>();

  addHost(h: ComputeHostRow): void { this.hosts.push(h); }
  addContainer(c: Omit<FakeContainer, "id" | "created_at"> & { created_at?: Date }): void {
    // 默认 created_at = now,按 nextContainerId 单调递增确保 ORDER BY id 稳定
    this.containers.push({
      id: this.nextContainerId++,
      created_at: c.created_at ?? new Date(),
      user_id: c.user_id,
      host_uuid: c.host_uuid,
      bound_ip: c.bound_ip,
      state: c.state,
    });
  }
  setUserPinnedHost(userId: number, hostId: string | null): void {
    this.pinnedByUser.set(userId, hostId);
  }
  setHostGateFail(hostId: string, fail: boolean): void {
    if (fail) this.gateFailHostIds.add(hostId);
    else this.gateFailHostIds.delete(hostId);
  }
  async end(): Promise<void> { /* FakePool.end — no real connections */ }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const s = sql.trim();

    // plan v4 round-2 — getSchedulableHostById:`WITH desired AS` + `WHERE id = $1`
    // 模拟 placement gate:gateFailHostIds 中的 host 视作 gate fail (返 0 行);
    // 其他按 status='ready' 通过(测试默认不模拟 image/dim 维度,full gate 由
    // queriesAtomicLifecycle.integ 测真 PG)。
    if (/WITH desired AS/.test(s) && /WHERE id = \$1/.test(s)) {
      const id = params[0] as string;
      const h = this.hosts.find((x) => x.id === id);
      if (!h || h.status !== "ready" || this.gateFailHostIds.has(id)) {
        return { rows: [], rowCount: 0 };
      }
      const row = {
        ...h,
        active_containers: String(
          this.containers.filter((c) => c.host_uuid === h.id && c.state === "active").length,
        ),
      };
      return { rows: [row], rowCount: 1 };
    }
    // plan v4 round-2 — listSchedulableHosts (CTE shape):
    // 同上,gateFailHostIds 中的 host 排除。
    if (/WITH desired AS/.test(s) && /FROM compute_hosts, desired/.test(s)) {
      const rows = this.hosts
        .filter((h) => h.status === "ready" && !this.gateFailHostIds.has(h.id))
        .slice()
        .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
        .map((h) => ({
          ...h,
          active_containers: String(
            this.containers.filter((c) => c.host_uuid === h.id && c.state === "active").length,
          ),
        }));
      return { rows, rowCount: rows.length };
    }
    // getHostById
    if (/FROM compute_hosts\s+WHERE id = \$1\s+LIMIT 1/.test(s)) {
      const id = params[0] as string;
      const row = this.hosts.find((h) => h.id === id) ?? null;
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    // getHostByName
    if (/FROM compute_hosts\s+WHERE name = \$1\s+LIMIT 1/.test(s)) {
      const name = params[0] as string;
      const row = this.hosts.find((h) => h.name === name) ?? null;
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    // 旧 listSchedulableHosts 兜底(legacy `WHERE status = 'ready'` 直接 WHERE)。
    // 当前 0042 已迁到 CTE;留这分支兼容潜在 ad-hoc 老查询。
    if (/WHERE status = 'ready'/.test(s) && /FROM compute_hosts/.test(s)) {
      const rows = this.hosts
        .filter((h) => h.status === "ready")
        .slice()
        .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
        .map((h) => ({
          ...h,
          active_containers: String(
            this.containers.filter((c) => c.host_uuid === h.id && c.state === "active").length,
          ),
        }));
      return { rows, rowCount: rows.length };
    }
    // listAllHosts (no WHERE status)
    if (/FROM compute_hosts\s+ORDER BY created_at ASC/.test(s) && !/WHERE/.test(s)) {
      const rows = this.hosts
        .slice()
        .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
      return { rows, rowCount: rows.length };
    }
    // countActiveContainersOnHost
    if (/SELECT COUNT\(\*\)::text AS n FROM agent_containers/.test(s)) {
      const hostUuid = params[0] as string;
      const n = this.containers.filter(
        (c) => c.host_uuid === hostUuid && c.state === "active",
      ).length;
      return { rows: [{ n: String(n) }], rowCount: 1 };
    }
    // getUserPinnedHost: SELECT pinned_host_uuid FROM users WHERE id = $1
    if (/SELECT pinned_host_uuid FROM users WHERE id = \$1/.test(s)) {
      const userId = params[0] as number;
      // map.get 没设 → undefined → 视为 user 不存在,返 0 行(scheduler 会按 NULL 处理)
      const v = this.pinnedByUser.get(userId);
      if (v === undefined) return { rows: [], rowCount: 0 };
      return { rows: [{ pinned_host_uuid: v }], rowCount: 1 };
    }
    // findUserDataHost (v1.0.17): 按 SQL 标识 `state IN ('active', 'vanished')` 区分
    // —— active 优先,然后 created_at DESC,最后 id DESC tie-break。
    if (
      /FROM agent_containers ac\s+JOIN compute_hosts ch/.test(s)
      && /state IN \('active', 'vanished'\)/.test(s)
    ) {
      const userId = params[0] as number;
      // 过滤 host_uuid !== "" + state ∈ {active, vanished} + user_id 匹配
      const candidates = this.containers
        .filter((x) => x.user_id === userId && (x.state === "active" || x.state === "vanished") && x.host_uuid)
        .filter((x) => this.hosts.some((h) => h.id === x.host_uuid));
      if (candidates.length === 0) return { rows: [], rowCount: 0 };
      // ORDER BY (state='active') DESC, created_at DESC, id DESC
      candidates.sort((a, b) => {
        const aActive = a.state === "active" ? 1 : 0;
        const bActive = b.state === "active" ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        const dt = b.created_at.getTime() - a.created_at.getTime();
        if (dt !== 0) return dt;
        return b.id - a.id;
      });
      const c = candidates[0]!;
      const host = this.hosts.find((h) => h.id === c.host_uuid)!;
      return {
        rows: [{
          container_id: String(c.id),
          host_uuid: c.host_uuid,
          host_status: host.status,
          state: c.state,
        }],
        rowCount: 1,
      };
    }
    // findUserStickyHost (legacy: 只查 active —— sshMux resolvePlacement 仍依赖)
    if (/FROM agent_containers ac\s+JOIN compute_hosts ch/.test(s)) {
      const userId = params[0] as number;
      const c = this.containers.find((x) => x.user_id === userId && x.state === "active");
      if (!c) return { rows: [], rowCount: 0 };
      const host = this.hosts.find((h) => h.id === c.host_uuid);
      if (!host) return { rows: [], rowCount: 0 };
      return {
        rows: [{ container_id: String(c.id), host_uuid: c.host_uuid, host_status: host.status }],
        rowCount: 1,
      };
    }
    // bridgeCidrFromExisting: SELECT bound_ip FROM agent_containers WHERE host_uuid=$1 AND bound_ip IS NOT NULL LIMIT 1
    if (/SELECT bound_ip\s+FROM agent_containers/.test(s) && /LIMIT 1/.test(s)) {
      const hostUuid = params[0] as string;
      const c = this.containers.find((x) => x.host_uuid === hostUuid && x.bound_ip);
      return { rows: c ? [{ bound_ip: c.bound_ip }] : [], rowCount: c ? 1 : 0 };
    }
    // pickBoundIp inline: SELECT bound_ip FROM agent_containers WHERE host_uuid=$1 AND state='active' AND bound_ip IS NOT NULL
    if (/SELECT bound_ip\s+FROM agent_containers/.test(s)) {
      const hostUuid = params[0] as string;
      const rows = this.containers
        .filter((x) => x.host_uuid === hostUuid && x.state === "active" && x.bound_ip)
        .map((c) => ({ bound_ip: c.bound_ip }));
      return { rows, rowCount: rows.length };
    }
    throw new Error(`FakePool: unhandled SQL:\n${s}`);
  }
}

function installFake(): FakePool {
  const fp = new FakePool();
  setPoolOverride(fp as unknown as Pool);
  return fp;
}

// ───────────────────────────────────────────────────────────────────────

describe("nodeScheduler.pickHost", () => {
  let fp: FakePool;
  beforeEach(() => { fp = installFake(); });
  afterEach(async () => { await resetPool(); });

  test("requireHostId returns that host when ready and under capacity", async () => {
    fp.addHost(mkHost({ id: "h1", name: "self", status: "ready", max_containers: 3 }));
    const r = await pickHost({ requireHostId: "h1" });
    assert.equal(r.row.id, "h1");
    assert.equal(r.activeContainers, 0);
  });

  test("requireHostId throws NodePoolUnavailableError when host not ready", async () => {
    fp.addHost(mkHost({ id: "h2", name: "b1", status: "bootstrapping" }));
    await assert.rejects(pickHost({ requireHostId: "h2" }), NodePoolUnavailableError);
  });

  test("requireHostId throws NodePoolBusyError when host at capacity", async () => {
    fp.addHost(mkHost({ id: "h3", name: "t1", status: "ready", max_containers: 1 }));
    fp.addContainer({ user_id: 10, host_uuid: "h3", bound_ip: "172.30.1.10", state: "active" });
    await assert.rejects(pickHost({ requireHostId: "h3" }), NodePoolBusyError);
  });

  test("dataHost: returns user's previous host when ready and not full (active container)", async () => {
    fp.addHost(mkHost({ id: "hA", name: "self", status: "ready", created_at: new Date(2026, 3, 1) }));
    fp.addHost(mkHost({ id: "hB", name: "tk-01", status: "ready", created_at: new Date(2026, 3, 2) }));
    fp.addContainer({ user_id: 42, host_uuid: "hB", bound_ip: "172.30.2.10", state: "active" });
    const r = await pickHost({ userId: 42 });
    assert.equal(r.row.id, "hB");
  });

  // v1.0.17 — 关键修复:idle sweep 销毁后 user 重连,vanished 容器仍能命中 sticky,
  // 让 user 回到原 host 拿原 docker volume(不在新 host 创建空 volume)。
  test("dataHost: vanished container 命中 sticky(idle sweep 后重连场景)", async () => {
    fp.addHost(mkHost({ id: "hA", name: "self", status: "ready", created_at: new Date(2026, 3, 1) }));
    fp.addHost(mkHost({ id: "hB", name: "tk-01", status: "ready", created_at: new Date(2026, 3, 2) }));
    // user 42 之前在 hB 跑过容器,但 idle sweep 已 vanished
    fp.addContainer({ user_id: 42, host_uuid: "hB", bound_ip: "172.30.2.10", state: "vanished" });
    const r = await pickHost({ userId: 42 });
    assert.equal(r.row.id, "hB");
  });

  test("dataHost: 多个 host 都有 vanished → 取最近一次 created_at", async () => {
    fp.addHost(mkHost({ id: "hA", name: "self", status: "ready", created_at: new Date(2026, 3, 1) }));
    fp.addHost(mkHost({ id: "hB", name: "tk-01", status: "ready", created_at: new Date(2026, 3, 2) }));
    fp.addHost(mkHost({ id: "hC", name: "boheyun-1", status: "ready", created_at: new Date(2026, 3, 3) }));
    // user 42 历史:hA → hB → hC, 都 vanished;最近一次在 hC
    fp.addContainer({ user_id: 42, host_uuid: "hA", bound_ip: "172.30.0.10", state: "vanished", created_at: new Date(2026, 3, 10) });
    fp.addContainer({ user_id: 42, host_uuid: "hB", bound_ip: "172.30.1.10", state: "vanished", created_at: new Date(2026, 3, 20) });
    fp.addContainer({ user_id: 42, host_uuid: "hC", bound_ip: "172.30.2.10", state: "vanished", created_at: new Date(2026, 3, 25) });
    const r = await pickHost({ userId: 42 });
    assert.equal(r.row.id, "hC");
  });

  test("dataHost: active 优先于 vanished(即便 vanished 更新)", async () => {
    fp.addHost(mkHost({ id: "hA", name: "self", status: "ready", created_at: new Date(2026, 3, 1) }));
    fp.addHost(mkHost({ id: "hB", name: "tk-01", status: "ready", created_at: new Date(2026, 3, 2) }));
    // 病态情况:vanished 比 active 更新(理论上不会,active 总是最新写;但
    // ORDER BY 必须显式 active 优先以防 clock skew 或测试时序)
    fp.addContainer({ user_id: 42, host_uuid: "hA", bound_ip: "172.30.0.10", state: "active", created_at: new Date(2026, 3, 1) });
    fp.addContainer({ user_id: 42, host_uuid: "hB", bound_ip: "172.30.1.10", state: "vanished", created_at: new Date(2026, 3, 30) });
    const r = await pickHost({ userId: 42 });
    assert.equal(r.row.id, "hA"); // active wins
  });

  // v1.0.17 关键策略:dataHost ready 但满 → throw NodePoolBusyError,**不 fallback**,
  // 因为 fallback 到 least-loaded 会在新 host 上写空 volume,等同丢数据。
  test("dataHost ready + 满 → 抛 NodePoolBusyError(不 fallback,数据完整性优先)", async () => {
    fp.addHost(mkHost({ id: "hData", name: "self", status: "ready", max_containers: 1, created_at: new Date(2026, 3, 1) }));
    fp.addHost(mkHost({ id: "hOther", name: "tk-01", status: "ready", max_containers: 5, created_at: new Date(2026, 3, 2) }));
    // user 42 数据在 hData(vanished),但 hData 已被别的 user 占满
    fp.addContainer({ user_id: 42, host_uuid: "hData", bound_ip: "172.30.0.10", state: "vanished" });
    fp.addContainer({ user_id: 99, host_uuid: "hData", bound_ip: "172.30.0.11", state: "active" }); // 占满
    // 必须抛 busy,而不是 fall-through 到 hOther 写空 volume
    await assert.rejects(pickHost({ userId: 42 }), NodePoolBusyError);
  });

  // v1.0.17 关键策略:dataHost 被动故障(quarantined/broken)→ fall through 到
  // least-loaded(host 真坏,数据救不回来,优先可用性)。draining 是 admin 主动
  // 状态,**不**走 fall through 而是 throw busy(见上方独立 test)。
  test("dataHost status=quarantined → fall through 到 least-loaded(数据丢失 trade-off:host 真坏)", async () => {
    fp.addHost(mkHost({ id: "hData", name: "self", status: "quarantined", created_at: new Date(2026, 3, 1) }));
    fp.addHost(mkHost({ id: "hOther", name: "tk-01", status: "ready", max_containers: 5, created_at: new Date(2026, 3, 2) }));
    fp.addContainer({ user_id: 42, host_uuid: "hData", bound_ip: "172.30.0.10", state: "vanished" });
    const r = await pickHost({ userId: 42 });
    assert.equal(r.row.id, "hOther");
  });

  // v1.0.17 — draining 是 admin **主动**状态(预备下架),数据 volume 仍在
  // host 本地,fall-through 会重现空 volume bug。必须抛 busy,让用户 retry 等
  // admin 完成迁移流程。
  test("dataHost status=draining → 抛 NodePoolBusyError(admin 主动状态,数据完整性优先)", async () => {
    fp.addHost(mkHost({ id: "hData", name: "self", status: "draining", created_at: new Date(2026, 3, 1) }));
    fp.addHost(mkHost({ id: "hOther", name: "tk-01", status: "ready", max_containers: 5, created_at: new Date(2026, 3, 2) }));
    fp.addContainer({ user_id: 42, host_uuid: "hData", bound_ip: "172.30.0.10", state: "vanished" });
    await assert.rejects(pickHost({ userId: 42 }), NodePoolBusyError);
  });

  // v1.0.17 — broken(被动故障:bootstrap 失败) → fall through(host 真挂,优先可用)
  test("dataHost status=broken → fall through 到 least-loaded(被动故障,host 真挂)", async () => {
    fp.addHost(mkHost({ id: "hData", name: "self", status: "broken", created_at: new Date(2026, 3, 1) }));
    fp.addHost(mkHost({ id: "hOther", name: "tk-01", status: "ready", max_containers: 5, created_at: new Date(2026, 3, 2) }));
    fp.addContainer({ user_id: 42, host_uuid: "hData", bound_ip: "172.30.0.10", state: "vanished" });
    const r = await pickHost({ userId: 42 });
    assert.equal(r.row.id, "hOther");
  });

  // v1.0.17 — bootstrapping(过渡态)→ fall through(host 还没就绪)
  test("dataHost status=bootstrapping → fall through 到 least-loaded", async () => {
    fp.addHost(mkHost({ id: "hData", name: "self", status: "bootstrapping", created_at: new Date(2026, 3, 1) }));
    fp.addHost(mkHost({ id: "hOther", name: "tk-01", status: "ready", max_containers: 5, created_at: new Date(2026, 3, 2) }));
    fp.addContainer({ user_id: 42, host_uuid: "hData", bound_ip: "172.30.0.10", state: "vanished" });
    const r = await pickHost({ userId: 42 });
    assert.equal(r.row.id, "hOther");
  });

  test("无 dataHost(全新 user)→ least-loaded", async () => {
    fp.addHost(mkHost({ id: "hA", name: "self", status: "ready", max_containers: 5, created_at: new Date(2026, 3, 1) }));
    fp.addHost(mkHost({ id: "hB", name: "tk-01", status: "ready", max_containers: 5, created_at: new Date(2026, 3, 2) }));
    // user 42 没有任何容器历史
    const r = await pickHost({ userId: 42 });
    assert.equal(r.row.id, "hA"); // 0 active
  });

  test("least-loaded: picks host with fewest active containers", async () => {
    // hA newer but has 0 containers, hB older with 2
    fp.addHost(mkHost({ id: "hA", name: "n1", status: "ready", max_containers: 5, created_at: new Date(2026, 3, 2) }));
    fp.addHost(mkHost({ id: "hB", name: "n2", status: "ready", max_containers: 5, created_at: new Date(2026, 3, 1) }));
    fp.addContainer({ user_id: 1, host_uuid: "hB", bound_ip: "172.30.1.10", state: "active" });
    fp.addContainer({ user_id: 2, host_uuid: "hB", bound_ip: "172.30.1.11", state: "active" });
    const r = await pickHost({});
    assert.equal(r.row.id, "hA");
  });

  test("all ready hosts at capacity surface as NodePoolUnavailableError (listSchedulableHosts pre-filters full hosts)", async () => {
    fp.addHost(mkHost({ id: "hF", name: "full", status: "ready", max_containers: 1 }));
    fp.addContainer({ user_id: 1, host_uuid: "hF", bound_ip: "172.30.1.10", state: "active" });
    // listSchedulableHosts SQL 已经 `WHERE status='ready'` + JS 侧过滤 `<max_containers`;
    // 两个都满足不了 → candidates 空 → pickHost 抛 NodePoolUnavailableError 而不是 Busy。
    await assert.rejects(pickHost({}), NodePoolUnavailableError);
  });

  test("no ready host throws NodePoolUnavailableError", async () => {
    fp.addHost(mkHost({ id: "hQ", name: "sick", status: "quarantined" }));
    await assert.rejects(pickHost({}), NodePoolUnavailableError);
  });
});

// ───────────────────────────────────────────────────────────────────────
//  v1.0.7 — host cooldown:
//  上层 v3ensureRunning 在 docker run 抛"Address already in use"类宿主级冲突
//  时调 markHostCooldown,该 host 60s 内 pickHost 跳过,用户下次 5s 重连
//  自然换台。
// ───────────────────────────────────────────────────────────────────────

describe("nodeScheduler.pickHost — host cooldown (v1.0.7)", () => {
  let fp: FakePool;
  beforeEach(() => { fp = installFake(); _clearHostCooldownForTests(); });
  afterEach(async () => { _clearHostCooldownForTests(); await resetPool(); });

  test("cooldown 中的 host 在 least-loaded 路径被剔除", async () => {
    fp.addHost(mkHost({ id: "hA", name: "n1", status: "ready", max_containers: 5, created_at: new Date(2026, 3, 1) }));
    fp.addHost(mkHost({ id: "hB", name: "n2", status: "ready", max_containers: 5, created_at: new Date(2026, 3, 2) }));
    // hA 0 active,hB 1 active —— 默认 hA 会被选(0 < 1)
    fp.addContainer({ user_id: 1, host_uuid: "hB", bound_ip: "172.30.2.10", state: "active" });
    // 标 hA cooldown 60s,接下来必须落 hB(虽然 hB load 高)
    markHostCooldown("hA", 60_000);
    const r = await pickHost({});
    assert.equal(r.row.id, "hB");
  });

  // v1.0.17 — dataHost ready + cooldown 的策略从 "fall-through" 改为
  // "throw NodePoolBusyError",原因:fall-through 到另一台 host 会
  // 创建空 docker volume,等同丢用户工作区数据。NodePoolBusyError
  // 让客户端 5s 后重试,届时 cooldown 自然过期,继续回到原 host。
  test("dataHost 在 cooldown → 抛 NodePoolBusyError(不 fallback,数据完整性优先)", async () => {
    fp.addHost(mkHost({ id: "hSelf", name: "self", status: "ready", max_containers: 5, created_at: new Date(2026, 3, 1) }));
    fp.addHost(mkHost({ id: "hStuck", name: "tk1", status: "ready", max_containers: 5, created_at: new Date(2026, 3, 2) }));
    // user 42 数据在 hStuck (active)
    fp.addContainer({ user_id: 42, host_uuid: "hStuck", bound_ip: "172.30.2.10", state: "active" });
    markHostCooldown("hStuck", 60_000);
    // 必须抛 busy(等待 cooldown 过期回到 hStuck),而不是 fall-through 到 hSelf 写空 volume
    await assert.rejects(pickHost({ userId: 42 }), NodePoolBusyError);
  });

  test("requireHostId 显式指定时,绕过 cooldown(admin debug 不受限)", async () => {
    fp.addHost(mkHost({ id: "hX", name: "tk-x", status: "ready", max_containers: 5 }));
    markHostCooldown("hX", 60_000);
    const r = await pickHost({ requireHostId: "hX" });
    assert.equal(r.row.id, "hX");
  });

  test("所有 ready host 都在 cooldown → NodePoolBusyError", async () => {
    fp.addHost(mkHost({ id: "hA", name: "n1", status: "ready", max_containers: 5 }));
    fp.addHost(mkHost({ id: "hB", name: "n2", status: "ready", max_containers: 5 }));
    markHostCooldown("hA", 60_000);
    markHostCooldown("hB", 60_000);
    await assert.rejects(pickHost({}), NodePoolBusyError);
  });

  test("过期 cooldown 自动失效(durationMs 已过 → 重新可调度)", async () => {
    fp.addHost(mkHost({ id: "hA", name: "n1", status: "ready", max_containers: 5 }));
    // 标负毫秒 duration 不会写入(防御性);标 1ms 然后等 5ms 即过期
    markHostCooldown("hA", 1);
    await new Promise((r) => setTimeout(r, 5));
    const r = await pickHost({});
    assert.equal(r.row.id, "hA");
  });

  test("markHostCooldown 重复标取较晚的过期时间", async () => {
    fp.addHost(mkHost({ id: "hA", name: "n1", status: "ready", max_containers: 5 }));
    fp.addHost(mkHost({ id: "hB", name: "n2", status: "ready", max_containers: 5 }));
    markHostCooldown("hA", 60_000);
    markHostCooldown("hA", 1); // 想缩短不行,保留长的
    const r = await pickHost({});
    assert.equal(r.row.id, "hB"); // hA 仍在 cooldown
  });

  test("非法参数(空 hostId / 0 / 负 / NaN duration)被静默忽略", async () => {
    fp.addHost(mkHost({ id: "hA", name: "n1", status: "ready", max_containers: 5 }));
    markHostCooldown("", 60_000);
    markHostCooldown("hA", 0);
    markHostCooldown("hA", -100);
    markHostCooldown("hA", Number.NaN);
    const r = await pickHost({});
    assert.equal(r.row.id, "hA"); // 都没生效
  });
});

// ───────────────────────────────────────────────────────────────────────
//  0040 — user-level host pin:
//  admin 把特定 user 钉到特定 host(QA/测试)。pinned 优先级高于 sticky,
//  低于 requireHostId。host 不可用时 fall-through 到 sticky/least-loaded。
// ───────────────────────────────────────────────────────────────────────

describe("nodeScheduler.pickHost — user-level pinned host (0040)", () => {
  let fp: FakePool;
  beforeEach(() => { fp = installFake(); _clearHostCooldownForTests(); });
  afterEach(async () => { _clearHostCooldownForTests(); await resetPool(); });

  test("pinned host ready 且未满 → 命中并优先于 sticky", async () => {
    fp.addHost(mkHost({ id: "hPin", name: "self", status: "ready", max_containers: 5, created_at: new Date(2026, 3, 1) }));
    fp.addHost(mkHost({ id: "hSticky", name: "tk1", status: "ready", max_containers: 5, created_at: new Date(2026, 3, 2) }));
    // user 50 sticky 在 hSticky,但 pinned 在 hPin → 必须命中 pinned
    fp.addContainer({ user_id: 50, host_uuid: "hSticky", bound_ip: "172.30.2.10", state: "active" });
    fp.setUserPinnedHost(50, "hPin");
    const r = await pickHost({ userId: 50 });
    assert.equal(r.row.id, "hPin");
  });

  test("pinned host 不存在 → fall-through 到 sticky", async () => {
    fp.addHost(mkHost({ id: "hSticky", name: "self", status: "ready", max_containers: 5 }));
    fp.addContainer({ user_id: 51, host_uuid: "hSticky", bound_ip: "172.30.0.10", state: "active" });
    // pin 写到一个不存在的 host id(host 已被删 + ON DELETE SET NULL 之前的 race 罕见;
    // 测一遍稳健性)
    fp.setUserPinnedHost(51, "hGhost");
    const r = await pickHost({ userId: 51 });
    assert.equal(r.row.id, "hSticky");
  });

  test("pinned host status=draining → fall-through", async () => {
    fp.addHost(mkHost({ id: "hPin", name: "tk1", status: "draining", max_containers: 5, created_at: new Date(2026, 3, 1) }));
    fp.addHost(mkHost({ id: "hOk", name: "self", status: "ready", max_containers: 5, created_at: new Date(2026, 3, 2) }));
    fp.setUserPinnedHost(52, "hPin");
    const r = await pickHost({ userId: 52 });
    assert.equal(r.row.id, "hOk"); // 没 sticky,落 least-loaded
  });

  test("pinned host 满容量 → fall-through 到 least-loaded", async () => {
    fp.addHost(mkHost({ id: "hPin", name: "tk1", status: "ready", max_containers: 1, created_at: new Date(2026, 3, 1) }));
    fp.addHost(mkHost({ id: "hOk", name: "self", status: "ready", max_containers: 5, created_at: new Date(2026, 3, 2) }));
    fp.addContainer({ user_id: 99, host_uuid: "hPin", bound_ip: "172.30.1.10", state: "active" }); // 占满
    fp.setUserPinnedHost(53, "hPin");
    const r = await pickHost({ userId: 53 });
    assert.equal(r.row.id, "hOk");
  });

  test("pinned host 在 cooldown → fall-through(关键: 不能破坏瞬态故障自愈)", async () => {
    fp.addHost(mkHost({ id: "hPin", name: "tk1", status: "ready", max_containers: 5, created_at: new Date(2026, 3, 1) }));
    fp.addHost(mkHost({ id: "hOk", name: "self", status: "ready", max_containers: 5, created_at: new Date(2026, 3, 2) }));
    fp.setUserPinnedHost(54, "hPin");
    markHostCooldown("hPin", 60_000);
    const r = await pickHost({ userId: 54 });
    assert.equal(r.row.id, "hOk");
  });

  test("pinned NULL → 维持原 sticky/least-loaded 行为", async () => {
    fp.addHost(mkHost({ id: "hA", name: "n1", status: "ready", max_containers: 5, created_at: new Date(2026, 3, 1) }));
    fp.addHost(mkHost({ id: "hB", name: "n2", status: "ready", max_containers: 5, created_at: new Date(2026, 3, 2) }));
    fp.setUserPinnedHost(55, null); // 显式 NULL
    fp.addContainer({ user_id: 55, host_uuid: "hB", bound_ip: "172.30.2.10", state: "active" });
    const r = await pickHost({ userId: 55 });
    assert.equal(r.row.id, "hB"); // sticky
  });

  test("requireHostId 仍优先于 pinned(admin debug 最高级)", async () => {
    fp.addHost(mkHost({ id: "hPin", name: "tk1", status: "ready", max_containers: 5 }));
    fp.addHost(mkHost({ id: "hForce", name: "self", status: "ready", max_containers: 5 }));
    fp.setUserPinnedHost(56, "hPin");
    const r = await pickHost({ userId: 56, requireHostId: "hForce" });
    assert.equal(r.row.id, "hForce");
  });

  test("opts.userId 不传 → 完全不查 pin", async () => {
    fp.addHost(mkHost({ id: "hOnly", name: "self", status: "ready", max_containers: 5 }));
    // 没设 pin,且不传 userId → least-loaded
    const r = await pickHost({});
    assert.equal(r.row.id, "hOnly");
  });
});

// ───────────────────────────────────────────────────────────────────────
//  plan v4 round-2 — placement gate (loaded_image 对齐 + dim 新鲜) 在 bypass
//  路径上的强制执行。pinned/dataHost 走 getSchedulableHostById,任一维度 fail
//  即视作"该 host 暂时不可调度",分别按各自策略处理:
//    - pinned: gate-fail → fall-through(避免被特定 host 维护期卡死)
//    - dataHost: gate-fail → throw NodePoolBusyError(数据完整性优先,不
//      fall-through 到空 volume)
//    - requireHostId: 仍只看 status='ready'(admin debug 最高优先级,有意 bypass)
// ───────────────────────────────────────────────────────────────────────

describe("nodeScheduler.pickHost — placement gate full enforcement (round-2)", () => {
  let fp: FakePool;
  beforeEach(() => { fp = installFake(); _clearHostCooldownForTests(); });
  afterEach(async () => { _clearHostCooldownForTests(); await resetPool(); });

  test("pinned host status=ready 但 gate fail → fall-through(避免单 host 维护期卡死 pin 用户)", async () => {
    fp.addHost(mkHost({ id: "hPin", name: "tk1", status: "ready", max_containers: 5, created_at: new Date(2026, 3, 1) }));
    fp.addHost(mkHost({ id: "hOk", name: "self", status: "ready", max_containers: 5, created_at: new Date(2026, 3, 2) }));
    // hPin status='ready' 但 gate fail(模拟 image 还没 distribute / dim stale)
    fp.setHostGateFail("hPin", true);
    fp.setUserPinnedHost(60, "hPin");
    const r = await pickHost({ userId: 60 });
    assert.equal(r.row.id, "hOk", "pinned gate-fail 必须 fall-through 而不是被卡");
  });

  test("dataHost status=ready 但 gate fail → 抛 NodePoolBusyError(数据优先,等 retry)", async () => {
    fp.addHost(mkHost({ id: "hData", name: "tk1", status: "ready", max_containers: 5, created_at: new Date(2026, 3, 1) }));
    fp.addHost(mkHost({ id: "hOk", name: "self", status: "ready", max_containers: 5, created_at: new Date(2026, 3, 2) }));
    // user 61 的数据(volume)在 hData;hData ready 但 gate fail
    fp.addContainer({ user_id: 61, host_uuid: "hData", bound_ip: "172.30.1.10", state: "vanished" });
    fp.setHostGateFail("hData", true);
    // 必须抛 busy 而不是 fall-through 到 hOk(fall-through = 写空 volume)
    await assert.rejects(
      pickHost({ userId: 61 }),
      (e: unknown) =>
        e instanceof NodePoolBusyError && /not schedulable.*gate fail/.test((e as Error).message),
    );
  });

  test("dataHost gate fail + 没 fallback host → 仍抛 busy(不会因没 fallback 翻车)", async () => {
    // 只有一个 host(dataHost),还 gate fail。结果仍是 busy(数据优先),
    // 不是 NodePoolUnavailableError(unavailable 是"全集没 ready 节点")
    fp.addHost(mkHost({ id: "hData", name: "self", status: "ready", max_containers: 5, created_at: new Date(2026, 3, 1) }));
    fp.addContainer({ user_id: 62, host_uuid: "hData", bound_ip: "172.30.0.10", state: "active" });
    fp.setHostGateFail("hData", true);
    await assert.rejects(pickHost({ userId: 62 }), NodePoolBusyError);
  });

  test("requireHostId 仍只看 status(有意 bypass full gate,admin debug 最高级)", async () => {
    // 即使 gate fail,requireHostId 路径仍按老语义放行(只查 status='ready' + 容量)
    fp.addHost(mkHost({ id: "hX", name: "tk-x", status: "ready", max_containers: 5 }));
    fp.setHostGateFail("hX", true);
    const r = await pickHost({ requireHostId: "hX" });
    assert.equal(r.row.id, "hX", "requireHostId 路径不受 placement gate 影响");
  });

  test("least-loaded 路径排除 gate fail host", async () => {
    fp.addHost(mkHost({ id: "hBad", name: "tk1", status: "ready", max_containers: 5, created_at: new Date(2026, 3, 1) }));
    fp.addHost(mkHost({ id: "hOk", name: "self", status: "ready", max_containers: 5, created_at: new Date(2026, 3, 2) }));
    fp.setHostGateFail("hBad", true);
    const r = await pickHost({});
    assert.equal(r.row.id, "hOk");
  });

  test("pinned + dataHost 同 host gate fail:dataHost 语义优先(throw busy 而非 pinned 的 fall-through)", async () => {
    // 真实场景:user 既被 admin pin 到 hX,数据也在 hX;hX gate fail。
    // pinned 检查先执行,fall-through;然后 dataHost 检查命中相同 host → throw busy。
    // (这是 pickHost 当前的执行顺序:pinned → dataHost → least-loaded)
    fp.addHost(mkHost({ id: "hX", name: "tk1", status: "ready", max_containers: 5, created_at: new Date(2026, 3, 1) }));
    fp.addHost(mkHost({ id: "hOk", name: "self", status: "ready", max_containers: 5, created_at: new Date(2026, 3, 2) }));
    fp.setUserPinnedHost(63, "hX");
    fp.addContainer({ user_id: 63, host_uuid: "hX", bound_ip: "172.30.1.10", state: "active" });
    fp.setHostGateFail("hX", true);
    // dataHost 关卡先于 least-loaded;数据完整性兜底 → busy
    await assert.rejects(pickHost({ userId: 63 }), NodePoolBusyError);
  });
});

describe("nodeScheduler.pickBoundIp", () => {
  let fp: FakePool;
  beforeEach(() => { fp = installFake(); });
  afterEach(async () => { await resetPool(); });

  test("lowest unused in [.10, .250] when some IPs occupied", async () => {
    fp.addHost(mkHost({ id: "hX", name: "nX", status: "ready", created_at: new Date(2026, 3, 1) }));
    fp.addContainer({ user_id: 1, host_uuid: "hX", bound_ip: "172.30.1.10", state: "active" });
    fp.addContainer({ user_id: 2, host_uuid: "hX", bound_ip: "172.30.1.11", state: "active" });
    const { boundIp, cidr } = await pickBoundIp("hX");
    assert.equal(boundIp, "172.30.1.12");
    assert.equal(cidr, "172.30.1.0/24");
  });

  test("self host fallback CIDR 172.30.0.0/24 when no containers yet", async () => {
    fp.addHost(mkHost({ id: "hSelf", name: "self", status: "ready", created_at: new Date(2026, 3, 1) }));
    const { boundIp, cidr } = await pickBoundIp("hSelf");
    assert.equal(cidr, "172.30.0.0/24");
    assert.equal(boundIp, "172.30.0.10");
  });

  test("uses row.bridge_cidr when DB column is set (0032+)", async () => {
    // migration 0032 后 admin createHost 已落 DB。pickBoundIp 必须优先读 DB,
    // 不再触达 bridgeCidrFromExisting / fallback 公式。
    fp.addHost(
      mkHost({
        id: "hDB",
        name: "tk-db",
        status: "ready",
        bridge_cidr: "172.30.2.0/24",
        created_at: new Date(2026, 3, 1),
      }),
    );
    const { boundIp, cidr } = await pickBoundIp("hDB");
    assert.equal(cidr, "172.30.2.0/24");
    assert.equal(boundIp, "172.30.2.10");
  });

  test("non-self fallback CIDR 172.30.<idx+1>.0/24", async () => {
    fp.addHost(mkHost({ id: "hSelf", name: "self", status: "ready", created_at: new Date(2026, 3, 1) }));
    fp.addHost(mkHost({ id: "hA", name: "tk-01", status: "ready", created_at: new Date(2026, 3, 2) }));
    fp.addHost(mkHost({ id: "hB", name: "tk-02", status: "ready", created_at: new Date(2026, 3, 3) }));
    const r1 = await pickBoundIp("hA");
    assert.equal(r1.cidr, "172.30.1.0/24");
    const r2 = await pickBoundIp("hB");
    assert.equal(r2.cidr, "172.30.2.0/24");
  });
});

describe("nodeScheduler.schedule", () => {
  let fp: FakePool;
  beforeEach(() => { fp = installFake(); });
  afterEach(async () => { await resetPool(); });

  test("combined pickHost + pickBoundIp returns Placement", async () => {
    fp.addHost(mkHost({ id: "hZ", name: "self", status: "ready", max_containers: 10, created_at: new Date(2026, 3, 1) }));
    const p = await schedule({});
    assert.equal(p.hostId, "hZ");
    assert.equal(p.hostHost, "self.example.com");
    assert.equal(p.agentPort, 9443);
    assert.equal(p.bridgeCidr, "172.30.0.0/24");
    assert.match(p.boundIp, /^172\.30\.0\.(1\d|2\d\d?|\d{2,3})$/);
    assert.equal(p.boundIp, "172.30.0.10");
  });
});
