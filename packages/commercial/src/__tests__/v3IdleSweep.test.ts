/**
 * V3 Phase 3F — agent-sandbox/v3idleSweep.ts 单测。
 *
 * 覆盖:
 *   - runIdleSweepTick:
 *       · 0 行 → 0 swept,errors 空
 *       · 1 stale active → 1 swept(stopAndRemove 被调,行翻 vanished)
 *       · 1 fresh active → 不 sweep
 *       · vanished 行被排除,不参与扫描
 *       · 单行 stopAndRemove 抛 → errors 累计,其他行继续处理
 *       · last_ws_activity IS NULL 行被排除(不 sweep)
 *       · batchLimit:扫到的行被截到 limit
 *   - startIdleSweepScheduler:
 *       · runOnceAlone 跑一次拿到 result
 *       · stop() 幂等且阻塞掉 timer
 *       · runOnStart=true 启动即触发(短间隔 + onTick 等待)
 *   - markV3ContainerActivity 只刷 active 行,vanished 行不动
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type Docker from "dockerode";
import type { Pool, PoolClient } from "pg";

import {
  runIdleSweepTick,
  startIdleSweepScheduler,
  markV3ContainerActivity,
  DEFAULT_IDLE_CUTOFF_MIN,
  DEFAULT_IDLE_SWEEP_INTERVAL_MS,
  DEFAULT_SWEEP_BATCH_LIMIT,
} from "../agent-sandbox/index.js";

// ───────────────────────────────────────────────────────────────────────
//  fake docker — 只需要 getContainer().stop() / .remove() 不抛
// ───────────────────────────────────────────────────────────────────────

type DockerCaptured = {
  stopped: string[];
  removed: string[];
};

function makeDocker(opts: { stopThrows?: Set<string>; removeThrows?: Set<string> } = {}): {
  docker: Docker;
  captured: DockerCaptured;
} {
  const captured: DockerCaptured = { stopped: [], removed: [] };
  const getContainer = (id: string) => ({
    stop: async () => {
      if (opts.stopThrows?.has(id)) {
        const e = new Error(`stop failed for ${id}`) as Error & { statusCode: number };
        e.statusCode = 500;
        throw e;
      }
      captured.stopped.push(id);
    },
    remove: async () => {
      if (opts.removeThrows?.has(id)) {
        const e = new Error(`remove failed for ${id}`) as Error & { statusCode: number };
        e.statusCode = 500;
        throw e;
      }
      captured.removed.push(id);
    },
  });
  const docker = { getContainer } as unknown as Docker;
  return { docker, captured };
}

// ───────────────────────────────────────────────────────────────────────
//  fake pg.Pool — 内存里塞 agent_containers 行
// ───────────────────────────────────────────────────────────────────────

interface FakeRow {
  id: number;
  user_id: number;
  bound_ip: string;
  state: "active" | "vanished";
  port: number;
  container_internal_id: string | null;
  /** 允许 null,模拟"还没记过任何 ws 帧"的中间窗口 */
  last_ws_activity: Date | null;
  updated_at: Date;
}

class FakePool {
  rows: FakeRow[] = [];
  selectCalls = 0;
  updateActivityCalls: number[] = []; // ids 被 mark 过

  seed(row: Omit<FakeRow, "updated_at"> & { updated_at?: Date }): void {
    this.rows.push({
      ...row,
      updated_at: row.updated_at ?? new Date(),
    });
  }

