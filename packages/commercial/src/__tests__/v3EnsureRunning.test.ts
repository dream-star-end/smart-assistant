/**
 * V3 Phase 3D — agent-sandbox/v3ensureRunning.ts 单测。
 *
 * 覆盖:
 *   - active+running+healthz ok → 返 {host, port}
 *   - active+running+healthz timeout → ContainerUnreadyError("starting")
 *   - active+stopped → ContainerUnreadyError("stopped", retryAfter=3)
 *   - active+missing → stopAndRemove + provision + waitHealthz → 成功
 *   - 无 active 行 → provision + waitHealthz → 成功
 *   - provision 抛(NameConflict / IP 池满)→ ContainerUnreadyError("provisioning")
 *   - getV3ContainerStatus 抛 → ContainerUnreadyError("supervisor_error")
 *   - bigint 越界 → ContainerUnreadyError("invalid_uid")
 *   - probeHealthz 默认实现走 http.request /healthz(简单 GET → 2xx)
 *
 * 不测的(归 integ):
 *   - 真 docker daemon
 *   - 真 PG / agent_containers
 *   - 真 ws 桥接(2E 自己有测)
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type Docker from "dockerode";
import type { Pool, PoolClient } from "pg";

import {
  makeV3EnsureRunning,
  ENSURE_RUNNING_DEFAULTS,
  buildReadinessOpts,
} from "../agent-sandbox/v3ensureRunning.js";
import { ContainerUnreadyError } from "../ws/userChatBridge.js";
import {
  V3_CONTAINER_PORT,
  type V3SupervisorDeps,
} from "../agent-sandbox/v3supervisor.js";

// ───────────────────────────────────────────────────────────────────────
//  Fakes —— ensureRunning 通过 supervisor.* helpers 调 docker/pool。
//  我们不直接 mock helpers(它们是 named export 不能 monkey-patch),
//  而是构造一个 docker + pool 让 helpers 走真实路径返回我们想要的态。
//
//  这套 fake 就是 v3Supervisor.test.ts 里 FakePool/makeDocker 的简化版。
// ───────────────────────────────────────────────────────────────────────

type FakeRow = {
  id: number;
  user_id: number;
  host_uuid: string | null;
  bound_ip: string;
  secret_hash: Buffer;
  state: "active" | "vanished";
  port: number;
  container_internal_id: string | null;
  last_ws_activity: Date;
  created_at: Date;
  updated_at: Date;
};

class FakePool {
  rows: FakeRow[] = [];
  nextId = 1;
  insertCount = 0;
  /** test 钩子:第 N 次 INSERT 强制 23505 */
  forceUniqConflictOnInserts = new Set<number>();

  preInsertActive(uid: number, boundIp: string, dockerId: string | null = "dockerid-pre"): FakeRow {
    const now = new Date();
    const row: FakeRow = {
      id: this.nextId++,
      user_id: uid,
      host_uuid: null,
      bound_ip: boundIp,
      secret_hash: Buffer.alloc(32, 0xaa),
      state: "active",
      port: V3_CONTAINER_PORT,
      container_internal_id: dockerId,
      last_ws_activity: now,
      created_at: now,
      updated_at: now,
    };
    this.rows.push(row);
    return row;
  }

  async connect(): Promise<PoolClient> {
    const self = this;
    const client = {
      async query(sql: string, params?: unknown[]): Promise<unknown> {
        return await self.runQuery(sql, params);
      },
      release() {
        /* noop */
      },
    } as unknown as PoolClient;
    return client;
  }

  async query(sql: string, params?: unknown[]): Promise<unknown> {
    return await this.runQuery(sql, params);
  }

  end(): Promise<void> {
    return Promise.resolve();
  }

  private async runQuery(sql: string, params?: unknown[]): Promise<unknown> {
    const trimmed = String(sql).trim();
    if (/^BEGIN/i.test(trimmed)) return { rowCount: 0, rows: [] };
    if (/^COMMIT/i.test(trimmed)) return { rowCount: 0, rows: [] };
    if (/^ROLLBACK/i.test(trimmed)) return { rowCount: 0, rows: [] };
    // codex round 1 FAIL #2/#3 修复 — provision 在 BEGIN 后取双锁
    if (/^SELECT pg_advisory_xact_lock/i.test(trimmed)) return { rowCount: 0, rows: [] };
    if (/INSERT INTO agent_containers/i.test(trimmed)) {
      const idx = this.insertCount++;
      if (this.forceUniqConflictOnInserts.has(idx)) {
        const e = new Error("uniq conflict") as Error & { code: string; constraint: string };
        e.code = "23505";
        e.constraint = "uniq_ac_bound_ip_active";
        throw e;
      }
      const userId = Number.parseInt(String(params![0]), 10);
      const hostUuid = params![1] == null ? null : String(params![1]);
      const boundIp = String(params![2]);
      const secretHash = params![3] as Buffer;
      const port = Number(params![4]);
      if (this.rows.some((r) => r.state === "active" && r.bound_ip === boundIp)) {
        const e = new Error("uniq conflict") as Error & { code: string; constraint: string };
        e.code = "23505";
        e.constraint = "uniq_ac_bound_ip_active";
        throw e;
      }
      const id = this.nextId++;
      const now = new Date();
      this.rows.push({
        id,
        user_id: userId,
        host_uuid: hostUuid,
        bound_ip: boundIp,
        secret_hash: secretHash,
        state: "active",
        port,
        container_internal_id: null,
        last_ws_activity: now,
        created_at: now,
        updated_at: now,
      });
      return { rowCount: 1, rows: [{ id: String(id) }] };
    }
    if (/UPDATE agent_containers/i.test(trimmed) && /SET container_internal_id/i.test(trimmed)) {
      const id = Number.parseInt(String(params![0]), 10);
      const cid = String(params![1]);
      const r = this.rows.find((x) => x.id === id);
      if (r) {
        r.container_internal_id = cid;
        r.updated_at = new Date();
      }
      return { rowCount: r ? 1 : 0, rows: [] };
    }
    if (/UPDATE agent_containers/i.test(trimmed) && /SET state='vanished'/i.test(trimmed)) {
      const id = Number.parseInt(String(params![0]), 10);
      const r = this.rows.find((x) => x.id === id);
      if (r) {
        r.state = "vanished";
        r.updated_at = new Date();
      }
      return { rowCount: r ? 1 : 0, rows: [] };
    }
    if (/SELECT id, user_id,\s*host\(bound_ip\)/i.test(trimmed) && /WHERE user_id/i.test(trimmed)) {
      const userId = Number.parseInt(String(params![0]), 10);
      const r = this.rows.find((x) => x.user_id === userId && x.state === "active");
      if (!r) return { rowCount: 0, rows: [] };
      return {
        rowCount: 1,
        rows: [{
          id: String(r.id),
          user_id: String(r.user_id),
          bound_ip: r.bound_ip,
          port: r.port,
          container_internal_id: r.container_internal_id,
          host_uuid: r.host_uuid,
        }],
      };
    }
    // V3 Phase 3I — provision 内部 active count cap query
    if (/SELECT COUNT\(\*\)::text AS active/i.test(trimmed) && /state = 'active'/i.test(trimmed)) {
      const active = this.rows.filter((x) => x.state === "active").length;
      return { rowCount: 1, rows: [{ active: String(active) }] };
    }
    throw new Error(`FakePool: unhandled SQL: ${trimmed.slice(0, 200)}`);
  }
}

