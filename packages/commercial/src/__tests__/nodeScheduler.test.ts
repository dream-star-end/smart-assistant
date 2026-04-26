/**
 * V3 D.5 — compute-pool/nodeScheduler.ts 单测。
 *
 * 覆盖:
 *   pickHost:
 *     - requireHostId: 强制落单机(ready + 未满 → 返;非 ready → 抛)
 *     - sticky: 近期有活容器的 host 命中 → 直接返
 *     - sticky miss(host 非 ready 或满) → 走 least-loaded
 *     - 最少负载选择(多 host 从 activeContainers 最少挑)
 *     - 全部满 → NodePoolBusyError
 *     - 无 ready host → NodePoolUnavailableError
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
    created_at: opts.created_at ?? now,
    updated_at: opts.updated_at ?? now,
  } as ComputeHostRow;
}

class FakePool {
  hosts: ComputeHostRow[] = [];
  containers: FakeContainer[] = [];
  nextContainerId = 1;

  addHost(h: ComputeHostRow): void { this.hosts.push(h); }
  addContainer(c: Omit<FakeContainer, "id">): void {
    this.containers.push({ id: this.nextContainerId++, ...c });
  }
  async end(): Promise<void> { /* FakePool.end — no real connections */ }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const s = sql.trim();

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
    // listSchedulableHosts: SELECT ... WHERE status = 'ready' ORDER BY created_at
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
    // findUserStickyHost
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

  test("sticky: returns user's previous host when ready and not full", async () => {
    fp.addHost(mkHost({ id: "hA", name: "self", status: "ready", created_at: new Date(2026, 3, 1) }));
    fp.addHost(mkHost({ id: "hB", name: "tk-01", status: "ready", created_at: new Date(2026, 3, 2) }));
    fp.addContainer({ user_id: 42, host_uuid: "hB", bound_ip: "172.30.2.10", state: "active" });
    const r = await pickHost({ userId: 42 });
    assert.equal(r.row.id, "hB");
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

  test("cooldown 让 sticky fall-through 到 least-loaded", async () => {
    fp.addHost(mkHost({ id: "hSelf", name: "self", status: "ready", max_containers: 5, created_at: new Date(2026, 3, 1) }));
    fp.addHost(mkHost({ id: "hStuck", name: "tk1", status: "ready", max_containers: 5, created_at: new Date(2026, 3, 2) }));
    // user 42 sticky 在 hStuck
    fp.addContainer({ user_id: 42, host_uuid: "hStuck", bound_ip: "172.30.2.10", state: "active" });
    markHostCooldown("hStuck", 60_000);
    const r = await pickHost({ userId: 42 });
    // sticky 被 cooldown 跳,least-loaded 也排除 hStuck → 落 hSelf
    assert.equal(r.row.id, "hSelf");
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
