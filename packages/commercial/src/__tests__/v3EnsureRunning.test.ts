/**
 * V3 Phase 3D — agent-sandbox/v3ensureRunning.ts 单测。
 *
 * 覆盖:
 *   - active+running+healthz ok → 返 {host, port}
 *   - active+running+healthz timeout → ContainerUnreadyError("starting")
 *   - active+stopped → stopAndRemove + provision + waitHealthz → 成功(v1.0.117)
 *   - active+stopped + stopAndRemove 失败 → ContainerUnreadyError("supervisor_error")
 *   - active + provisioning(cid=NULL, age<grace)→ ContainerUnreadyError("provisioning") 短重试等待
 *     (不 stopAndRemove、不销毁在途/孤儿行;单一 singleflight 统一后 = 孤儿有界自愈缓冲)
 *   - active + missing(cid=NULL, age>=grace)→ stopAndRemove 翻 vanished + reprovision 自愈
 *   - active+missing → stopAndRemove + provision + waitHealthz → 成功
 *   - 并发 ensureRunning 输家保护(uniq_ac_user_id_active)留 integ 覆盖(FakePool 当前只模拟 bound_ip uniq)
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
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type Docker from "dockerode";
import type { Pool, PoolClient } from "pg";

import {
  makeV3EnsureRunning,
  ENSURE_RUNNING_DEFAULTS,
  buildReadinessOpts,
  requestRuntimeRecycleDrain,
} from "../agent-sandbox/v3ensureRunning.js";
import { ContainerUnreadyError } from "../ws/userChatBridge.js";
import {
  V3_CONTAINER_PORT,
  type V3SupervisorDeps,
  type V3ContainerStatus,
} from "../agent-sandbox/v3supervisor.js";
import { computeInboundNonce } from "../bridgeSecret.js";
import type { TunnelDialOptions } from "../compute-pool/nodeAgentClient.js";
import { resetPool, setPoolOverride } from "../db/index.js";

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
  last_ws_activity: Date | null;
  created_at: Date;
  updated_at: Date;
};

/** v3MayServe 读的 users 迁移状态行(channelMigration/channelState.getChannelState)。 */
type FakeChannelRow = {
  v5_migrated_at: Date | null;
  v5_migration_status: "seeding" | "migrating" | "migrated" | "rolled_back" | null;
};

/** 当前活跃 FakePool —— 构造即登记,供 globalPoolDelegate 转发(见文件下方注释)。 */
let activeFakePool: FakePool | null = null;

class FakePool {
  rows: FakeRow[] = [];
  nextId = 1;
  insertCount = 0;
  /**
   * v3→v5 迁移门控 fixture:provisionV3Container 在 v3 channel 下先调 v3MayServe(uid),
   * 它读 **全局** getPool()(不是 deps.pool)。缺省 = 未迁移 → 放行。
   */
  channelRows: Map<string, FakeChannelRow> = new Map();
  setChannelState(uid: number | string, row: FakeChannelRow): void {
    this.channelRows.set(String(uid), row);
  }

  constructor() {
    activeFakePool = this;
  }
  /** test 钩子:第 N 次 INSERT 强制 23505 */
  forceUniqConflictOnInserts = new Set<number>();
  /**
   * V3 Phase 3I per-host cap:模拟 compute_hosts.max_containers。
   * `setHostMax(uuid, null)` 显式模拟 "compute_hosts 行 missing"。
   * 未配置 host_uuid → DEFAULT_TEST_HOST_MAX = 999(单测默认不踩 cap)。
   */
  hostMax: Map<string, number | null> = new Map();
  setHostMax(hostUuid: string, max: number | null): void {
    this.hostMax.set(hostUuid, max);
  }

