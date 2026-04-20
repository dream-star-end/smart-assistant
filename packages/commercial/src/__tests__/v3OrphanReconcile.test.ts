/**
 * V3 Phase 3H — agent-sandbox/v3orphanReconcile.ts 单测。
 *
 * 覆盖:
 *   - runOrphanReconcileTick:
 *       · 空 docker + 空 DB → 0/0
 *       · docker 有 1 但 DB 无该 cid → docker orphan 删
 *       · DB 有 1 active row + docker 有同 cid 容器 → 啥都不动
 *       · DB 有 1 active row 但 docker 404 → 标 vanished(direction B)
 *       · docker 容器 Created < 安全窗口 → skip(safetyRaceWindow)
 *       · docker container_internal_id IS NULL 行 → 不参与 direction B
 *       · 单 docker stop 抛 → errors 累加,其他容器继续
 *       · 单 DB inspect 抛非 404(daemon 错)→ errors 累加
 *       · 多容器 + 多 DB row 混合
 *   - startOrphanReconcileScheduler:
 *       · runOnce 串行
 *       · stop 幂等
 *       · runOnStart 默认 true → 立刻跑 + onTick
 *       · runOnStart=false → 不立即跑(给 timer 排到才跑)
 *   - 默认常量 sanity
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type Docker from "dockerode";
import type { Pool, PoolClient } from "pg";

import {
  runOrphanReconcileTick,
  startOrphanReconcileScheduler,
  DEFAULT_ORPHAN_RECONCILE_INTERVAL_MS,
  DEFAULT_RECONCILE_BATCH_LIMIT,
  SAFETY_RACE_WINDOW_SEC,
} from "../agent-sandbox/index.js";

// ───────────────────────────────────────────────────────────────────────
//  fake docker — listContainers + getContainer().stop/remove/inspect
// ───────────────────────────────────────────────────────────────────────

interface FakeDockerContainer {
  Id: string;
  Created: number; // unix epoch sec
  /** 是否 inspect 抛 404(模拟 docker 容器消失)*/
  inspectNotFound?: boolean;
  /** inspect 抛非 404 错(模拟 daemon 抖动)*/
  inspectThrows?: boolean;
  Running?: boolean;
}

interface DockerCaptured {
  stopped: string[];
  removed: string[];
  inspected: string[];
  listFilters: unknown[];
}

