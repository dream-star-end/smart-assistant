/**
 * V3 Phase 3G — agent-sandbox/v3volumeGc.ts 单测。
 *
 * v1.0.106 P1 改动:`removeV3Volume` 从单机 docker 改成跨 host fan-out
 * (`containerService.removeVolume(hostId, name)` × ready/draining hosts);
 * 测试镜像 mock 从 docker.getVolume 升到 containerService + listAllHosts。
 *
 * 覆盖:
 *   - runVolumeGcTick:
 *       · 无候选 → 0 removed
 *       · 1 banned 7d 候选 → fan-out 删 5 volume × N host
 *       · 1 no-login 90d 候选 → 同上
 *       · banned 但有 active 容器行 → 跳过 + skippedActiveContainer 计数
 *       · banned + no-login 同时命中 → 去重(同 uid 只 GC 一次)
 *       · 单 host 远端 generic 错(非 404)→ AggregateError → outcome 'failed'
 *         + 后续 volume 仍尝试 + 其他 host 不被牵连
 *       · 单 host 远端 404(httpStatus)→ silent continue,outcome 'removed'
 *       · 单 host 本地 404(statusCode)→ silent continue
 *       · status filter:bootstrapping/quarantined/broken 不被调,ready/draining 被调
 *       · 时间窗内 banned(< 7d)不被 GC
 *       · 时间窗内 active 用户最近有 refresh_token → 不被 GC
 *       · users.created_at 窗内(注册 < 90d)→ no-login 排除
 *       · batchLimit 切半,banned/no-login 各占一半
 *       · containerService 未注入 → fallback 走本机 dockerode(向后兼容)
 *   - startVolumeGcScheduler:
 *       · runOnce 串行触发拿到 result
 *       · stop() 幂等
 *       · runOnStart=true → 立刻跑 + onTick
 *   - 默认常量 sanity
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type Docker from "dockerode";
import type { Pool, PoolClient } from "pg";

import {
  runVolumeGcTick,
  startVolumeGcScheduler,
  DEFAULT_VOLUME_GC_INTERVAL_MS,
  DEFAULT_BANNED_RETAIN_DAYS,
  DEFAULT_NO_LOGIN_RETAIN_DAYS,
  DEFAULT_VOLUME_GC_BATCH_LIMIT,
} from "../agent-sandbox/index.js";
import type { ContainerService } from "../compute-pool/containerService.js";
import type { ComputeHostRow, ComputeHostStatus } from "../compute-pool/types.js";

// ───────────────────────────────────────────────────────────────────────
//  fake docker — fallback path (containerService 未注入时用)
// ───────────────────────────────────────────────────────────────────────

type DockerCaptured = {
  removed: string[];
};

function makeDocker(opts: { removeThrows?: Set<string>; missing?: Set<string> } = {}): {
  docker: Docker;
  captured: DockerCaptured;
} {
  const captured: DockerCaptured = { removed: [] };
  const getVolume = (name: string) => ({
    remove: async () => {
      if (opts.missing?.has(name)) {
        const e = new Error(`No such volume: ${name}`) as Error & { statusCode: number };
        e.statusCode = 404;
        throw e;
      }
      if (opts.removeThrows?.has(name)) {
        const e = new Error(`remove failed for ${name}`) as Error & { statusCode: number };
        e.statusCode = 500;
        throw e;
      }
      captured.removed.push(name);
    },
  });
  const docker = { getVolume } as unknown as Docker;
  return { docker, captured };
}

// ───────────────────────────────────────────────────────────────────────
//  fake hosts list
// ───────────────────────────────────────────────────────────────────────

type HostSpec = { id: string; name: string; status: ComputeHostStatus };

const DEFAULT_HOSTS: HostSpec[] = [
  { id: "h-self", name: "self", status: "ready" },
  { id: "h-tk1", name: "oc-compute-tk1", status: "ready" },
  { id: "h-by", name: "boheyun-1", status: "draining" },
  { id: "h-boot", name: "fly-01", status: "bootstrapping" },
];

function makeListAllHosts(specs: HostSpec[] = DEFAULT_HOSTS): () => Promise<ComputeHostRow[]> {
  return async () =>
    specs.map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
    } as unknown as ComputeHostRow));
}

// ready+draining 才参与删除;由 v3supervisor.removeV3Volume 内部过滤决定
function targetableHostIds(specs: HostSpec[] = DEFAULT_HOSTS): string[] {
  return specs.filter((s) => s.status === "ready" || s.status === "draining").map((s) => s.id);
}

// ───────────────────────────────────────────────────────────────────────
//  fake containerService — 捕获 (hostId, name) per call
// ───────────────────────────────────────────────────────────────────────

type ContainerCaptured = {
  /** 扁平名字列表(按 hostId 维度去重以保留旧测试断言风格)。 */
  removed: string[];
  /** 完整 (hostId, name) pair,新 P1 测试用。 */
  perHost: Array<{ hostId: string; name: string }>;
};

