/**
 * V5 runtime tuple —— runtimeStale 三维判定 + provision 侧硬门(多机 release / 瘦身镜像)单测。
 *
 * runtimeStale(泛化自旧 imageStale,plan §1.4):
 *   stale = imageStale(优先 immutable ID,缺 desired.imageId 回落 tag)
 *         ∨ release label ≠ desired ∨ boot_hash label ≠ desired
 *
 * 覆盖(通过 makeV3EnsureRunning,以 coldStart / stopped 观测回收 vs warm 复用):
 *   - 三元组全 match → warm 复用
 *   - 仅 imageId / 仅 release / 仅 boot_hash 不符 → 回收;组合不符 → 回收
 *   - label 缺失 + desired 非空 → 回收(fail toward converge)
 *   - desired 空(未配 tuple)+ 同 tag → 不回收;+ 不同 tag → 回收(tag 回落,旧行为)
 *   - 同 tag 不同 imageId(desired.imageId 设)→ 回收(不可变 ID 击穿 tag)
 *
 * provision 硬门(直接调 provisionV3Container):
 *   - 多机 + OC_RUNTIME_RELEASE → 拒
 *   - 瘦身镜像(embed_source=0)+ 空 release → 拒;胖镜像 + 空 release → 通过
 *
 * 运行:npx tsx --test packages/commercial/src/__tests__/runtimeStale.test.ts
 *
 * 判定用 runtimeChannelForTest:"v3" 关掉 v5 drain/延迟状态机(既有状态机不动,本组只验判定输入);
 * 实际 OC_RUNTIME_CHANNEL=v5(provision 跳过 v3MayServe 的 DB 依赖)+ OPTIONAL 降级避免 bundle/baseline 阻断。
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import type Docker from "dockerode";
import type { Pool, PoolClient } from "pg";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  makeV3EnsureRunning,
  provisionV3Container,
  V3_CONTAINER_PORT,
  SupervisorError,
  RUNTIME_RELEASE_LABEL_KEY,
  RUNTIME_BOOT_HASH_LABEL_KEY,
  RUNTIME_EMBED_SOURCE_LABEL_KEY,
  RELEASE_MOUNT_TARGET,
  OPENCLAUDE_DEFAULT_WORKSPACE_VALUE,
  V3_CCB_BASELINE_SKILL_NAMES,
  type V3SupervisorDeps,
  type V3RuntimeTuple,
  type SyntheticEvalOverlayRuntime,
} from "../agent-sandbox/index.js";
import {
  SYNTHETIC_EVAL_MANIFEST_LABEL,
  SYNTHETIC_EVAL_NONCE_LABEL,
  SYNTHETIC_EVAL_SCRATCH_TMPFS_OPTIONS,
  SYNTHETIC_EVAL_SCRATCH_TMPFS_TARGETS,
  SYNTHETIC_EVAL_UID_LABEL,
  syntheticEvalOverlayLabels,
  type SyntheticEvalOverlaySpec,
} from "../agent-sandbox/syntheticEvalOverlay.js";
import { ContainerUnreadyError } from "../ws/userChatBridge.js";

const TEST_HOST = "11111111-1111-1111-1111-111111111111";
const TEST_HOST_ALT = "22222222-2222-2222-2222-222222222222";
const DEFAULT_TEST_HOST_MAX = 999;
const TEST_IMAGE = "openclaude/openclaude-runtime:test";

// ───────────────────────────────────────────────────────────────────────
//  Fake pg.Pool(覆盖 status / provision / cap / migration 各 SQL)
// ───────────────────────────────────────────────────────────────────────

type FakeRow = {
  id: number;
  user_id: number;
  host_uuid: string | null;
  bound_ip: string;
  secret_hash: Buffer;
  state: "active" | "vanished";
  port: number;
  image: string;
  container_internal_id: string | null;
  codex_account_id?: string | null;
  last_ws_activity: Date | null;
  created_at: Date;
  updated_at: Date;
};

class FakePool {
  rows: FakeRow[] = [];
  nextId = 1;
  insertCount = 0;

  preInsertActive(uid: number, boundIp: string, dockerId: string): FakeRow {
    const now = new Date();
    const row: FakeRow = {
      id: this.nextId++,
      user_id: uid,
      host_uuid: TEST_HOST,
      bound_ip: boundIp,
      secret_hash: Buffer.alloc(32, 0xaa),
      state: "active",
      port: V3_CONTAINER_PORT,
      image: TEST_IMAGE,
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
    return {
      async query(sql: string, params?: unknown[]) { return self.runQuery(sql, params); },
      release() {},
    } as unknown as PoolClient;
  }
  async query(sql: string, params?: unknown[]): Promise<unknown> { return this.runQuery(sql, params); }
  end(): Promise<void> { return Promise.resolve(); }

  private runQuery(sql: string, params?: unknown[]): unknown {
    const t = String(sql).trim();
    if (/^BEGIN/i.test(t) || /^COMMIT/i.test(t) || /^ROLLBACK/i.test(t)) return { rowCount: 0, rows: [] };
    if (/^SELECT pg_advisory_xact_lock/i.test(t)) return { rowCount: 0, rows: [] };
    if (/INSERT INTO agent_containers/i.test(t)) {
      this.insertCount++;
      const userId = Number.parseInt(String(params![0]), 10);
      const hostUuid = params![1] == null ? null : String(params![1]);
      const boundIp = String(params![2]);
      const id = this.nextId++;
      const now = new Date();
      this.rows.push({
        id, user_id: userId, host_uuid: hostUuid, bound_ip: boundIp,
        secret_hash: params![3] as Buffer, state: "active", port: Number(params![4]),
        image: String(params![5]), container_internal_id: null, codex_account_id: null,
        last_ws_activity: now, created_at: now, updated_at: now,
      });
      return { rowCount: 1, rows: [{ id: String(id) }] };
    }
    if (/UPDATE agent_containers/i.test(t) && /SET container_internal_id/i.test(t)) {
      const id = Number.parseInt(String(params![0]), 10);
      const r = this.rows.find((x) => x.id === id && x.state === "active");
      if (r) { r.container_internal_id = String(params![1]); }
      return { rowCount: r ? 1 : 0, rows: [] };
    }
    if (/UPDATE agent_containers/i.test(t) && /SET state\s*=\s*'vanished'/i.test(t)) {
      const id = Number.parseInt(String(params![0]), 10);
      const r = this.rows.find((x) => x.id === id);
      if (r) r.state = "vanished";
      const returnsHost = /RETURNING\s+host_uuid/i.test(t);
      return { rowCount: r ? 1 : 0, rows: r && returnsHost ? [{ host_uuid: r.host_uuid }] : [] };
    }
    // findOpenByUser(INV-3)—— FakePool 不建 agent_migrations,恒 0 行。
    if (/FROM agent_containers c/i.test(t) && /JOIN agent_migrations m/i.test(t)) {
      return { rowCount: 0, rows: [] };
    }
    if (/SELECT id, user_id,\s*host\(bound_ip\)/i.test(t) && /WHERE user_id/i.test(t)) {
      const userId = Number.parseInt(String(params![0]), 10);
      const r = this.rows.find((x) => x.user_id === userId && x.state === "active");
      if (!r) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [{
        id: String(r.id), user_id: String(r.user_id), bound_ip: r.bound_ip, port: r.port,
        container_internal_id: r.container_internal_id, host_uuid: r.host_uuid,
        created_at: r.created_at, last_ws_activity: r.last_ws_activity,
      }] };
    }
    if (/SELECT id::text AS id FROM agent_containers/i.test(t) && /state = 'active' AND runtime_channel/i.test(t)) {
      const userId = Number.parseInt(String(params![0]), 10);
      const r = this.rows.find((x) => x.user_id === userId && x.state === "active");
      return r ? { rowCount: 1, rows: [{ id: String(r.id) }] } : { rowCount: 0, rows: [] };
    }
    if (/SELECT COUNT\(\*\) FROM agent_containers/i.test(t) && /max_containers FROM compute_hosts/i.test(t)) {
      const hostUuid = String(params![0]);
      const active = this.rows.filter((x) => x.state === "active" && x.host_uuid === hostUuid).length;
      return { rowCount: 1, rows: [{ active: String(active), max_containers: DEFAULT_TEST_HOST_MAX }] };
    }
    throw new Error(`FakePool: unhandled SQL: ${t.slice(0, 160)}`);
  }
}

// ───────────────────────────────────────────────────────────────────────
//  Fake docker —— 运行容器 inspect 回 { Image(ID), Config.Image(tag), Config.Labels }
// ───────────────────────────────────────────────────────────────────────

type DockerBehavior = {
  /** 运行容器 inspect:top-level Image(immutable ID)。 */
  runningImageId?: string;
  /** 运行容器 inspect:Config.Image(tag),默认匹配 deps.image(不触发 tag stale)。 */
  runningTag?: string;
  /** 运行容器 inspect:Config.Labels(含 runtime label)。 */
  runningLabels?: Record<string, string>;
  /** 镜像 inspect labels(assertImageHasV3Sink / slim guard)。默认含 v3-sink。 */
  imageLabels?: Record<string, string>;
};
type CreateOptsShape = {
  Env?: string[];
  Labels?: Record<string, string>;
  HostConfig?: { Binds?: string[] };
};
type DockerCaptured = {
  created: number;
  started: number;
  stopped: number;
  removed: number;
  /** R2-B3:最后一次 docker createContainer 的 opts(断言 Env / Binds 注入)。 */
  lastCreateOpts?: CreateOptsShape;
};