  preInsertActive(
    uid: number,
    boundIp: string,
    dockerId: string | null = "dockerid-pre",
    hostUuid: string = TEST_HOST,
  ): FakeRow {
    const now = new Date();
    const row: FakeRow = {
      id: this.nextId++,
      user_id: uid,
      host_uuid: hostUuid,
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
    if (/^(SAVEPOINT|ROLLBACK TO SAVEPOINT|RELEASE SAVEPOINT) oc_v3_ip_alloc_attempt$/i.test(trimmed)) {
      return { rowCount: 0, rows: [] };
    }
    if (/^BEGIN/i.test(trimmed)) return { rowCount: 0, rows: [] };
    if (/^COMMIT/i.test(trimmed)) return { rowCount: 0, rows: [] };
    if (/^ROLLBACK/i.test(trimmed)) return { rowCount: 0, rows: [] };
    // codex round 1 FAIL #2/#3 修复 — provision 在 BEGIN 后取双锁
    if (/^SELECT pg_advisory_xact_lock/i.test(trimmed)) return { rowCount: 0, rows: [] };
    // v3→v5 迁移门控读 users(channelState.getChannelState),走全局 pool 转发进来。
    if (/SELECT v5_migrated_at, v5_migration_status\s+FROM users/i.test(trimmed)) {
      const uid = String(params![0]);
      const row = this.channelRows.get(uid) ?? {
        v5_migrated_at: null,
        v5_migration_status: null,
      };
      return { rowCount: 1, rows: [row] };
    }
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
    // Phase 2.B INV-3 findOpenByUser SELECT — FakePool 不建模 agent_migrations 表,
    // 默认返 0 行(等价"无 open migration"),所有现有 ensureRunning unit 测继续走
    // 正常路径不被 INV-3 拦。真测在 v3EnsureRunningMigrationGuard.test.ts(PG fixture)。
    if (
      /SELECT m\.id, m\.phase/i.test(trimmed)
      && /FROM agent_containers c/i.test(trimmed)
      && /JOIN agent_migrations m/i.test(trimmed)
    ) {
      return { rowCount: 0, rows: [] };
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
          last_ws_activity: r.last_ws_activity,
          // getV3ContainerStatus 的 cid=NULL 分支按 created_at 二分 provisioning/missing。
          // 缺此列 → new Date(undefined) → NaN age → 恒 missing(旧测试的隐性 bug)。
          created_at: r.created_at,
        }],
      };
    }
    // provision 锁内幂等复查(并发 ensure 双请求):同 uid 已有 active 行 → NameConflict。
    if (
      /SELECT id::text AS id FROM agent_containers/i.test(trimmed)
      && /state = 'active' AND runtime_channel/i.test(trimmed)
    ) {
      const userId = Number.parseInt(String(params![0]), 10);
      const r = this.rows.find((x) => x.user_id === userId && x.state === "active");
      return r ? { rowCount: 1, rows: [{ id: String(r.id) }] } : { rowCount: 0, rows: [] };
    }
    // V3 Phase 3I — per-host admission gate(provisionV3Container 内事务):
    //   SELECT (SELECT COUNT(*) ... WHERE state='active' AND host_uuid=$1)::text AS active,
    //          (SELECT max_containers FROM compute_hosts WHERE id=$1) AS max_containers
    if (
      /SELECT COUNT\(\*\) FROM agent_containers/i.test(trimmed)
      && /AS active/i.test(trimmed)
      && /max_containers FROM compute_hosts/i.test(trimmed)
    ) {
      const hostUuid = String(params![0]);
      const active = this.rows.filter(
        (x) => x.state === "active" && x.host_uuid === hostUuid,
      ).length;
      const max = this.hostMax.has(hostUuid)
        ? this.hostMax.get(hostUuid)
        : DEFAULT_TEST_HOST_MAX;
      return {
        rowCount: 1,
        rows: [{ active: String(active), max_containers: max }],
      };
    }
    throw new Error(`FakePool: unhandled SQL: ${trimmed.slice(0, 200)}`);
  }
}

// ───────────────────────────────────────────────────────────────────────
//  全局 pool 委派(v3MayServe 门控用)—— 与 v3Supervisor.test.ts 同手法
// ───────────────────────────────────────────────────────────────────────
//
// ensureRunning 的 provision 分支最终调 provisionV3Container,它在 v3 channel 下
// 先跑 v3→v5 迁移门控 v3MayServe(uid) → db/index.ts 的**全局** getPool()。
// 单测进程没有 DATABASE_URL/REDIS_URL,全局 getPool() 会 loadConfig() 抛 ConfigError,
// 被 ensureRunning 的 catch-all 吞成 ContainerUnreadyError("provisioning"),于是
// 所有走 provision 的分支(image_missing / image_outdated / host_full / 滚动回收 …)
// 断言全部落到 'provisioning',整个 makeV3EnsureRunning 套件长期躺在
// .github/known-failures/commercial-unit.txt 里 —— 等于"开会话→建容器"主路径无门禁。
//
// 把全局 pool 指向当前 FakePool:门控真跑(默认放行),新增用例零接线。
const globalPoolDelegate = {
  query(sql: string, params?: unknown[]): Promise<unknown> {
    if (!activeFakePool) {
      return Promise.reject(new Error("global pool used before any FakePool was constructed"));
    }
    return activeFakePool.query(sql, params);
  },
  connect(): Promise<PoolClient> {
    if (!activeFakePool) {
      return Promise.reject(new Error("global pool used before any FakePool was constructed"));
    }
    return activeFakePool.connect();
  },
  end(): Promise<void> {
    return Promise.resolve();
  },
} as unknown as Pool;