interface CSOptions {
  /** key = `hostId:name`,throw 404(httpStatus 形)。 */
  perHostNotFound?: Set<string>;
  /** key = `hostId:name`,throw generic Error。 */
  perHostThrows?: Map<string, Error>;
  /** 名字命中即整体 throw 500(任何 host),保留给旧 single-host 风格测试。 */
  removeThrows?: Set<string>;
  /** 名字命中即整体 404(任何 host),保留给旧 single-host 风格测试。 */
  missing?: Set<string>;
}

function makeContainerService(opts: CSOptions = {}): {
  containerService: ContainerService;
  captured: ContainerCaptured;
} {
  const captured: ContainerCaptured = { removed: [], perHost: [] };
  const seenNames = new Set<string>();
  const containerService = {
    removeVolume: async (hostId: string, name: string) => {
      const key = `${hostId}:${name}`;
      if (opts.perHostNotFound?.has(key)) {
        const e = new Error(`No such volume: ${name}`) as Error & { httpStatus: number };
        e.httpStatus = 404;
        throw e;
      }
      if (opts.perHostThrows?.has(key)) {
        throw opts.perHostThrows.get(key);
      }
      if (opts.missing?.has(name)) {
        const e = new Error(`No such volume: ${name}`) as Error & { httpStatus: number };
        e.httpStatus = 404;
        throw e;
      }
      if (opts.removeThrows?.has(name)) {
        const e = new Error(`remove failed for ${name}`) as Error & { httpStatus: number };
        e.httpStatus = 500;
        throw e;
      }
      captured.perHost.push({ hostId, name });
      if (!seenNames.has(name)) {
        captured.removed.push(name);
        seenNames.add(name);
      }
    },
  } as unknown as ContainerService;
  return { containerService, captured };
}

// ───────────────────────────────────────────────────────────────────────
//  fake pg.Pool — users / refresh_tokens / agent_containers
// ───────────────────────────────────────────────────────────────────────

interface FakeUser {
  id: number;
  status: "active" | "banned" | "deleting" | "deleted";
  created_at: Date;
  updated_at: Date;
}

interface FakeRefreshToken {
  user_id: number;
  created_at: Date;
}

interface FakeAgentContainer {
  user_id: number;
  state: "active" | "vanished";
}

class FakePool {
  users: FakeUser[] = [];
  refreshTokens: FakeRefreshToken[] = [];
  agentContainers: FakeAgentContainer[] = [];
  selectBannedCalls = 0;
  selectNoLoginCalls = 0;
  hasActiveCalls: number[] = [];

  seedUser(u: Omit<FakeUser, "created_at" | "updated_at"> & {
    created_at?: Date;
    updated_at?: Date;
  }): void {
    const now = new Date();
    this.users.push({
      ...u,
      created_at: u.created_at ?? now,
      updated_at: u.updated_at ?? now,
    });
  }

  seedToken(t: FakeRefreshToken): void {
    this.refreshTokens.push(t);
  }

  seedContainer(c: FakeAgentContainer): void {
    this.agentContainers.push(c);
  }

