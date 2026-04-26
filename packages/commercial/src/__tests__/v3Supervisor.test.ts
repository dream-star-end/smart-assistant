/**
 * V3 Phase 3C — agent-sandbox/v3supervisor.ts 单测。
 *
 * 路径覆盖:
 *   - provisionV3Container 写出的 docker createContainer 参数完全符合 §9.3
 *     (cap-drop NET_RAW+NET_ADMIN / tmpfs /run/oc/claude-config / 单 volume /
 *      4 个 anthropic env / docker --ip / 网络 openclaude-v3-net / no restart)
 *   - INSERT agent_containers 行落 bound_ip + secret_hash(SHA256 32 byte BYTEA)
 *     + state='active' + port=18789 + last_ws_activity NOT NULL
 *   - 唯一冲突自动重试换 IP(uniq_ac_bound_ip_active)
 *   - docker create 失败 → ROLLBACK + best-effort docker rm
 *   - stopAndRemoveV3Container 走完整顺序 + state='vanished'
 *   - getV3ContainerStatus running / stopped / missing / no row
 *
 * 不测的(归 integ / 后续 task):
 *   - docker daemon 是否真接受 IPAMConfig.IPv4Address(整网络)
 *   - 真 PG 是否真触发 uniq partial index(0012 schema 测试已覆盖)
 *   - 容器内 entrypoint scrub 行为(3A 测试已覆盖)
 */

import { describe, test, beforeEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join as pathJoin } from "node:path";
import { fileURLToPath } from "node:url";
import type Docker from "dockerode";
import type { Pool, PoolClient } from "pg";

import {
  provisionV3Container,
  stopAndRemoveV3Container,
  getV3ContainerStatus,
  v3ContainerNameFor,
  v3VolumeNameFor,
  v3ProjectsVolumeNameFor,
  resolveCcbBaselineMounts,
  V3_CCB_BASELINE_SKILL_NAMES,
  V3_NETWORK_NAME,
  V3_INTERNAL_PROXY_URL,
  V3_CONTAINER_PORT,
  V3_CONFIG_TMPFS_PATH,
  V3_VOLUME_MOUNT,
  V3_PROJECTS_MOUNT,
  SupervisorError,
} from "../agent-sandbox/index.js";

// ───────────────────────────────────────────────────────────────────────
//  fake docker
// ───────────────────────────────────────────────────────────────────────

type DockerCaptured = {
  volumesCreated: Array<{ Name?: string; Labels?: Record<string, string>; Driver?: string }>;
  containersCreated: Array<Parameters<Docker["createContainer"]>[0]>;
  started: number;
  stopped: number;
  removed: number;
  inspected: number;
};

type DockerBehavior = {
  imageMissing?: boolean;
  startFails?: boolean;
  inspectMissing?: boolean;
  inspectRunning?: boolean;
};

function httpError(code: number, msg: string): Error {
  const e = new Error(msg) as Error & { statusCode: number };
  e.statusCode = code;
  return e;
}

function makeDocker(behavior: DockerBehavior = {}): { docker: Docker; captured: DockerCaptured } {
  const captured: DockerCaptured = {
    volumesCreated: [],
    containersCreated: [],
    started: 0,
    stopped: 0,
    removed: 0,
    inspected: 0,
  };

  const createVolume = async (opts: { Name?: string; Labels?: Record<string, string>; Driver?: string }) => {
    captured.volumesCreated.push(opts);
    return {} as Awaited<ReturnType<Docker["createVolume"]>>;
  };
  const getVolume = (name: string) => ({
    inspect: async () => {
      const entry = captured.volumesCreated.find((v) => v.Name === name);
      if (!entry) throw httpError(404, "no such volume");
      return {
        Name: name,
        Driver: "local",
        Labels: entry.Labels ?? {},
      } as unknown as Awaited<ReturnType<ReturnType<Docker["getVolume"]>["inspect"]>>;
    },
    remove: async () => {
      /* noop */
    },
  });

  const createContainer = async (opts: Parameters<Docker["createContainer"]>[0]) => {
    if (behavior.imageMissing) throw httpError(404, "No such image: openclaude/openclaude-runtime:test");
    captured.containersCreated.push(opts);
    return {
      id: `dockerid-${captured.containersCreated.length}`,
      start: async () => {
        if (behavior.startFails) throw httpError(500, "start failed");
        captured.started++;
      },
      remove: async () => {
        captured.removed++;
      },
    } as unknown as Awaited<ReturnType<Docker["createContainer"]>>;
  };

  const getContainer = (_id: string) => ({
    inspect: async () => {
      captured.inspected++;
      if (behavior.inspectMissing) throw httpError(404, "no such container");
      return {
        Id: _id,
        State: { Running: behavior.inspectRunning ?? true, Status: behavior.inspectRunning === false ? "exited" : "running" },
      } as unknown as Awaited<ReturnType<ReturnType<Docker["getContainer"]>["inspect"]>>;
    },
    stop: async () => {
      captured.stopped++;
    },
    remove: async () => {
      captured.removed++;
    },
  });

  const docker = {
    createVolume,
    getVolume: getVolume as unknown as Docker["getVolume"],
    createContainer,
    getContainer,
  } as unknown as Docker;

  return { docker, captured };
}