before(async () => {
  // 先 resetPool:setPoolOverride 在"已有单例"时会抛(见 db/index.ts)。
  await resetPool();
  setPoolOverride(globalPoolDelegate);
});

after(async () => {
  activeFakePool = null;
  await resetPool();
});

type DockerBehavior = {
  /** docker.getContainer(id).inspect() 行为:running/stopped/missing */
  inspectState?: "running" | "stopped" | "missing";
  /** 运行容器的 Config.Image(默认匹配 deps.image → 不触发镜像回收)。 */
  containerImage?: string;
  /** 第 N 个 createContainer 抛(模拟 image missing) */
  createContainerThrow?: Error;
  /**
   * v1.0.84 PR #4 image guard:控制 `docker.getImage(tag).inspect()` 返回。
   *   - undefined(默认)→ labels 含 `v3-sink` token,guard 透传
   *   - {kind:"labels", labels} → 自定义 labels(放进 Config.Labels)
   *   - {kind:"missing"}        → 抛 statusCode=404(image absent → guard 放行)
   */
  imageInspect?:
    | { kind: "labels"; labels: Record<string, string> }
    | { kind: "missing" };
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
          "com.openclaude.v3.uid": name.replace(/^oc-v3-(data|proj|codex|userlocal|userconfig)-u/, ""),
        },
      }),
      remove: async () => { /* noop */ },
    }),
    // v1.0.84 PR #4 image guard:provisionV3Container 早于 BEGIN 调
    // `docker.getImage(image).inspect()` 校验 oc.runtime.features=v3-sink。
    // 默认 labels 含 v3-sink → 现有 ensureRunning 测试零修改穿透 guard。
    getImage: (tag: string) => ({
      inspect: async () => {
        const beh = behavior.imageInspect;
        if (beh?.kind === "missing") throw httpError(404, "No such image");
        const labels =
          beh?.kind === "labels"
            ? beh.labels
            : { "oc.runtime.features": "file-proxy-v1 v3-sink" };
        return {
          Id: "sha256:fakeimage",
          RepoTags: [tag],
          Config: { Labels: labels },
        };
      },
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
          Config: { Image: behavior.containerImage ?? "openclaude/openclaude-runtime:test" },
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

// V3 Phase 3I per-host cap:provisionV3Container 现在强制 effectiveHostUuid
// (hostId || deps.selfHostId)非空且 canonical UUID,所以测试 deps 必须给
// selfHostId。FakePool 默认对此 host 应用 DEFAULT_TEST_HOST_MAX=999(不踩 cap)。
const TEST_HOST = "11111111-1111-1111-1111-111111111111";
const DEFAULT_TEST_HOST_MAX = 999;

function makeDeps(
  docker: Docker,
  pool: Pool,
  overrides: Partial<V3SupervisorDeps> = {},
): V3SupervisorDeps {
  return {
    docker,
    pool,
    image: "openclaude/openclaude-runtime:test",
    selfHostId: TEST_HOST,
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

test("remote runtime drain 经 node-agent tunnel 保留 Docker path 与数值容器鉴权语义", async () => {
  const pool = new FakePool();
  const { docker } = makeDocker();
  const bridgeSecret = "remote-drain-secret";
  const deps = makeDeps(docker, pool as unknown as Pool, { bridgeSecret });
  const status = {
    containerId: 77,
    userId: 9,
    boundIp: "172.31.0.9",
    port: V3_CONTAINER_PORT,
    dockerContainerId: "docker-remote-77",
    state: "running",
    hostId: "22222222-2222-2222-2222-222222222222",
    lastWsActivity: new Date(),
  } satisfies V3ContainerStatus;

  for (const [httpCode, expected] of [
    [200, "accepted"],
    [409, "busy"],
    [503, "failed"],
  ] as const) {
    const psk = Buffer.from("a1b2c3d4", "hex");
    let destroyed = false;
    const capturedDialOptions: TunnelDialOptions[] = [];
    const socket = new EventEmitter() as EventEmitter & { destroy(): void };
    socket.destroy = () => { destroyed = true; };

    const result = await requestRuntimeRecycleDrain(deps, status, 100, {
      resolveTarget: async () => ({
        hostId: status.hostId,
        host: "remote.example",
        agentPort: 9443,
        expectedFingerprint: "aa".repeat(32),
        psk,
        requireFingerprint: true,
      }),
      dialTunnel: async (options) => {
        capturedDialOptions.push(options);
        setTimeout(() => socket.emit("data", Buffer.from(`HTTP/1.1 ${httpCode} Result\r\n`)), 0);
        return socket as never;
      },
    });

    const dialOptions = capturedDialOptions[0];
    assert.ok(dialOptions);
    assert.equal(result, expected);
    assert.equal(dialOptions.containerInternalId, "docker-remote-77");
    assert.equal(
      dialOptions.pathAndQuery,
      `/internal/v3/runtime-recycle-drain?port=${V3_CONTAINER_PORT}`,
    );
    assert.equal(dialOptions.headers?.["x-openclaude-container-id"], "77");
    assert.equal(
      dialOptions.headers?.["x-openclaude-inbound-nonce"],
      computeInboundNonce(bridgeSecret, 77),
    );
    assert.equal(destroyed, true);
    assert.ok(psk.every((byte) => byte === 0), "temporary node-agent PSK must be cleared");
  }
});

test("remote runtime drain 超时 fail-closed 且销毁 tunnel", async () => {
  const pool = new FakePool();
  const { docker } = makeDocker();
  const deps = makeDeps(docker, pool as unknown as Pool, { bridgeSecret: "secret" });
  const status = {
    containerId: 78,
    userId: 10,
    boundIp: "172.31.0.10",
    port: V3_CONTAINER_PORT,
    dockerContainerId: "docker-remote-78",
    state: "running",
    hostId: "33333333-3333-3333-3333-333333333333",
    lastWsActivity: null,
  } satisfies V3ContainerStatus;
  let destroyed = false;
  const socket = new EventEmitter() as EventEmitter & { destroy(): void };
  socket.destroy = () => { destroyed = true; };

  const result = await requestRuntimeRecycleDrain(deps, status, 5, {
    resolveTarget: async () => ({
      hostId: status.hostId,
      host: "remote.example",
      agentPort: 9443,
      expectedFingerprint: "bb".repeat(32),
      psk: Buffer.from("abcd", "hex"),
      requireFingerprint: true,
    }),
    dialTunnel: async () => socket as never,
  });

  assert.equal(result, "failed");
  assert.equal(destroyed, true);
});

test("remote runtime drain 的总预算覆盖悬停的 tunnel 建连", async () => {
  const pool = new FakePool();
  const { docker } = makeDocker();
  const deps = makeDeps(docker, pool as unknown as Pool, { bridgeSecret: "secret" });
  const status = {
    containerId: 79,
    userId: 11,
    boundIp: "172.31.0.11",
    port: V3_CONTAINER_PORT,
    dockerContainerId: "docker-remote-79",
    state: "running",
    hostId: "44444444-4444-4444-4444-444444444444",
    lastWsActivity: null,
  } satisfies V3ContainerStatus;
  const psk = Buffer.from("abcd", "hex");
  const startedAt = Date.now();

  const result = await requestRuntimeRecycleDrain(deps, status, 10, {
    resolveTarget: async () => ({
      hostId: status.hostId,
      host: "remote.example",
      agentPort: 9443,
      expectedFingerprint: "cc".repeat(32),
      psk,
      requireFingerprint: true,
    }),
    dialTunnel: () => new Promise<never>(() => {}),
  });

  assert.equal(result, "failed");
  assert.ok(Date.now() - startedAt < 250, "hung TLS dial must not consume its independent 10s timeout");
  assert.ok(psk.every((byte) => byte === 0), "timed-out node-agent PSK must be cleared");
});

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
    assert.deepStrictEqual(ep, {
      host: "172.30.1.1",
      port: V3_CONTAINER_PORT,
      containerId: 1,
      coldStart: false, // running 重用分支
    });
  });

  test("active + running 但镜像过期 → stopAndRemove + 用新镜像 provision(滚动回收)", async () => {
    const pool = new FakePool();
    pool.preInsertActive(11, "172.30.1.5", "dockerid-pre-11");
    // 运行容器镜像 = 旧 tag,与 deps.image(...:test)不符 → imageStale → 回收重建,而非 warm 复用。
    const { docker, captured } = makeDocker({
      inspectState: "running",
      containerImage: "openclaude/openclaude-runtime:v5-ccb-OLD",
    });
    const ensureRunning = makeV3EnsureRunning(makeDeps(docker, pool as unknown as Pool), {
      probeHealthz: async () => true,
      probeWsUpgrade: async () => true,
      sleep: noSleep,
      now: fixedNow,
    });

    const ep = await ensureRunning(11n);
    assert.strictEqual(ep.coldStart, true, "镜像过期应走 provision 重建,不是 warm 复用");
    assert.ok(captured.stopped >= 1 && captured.removed >= 1, "旧容器应被 stopAndRemove");
    assert.ok(captured.containersCreated >= 1, "应用新镜像 provision 新容器");
  });

  test("v5 stale image + 最近有 WS 活动但无在途 turn → drain accepted 后回收", async () => {
      const pool = new FakePool();
      const row = pool.preInsertActive(111, "172.31.1.11", "dockerid-pre-111");
      const now = 2_000_000;
      row.last_ws_activity = new Date(now - 29 * 60_000);
      const { docker, captured } = makeDocker({
        inspectState: "running",
        containerImage: "openclaude/openclaude-runtime:old",
      });
      let drainCalls = 0;
      const ensureRunning = makeV3EnsureRunning(makeDeps(docker, pool as unknown as Pool), {
        probeHealthz: async () => true,
        probeWsUpgrade: async () => true,
        now: () => now,
        runtimeChannelForTest: "v5",
        requestRuntimeRecycleDrain: async () => { drainCalls += 1; return "accepted"; },
      });
      // drain accepted → 与"tag 过期回收"同一条 fall-through:stopAndRemove 后立刻
      // 用新 image 重建并返回新 endpoint(coldStart=true)。
      // 本用例原先断言 rejects('provisioning') —— 那是夹具缺全局 pool 时 provision 恒
      // 抛 ConfigError 被 catch-all 吞掉的假象,等于"回收后没重建"也算过。改成断言真重建。
      const ep = await ensureRunning(111n);
      assert.equal(drainCalls, 1);
      assert.equal(ep.coldStart, true, "drain accepted → 回收旧容器并重建");
      assert.ok(captured.stopped >= 1, "旧容器应被 stop");
      assert.ok(captured.containersCreated >= 1, "必须用新镜像重建,不能只停不建");
  });

  test("v5 stale image + 最近有 WS 活动但仍有在途 turn → drain busy 后延期", async () => {
      const pool = new FakePool();
      const row = pool.preInsertActive(112, "172.31.1.12", "dockerid-pre-112");
      const now = 2_000_000;
      row.last_ws_activity = new Date(now - 60_000);
      const { docker, captured } = makeDocker({
        inspectState: "running",
        containerImage: "openclaude/openclaude-runtime:old",
      });
      let drainCalls = 0;
      const ensureRunning = makeV3EnsureRunning(makeDeps(docker, pool as unknown as Pool), {
        probeHealthz: async () => true,
        probeWsUpgrade: async () => true,
        now: () => now,
        runtimeChannelForTest: "v5",
        requestRuntimeRecycleDrain: async () => { drainCalls += 1; return "busy"; },
      });
      const ep = await ensureRunning(112n);
      assert.equal(ep.coldStart, false);
      assert.equal(drainCalls, 1);
      assert.equal(captured.stopped, 0);
  });

  test("v5 stale image + NULL 活动 + drain busy/failure → 延期", async () => {
      for (const result of ["busy", "failed"] as const) {
        const pool = new FakePool();
        const row = pool.preInsertActive(113, "172.31.1.13", "dockerid-pre-113");
        row.last_ws_activity = null;
        const { docker, captured } = makeDocker({
          inspectState: "running",
          containerImage: "openclaude/openclaude-runtime:old",
        });
        const ensureRunning = makeV3EnsureRunning(makeDeps(docker, pool as unknown as Pool), {
          probeHealthz: async () => true,
          probeWsUpgrade: async () => true,
          runtimeChannelForTest: "v5",
          requestRuntimeRecycleDrain: async () => result,
        });
        const ep = await ensureRunning(113n);
        assert.equal(ep.coldStart, false, result);
        assert.equal(captured.stopped, 0, result);
      }
  });

  test("v5 force stale recycle 绕过活动与 drain", async () => {
      const pool = new FakePool();
      pool.preInsertActive(114, "172.31.1.14", "dockerid-pre-114");
      const { docker, captured } = makeDocker({
        inspectState: "running",
        containerImage: "openclaude/openclaude-runtime:old",
      });
      let drainCalls = 0;
      const ensureRunning = makeV3EnsureRunning(makeDeps(docker, pool as unknown as Pool), {
        probeHealthz: async () => true,
        probeWsUpgrade: async () => true,
        runtimeChannelForTest: "v5",
        forceStaleImageRecycle: true,
        requestRuntimeRecycleDrain: async () => { drainCalls += 1; return "busy"; },
      });
      // force=true → 完全跳过 drain 直接回收重建(同上,原 rejects 断言是夹具假象)。
      const ep = await ensureRunning(114n);
      assert.equal(drainCalls, 0, "force 模式绝不询问 drain");
      assert.equal(ep.coldStart, true, "force 回收后必须重建");
      assert.ok(captured.stopped >= 1, "旧容器应被 stop");
      assert.ok(captured.containersCreated >= 1, "必须重建新容器");
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

  test("active + stopped(docker exited)→ stopAndRemove(标 vanished) + provision 新容器 + ok (v1.0.117)", async () => {
    // v1.0.117:stopped 与 missing 同走 stopAndRemove + reprovision 路径,
    // 消除原 ContainerUnreadyError("stopped") 死循环(boss 2026-05-09 实测被卡几分钟)。
    const pool = new FakePool();
    pool.preInsertActive(9, "172.30.1.3", "dockerid-pre-9");
    const { docker, captured } = makeDocker({ inspectState: "stopped" });
    const ensureRunning = makeV3EnsureRunning(makeDeps(docker, pool as unknown as Pool), {
      probeHealthz: async () => true,
      probeWsUpgrade: async () => true,
      sleep: noSleep,
      now: fixedNow,
    });

    const ep = await ensureRunning(9n);
    assert.strictEqual(ep.host, "172.30.5.42");  // randomIp 注入值(新分配)
    assert.strictEqual(ep.port, V3_CONTAINER_PORT);
    assert.strictEqual(ep.coldStart, true);  // 走 provision 分支
    // 老行已 vanished
    const oldRow = pool.rows.find((r) => r.id === 1);
    assert.strictEqual(oldRow?.state, "vanished");
    // 新行已 active
    const newRow = pool.rows.find((r) => r.id === 2);
    assert.strictEqual(newRow?.state, "active");
    assert.strictEqual(newRow?.user_id, 9);
    // docker create + start 各一次(新容器)
    assert.strictEqual(captured.containersCreated, 1);
    assert.strictEqual(captured.started, 1);
  });

  test("active + stopped + stopAndRemove(UPDATE)抛 → ContainerUnreadyError('supervisor_error')", async () => {
    // 与 missing 分支语义一致:stopAndRemoveV3Container 抛 → caller 短重试。
    const pool = new FakePool();
    pool.preInsertActive(91, "172.30.1.31", "dockerid-pre-91");
    const { docker, captured } = makeDocker({ inspectState: "stopped" });
    // 拦截 UPDATE state='vanished'(stopAndRemove 第一步)让它抛
    const origQuery = pool.query.bind(pool);
    pool.query = (async (sql: string, params?: unknown[]) => {
      if (typeof sql === "string" && /UPDATE agent_containers/i.test(sql) && /SET state='vanished'/i.test(sql)) {
        throw new Error("simulated DB outage during stopAndRemove");
      }
      return origQuery(sql, params);
    }) as typeof pool.query;
    const ensureRunning = makeV3EnsureRunning(makeDeps(docker, pool as unknown as Pool), {
      probeHealthz: async () => true,
      probeWsUpgrade: async () => true,
      sleep: noSleep,
      now: fixedNow,
    });

    await assert.rejects(ensureRunning(91n), (err) => {
      assert.ok(err instanceof ContainerUnreadyError);
      assert.strictEqual(err.reason, "supervisor_error");
      assert.strictEqual(err.retryAfterSec, ENSURE_RUNNING_DEFAULTS.RETRY_AFTER_PROVISIONING_SEC);
      return true;
    });
    // 没创建新容器 — provision 没机会跑
    assert.strictEqual(captured.containersCreated, 0);
  });

  // 注:并发 ensureRunning 输家保护(uniq_ac_user_id_active)依赖 PG 真索引,
  //     FakePool 当前只模拟 uniq_ac_bound_ip_active(走 retry-on-conflict 路径,
  //     不会冒出来给 ensureRunning),要专测 user_id 并发冲突需扩 FakePool。
  //     这条留 integ 测试覆盖,本文件不加(Codex 提的"建议补",非阻塞)。

  test("active + provisioning(young cid=NULL, age<15s)→ 等待短重试,不 stopAndRemove、不销毁在途行(Codex MAJOR 修复)", async () => {
    // saga 中段:并发 provision(尤其 makeUidSingleflight 覆盖不到的跨闭包 —— prewarm 独立闭包
    // vs WS 独立闭包)正在建容器,cid 尚未由 Tx2 落库。getV3ContainerStatus age<15s → 'provisioning'。
    // ensureRunning **必须等待**(短重试),**绝不** stopAndRemove —— 否则销毁在途容器 → 在途者
    // Tx2 rowCount=0 补偿 rm → 与同名 create 交错把前台打进 NameConflict。几秒后在途者 Tx2 落 cid
    // → 下轮 ensure 命中 running,零 churn 零 vanish。
    const pool = new FakePool();
    const row = pool.preInsertActive(92, "172.30.1.32", null); // cid=NULL,created_at=now → young
    const { docker, captured } = makeDocker({ inspectState: "running" });
    const ensureRunning = makeV3EnsureRunning(makeDeps(docker, pool as unknown as Pool), {
      probeHealthz: async () => true,
      probeWsUpgrade: async () => true,
      sleep: noSleep,
      now: fixedNow,
    });

    await assert.rejects(ensureRunning(92n), (err) => {
      assert.ok(err instanceof ContainerUnreadyError);
      assert.strictEqual(err.reason, "provisioning");
      return true;
    });
    // 关键:在途行未被销毁、无新容器创建、无 stop/remove docker 副作用。
    assert.strictEqual(row.state, "active", "在途 provisioning 行绝不能被翻 vanished");
    assert.strictEqual(captured.containersCreated, 0, "不得 stopAndRemove + 重建");
    assert.strictEqual(captured.stopped, 0);
    assert.strictEqual(captured.removed, 0);
  });

  test("active + missing(orphan cid=NULL, age>=15s)→ stopAndRemove 翻 vanished + reprovision 自愈(既有路径不回归)", async () => {
    // 真孤儿(进程崩溃留下,>15s):getV3ContainerStatus → 'missing'。既有自愈不回归:
    // stopAndRemove(对 NULL cid 提前 return,只翻 vanished 不动 docker)+ fall through provision 重建。
    const pool = new FakePool();
    const row = pool.preInsertActive(93, "172.30.1.33", null);
    row.created_at = new Date(Date.now() - 30_000); // age>=15s → missing
    const { docker, captured } = makeDocker({ inspectState: "running" });
    const ensureRunning = makeV3EnsureRunning(makeDeps(docker, pool as unknown as Pool), {
      probeHealthz: async () => true,
      probeWsUpgrade: async () => true,
      sleep: noSleep,
      now: fixedNow,
    });

    const ep = await ensureRunning(93n);
    assert.strictEqual(ep.coldStart, true);
    assert.strictEqual(row.state, "vanished", "老孤儿 row 翻 vanished");
    const newRow = pool.rows.find((r) => r.user_id === 93 && r.state === "active");
    assert.ok(newRow, "应有一条新 active row");
    assert.strictEqual(captured.containersCreated, 1);
    assert.strictEqual(captured.started, 1);
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
    assert.deepStrictEqual(ep, {
      host: "172.30.5.42",
      port: V3_CONTAINER_PORT,
      containerId: 1,
      coldStart: true, // provision 分支
    });
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

  test("provision 失败(image guard ImageOutdated)→ ContainerUnreadyError('image_outdated', 300s) 且不发起 docker create", async () => {
    // v1.0.84 PR #4 — caller-side contract lock(Codex code-review round-1 建议)。
    // image labels 缺 oc.runtime.features=v3-sink → supervisor 抛 ImageOutdated;
    // ensureRunning 翻成 reason='image_outdated' + 300s 长退避(对齐 image_missing 的
    // 部署级故障语义,避免 5s 风暴)。同时 guard 在 BEGIN/createContainer 之前拒绝 →
    // 不留 docker 副作用。setQuarantined / safeEnqueueAlert 是 best-effort fire-and-forget,
    // 与 image_missing 测试一致不在此 unit 层 assert(归 integ)。
    const pool = new FakePool();
    const { docker, captured } = makeDocker({
      imageInspect: { kind: "labels", labels: { "oc.runtime.features": "file-proxy-v1" } },
    });
    // 显式 enforce 防止 env 串扰
    const prev = process.env.OC_V3_IMAGE_GUARD;
    process.env.OC_V3_IMAGE_GUARD = "enforce";
    try {
      const ensureRunning = makeV3EnsureRunning(makeDeps(docker, pool as unknown as Pool), {
        probeHealthz: async () => true,
        probeWsUpgrade: async () => true,
        sleep: noSleep,
        now: fixedNow,
      });

      await assert.rejects(ensureRunning(212n), (err) => {
        assert.ok(err instanceof ContainerUnreadyError);
        assert.strictEqual(err.reason, "image_outdated");
        assert.strictEqual(err.retryAfterSec, 300);
        return true;
      });
      // guard 早于 docker create / BEGIN —— 不应有 docker 副作用,也不应留 active 行
      assert.strictEqual(captured.containersCreated, 0);
      assert.strictEqual(captured.started, 0);
      assert.strictEqual(pool.rows.length, 0);
    } finally {
      if (prev === undefined) delete process.env.OC_V3_IMAGE_GUARD;
      else process.env.OC_V3_IMAGE_GUARD = prev;
    }
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
      assert.deepStrictEqual(ep, {
        host: "127.0.0.1",
        port,
        containerId: 1,
        coldStart: false, // running 重用分支
      });
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

  // V3 Phase 3I: provision 撞 per-host max_containers → SupervisorError("HostFull")
  // 必须翻成 ContainerUnreadyError("host_full", retryAfter=10),前端按 retryAfter 提示
  // "系统繁忙",下次 pickHost 自然换台。
  //
  // 设计变更(v1.0.x — 全局 cap → per-host cap):
  //   - deps.maxRunningContainers 已删,权威源是 compute_hosts.max_containers(admin UI 管理)
  //   - cap 检查现在 BEGIN 后、acquire host-cap lock 后做(事务内),撞 cap 走 ROLLBACK
  //   - HostFull 分支不再 safeEnqueueAlert(单 host 满是正常调度压力,不告警);
  //     "全集群无可用 host" 语义由 NodePoolUnavailableError 分支承担
  test("provision 时 host 满 per-host cap → ContainerUnreadyError('host_full', retryAfter=10)", async () => {
    const pool = new FakePool();
    // 模拟 admin UI 把 TEST_HOST 的 max_containers 设到 2,DB 已 active 2 个 → 撞 cap
    pool.setHostMax(TEST_HOST, 2);
    pool.preInsertActive(101, "172.30.1.101", "dockerid-101");
    pool.preInsertActive(102, "172.30.1.102", "dockerid-102");
    const { docker, captured } = makeDocker();
    const deps = makeDeps(docker, pool as unknown as Pool);
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
    // cap 在事务内拒 → 不 createContainer / 不 start
    assert.strictEqual(captured.containersCreated, 0);
    assert.strictEqual(captured.started, 0);
    // 行数不变(事务回滚) — uid=18 没有遗留 row
    assert.strictEqual(pool.rows.some((r) => r.user_id === 18), false);
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