  async query(sql: string, params?: unknown[]): Promise<unknown> {
    const trimmed = String(sql).trim();

    // codex round 1 FAIL #3 修复 — gcSingleUidLocked 用事务 + advisory lock 包裹
    // 单 uid 处理。FakePool 不真模拟锁语义,BEGIN/COMMIT/ROLLBACK/lock 都 noop。
    if (/^BEGIN/i.test(trimmed)) return { rowCount: 0, rows: [] };
    if (/^COMMIT/i.test(trimmed)) return { rowCount: 0, rows: [] };
    if (/^ROLLBACK/i.test(trimmed)) return { rowCount: 0, rows: [] };
    if (/^SELECT pg_advisory_xact_lock/i.test(trimmed)) return { rowCount: 0, rows: [] };

    // SELECT banned candidates
    if (
      /^SELECT id FROM users\s+WHERE status = 'banned'/i.test(trimmed)
    ) {
      this.selectBannedCalls++;
      const days = Number(params?.[0]);
      const limit = Number(params?.[1]);
      const cutoff = new Date(Date.now() - days * 86_400_000);
      const matched = this.users
        .filter((u) => u.status === "banned" && u.updated_at < cutoff)
        .sort((a, b) => a.updated_at.getTime() - b.updated_at.getTime())
        .slice(0, limit);
      return {
        rowCount: matched.length,
        rows: matched.map((u) => ({ id: String(u.id) })),
      };
    }

    // SELECT no-login candidates
    if (
      /^SELECT u\.id\s+FROM users u\s+WHERE u\.status = 'active'/i.test(trimmed)
    ) {
      this.selectNoLoginCalls++;
      const days = Number(params?.[0]);
      const limit = Number(params?.[1]);
      const cutoff = new Date(Date.now() - days * 86_400_000);
      const matched = this.users
        .filter((u) => {
          if (u.status !== "active") return false;
          // u.created_at < cutoff
          if (u.created_at >= cutoff) return false;
          // NOT EXISTS refresh_tokens > cutoff
          const hasRecent = this.refreshTokens.some(
            (t) => t.user_id === u.id && t.created_at > cutoff,
          );
          return !hasRecent;
        })
        .sort((a, b) => a.id - b.id)
        .slice(0, limit);
      return {
        rowCount: matched.length,
        rows: matched.map((u) => ({ id: String(u.id) })),
      };
    }

    // SELECT EXISTS active container for uid
    if (/SELECT EXISTS/i.test(trimmed) && /agent_containers/i.test(trimmed)) {
      const uid = Number.parseInt(String(params?.[0]), 10);
      this.hasActiveCalls.push(uid);
      const exists = this.agentContainers.some(
        (c) => c.user_id === uid && c.state === "active",
      );
      return { rowCount: 1, rows: [{ exists }] };
    }

    throw new Error(`FakePool: unhandled SQL: ${trimmed.slice(0, 200)}`);
  }

  async connect(): Promise<PoolClient> {
    const self = this;
    return {
      query: (sql: string, params?: unknown[]) => self.query(sql, params),
      release: () => { /* */ },
    } as unknown as PoolClient;
  }

  end(): Promise<void> {
    return Promise.resolve();
  }
}

const TEST_IMAGE = "openclaude/openclaude-runtime:test";

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}

/**
 * 给定 uid,返回 removeV3Volume 内部按顺序删 5 个 volume 的预期名字数组。
 * 顺序与 v3supervisor.removeV3Volume 实现严格一致(D2 持久化方案):
 *   data → proj → codex → userlocal → userconfig
 */
function expectedVolumes(uid: number): string[] {
  return [
    `oc-v3-data-u${uid}`,
    `oc-v3-proj-u${uid}`,
    `oc-v3-codex-u${uid}`,
    `oc-v3-userlocal-u${uid}`,
    `oc-v3-userconfig-u${uid}`,
  ];
}

/** 跨 host fan-out:对 ready+draining hosts × 5 names 的完整笛卡尔积 (hostId, name) 列表 */
function expectedFanOut(uid: number, hosts: HostSpec[] = DEFAULT_HOSTS): Array<{ hostId: string; name: string }> {
  const targetable = hosts.filter((h) => h.status === "ready" || h.status === "draining");
  const names = expectedVolumes(uid);
  const out: Array<{ hostId: string; name: string }> = [];
  for (const h of targetable) for (const n of names) out.push({ hostId: h.id, name: n });
  return out;
}

