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
  host_uuid?: string | null;
}

class FakePool {
  rows: FakeDbRow[] = [];
  vanishedCalls: number[] = [];

  seed(r: FakeDbRow): void {
    this.rows.push(r);
  }

  async query(sql: string, params?: unknown[]): Promise<unknown> {
    const trimmed = String(sql).trim();
    // SELECT id, container_internal_id, host_uuid FROM agent_containers WHERE state='active'
    if (
      /^SELECT id, container_internal_id, host_uuid\s+FROM agent_containers/i.test(trimmed) &&
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
          host_uuid: r.host_uuid ?? null,
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

// ───────────────────────────────────────────────────────────────────────
//  multi-host routing —— hshi/user33 (1185) 误删 bug 的回归测试
//  bug: Direction B 直打 deps.docker.inspect,跨 host 容器必 404 → 误标 vanished
//  fix: row.host_uuid !== selfHostId 时走 deps.containerService.inspect(host_uuid, cid)
// ───────────────────────────────────────────────────────────────────────

interface CsCaptured {
  inspected: Array<{ hostId: string; cid: string }>;
  stopped: Array<{ hostId: string; cid: string }>;
  removed: Array<{ hostId: string; cid: string }>;
}

function makeContainerService(opts: {
  /** 这些 cid 在 inspect 时返回 dockerode 风格 404(`statusCode=404`)*/
  notFoundCids?: Set<string>;
  /** 这些 cid 在 inspect 时返回 nodeAgent 风格 404(`AgentAppError.httpStatus=404`)*/
  notFoundCidsHttp?: Set<string>;
  /** 这些 cid 在 inspect 时抛非 404(模拟 mTLS 临时错)*/
  throwCids?: Set<string>;
} = {}): { svc: NonNullable<V3SupervisorDeps["containerService"]>; captured: CsCaptured } {
  const captured: CsCaptured = { inspected: [], stopped: [], removed: [] };
  // 模拟 nodeAgentClient.AgentAppError 形状(httpStatus,而非 statusCode)
  const makeHttpNotFound = (cid: string) => {
    const e = new Error(`agent returned 404: No such container: ${cid}`) as Error & { httpStatus: number };
    e.httpStatus = 404;
    return e;
  };
  const svc = {
    async inspect(hostId: string, cid: string) {
      captured.inspected.push({ hostId, cid });
      if (opts.notFoundCids?.has(cid)) {
        const e = new Error(`No such container: ${cid}`) as Error & { statusCode: number };
        e.statusCode = 404;
        throw e;
      }
      if (opts.notFoundCidsHttp?.has(cid)) {
        throw makeHttpNotFound(cid);
      }
      if (opts.throwCids?.has(cid)) {
        const e = new Error("mTLS unavailable") as Error & { statusCode: number };
        e.statusCode = 502;
        throw e;
      }
      return { Id: cid, State: { Running: true } };
    },
    async stop(hostId: string, cid: string) {
      captured.stopped.push({ hostId, cid });
      // 模拟 missing → 404(stopAndRemoveV3Container 会吞)
      if (opts.notFoundCids?.has(cid)) {
        const e = new Error(`No such container: ${cid}`) as Error & { statusCode: number };
        e.statusCode = 404;
        throw e;
      }
      if (opts.notFoundCidsHttp?.has(cid)) {
        throw makeHttpNotFound(cid);
      }
    },
    async remove(hostId: string, cid: string) {
      captured.removed.push({ hostId, cid });
      if (opts.notFoundCids?.has(cid)) {
        const e = new Error(`No such container: ${cid}`) as Error & { statusCode: number };
        e.statusCode = 404;
        throw e;
      }
      if (opts.notFoundCidsHttp?.has(cid)) {
        throw makeHttpNotFound(cid);
      }
    },
    // 余下 ContainerService 接口未在 reconcile 路径上调用,塞 throw 占位
    async ensureVolume() { throw new Error("not used in reconcile"); },
    async removeVolume() { throw new Error("not used in reconcile"); },
    async inspectVolume() { throw new Error("not used in reconcile"); },
    async createAndStart() { throw new Error("not used in reconcile"); },
    async resolveBaselinePaths() { throw new Error("not used in reconcile"); },
  } as unknown as NonNullable<V3SupervisorDeps["containerService"]>;
  return { svc, captured };
}

// 需要在文件顶部引入 V3SupervisorDeps 类型
// (本套件的 import 用的是 agent-sandbox/index.js,该 barrel 不再 re-export 类型)
// 这里直接通过 NonNullable<…> + 内部 cast 的方式取到 containerService 字段类型
import type { V3SupervisorDeps } from "../agent-sandbox/v3supervisor.js";

const SELF_HOST = "self-host-uuid-aaaa";
const REMOTE_HOST = "remote-host-uuid-bbbb";

describe("runOrphanReconcileTick · multi-host routing", () => {
  test("跨 host row + containerService.inspect ok → 不 vanish(回归 hshi/user33 1185)", async () => {
    const pool = new FakePool();
    pool.seed({
      id: 1185, state: "active",
      container_internal_id: "remote-cid-X",
      host_uuid: REMOTE_HOST,
    });
    const { docker, captured: dockerCap } = makeDocker(); // 本机 docker 啥都没有
    const { svc, captured: csCap } = makeContainerService();
    const r = await runOrphanReconcileTick({
      docker, pool: pool as unknown as Pool, image: TEST_IMAGE,
      containerService: svc, selfHostId: SELF_HOST,
    });
    assert.equal(r.dbOrphansVanished, 0, "跨 host row 不应被 vanish");
    assert.equal(pool.rows[0]!.state, "active", "DB 行仍 active");
    assert.deepEqual(csCap.inspected, [{ hostId: REMOTE_HOST, cid: "remote-cid-X" }],
      "inspect 必须走 containerService 而不是本机 docker");
    assert.equal(dockerCap.inspected.length, 0, "本机 docker.inspect 不该被调");
  });

  test("跨 host row + containerService.inspect 404 (statusCode dockerode 形状) → vanish(走 cs.stop+remove)", async () => {
    const pool = new FakePool();
    pool.seed({
      id: 1186, state: "active",
      container_internal_id: "remote-cid-Y",
      host_uuid: REMOTE_HOST,
    });
    const { docker } = makeDocker();
    const { svc, captured: csCap } = makeContainerService({
      notFoundCids: new Set(["remote-cid-Y"]),
    });
    const r = await runOrphanReconcileTick({
      docker, pool: pool as unknown as Pool, image: TEST_IMAGE,
      containerService: svc, selfHostId: SELF_HOST,
    });
    assert.equal(r.dbOrphansVanished, 1);
    assert.deepEqual(pool.vanishedCalls, [1186]);
    assert.equal(pool.rows[0]!.state, "vanished");
    // stopAndRemoveV3Container 走 remote 路径,stop+remove 通过 containerService
    assert.deepEqual(csCap.stopped, [{ hostId: REMOTE_HOST, cid: "remote-cid-Y" }]);
    assert.deepEqual(csCap.removed, [{ hostId: REMOTE_HOST, cid: "remote-cid-Y" }]);
  });

  test("跨 host row + containerService.inspect 404 (httpStatus AgentAppError 形状) → vanish", async () => {
    // 真实远端路径走 nodeAgentClient,404 抛 `AgentAppError { httpStatus: 404 }`
    // 而不是 dockerode 的 `{ statusCode: 404 }`。回归保护 isNotFound 必须同时识别。
    const pool = new FakePool();
    pool.seed({
      id: 1191, state: "active",
      container_internal_id: "remote-cid-Y2",
      host_uuid: REMOTE_HOST,
    });
    const { docker } = makeDocker();
    const { svc, captured: csCap } = makeContainerService({
      notFoundCidsHttp: new Set(["remote-cid-Y2"]),
    });
    const r = await runOrphanReconcileTick({
      docker, pool: pool as unknown as Pool, image: TEST_IMAGE,
      containerService: svc, selfHostId: SELF_HOST,
    });
    assert.equal(r.dbOrphansVanished, 1, "httpStatus=404 也必须走 vanish");
    assert.equal(r.errors.length, 0, "404 不该进 errors[]");
    assert.deepEqual(pool.vanishedCalls, [1191]);
    assert.equal(pool.rows[0]!.state, "vanished");
    // 同时回归 stopAndRemoveV3Container 的 isNotFound:remote stop/remove 抛
    // httpStatus=404 不应聚合成 PartialV3Cleanup
    assert.deepEqual(csCap.stopped, [{ hostId: REMOTE_HOST, cid: "remote-cid-Y2" }]);
    assert.deepEqual(csCap.removed, [{ hostId: REMOTE_HOST, cid: "remote-cid-Y2" }]);
  });

  test("跨 host row + containerService 未注入 → skip,不 vanish", async () => {
    const pool = new FakePool();
    pool.seed({
      id: 1187, state: "active",
      container_internal_id: "remote-cid-Z",
      host_uuid: REMOTE_HOST,
    });
    const { docker, captured: dockerCap } = makeDocker();
    const r = await runOrphanReconcileTick({
      docker, pool: pool as unknown as Pool, image: TEST_IMAGE,
      // 故意只给 selfHostId 不给 containerService
      selfHostId: SELF_HOST,
    });
    assert.equal(r.dbOrphansVanished, 0, "containerService 缺失时跨 host row 必须 skip");
    assert.equal(r.errors.length, 0);
    assert.equal(pool.rows[0]!.state, "active");
    assert.equal(dockerCap.inspected.length, 0, "也不该回退本机 docker");
  });

  test("row.host_uuid 有值但 selfHostId 缺失 → skip,绝不 vanish", async () => {
    const pool = new FakePool();
    pool.seed({
      id: 1188, state: "active",
      container_internal_id: "ambiguous-cid",
      host_uuid: REMOTE_HOST,
    });
    const { docker, captured: dockerCap } = makeDocker();
    const { svc, captured: csCap } = makeContainerService();
    const r = await runOrphanReconcileTick({
      docker, pool: pool as unknown as Pool, image: TEST_IMAGE,
      containerService: svc,
      // selfHostId 故意不传:无法判定 row 是本机还是远端
    });
    assert.equal(r.dbOrphansVanished, 0, "无法判定 host 时绝不破坏");
    assert.equal(pool.rows[0]!.state, "active");
    assert.equal(dockerCap.inspected.length, 0, "不该走本机");
    assert.equal(csCap.inspected.length, 0, "也不该走远端");
  });

  test("row.host_uuid === selfHostId → 走本机 docker.inspect", async () => {
    const pool = new FakePool();
    pool.seed({
      id: 1189, state: "active",
      container_internal_id: "local-cid-A",
      host_uuid: SELF_HOST,
    });
    const { docker, captured: dockerCap } = makeDocker({
      containers: [{ Id: "local-cid-A", Created: NOW_SEC() - 1000 }],
    });
    const { svc, captured: csCap } = makeContainerService();
    const r = await runOrphanReconcileTick({
      docker, pool: pool as unknown as Pool, image: TEST_IMAGE,
      containerService: svc, selfHostId: SELF_HOST,
    });
    assert.equal(r.dbOrphansVanished, 0);
    assert.deepEqual(dockerCap.inspected, ["local-cid-A"], "本机行走本机 docker");
    assert.equal(csCap.inspected.length, 0, "本机行不该走 containerService");
  });

  test("跨 host inspect 抛非 404(mTLS 抖动)→ errors[],不 vanish", async () => {
    const pool = new FakePool();
    pool.seed({
      id: 1190, state: "active",
      container_internal_id: "flaky-cid",
      host_uuid: REMOTE_HOST,
    });
    const { docker } = makeDocker();
    const { svc } = makeContainerService({
      throwCids: new Set(["flaky-cid"]),
    });
    const r = await runOrphanReconcileTick({
      docker, pool: pool as unknown as Pool, image: TEST_IMAGE,
      containerService: svc, selfHostId: SELF_HOST,
    });
    assert.equal(r.dbOrphansVanished, 0, "非 404 错误绝不升级为 vanish");
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0]!.kind, "db");
    assert.equal(r.errors[0]!.id, "1190");
    assert.match(r.errors[0]!.error, /mTLS unavailable/);
    assert.equal(pool.rows[0]!.state, "active");
  });

  test("Direction A:selfHostId 存在时,跨 host row cid 不阻止本机 dockerOrphan 删除", async () => {
    // 反向回归:本机 listContainers 列出一个真孤儿,DB 里只有跨 host active 行
    // (host_uuid !== selfHostId)。修复后跨 host cid 不进 dbActiveCids,本机
    // 孤儿能被正常清理。
    const pool = new FakePool();
    pool.seed({
      id: 9000, state: "active",
      container_internal_id: "cross-host-cid", // 与本机 docker 列表无关
      host_uuid: REMOTE_HOST,
    });
    const { docker, captured: dockerCap } = makeDocker({
      containers: [{ Id: "local-orphan", Created: NOW_SEC() - 1000 }],
    });
    const { svc } = makeContainerService();
    const r = await runOrphanReconcileTick({
      docker, pool: pool as unknown as Pool, image: TEST_IMAGE,
      containerService: svc, selfHostId: SELF_HOST,
    });
    assert.equal(r.dockerOrphansRemoved, 1);
    assert.deepEqual(dockerCap.stopped, ["local-orphan"]);
    assert.deepEqual(dockerCap.removed, ["local-orphan"]);
  });

  test("Direction A:selfHostId 缺失时退回原全集,跨 host cid 与本机 docker id 同名时不误删", async () => {
    // selfHostId 缺失场景:多 host 配置出错。退回原行为 = 全部 active cid 都进
    // dbActiveCids,即便撞上跨 host cid 也不删本机容器。
    const pool = new FakePool();
    pool.seed({
      id: 9001, state: "active",
      container_internal_id: "shared-cid", // 巧合与本机 docker id 同名
      host_uuid: REMOTE_HOST,
    });
    const { docker, captured: dockerCap } = makeDocker({
      containers: [{ Id: "shared-cid", Created: NOW_SEC() - 1000 }],
    });
    const r = await runOrphanReconcileTick({
      docker, pool: pool as unknown as Pool, image: TEST_IMAGE,
      // 注意:selfHostId 缺失
    });
    assert.equal(r.dockerOrphansRemoved, 0, "本机容器不应被误删");
    assert.equal(dockerCap.stopped.length, 0);
    assert.equal(dockerCap.removed.length, 0);
  });
});