type DockerBehavior = {
  /** docker.getContainer(id).inspect() 行为:running/stopped/missing */
  inspectState?: "running" | "stopped" | "missing";
  /** 第 N 个 createContainer 抛(模拟 image missing) */
  createContainerThrow?: Error;
};

type DockerCaptured = {
  containersCreated: number;
  started: number;
  stopped: number;
  removed: number;
};

function httpError(code: number, msg: string): Error {
  const e = new Error(msg) as Error & { statusCode: number };
  e.statusCode = code;
  return e;
}

function makeDocker(behavior: DockerBehavior = {}): { docker: Docker; captured: DockerCaptured } {
  const captured: DockerCaptured = {
    containersCreated: 0,
    started: 0,
    stopped: 0,
    removed: 0,
  };
  const docker = {
    createVolume: async () => ({}),
    getVolume: (name: string) => ({
      inspect: async () => ({
        Name: name,
        Driver: "local",
        Labels: {
          "com.openclaude.v3.managed": "1",
          "com.openclaude.v3.uid": name.replace(/^oc-v3-(data|proj)-u/, ""),
        },
      }),
      remove: async () => { /* noop */ },
    }),
    createContainer: async () => {
      if (behavior.createContainerThrow) throw behavior.createContainerThrow;
      captured.containersCreated++;
      const id = `dockerid-new-${captured.containersCreated}`;
      return {
        id,
        start: async () => {
          captured.started++;
        },
        remove: async () => {
          captured.removed++;
        },
      };
    },
    getContainer: (_id: string) => ({
      inspect: async () => {
        if (behavior.inspectState === "missing") throw httpError(404, "no such");
        return {
          Id: _id,
          State: { Running: behavior.inspectState !== "stopped", Status: behavior.inspectState ?? "running" },
        };
      },
      stop: async () => {
        captured.stopped++;
      },
      remove: async () => {
        captured.removed++;
      },
    }),
  } as unknown as Docker;
  return { docker, captured };
}