// ───────────────────────────────────────────────────────────────────────
//  runVolumeGcTick
// ───────────────────────────────────────────────────────────────────────

describe("runVolumeGcTick", () => {
  test("空表 → 0 scanned 0 removed", async () => {
    const pool = new FakePool();
    const { docker } = makeDocker();
    const { containerService, captured } = makeContainerService();
    const r = await runVolumeGcTick({
      docker,
      pool: pool as unknown as Pool,
      image: TEST_IMAGE,
      containerService,
      listAllHosts: makeListAllHosts(),
    });
    assert.equal(r.scanned, 0);
    assert.equal(r.removed, 0);
    assert.equal(r.skippedActiveContainer, 0);
    assert.deepEqual(r.errors, []);
    assert.equal(captured.perHost.length, 0);
    assert.equal(pool.selectBannedCalls, 1);
    assert.equal(pool.selectNoLoginCalls, 1);
  });

  test("1 banned 用户超 7d → fan-out 删 5 volume × ready/draining hosts", async () => {
    const pool = new FakePool();
    pool.seedUser({
      id: 100, status: "banned",
      updated_at: daysAgo(10), // > 7d
      created_at: daysAgo(60),
    });
    const { docker } = makeDocker();
    const { containerService, captured } = makeContainerService();
    const r = await runVolumeGcTick({
      docker,
      pool: pool as unknown as Pool,
      image: TEST_IMAGE,
      containerService,
      listAllHosts: makeListAllHosts(),
    });
    assert.equal(r.scanned, 1);
    assert.equal(r.removed, 1);
    assert.equal(r.errors.length, 0);
    // 名字维度仍 5 个 volume(集合断言)
    assert.deepEqual(captured.removed.sort(), expectedVolumes(100).sort());
    // 跨 host fan-out:targetable hosts × 5 names = 3 × 5 = 15 calls
    assert.equal(captured.perHost.length, expectedFanOut(100).length);
    assert.equal(captured.perHost.length, 15);
    assert.deepEqual(pool.hasActiveCalls, [100]);
  });

  test("1 active 用户超 90d 无 token → fan-out 删", async () => {
    const pool = new FakePool();
    pool.seedUser({
      id: 200, status: "active",
      created_at: daysAgo(180),
      updated_at: daysAgo(180),
    });
    pool.seedToken({ user_id: 200, created_at: daysAgo(100) });
    const { docker } = makeDocker();
    const { containerService, captured } = makeContainerService();
    const r = await runVolumeGcTick({
      docker,
      pool: pool as unknown as Pool,
      image: TEST_IMAGE,
      containerService,
      listAllHosts: makeListAllHosts(),
    });
    assert.equal(r.scanned, 1);
    assert.equal(r.removed, 1);
    assert.deepEqual(captured.removed.sort(), expectedVolumes(200).sort());
  });

  test("banned 用户但有 active 容器行 → skip,不调 containerService", async () => {
    const pool = new FakePool();
    pool.seedUser({
      id: 300, status: "banned",
      updated_at: daysAgo(10),
      created_at: daysAgo(60),
    });
    pool.seedContainer({ user_id: 300, state: "active" });
    const { docker } = makeDocker();
    const { containerService, captured } = makeContainerService();
    const r = await runVolumeGcTick({
      docker,
      pool: pool as unknown as Pool,
      image: TEST_IMAGE,
      containerService,
      listAllHosts: makeListAllHosts(),
    });
    assert.equal(r.scanned, 1);
    assert.equal(r.removed, 0);
    assert.equal(r.skippedActiveContainer, 1);
    assert.equal(captured.perHost.length, 0);
  });

  test("banned 但有 vanished 容器(非 active)→ 仍可删", async () => {
    const pool = new FakePool();
    pool.seedUser({
      id: 350, status: "banned",
      updated_at: daysAgo(10),
      created_at: daysAgo(60),
    });
    pool.seedContainer({ user_id: 350, state: "vanished" });
    const { docker } = makeDocker();
    const { containerService, captured } = makeContainerService();
    const r = await runVolumeGcTick({
      docker,
      pool: pool as unknown as Pool,
      image: TEST_IMAGE,
      containerService,
      listAllHosts: makeListAllHosts(),
    });
    assert.equal(r.scanned, 1);
    assert.equal(r.removed, 1);
    assert.deepEqual(captured.removed.sort(), expectedVolumes(350).sort());
  });

  test("banned 5d(< 7d)→ 不命中", async () => {
    const pool = new FakePool();
    pool.seedUser({
      id: 400, status: "banned",
      updated_at: daysAgo(5),
      created_at: daysAgo(60),
    });
    const { docker } = makeDocker();
    const { containerService, captured } = makeContainerService();
    const r = await runVolumeGcTick({
      docker,
      pool: pool as unknown as Pool,
      image: TEST_IMAGE,
      containerService,
      listAllHosts: makeListAllHosts(),
    });
    assert.equal(r.scanned, 0);
    assert.equal(captured.perHost.length, 0);
  });

  test("active 用户 30d 内有 token → 不命中", async () => {
    const pool = new FakePool();
    pool.seedUser({
      id: 500, status: "active",
      created_at: daysAgo(180),
      updated_at: daysAgo(180),
    });
    pool.seedToken({ user_id: 500, created_at: daysAgo(30) });
    const { docker } = makeDocker();
    const { containerService, captured } = makeContainerService();
    const r = await runVolumeGcTick({
      docker,
      pool: pool as unknown as Pool,
      image: TEST_IMAGE,
      containerService,
      listAllHosts: makeListAllHosts(),
    });
    assert.equal(r.scanned, 0);
    assert.equal(captured.perHost.length, 0);
  });

  test("active 用户注册 < 90d → 即使无 token 也不算 no-login", async () => {
    const pool = new FakePool();
    pool.seedUser({
      id: 600, status: "active",
      created_at: daysAgo(30),
      updated_at: daysAgo(30),
    });
    const { docker } = makeDocker();
    const { containerService, captured } = makeContainerService();
    const r = await runVolumeGcTick({
      docker,
      pool: pool as unknown as Pool,
      image: TEST_IMAGE,
      containerService,
      listAllHosts: makeListAllHosts(),
    });
    assert.equal(r.scanned, 0);
    assert.equal(captured.perHost.length, 0);
  });

  test("[P1] 单 host generic 错(非 404) → AggregateError → outcome 'failed' + 其他 host 完整跑完", async () => {
    const pool = new FakePool();
    pool.seedUser({ id: 700, status: "banned", updated_at: daysAgo(10), created_at: daysAgo(60) });
    pool.seedUser({ id: 701, status: "banned", updated_at: daysAgo(20), created_at: daysAgo(60) });
    // u700 在 h-tk1 上的 codex volume 抛 dial timeout(generic),其他全成功
    const perHostThrows = new Map<string, Error>([
      [`h-tk1:oc-v3-codex-u700`, new Error("dial timeout")],
    ]);
    const { docker } = makeDocker();
    const { containerService, captured } = makeContainerService({ perHostThrows });
    const r = await runVolumeGcTick({
      docker,
      pool: pool as unknown as Pool,
      image: TEST_IMAGE,
      containerService,
      listAllHosts: makeListAllHosts(),
    });
    assert.equal(r.scanned, 2);
    assert.equal(r.removed, 1);    // u701 干净删完
    assert.equal(r.errors.length, 1); // u700 失败
    assert.equal(r.errors[0]!.uid, 700);
    assert.equal(r.errors[0]!.reason, "banned");
    // AggregateError 被 formatRemoveError flatten:含 host id + volume 名 + dial timeout
    assert.match(r.errors[0]!.error, /removeV3Volume failed for uid=700/);
    assert.match(r.errors[0]!.error, /h-tk1/);
    assert.match(r.errors[0]!.error, /oc-v3-codex-u700/);
    assert.match(r.errors[0]!.error, /dial timeout/);

    // u700 即便 codex 抛错,本 host 后续 volume 仍尝试(最大化清理面)
    const u700Tk1Calls = captured.perHost
      .filter((c) => c.hostId === "h-tk1" && c.name.endsWith("-u700"));
    // h-tk1 上 5 个里 codex 抛错没记 perHost(throw 路径不 push),其他 4 个会被记
    assert.equal(u700Tk1Calls.length, 4);
    assert.ok(u700Tk1Calls.find((c) => c.name === "oc-v3-userlocal-u700"),
      "userlocal-u700 应在 codex 抛错后仍被尝试");

    // 其他 host(h-self / h-by)对 u700 完整 5 个 volume 都跑了
    for (const hostId of ["h-self", "h-by"]) {
      const calls = captured.perHost.filter((c) => c.hostId === hostId && c.name.endsWith("-u700"));
      assert.equal(calls.length, 5, `${hostId} 应跑完 u700 全部 5 volume`);
    }

    // u701 fan-out 干净 = 3 hosts × 5 volumes = 15 calls
    const u701Calls = captured.perHost.filter((c) => c.name.endsWith("-u701"));
    assert.equal(u701Calls.length, 15);
  });

  test("[P1] 单 host 远端 404(httpStatus)→ silent continue,outcome 'removed'", async () => {
    const pool = new FakePool();
    pool.seedUser({ id: 800, status: "banned", updated_at: daysAgo(10), created_at: daysAgo(60) });
    // h-tk1 上整 5 volume 全 404(模拟该 host 历史无该用户 volume)
    const perHostNotFound = new Set<string>(
      expectedVolumes(800).map((n) => `h-tk1:${n}`),
    );
    const { docker } = makeDocker();
    const { containerService, captured } = makeContainerService({ perHostNotFound });
    const r = await runVolumeGcTick({
      docker,
      pool: pool as unknown as Pool,
      image: TEST_IMAGE,
      containerService,
      listAllHosts: makeListAllHosts(),
    });
    assert.equal(r.scanned, 1);
    assert.equal(r.removed, 1);
    assert.equal(r.errors.length, 0);
    // h-tk1 5 个调用全 404 被吞,perHost 不记;其他 host 各 5 个
    const tk1Calls = captured.perHost.filter((c) => c.hostId === "h-tk1");
    assert.equal(tk1Calls.length, 0);
    const selfCalls = captured.perHost.filter((c) => c.hostId === "h-self");
    assert.equal(selfCalls.length, 5);
    const byCalls = captured.perHost.filter((c) => c.hostId === "h-by");
    assert.equal(byCalls.length, 5);
  });

  test("[P1] 单 host 本地 404(statusCode)→ silent continue,outcome 'removed'", async () => {
    const pool = new FakePool();
    pool.seedUser({ id: 850, status: "banned", updated_at: daysAgo(10), created_at: daysAgo(60) });
    // 模拟 h-self(local docker)上某个 volume 已被手清,统一抛 statusCode=404
    const perHostThrows = new Map<string, Error>();
    for (const n of expectedVolumes(850)) {
      const e = new Error(`No such volume: ${n}`) as Error & { statusCode: number };
      e.statusCode = 404;
      perHostThrows.set(`h-self:${n}`, e);
    }
    const { docker } = makeDocker();
    const { containerService, captured } = makeContainerService({ perHostThrows });
    const r = await runVolumeGcTick({
      docker,
      pool: pool as unknown as Pool,
      image: TEST_IMAGE,
      containerService,
      listAllHosts: makeListAllHosts(),
    });
    assert.equal(r.scanned, 1);
    assert.equal(r.removed, 1);
    assert.equal(r.errors.length, 0);
    const selfCalls = captured.perHost.filter((c) => c.hostId === "h-self");
    assert.equal(selfCalls.length, 0);
  });

  test("[P1] status filter:bootstrapping/quarantined/broken 不被调,ready/draining 被调", async () => {
    const pool = new FakePool();
    pool.seedUser({ id: 900, status: "banned", updated_at: daysAgo(10), created_at: daysAgo(60) });
    const hosts: HostSpec[] = [
      { id: "h-r1", name: "ready-1", status: "ready" },
      { id: "h-r2", name: "ready-2", status: "ready" },
      { id: "h-d1", name: "draining-1", status: "draining" },
      { id: "h-bs", name: "bootstrap-1", status: "bootstrapping" },
      { id: "h-q",  name: "quarantined-1", status: "quarantined" },
      { id: "h-bk", name: "broken-1", status: "broken" },
    ];
    const { docker } = makeDocker();
    const { containerService, captured } = makeContainerService();
    const r = await runVolumeGcTick({
      docker,
      pool: pool as unknown as Pool,
      image: TEST_IMAGE,
      containerService,
      listAllHosts: makeListAllHosts(hosts),
    });
    assert.equal(r.scanned, 1);
    assert.equal(r.removed, 1);
    // 只 ready+draining 3 台 × 5 volumes = 15 calls
    assert.equal(captured.perHost.length, 15);
    const calledHosts = new Set(captured.perHost.map((c) => c.hostId));
    assert.deepEqual(
      [...calledHosts].sort(),
      ["h-d1", "h-r1", "h-r2"].sort(),
    );
    // 未调的 host 严格断言
    for (const skipped of ["h-bs", "h-q", "h-bk"]) {
      assert.ok(!calledHosts.has(skipped), `${skipped} 不应被调用`);
    }
  });

  test("[P1] containerService 未注入 → fallback 走本机 dockerode(向后兼容)", async () => {
    const pool = new FakePool();
    pool.seedUser({ id: 950, status: "banned", updated_at: daysAgo(10), created_at: daysAgo(60) });
    const { docker, captured: dockerCaptured } = makeDocker();
    // 故意不传 containerService / listAllHosts
    const r = await runVolumeGcTick({
      docker,
      pool: pool as unknown as Pool,
      image: TEST_IMAGE,
    });
    assert.equal(r.scanned, 1);
    assert.equal(r.removed, 1);
    assert.equal(r.errors.length, 0);
    // 走本机 docker 路径删 5 个 volume
    assert.deepEqual(dockerCaptured.removed.sort(), expectedVolumes(950).sort());
  });

  test("banned + no-login 同时命中 → 去重,只 GC 一次(banned 优先)", async () => {
    const pool = new FakePool();
    pool.seedUser({ id: 901, status: "banned", updated_at: daysAgo(10), created_at: daysAgo(60) });
    pool.seedUser({ id: 902, status: "active", updated_at: daysAgo(180), created_at: daysAgo(180) });
    const { docker } = makeDocker();
    const { containerService, captured } = makeContainerService();
    const r = await runVolumeGcTick({
      docker,
      pool: pool as unknown as Pool,
      image: TEST_IMAGE,
      containerService,
      listAllHosts: makeListAllHosts(),
    });
    assert.equal(r.scanned, 2);
    assert.equal(r.removed, 2);
    // 名字维度集合断言
    assert.deepEqual(
      captured.removed.sort(),
      [...expectedVolumes(901), ...expectedVolumes(902)].sort(),
    );
  });

  test("自定义 bannedRetainDays=1 / noLoginRetainDays=10", async () => {
    const pool = new FakePool();
    pool.seedUser({ id: 1000, status: "banned", updated_at: daysAgo(2), created_at: daysAgo(30) });
    pool.seedUser({ id: 1001, status: "active", updated_at: daysAgo(20), created_at: daysAgo(20) });
    const { docker } = makeDocker();
    const { containerService, captured } = makeContainerService();
    const r = await runVolumeGcTick(
      {
        docker,
        pool: pool as unknown as Pool,
        image: TEST_IMAGE,
        containerService,
        listAllHosts: makeListAllHosts(),
      },
      { bannedRetainDays: 1, noLoginRetainDays: 10 },
    );
    assert.equal(r.scanned, 2);
    assert.equal(r.removed, 2);
    assert.deepEqual(
      captured.removed.sort(),
      [...expectedVolumes(1000), ...expectedVolumes(1001)].sort(),
    );
  });

  test("batchLimit=2 在多 banned 候选时分半 — banned 1 + no-login 1 = 2 命中", async () => {
    const pool = new FakePool();
    pool.seedUser({ id: 1100, status: "banned", updated_at: daysAgo(20), created_at: daysAgo(60) });
    pool.seedUser({ id: 1101, status: "banned", updated_at: daysAgo(30), created_at: daysAgo(60) });
    pool.seedUser({ id: 1102, status: "active", updated_at: daysAgo(180), created_at: daysAgo(180) });
    const { docker } = makeDocker();
    const { containerService, captured } = makeContainerService();
    const r = await runVolumeGcTick(
      {
        docker,
        pool: pool as unknown as Pool,
        image: TEST_IMAGE,
        containerService,
        listAllHosts: makeListAllHosts(),
      },
      { batchLimit: 2 },
    );
    // halfLimit = max(1, 2/2) = 1 → banned 取最老 1 个;noLoginLimit = max(1, 2-1) = 1 → no-login 取 1 个
    assert.equal(r.scanned, 2);
    assert.equal(r.removed, 2);
    // 名字维度断言
    for (const name of expectedVolumes(1101)) {
      assert.ok(captured.removed.includes(name), `missing ${name}`);
    }
    for (const name of expectedVolumes(1102)) {
      assert.ok(captured.removed.includes(name), `missing ${name}`);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────
//  常量 sanity
// ───────────────────────────────────────────────────────────────────────

describe("volumeGc defaults", () => {
  test("默认值与 dev plan §1196 / §1199 一致", () => {
    assert.equal(DEFAULT_BANNED_RETAIN_DAYS, 7);
    assert.equal(DEFAULT_NO_LOGIN_RETAIN_DAYS, 90);
    assert.equal(DEFAULT_VOLUME_GC_INTERVAL_MS, 3_600_000);
    assert.equal(DEFAULT_VOLUME_GC_BATCH_LIMIT, 100);
  });
});

// ───────────────────────────────────────────────────────────────────────
//  startVolumeGcScheduler
// ───────────────────────────────────────────────────────────────────────

describe("startVolumeGcScheduler", () => {
  test("runOnce 串行触发返 result", async () => {
    const pool = new FakePool();
    pool.seedUser({ id: 1200, status: "banned", updated_at: daysAgo(10), created_at: daysAgo(60) });
    const { docker } = makeDocker();
    const { containerService, captured } = makeContainerService();
    const sched = startVolumeGcScheduler(
      {
        docker,
        pool: pool as unknown as Pool,
        image: TEST_IMAGE,
        containerService,
        listAllHosts: makeListAllHosts(),
      },
      { intervalMs: 9_999_999, runOnStart: false },
    );
    try {
      const r = await sched.runOnce();
      assert.equal(r.scanned, 1);
      assert.equal(r.removed, 1);
      assert.deepEqual(captured.removed.sort(), expectedVolumes(1200).sort());
    } finally {
      await sched.stop();
    }
  });

  test("stop() 幂等 — 多次调用不抛", async () => {
    const pool = new FakePool();
    const { docker } = makeDocker();
    const { containerService } = makeContainerService();
    const sched = startVolumeGcScheduler(
      {
        docker,
        pool: pool as unknown as Pool,
        image: TEST_IMAGE,
        containerService,
        listAllHosts: makeListAllHosts(),
      },
      { intervalMs: 9_999_999, runOnStart: false },
    );
    await sched.stop();
    await sched.stop();
  });

  test("runOnStart=true → tick 立即跑 + onTick 拿到 result", async () => {
    const pool = new FakePool();
    pool.seedUser({ id: 1300, status: "banned", updated_at: daysAgo(10), created_at: daysAgo(60) });
    const { docker } = makeDocker();
    const { containerService, captured } = makeContainerService();
    let observed: { scanned: number; removed: number } | null = null;
    const ticked = new Promise<void>((resolve) => {
      const sched = startVolumeGcScheduler(
        {
          docker,
          pool: pool as unknown as Pool,
          image: TEST_IMAGE,
          containerService,
          listAllHosts: makeListAllHosts(),
        },
        {
          intervalMs: 9_999_999,
          runOnStart: true,
          onTick: (r) => {
            observed = { scanned: r.scanned, removed: r.removed };
            resolve();
            void sched.stop();
          },
        },
      );
    });
    await ticked;
    assert.deepEqual(observed, { scanned: 1, removed: 1 });
    assert.deepEqual(captured.removed.sort(), expectedVolumes(1300).sort());
  });
});