  async query(sql: string, params?: unknown[]): Promise<unknown> {
    const trimmed = String(sql).trim();
    // SELECT id, container_internal_id FROM agent_containers WHERE state='active' ...
    if (
      /^SELECT id, container_internal_id\s+FROM agent_containers/i.test(trimmed) &&
      /WHERE state = 'active'/i.test(trimmed)
    ) {
      this.selectCalls++;
      const cutoffMin = Number(params?.[0]);
      const limit = Number(params?.[1]);
      const cutoff = new Date(Date.now() - cutoffMin * 60_000);
      const matching = this.rows
        .filter(
          (r) =>
            r.state === "active" &&
            r.last_ws_activity !== null &&
            r.last_ws_activity < cutoff,
        )
        .sort(
          (a, b) =>
            (a.last_ws_activity?.getTime() ?? 0) -
            (b.last_ws_activity?.getTime() ?? 0),
        )
        .slice(0, limit);
      return {
        rowCount: matching.length,
        rows: matching.map((r) => ({
          id: String(r.id),
          container_internal_id: r.container_internal_id,
        })),
      };
    }
    // UPDATE agent_containers SET state='vanished' WHERE id = $1
    if (
      /^UPDATE agent_containers/i.test(trimmed) &&
      /SET state='vanished'/i.test(trimmed)
    ) {
      const id = Number.parseInt(String(params?.[0]), 10);
      const r = this.rows.find((x) => x.id === id);
      if (r) {
        r.state = "vanished";
        r.updated_at = new Date();
      }
      return { rowCount: r ? 1 : 0, rows: [] };
    }
    // markV3ContainerActivity: UPDATE agent_containers SET last_ws_activity = NOW(), updated_at = NOW() WHERE id = $1::bigint AND state = 'active'
    if (
      /^UPDATE agent_containers/i.test(trimmed) &&
      /SET last_ws_activity = NOW\(\)/i.test(trimmed)
    ) {
      const id = Number.parseInt(String(params?.[0]), 10);
      this.updateActivityCalls.push(id);
      const r = this.rows.find((x) => x.id === id && x.state === "active");
      if (r) {
        r.last_ws_activity = new Date();
        r.updated_at = new Date();
      }
      return { rowCount: r ? 1 : 0, rows: [] };
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

function makeStaleDate(minutesAgo: number): Date {
  return new Date(Date.now() - minutesAgo * 60_000);
}

// ───────────────────────────────────────────────────────────────────────
//  runIdleSweepTick
// ───────────────────────────────────────────────────────────────────────

describe("runIdleSweepTick", () => {
  test("空表 → 0 scanned 0 swept", async () => {
    const pool = new FakePool();
    const { docker, captured } = makeDocker();
    const r = await runIdleSweepTick({
      docker, pool: pool as unknown as Pool, image: TEST_IMAGE,
    });
    assert.equal(r.scanned, 0);
    assert.equal(r.swept, 0);
    assert.deepEqual(r.errors, []);
    assert.equal(captured.stopped.length, 0);
    assert.equal(captured.removed.length, 0);
    assert.equal(pool.selectCalls, 1);
  });

  test("1 stale active → swept,行翻 vanished,docker stop+remove 被调", async () => {
    const pool = new FakePool();
    pool.seed({
      id: 1, user_id: 100, bound_ip: "172.30.1.10",
      state: "active", port: 18789,
      container_internal_id: "docker-aaaa",
      last_ws_activity: makeStaleDate(45), // > 30min cutoff
    });
    const { docker, captured } = makeDocker();
    const r = await runIdleSweepTick({
      docker, pool: pool as unknown as Pool, image: TEST_IMAGE,
    });
    assert.equal(r.scanned, 1);
    assert.equal(r.swept, 1);
    assert.equal(r.errors.length, 0);
    assert.deepEqual(captured.stopped, ["docker-aaaa"]);
    assert.deepEqual(captured.removed, ["docker-aaaa"]);
    assert.equal(pool.rows[0]!.state, "vanished");
  });

  test("fresh active(15min)不被 sweep — 默认 cutoff=30min", async () => {
    const pool = new FakePool();
    pool.seed({
      id: 2, user_id: 200, bound_ip: "172.30.1.20",
      state: "active", port: 18789,
      container_internal_id: "docker-bbbb",
      last_ws_activity: makeStaleDate(15),
    });
    const { docker, captured } = makeDocker();
    const r = await runIdleSweepTick({
      docker, pool: pool as unknown as Pool, image: TEST_IMAGE,
    });
    assert.equal(r.scanned, 0);
    assert.equal(r.swept, 0);
    assert.equal(captured.stopped.length, 0);
    assert.equal(pool.rows[0]!.state, "active");
  });

  test("vanished 行被 SQL filter 排除", async () => {
    const pool = new FakePool();
    pool.seed({
      id: 3, user_id: 300, bound_ip: "172.30.1.30",
      state: "vanished", port: 18789,
      container_internal_id: "docker-cccc",
      last_ws_activity: makeStaleDate(120),
    });
    const { docker, captured } = makeDocker();
    const r = await runIdleSweepTick({
      docker, pool: pool as unknown as Pool, image: TEST_IMAGE,
    });
    assert.equal(r.scanned, 0);
    assert.equal(captured.stopped.length, 0);
  });

  test("last_ws_activity IS NULL 行被排除(provision 后未更新过)", async () => {
    const pool = new FakePool();
    pool.seed({
      id: 4, user_id: 400, bound_ip: "172.30.1.40",
      state: "active", port: 18789,
      container_internal_id: "docker-dddd",
      last_ws_activity: null,
    });
    const { docker, captured } = makeDocker();
    const r = await runIdleSweepTick({
      docker, pool: pool as unknown as Pool, image: TEST_IMAGE,
    });
    assert.equal(r.scanned, 0);
    assert.equal(captured.stopped.length, 0);
    assert.equal(pool.rows[0]!.state, "active");
  });

  test("多行混合:stale active sweep,fresh active 留,vanished 不动", async () => {
    const pool = new FakePool();
    pool.seed({ id: 10, user_id: 1, bound_ip: "172.30.10.1", state: "active", port: 18789, container_internal_id: "d-10", last_ws_activity: makeStaleDate(100) });
    pool.seed({ id: 11, user_id: 2, bound_ip: "172.30.10.2", state: "active", port: 18789, container_internal_id: "d-11", last_ws_activity: makeStaleDate(5)   });
    pool.seed({ id: 12, user_id: 3, bound_ip: "172.30.10.3", state: "vanished", port: 18789, container_internal_id: "d-12", last_ws_activity: makeStaleDate(200) });
    pool.seed({ id: 13, user_id: 4, bound_ip: "172.30.10.4", state: "active", port: 18789, container_internal_id: "d-13", last_ws_activity: makeStaleDate(50)  });
    const { docker, captured } = makeDocker();
    const r = await runIdleSweepTick({
      docker, pool: pool as unknown as Pool, image: TEST_IMAGE,
    });
    assert.equal(r.scanned, 2);
    assert.equal(r.swept, 2);
    assert.equal(r.errors.length, 0);
    // 老的(100min)排在前(ORDER BY last_ws_activity ASC)
    assert.deepEqual(captured.stopped.sort(), ["d-10", "d-13"].sort());
    assert.deepEqual(captured.removed.sort(), ["d-10", "d-13"].sort());
    // 状态:10 / 13 vanished, 11 / 12 不变
    const byId = (id: number) => pool.rows.find((x) => x.id === id)!;
    assert.equal(byId(10).state, "vanished");
    assert.equal(byId(11).state, "active");
    assert.equal(byId(12).state, "vanished"); // 本来就 vanished
    assert.equal(byId(13).state, "vanished");
  });

  test("单行 stopAndRemove 抛 → errors 累计,其他行继续 sweep", async () => {
    const pool = new FakePool();
    pool.seed({ id: 20, user_id: 1, bound_ip: "172.30.20.1", state: "active", port: 18789, container_internal_id: "d-20", last_ws_activity: makeStaleDate(60) });
    pool.seed({ id: 21, user_id: 2, bound_ip: "172.30.20.2", state: "active", port: 18789, container_internal_id: "d-21", last_ws_activity: makeStaleDate(90) });
    const { docker, captured } = makeDocker({ stopThrows: new Set(["d-20"]) });
    const r = await runIdleSweepTick({
      docker, pool: pool as unknown as Pool, image: TEST_IMAGE,
    });
    assert.equal(r.scanned, 2);
    assert.equal(r.swept, 1);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0]!.containerId, 20);
    assert.match(r.errors[0]!.error, /stop failed/);
    // d-21 仍被 stop+remove
    assert.deepEqual(captured.stopped, ["d-21"]);
    assert.deepEqual(captured.removed, ["d-21"]);
    // 21 翻 vanished;20 因为 stopAndRemove 抛了 → 行还是 active
    assert.equal(pool.rows.find((r) => r.id === 21)!.state, "vanished");
    assert.equal(pool.rows.find((r) => r.id === 20)!.state, "active");
  });

  test("batchLimit=1 在多行 stale 时只处理 1 行", async () => {
    const pool = new FakePool();
    pool.seed({ id: 30, user_id: 1, bound_ip: "172.30.30.1", state: "active", port: 18789, container_internal_id: "d-30", last_ws_activity: makeStaleDate(60) });
    pool.seed({ id: 31, user_id: 2, bound_ip: "172.30.30.2", state: "active", port: 18789, container_internal_id: "d-31", last_ws_activity: makeStaleDate(90) });
    pool.seed({ id: 32, user_id: 3, bound_ip: "172.30.30.3", state: "active", port: 18789, container_internal_id: "d-32", last_ws_activity: makeStaleDate(120) });
    const { docker, captured } = makeDocker();
    const r = await runIdleSweepTick(
      { docker, pool: pool as unknown as Pool, image: TEST_IMAGE },
      { batchLimit: 1 },
    );
    assert.equal(r.scanned, 1);
    assert.equal(r.swept, 1);
    // 最 stale 的(120min)排前
    assert.deepEqual(captured.stopped, ["d-32"]);
  });

  test("idleCutoffMin 自定义为 5 分钟时,15min 行也被 sweep", async () => {
    const pool = new FakePool();
    pool.seed({ id: 40, user_id: 1, bound_ip: "172.30.40.1", state: "active", port: 18789, container_internal_id: "d-40", last_ws_activity: makeStaleDate(15) });
    const { docker, captured } = makeDocker();
    const r = await runIdleSweepTick(
      { docker, pool: pool as unknown as Pool, image: TEST_IMAGE },
      { idleCutoffMin: 5 },
    );
    assert.equal(r.scanned, 1);
    assert.equal(r.swept, 1);
    assert.deepEqual(captured.stopped, ["d-40"]);
  });
});

// ───────────────────────────────────────────────────────────────────────
//  常量 sanity
// ───────────────────────────────────────────────────────────────────────

describe("idleSweep defaults", () => {
  test("默认值与 §13.3 一致", () => {
    assert.equal(DEFAULT_IDLE_CUTOFF_MIN, 30);
    assert.equal(DEFAULT_IDLE_SWEEP_INTERVAL_MS, 60_000);
    assert.equal(DEFAULT_SWEEP_BATCH_LIMIT, 100);
  });
});

// ───────────────────────────────────────────────────────────────────────
//  startIdleSweepScheduler
// ───────────────────────────────────────────────────────────────────────

describe("startIdleSweepScheduler", () => {
  test("runOnce 串行触发返 result", async () => {
    const pool = new FakePool();
    pool.seed({ id: 50, user_id: 1, bound_ip: "172.30.50.1", state: "active", port: 18789, container_internal_id: "d-50", last_ws_activity: makeStaleDate(60) });
    const { docker, captured } = makeDocker();
    const sched = startIdleSweepScheduler(
      { docker, pool: pool as unknown as Pool, image: TEST_IMAGE },
      { intervalMs: 9999, runOnStart: false },
    );
    try {
      const r = await sched.runOnce();
      assert.equal(r.scanned, 1);
      assert.equal(r.swept, 1);
      assert.deepEqual(captured.stopped, ["d-50"]);
    } finally {
      await sched.stop();
    }
  });

  test("stop() 幂等 — 多次调用不抛", async () => {
    const pool = new FakePool();
    const { docker } = makeDocker();
    const sched = startIdleSweepScheduler(
      { docker, pool: pool as unknown as Pool, image: TEST_IMAGE },
      { intervalMs: 9999, runOnStart: false },
    );
    await sched.stop();
    await sched.stop(); // 第二次也不抛
  });

  test("runOnStart=true → tick 立刻跑一次,onTick 拿到 result", async () => {
    const pool = new FakePool();
    pool.seed({ id: 60, user_id: 1, bound_ip: "172.30.60.1", state: "active", port: 18789, container_internal_id: "d-60", last_ws_activity: makeStaleDate(45) });
    const { docker, captured } = makeDocker();
    let observed: { scanned: number; swept: number } | null = null;
    const ticked = new Promise<void>((resolve) => {
      const sched = startIdleSweepScheduler(
        { docker, pool: pool as unknown as Pool, image: TEST_IMAGE },
        {
          intervalMs: 9999,
          runOnStart: true,
          onTick: (r) => {
            observed = { scanned: r.scanned, swept: r.swept };
            resolve();
            void sched.stop();
          },
        },
      );
    });
    await ticked;
    assert.deepEqual(observed, { scanned: 1, swept: 1 });
    assert.deepEqual(captured.stopped, ["d-60"]);
  });
});

// ───────────────────────────────────────────────────────────────────────
//  markV3ContainerActivity
// ───────────────────────────────────────────────────────────────────────

describe("markV3ContainerActivity", () => {
  test("active 行 → last_ws_activity 刷新到接近 NOW()", async () => {
    const pool = new FakePool();
    const oldDate = makeStaleDate(60);
    pool.seed({
      id: 70, user_id: 1, bound_ip: "172.30.70.1",
      state: "active", port: 18789, container_internal_id: "d-70",
      last_ws_activity: oldDate,
    });
    const before = Date.now();
    await markV3ContainerActivity(
      { docker: {} as Docker, pool: pool as unknown as Pool, image: TEST_IMAGE },
      70,
    );
    const after = Date.now();
    const r = pool.rows.find((x) => x.id === 70)!;
    assert.ok(r.last_ws_activity!.getTime() >= before);
    assert.ok(r.last_ws_activity!.getTime() <= after + 5);
    assert.deepEqual(pool.updateActivityCalls, [70]);
  });

  test("vanished 行 → 不刷新(WHERE state='active' 兜住)", async () => {
    const pool = new FakePool();
    const oldDate = makeStaleDate(120);
    pool.seed({
      id: 71, user_id: 1, bound_ip: "172.30.71.1",
      state: "vanished", port: 18789, container_internal_id: "d-71",
      last_ws_activity: oldDate,
    });
    await markV3ContainerActivity(
      { docker: {} as Docker, pool: pool as unknown as Pool, image: TEST_IMAGE },
      71,
    );
    const r = pool.rows.find((x) => x.id === 71)!;
    assert.equal(r.last_ws_activity!.getTime(), oldDate.getTime());
    // SQL 仍然被 issue,但 WHERE 命不中 → rowCount 0
    assert.deepEqual(pool.updateActivityCalls, [71]);
  });

  test("无效 id → 早返,不 issue SQL", async () => {
    const pool = new FakePool();
    await markV3ContainerActivity(
      { docker: {} as Docker, pool: pool as unknown as Pool, image: TEST_IMAGE },
      0,
    );
    await markV3ContainerActivity(
      { docker: {} as Docker, pool: pool as unknown as Pool, image: TEST_IMAGE },
      -1,
    );
    await markV3ContainerActivity(
      { docker: {} as Docker, pool: pool as unknown as Pool, image: TEST_IMAGE },
      1.5,
    );
    assert.deepEqual(pool.updateActivityCalls, []);
  });

  test("pool.query 抛 → 不冒泡(自吞)", async () => {
    const pool = {
      query: async () => { throw new Error("connection lost"); },
    } as unknown as Pool;
    // 不应该抛
    await markV3ContainerActivity(
      { docker: {} as Docker, pool, image: TEST_IMAGE },
      100,
    );
  });
});