function httpError(code: number, msg: string): Error {
  const e = new Error(msg) as Error & { statusCode: number };
  e.statusCode = code;
  return e;
}

function makeDocker(b: DockerBehavior = {}): { docker: Docker; captured: DockerCaptured } {
  const captured: DockerCaptured = { created: 0, started: 0, stopped: 0, removed: 0 };
  const docker = {
    createVolume: async () => ({}),
    getVolume: (name: string) => ({
      inspect: async () => ({
        Name: name, Driver: "local",
        Labels: {
          "com.openclaude.v3.managed": "1",
          "com.openclaude.v3.uid": name.replace(/^oc-v[35]-(data|proj|codex|userlocal|userconfig)-u/, ""),
        },
      }),
      remove: async () => {},
    }),
    getImage: (tag: string) => ({
      inspect: async () => ({
        Id: "sha256:fakeimage", RepoTags: [tag],
        Config: { Labels: b.imageLabels ?? { "oc.runtime.features": "v3-sink" } },
      }),
    }),
    createContainer: async (opts: CreateOptsShape) => {
      captured.created++;
      captured.lastCreateOpts = opts;
      const id = captured.created.toString(16).padStart(64, "0");
      return { id, start: async () => { captured.started++; }, remove: async () => { captured.removed++; } };
    },
    getContainer: (_id: string) => ({
      inspect: async () => ({
        Id: _id,
        Image: b.runningImageId ?? "sha256:running",
        State: { Running: true, Status: "running" },
        Config: { Image: b.runningTag ?? TEST_IMAGE, Labels: b.runningLabels ?? {} },
      }),
      stop: async () => { captured.stopped++; },
      remove: async () => { captured.removed++; },
    }),
  } as unknown as Docker;
  return { docker, captured };
}