function makeDocker(opts: {
  containers?: FakeDockerContainer[];
  stopThrows?: Set<string>;
  removeThrows?: Set<string>;
} = {}): { docker: Docker; captured: DockerCaptured } {
  const containers = opts.containers ?? [];
  const captured: DockerCaptured = {
    stopped: [], removed: [], inspected: [], listFilters: [],
  };

  const listContainers = async (q: { all?: boolean; filters?: unknown }) => {
    captured.listFilters.push(q.filters);
    return containers.map((c) => ({
      Id: c.Id,
      Created: c.Created,
      Names: [`/oc-v3-test-${c.Id}`],
      Labels: { "com.openclaude.v3.managed": "1" },
    }));
  };

  const getContainer = (id: string) => ({
    inspect: async () => {
      captured.inspected.push(id);
      const c = containers.find((x) => x.Id === id);
      if (!c || c.inspectNotFound) {
        const e = new Error(`No such container: ${id}`) as Error & { statusCode: number };
        e.statusCode = 404;
        throw e;
      }
      if (c.inspectThrows) {
        const e = new Error(`daemon unavailable`) as Error & { statusCode: number };
        e.statusCode = 500;
        throw e;
      }
      return { Id: id, State: { Running: c.Running ?? true } };
    },
    stop: async () => {
      if (opts.stopThrows?.has(id)) {
        const e = new Error(`stop failed for ${id}`) as Error & { statusCode: number };
        e.statusCode = 500;
        throw e;
      }
      // 容器不在 containers 里 → 模拟 docker 404
      if (!containers.find((x) => x.Id === id)) {
        const e = new Error(`No such container: ${id}`) as Error & { statusCode: number };
        e.statusCode = 404;
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
      if (!containers.find((x) => x.Id === id)) {
        const e = new Error(`No such container: ${id}`) as Error & { statusCode: number };
        e.statusCode = 404;
        throw e;
      }
      captured.removed.push(id);
    },
  });

  const docker = { listContainers, getContainer } as unknown as Docker;
  return { docker, captured };
}

// ───────────────────────────────────────────────────────────────────────
//  fake pg.Pool — agent_containers 读 / vanished UPDATE
// ───────────────────────────────────────────────────────────────────────

interface FakeDbRow {
  id: number;
  state: "active" | "vanished";
  container_internal_id: string | null;
}

class FakePool {
  rows: FakeDbRow[] = [];
  vanishedCalls: number[] = [];

  seed(r: FakeDbRow): void {
    this.rows.push(r);
  }

  async query(sql: string, params?: unknown[]): Promise<unknown> {
    const trimmed = String(sql).trim();
    // SELECT id, container_internal_id FROM agent_containers WHERE state='active'
    if (
      /^SELECT id, container_internal_id\s+FROM agent_containers/i.test(trimmed) &&
      /WHERE state = 'active'/i.test(trimmed)
    ) {
      const limit = Number(params?.[0]);
      const matched = this.rows
        .filter((r) => r.state === "active")
        .sort((a, b) => a.id - b.id)
        .slice(0, limit);
      return {
        rowCount: matched.length,
        rows: matched.map((r) => ({
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
      this.vanishedCalls.push(id);
      const r = this.rows.find((x) => x.id === id);
      if (r) r.state = "vanished";
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
const NOW_SEC = () => Math.floor(Date.now() / 1000);

// ───────────────────────────────────────────────────────────────────────
//  runOrphanReconcileTick
// ───────────────────────────────────────────────────────────────────────

describe("runOrphanReconcileTick", () => {
  test("空 docker + 空 DB → 0/0/0", async () => {
    const pool = new FakePool();
    const { docker, captured } = makeDocker();
    const r = await runOrphanReconcileTick({
      docker, pool: pool as unknown as Pool, image: TEST_IMAGE,
    });
    assert.equal(r.scanned.dockerContainers, 0);
    assert.equal(r.scanned.dbActiveRows, 0);
    assert.equal(r.dockerOrphansRemoved, 0);
    assert.equal(r.dbOrphansVanished, 0);
    assert.equal(r.skippedRecent, 0);
    assert.deepEqual(r.errors, []);
    assert.equal(captured.stopped.length, 0);
    assert.equal(captured.removed.length, 0);
  });

  test("docker 1 容器但 DB 没该 cid → docker orphan 被 stop+rm", async () => {
    const pool = new FakePool();
    const { docker, captured } = makeDocker({
      containers: [{ Id: "docker-A", Created: NOW_SEC() - 1000 }], // 老
    });
    const r = await runOrphanReconcileTick({
      docker, pool: pool as unknown as Pool, image: TEST_IMAGE,
    });
    assert.equal(r.scanned.dockerContainers, 1);
    assert.equal(r.scanned.dbActiveRows, 0);
    assert.equal(r.dockerOrphansRemoved, 1);
    assert.equal(r.dbOrphansVanished, 0);
    assert.deepEqual(captured.stopped, ["docker-A"]);
    assert.deepEqual(captured.removed, ["docker-A"]);
  });

  test("docker 1 + DB 1 active row 同 cid → 不动(双方对齐)", async () => {
    const pool = new FakePool();
    pool.seed({ id: 100, state: "active", container_internal_id: "docker-B" });
    const { docker, captured } = makeDocker({
      containers: [{ Id: "docker-B", Created: NOW_SEC() - 1000 }],
    });
    const r = await runOrphanReconcileTick({
      docker, pool: pool as unknown as Pool, image: TEST_IMAGE,
    });
    assert.equal(r.scanned.dockerContainers, 1);
    assert.equal(r.scanned.dbActiveRows, 1);
    assert.equal(r.dockerOrphansRemoved, 0);
    assert.equal(r.dbOrphansVanished, 0);
    assert.equal(captured.stopped.length, 0);
    assert.equal(captured.removed.length, 0);
    // direction B inspect 验过该容器仍 alive
    assert.deepEqual(captured.inspected, ["docker-B"]);
    assert.equal(pool.rows[0]!.state, "active");
  });

  test("DB 1 active row 但 docker 404 → 标 vanished(direction B)", async () => {
    const pool = new FakePool();
    pool.seed({ id: 200, state: "active", container_internal_id: "docker-C" });
    // docker 没该容器(空 list + inspect 404)
    const { docker, captured } = makeDocker({});
    const r = await runOrphanReconcileTick({
      docker, pool: pool as unknown as Pool, image: TEST_IMAGE,
    });
    assert.equal(r.scanned.dockerContainers, 0);
    assert.equal(r.scanned.dbActiveRows, 1);
    assert.equal(r.dockerOrphansRemoved, 0);
    assert.equal(r.dbOrphansVanished, 1);
    assert.deepEqual(pool.vanishedCalls, [200]);
    assert.equal(pool.rows[0]!.state, "vanished");
    // stopAndRemove 内部 missing → noop on stop/remove
    assert.equal(captured.stopped.length, 0);
    assert.equal(captured.removed.length, 0);
  });

  test("docker 容器 Created < 5min 安全窗 → skip,不算 orphan", async () => {
    const pool = new FakePool();
    const { docker, captured } = makeDocker({
      containers: [{ Id: "docker-D", Created: NOW_SEC() - 60 }], // 60s ago < 300s
    });
    const r = await runOrphanReconcileTick({
      docker, pool: pool as unknown as Pool, image: TEST_IMAGE,
    });
    assert.equal(r.scanned.dockerContainers, 0);
    assert.equal(r.skippedRecent, 1);
    assert.equal(r.dockerOrphansRemoved, 0);
    assert.equal(captured.stopped.length, 0);
  });

  test("DB row container_internal_id IS NULL → 不参与 direction B", async () => {
    const pool = new FakePool();
    pool.seed({ id: 300, state: "active", container_internal_id: null });
    const { docker, captured } = makeDocker({});
    const r = await runOrphanReconcileTick({
      docker, pool: pool as unknown as Pool, image: TEST_IMAGE,
    });
    assert.equal(r.dbOrphansVanished, 0);
    assert.equal(r.errors.length, 0);
    assert.equal(captured.inspected.length, 0); // NULL → 不 inspect
    assert.equal(pool.rows[0]!.state, "active"); // 仍 active
  });

  test("单 docker stop 抛 → errors 累加,其他 docker 继续删", async () => {
    const pool = new FakePool();
    const { docker, captured } = makeDocker({
      containers: [
        { Id: "docker-E", Created: NOW_SEC() - 1000 },
        { Id: "docker-F", Created: NOW_SEC() - 1000 },
      ],
      stopThrows: new Set(["docker-E"]),
    });
    const r = await runOrphanReconcileTick({
      docker, pool: pool as unknown as Pool, image: TEST_IMAGE,
    });
    assert.equal(r.scanned.dockerContainers, 2);
    assert.equal(r.dockerOrphansRemoved, 1);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0]!.kind, "docker");
    assert.equal(r.errors[0]!.id, "docker-E");
    assert.deepEqual(captured.stopped, ["docker-F"]);
    assert.deepEqual(captured.removed, ["docker-F"]);
  });

  test("DB inspect 抛 500(非 404)→ errors 累加但不标 vanished", async () => {
    const pool = new FakePool();
    pool.seed({ id: 400, state: "active", container_internal_id: "docker-G" });
    const { docker } = makeDocker({
      containers: [{ Id: "docker-G", Created: NOW_SEC() - 1000, inspectThrows: true }],
    });
    const r = await runOrphanReconcileTick({
      docker, pool: pool as unknown as Pool, image: TEST_IMAGE,
    });
    assert.equal(r.dbOrphansVanished, 0);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0]!.kind, "db");
    assert.equal(r.errors[0]!.id, "400");
    assert.match(r.errors[0]!.error, /daemon unavailable/);
    // 行没被标 vanished(因为不是 404)
    assert.equal(pool.rows[0]!.state, "active");
    assert.deepEqual(pool.vanishedCalls, []);
  });

  test("混合:1 docker 孤儿 + 1 DB 孤儿 + 1 对齐 + 1 太新 skip", async () => {
    const pool = new FakePool();
    pool.seed({ id: 500, state: "active", container_internal_id: "docker-H" }); // 对齐
    pool.seed({ id: 501, state: "active", container_internal_id: "docker-X" }); // DB 孤儿
    const { docker, captured } = makeDocker({
      containers: [
        { Id: "docker-H", Created: NOW_SEC() - 1000 }, // 对齐
        { Id: "docker-Y", Created: NOW_SEC() - 1000 }, // docker 孤儿
        { Id: "docker-Z", Created: NOW_SEC() - 30   }, // 太新,skip
      ],
    });
    const r = await runOrphanReconcileTick({
      docker, pool: pool as unknown as Pool, image: TEST_IMAGE,
    });
    assert.equal(r.scanned.dockerContainers, 2); // Z 被 skip
    assert.equal(r.scanned.dbActiveRows, 2);
    assert.equal(r.dockerOrphansRemoved, 1);
    assert.equal(r.dbOrphansVanished, 1);
    assert.equal(r.skippedRecent, 1);
    assert.deepEqual(captured.stopped, ["docker-Y"]);
    assert.deepEqual(captured.removed, ["docker-Y"]);
    assert.deepEqual(pool.vanishedCalls, [501]);
    // H 仍 active,X 翻 vanished
    assert.equal(pool.rows.find((r) => r.id === 500)!.state, "active");
    assert.equal(pool.rows.find((r) => r.id === 501)!.state, "vanished");
  });

  test("listContainers 用 com.openclaude.v3.managed=1 label filter", async () => {
    const pool = new FakePool();
    const { docker, captured } = makeDocker();
    await runOrphanReconcileTick({
      docker, pool: pool as unknown as Pool, image: TEST_IMAGE,
    });
    assert.equal(captured.listFilters.length, 1);
    const f = captured.listFilters[0] as { label: string[] };
    assert.deepEqual(f.label, ["com.openclaude.v3.managed=1"]);
  });

  test("自定义 safetyRaceWindowSec=10 → 30s 老的容器照样删", async () => {
    const pool = new FakePool();
    const { docker, captured } = makeDocker({
      containers: [{ Id: "docker-Q", Created: NOW_SEC() - 30 }],
    });
    const r = await runOrphanReconcileTick(
      { docker, pool: pool as unknown as Pool, image: TEST_IMAGE },
      { safetyRaceWindowSec: 10 },
    );
    assert.equal(r.dockerOrphansRemoved, 1);
    assert.deepEqual(captured.stopped, ["docker-Q"]);
  });
});

// ───────────────────────────────────────────────────────────────────────
//  默认常量 sanity
// ───────────────────────────────────────────────────────────────────────

describe("orphanReconcile defaults", () => {
  test("默认值与 §3H 一致", () => {
    assert.equal(DEFAULT_ORPHAN_RECONCILE_INTERVAL_MS, 3_600_000);
    assert.equal(DEFAULT_RECONCILE_BATCH_LIMIT, 200);
    assert.equal(SAFETY_RACE_WINDOW_SEC, 300);
  });
});

// ───────────────────────────────────────────────────────────────────────
//  startOrphanReconcileScheduler
// ───────────────────────────────────────────────────────────────────────

describe("startOrphanReconcileScheduler", () => {
  test("runOnce 串行触发返 result", async () => {
    const pool = new FakePool();
    const { docker, captured } = makeDocker({
      containers: [{ Id: "docker-S1", Created: NOW_SEC() - 1000 }],
    });
    const sched = startOrphanReconcileScheduler(
      { docker, pool: pool as unknown as Pool, image: TEST_IMAGE },
      { intervalMs: 9_999_999, runOnStart: false },
    );
    try {
      const r = await sched.runOnce();
      assert.equal(r.dockerOrphansRemoved, 1);
      assert.deepEqual(captured.stopped, ["docker-S1"]);
    } finally {
      await sched.stop();
    }
  });

  test("stop() 幂等", async () => {
    const pool = new FakePool();
    const { docker } = makeDocker();
    const sched = startOrphanReconcileScheduler(
      { docker, pool: pool as unknown as Pool, image: TEST_IMAGE },
      { intervalMs: 9_999_999, runOnStart: false },
    );
    await sched.stop();
    await sched.stop();
  });

  test("默认 runOnStart=true → 立刻跑 + onTick 拿到 result", async () => {
    const pool = new FakePool();
    const { docker, captured } = makeDocker({
      containers: [{ Id: "docker-S2", Created: NOW_SEC() - 1000 }],
    });
    let observed: { dockerOrphansRemoved: number } | null = null;
    const ticked = new Promise<void>((resolve) => {
      const sched = startOrphanReconcileScheduler(
        { docker, pool: pool as unknown as Pool, image: TEST_IMAGE },
        {
          intervalMs: 9_999_999,
          // 注意:不传 runOnStart 走默认 true
          onTick: (r) => {
            observed = { dockerOrphansRemoved: r.dockerOrphansRemoved };
            resolve();
            void sched.stop();
          },
        },
      );
    });
    await ticked;
    assert.deepEqual(observed, { dockerOrphansRemoved: 1 });
    assert.deepEqual(captured.stopped, ["docker-S2"]);
  });

  test("runOnStart=false → 不立即跑(needs runOnce 触发)", async () => {
    const pool = new FakePool();
    const { docker, captured } = makeDocker({
      containers: [{ Id: "docker-S3", Created: NOW_SEC() - 1000 }],
    });
    const sched = startOrphanReconcileScheduler(
      { docker, pool: pool as unknown as Pool, image: TEST_IMAGE },
      { intervalMs: 9_999_999, runOnStart: false },
    );
    // 给 event loop 一拍,确保 tickLoop 没被调
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(captured.stopped.length, 0);
    await sched.stop();
  });
});
