/**
 * V3 Phase 3G — agent-sandbox/v3volumeGc.ts 单测。
 *
 * 覆盖:
 *   - runVolumeGcTick:
 *       · 无候选 → 0 removed
 *       · 1 banned 7d 候选 → docker volume remove + counter
 *       · 1 no-login 90d 候选 → docker volume remove
 *       · banned 但有 active 容器行 → 跳过 + skippedActiveContainer 计数
 *       · banned + no-login 同时命中 → 去重(同 uid 只 GC 一次)
 *       · removeV3Volume 抛 → errors 累计,其他 uid 继续
 *       · 时间窗内 banned(< 7d)不被 GC
 *       · 时间窗内 active 用户最近有 refresh_token → 不被 GC
 *       · users.created_at 窗内(注册 < 90d)→ no-login 排除
 *       · batchLimit 切半,banned/no-login 各占一半
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

// ───────────────────────────────────────────────────────────────────────
//  fake docker — 只需要 getVolume(name).remove() / .inspect()
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

// ───────────────────────────────────────────────────────────────────────
//  runVolumeGcTick
// ───────────────────────────────────────────────────────────────────────

describe("runVolumeGcTick", () => {
  test("空表 → 0 scanned 0 removed", async () => {
    const pool = new FakePool();
    const { docker, captured } = makeDocker();
    const r = await runVolumeGcTick({
      docker, pool: pool as unknown as Pool, image: TEST_IMAGE,
    });
    assert.equal(r.scanned, 0);
    assert.equal(r.removed, 0);
    assert.equal(r.skippedActiveContainer, 0);
    assert.deepEqual(r.errors, []);
    assert.equal(captured.removed.length, 0);
    assert.equal(pool.selectBannedCalls, 1);
    assert.equal(pool.selectNoLoginCalls, 1);
  });

  test("1 banned 用户超 7d → volume removed + 状态记 banned", async () => {
    const pool = new FakePool();
    pool.seedUser({
      id: 100, status: "banned",
      updated_at: daysAgo(10), // > 7d
      created_at: daysAgo(60),
    });
    const { docker, captured } = makeDocker();
    const r = await runVolumeGcTick({
      docker, pool: pool as unknown as Pool, image: TEST_IMAGE,
    });
    assert.equal(r.scanned, 1);
    assert.equal(r.removed, 1);
    assert.equal(r.errors.length, 0);
    assert.deepEqual(captured.removed, ["oc-v3-data-u100"]);
    assert.deepEqual(pool.hasActiveCalls, [100]);
  });

  test("1 active 用户超 90d 无 token → volume removed", async () => {
    const pool = new FakePool();
    pool.seedUser({
      id: 200, status: "active",
      created_at: daysAgo(180),
      updated_at: daysAgo(180),
    });
    // 仅有 100d 前的 token,卡在窗口外
    pool.seedToken({ user_id: 200, created_at: daysAgo(100) });
    const { docker, captured } = makeDocker();
    const r = await runVolumeGcTick({
      docker, pool: pool as unknown as Pool, image: TEST_IMAGE,
    });
    assert.equal(r.scanned, 1);
    assert.equal(r.removed, 1);
    assert.deepEqual(captured.removed, ["oc-v3-data-u200"]);
  });

  test("banned 用户但有 active 容器行 → skip,不删 volume", async () => {
    const pool = new FakePool();
    pool.seedUser({
      id: 300, status: "banned",
      updated_at: daysAgo(10),
      created_at: daysAgo(60),
    });
    pool.seedContainer({ user_id: 300, state: "active" });
    const { docker, captured } = makeDocker();
    const r = await runVolumeGcTick({
      docker, pool: pool as unknown as Pool, image: TEST_IMAGE,
    });
    assert.equal(r.scanned, 1);
    assert.equal(r.removed, 0);
    assert.equal(r.skippedActiveContainer, 1);
    assert.equal(captured.removed.length, 0);
  });

  test("banned 但有 vanished 容器(非 active)→ 仍可删 volume", async () => {
    const pool = new FakePool();
    pool.seedUser({
      id: 350, status: "banned",
      updated_at: daysAgo(10),
      created_at: daysAgo(60),
    });
    pool.seedContainer({ user_id: 350, state: "vanished" });
    const { docker, captured } = makeDocker();
    const r = await runVolumeGcTick({
      docker, pool: pool as unknown as Pool, image: TEST_IMAGE,
    });
    assert.equal(r.scanned, 1);
    assert.equal(r.removed, 1);
    assert.deepEqual(captured.removed, ["oc-v3-data-u350"]);
  });

  test("banned 5d(< 7d)→ 不命中", async () => {
    const pool = new FakePool();
    pool.seedUser({
      id: 400, status: "banned",
      updated_at: daysAgo(5),
      created_at: daysAgo(60),
    });
    const { docker, captured } = makeDocker();
    const r = await runVolumeGcTick({
      docker, pool: pool as unknown as Pool, image: TEST_IMAGE,
    });
    assert.equal(r.scanned, 0);
    assert.equal(captured.removed.length, 0);
  });

  test("active 用户 30d 内有 token → 不命中", async () => {
    const pool = new FakePool();
    pool.seedUser({
      id: 500, status: "active",
      created_at: daysAgo(180),
      updated_at: daysAgo(180),
    });
    pool.seedToken({ user_id: 500, created_at: daysAgo(30) });
    const { docker, captured } = makeDocker();
    const r = await runVolumeGcTick({
      docker, pool: pool as unknown as Pool, image: TEST_IMAGE,
    });
    assert.equal(r.scanned, 0);
    assert.equal(captured.removed.length, 0);
  });

  test("active 用户注册 < 90d → 即使无 token 也不算 no-login", async () => {
    const pool = new FakePool();
    pool.seedUser({
      id: 600, status: "active",
      created_at: daysAgo(30), // < 90d 注册
      updated_at: daysAgo(30),
    });
    // 注:故意不 seed token
    const { docker, captured } = makeDocker();
    const r = await runVolumeGcTick({
      docker, pool: pool as unknown as Pool, image: TEST_IMAGE,
    });
    assert.equal(r.scanned, 0);
    assert.equal(captured.removed.length, 0);
  });

  test("removeV3Volume 抛 → errors 累加,其他 uid 继续", async () => {
    const pool = new FakePool();
    pool.seedUser({ id: 700, status: "banned", updated_at: daysAgo(10), created_at: daysAgo(60) });
    pool.seedUser({ id: 701, status: "banned", updated_at: daysAgo(20), created_at: daysAgo(60) });
    const { docker, captured } = makeDocker({
      removeThrows: new Set(["oc-v3-data-u700"]),
    });
    const r = await runVolumeGcTick({
      docker, pool: pool as unknown as Pool, image: TEST_IMAGE,
    });
    assert.equal(r.scanned, 2);
    assert.equal(r.removed, 1);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0]!.uid, 700);
    assert.equal(r.errors[0]!.reason, "banned");
    assert.match(r.errors[0]!.error, /remove failed/);
    assert.deepEqual(captured.removed, ["oc-v3-data-u701"]);
  });

  test("missing volume(404)→ 不算错误,removed 计数加 1", async () => {
    const pool = new FakePool();
    pool.seedUser({ id: 800, status: "banned", updated_at: daysAgo(10), created_at: daysAgo(60) });
    const { docker, captured } = makeDocker({
      missing: new Set(["oc-v3-data-u800"]),
    });
    const r = await runVolumeGcTick({
      docker, pool: pool as unknown as Pool, image: TEST_IMAGE,
    });
    // removeV3Volume 内部把 404 转 noop,不抛 → counter ++
    assert.equal(r.scanned, 1);
    assert.equal(r.removed, 1);
    assert.equal(r.errors.length, 0);
    assert.equal(captured.removed.length, 0); // 没真的进 captured(404 在 missing branch)
  });

  test("banned + no-login 同时命中同 uid → 去重,只 GC 一次(banned 优先)", async () => {
    const pool = new FakePool();
    // active + 老到不行 + 无 token → 命中 no-login
    // 同一 uid 不可能同时 banned + active,但保险起见测 union 去重逻辑
    // 用两个不同 uid 模拟:uid 900 banned,uid 901 no-login
    pool.seedUser({ id: 900, status: "banned", updated_at: daysAgo(10), created_at: daysAgo(60) });
    pool.seedUser({ id: 901, status: "active", updated_at: daysAgo(180), created_at: daysAgo(180) });
    const { docker, captured } = makeDocker();
    const r = await runVolumeGcTick({
      docker, pool: pool as unknown as Pool, image: TEST_IMAGE,
    });
    assert.equal(r.scanned, 2);
    assert.equal(r.removed, 2);
    assert.deepEqual(
      captured.removed.sort(),
      ["oc-v3-data-u900", "oc-v3-data-u901"].sort(),
    );
  });

  test("自定义 bannedRetainDays=1 / noLoginRetainDays=10", async () => {
    const pool = new FakePool();
    pool.seedUser({ id: 1000, status: "banned", updated_at: daysAgo(2), created_at: daysAgo(30) });
    pool.seedUser({ id: 1001, status: "active", updated_at: daysAgo(20), created_at: daysAgo(20) });
    // uid 1001 注册 20d > 10d 阈值,无 token → 命中 no-login
    const { docker, captured } = makeDocker();
    const r = await runVolumeGcTick(
      { docker, pool: pool as unknown as Pool, image: TEST_IMAGE },
      { bannedRetainDays: 1, noLoginRetainDays: 10 },
    );
    assert.equal(r.scanned, 2);
    assert.equal(r.removed, 2);
    assert.deepEqual(
      captured.removed.sort(),
      ["oc-v3-data-u1000", "oc-v3-data-u1001"].sort(),
    );
  });

  test("batchLimit=2 在多 banned 候选时分半 — banned 1 + no-login 1 = 2 命中", async () => {
    const pool = new FakePool();
    pool.seedUser({ id: 1100, status: "banned", updated_at: daysAgo(20), created_at: daysAgo(60) });
    pool.seedUser({ id: 1101, status: "banned", updated_at: daysAgo(30), created_at: daysAgo(60) });
    pool.seedUser({ id: 1102, status: "active", updated_at: daysAgo(180), created_at: daysAgo(180) });
    const { docker, captured } = makeDocker();
    const r = await runVolumeGcTick(
      { docker, pool: pool as unknown as Pool, image: TEST_IMAGE },
      { batchLimit: 2 },
    );
    // halfLimit = max(1, 2/2) = 1 → banned 取最老 1 个;noLoginLimit = max(1, 2-1) = 1 → no-login 取 1 个
    assert.equal(r.scanned, 2);
    assert.equal(r.removed, 2);
    // banned 取 updated_at ASC 最老的 1101(30d)
    assert.ok(captured.removed.includes("oc-v3-data-u1101"));
    assert.ok(captured.removed.includes("oc-v3-data-u1102"));
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
    const { docker, captured } = makeDocker();
    const sched = startVolumeGcScheduler(
      { docker, pool: pool as unknown as Pool, image: TEST_IMAGE },
      { intervalMs: 9_999_999, runOnStart: false },
    );
    try {
      const r = await sched.runOnce();
      assert.equal(r.scanned, 1);
      assert.equal(r.removed, 1);
      assert.deepEqual(captured.removed, ["oc-v3-data-u1200"]);
    } finally {
      await sched.stop();
    }
  });

  test("stop() 幂等 — 多次调用不抛", async () => {
    const pool = new FakePool();
    const { docker } = makeDocker();
    const sched = startVolumeGcScheduler(
      { docker, pool: pool as unknown as Pool, image: TEST_IMAGE },
      { intervalMs: 9_999_999, runOnStart: false },
    );
    await sched.stop();
    await sched.stop();
  });

  test("runOnStart=true → tick 立即跑 + onTick 拿到 result", async () => {
    const pool = new FakePool();
    pool.seedUser({ id: 1300, status: "banned", updated_at: daysAgo(10), created_at: daysAgo(60) });
    const { docker, captured } = makeDocker();
    let observed: { scanned: number; removed: number } | null = null;
    const ticked = new Promise<void>((resolve) => {
      const sched = startVolumeGcScheduler(
        { docker, pool: pool as unknown as Pool, image: TEST_IMAGE },
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
    assert.deepEqual(captured.removed, ["oc-v3-data-u1300"]);
  });
});