function makeDeps(docker: Docker, pool: FakePool, tuple?: V3RuntimeTuple): V3SupervisorDeps {
  return {
    docker, pool: pool as unknown as Pool, image: TEST_IMAGE, selfHostId: TEST_HOST,
    randomIp: () => "172.31.5.42", randomSecret: () => "a".repeat(64),
    ...(tuple ? { runtimeTuple: tuple } : {}),
  };
}

const noSleep = async (_ms: number) => Promise.resolve();
const fixedNow = () => 1_000_000;

/** ensureRunning，runtimeChannelForTest="v3" 关 drain 状态机 → stale 即立刻回收。 */
function makeEnsure(deps: V3SupervisorDeps) {
  return makeV3EnsureRunning(deps, {
    probeHealthz: async () => true,
    probeWsUpgrade: async () => true,
    sleep: noSleep,
    now: fixedNow,
    runtimeChannelForTest: "v3",
  });
}

// ───────────────────────────────────────────────────────────────────────

describe("runtimeStale 判定", () => {
  let savedChannel: string | undefined;
  let savedBundleOpt: string | undefined;
  let savedBaselineOpt: string | undefined;
  before(() => {
    savedChannel = process.env.OC_RUNTIME_CHANNEL;
    savedBundleOpt = process.env.OC_PLATFORM_BUNDLE_OPTIONAL;
    savedBaselineOpt = process.env.OC_V3_CCB_BASELINE_OPTIONAL;
    process.env.OC_RUNTIME_CHANNEL = "v5"; // provision 跳过 v3MayServe 的 DB 依赖
    process.env.OC_PLATFORM_BUNDLE_OPTIONAL = "1"; // reprovision 不因缺 bundle fail-closed
    process.env.OC_V3_CCB_BASELINE_OPTIONAL = "1";
  });
  after(() => {
    const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
    restore("OC_RUNTIME_CHANNEL", savedChannel);
    restore("OC_PLATFORM_BUNDLE_OPTIONAL", savedBundleOpt);
    restore("OC_V3_CCB_BASELINE_OPTIONAL", savedBaselineOpt);
  });

  const RELEASE_PATH = "/var/lib/openclaude-v5/runtime-releases/rel-abc123def456";
  const RELEASE_BASENAME = "rel-abc123def456";
  const BOOT = "boot00001111";
  const IMAGE_ID = "sha256:desiredimage";
  // desired 三元组齐全的 tuple。releaseResolvedPath 与 releasePath 同值 —— B3 门要求
  // release 已配置(raw)则必须已解析(否则 reprovision 会被 RuntimeReleaseInvalid 无条件拦掉)。
  const fullTuple = (): V3RuntimeTuple => ({
    imageId: IMAGE_ID,
    releasePath: RELEASE_PATH,
    releaseResolvedPath: RELEASE_PATH,
    bootHash: BOOT,
  });
  // 与 fullTuple 匹配的运行容器 label(release / boot_hash 走 label)。
  const matchingLabels = (): Record<string, string> => ({
    [RUNTIME_RELEASE_LABEL_KEY]: RELEASE_BASENAME,
    [RUNTIME_BOOT_HASH_LABEL_KEY]: BOOT,
  });

  test("三元组全 match → warm 复用(不回收)", async () => {
    const pool = new FakePool();
    pool.preInsertActive(1, "172.31.1.1", "dockerid-pre-1");
    const { docker, captured } = makeDocker({ runningImageId: IMAGE_ID, runningLabels: matchingLabels() });
    const ep = await makeEnsure(makeDeps(docker, pool, fullTuple()))(1n);
    assert.equal(ep.coldStart, false, "全 match 应 warm 复用");
    assert.equal(captured.stopped, 0);
    assert.equal(captured.created, 0);
  });

  test("仅 imageId 不符(不可变 ID)→ 回收", async () => {
    const pool = new FakePool();
    pool.preInsertActive(2, "172.31.1.2", "dockerid-pre-2");
    const { docker, captured } = makeDocker({ runningImageId: "sha256:OLD", runningLabels: matchingLabels() });
    const ep = await makeEnsure(makeDeps(docker, pool, fullTuple()))(2n);
    assert.equal(ep.coldStart, true, "imageId 不符应回收重建");
    assert.ok(captured.stopped >= 1 && captured.created >= 1);
  });

  test("同 tag 不同 imageId → 回收(不可变 ID 击穿 tag)", async () => {
    const pool = new FakePool();
    pool.preInsertActive(3, "172.31.1.3", "dockerid-pre-3");
    // Config.Image == deps.image(tag 相同,tag 回落判不出),但 Image(ID) != desired.imageId。
    const { docker, captured } = makeDocker({
      runningTag: TEST_IMAGE, runningImageId: "sha256:OLD", runningLabels: matchingLabels(),
    });
    const ep = await makeEnsure(makeDeps(docker, pool, fullTuple()))(3n);
    assert.equal(ep.coldStart, true, "同 tag 换镜像也应按 ID 判 stale");
    assert.ok(captured.stopped >= 1);
  });

  test("仅 release label 不符 → 回收", async () => {
    const pool = new FakePool();
    pool.preInsertActive(4, "172.31.1.4", "dockerid-pre-4");
    const { docker, captured } = makeDocker({
      runningImageId: IMAGE_ID,
      runningLabels: { [RUNTIME_RELEASE_LABEL_KEY]: "rel-oldoldoldold", [RUNTIME_BOOT_HASH_LABEL_KEY]: BOOT },
    });
    const ep = await makeEnsure(makeDeps(docker, pool, fullTuple()))(4n);
    assert.equal(ep.coldStart, true);
    assert.ok(captured.stopped >= 1);
  });

  test("仅 boot_hash label 不符 → 回收", async () => {
    const pool = new FakePool();
    pool.preInsertActive(5, "172.31.1.5", "dockerid-pre-5");
    const { docker, captured } = makeDocker({
      runningImageId: IMAGE_ID,
      runningLabels: { [RUNTIME_RELEASE_LABEL_KEY]: RELEASE_BASENAME, [RUNTIME_BOOT_HASH_LABEL_KEY]: "bootZZZZ0000" },
    });
    const ep = await makeEnsure(makeDeps(docker, pool, fullTuple()))(5n);
    assert.equal(ep.coldStart, true);
    assert.ok(captured.stopped >= 1);
  });

  test("label 缺失 + desired 非空 → 回收(fail toward converge)", async () => {
    const pool = new FakePool();
    pool.preInsertActive(6, "172.31.1.6", "dockerid-pre-6");
    // 运行容器无 runtime label(旧容器)但 imageId match → 仅靠 label 缺失即判 stale。
    const { docker, captured } = makeDocker({ runningImageId: IMAGE_ID, runningLabels: {} });
    const ep = await makeEnsure(makeDeps(docker, pool, fullTuple()))(6n);
    assert.equal(ep.coldStart, true, "release/boot_hash label 缺失 + desired 非空应回收");
    assert.ok(captured.stopped >= 1);
  });

  test("组合不符(imageId + release)→ 回收", async () => {
    const pool = new FakePool();
    pool.preInsertActive(7, "172.31.1.7", "dockerid-pre-7");
    const { docker, captured } = makeDocker({
      runningImageId: "sha256:OLD",
      runningLabels: { [RUNTIME_RELEASE_LABEL_KEY]: "rel-xxxxxxxxxxxx", [RUNTIME_BOOT_HASH_LABEL_KEY]: BOOT },
    });
    const ep = await makeEnsure(makeDeps(docker, pool, fullTuple()))(7n);
    assert.equal(ep.coldStart, true);
    assert.ok(captured.stopped >= 1);
  });

  test("未配 tuple + 同 tag → 不回收(旧行为)", async () => {
    const pool = new FakePool();
    pool.preInsertActive(8, "172.31.1.8", "dockerid-pre-8");
    // 无 runtimeTuple → desired 全空 → tag 回落;Config.Image == deps.image → 不 stale。
    const { docker, captured } = makeDocker({ runningTag: TEST_IMAGE });
    const ep = await makeEnsure(makeDeps(docker, pool))(8n);
    assert.equal(ep.coldStart, false, "无 tuple + 同 tag 应 warm 复用");
    assert.equal(captured.stopped, 0);
  });

  test("未配 tuple + 不同 tag → 回收(tag 回落,旧 imageStale)", async () => {
    const pool = new FakePool();
    pool.preInsertActive(9, "172.31.1.9", "dockerid-pre-9");
    const { docker, captured } = makeDocker({ runningTag: "openclaude/openclaude-runtime:OLDTAG" });
    const ep = await makeEnsure(makeDeps(docker, pool))(9n);
    assert.equal(ep.coldStart, true, "无 tuple + 不同 tag 应按 tag 回收(旧行为保留)");
    assert.ok(captured.stopped >= 1);
  });
});