// ───────────────────────────────────────────────────────────────────────
//  fake pg.Pool — 内存里塞 agent_containers 行,模拟 uniq partial index
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
  /** 第几次 connect 时返回的 client。每次 BEGIN/COMMIT/ROLLBACK 都记。 */
  clientLog: Array<"BEGIN" | "COMMIT" | "ROLLBACK"> = [];
  /** test 钩子:第 N 次 INSERT 强制抛 23505(模拟 uniq 冲突),序号从 0 开始 */
  forceUniqConflictOnInserts: Set<number> = new Set();
  insertCount = 0;

  async connect(): Promise<PoolClient> {
    const log = this.clientLog;
    const self = this;
    const client = {
      async query(sql: string, params?: unknown[]): Promise<unknown> {
        const trimmed = String(sql).trim();
        if (/^BEGIN/i.test(trimmed)) {
          log.push("BEGIN");
          return { rowCount: 0, rows: [] };
        }
        if (/^COMMIT/i.test(trimmed)) {
          log.push("COMMIT");
          return { rowCount: 0, rows: [] };
        }
        if (/^ROLLBACK/i.test(trimmed)) {
          log.push("ROLLBACK");
          return { rowCount: 0, rows: [] };
        }
        // codex round 1 FAIL #2/#3 修复 — provision 在 BEGIN 后立刻拿
        // user-lifecycle 锁 + host-cap 锁,FakePool 不模拟真锁语义,直接 noop。
        if (/^SELECT pg_advisory_xact_lock/i.test(trimmed)) {
          return { rowCount: 0, rows: [] };
        }
        if (/INSERT INTO agent_containers/i.test(trimmed)) {
          const idx = self.insertCount++;
          if (self.forceUniqConflictOnInserts.has(idx)) {
            const e = new Error('duplicate key value violates unique constraint "uniq_ac_bound_ip_active"') as Error & {
              code: string;
              constraint: string;
            };
            e.code = "23505";
            e.constraint = "uniq_ac_bound_ip_active";
            throw e;
          }
          // params: [user_id, host_uuid, bound_ip, secret_hash, port]
          const userId = Number.parseInt(String(params![0]), 10);
          const hostUuid = params![1] == null ? null : String(params![1]);
          const boundIp = String(params![2]);
          const secretHash = params![3] as Buffer;
          const port = Number(params![4]);
          // 真 uniq:active 中已有同 IP → 23505
          if (self.rows.some((r) => r.state === "active" && r.bound_ip === boundIp)) {
            const e = new Error("duplicate key") as Error & { code: string; constraint: string };
            e.code = "23505";
            e.constraint = "uniq_ac_bound_ip_active";
            throw e;
          }
          const id = self.nextId++;
          const now = new Date();
          self.rows.push({
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
          const r = self.rows.find((x) => x.id === id);
          if (r) {
            r.container_internal_id = cid;
            r.updated_at = new Date();
          }
          return { rowCount: r ? 1 : 0, rows: [] };
        }
        if (/UPDATE agent_containers/i.test(trimmed) && /SET state='vanished'/i.test(trimmed)) {
          const id = Number.parseInt(String(params![0]), 10);
          const r = self.rows.find((x) => x.id === id);
          if (r) {
            r.state = "vanished";
            r.updated_at = new Date();
          }
          return { rowCount: r ? 1 : 0, rows: [] };
        }
        if (/SELECT id, user_id,\s*host\(bound_ip\)/i.test(trimmed) && /WHERE user_id/i.test(trimmed)) {
          const userId = Number.parseInt(String(params![0]), 10);
          const r = self.rows.find((x) => x.user_id === userId && x.state === "active");
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
        // V3 Phase 3I — provisionV3Container 在事务前查 active count 做 cap 检查
        if (/SELECT COUNT\(\*\)::text AS active/i.test(trimmed) && /state = 'active'/i.test(trimmed)) {
          const active = self.rows.filter((x) => x.state === "active").length;
          return { rowCount: 1, rows: [{ active: String(active) }] };
        }
        throw new Error(`FakePool: unhandled SQL: ${trimmed.slice(0, 200)}`);
      },
      release() {
        /* noop */
      },
    } as unknown as PoolClient;
    return client;
  }

  async query(sql: string, params?: unknown[]): Promise<unknown> {
    // 顶层 query 仅 stop/status 用
    const c = await this.connect();
    return await c.query(sql, params);
  }

  end(): Promise<void> {
    return Promise.resolve();
  }
}

// ───────────────────────────────────────────────────────────────────────
//  helpers
// ───────────────────────────────────────────────────────────────────────

const TEST_IMAGE = "openclaude/openclaude-runtime:test";

function fixedSecret(s: string): () => string {
  return () => s;
}

function fixedIps(ips: string[]): () => string {
  let i = 0;
  return () => ips[Math.min(i++, ips.length - 1)]!;
}

// ───────────────────────────────────────────────────────────────────────
//  纯名字函数
// ───────────────────────────────────────────────────────────────────────

describe("v3ContainerNameFor / v3VolumeNameFor / v3ProjectsVolumeNameFor", () => {
  test("happy path", () => {
    assert.equal(v3ContainerNameFor(42), "oc-v3-u42");
    assert.equal(v3VolumeNameFor(42), "oc-v3-data-u42");
    assert.equal(v3ProjectsVolumeNameFor(42), "oc-v3-proj-u42");
  });
  test("rejects bad uid", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => v3ContainerNameFor(bad as number), SupervisorError);
      assert.throws(() => v3VolumeNameFor(bad as number), SupervisorError);
      assert.throws(() => v3ProjectsVolumeNameFor(bad as number), SupervisorError);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────
//  provisionV3Container — happy path 全契约
// ───────────────────────────────────────────────────────────────────────

describe("provisionV3Container", () => {
  let pool: FakePool;
  // 基线 fail-closed 默认启用;这些 happy-path 测试不关心基线内容,设 OPTIONAL 降级
  // 为 warn+skip,避免触发 CcbBaselineMissing。基线专项测试在下一个 describe 里。
  let prevOptional: string | undefined;
  before(() => {
    prevOptional = process.env.OC_V3_CCB_BASELINE_OPTIONAL;
    process.env.OC_V3_CCB_BASELINE_OPTIONAL = "1";
  });
  after(() => {
    if (prevOptional === undefined) delete process.env.OC_V3_CCB_BASELINE_OPTIONAL;
    else process.env.OC_V3_CCB_BASELINE_OPTIONAL = prevOptional;
  });
  beforeEach(() => {
    pool = new FakePool();
  });

  test("docker createContainer 参数符合 §9.3 全部硬约束", async () => {
    const { docker, captured } = makeDocker();
    const SECRET = "a".repeat(64);
    const IP = "172.30.5.42";
    const result = await provisionV3Container(
      { docker, pool: pool as unknown as Pool, image: TEST_IMAGE, randomIp: () => IP, randomSecret: fixedSecret(SECRET) },
      777,
    );

    assert.equal(result.userId, 777);
    assert.equal(result.boundIp, IP);
    assert.equal(result.port, V3_CONTAINER_PORT);
    assert.equal(result.token, `oc-v3.${result.containerId}.${SECRET}`);
    assert.ok(result.dockerContainerId.length > 0);

    // volume 落 label(data + projects 两个,顺序按 ensureV3Volumes 内部)
    assert.equal(captured.volumesCreated.length, 2);
    const dataVol = captured.volumesCreated.find((v) => v.Name === "oc-v3-data-u777");
    const projVol = captured.volumesCreated.find((v) => v.Name === "oc-v3-proj-u777");
    assert.ok(dataVol, "oc-v3-data-u777 must be created");
    assert.ok(projVol, "oc-v3-proj-u777 must be created");
    assert.equal(dataVol!.Labels?.["com.openclaude.v3.managed"], "1");
    assert.equal(dataVol!.Labels?.["com.openclaude.v3.uid"], "777");
    assert.equal(projVol!.Labels?.["com.openclaude.v3.managed"], "1");
    assert.equal(projVol!.Labels?.["com.openclaude.v3.uid"], "777");

    // container 参数
    assert.equal(captured.containersCreated.length, 1);
    const opts = captured.containersCreated[0]!;
    assert.equal(opts.name, "oc-v3-u777");
    assert.equal(opts.Image, TEST_IMAGE);
    assert.equal(opts.User, "1000:1000");
    assert.equal(opts.Tty, false);
    assert.equal(opts.AttachStdin, false);

    // env: 4 个 anthropic 注入,顺序不重要,内容必须精确
    const env = opts.Env ?? [];
    assert.ok(env.includes(`ANTHROPIC_BASE_URL=${V3_INTERNAL_PROXY_URL}`));
    assert.ok(env.includes(`ANTHROPIC_AUTH_TOKEN=${result.token}`));
    assert.ok(env.includes("CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1"));
    assert.ok(env.includes(`CLAUDE_CONFIG_DIR=${V3_CONFIG_TMPFS_PATH}`));
    // PR4: mcp-memory SkillStore 通过这个 env 接管平台基线只读视图
    assert.ok(
      env.includes(`OPENCLAUDE_BASELINE_SKILLS_DIR=${V3_CONFIG_TMPFS_PATH}/skills`),
      "supervisor must inject OPENCLAUDE_BASELINE_SKILLS_DIR so SkillStore can overlay platform baseline",
    );
    // 商用版容器必须默认跳过 personal-version 自反思 cron(否则用户没说话也每天扣 ~¥2-3)。
    // 处理逻辑见 packages/gateway/src/cron.ts::ensureCronFile。本地路径覆盖在这里;
    // remote 路径会把同一 env 数组转换成 ContainerSpec.env 透传给 node-agent。
    assert.ok(
      env.includes("OC_SEED_DEFAULT_CRON=0"),
      "supervisor must inject OC_SEED_DEFAULT_CRON=0 to skip personal-version default cron seeding",
    );

    // 网络 + IP forced via IPAMConfig
    assert.equal(opts.HostConfig?.NetworkMode, V3_NETWORK_NAME);
    const epc = opts.NetworkingConfig?.EndpointsConfig?.[V3_NETWORK_NAME];
    assert.equal(epc?.IPAMConfig?.IPv4Address, IP);

    // 资源硬限额:默认 2GB / 1 核 / 1024 pids(env 未设,走 DEFAULT_V3_*)
    assert.equal(opts.HostConfig?.Memory, 2048 * 1024 * 1024);
    assert.equal(opts.HostConfig?.MemorySwap, 2048 * 1024 * 1024, "MemorySwap 必须 == Memory 禁 swap");
    assert.equal(opts.HostConfig?.MemorySwappiness, 0);
    assert.equal(opts.HostConfig?.NanoCpus, 1_000_000_000, "1.0 CPU = 1e9 ns");
    assert.equal(opts.HostConfig?.PidsLimit, 1024);

    // cap-drop NET_RAW + NET_ADMIN
    assert.deepEqual(opts.HostConfig?.CapDrop, ["NET_RAW", "NET_ADMIN"]);
    assert.deepEqual(opts.HostConfig?.CapAdd, []);

    // SecurityOpt no-new-privileges + Privileged false
    assert.ok(opts.HostConfig?.SecurityOpt?.includes("no-new-privileges"));
    assert.equal(opts.HostConfig?.Privileged, false);

    // tmpfs /run/oc/claude-config
    const tmp = (opts.HostConfig?.Tmpfs ?? {})[V3_CONFIG_TMPFS_PATH];
    assert.ok(tmp, "Tmpfs entry for CLAUDE_CONFIG_DIR must exist");
    assert.match(tmp, /nosuid/);
    assert.match(tmp, /nodev/);
    assert.match(tmp, /mode=0700/);

    // 双 volume: data → /home/agent/.openclaude; projects → /run/oc/claude-config/projects
    assert.deepEqual(opts.HostConfig?.Binds, [
      `oc-v3-data-u777:${V3_VOLUME_MOUNT}:rw`,
      `oc-v3-proj-u777:${V3_PROJECTS_MOUNT}:rw`,
    ]);

    // restart no
    assert.equal(opts.HostConfig?.RestartPolicy?.Name, "no");

    // labels
    assert.equal(opts.Labels?.["com.openclaude.v3.managed"], "1");
    assert.equal(opts.Labels?.["com.openclaude.v3.uid"], "777");

    // start 成功
    assert.equal(captured.started, 1);
  });

  test("资源限额 env 覆盖:合法小数 CPU 正确转换 + 非法微值回退默认(Codex round 1 BLOCKER 回归锁)", async () => {
    // Codex round 1 抓到的 bug:OC_V3_MEMORY_MB=0.5 会被 floor 成 0,Docker 当"不限";必须回退默认
    const savedMem = process.env.OC_V3_MEMORY_MB;
    const savedCpu = process.env.OC_V3_CPUS;
    const savedPid = process.env.OC_V3_PIDS_LIMIT;
    try {
      // 1) 微值(floor 后为 0)→ 回退默认,绝不传 0 给 Docker
      process.env.OC_V3_MEMORY_MB = "0.5";
      process.env.OC_V3_CPUS = "1e-10";
      process.env.OC_V3_PIDS_LIMIT = "0.5";
      {
        const { docker, captured } = makeDocker();
        await provisionV3Container(
          { docker, pool: pool as unknown as Pool, image: TEST_IMAGE, randomIp: () => "172.30.9.1", randomSecret: fixedSecret("c".repeat(64)) },
          901,
        );
        const hc = captured.containersCreated[0]!.HostConfig!;
        assert.equal(hc.Memory, 2048 * 1024 * 1024, "floor 后 <1 必须回退 DEFAULT_V3_MEMORY_MB,不能传 0");
        assert.equal(hc.NanoCpus, 1_000_000_000, "floor 后 <1 ns 必须回退 DEFAULT_V3_CPUS");
        assert.equal(hc.PidsLimit, 1024, "floor 后 <1 必须回退 DEFAULT_V3_PIDS_LIMIT");
      }

      // 2) 合法小数 CPU 正确换算:0.5 核 → 5e8 ns
      pool = new FakePool();
      delete process.env.OC_V3_MEMORY_MB;
      process.env.OC_V3_CPUS = "0.5";
      delete process.env.OC_V3_PIDS_LIMIT;
      {
        const { docker, captured } = makeDocker();
        await provisionV3Container(
          { docker, pool: pool as unknown as Pool, image: TEST_IMAGE, randomIp: () => "172.30.9.2", randomSecret: fixedSecret("d".repeat(64)) },
          902,
        );
        const hc = captured.containersCreated[0]!.HostConfig!;
        assert.equal(hc.NanoCpus, 500_000_000, "0.5 核 == 500_000_000 ns");
      }
    } finally {
      if (savedMem === undefined) delete process.env.OC_V3_MEMORY_MB;
      else process.env.OC_V3_MEMORY_MB = savedMem;
      if (savedCpu === undefined) delete process.env.OC_V3_CPUS;
      else process.env.OC_V3_CPUS = savedCpu;
      if (savedPid === undefined) delete process.env.OC_V3_PIDS_LIMIT;
      else process.env.OC_V3_PIDS_LIMIT = savedPid;
    }
  });

  test("agent_containers row: bound_ip + secret_hash(SHA256 BYTEA) + state=active + container_internal_id", async () => {
    const { docker, captured } = makeDocker();
    const SECRET = "b".repeat(64);
    const result = await provisionV3Container(
      { docker, pool: pool as unknown as Pool, image: TEST_IMAGE, randomIp: () => "172.30.7.7", randomSecret: fixedSecret(SECRET) },
      11,
    );
    assert.equal(pool.rows.length, 1);
    const row = pool.rows[0]!;
    assert.equal(row.id, result.containerId);
    assert.equal(row.user_id, 11);
    assert.equal(row.bound_ip, "172.30.7.7");
    assert.equal(row.state, "active");
    assert.equal(row.port, V3_CONTAINER_PORT);
    assert.equal(row.container_internal_id, captured.containersCreated.length === 1 ? "dockerid-1" : null);
    // SHA-256(secret_bytes) — 与 containerIdentity.hashSecret 同算法
    const expected = createHash("sha256").update(Buffer.from(SECRET, "hex")).digest();
    assert.ok(Buffer.isBuffer(row.secret_hash), "secret_hash must be Buffer (BYTEA)");
    assert.equal(row.secret_hash.length, 32);
    assert.ok(row.secret_hash.equals(expected), "secret_hash must equal SHA-256(secret bytes)");
    // 事务序列:BEGIN → COMMIT
    assert.deepEqual(pool.clientLog, ["BEGIN", "COMMIT"]);
  });

  test("uniq_ac_bound_ip_active 冲突自动重试换 IP", async () => {
    const { docker } = makeDocker();
    pool.forceUniqConflictOnInserts.add(0); // 第一次 INSERT 失败
    pool.forceUniqConflictOnInserts.add(1); // 第二次也失败
    const ips = fixedIps(["172.30.0.10", "172.30.0.11", "172.30.0.12"]);
    const result = await provisionV3Container(
      { docker, pool: pool as unknown as Pool, image: TEST_IMAGE, randomIp: ips, randomSecret: fixedSecret("c".repeat(64)) },
      55,
    );
    // 第三次 INSERT 才成功
    assert.equal(result.boundIp, "172.30.0.12");
    assert.equal(pool.insertCount, 3);
    assert.equal(pool.rows.length, 1);
  });

  test("docker createContainer 失败 → ROLLBACK + 不留 PG 行", async () => {
    const { docker } = makeDocker({ imageMissing: true });
    await assert.rejects(
      provisionV3Container(
        { docker, pool: pool as unknown as Pool, image: TEST_IMAGE, randomIp: () => "172.30.1.1", randomSecret: fixedSecret("d".repeat(64)) },
        9,
      ),
      (err: Error) => err instanceof SupervisorError && err.code === "ImageNotFound",
    );
    // ROLLBACK 跑过
    assert.deepEqual(pool.clientLog, ["BEGIN", "ROLLBACK"]);
    // FakePool 内仍然写了行(insert 已 commit 到内存),但实际 PG 会回滚 ——
    // 这个 fake 的局限性,真 PG 不会有残留;断言 ROLLBACK 即可证明语义对
  });

  test("container.start 失败 → docker rm -f + ROLLBACK", async () => {
    const { docker, captured } = makeDocker({ startFails: true });
    await assert.rejects(
      provisionV3Container(
        { docker, pool: pool as unknown as Pool, image: TEST_IMAGE, randomIp: () => "172.30.2.2", randomSecret: fixedSecret("e".repeat(64)) },
        9,
      ),
      (err: Error) => err instanceof SupervisorError,
    );
    // start 之前 createContainer 成功 → start 失败时直接 container.remove
    // 之后 catch 块再次 docker.getContainer().remove (best-effort) → removed >= 1
    assert.ok(captured.removed >= 1);
    assert.deepEqual(pool.clientLog, ["BEGIN", "ROLLBACK"]);
  });

  test("rejects bad image / uid", async () => {
    const { docker } = makeDocker();
    await assert.rejects(
      provisionV3Container({ docker, pool: pool as unknown as Pool, image: "" }, 1),
      (err: Error) => err instanceof SupervisorError && err.code === "InvalidArgument",
    );
    await assert.rejects(
      provisionV3Container({ docker, pool: pool as unknown as Pool, image: TEST_IMAGE }, 0),
      (err: Error) => err instanceof SupervisorError && err.code === "InvalidArgument",
    );
  });

  test("rejects mock secret 不是 64 hex(防生成器漂移)", async () => {
    const { docker } = makeDocker();
    await assert.rejects(
      provisionV3Container(
        { docker, pool: pool as unknown as Pool, image: TEST_IMAGE, randomIp: () => "172.30.3.3", randomSecret: () => "short" },
        7,
      ),
      (err: Error) => err instanceof SupervisorError && err.code === "InvalidArgument",
    );
  });
});

// ───────────────────────────────────────────────────────────────────────
//  stopAndRemoveV3Container
// ───────────────────────────────────────────────────────────────────────

describe("stopAndRemoveV3Container", () => {
  let prevOptional: string | undefined;
  before(() => {
    prevOptional = process.env.OC_V3_CCB_BASELINE_OPTIONAL;
    process.env.OC_V3_CCB_BASELINE_OPTIONAL = "1";
  });
  after(() => {
    if (prevOptional === undefined) delete process.env.OC_V3_CCB_BASELINE_OPTIONAL;
    else process.env.OC_V3_CCB_BASELINE_OPTIONAL = prevOptional;
  });
  test("stops + removes + sets state='vanished'", async () => {
    const { docker, captured } = makeDocker();
    const pool = new FakePool();
    // 先 provision 一个,再 stop
    const r = await provisionV3Container(
      { docker, pool: pool as unknown as Pool, image: TEST_IMAGE, randomIp: () => "172.30.9.9", randomSecret: fixedSecret("f".repeat(64)) },
      33,
    );
    assert.equal(pool.rows[0]!.state, "active");

    await stopAndRemoveV3Container(
      { docker, pool: pool as unknown as Pool, image: TEST_IMAGE },
      { id: r.containerId, container_internal_id: r.dockerContainerId },
    );

    assert.equal(captured.stopped, 1);
    assert.ok(captured.removed >= 1);
    assert.equal(pool.rows[0]!.state, "vanished");
  });

  test("docker missing → 仍然把 row 标 vanished(幂等)", async () => {
    const { docker } = makeDocker({ inspectMissing: true });
    const pool = new FakePool();
    pool.rows.push({
      id: 99,
      user_id: 1,
      host_uuid: null,
      bound_ip: "172.30.4.4",
      secret_hash: Buffer.alloc(32),
      state: "active",
      port: 18789,
      container_internal_id: "ghost",
      last_ws_activity: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    });
    // stop / remove 都返 404 → 不抛(isNotFound 吞掉)
    const dockerWith404 = {
      getContainer: () => ({
        stop: async () => { throw httpError(404, "missing"); },
        remove: async () => { throw httpError(404, "missing"); },
      }),
    } as unknown as Docker;
    await stopAndRemoveV3Container(
      { docker: dockerWith404, pool: pool as unknown as Pool, image: TEST_IMAGE },
      { id: 99, container_internal_id: "ghost" },
    );
    assert.equal(pool.rows[0]!.state, "vanished");
  });

  // 2026-04-21 codex round 1 finding #4 修复回归 + R3 升级:
  // docker stop 抛非 404 错误时,row 必须仍然被标 vanished(admin 意图权威)。
  // R3:stop 失败但 remove({force:true}) 成功 → 视作清理 OK(不抛错)。
  test("docker stop 抛非-404 错 + remove force 成功 → 清理成功(R3 best-effort)", async () => {
    const pool = new FakePool();
    pool.rows.push({
      id: 77,
      user_id: 1,
      host_uuid: null,
      bound_ip: "172.30.5.5",
      secret_hash: Buffer.alloc(32),
      state: "active",
      port: 18789,
      container_internal_id: "halfdead",
      last_ws_activity: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    });
    let removeCalled = false;
    const dockerWithErr = {
      getContainer: () => ({
        stop: async () => { throw httpError(500, "docker daemon overloaded"); },
        remove: async () => { removeCalled = true; /* force remove 救场 */ },
      }),
    } as unknown as Docker;
    // stop 失败但 remove 成功 → 不抛
    await stopAndRemoveV3Container(
      { docker: dockerWithErr, pool: pool as unknown as Pool, image: TEST_IMAGE },
      { id: 77, container_internal_id: "halfdead" },
    );
    assert.equal(pool.rows[0]!.state, "vanished");
    assert.equal(removeCalled, true, "force remove must run after stop failed");
  });

  // R3:stop + remove 都失败 → 聚合包成 PartialV3Cleanup,row 仍 vanished
  test("docker stop+remove 都抛非-404 → 聚合 PartialV3Cleanup, row 仍 vanished", async () => {
    const pool = new FakePool();
    pool.rows.push({
      id: 88,
      user_id: 2,
      host_uuid: null,
      bound_ip: "172.30.5.6",
      secret_hash: Buffer.alloc(32),
      state: "active",
      port: 18789,
      container_internal_id: "halfdead2",
      last_ws_activity: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    });
    const dockerBothErr = {
      getContainer: () => ({
        stop: async () => { throw httpError(500, "stop boom"); },
        remove: async () => { throw httpError(500, "remove boom"); },
      }),
    } as unknown as Docker;
    await assert.rejects(
      stopAndRemoveV3Container(
        { docker: dockerBothErr, pool: pool as unknown as Pool, image: TEST_IMAGE },
        { id: 88, container_internal_id: "halfdead2" },
      ),
      (err: Error) =>
        err instanceof SupervisorError &&
        (err as SupervisorError).code === "PartialV3Cleanup" &&
        /stop\+remove/.test(err.message),
    );
    assert.equal(pool.rows[0]!.state, "vanished");
  });

  // R2 加固保留:仅 remove 步骤失败也要包成 PartialV3Cleanup
  test("docker remove 抛非-404 错(stop ok)→ 包成 PartialV3Cleanup", async () => {
    const pool = new FakePool();
    pool.rows.push({
      id: 99,
      user_id: 3,
      host_uuid: null,
      bound_ip: "172.30.5.7",
      secret_hash: Buffer.alloc(32),
      state: "active",
      port: 18789,
      container_internal_id: "halfdead3",
      last_ws_activity: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    });
    const dockerRemoveErr = {
      getContainer: () => ({
        stop: async () => { /* ok */ },
        remove: async () => { throw httpError(500, "remove boom"); },
      }),
    } as unknown as Docker;
    await assert.rejects(
      stopAndRemoveV3Container(
        { docker: dockerRemoveErr, pool: pool as unknown as Pool, image: TEST_IMAGE },
        { id: 99, container_internal_id: "halfdead3" },
      ),
      (err: Error) =>
        err instanceof SupervisorError &&
        (err as SupervisorError).code === "PartialV3Cleanup" &&
        /remove/.test(err.message),
    );
    assert.equal(pool.rows[0]!.state, "vanished");
  });

  // R4 finding 加固(R5):stop 非-404 错 + remove 返回 404(容器已不存在)
  // → 容器其实已经被清掉了,清理目的达成,**不应该**抛 PartialV3Cleanup。
  // 之前的实现把 stop 失败 push 进 failures[],然后看见 failures.length>0 就抛
  // ——即使 remove 收到 404 表示容器已 gone。这是个误报 partial,会让 admin
  // 看到 502 V3_CLEANUP_PARTIAL,但其实状态已 vanished + docker 已清干净。
  test("docker stop 抛非-404 + remove 返回 404 → 视作清理 OK (R5 幂等)", async () => {
    const pool = new FakePool();
    pool.rows.push({
      id: 100,
      user_id: 4,
      host_uuid: null,
      bound_ip: "172.30.5.8",
      secret_hash: Buffer.alloc(32),
      state: "active",
      port: 18789,
      container_internal_id: "halfdead4",
      last_ws_activity: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    });
    const dockerStopErrRemoveGone = {
      getContainer: () => ({
        stop: async () => { throw httpError(500, "stop boom"); },
        remove: async () => { throw httpError(404, "no such container"); },
      }),
    } as unknown as Docker;
    // 不应抛 —— 容器已不存在,清理目的达成
    await stopAndRemoveV3Container(
      { docker: dockerStopErrRemoveGone, pool: pool as unknown as Pool, image: TEST_IMAGE },
      { id: 100, container_internal_id: "halfdead4" },
    );
    assert.equal(pool.rows[0]!.state, "vanished");
  });
});

// ───────────────────────────────────────────────────────────────────────
//  getV3ContainerStatus
// ───────────────────────────────────────────────────────────────────────

describe("getV3ContainerStatus", () => {
  test("无 row → null", async () => {
    const { docker } = makeDocker();
    const pool = new FakePool();
    const r = await getV3ContainerStatus(
      { docker, pool: pool as unknown as Pool, image: TEST_IMAGE },
      42,
    );
    assert.equal(r, null);
  });

  test("active row + docker running → state='running'", async () => {
    const { docker } = makeDocker({ inspectRunning: true });
    const pool = new FakePool();
    const provisioned = await provisionV3Container(
      { docker, pool: pool as unknown as Pool, image: TEST_IMAGE, randomIp: () => "172.30.10.10", randomSecret: fixedSecret("a".repeat(64)) },
      77,
    );
    const r = await getV3ContainerStatus(
      { docker, pool: pool as unknown as Pool, image: TEST_IMAGE },
      77,
    );
    assert.ok(r);
    assert.equal(r!.state, "running");
    assert.equal(r!.boundIp, "172.30.10.10");
    assert.equal(r!.port, V3_CONTAINER_PORT);
    assert.equal(r!.dockerContainerId, provisioned.dockerContainerId);
  });

  test("active row + docker missing → state='missing'", async () => {
    const { docker } = makeDocker({ inspectMissing: true });
    const pool = new FakePool();
    pool.rows.push({
      id: 1,
      user_id: 5,
      host_uuid: null,
      bound_ip: "172.30.11.11",
      secret_hash: Buffer.alloc(32),
      state: "active",
      port: 18789,
      container_internal_id: "ghost",
      last_ws_activity: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    });
    const r = await getV3ContainerStatus(
      { docker, pool: pool as unknown as Pool, image: TEST_IMAGE },
      5,
    );
    assert.ok(r);
    assert.equal(r!.state, "missing");
  });

  test("active row 但 container_internal_id 为 NULL → state='stopped'(provision 中间窗口)", async () => {
    const { docker } = makeDocker();
    const pool = new FakePool();
    pool.rows.push({
      id: 1,
      user_id: 5,
      host_uuid: null,
      bound_ip: "172.30.12.12",
      secret_hash: Buffer.alloc(32),
      state: "active",
      port: 18789,
      container_internal_id: null,
      last_ws_activity: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    });
    const r = await getV3ContainerStatus(
      { docker, pool: pool as unknown as Pool, image: TEST_IMAGE },
      5,
    );
    assert.ok(r);
    assert.equal(r!.state, "stopped");
    assert.equal(r!.dockerContainerId, "");
  });
});

// ───────────────────────────────────────────────────────────────────────
//  V3 Phase 3I — MAX_RUNNING_CONTAINERS cap
// ───────────────────────────────────────────────────────────────────────

describe("provisionV3Container — MAX_RUNNING_CONTAINERS cap (3I)", () => {
  let pool: FakePool;
  let prevOptional: string | undefined;
  before(() => {
    prevOptional = process.env.OC_V3_CCB_BASELINE_OPTIONAL;
    process.env.OC_V3_CCB_BASELINE_OPTIONAL = "1";
  });
  after(() => {
    if (prevOptional === undefined) delete process.env.OC_V3_CCB_BASELINE_OPTIONAL;
    else process.env.OC_V3_CCB_BASELINE_OPTIONAL = prevOptional;
  });
  beforeEach(() => {
    pool = new FakePool();
  });

  /** 塞 N 个 active 行进 FakePool,模拟 host 已经满负荷 */
  function seedActiveRows(n: number): void {
    for (let i = 0; i < n; i++) {
      const now = new Date();
      pool.rows.push({
        id: pool.nextId++,
        user_id: 1000 + i,
        host_uuid: null,
        bound_ip: `172.30.100.${i + 1}`,
        secret_hash: Buffer.alloc(32),
        state: "active",
        port: V3_CONTAINER_PORT,
        container_internal_id: `seed-${i}`,
        last_ws_activity: now,
        created_at: now,
        updated_at: now,
      });
    }
  }

  test("active < cap → 正常 provision(deps.maxRunningContainers 注入 = 3,2 active)", async () => {
    const { docker } = makeDocker();
    seedActiveRows(2);
    const r = await provisionV3Container(
      {
        docker,
        pool: pool as unknown as Pool,
        image: TEST_IMAGE,
        randomIp: () => "172.30.50.1",
        randomSecret: fixedSecret("0".repeat(64)),
        maxRunningContainers: 3,
      },
      777,
    );
    assert.ok(r.containerId > 0);
    assert.equal(r.boundIp, "172.30.50.1");
    // 第三行成功落了
    assert.equal(pool.rows.filter((x) => x.state === "active").length, 3);
  });

  test("active = cap → 抛 SupervisorError('HostFull') 在事务内 + 不动 docker", async () => {
    const { docker, captured } = makeDocker();
    seedActiveRows(3);
    await assert.rejects(
      provisionV3Container(
        {
          docker,
          pool: pool as unknown as Pool,
          image: TEST_IMAGE,
          randomIp: () => "172.30.50.99",
          randomSecret: fixedSecret("1".repeat(64)),
          maxRunningContainers: 3,
        },
        9001,
      ),
      (err: Error) => err instanceof SupervisorError && err.code === "HostFull",
    );
    // codex round 1 FAIL #2 修复 — cap 检查现在在事务内,与 host-cap 锁串行,
    // 撞 cap 时 BEGIN 已经发生但走 ROLLBACK,docker 一字未动
    assert.deepEqual(pool.clientLog, ["BEGIN", "ROLLBACK"]);
    assert.equal(captured.containersCreated.length, 0);
    assert.equal(captured.volumesCreated.length, 0);
    // 行数不变(事务回滚)
    assert.equal(pool.rows.length, 3);
  });

  test("active > cap(运维手动塞了多)→ 仍然 HostFull,不会绕过", async () => {
    const { docker } = makeDocker();
    seedActiveRows(5);
    await assert.rejects(
      provisionV3Container(
        {
          docker,
          pool: pool as unknown as Pool,
          image: TEST_IMAGE,
          randomIp: () => "172.30.51.1",
          randomSecret: fixedSecret("2".repeat(64)),
          maxRunningContainers: 3,
        },
        9002,
      ),
      (err: Error) => err instanceof SupervisorError && err.code === "HostFull",
    );
  });

  test("vanished 行不计入 cap(已死容器不占容量)", async () => {
    const { docker } = makeDocker();
    seedActiveRows(2);
    // 再塞 5 个 vanished 行,模拟 idle sweep / orphan reconcile 已经清掉
    for (let i = 0; i < 5; i++) {
      const now = new Date();
      pool.rows.push({
        id: pool.nextId++,
        user_id: 8000 + i,
        host_uuid: null,
        bound_ip: `172.30.200.${i + 1}`,
        secret_hash: Buffer.alloc(32),
        state: "vanished",
        port: V3_CONTAINER_PORT,
        container_internal_id: `dead-${i}`,
        last_ws_activity: now,
        created_at: now,
        updated_at: now,
      });
    }
    // cap=3,active=2(vanished 不算),应该过
    const r = await provisionV3Container(
      {
        docker,
        pool: pool as unknown as Pool,
        image: TEST_IMAGE,
        randomIp: () => "172.30.50.55",
        randomSecret: fixedSecret("3".repeat(64)),
        maxRunningContainers: 3,
      },
      9003,
    );
    assert.ok(r.containerId > 0);
  });

  test("env OC_MAX_RUNNING_CONTAINERS 兜底 + deps.maxRunningContainers 优先级更高", async () => {
    const { docker } = makeDocker();
    seedActiveRows(2);
    const original = process.env.OC_MAX_RUNNING_CONTAINERS;
    try {
      // env 设的 cap 低,但 deps 注入更高 → deps 赢
      process.env.OC_MAX_RUNNING_CONTAINERS = "1";
      const r = await provisionV3Container(
        {
          docker,
          pool: pool as unknown as Pool,
          image: TEST_IMAGE,
          randomIp: () => "172.30.52.1",
          randomSecret: fixedSecret("4".repeat(64)),
          maxRunningContainers: 5,
        },
        9004,
      );
      assert.ok(r.containerId > 0);
    } finally {
      if (original === undefined) delete process.env.OC_MAX_RUNNING_CONTAINERS;
      else process.env.OC_MAX_RUNNING_CONTAINERS = original;
    }
  });

  test("env OC_MAX_RUNNING_CONTAINERS 生效(deps 不注入时回落到 env)", async () => {
    const { docker, captured } = makeDocker();
    seedActiveRows(2);
    const original = process.env.OC_MAX_RUNNING_CONTAINERS;
    try {
      process.env.OC_MAX_RUNNING_CONTAINERS = "2";
      await assert.rejects(
        provisionV3Container(
          {
            docker,
            pool: pool as unknown as Pool,
            image: TEST_IMAGE,
            randomIp: () => "172.30.52.99",
            randomSecret: fixedSecret("5".repeat(64)),
            // 故意不注入 maxRunningContainers,让代码走 readMaxRunningContainersFromEnv
          },
          9005,
        ),
        (err: Error) => err instanceof SupervisorError && err.code === "HostFull",
      );
      assert.equal(captured.containersCreated.length, 0);
    } finally {
      if (original === undefined) delete process.env.OC_MAX_RUNNING_CONTAINERS;
      else process.env.OC_MAX_RUNNING_CONTAINERS = original;
    }
  });

  test("env OC_MAX_RUNNING_CONTAINERS=非法值 → 回落默认 50(2 active 不挡)", async () => {
    const { docker } = makeDocker();
    seedActiveRows(2);
    const original = process.env.OC_MAX_RUNNING_CONTAINERS;
    try {
      // "abc" / "0" / "-5" / "1.5" / "" 全都视为非法 → DEFAULT_MAX_RUNNING_CONTAINERS=50,
      // 2 active < 50 → 直接放行;只跑一次 provision 验证就行(多次会 IP 撞)。
      process.env.OC_MAX_RUNNING_CONTAINERS = "abc";
      const r = await provisionV3Container(
        {
          docker,
          pool: pool as unknown as Pool,
          image: TEST_IMAGE,
          randomIp: () => "172.30.53.50",
          randomSecret: fixedSecret("6".repeat(64)),
          // 故意不注入 deps cap → 走 env → 非法 → 50 默认
        },
        9100,
      );
      assert.ok(r.containerId > 0);
      assert.equal(pool.rows.filter((x) => x.state === "active").length, 3);
    } finally {
      if (original === undefined) delete process.env.OC_MAX_RUNNING_CONTAINERS;
      else process.env.OC_MAX_RUNNING_CONTAINERS = original;
    }
  });
});

// ───────────────────────────────────────────────────────────────────────
//  V3 Phase 3I — preheatV3Image
// ───────────────────────────────────────────────────────────────────────

describe("preheatV3Image (3I)", () => {
  test("镜像已在本地 → outcome='already' 且不调 docker.pull", async () => {
    let pulled = 0;
    let inspected = 0;
    const docker = {
      getImage: (_name: string) => ({
        inspect: async () => {
          inspected++;
          return { Id: "sha256:abc" } as unknown;
        },
      }),
      pull: (_img: string, cb: (err: Error | null, s: NodeJS.ReadableStream) => void) => {
        pulled++;
        cb(new Error("should not be called"), null as unknown as NodeJS.ReadableStream);
      },
      modem: { followProgress: (_s: NodeJS.ReadableStream, cb: (e: Error | null) => void) => cb(null) },
    } as unknown as Docker;

    const { preheatV3Image } = await import("../agent-sandbox/index.js");
    const res = await preheatV3Image(docker, "openclaude/runtime:test");
    assert.equal(res.outcome, "already");
    assert.equal(res.image, "openclaude/runtime:test");
    assert.equal(inspected, 1);
    assert.equal(pulled, 0);
  });

  test("镜像不在本地 → outcome='pulled' 且 docker.pull + followProgress 都调过", async () => {
    let pulled = 0;
    let progressed = 0;
    const docker = {
      getImage: (_name: string) => ({
        inspect: async () => { throw httpError(404, "no such image"); },
      }),
      pull: (img: string, cb: (err: Error | null, s: NodeJS.ReadableStream) => void) => {
        pulled++;
        assert.equal(img, "openclaude/runtime:test");
        // 喂个空 stream
        cb(null, { } as NodeJS.ReadableStream);
      },
      modem: {
        followProgress: (_s: NodeJS.ReadableStream, cb: (e: Error | null) => void) => {
          progressed++;
          // 异步 resolve,模拟 dockerode 真实行为
          setImmediate(() => cb(null));
        },
      },
    } as unknown as Docker;

    const { preheatV3Image } = await import("../agent-sandbox/index.js");
    const res = await preheatV3Image(docker, "openclaude/runtime:test");
    assert.equal(res.outcome, "pulled");
    assert.equal(pulled, 1);
    assert.equal(progressed, 1);
  });

  test("docker.pull 抛错 → outcome='error' 不冒泡(gateway 启动不被阻断)", async () => {
    const docker = {
      getImage: (_name: string) => ({
        inspect: async () => { throw httpError(404, "no such image"); },
      }),
      pull: (_img: string, cb: (err: Error | null, s: NodeJS.ReadableStream) => void) => {
        cb(new Error("registry unreachable"), null as unknown as NodeJS.ReadableStream);
      },
      modem: { followProgress: (_s: NodeJS.ReadableStream, cb: (e: Error | null) => void) => cb(null) },
    } as unknown as Docker;

    const { preheatV3Image } = await import("../agent-sandbox/index.js");
    const res = await preheatV3Image(docker, "openclaude/runtime:test");
    assert.equal(res.outcome, "error");
    assert.match(res.error ?? "", /registry unreachable/);
  });

  test("inspect 抛非 404(daemon 不可达)→ outcome='error' 直接返回不 pull", async () => {
    let pulled = 0;
    const docker = {
      getImage: (_name: string) => ({
        inspect: async () => { throw httpError(500, "docker daemon down"); },
      }),
      pull: (_img: string, cb: (err: Error | null, s: NodeJS.ReadableStream) => void) => {
        pulled++;
        cb(null, {} as NodeJS.ReadableStream);
      },
      modem: { followProgress: (_s: NodeJS.ReadableStream, cb: (e: Error | null) => void) => cb(null) },
    } as unknown as Docker;

    const { preheatV3Image } = await import("../agent-sandbox/index.js");
    const res = await preheatV3Image(docker, "openclaude/runtime:test");
    assert.equal(res.outcome, "error");
    assert.match(res.error ?? "", /daemon down/);
    assert.equal(pulled, 0); // inspect 错的不是 404 就不 fallback 到 pull
  });

  test("空 image string → outcome='error' early return,不碰 docker", async () => {
    let touched = 0;
    const docker = {
      getImage: () => { touched++; return { inspect: async () => ({}) } as unknown as ReturnType<Docker["getImage"]>; },
      pull: () => { touched++; },
      modem: { followProgress: () => { touched++; } },
    } as unknown as Docker;

    const { preheatV3Image } = await import("../agent-sandbox/index.js");
    const res = await preheatV3Image(docker, "");
    assert.equal(res.outcome, "error");
    assert.equal(touched, 0);
  });

  test("logger 被回调:本地有 → info('image already present');pull 失败 → warn", async () => {
    const events: Array<{ lvl: string; msg: string }> = [];
    const logger = {
      info: (msg: string) => events.push({ lvl: "info", msg }),
      warn: (msg: string) => events.push({ lvl: "warn", msg }),
    };

    const dockerHit = {
      getImage: () => ({ inspect: async () => ({}) }),
      pull: () => { /* noop */ },
      modem: { followProgress: () => { /* noop */ } },
    } as unknown as Docker;
    const dockerFail = {
      getImage: () => ({ inspect: async () => { throw httpError(404, "missing"); } }),
      pull: (_img: string, cb: (err: Error | null, s: NodeJS.ReadableStream) => void) => {
        cb(new Error("net down"), null as unknown as NodeJS.ReadableStream);
      },
      modem: { followProgress: (_s: NodeJS.ReadableStream, cb: (e: Error | null) => void) => cb(null) },
    } as unknown as Docker;

    const { preheatV3Image } = await import("../agent-sandbox/index.js");
    await preheatV3Image(dockerHit, "img:1", logger);
    await preheatV3Image(dockerFail, "img:1", logger);

    assert.ok(events.find((e) => e.lvl === "info" && /already present/.test(e.msg)), "expected info log for already-present");
    assert.ok(events.find((e) => e.lvl === "warn" && /pull failed/.test(e.msg)), "expected warn log for pull failure");
  });
});

// ───────────────────────────────────────────────────────────────────────
//  wrapDockerError — node-agent AgentAppError 翻译路径
//
//  关键:RUN_FAIL + "Unable to find image" 等 docker CLI 文案 → ImageNotFound,
//  让 v3ensureRunning 走 RETRY_AFTER_IMAGE_MISSING_SEC=300 而不是 5s 风暴。
//  其它 RUN_FAIL → Unknown(保留原行为);dockerode 404 走另一分支(下面也覆盖)。
// ───────────────────────────────────────────────────────────────────────

describe("wrapDockerError — node-agent AgentAppError 路径", () => {
  test("RUN_FAIL + 'Unable to find image' → ImageNotFound (核心修复)", async () => {
    const { AgentAppError } = await import("../compute-pool/nodeAgentClient.js");
    const { wrapDockerError } = await import("../agent-sandbox/v3supervisor.js");
    const err = new AgentAppError(
      "host-uuid-1",
      500,
      "RUN_FAIL",
      "docker run failed: Unable to find image 'openclaude/openclaude-runtime:abc123' locally",
    );
    const wrapped = wrapDockerError(err);
    assert.equal(wrapped.code, "ImageNotFound");
    assert.match(wrapped.message, /Unable to find image/);
  });

  test("RUN_FAIL + 'pull access denied' → ImageNotFound", async () => {
    const { AgentAppError } = await import("../compute-pool/nodeAgentClient.js");
    const { wrapDockerError } = await import("../agent-sandbox/v3supervisor.js");
    const err = new AgentAppError("h", 500, "RUN_FAIL", "docker run failed: pull access denied for foo/bar");
    assert.equal(wrapDockerError(err).code, "ImageNotFound");
  });

  test("RUN_FAIL + 'manifest unknown' → ImageNotFound", async () => {
    const { AgentAppError } = await import("../compute-pool/nodeAgentClient.js");
    const { wrapDockerError } = await import("../agent-sandbox/v3supervisor.js");
    const err = new AgentAppError("h", 500, "RUN_FAIL", "docker pull: manifest unknown");
    assert.equal(wrapDockerError(err).code, "ImageNotFound");
  });

  test("RUN_FAIL + 'repository ... not found' → ImageNotFound", async () => {
    const { AgentAppError } = await import("../compute-pool/nodeAgentClient.js");
    const { wrapDockerError } = await import("../agent-sandbox/v3supervisor.js");
    const err = new AgentAppError("h", 500, "RUN_FAIL", "Error response: repository openclaude/foo not found");
    assert.equal(wrapDockerError(err).code, "ImageNotFound");
  });

  test("RUN_FAIL + 'No such image' → ImageNotFound (与 dockerode 4xx 同源)", async () => {
    const { AgentAppError } = await import("../compute-pool/nodeAgentClient.js");
    const { wrapDockerError } = await import("../agent-sandbox/v3supervisor.js");
    const err = new AgentAppError("h", 500, "RUN_FAIL", "docker run failed: No such image: openclaude/runtime:abc");
    assert.equal(wrapDockerError(err).code, "ImageNotFound");
  });

  test("RUN_FAIL 但文案不是 image 缺失(如 'cgroup' / 'permission denied') → Unknown", async () => {
    const { AgentAppError } = await import("../compute-pool/nodeAgentClient.js");
    const { wrapDockerError } = await import("../agent-sandbox/v3supervisor.js");
    const err = new AgentAppError("h", 500, "RUN_FAIL", "docker run failed: cgroup error");
    const wrapped = wrapDockerError(err);
    assert.equal(wrapped.code, "Unknown");
    assert.match(wrapped.message, /cgroup error/);
  });

  test("非 RUN_FAIL 的 AgentAppError(如 STOP_FAIL) → Unknown,不触发 ImageNotFound", async () => {
    const { AgentAppError } = await import("../compute-pool/nodeAgentClient.js");
    const { wrapDockerError } = await import("../agent-sandbox/v3supervisor.js");
    // 即使 message 含 "Unable to find image",code 不是 RUN_FAIL 就不归类
    const err = new AgentAppError("h", 500, "STOP_FAIL", "Unable to find image during stop");
    assert.equal(wrapDockerError(err).code, "Unknown");
  });

  test("dockerode 404 + 'No such image' 老路径未被破坏", async () => {
    const { wrapDockerError } = await import("../agent-sandbox/v3supervisor.js");
    const err = Object.assign(new Error("No such image: foo:bar"), { statusCode: 404 });
    assert.equal(wrapDockerError(err).code, "ImageNotFound");
  });

  test("dockerode 404 但文案不像 image(普通 NotFound) → NotFound", async () => {
    const { wrapDockerError } = await import("../agent-sandbox/v3supervisor.js");
    const err = Object.assign(new Error("No such container: xxx"), { statusCode: 404 });
    assert.equal(wrapDockerError(err).code, "NotFound");
  });

  test("ENOENT/ECONNREFUSED → DockerUnavailable", async () => {
    const { wrapDockerError } = await import("../agent-sandbox/v3supervisor.js");
    const err = Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" });
    assert.equal(wrapDockerError(err).code, "DockerUnavailable");
  });

  // v1.0.7 — node-agent docker run 抛宿主级冲突归 TransientHostFault,
  // v3ensureRunning 据此把 host 进 cooldown(60s),让用户 5s 重连换台。
  test("RUN_FAIL + 'Address already in use' → TransientHostFault", async () => {
    const { AgentAppError } = await import("../compute-pool/nodeAgentClient.js");
    const { wrapDockerError } = await import("../agent-sandbox/v3supervisor.js");
    const err = new AgentAppError(
      "h",
      500,
      "RUN_FAIL",
      "docker run: exit status 125: ... docker: Error response from daemon: Address already in use.",
    );
    assert.equal(wrapDockerError(err).code, "TransientHostFault");
  });

  test("RUN_FAIL + 'port is already allocated' → TransientHostFault", async () => {
    const { AgentAppError } = await import("../compute-pool/nodeAgentClient.js");
    const { wrapDockerError } = await import("../agent-sandbox/v3supervisor.js");
    const err = new AgentAppError(
      "h",
      500,
      "RUN_FAIL",
      "docker: Error response from daemon: driver failed programming external connectivity on endpoint oc-v3-u28: Bind for 0.0.0.0:18789 failed: port is already allocated",
    );
    assert.equal(wrapDockerError(err).code, "TransientHostFault");
  });

  test("RUN_FAIL + 'Conflict ... container name ... is already in use' → TransientHostFault", async () => {
    const { AgentAppError } = await import("../compute-pool/nodeAgentClient.js");
    const { wrapDockerError } = await import("../agent-sandbox/v3supervisor.js");
    const err = new AgentAppError(
      "h",
      500,
      "RUN_FAIL",
      'Conflict. The container name "/oc-v3-u28" is already in use by container "abc"',
    );
    assert.equal(wrapDockerError(err).code, "TransientHostFault");
  });

  test("ImageNotFound 文案优先于 TransientHostFault(同时命中时按 image 缺失走 5min 长重试)", async () => {
    // 防御:如果有人写了带 "Address already in use" 又含 "Unable to find image" 的怪异文案,
    // 应该优先按 image 缺失分类(它是部署级故障,5min retry 比 60s cooldown 更合适)
    const { AgentAppError } = await import("../compute-pool/nodeAgentClient.js");
    const { wrapDockerError } = await import("../agent-sandbox/v3supervisor.js");
    const err = new AgentAppError(
      "h",
      500,
      "RUN_FAIL",
      "Unable to find image 'foo:bar' locally. Address already in use",
    );
    assert.equal(wrapDockerError(err).code, "ImageNotFound");
  });
});

// ───────────────────────────────────────────────────────────────────────
//  CCB baseline (平台守则 CLAUDE.md + system-info skill 只读注入)
//
//  resolveCcbBaselineMounts:
//   - 绝对路径 + path.normalize 比较(允许尾斜杠)
//   - 每个叶子:lstat 非 symlink / 类型匹配 / root owned / 非 group/other writable
//   - SKILL.md 也必须存在
//   - 任一失败返 null
//
//  provisionV3Container 与基线的交互:
//   - 基线 OK → Binds 从 2 条变 4 条(追加两条 :ro)
//   - 基线缺失 + OC_V3_CCB_BASELINE_OPTIONAL=1 → warn + 2 条 Binds
//   - 基线缺失 + optional 未开 → 抛 SupervisorError("CcbBaselineMissing")
// ───────────────────────────────────────────────────────────────────────

/**
 * Helper — 在 os.tmpdir() 下造一个合法的 baseline 目录,chmod 成符合我们校验口径的
 * 权限(644/755,group/other 不可写)。owner 一般就是进程自己(test 跑在 root 下
 * 则是 root;普通用户跑则是 uid≠0 会被 assertBaselineLeaf 拒 —— 所以这类测试
 * 只在 root 下跑才能全绿)。如果不是 root,返回 null(跳过该分支测试)。
 *
 * 注入全部 `V3_CCB_BASELINE_SKILL_NAMES` 里的 skill(system-info + 其它 4 个),
 * 所有 SKILL.md 都写;`withAllSkillMd=false` 时故意漏第一条 skill 的 SKILL.md,
 * 用来覆盖"一条 skill 缺 SKILL.md → 整个 resolve 返 null"分支(fail-all)。
 */
function makeFakeBaseline(withAllSkillMd = true): { dir: string; cleanup: () => void } | null {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    return null;
  }
  const dir = mkdtempSync(pathJoin(tmpdir(), "ccb-baseline-test-"));
  writeFileSync(pathJoin(dir, "CLAUDE.md"), "# test baseline\n", { mode: 0o644 });
  mkdirSync(pathJoin(dir, "skills"), { mode: 0o755 });
  for (const [idx, name] of V3_CCB_BASELINE_SKILL_NAMES.entries()) {
    mkdirSync(pathJoin(dir, "skills", name), { mode: 0o755 });
    // withAllSkillMd=false 时故意漏第一条 skill 的 SKILL.md,触发 fail-closed
    if (withAllSkillMd || idx !== 0) {
      writeFileSync(
        pathJoin(dir, "skills", name, "SKILL.md"),
        `# ${name}\n`,
        { mode: 0o644 },
      );
    }
  }
  chmodSync(dir, 0o755);
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("resolveCcbBaselineMounts", () => {
  // R3 codex HIGH#2 防回归:PR3 加基线 skill 时,新目录必须真的存在于仓库里
  // (不是只 manifest 数组加了名字,但 ccb-baseline/skills/<name>/ 目录漏 git-track)。
  // 这个 test 不依赖 root,只检查仓库 checkout 下 manifest 里每条 skill 的
  // `<name>/SKILL.md` 文件是否在。如果漏带,deploy 后生产每次 provision 都会
  // fail-closed,这个 test 先在 CI / 本地 bun test 就把问题拦下。
  test("shipped ccb-baseline has every manifest skill tracked in repo", () => {
    // 从 test 文件位置反查 baseline 源:
    // packages/commercial/src/__tests__/v3Supervisor.test.ts
    //   ↑2 → packages/commercial/
    //   → agent-sandbox/ccb-baseline/
    const here = dirname(fileURLToPath(import.meta.url));
    const baselineDir = pathJoin(here, "..", "..", "agent-sandbox", "ccb-baseline");
    assert.ok(
      existsSync(pathJoin(baselineDir, "CLAUDE.md")),
      `shipped baseline CLAUDE.md missing at ${baselineDir}`,
    );
    const skillsDir = pathJoin(baselineDir, "skills");
    assert.ok(
      statSync(skillsDir).isDirectory(),
      `shipped baseline skills/ is not a directory at ${skillsDir}`,
    );
    // 仓库里 skills/ 的顶层条目 === manifest
    const shipped = new Set(readdirSync(skillsDir));
    const declared = new Set<string>(V3_CCB_BASELINE_SKILL_NAMES);
    assert.deepEqual(
      [...shipped].sort(),
      [...declared].sort(),
      `shipped skills/ (${[...shipped].join(",")}) ≠ manifest (${[...declared].join(",")})`,
    );
    // 每条 skill 都必须带 SKILL.md
    for (const name of V3_CCB_BASELINE_SKILL_NAMES) {
      const mdPath = pathJoin(skillsDir, name, "SKILL.md");
      assert.ok(existsSync(mdPath), `shipped baseline missing ${name}/SKILL.md at ${mdPath}`);
    }
  });

  test("rejects empty / non-string", () => {
    assert.equal(resolveCcbBaselineMounts(""), null);
    assert.equal(resolveCcbBaselineMounts("   "), null);
    // @ts-expect-error 测试非法输入
    assert.equal(resolveCcbBaselineMounts(null), null);
    // @ts-expect-error
    assert.equal(resolveCcbBaselineMounts(undefined), null);
    // @ts-expect-error
    assert.equal(resolveCcbBaselineMounts(123), null);
  });

  test("rejects relative path", () => {
    assert.equal(resolveCcbBaselineMounts("relative/path"), null);
    assert.equal(resolveCcbBaselineMounts("./foo"), null);
    assert.equal(resolveCcbBaselineMounts("foo"), null);
  });

  test("rejects nonexistent absolute path", () => {
    assert.equal(resolveCcbBaselineMounts("/definitely/does/not/exist/baseline"), null);
  });

  test("(root only) happy path returns CLAUDE.md + skills/ realpaths", () => {
    const b = makeFakeBaseline();
    if (!b) return; // 非 root 跳过
    try {
      const got = resolveCcbBaselineMounts(b.dir);
      assert.ok(got, "expected non-null result");
      assert.equal(got!.claudeMdHostPath, pathJoin(b.dir, "CLAUDE.md"));
      assert.equal(got!.skillsDirHostPath, pathJoin(b.dir, "skills"));
    } finally {
      b.cleanup();
    }
  });

  test("(root only) accepts trailing slash", () => {
    const b = makeFakeBaseline();
    if (!b) return;
    try {
      const got = resolveCcbBaselineMounts(b.dir + "/");
      assert.ok(got, "expected trailing-slash path to still resolve");
    } finally {
      b.cleanup();
    }
  });

  test("(root only) rejects if any one baseline skill SKILL.md is missing (fail-all)", () => {
    const b = makeFakeBaseline(false); // 故意漏第一条 skill 的 SKILL.md
    if (!b) return;
    try {
      assert.equal(resolveCcbBaselineMounts(b.dir), null);
    } finally {
      b.cleanup();
    }
  });

  test("(root only) rejects if any one baseline skill has group/other writable SKILL.md", () => {
    // parent-dir 挂载下,一条 skill 文件权限失守 = 整个 skills/ 挂进容器就暴露,
    // 所以逐条校验 owner + mode 必须覆盖每一条 SKILL.md,不能因为 skills/ 父目录
    // 本身 755+root 就给后代开放过。这里改随便一条基线 skill 的 SKILL.md 权限,
    // 期望整个 resolve 返 null。
    const b = makeFakeBaseline();
    if (!b) return;
    try {
      // 选中间一条(非 system-info)以证明不是只看第一条
      const target = V3_CCB_BASELINE_SKILL_NAMES[1]!;
      chmodSync(pathJoin(b.dir, "skills", target, "SKILL.md"), 0o664);
      assert.equal(resolveCcbBaselineMounts(b.dir), null);
    } finally {
      b.cleanup();
    }
  });

  test("(root only) rejects if any one baseline skill dir is a symlink", () => {
    // 把某条 skill 的目录换成指向另一个目录的 symlink,校验应当拒绝
    // (防 symlink 逃逸把宿主敏感目录的 SKILL.md 暴露进容器)
    const b = makeFakeBaseline();
    if (!b) return;
    try {
      const target = V3_CCB_BASELINE_SKILL_NAMES[2]!;
      const real = pathJoin(b.dir, `__real_${target}`);
      mkdirSync(real, { mode: 0o755 });
      writeFileSync(pathJoin(real, "SKILL.md"), "# x\n", { mode: 0o644 });
      rmSync(pathJoin(b.dir, "skills", target), { recursive: true });
      symlinkSync(real, pathJoin(b.dir, "skills", target));
      assert.equal(resolveCcbBaselineMounts(b.dir), null);
    } finally {
      b.cleanup();
    }
  });

  test("(root only) rejects symlinked CLAUDE.md (防 symlink 逃逸挂宿主敏感文件)", () => {
    const b = makeFakeBaseline();
    if (!b) return;
    try {
      // 把 CLAUDE.md 换成指向外部文件的 symlink
      rmSync(pathJoin(b.dir, "CLAUDE.md"));
      symlinkSync("/etc/hostname", pathJoin(b.dir, "CLAUDE.md"));
      assert.equal(resolveCcbBaselineMounts(b.dir), null);
    } finally {
      b.cleanup();
    }
  });

  test("(root only) rejects world-writable CLAUDE.md", () => {
    const b = makeFakeBaseline();
    if (!b) return;
    try {
      chmodSync(pathJoin(b.dir, "CLAUDE.md"), 0o646); // other-write
      assert.equal(resolveCcbBaselineMounts(b.dir), null);
    } finally {
      b.cleanup();
    }
  });

  test("(root only) rejects group-writable CLAUDE.md", () => {
    const b = makeFakeBaseline();
    if (!b) return;
    try {
      chmodSync(pathJoin(b.dir, "CLAUDE.md"), 0o664); // group-write
      assert.equal(resolveCcbBaselineMounts(b.dir), null);
    } finally {
      b.cleanup();
    }
  });

  // Codex R2 发现:中间目录 skills/ 未做 owner/mode 校验 → 攻击者可在校验通过后
  // 替换 system-info 路径。现在 skills/ 也被 assertBaselineLeaf 锁死。
  test("(root only) rejects world-writable intermediate skills/ dir", () => {
    const b = makeFakeBaseline();
    if (!b) return;
    try {
      chmodSync(pathJoin(b.dir, "skills"), 0o757); // other-write
      assert.equal(resolveCcbBaselineMounts(b.dir), null);
    } finally {
      b.cleanup();
    }
  });

  test("(root only) rejects symlinked intermediate skills/ dir", () => {
    const b = makeFakeBaseline();
    if (!b) return;
    try {
      // 把整个 skills/ 换成 symlink
      const realSkills = pathJoin(b.dir, "__real_skills");
      mkdirSync(realSkills, { mode: 0o755 });
      mkdirSync(pathJoin(realSkills, "system-info"), { mode: 0o755 });
      writeFileSync(pathJoin(realSkills, "system-info", "SKILL.md"), "# x\n", { mode: 0o644 });
      rmSync(pathJoin(b.dir, "skills"), { recursive: true });
      symlinkSync(realSkills, pathJoin(b.dir, "skills"));
      assert.equal(resolveCcbBaselineMounts(b.dir), null);
    } finally {
      b.cleanup();
    }
  });

  // R3 codex HIGH#1 — parent-dir 挂载的额外校验面
  // 以下几条 test 覆盖:"每条 manifest skill 都合规,但 skills/ 下多了未声明的条目 /
  // 某条 skill 目录下多了 SKILL.md 之外的内容 / SKILL.md 是 symlink"。旧逻辑(仅
  // 按 manifest 逐条 lstat)放过;新逻辑(readdir 白名单 + 严格 `["SKILL.md"]`)
  // 必须拒绝,否则 parent-dir ro 挂进容器就暴露未校验内容。

  test("(root only) rejects undeclared extra subdirectory under skills/", () => {
    const b = makeFakeBaseline();
    if (!b) return;
    try {
      // 伪造一条 rsync 漏 --delete 留下的残余 skill
      mkdirSync(pathJoin(b.dir, "skills", "__unknown_extra"), { mode: 0o755 });
      writeFileSync(
        pathJoin(b.dir, "skills", "__unknown_extra", "SKILL.md"),
        "# leaked\n",
        { mode: 0o644 },
      );
      assert.equal(resolveCcbBaselineMounts(b.dir), null);
    } finally {
      b.cleanup();
    }
  });

  test("(root only) rejects undeclared extra file under skills/", () => {
    const b = makeFakeBaseline();
    if (!b) return;
    try {
      // 手工误放的临时文件也拒
      writeFileSync(pathJoin(b.dir, "skills", "README.md"), "# stray\n", { mode: 0o644 });
      assert.equal(resolveCcbBaselineMounts(b.dir), null);
    } finally {
      b.cleanup();
    }
  });

  test("(root only) rejects if a skill dir contains an extra file beyond SKILL.md", () => {
    const b = makeFakeBaseline();
    if (!b) return;
    try {
      const target = V3_CCB_BASELINE_SKILL_NAMES[0]!;
      writeFileSync(
        pathJoin(b.dir, "skills", target, "notes.txt"),
        "stuff\n",
        { mode: 0o644 },
      );
      assert.equal(resolveCcbBaselineMounts(b.dir), null);
    } finally {
      b.cleanup();
    }
  });

  test("(root only) rejects if a skill dir contains a subdirectory", () => {
    // 未来要支持 scripts/ references/,必须显式改 manifest 校验代码扩白名单,
    // 默认一律拒 —— parent-dir 挂载时 subdir 无论权限如何都会暴露进容器。
    const b = makeFakeBaseline();
    if (!b) return;
    try {
      const target = V3_CCB_BASELINE_SKILL_NAMES[3]!;
      mkdirSync(pathJoin(b.dir, "skills", target, "scripts"), { mode: 0o755 });
      assert.equal(resolveCcbBaselineMounts(b.dir), null);
    } finally {
      b.cleanup();
    }
  });

  test("(root only) rejects if SKILL.md itself is a symlink", () => {
    // SKILL.md symlink 到宿主敏感文件,parent-dir 挂载会把 symlink 暴露进容器
    // (容器里 readlink → 宿主文件)。assertBaselineLeaf 本来就 reject symlink,
    // 这条 test 做防回归。
    const b = makeFakeBaseline();
    if (!b) return;
    try {
      const target = V3_CCB_BASELINE_SKILL_NAMES[0]!;
      const mdPath = pathJoin(b.dir, "skills", target, "SKILL.md");
      rmSync(mdPath);
      symlinkSync("/etc/hostname", mdPath);
      assert.equal(resolveCcbBaselineMounts(b.dir), null);
    } finally {
      b.cleanup();
    }
  });

  test("(root only) rejects if a manifest skill dir is group-writable", () => {
    // skills/ 父目录合规,但某条 skill 自身 mode 宽松 —— 仍然拒
    // (assertBaselineLeaf 对每条 skill 目录 owner + mode 都锁)
    const b = makeFakeBaseline();
    if (!b) return;
    try {
      const target = V3_CCB_BASELINE_SKILL_NAMES[1]!;
      chmodSync(pathJoin(b.dir, "skills", target), 0o775); // group-write
      assert.equal(resolveCcbBaselineMounts(b.dir), null);
    } finally {
      b.cleanup();
    }
  });
});

describe("provisionV3Container — CCB baseline 挂载分支", () => {
  let pool: FakePool;
  let prevDir: string | undefined;
  let prevOptional: string | undefined;

  before(() => {
    prevDir = process.env.OC_V3_CCB_BASELINE_DIR;
    prevOptional = process.env.OC_V3_CCB_BASELINE_OPTIONAL;
  });
  after(() => {
    if (prevDir === undefined) delete process.env.OC_V3_CCB_BASELINE_DIR;
    else process.env.OC_V3_CCB_BASELINE_DIR = prevDir;
    if (prevOptional === undefined) delete process.env.OC_V3_CCB_BASELINE_OPTIONAL;
    else process.env.OC_V3_CCB_BASELINE_OPTIONAL = prevOptional;
  });
  beforeEach(() => {
    pool = new FakePool();
    delete process.env.OC_V3_CCB_BASELINE_OPTIONAL;
  });

  test("baseline 缺失 + optional 未开 → 抛 CcbBaselineMissing", async () => {
    const { docker, captured } = makeDocker();
    await assert.rejects(
      provisionV3Container(
        {
          docker,
          pool: pool as unknown as Pool,
          image: TEST_IMAGE,
          randomIp: () => "172.30.6.6",
          randomSecret: fixedSecret("a".repeat(64)),
          ccbBaselineDir: "/definitely/not/a/baseline/dir",
        },
        123,
      ),
      (err: Error) => err instanceof SupervisorError && err.code === "CcbBaselineMissing",
    );
    // fail-closed:不应调用 docker.createContainer
    assert.equal(captured.containersCreated.length, 0);
  });

  test("baseline 缺失 + OC_V3_CCB_BASELINE_OPTIONAL=1 → warn 并继续(2 条 Binds)", async () => {
    process.env.OC_V3_CCB_BASELINE_OPTIONAL = "1";
    const { docker, captured } = makeDocker();
    await provisionV3Container(
      {
        docker,
        pool: pool as unknown as Pool,
        image: TEST_IMAGE,
        randomIp: () => "172.30.6.7",
        randomSecret: fixedSecret("b".repeat(64)),
        ccbBaselineDir: "/definitely/not/a/baseline/dir",
      },
      124,
    );
    const opts = captured.containersCreated[0]!;
    // 只有 data + projects 两条 volume bind(没追加 baseline ro)
    assert.deepEqual(opts.HostConfig?.Binds, [
      `oc-v3-data-u124:${V3_VOLUME_MOUNT}:rw`,
      `oc-v3-proj-u124:${V3_PROJECTS_MOUNT}:rw`,
    ]);
  });

  test("(root only) baseline 齐全 → 4 条 Binds(2 volume + CLAUDE.md + skills 父目录)", async () => {
    const b = makeFakeBaseline();
    if (!b) return; // 非 root 跳过
    try {
      const { docker, captured } = makeDocker();
      await provisionV3Container(
        {
          docker,
          pool: pool as unknown as Pool,
          image: TEST_IMAGE,
          randomIp: () => "172.30.6.8",
          randomSecret: fixedSecret("c".repeat(64)),
          ccbBaselineDir: b.dir,
        },
        125,
      );
      const opts = captured.containersCreated[0]!;
      assert.deepEqual(opts.HostConfig?.Binds, [
        `oc-v3-data-u125:${V3_VOLUME_MOUNT}:rw`,
        `oc-v3-proj-u125:${V3_PROJECTS_MOUNT}:rw`,
        `${pathJoin(b.dir, "CLAUDE.md")}:${V3_CONFIG_TMPFS_PATH}/CLAUDE.md:ro`,
        // 挂 skills/ 整目录;父目录 ro 一次性覆盖所有基线 skill,
        // 新增基线 skill 不改这里,只加一条 V3_CCB_BASELINE_SKILL_NAMES 即可。
        `${pathJoin(b.dir, "skills")}:${V3_CONFIG_TMPFS_PATH}/skills:ro`,
      ]);
    } finally {
      b.cleanup();
    }
  });
});