function makeDeps(
  docker: Docker,
  pool: Pool,
  overrides: Partial<V3SupervisorDeps> = {},
): V3SupervisorDeps {
  return {
    docker,
    pool,
    image: "openclaude/openclaude-runtime:test",
    randomIp: () => "172.30.5.42",
    randomSecret: () => "a".repeat(64),
    ...overrides,
  };
}

const noSleep = async (_ms: number) => Promise.resolve();
const fixedNow = () => 1_000_000;

// ───────────────────────────────────────────────────────────────────────
//  Tests
// ───────────────────────────────────────────────────────────────────────

describe("makeV3EnsureRunning", () => {
  // 基线 fail-closed 默认启用;ensureRunning 走 provision 路径的用例不关心基线内容,
  // 设 OC_V3_CCB_BASELINE_OPTIONAL=1 降级为 warn+skip,避免 CcbBaselineMissing。
  // 对齐 v3Supervisor.test.ts provisionV3Container 测试的既有模式。
  let prevOptional: string | undefined;
  before(() => {
    prevOptional = process.env.OC_V3_CCB_BASELINE_OPTIONAL;
    process.env.OC_V3_CCB_BASELINE_OPTIONAL = "1";
  });
  after(() => {
    if (prevOptional === undefined) delete process.env.OC_V3_CCB_BASELINE_OPTIONAL;
    else process.env.OC_V3_CCB_BASELINE_OPTIONAL = prevOptional;
  });

  test("active + running + healthz ok → 返 {host, port}", async () => {
    const pool = new FakePool();
    pool.preInsertActive(7, "172.30.1.1", "dockerid-pre-7");
    const { docker } = makeDocker({ inspectState: "running" });
    const ensureRunning = makeV3EnsureRunning(makeDeps(docker, pool as unknown as Pool), {
      probeHealthz: async () => true,
      probeWsUpgrade: async () => true,
      sleep: noSleep,
      now: fixedNow,
    });

    const ep = await ensureRunning(7n);
    assert.deepStrictEqual(ep, { host: "172.30.1.1", port: V3_CONTAINER_PORT });
  });

  test("active + running + healthz 一直返 false → ContainerUnreadyError('starting')", async () => {
    const pool = new FakePool();
    pool.preInsertActive(8, "172.30.1.2", "dockerid-pre-8");
    const { docker } = makeDocker({ inspectState: "running" });
    let nowVal = 1_000_000;
    const ensureRunning = makeV3EnsureRunning(makeDeps(docker, pool as unknown as Pool), {
      probeHealthz: async () => false,
      probeWsUpgrade: async () => false,
      sleep: async (ms) => { nowVal += ms; },
      now: () => nowVal,
      healthzTimeoutMs: 1000,
      healthzIntervalMs: 100,
    });

    await assert.rejects(ensureRunning(8n), (err) => {
      assert.ok(err instanceof ContainerUnreadyError);
      assert.strictEqual(err.reason, "starting");
      assert.strictEqual(err.retryAfterSec, ENSURE_RUNNING_DEFAULTS.RETRY_AFTER_PROVISIONING_SEC);
      return true;
    });
  });

  test("active + stopped → ContainerUnreadyError('stopped', retryAfter=3)", async () => {
    const pool = new FakePool();
    pool.preInsertActive(9, "172.30.1.3", "dockerid-pre-9");
    const { docker, captured } = makeDocker({ inspectState: "stopped" });
    const ensureRunning = makeV3EnsureRunning(makeDeps(docker, pool as unknown as Pool), {
      probeHealthz: async () => true,  // 不应被调到
      sleep: noSleep,
      now: fixedNow,
    });

    await assert.rejects(ensureRunning(9n), (err) => {
      assert.ok(err instanceof ContainerUnreadyError);
      assert.strictEqual(err.reason, "stopped");
      assert.strictEqual(err.retryAfterSec, ENSURE_RUNNING_DEFAULTS.RETRY_AFTER_STOPPED_SEC);
      return true;
    });
    // MVP 不主动 start 已 stopped 的容器
    assert.strictEqual(captured.started, 0);
    assert.strictEqual(captured.containersCreated, 0);
  });

  test("active + missing → stopAndRemove(标 vanished) + provision 新容器 + ok", async () => {
    const pool = new FakePool();
    pool.preInsertActive(10, "172.30.1.4", "dockerid-pre-10");
    const { docker, captured } = makeDocker({ inspectState: "missing" });
    const ensureRunning = makeV3EnsureRunning(makeDeps(docker, pool as unknown as Pool), {
      probeHealthz: async () => true,
      probeWsUpgrade: async () => true,
      sleep: noSleep,
      now: fixedNow,
    });

    const ep = await ensureRunning(10n);
    assert.strictEqual(ep.host, "172.30.5.42");  // randomIp 注入值
    assert.strictEqual(ep.port, V3_CONTAINER_PORT);
    // 老行已 vanished
    const oldRow = pool.rows.find((r) => r.id === 1);
    assert.strictEqual(oldRow?.state, "vanished");
    // 新行已 active
    const newRow = pool.rows.find((r) => r.id === 2);
    assert.strictEqual(newRow?.state, "active");
    assert.strictEqual(newRow?.user_id, 10);
    assert.strictEqual(newRow?.bound_ip, "172.30.5.42");
    // docker create + start 各一次
    assert.strictEqual(captured.containersCreated, 1);
    assert.strictEqual(captured.started, 1);
  });

  test("无 active 行 → 走 provision 路径,成功后返新容器 endpoint", async () => {
    const pool = new FakePool();
    const { docker, captured } = makeDocker();
    const ensureRunning = makeV3EnsureRunning(makeDeps(docker, pool as unknown as Pool), {
      probeHealthz: async () => true,
      probeWsUpgrade: async () => true,
      sleep: noSleep,
      now: fixedNow,
    });

    const ep = await ensureRunning(11n);
    assert.deepStrictEqual(ep, { host: "172.30.5.42", port: V3_CONTAINER_PORT });
    assert.strictEqual(captured.containersCreated, 1);
    assert.strictEqual(captured.started, 1);
    assert.strictEqual(pool.rows.length, 1);
    assert.strictEqual(pool.rows[0]!.state, "active");
    assert.strictEqual(pool.rows[0]!.container_internal_id, "dockerid-new-1");
  });

  test("provision 失败(image missing)→ ContainerUnreadyError('image_missing', 300s)", async () => {
    // codex round 1 FAIL #4 修复 — ImageNotFound 是部署级故障(镜像没拉/打错 tag),
    // 5s 重试只会风暴,翻译成 retryAfter=300s + reason='image_missing' 给前端长退避。
    const pool = new FakePool();
    const { docker } = makeDocker({
      createContainerThrow: httpError(404, "No such image: openclaude/openclaude-runtime:test"),
    });
    const ensureRunning = makeV3EnsureRunning(makeDeps(docker, pool as unknown as Pool), {
      probeHealthz: async () => true,
      probeWsUpgrade: async () => true,
      sleep: noSleep,
      now: fixedNow,
    });

    await assert.rejects(ensureRunning(12n), (err) => {
      assert.ok(err instanceof ContainerUnreadyError);
      assert.strictEqual(err.reason, "image_missing");
      assert.strictEqual(err.retryAfterSec, 300);
      return true;
    });
  });

  test("provision 失败(其他错)→ ContainerUnreadyError('provisioning', 5s)", async () => {
    // 非 ImageNotFound 类型故障(docker daemon timeout / network) 仍走 5s 短退避。
    const pool = new FakePool();
    const { docker } = makeDocker({
      createContainerThrow: httpError(500, "docker daemon timeout"),
    });
    const ensureRunning = makeV3EnsureRunning(makeDeps(docker, pool as unknown as Pool), {
      probeHealthz: async () => true,
      probeWsUpgrade: async () => true,
      sleep: noSleep,
      now: fixedNow,
    });

    await assert.rejects(ensureRunning(112n), (err) => {
      assert.ok(err instanceof ContainerUnreadyError);
      assert.strictEqual(err.reason, "provisioning");
      assert.strictEqual(err.retryAfterSec, 5);
      return true;
    });
  });

  test("无 active 行 + provision 后 healthz timeout → ContainerUnreadyError('starting')", async () => {
    const pool = new FakePool();
    const { docker } = makeDocker();
    let nowVal = 1_000_000;
    const ensureRunning = makeV3EnsureRunning(makeDeps(docker, pool as unknown as Pool), {
      probeHealthz: async () => false,
      probeWsUpgrade: async () => false,
      sleep: async (ms) => { nowVal += ms; },
      now: () => nowVal,
      healthzTimeoutMs: 500,
      healthzIntervalMs: 100,
    });

    await assert.rejects(ensureRunning(13n), (err) => {
      assert.ok(err instanceof ContainerUnreadyError);
      assert.strictEqual(err.reason, "starting");
      return true;
    });
    // 注意:虽然 healthz timeout,但容器已经 provisioned;3F idle sweep 会清,
    // 用户下次重连 ensureRunning 看到 status='running' 再探活
    assert.strictEqual(pool.rows.length, 1);
    assert.strictEqual(pool.rows[0]!.state, "active");
  });

  test("getV3ContainerStatus 抛(DB 错)→ ContainerUnreadyError('supervisor_error')", async () => {
    // 用一个会让 SELECT 抛的 pool
    const brokenPool = {
      connect: async () => ({
        query: async () => { throw new Error("PG down"); },
        release: () => { /* */ },
      }),
      query: async () => { throw new Error("PG down"); },
      end: async () => { /* */ },
    } as unknown as Pool;
    const { docker } = makeDocker();
    const ensureRunning = makeV3EnsureRunning(makeDeps(docker, brokenPool), {
      probeHealthz: async () => true,
      probeWsUpgrade: async () => true,
      sleep: noSleep,
      now: fixedNow,
    });

    await assert.rejects(ensureRunning(14n), (err) => {
      assert.ok(err instanceof ContainerUnreadyError);
      assert.strictEqual(err.reason, "supervisor_error");
      return true;
    });
  });

  test("uid <= 0 → ContainerUnreadyError('invalid_uid')", async () => {
    const pool = new FakePool();
    const { docker } = makeDocker();
    const ensureRunning = makeV3EnsureRunning(makeDeps(docker, pool as unknown as Pool));

    await assert.rejects(ensureRunning(0n), (err) => {
      assert.ok(err instanceof ContainerUnreadyError);
      assert.strictEqual(err.reason, "invalid_uid");
      return true;
    });
  });

  test("uid > 2^53 → ContainerUnreadyError('invalid_uid')", async () => {
    const pool = new FakePool();
    const { docker } = makeDocker();
    const ensureRunning = makeV3EnsureRunning(makeDeps(docker, pool as unknown as Pool));

    const huge = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    await assert.rejects(ensureRunning(huge), (err) => {
      assert.ok(err instanceof ContainerUnreadyError);
      assert.strictEqual(err.reason, "invalid_uid");
      return true;
    });
  });

  test("默认 HTTP probe 命中真 200(WS probe stub 返 true)→ ready", async () => {
    // 起一个本机 server,默认 probeHealthz 走 http.request 探它;WS probe 用 stub
    // (3E 已经独立测过 WS upgrade probe 实现,这里只验证 HTTP 默认实现接到 ensureRunning)
    const server: Server = createServer((req, res) => {
      if (req.url === "/healthz") {
        res.statusCode = 200;
        res.end("ok");
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;

    const pool = new FakePool();
    pool.preInsertActive(15, "127.0.0.1", "dockerid-pre-15");
    const { docker } = makeDocker({ inspectState: "running" });
    const ensureRunning = makeV3EnsureRunning(makeDeps(docker, pool as unknown as Pool), {
      probeWsUpgrade: async () => true,
      sleep: noSleep,
      now: fixedNow,
    });

    pool.rows[0]!.port = port;
    try {
      const ep = await ensureRunning(15n);
      assert.deepStrictEqual(ep, { host: "127.0.0.1", port });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test("默认 HTTP probe 命中真 500 → 不 ready,继续轮询直到 timeout", async () => {
    const server: Server = createServer((_req, res) => {
      res.statusCode = 500;
      res.end("nope");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;

    const pool = new FakePool();
    pool.preInsertActive(16, "127.0.0.1", "dockerid-pre-16");
    const { docker } = makeDocker({ inspectState: "running" });
    let nowVal = 1_000_000;
    const ensureRunning = makeV3EnsureRunning(makeDeps(docker, pool as unknown as Pool), {
      probeWsUpgrade: async () => true,  // WS 即使 ok 也救不了 HTTP 500
      sleep: async (ms) => { nowVal += ms; },
      now: () => nowVal,
      healthzTimeoutMs: 300,
      healthzIntervalMs: 100,
      healthzProbeMs: 200,
    });
    pool.rows[0]!.port = port;

    try {
      await assert.rejects(ensureRunning(16n), (err) => {
        assert.ok(err instanceof ContainerUnreadyError);
        assert.strictEqual(err.reason, "starting");
        return true;
      });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test("HTTP ok 但 WS upgrade 一直失败 → 不 ready (3E 双过语义)", async () => {
    const pool = new FakePool();
    pool.preInsertActive(17, "172.30.1.7", "dockerid-pre-17");
    const { docker } = makeDocker({ inspectState: "running" });
    let nowVal = 1_000_000;
    const ensureRunning = makeV3EnsureRunning(makeDeps(docker, pool as unknown as Pool), {
      probeHealthz: async () => true,
      probeWsUpgrade: async () => false,
      sleep: async (ms) => { nowVal += ms; },
      now: () => nowVal,
      healthzTimeoutMs: 500,
      healthzIntervalMs: 100,
    });

    await assert.rejects(ensureRunning(17n), (err) => {
      assert.ok(err instanceof ContainerUnreadyError);
      assert.strictEqual(err.reason, "starting");
      return true;
    });
  });

  // V3 Phase 3I: provision 撞 cap → SupervisorError("HostFull") 必须翻成
  // ContainerUnreadyError("host_full", retryAfter=10),前端按 retryAfter 提示"系统繁忙"。
  test("provision 时 host 满 cap → ContainerUnreadyError('host_full', retryAfter=10)", async () => {
    const pool = new FakePool();
    // 塞满 maxRunningContainers=2,uid=18 没有 active 行 → 走 provision → cap 拒
    pool.preInsertActive(101, "172.30.1.101", "dockerid-101");
    pool.preInsertActive(102, "172.30.1.102", "dockerid-102");
    const { docker, captured } = makeDocker();
    const deps = makeDeps(docker, pool as unknown as Pool, {
      maxRunningContainers: 2,
    });
    const ensureRunning = makeV3EnsureRunning(deps, {
      probeHealthz: async () => true,
      probeWsUpgrade: async () => true,
      sleep: noSleep,
      now: fixedNow,
    });

    await assert.rejects(ensureRunning(18n), (err) => {
      assert.ok(err instanceof ContainerUnreadyError);
      assert.strictEqual(err.reason, "host_full");
      assert.strictEqual(err.retryAfterSec, ENSURE_RUNNING_DEFAULTS.RETRY_AFTER_HOST_FULL_SEC);
      return true;
    });
    // cap 在事务前直接拒 → 不 createContainer / 不 start
    assert.strictEqual(captured.containersCreated, 0);
    assert.strictEqual(captured.started, 0);
  });

  // V1.0.53 — buildReadinessOpts 不再 eager 填 timeoutMs(留给 waitContainerReady
  // 按 endpoint kind 选 self 10s / remote 25s)。这条测试守门:谁要把 eager
  // default 加回来,这里会先 fail,免得 remote 默认 25s 又退化回 10s。
  describe("buildReadinessOpts (lazy timeout regression guard)", () => {
    test("不传 healthzTimeoutMs → out.timeoutMs 必须 undefined(留给 waitContainerReady 按 endpoint 决策)", () => {
      const out = buildReadinessOpts({});
      assert.strictEqual(out.timeoutMs, undefined,
        "如果这里不是 undefined,说明谁在 buildReadinessOpts 里 eager 填了 default — 会让 remote 退回 10s");
    });

    test("显式传 healthzTimeoutMs → 透传到 out.timeoutMs", () => {
      const out = buildReadinessOpts({ healthzTimeoutMs: 12_345 });
      assert.strictEqual(out.timeoutMs, 12_345);
    });

    test("interval / probe 单次超时 仍 eager 填 default(只有总 timeout 改 lazy)", () => {
      const out = buildReadinessOpts({});
      assert.strictEqual(out.intervalMs, ENSURE_RUNNING_DEFAULTS.HEALTHZ_INTERVAL_MS);
      assert.strictEqual(out.httpProbeMs, ENSURE_RUNNING_DEFAULTS.HEALTHZ_PROBE_MS);
      assert.strictEqual(out.wsProbeMs, ENSURE_RUNNING_DEFAULTS.WS_PROBE_MS);
    });
  });
});