// ───────────────────────────────────────────────────────────────────────
//  provision 侧硬门:多机 + release / 瘦身镜像 + 空 release
// ───────────────────────────────────────────────────────────────────────

describe("provision 硬门:多机 release / 瘦身镜像", () => {
  let savedChannel: string | undefined;
  let savedBaselineOpt: string | undefined;
  let savedBundleOpt: string | undefined;
  before(() => {
    savedChannel = process.env.OC_RUNTIME_CHANNEL;
    savedBaselineOpt = process.env.OC_V3_CCB_BASELINE_OPTIONAL;
    savedBundleOpt = process.env.OC_PLATFORM_BUNDLE_OPTIONAL;
    process.env.OC_RUNTIME_CHANNEL = "v5";
    process.env.OC_V3_CCB_BASELINE_OPTIONAL = "1";
    process.env.OC_PLATFORM_BUNDLE_OPTIONAL = "1";
  });
  after(() => {
    const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
    restore("OC_RUNTIME_CHANNEL", savedChannel);
    restore("OC_V3_CCB_BASELINE_OPTIONAL", savedBaselineOpt);
    restore("OC_PLATFORM_BUNDLE_OPTIONAL", savedBundleOpt);
  });

  // 最小 containerService stub(仅供 useRemote 判定成立 + 不实际调用)。
  const fakeContainerService = {
    ensureVolume: async () => {}, removeVolume: async () => {}, inspectVolume: async () => ({ exists: false }),
    createAndStart: async () => ({ containerInternalId: "x" }), stop: async () => {}, remove: async () => {},
    inspect: async () => ({ id: "x", state: "running", startedAt: null, finishedAt: null, exitCode: null, oomKilled: false, boundIp: "" }),
    inspectImage: async () => ({ id: "sha256:x", repoTags: [], labels: { "oc.runtime.features": "v3-sink" } }),
    isRemote: async () => true, resolveBaselinePaths: async () => ({ agentsMdHostPath: "", claudeMdHostPath: "", skillsDirHostPath: "" }),
  } as unknown as V3SupervisorDeps["containerService"];

  test("多机(remote host)+ OC_RUNTIME_RELEASE → 拒 provision", async () => {
    const pool = new FakePool();
    const { docker } = makeDocker();
    const deps: V3SupervisorDeps = {
      docker, pool: pool as unknown as Pool, image: TEST_IMAGE,
      selfHostId: TEST_HOST, containerService: fakeContainerService,
      randomIp: () => "172.31.5.99", randomSecret: () => "a".repeat(64),
      runtimeTuple: { releasePath: "/var/lib/openclaude-v5/runtime-releases/rel-abc123def456" },
    };
    await assert.rejects(
      // hostId=TEST_HOST_ALT(≠ selfHostId)→ useRemote=true。
      provisionV3Container(deps, 100, TEST_HOST_ALT, "172.31.5.99", "172.31.0.0/24"),
      (err: unknown) =>
        err instanceof SupervisorError &&
        err.code === "RuntimePlacementInvalid" &&
        /release requires self-host/i.test(err.message),
    );
    assert.equal(pool.rows.length, 0, "gate 早于 BEGIN,无占位行");
  });

  test("B3:release 已配置(raw)但启动期未解析(releaseResolvedPath 空)→ 无条件拒(RuntimeReleaseInvalid)", async () => {
    const pool = new FakePool();
    // 胖镜像 —— 排除瘦身护栏干扰,专测 B3 的 configured&&!resolved 门。
    const { docker } = makeDocker({ imageLabels: { "oc.runtime.features": "v3-sink" } });
    const deps: V3SupervisorDeps = {
      docker, pool: pool as unknown as Pool, image: TEST_IMAGE, selfHostId: TEST_HOST,
      randomIp: () => "172.31.5.77", randomSecret: () => "a".repeat(64),
      // releasePath 配了但 releaseResolvedPath 缺 —— 模拟 index.ts 启动期解析失败留空。
      runtimeTuple: { releasePath: "/var/lib/openclaude-v5/runtime-releases/rel-abc123def456" },
    };
    // OC_PLATFORM_BUNDLE_OPTIONAL=1 对 release **无效**(release 无逃生口)→ 仍拒。
    await assert.rejects(
      provisionV3Container(deps, 103),
      (err: unknown) =>
        err instanceof SupervisorError &&
        err.code === "RuntimeReleaseInvalid" &&
        /not resolved at startup/i.test(err.message),
    );
    assert.equal(pool.rows.length, 0, "gate 早于 BEGIN,无占位行");
  });

  test("瘦身镜像(embed_source=0)+ 空 release → 拒 provision", async () => {
    const pool = new FakePool();
    const { docker } = makeDocker({
      imageLabels: { "oc.runtime.features": "v3-sink", [RUNTIME_EMBED_SOURCE_LABEL_KEY]: "0" },
    });
    const deps = makeDeps(docker, pool); // 无 runtimeTuple → releasePath 空
    await assert.rejects(
      provisionV3Container(deps, 101),
      (err: unknown) =>
        err instanceof SupervisorError && err.code === "InvalidArgument" && /embed_source=0.*OC_RUNTIME_RELEASE|requires OC_RUNTIME_RELEASE/i.test(err.message),
    );
    assert.equal(pool.rows.length, 0, "gate 早于 BEGIN,无占位行");
  });

  test("胖镜像(无 embed_source label)+ 空 release → 通过瘦身护栏(照常 provision)", async () => {
    const pool = new FakePool();
    const { docker, captured } = makeDocker({ imageLabels: { "oc.runtime.features": "v3-sink" } });
    const deps = makeDeps(docker, pool);
    const r = await provisionV3Container(deps, 102);
    assert.equal(r.userId, 102);
    assert.equal(captured.created, 1);
    assert.equal(captured.started, 1);
  });
});

describe("R2-B3:workspace env 绑 release 轴(bundle 未启用也注入,离开只读源码树)", () => {
  let savedChannel: string | undefined;
  let savedBaselineOpt: string | undefined;
  let savedBundleOpt: string | undefined;
  before(() => {
    savedChannel = process.env.OC_RUNTIME_CHANNEL;
    savedBaselineOpt = process.env.OC_V3_CCB_BASELINE_OPTIONAL;
    savedBundleOpt = process.env.OC_PLATFORM_BUNDLE_OPTIONAL;
    process.env.OC_RUNTIME_CHANNEL = "v5";
    process.env.OC_V3_CCB_BASELINE_OPTIONAL = "1";
    process.env.OC_PLATFORM_BUNDLE_OPTIONAL = "1";
  });
  after(() => {
    const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
    restore("OC_RUNTIME_CHANNEL", savedChannel);
    restore("OC_V3_CCB_BASELINE_OPTIONAL", savedBaselineOpt);
    restore("OC_PLATFORM_BUNDLE_OPTIONAL", savedBundleOpt);
  });

  const RELEASE_PATH = "/var/lib/openclaude-v5/runtime-releases/rel-abc123def456";

  test("release-only(瘦身镜像 + release 配齐、无 bundle)→ Env 含 OPENCLAUDE_DEFAULT_WORKSPACE,不含 bundle 三 env;Binds 含 release 挂载", async () => {
    const pool = new FakePool();
    // 瘦身镜像(embed_source=0)+ release 配齐 = 生产 release 轴激活的真实形态。
    const { docker, captured } = makeDocker({
      imageLabels: { "oc.runtime.features": "v3-sink", [RUNTIME_EMBED_SOURCE_LABEL_KEY]: "0" },
    });
    const deps = makeDeps(docker, pool, { releasePath: RELEASE_PATH, releaseResolvedPath: RELEASE_PATH });
    await provisionV3Container(deps, 200);
    assert.equal(captured.created, 1);

    const env = captured.lastCreateOpts?.Env ?? [];
    const binds = captured.lastCreateOpts?.HostConfig?.Binds ?? [];

    // release 轴:workspace env 必须在(/opt/openclaude 变 ro,默认 cwd 须离开只读树)。
    assert.ok(
      env.includes(`OPENCLAUDE_DEFAULT_WORKSPACE=${OPENCLAUDE_DEFAULT_WORKSPACE_VALUE}`),
      "workspace env 必须随 release 轴注入",
    );
    // bundle 三 env 必须不在(bundle 未启用 → 绝不注入 PROMPTS_DIR / WEB_CONTEXT_BIN / BUNDLE_REV)。
    assert.ok(!env.some((e) => e.startsWith("OPENCLAUDE_PLATFORM_PROMPTS_DIR=")), "bundle 未启用 → 无 PROMPTS_DIR");
    assert.ok(!env.some((e) => e.startsWith("OPENCLAUDE_WEB_CONTEXT_BIN=")), "bundle 未启用 → 无 WEB_CONTEXT_BIN");
    assert.ok(!env.some((e) => e.startsWith("OC_PLATFORM_BUNDLE_REV=")), "bundle 未启用 → 无 BUNDLE_REV");
    // release 挂载 bind 必须在(/opt/openclaude:ro)。
    assert.ok(
      binds.includes(`${RELEASE_PATH}:${RELEASE_MOUNT_TARGET}:ro`),
      "release 挂载 bind 必须在",
    );
  });
});

describe("V5 synthetic exact-eval overlay container wiring", () => {
  let savedChannel: string | undefined;
  let savedBaselineOpt: string | undefined;
  let stableBaseline = "";
  let overlaySpec: SyntheticEvalOverlaySpec;
  before(() => {
    savedChannel = process.env.OC_RUNTIME_CHANNEL;
    savedBaselineOpt = process.env.OC_V3_CCB_BASELINE_OPTIONAL;
    process.env.OC_RUNTIME_CHANNEL = "v5";
    process.env.OC_V3_CCB_BASELINE_OPTIONAL = "0";
    stableBaseline = mkdtempSync(join(tmpdir(), "v5-synthetic-baseline-"));
    writeFileSync(join(stableBaseline, "AGENTS.md"), "# test agents\n", {
      mode: 0o644,
    });
    writeFileSync(join(stableBaseline, "CLAUDE.md"), "# test claude\n", {
      mode: 0o644,
    });
    const skillsDir = join(stableBaseline, "skills");
    mkdirSync(skillsDir, { mode: 0o755 });
    for (const name of V3_CCB_BASELINE_SKILL_NAMES) {
      const skillDir = join(skillsDir, name);
      mkdirSync(skillDir, { mode: 0o755 });
      writeFileSync(join(skillDir, "SKILL.md"), `# ${name}\n`, {
        mode: 0o644,
      });
    }
    overlaySpec = {
      uid: 247,
      nonce: "1".repeat(32),
      manifestSha: "a".repeat(64),
      candidateTreePath: "/var/lib/openclaude-v5/synthetic-eval-overlay/a/tree",
      promptsHostPath: "/var/lib/openclaude-v5/synthetic-eval-overlay/a/tree/prompts",
      promptSlotsHostPath: "/var/lib/openclaude-v5/synthetic-eval-overlay/a/tree/promptSlots.ts",
      baselineHostPath: stableBaseline,
    };
  });
  after(() => {
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore("OC_RUNTIME_CHANNEL", savedChannel);
    restore("OC_V3_CCB_BASELINE_OPTIONAL", savedBaselineOpt);
    rmSync(stableBaseline, { recursive: true, force: true });
  });
  function fakeOverlay(
    prepared: boolean,
    onActivate: (containerId: string) => void = () => undefined,
  ): SyntheticEvalOverlayRuntime {
    return {
      resolvePrepared: (uid) => prepared && uid === 247 ? overlaySpec : null,
      activatePrepared: (_spec, containerId) => onActivate(containerId),
      classifyContainer: () => ({ mode: "standard" }),
      labels: syntheticEvalOverlayLabels,
    };
  }

  test("prepared synthetic UID gets exact prompt/baseline binds, env, labels and activation", async () => {
    const pool = new FakePool();
    const { docker, captured } = makeDocker();
    let activated = "";
    const deps = makeDeps(docker, pool);
    deps.syntheticEvalOverlay = fakeOverlay(true, (id) => { activated = id; });
    await provisionV3Container(deps, 247);

    const opts = captured.lastCreateOpts!;
    const env = opts.Env ?? [];
    const binds = opts.HostConfig?.Binds ?? [];
    assert.deepEqual(
      env.filter((item) => item.startsWith("OPENCLAUDE_PLATFORM_PROMPTS_DIR=")),
      ["OPENCLAUDE_PLATFORM_PROMPTS_DIR=/run/oc/synthetic-eval/prompts"],
    );
    assert.ok(binds.includes(
      `${overlaySpec.promptsHostPath}:/run/oc/synthetic-eval/prompts:ro`,
    ));
    assert.ok(binds.includes(
      `${overlaySpec.promptSlotsHostPath}:/opt/openclaude/packages/gateway/src/promptSlots.ts:ro`,
    ));
    assert.ok(binds.includes(
      `${stableBaseline}/AGENTS.md:/opt/openclaude/AGENTS.md:ro`,
    ));
    assert.equal(opts.Labels?.[SYNTHETIC_EVAL_MANIFEST_LABEL], overlaySpec.manifestSha);
    assert.equal(opts.Labels?.[SYNTHETIC_EVAL_NONCE_LABEL], overlaySpec.nonce);
    assert.equal(opts.Labels?.[SYNTHETIC_EVAL_UID_LABEL], "247");
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(
          (opts.HostConfig as { Tmpfs?: Record<string, string> } | undefined)
            ?.Tmpfs ?? {},
        )
          .filter(([target]) =>
            SYNTHETIC_EVAL_SCRATCH_TMPFS_TARGETS.includes(
              target as (typeof SYNTHETIC_EVAL_SCRATCH_TMPFS_TARGETS)[number],
            )
          ),
      ),
      Object.fromEntries(
        SYNTHETIC_EVAL_SCRATCH_TMPFS_TARGETS.map((target) => [
          target,
          SYNTHETIC_EVAL_SCRATCH_TMPFS_OPTIONS,
        ]),
      ),
    );
    assert.equal(activated, "1".padStart(64, "0"));
  });

  test("injected runtime remains byte-identical for a non-synthetic UID", async () => {
    const plainPool = new FakePool();
    const wiredPool = new FakePool();
    const plain = makeDocker();
    const wired = makeDocker();
    const plainDeps = makeDeps(plain.docker, plainPool);
    plainDeps.ccbBaselineDir = stableBaseline;
    await provisionV3Container(plainDeps, 123);
    const wiredDeps = makeDeps(wired.docker, wiredPool);
    wiredDeps.ccbBaselineDir = stableBaseline;
    wiredDeps.syntheticEvalOverlay = fakeOverlay(true);
    await provisionV3Container(wiredDeps, 123);
    assert.deepEqual(wired.captured.lastCreateOpts, plain.captured.lastCreateOpts);
  });

  test("synthetic UID without a prepared record keeps the standard container spec", async () => {
    const plainPool = new FakePool();
    const wiredPool = new FakePool();
    const plain = makeDocker();
    const wired = makeDocker();
    const plainDeps = makeDeps(plain.docker, plainPool);
    plainDeps.ccbBaselineDir = stableBaseline;
    await provisionV3Container(plainDeps, 247);
    const wiredDeps = makeDeps(wired.docker, wiredPool);
    wiredDeps.ccbBaselineDir = stableBaseline;
    wiredDeps.syntheticEvalOverlay = fakeOverlay(false);
    await provisionV3Container(wiredDeps, 247);
    assert.deepEqual(wired.captured.lastCreateOpts, plain.captured.lastCreateOpts);
  });

  test("orphan overlay labels force safe recycle back to the standard container", async () => {
    const pool = new FakePool();
    pool.preInsertActive(247, "172.31.1.247", "dockerid-pre-overlay");
    const { docker, captured } = makeDocker({
      runningLabels: syntheticEvalOverlayLabels(overlaySpec),
    });
    const deps = makeDeps(docker, pool);
    deps.ccbBaselineDir = stableBaseline;
    deps.syntheticEvalOverlay = {
      ...fakeOverlay(false),
      classifyContainer: () => ({
        mode: "stale",
        reason: "synthetic overlay labels do not match active record",
      }),
    };
    const result = await makeEnsure(deps)(247n);
    assert.equal(result.coldStart, true);
    assert.ok(captured.stopped >= 1);
    assert.equal(captured.created, 1);
    assert.equal(
      captured.lastCreateOpts?.Labels?.[SYNTHETIC_EVAL_MANIFEST_LABEL],
      undefined,
    );
  });

  for (const [drainResult, uid] of [
    ["busy", 247],
    ["failed", 626],
  ] as const) {
    test(`overlay mismatch with V5 drain ${drainResult} fails closed instead of warm reuse`, async () => {
      const pool = new FakePool();
      pool.preInsertActive(uid, `172.31.1.${uid % 255}`, `dockerid-pre-${uid}`);
      const { docker, captured } = makeDocker({
        runningLabels: syntheticEvalOverlayLabels({
          ...overlaySpec,
          uid,
        }),
      });
      const deps = makeDeps(docker, pool);
      deps.ccbBaselineDir = stableBaseline;
      deps.syntheticEvalOverlay = {
        ...fakeOverlay(false),
        classifyContainer: () => ({
          mode: "stale",
          reason: "synthetic overlay labels do not match active record",
        }),
      };
      const ensure = makeV3EnsureRunning(deps, {
        probeHealthz: async () => true,
        probeWsUpgrade: async () => true,
        sleep: noSleep,
        now: fixedNow,
        runtimeChannelForTest: "v5",
        forceStaleImageRecycle: true,
        requestRuntimeRecycleDrain: async () => drainResult,
      });
      await assert.rejects(
        () => ensure(BigInt(uid)),
        (error: unknown) => {
          assert.ok(error instanceof ContainerUnreadyError);
          assert.equal(error.reason, "synthetic_eval_recycle_blocked");
          return true;
        },
      );
      assert.equal(captured.stopped, 0);
      assert.equal(captured.removed, 0);
      assert.equal(captured.created, 0);
    });
  }

  test("overlay activation happens only after Tx2 and activation failure compensates the container", async () => {
    const pool = new FakePool();
    const { docker, captured } = makeDocker();
    const deps = makeDeps(docker, pool);
    let sawCommittedIdentity = false;
    deps.syntheticEvalOverlay = fakeOverlay(true, (containerId) => {
      sawCommittedIdentity = pool.rows.some(
        (row) =>
          row.state === "active"
          && row.container_internal_id === containerId,
      );
      throw new Error("activation failed");
    });

    await assert.rejects(
      () => provisionV3Container(deps, 247),
      /activation failed/,
    );
    assert.equal(sawCommittedIdentity, true);
    assert.ok(captured.removed >= 1);
    assert.equal(
      pool.rows.some((row) => row.state === "active"),
      false,
    );
  });
});
