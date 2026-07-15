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
  v3CodexVolumeNameFor,
  v3UserLocalVolumeNameFor,
  v3UserConfigVolumeNameFor,
  resolveCcbBaselineMounts,
  V3_CCB_BASELINE_SKILL_NAMES,
  V3_NETWORK_NAME,
  V3_GATEWAY_IP,
  V3_INTERNAL_PROXY_URL,
  gatewayIpFromV3Cidr,
  V3_CONTAINER_PORT,
  V3_CONFIG_TMPFS_PATH,
  V3_VOLUME_MOUNT,
  V3_PROJECTS_MOUNT,
  V3_CODEX_HOME_MOUNT,
  V3_USER_LOCAL_MOUNT,
  V3_USER_CONFIG_MOUNT,
  SupervisorError,
  classifyRuntimeArtifactFailure,
} from "../agent-sandbox/index.js";
import { buildCodexRelayLocalBaseUrl } from "../http/internalCodexRelay.js";

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
  /** v1.0.84 PR #4 image guard:统计 docker.getImage(tag).inspect() 调用次数(monolith fallback 路径)。 */
  imageInspected: number;
};

type DockerBehavior = {
  imageMissing?: boolean;
  startFails?: boolean;
  inspectMissing?: boolean;
  inspectRunning?: boolean;
  /**
   * v1.0.84 PR #4 image guard 测试用:控制 monolith fallback 路径下
   * `docker.getImage(tag).inspect()` 的返回值。
   *   - undefined(默认)→ 返回 `{Config:{Labels:{"oc.runtime.features":"file-proxy-v1 v3-sink"}}}`,
   *     让所有不显式关心 guard 的现有测试默认通过校验
   *   - {kind:"labels", labels} → 返指定 labels(放进 Config.Labels)
   *   - {kind:"missing"}        → 抛 statusCode=404(模拟 image absent)
   *   - {kind:"throw", err}     → 抛指定错误(模拟 daemon down)
   */
  imageInspect?:
    | { kind: "labels"; labels: Record<string, string> }
    | { kind: "missing" }
    | { kind: "throw"; err: Error };
  /**
   * NameConflict 自愈测试用:前 N 次 `docker.createContainer()` 抛 statusCode=409
   * (docker "name already in use")。第 N+1 次起正常创建。默认 0(不注入冲突)。
   */
  createConflictCount?: number;
  /**
   * NameConflict 自愈测试用:控制 `getContainer(name).inspect()`(冲突容器 inspect)
   * 返回的 labels + state。未设 → 走默认 inspect(现有测试不受影响)。
   */
  conflictInspectResult?: { labels: Record<string, string>; state: string; id?: string };
  /** 冲突容器 inspect 抛 404(TOCTOU:inspect 前已被清)。 */
  conflictInspectMissing?: boolean;
  /** 冲突容器 inspect 抛非 404 错误(daemon/权限/临时故障)。 */
  conflictInspectThrows?: Error;
  /** 自愈 rm 冲突容器时抛 404(别的 reaper / 并发 provision 已删)。 */
  conflictRemoveMissing?: boolean;
  /** 结构性守卫测试:createContainer 被调用瞬间的回调(捕获此刻 PG 事务状态)。 */
  onCreateContainer?: () => void;
  /** 结构性守卫测试:container.start 被调用瞬间的回调。 */
  onStartContainer?: () => void;
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
    imageInspected: 0,
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

  let createCalls = 0;
  const createContainer = async (opts: Parameters<Docker["createContainer"]>[0]) => {
    createCalls++;
    behavior.onCreateContainer?.();
    if (behavior.imageMissing) throw httpError(404, "No such image: openclaude/openclaude-runtime:test");
    if (behavior.createConflictCount && createCalls <= behavior.createConflictCount) {
      throw httpError(409, 'Conflict. The container name "/oc-v3-u1" is already in use');
    }
    captured.containersCreated.push(opts);
    return {
      id: `dockerid-${captured.containersCreated.length}`,
      start: async () => {
        behavior.onStartContainer?.();
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
      // NameConflict 自愈路径:冲突容器 inspect(优先于默认 inspect)。
      if (behavior.conflictInspectMissing) throw httpError(404, "no such container");
      if (behavior.conflictInspectThrows) throw behavior.conflictInspectThrows;
      if (behavior.conflictInspectResult) {
        const ci = behavior.conflictInspectResult;
        return {
          Id: ci.id ?? "conflict-docker-id",
          Config: { Labels: ci.labels },
          State: { Status: ci.state, Running: ci.state === "running" },
        } as unknown as Awaited<ReturnType<ReturnType<Docker["getContainer"]>["inspect"]>>;
      }
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
      if (behavior.conflictRemoveMissing) throw httpError(404, "no such container");
      captured.removed++;
    },
  });

  // v1.0.84 PR #4 image guard:provisionV3Container 在 BEGIN 前会调
  // `docker.getImage(image).inspect()`(facade 未注入时的 monolith fallback)。
  // 默认 labels 包含 v3-sink → 现有测试零修改即通过 guard;behavior.imageInspect
  // 显式给定 → 单测精确控制 guard 走哪个分支。
  const getImage = (_tag: string) => ({
    inspect: async () => {
      captured.imageInspected++;
      const beh = behavior.imageInspect;
      if (beh?.kind === "throw") throw beh.err;
      if (beh?.kind === "missing") throw httpError(404, "No such image");
      const labels =
        beh?.kind === "labels"
          ? beh.labels
          : { "oc.runtime.features": "file-proxy-v1 v3-sink" };
      return {
        Id: "sha256:fakeimage",
        RepoTags: [_tag],
        Config: { Labels: labels },
      } as unknown as Awaited<ReturnType<ReturnType<Docker["getImage"]>["inspect"]>>;
    },
  });

  const docker = {
    createVolume,
    getVolume: getVolume as unknown as Docker["getVolume"],
    createContainer,
    getContainer,
    getImage: getImage as unknown as Docker["getImage"],
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
  // v1.0.200 — provision 写 image 列(快照),admin UI 列表读它显示版本。
  // 0017 drop NOT NULL 但 v3 supervisor 现在显式 INSERT,FakeRow 必须存,
  // 否则 image 列断言假阴。
  image: string;
  container_internal_id: string | null;
  // saga Tx2 与 cid 一并写(binding 成功记 account_id,否则保持 NULL)。
  // 可选:既有直接构造 FakeRow 的 seed helper 不必填,provision INSERT 会写 null。
  codex_account_id?: string | null;
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
  /**
   * test 钩子:覆盖某次 INSERT 抛错时 PG constraint 名字。
   *   - 默认抛 `uniq_ac_bound_ip_active`(0012 旧名,模拟旧索引仍在的环境)
   *   - 0048 之后新仲裁器是 `idx_ac_host_bound_ip_active`,可通过此 map 注入校验
   *     supervisor retry filter 同时识别两个名字
   */
  forceConflictConstraintName: Map<number, string> = new Map();
  insertCount = 0;
  /**
   * v3 per-host cap admission test hook —— mock compute_hosts.max_containers。
   * 未配置 host_uuid → 走 DEFAULT_TEST_HOST_MAX(999,默认不踩 cap)。
   * 通过 setHostMax(uuid, n) 覆盖单 host 的上限,模拟 admin UI 改 max。
   * 设为 null 模拟 compute_hosts 行 missing(应触发 InvalidArgument)。
   */
  hostMax: Map<string, number | null> = new Map();
  setHostMax(hostUuid: string, max: number | null): void {
    this.hostMax.set(hostUuid, max);
  }

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
            const constraintName =
              self.forceConflictConstraintName.get(idx) ?? "uniq_ac_bound_ip_active";
            const e = new Error(
              `duplicate key value violates unique constraint "${constraintName}"`,
            ) as Error & { code: string; constraint: string };
            e.code = "23505";
            e.constraint = constraintName;
            throw e;
          }
          // params: [user_id, host_uuid, bound_ip, secret_hash, port, image]
          const userId = Number.parseInt(String(params![0]), 10);
          const hostUuid = params![1] == null ? null : String(params![1]);
          const boundIp = String(params![2]);
          const secretHash = params![3] as Buffer;
          const port = Number(params![4]);
          const image = String(params![5]);
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
            image,
            container_internal_id: null,
            codex_account_id: null,
            last_ws_activity: now,
            created_at: now,
            updated_at: now,
          });
          return { rowCount: 1, rows: [{ id: String(id) }] };
        }
        if (/UPDATE agent_containers/i.test(trimmed) && /SET container_internal_id/i.test(trimmed)) {
          // saga Tx2:SET container_internal_id=$2, codex_account_id=$3
          //   WHERE id=$1 AND state='active' AND runtime_channel=$4
          // state='active' guard:占位行已被并发翻 vanished → rowCount=0(触发补偿)。
          const id = Number.parseInt(String(params![0]), 10);
          const cid = String(params![1]);
          const codexAccountId = params![2] == null ? null : String(params![2]);
          const guardsActive = /state\s*=\s*'active'/i.test(trimmed);
          const r = self.rows.find(
            (x) => x.id === id && (!guardsActive || x.state === "active"),
          );
          if (r) {
            r.container_internal_id = cid;
            r.codex_account_id = codexAccountId;
            r.updated_at = new Date();
          }
          return { rowCount: r ? 1 : 0, rows: [] };
        }
        if (/UPDATE agent_containers/i.test(trimmed) && /SET state\s*=\s*'vanished'/i.test(trimmed)) {
          const id = Number.parseInt(String(params![0]), 10);
          const r = self.rows.find((x) => x.id === id);
          if (r) {
            r.state = "vanished";
            r.updated_at = new Date();
          }
          // v1.0.22 stopAndRemoveV3Container 用 RETURNING host_uuid 兜底跨 host 路由
          const returnsHostUuid = /RETURNING\s+host_uuid/i.test(trimmed);
          return {
            rowCount: r ? 1 : 0,
            rows: r && returnsHostUuid ? [{ host_uuid: r.host_uuid }] : [],
          };
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
              created_at: r.created_at,
              last_ws_activity: r.last_ws_activity,
            }],
          };
        }
        // provision 锁内幂等复查(并发 ensure 双请求):同 uid 已有 active 行 → NameConflict。
        // SQL 形态: SELECT id::text AS id FROM agent_containers WHERE user_id=$1 AND state='active' AND runtime_channel=$2 LIMIT 1
        if (
          /SELECT id::text AS id FROM agent_containers/i.test(trimmed)
          && /state = 'active' AND runtime_channel/i.test(trimmed)
        ) {
          const userId = Number.parseInt(String(params![0]), 10);
          const r = self.rows.find((x) => x.user_id === userId && x.state === "active");
          return r ? { rowCount: 1, rows: [{ id: String(r.id) }] } : { rowCount: 0, rows: [] };
        }
        // v3 per-host cap admission gate —— provisionV3Container 在 BEGIN 后
        // 拿 per-host advisory lock 后,同事务读 per-host active count + per-host
        // compute_hosts.max_containers。SQL 形态:
        //   SELECT
        //     (SELECT COUNT(*) FROM agent_containers
        //       WHERE state='active' AND host_uuid=$1::uuid)::text AS active,
        //     (SELECT max_containers FROM compute_hosts WHERE id=$1::uuid) AS max_containers
        if (
          /SELECT COUNT\(\*\) FROM agent_containers/i.test(trimmed)
          && /AS active/i.test(trimmed)
          && /max_containers FROM compute_hosts/i.test(trimmed)
        ) {
          const hostUuid = String(params![0]);
          const active = self.rows.filter(
            (x) => x.state === "active" && x.host_uuid === hostUuid,
          ).length;
          const max = self.hostMax.has(hostUuid)
            ? self.hostMax.get(hostUuid)
            : DEFAULT_TEST_HOST_MAX;
          return {
            rowCount: 1,
            rows: [{ active: String(active), max_containers: max }],
          };
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

/**
 * 默认测试用 selfHostId / hostId。canonical 36-char lowercase UUID,与
 * provisionV3Container 内的 HOST_UUID_CANONICAL_RE 严格校验对齐。
 * FakePool 默认对此 host 应用 `DEFAULT_TEST_HOST_MAX` = 999(单测不踩 cap)。
 */
const TEST_HOST = "11111111-1111-1111-1111-111111111111";
const TEST_HOST_ALT = "22222222-2222-2222-2222-222222222222";
const DEFAULT_TEST_HOST_MAX = 999;

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

describe("v3ContainerNameFor / v3VolumeNameFor / v3ProjectsVolumeNameFor / v3{Codex,UserLocal,UserConfig}VolumeNameFor", () => {
  test("happy path", () => {
    assert.equal(v3ContainerNameFor(42), "oc-v3-u42");
    assert.equal(v3VolumeNameFor(42), "oc-v3-data-u42");
    assert.equal(v3ProjectsVolumeNameFor(42), "oc-v3-proj-u42");
    // D2 — 3 个新持久化 volume
    assert.equal(v3CodexVolumeNameFor(42), "oc-v3-codex-u42");
    assert.equal(v3UserLocalVolumeNameFor(42), "oc-v3-userlocal-u42");
    assert.equal(v3UserConfigVolumeNameFor(42), "oc-v3-userconfig-u42");
  });
  test("rejects bad uid", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => v3ContainerNameFor(bad as number), SupervisorError);
      assert.throws(() => v3VolumeNameFor(bad as number), SupervisorError);
      assert.throws(() => v3ProjectsVolumeNameFor(bad as number), SupervisorError);
      assert.throws(() => v3CodexVolumeNameFor(bad as number), SupervisorError);
      assert.throws(() => v3UserLocalVolumeNameFor(bad as number), SupervisorError);
      assert.throws(() => v3UserConfigVolumeNameFor(bad as number), SupervisorError);
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
  // OC_PLATFORM_BUNDLE_OPTIONAL=1 同理:v5 runtime tuple 上线后 v5 channel 缺 bundle 默认
  // fail-closed(供 dev 降级),本组不关心 bundle 内容(B6 用例走 v5 channel),降级避免拒 provision。
  let prevOptional: string | undefined;
  let prevBundleOptional: string | undefined;
  before(() => {
    prevOptional = process.env.OC_V3_CCB_BASELINE_OPTIONAL;
    process.env.OC_V3_CCB_BASELINE_OPTIONAL = "1";
    prevBundleOptional = process.env.OC_PLATFORM_BUNDLE_OPTIONAL;
    process.env.OC_PLATFORM_BUNDLE_OPTIONAL = "1";
  });
  after(() => {
    if (prevOptional === undefined) delete process.env.OC_V3_CCB_BASELINE_OPTIONAL;
    else process.env.OC_V3_CCB_BASELINE_OPTIONAL = prevOptional;
    if (prevBundleOptional === undefined) delete process.env.OC_PLATFORM_BUNDLE_OPTIONAL;
    else process.env.OC_PLATFORM_BUNDLE_OPTIONAL = prevBundleOptional;
  });
  beforeEach(() => {
    pool = new FakePool();
  });

  test("docker createContainer 参数符合 §9.3 全部硬约束", async () => {
    const { docker, captured } = makeDocker();
    const SECRET = "a".repeat(64);
    const IP = "172.30.5.42";
    const result = await provisionV3Container(
      { docker, pool: pool as unknown as Pool, image: TEST_IMAGE, selfHostId: TEST_HOST, randomIp: () => IP, randomSecret: fixedSecret(SECRET) },
      777,
    );

    assert.equal(result.userId, 777);
    assert.equal(result.boundIp, IP);
    assert.equal(result.port, V3_CONTAINER_PORT);
    assert.equal(result.token, `oc-v3.${result.containerId}.${SECRET}`);
    assert.ok(result.dockerContainerId.length > 0);

    // volume 落 label(D2 全套 5 个:data + projects + codex + userlocal + userconfig)
    assert.equal(captured.volumesCreated.length, 5);
    for (const expectedName of [
      "oc-v3-data-u777",
      "oc-v3-proj-u777",
      "oc-v3-codex-u777",
      "oc-v3-userlocal-u777",
      "oc-v3-userconfig-u777",
    ]) {
      const v = captured.volumesCreated.find((x) => x.Name === expectedName);
      assert.ok(v, `${expectedName} must be created`);
      assert.equal(v!.Labels?.["com.openclaude.v3.managed"], "1");
      assert.equal(v!.Labels?.["com.openclaude.v3.uid"], "777");
    }

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
    // v1.0.193 — 切容器内 gateway /api/file ACL 到 trusted-backend 模式。
    // 没注入 => /api/file 退化到严白名单,boss/客户的 hello.txt 等 cwd 产物
    // 又会 403。**任何往 FILE_BLOCKED_PATTERNS 加 master 注入敏感路径的 PR
    // 必须同时来这里核对** —— env 不能被偷偷拿走。
    assert.ok(
      env.includes("OC_V3_TRUSTED_FILE_SERVE=1"),
      "supervisor must inject OC_V3_TRUSTED_FILE_SERVE=1 so container gateway uses blocklist-only ACL (see packages/gateway/src/server.ts isFileAllowed trusted branch)",
    );

    // 网络 + IP forced via IPAMConfig
    assert.equal(opts.HostConfig?.NetworkMode, V3_NETWORK_NAME);
    const epc = opts.NetworkingConfig?.EndpointsConfig?.[V3_NETWORK_NAME];
    assert.equal(epc?.IPAMConfig?.IPv4Address, IP);

    // 资源硬限额:默认 4GB / 1 核 / 4096 pids(env 未设,走 DEFAULT_V3_*)
    assert.equal(opts.HostConfig?.Memory, 4096 * 1024 * 1024);
    assert.equal(opts.HostConfig?.MemorySwap, 4096 * 1024 * 1024, "MemorySwap 必须 == Memory 禁 swap");
    assert.equal(opts.HostConfig?.MemorySwappiness, 0);
    assert.equal(opts.HostConfig?.NanoCpus, 1_000_000_000, "1.0 CPU = 1e9 ns");
    assert.equal(opts.HostConfig?.PidsLimit, 4096);

    // cap-drop NET_RAW + NET_ADMIN
    assert.deepEqual(opts.HostConfig?.CapDrop, ["NET_RAW", "NET_ADMIN"]);
    assert.deepEqual(opts.HostConfig?.CapAdd, []);

    // Privileged false。SecurityOpt 自 2026-05-09 (D1) 起为空数组 — 移除
    // no-new-privileges 是为了让 agent 用户 NOPASSWD sudo 生效(详见
    // v3supervisor.ts SecurityOpt 段注释)。这里显式断言空,避免未来回滚不
    // 经意带回 no-new-privileges 而 sudo 又静默失败。
    assert.deepEqual(opts.HostConfig?.SecurityOpt ?? [], []);
    assert.equal(opts.HostConfig?.Privileged, false);

    // tmpfs /run/oc/claude-config
    const tmp = (opts.HostConfig?.Tmpfs ?? {})[V3_CONFIG_TMPFS_PATH];
    assert.ok(tmp, "Tmpfs entry for CLAUDE_CONFIG_DIR must exist");
    assert.match(tmp, /nosuid/);
    assert.match(tmp, /nodev/);
    assert.match(tmp, /mode=0700/);

    // 7 条 bind(D2 持久化方案 + codex-auth ro + ssh-user-run ro):
    //   data       → /home/agent/.openclaude
    //   projects   → /run/oc/claude-config/projects
    //   codex      → /home/agent/.codex
    //   userlocal  → /home/agent/.local
    //   userconfig → /home/agent/.config
    //   codex-auth → /run/oc/codex-auth  (legacy fallback:本测试无 DATABASE_URL → pickCodex 抛错 →
    //                                    boundCodexAccountId=null → 走 else if (!useRemote) 分支,
    //                                    codexMountSource = DEFAULT_V3_CODEX_CONTAINER_DIR)
    //   ssh        → /run/ccb-ssh        (本地 provision 总会 mkdir /run/ccb-ssh/u<uid> + 挂 ro,
    //                                    让容器内 agent 走 ctl.sock 用 ccb ssh mux)
    // 任一项改动 → 同步 v3supervisor.ts:1755-1764(base 5) / :1881(codex-auth) / :1889(ssh)
    assert.deepEqual(opts.HostConfig?.Binds, [
      `oc-v3-data-u777:${V3_VOLUME_MOUNT}:rw`,
      `oc-v3-proj-u777:${V3_PROJECTS_MOUNT}:rw`,
      `oc-v3-codex-u777:${V3_CODEX_HOME_MOUNT}:rw`,
      `oc-v3-userlocal-u777:${V3_USER_LOCAL_MOUNT}:rw`,
      `oc-v3-userconfig-u777:${V3_USER_CONFIG_MOUNT}:rw`,
      // DEFAULT_V3_CODEX_CONTAINER_DIR + V3_CODEX_AUTH_RO_MOUNT(literal 保持测试自证)
      "/var/lib/openclaude-v3/codex-container-auth:/run/oc/codex-auth:ro",
      // V3_SSH_RUN_ROOT_HOST/u<uid> + V3_SSH_RUN_CONTAINER_MOUNT(常量未 export,literal)
      "/run/ccb-ssh/u777:/run/ccb-ssh:ro",
    ]);

    // restart no
    assert.equal(opts.HostConfig?.RestartPolicy?.Name, "no");

    // labels
    assert.equal(opts.Labels?.["com.openclaude.v3.managed"], "1");
    assert.equal(opts.Labels?.["com.openclaude.v3.uid"], "777");

    // start 成功
    assert.equal(captured.started, 1);
  });

  test("Codex relay env: passes non-secret knobs but rewrites upstream URL to container loopback relay", async () => {
    const keys = [
      "OC_V3_CODEX_LOCAL_RELAY_ENABLED",
      "OC_CODEX_MODEL_PROVIDER",
      "OC_CODEX_PROVIDER_NAME",
      "OC_CODEX_BASE_URL",
      "OC_CODEX_UPSTREAM_BASE_URL",
      "OC_CODEX_WIRE_API",
      "OC_CODEX_PREFERRED_AUTH_METHOD",
      "OC_CODEX_DISABLE_RESPONSE_STORAGE",
      "OC_CODEX_API_KEY",
    ] as const;
    const saved = new Map<string, string | undefined>();
    for (const key of keys) saved.set(key, process.env[key]);
    try {
      process.env.OC_V3_CODEX_LOCAL_RELAY_ENABLED = "1";
      process.env.OC_CODEX_MODEL_PROVIDER = "api111";
      process.env.OC_CODEX_PROVIDER_NAME = "Yunwu";
      process.env.OC_CODEX_BASE_URL = "https://yunwu.ai/v1";
      process.env.OC_CODEX_WIRE_API = "responses";
      process.env.OC_CODEX_PREFERRED_AUTH_METHOD = "apikey";
      process.env.OC_CODEX_DISABLE_RESPONSE_STORAGE = "1";
      process.env.OC_CODEX_API_KEY = "not-a-real-api-key";

      const { docker, captured } = makeDocker();
      await provisionV3Container(
        {
          docker,
          pool: pool as unknown as Pool,
          image: TEST_IMAGE,
          selfHostId: TEST_HOST,
          randomIp: () => "172.30.5.43",
          randomSecret: fixedSecret("b".repeat(64)),
        },
        778,
      );

      const env = captured.containersCreated[0]?.Env ?? [];
      assert.ok(env.includes("OC_CODEX_MODEL_PROVIDER=api111"));
      assert.ok(env.includes("OC_CODEX_PROVIDER_NAME=Yunwu"));
      assert.ok(env.includes(`OC_CODEX_BASE_URL=${buildCodexRelayLocalBaseUrl(`http://127.0.0.1:${V3_CONTAINER_PORT}`, "https://yunwu.ai/v1")}`));
      assert.ok(env.includes("OC_CODEX_WIRE_API=responses"));
      assert.ok(env.includes("OC_CODEX_PREFERRED_AUTH_METHOD=apikey"));
      assert.ok(env.includes("OC_CODEX_DISABLE_RESPONSE_STORAGE=1"));
      assert.ok(
        !env.includes("OC_CODEX_BASE_URL=https://yunwu.ai/v1"),
        "external upstream base URL must not be passed directly into managed containers",
      );
      assert.ok(
        !env.some((entry) => entry.startsWith("OC_CODEX_UPSTREAM_BASE_URL=")),
        "upstream base URL is master-only and must not be passed into managed containers",
      );
      assert.ok(
        !env.some((entry) => entry.startsWith("OC_CODEX_API_KEY=")),
        "OC_CODEX_API_KEY must stay in auth.json and out of docker env",
      );
    } finally {
      for (const key of keys) {
        const prev = saved.get(key);
        if (prev === undefined) delete process.env[key];
        else process.env[key] = prev;
      }
    }
  });

  test("B6:v5 channel 绑定失败/NULL 不挂 legacy 共享 codex auth 目录(fail-closed;v3 对照见 §9.3 测试)", async () => {
    // 本测试与 §9.3 基线测试同构:无 DATABASE_URL → pickCodexAccountForBinding 抛错
    // → boundCodexAccountId=null。v3 channel(§9.3 测试)断言共享目录 bind **存在**,
    // v5 channel 在此断言它**不存在** —— 共享 auth.json 可能残留上游 key,不得暴露
    // 给 v5 用户容器(feat/v5-codex-oauth-egress B6)。
    const savedChannel = process.env.OC_RUNTIME_CHANNEL;
    try {
      process.env.OC_RUNTIME_CHANNEL = "v5";
      const { docker, captured } = makeDocker();
      await provisionV3Container(
        {
          docker,
          pool: pool as unknown as Pool,
          image: TEST_IMAGE,
          selfHostId: TEST_HOST,
          randomIp: () => "172.31.5.44",
          randomSecret: fixedSecret("d".repeat(64)),
        },
        779,
      );
      const env = captured.containersCreated[0]?.Env ?? [];
      assert.ok(env.includes("OC_CONTAINER_PREVIEW_ENABLED=1"));
      const binds = (captured.containersCreated[0]?.HostConfig?.Binds ?? []) as string[];
      assert.ok(binds.length > 0, "v5 容器仍需其它 bind(data/proj/codex volume 等)");
      assert.ok(
        !binds.some((b) => b.includes(":/run/oc/codex-auth:")),
        `v5 容器不得挂共享 codex auth fallback,got: ${JSON.stringify(binds)}`,
      );
    } finally {
      if (savedChannel === undefined) delete process.env.OC_RUNTIME_CHANNEL;
      else process.env.OC_RUNTIME_CHANNEL = savedChannel;
    }
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
          { docker, pool: pool as unknown as Pool, image: TEST_IMAGE, selfHostId: TEST_HOST, randomIp: () => "172.30.9.1", randomSecret: fixedSecret("c".repeat(64)) },
          901,
        );
        const hc = captured.containersCreated[0]!.HostConfig!;
        assert.equal(hc.Memory, 4096 * 1024 * 1024, "floor 后 <1 必须回退 DEFAULT_V3_MEMORY_MB,不能传 0");
        assert.equal(hc.NanoCpus, 1_000_000_000, "floor 后 <1 ns 必须回退 DEFAULT_V3_CPUS");
        assert.equal(hc.PidsLimit, 4096, "floor 后 <1 必须回退 DEFAULT_V3_PIDS_LIMIT");
      }

      // 2) 合法小数 CPU 正确换算:0.5 核 → 5e8 ns
      pool = new FakePool();
      delete process.env.OC_V3_MEMORY_MB;
      process.env.OC_V3_CPUS = "0.5";
      delete process.env.OC_V3_PIDS_LIMIT;
      {
        const { docker, captured } = makeDocker();
        await provisionV3Container(
          { docker, pool: pool as unknown as Pool, image: TEST_IMAGE, selfHostId: TEST_HOST, randomIp: () => "172.30.9.2", randomSecret: fixedSecret("d".repeat(64)) },
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
      { docker, pool: pool as unknown as Pool, image: TEST_IMAGE, selfHostId: TEST_HOST, randomIp: () => "172.30.7.7", randomSecret: fixedSecret(SECRET) },
      11,
    );
    assert.equal(pool.rows.length, 1);
    const row = pool.rows[0]!;
    assert.equal(row.id, result.containerId);
    assert.equal(row.user_id, 11);
    assert.equal(row.bound_ip, "172.30.7.7");
    assert.equal(row.state, "active");
    assert.equal(row.port, V3_CONTAINER_PORT);
    // v1.0.200 — provision 必须把 deps.image 快照写进 image 列,
    // admin UI containers tab 据此渲染镜像版本(packages/web/public/modules/admin.js:3307)。
    // 0017 drop NOT NULL 但 v3 现在仍显式写入,符合"per-container 镜像快照"语义。
    assert.equal(row.image, TEST_IMAGE);
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
      { docker, pool: pool as unknown as Pool, image: TEST_IMAGE, selfHostId: TEST_HOST, randomIp: ips, randomSecret: fixedSecret("c".repeat(64)) },
      55,
    );
    // 第三次 INSERT 才成功
    assert.equal(result.boundIp, "172.30.0.12");
    assert.equal(pool.insertCount, 3);
    assert.equal(pool.rows.length, 1);
    // retry 路径每次重试都要带 image,不能 conflict 后丢字段(v1.0.200 image col 回归锁)
    assert.equal(pool.rows[0]!.image, TEST_IMAGE);
  });

  test("placement 指定 boundIp 的 fixed 分支也写 image(v1.0.200 image col 回归锁)", async () => {
    // scheduler 给定 boundIp 时走 allocateBoundIpAndInsertRow 的 fixedBoundIp 分支
    // (不 retry,直接 NameConflict)。两条分支的 INSERT 都必须带 image 列,
    // 否则 admin UI 渲染随机分支与 placement 分支差异化空白 — 加锁回归。
    const { docker } = makeDocker();
    const result = await provisionV3Container(
      { docker, pool: pool as unknown as Pool, image: TEST_IMAGE, selfHostId: TEST_HOST, randomSecret: fixedSecret("e".repeat(64)) },
      57,
      TEST_HOST,
      "172.30.5.99",
    );
    assert.equal(result.boundIp, "172.30.5.99");
    assert.equal(pool.rows.length, 1);
    assert.equal(pool.rows[0]!.image, TEST_IMAGE);
  });

  test("idx_ac_host_bound_ip_active(0030 composite,0048 后新仲裁器)冲突也走 retry 路径", async () => {
    // 0048 drop uniq_ac_bound_ip_active 后,IP 撞车 23505 由 composite
    // (host_uuid, bound_ip) 抛,constraint 名换成 idx_ac_host_bound_ip_active。
    // supervisor retry filter 必须同时识别新旧名字(deploy 顺序错位也不死)。
    const { docker } = makeDocker();
    pool.forceUniqConflictOnInserts.add(0);
    pool.forceConflictConstraintName.set(0, "idx_ac_host_bound_ip_active");
    pool.forceUniqConflictOnInserts.add(1);
    pool.forceConflictConstraintName.set(1, "idx_ac_host_bound_ip_active");
    const ips = fixedIps(["172.30.0.10", "172.30.0.11", "172.30.0.12"]);
    const result = await provisionV3Container(
      { docker, pool: pool as unknown as Pool, image: TEST_IMAGE, selfHostId: TEST_HOST, randomIp: ips, randomSecret: fixedSecret("c".repeat(64)) },
      56,
    );
    assert.equal(result.boundIp, "172.30.0.12");
    assert.equal(pool.insertCount, 3);
    assert.equal(pool.rows.length, 1);
  });

  test("docker createContainer 失败 → Tx1 提交后中段失败,补偿翻 vanished(不留 active 行)", async () => {
    const { docker } = makeDocker({ imageMissing: true });
    await assert.rejects(
      provisionV3Container(
        { docker, pool: pool as unknown as Pool, image: TEST_IMAGE, selfHostId: TEST_HOST, randomIp: () => "172.30.1.1", randomSecret: fixedSecret("d".repeat(64)) },
        9,
      ),
      (err: Error) => err instanceof SupervisorError && err.code === "ImageNotFound",
    );
    // saga:Tx1 短事务已提交占位行(BEGIN→COMMIT),docker create 在无事务中段失败 →
    // compensateProvisionFailure 短事务翻 vanished;不再是旧的 BEGIN→ROLLBACK。
    assert.deepEqual(pool.clientLog, ["BEGIN", "COMMIT"]);
    assert.equal(pool.rows.length, 1, "Tx1 占位行已提交");
    assert.equal(pool.rows[0]!.state, "vanished", "中段失败 → 补偿翻 vanished");
    assert.equal(pool.rows[0]!.container_internal_id, null, "cid 从未写入(Tx2 未跑)");
  });

  test("container.start 失败 → docker rm -f + 补偿翻 vanished(Tx1 已提交)", async () => {
    const { docker, captured } = makeDocker({ startFails: true });
    await assert.rejects(
      provisionV3Container(
        { docker, pool: pool as unknown as Pool, image: TEST_IMAGE, selfHostId: TEST_HOST, randomIp: () => "172.30.2.2", randomSecret: fixedSecret("e".repeat(64)) },
        9,
      ),
      (err: Error) => err instanceof SupervisorError,
    );
    // start 之前 createContainer 成功 → start 失败时就近 container.remove,
    // 再由 compensateProvisionFailure best-effort docker.getContainer().remove → removed >= 1
    assert.ok(captured.removed >= 1);
    // saga:Tx1 已提交(BEGIN→COMMIT),中段 start 失败 → 补偿翻 vanished。
    assert.deepEqual(pool.clientLog, ["BEGIN", "COMMIT"]);
    assert.equal(pool.rows[0]!.state, "vanished");
  });

  test("结构性守卫:docker.createContainer / start 被调时 provision client 上无悬挂 BEGIN(Tx1 已 COMMIT 释放)", async () => {
    // saga 核心不变量:docker 慢 IO 绝不在开着的事务里跑。捕获 createContainer / start
    // 触发瞬间的 clientLog —— 必须已是 ["BEGIN","COMMIT"](末尾 COMMIT,无悬挂 BEGIN),
    // 证明 Tx1 短事务已提交并 release,中段无 checked-out client / 无 idle-in-tx 窗口。
    // 防回归:若有人把 docker 副作用挪回单条长事务,这里会捕到悬挂的 ["BEGIN"]。
    let logAtCreate: string[] | undefined;
    let logAtStart: string[] | undefined;
    const { docker } = makeDocker({
      onCreateContainer: () => {
        logAtCreate = [...pool.clientLog];
      },
      onStartContainer: () => {
        logAtStart = [...pool.clientLog];
      },
    });
    await provisionV3Container(
      { docker, pool: pool as unknown as Pool, image: TEST_IMAGE, selfHostId: TEST_HOST, randomIp: () => "172.30.8.8", randomSecret: fixedSecret("f".repeat(64)) },
      77,
    );
    assert.deepEqual(logAtCreate, ["BEGIN", "COMMIT"], "createContainer 时 Tx1 必须已 COMMIT(无悬挂 BEGIN)");
    assert.deepEqual(logAtStart, ["BEGIN", "COMMIT"], "container.start 时 Tx1 必须已 COMMIT(无悬挂 BEGIN)");
    // Tx2 走 pool.query(不 connect),不追加事务记录;成功后 clientLog 仍是 BEGIN→COMMIT。
    assert.deepEqual(pool.clientLog, ["BEGIN", "COMMIT"]);
    assert.equal(pool.rows[0]!.container_internal_id, "dockerid-1", "Tx2 已写 cid");
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
        { docker, pool: pool as unknown as Pool, image: TEST_IMAGE, selfHostId: TEST_HOST, randomIp: () => "172.30.3.3", randomSecret: () => "short" },
        7,
      ),
      (err: Error) => err instanceof SupervisorError && err.code === "InvalidArgument",
    );
  });
});

// ───────────────────────────────────────────────────────────────────────
//  provisionV3Container — docker create NameConflict 自愈(2026-07-06 事故根治)
// ───────────────────────────────────────────────────────────────────────

describe("provisionV3Container — docker create NameConflict 自愈", () => {
  let pool: FakePool;
  let prevOptional: string | undefined;
  let prevBundleOptional: string | undefined;
  let savedChannel: string | undefined;
  before(() => {
    prevOptional = process.env.OC_V3_CCB_BASELINE_OPTIONAL;
    process.env.OC_V3_CCB_BASELINE_OPTIONAL = "1";
    // v5 runtime tuple 上线后 v5 channel 缺 OC_PLATFORM_BUNDLE 默认 fail-closed;本组不测 bundle,
    // 设 OPTIONAL=1 降级(dev 逃生),让 NameConflict 自愈用例在无 bundle 的单元环境里跑过。
    prevBundleOptional = process.env.OC_PLATFORM_BUNDLE_OPTIONAL;
    process.env.OC_PLATFORM_BUNDLE_OPTIONAL = "1";
    // 事故 channel = v5(容器名 oc-v5-u1)。v5 provision 跳过 v3MayServe 门控
    // (它走全局 getPool → 无 DATABASE_URL 会抛 ConfigError,是既有基线失败源),
    // 故这里显式 v5:既忠实复现事故,又让自愈用例可在无 DB 的单元环境里独立跑过。
    savedChannel = process.env.OC_RUNTIME_CHANNEL;
    process.env.OC_RUNTIME_CHANNEL = "v5";
  });
  after(() => {
    if (prevOptional === undefined) delete process.env.OC_V3_CCB_BASELINE_OPTIONAL;
    else process.env.OC_V3_CCB_BASELINE_OPTIONAL = prevOptional;
    if (prevBundleOptional === undefined) delete process.env.OC_PLATFORM_BUNDLE_OPTIONAL;
    else process.env.OC_PLATFORM_BUNDLE_OPTIONAL = prevBundleOptional;
    if (savedChannel === undefined) delete process.env.OC_RUNTIME_CHANNEL;
    else process.env.OC_RUNTIME_CHANNEL = savedChannel;
  });
  beforeEach(() => {
    pool = new FakePool();
  });

  // v5 channel;"我们管理的" v5 容器 labels(managed/uid label key 恒含 "v3" 是历史命名,
  // channel 由 com.openclaude.runtime_channel 区分)。
  const OURS_V3 = {
    "com.openclaude.v3.managed": "1",
    "com.openclaude.v3.uid": "1",
    "com.openclaude.runtime_channel": "v5",
  };
  const depsFor = (docker: Docker, ip: string, secretChar: string) => ({
    docker,
    pool: pool as unknown as Pool,
    image: TEST_IMAGE,
    selfHostId: TEST_HOST,
    randomIp: () => ip,
    randomSecret: fixedSecret(secretChar.repeat(64)),
  });

  test("(a) create 409 + 冲突容器 created 态 + 三重 label 匹配 → rm 后重试成功", async () => {
    const { docker, captured } = makeDocker({
      createConflictCount: 1,
      conflictInspectResult: { labels: OURS_V3, state: "created", id: "zombie-cd2a410d" },
    });
    const result = await provisionV3Container(depsFor(docker, "172.30.9.1", "a"), 1);
    assert.equal(captured.removed, 1, "created 态僵尸应被 rm(force)一次");
    assert.equal(captured.containersCreated.length, 1, "create 重试成功(仅第二次进 push)");
    assert.equal(captured.started, 1, "容器已 start");
    assert.equal(result.userId, 1);
    assert.equal(result.boundIp, "172.30.9.1");
    assert.ok(result.dockerContainerId.length > 0);
  });

  test("(b) 冲突容器 running 态 → 绝不删,保留 NameConflict 失败", async () => {
    const { docker, captured } = makeDocker({
      createConflictCount: 1,
      conflictInspectResult: { labels: OURS_V3, state: "running" },
    });
    await assert.rejects(
      provisionV3Container(depsFor(docker, "172.30.9.2", "b"), 1),
      (err: Error) => err instanceof SupervisorError && err.code === "NameConflict",
    );
    assert.equal(captured.removed, 0, "running 活容器绝不删");
    assert.equal(captured.containersCreated.length, 0, "不重试 create");
  });

  test("(c1) 冲突容器 uid label 不匹配 → 绝不删", async () => {
    const { docker, captured } = makeDocker({
      createConflictCount: 1,
      conflictInspectResult: {
        labels: { ...OURS_V3, "com.openclaude.v3.uid": "999" },
        state: "created",
      },
    });
    await assert.rejects(
      provisionV3Container(depsFor(docker, "172.30.9.3", "c"), 1),
      (err: Error) => err instanceof SupervisorError && err.code === "NameConflict",
    );
    assert.equal(captured.removed, 0);
    assert.equal(captured.containersCreated.length, 0);
  });

  test("(c2) 冲突容器 runtime_channel 归属对方(v3)→ v5 实例绝不删", async () => {
    const { docker, captured } = makeDocker({
      createConflictCount: 1,
      conflictInspectResult: {
        labels: { ...OURS_V3, "com.openclaude.runtime_channel": "v3" },
        state: "created",
      },
    });
    await assert.rejects(
      provisionV3Container(depsFor(docker, "172.30.9.4", "d"), 1),
      (err: Error) => err instanceof SupervisorError && err.code === "NameConflict",
    );
    assert.equal(captured.removed, 0, "跨 channel 容器绝不删");
    assert.equal(captured.containersCreated.length, 0);
  });

  test("(c3) 冲突容器缺 managed label → 绝不删", async () => {
    const { docker, captured } = makeDocker({
      createConflictCount: 1,
      conflictInspectResult: {
        labels: { "com.openclaude.v3.uid": "1", "com.openclaude.runtime_channel": "v5" },
        state: "created",
      },
    });
    await assert.rejects(
      provisionV3Container(depsFor(docker, "172.30.9.5", "e"), 1),
      (err: Error) => err instanceof SupervisorError && err.code === "NameConflict",
    );
    assert.equal(captured.removed, 0, "非 managed 容器绝不删");
    assert.equal(captured.containersCreated.length, 0);
  });

  test("(d) 自愈 rm 撞 404(别的 reaper / 并发 provision 已删)→ 吞掉并重试成功", async () => {
    const { docker, captured } = makeDocker({
      createConflictCount: 1,
      conflictInspectResult: { labels: OURS_V3, state: "exited" },
      conflictRemoveMissing: true,
    });
    const result = await provisionV3Container(depsFor(docker, "172.30.9.6", "f"), 1);
    assert.equal(captured.removed, 0, "rm 抛 404 未计数(幂等共存,吞掉)");
    assert.equal(captured.containersCreated.length, 1, "404 后仍重试 create 成功");
    assert.equal(captured.started, 1);
    assert.ok(result.dockerContainerId.length > 0);
  });

  test("(e) 冲突容器 inspect 前已消失(TOCTOU 404)→ 直接重试成功", async () => {
    const { docker, captured } = makeDocker({
      createConflictCount: 1,
      conflictInspectMissing: true,
    });
    const result = await provisionV3Container(depsFor(docker, "172.30.9.7", "0"), 1);
    assert.equal(captured.removed, 0, "名字已释放,无需 rm");
    assert.equal(captured.containersCreated.length, 1, "直接重试 create 成功");
    assert.equal(captured.started, 1);
    assert.ok(result.dockerContainerId.length > 0);
  });

  test("(f) 冲突容器 inspect 非 404 失败(daemon 抖动)→ 无法判定死活,绝不删", async () => {
    const { docker, captured } = makeDocker({
      createConflictCount: 1,
      conflictInspectThrows: httpError(500, "docker daemon error"),
    });
    await assert.rejects(
      provisionV3Container(depsFor(docker, "172.30.9.8", "1"), 1),
      (err: Error) => err instanceof SupervisorError && err.code === "NameConflict",
    );
    assert.equal(captured.removed, 0, "inspect 失败绝不删");
    assert.equal(captured.containersCreated.length, 0);
  });

  test("(g) 自愈仅一次:rm 后重试仍撞 409(并发 provision 重建同名)→ 不循环,抛 NameConflict", async () => {
    const { docker, captured } = makeDocker({
      // 前两次 create 都 409:第一次触发自愈,rm 后重试(第二次)仍 409 → 不再循环。
      createConflictCount: 2,
      conflictInspectResult: { labels: OURS_V3, state: "created" },
    });
    await assert.rejects(
      provisionV3Container(depsFor(docker, "172.30.9.9", "2"), 1),
      (err: Error) => err instanceof SupervisorError && err.code === "NameConflict",
    );
    assert.equal(captured.removed, 1, "只 rm 一次");
    assert.equal(captured.containersCreated.length, 0, "两次 create 都 409,均未进 push");
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
      { docker, pool: pool as unknown as Pool, image: TEST_IMAGE, selfHostId: TEST_HOST, randomIp: () => "172.30.9.9", randomSecret: fixedSecret("f".repeat(64)) },
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
      image: TEST_IMAGE,
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
      image: TEST_IMAGE,
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
      image: TEST_IMAGE,
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
      image: TEST_IMAGE,
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
      image: TEST_IMAGE,
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

  // ─────────────────────────────────────────────────────────────────────
  // v1.0.22 host-aware stopAndRemove —— 系统性修复
  // 5/6 处调用点(idleSweep / ensureRunning stale recovery / admin 三处)
  // 都没传 host_uuid,跨 host 容器在远端不会被真清。本函数用 RETURNING host_uuid
  // 兜底,所有调用点自动 host-aware。
  //
  // 关键安全 gate(Codex round 1 review):
  //   A) host 未知 + 多 host 系统 → skip docker(host_uuid 缺失 ≠ 本地安全)
  //   B) cross-host + containerService 未注入 → skip docker(避免清错宿主)
  //
  // caller 显式传的 host_uuid 优先于 DB 里的(reconcile 路径已显式传 + 并发可信);
  // 不一致 → warn 留诊断线索,按 caller 走。
  // ─────────────────────────────────────────────────────────────────────

  /** 容器服务 stub —— 记录所有 stop/remove 调用,缺省其它方法。 */
  function makeContainerServiceStub() {
    const calls: Array<{ op: "stop" | "remove"; hostId: string; cid: string }> = [];
    const cs = {
      ensureVolume: async () => {},
      removeVolume: async () => {},
      inspectVolume: async () => ({ exists: false }),
      createAndStart: async () => ({ containerInternalId: "" }),
      stop: async (hostId: string, cid: string, _opts?: unknown) => {
        calls.push({ op: "stop", hostId, cid });
      },
      remove: async (hostId: string, cid: string, _opts?: unknown) => {
        calls.push({ op: "remove", hostId, cid });
      },
      inspect: async () => { throw new Error("inspect should not be called"); },
      // v1.0.84 PR #4 image guard:facade 默认返带 v3-sink token,let stopAndRemove
      // 系列测试不被 guard 拦下来(本 helper 给 stopAndRemove 路径用,not provision)。
      inspectImage: async () => ({
        id: "sha256:fakeimage",
        repoTags: ["openclaude/openclaude-runtime:test"],
        labels: { "oc.runtime.features": "file-proxy-v1 v3-sink" },
      }),
      isRemote: async () => true,
      resolveBaselinePaths: async () => ({
        agentsMdHostPath: "/tmp/baseline-not-used/AGENTS.md",
        claudeMdHostPath: "/tmp/baseline-not-used/CLAUDE.md",
        skillsDirHostPath: "/tmp/baseline-not-used/skills",
      }),
    };
    return { cs, calls };
  }

  /** console.warn 捕获,断言 gate 触发了诊断日志。 */
  async function withCapturedWarns<T>(fn: () => Promise<T>): Promise<{ result: T; warns: string[] }> {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" "));
    };
    try {
      const result = await fn();
      return { result, warns };
    } finally {
      console.warn = orig;
    }
  }

  test("v1.0.22: caller 无 host_uuid + DB host=remote → 用 RETURNING 兜底走 containerService", async () => {
    const { docker, captured } = makeDocker();
    const pool = new FakePool();
    pool.rows.push({
      id: 1189,
      user_id: 33,
      host_uuid: "boheyun-1",
      bound_ip: "172.30.2.10",
      image: TEST_IMAGE,
      secret_hash: Buffer.alloc(32),
      state: "active",
      port: 18789,
      container_internal_id: "8654750e",
      last_ws_activity: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    });
    const { cs, calls } = makeContainerServiceStub();

    // caller 没传 host_uuid(模拟 idleSweep / admin 旧调用点)
    await stopAndRemoveV3Container(
      {
        docker,
        pool: pool as unknown as Pool,
        image: TEST_IMAGE,
        // biome-ignore lint/suspicious/noExplicitAny: containerService 类型只在这里 stub
        containerService: cs as any,
        selfHostId: "self",
      },
      { id: 1189, container_internal_id: "8654750e" },
    );

    // RETURNING host_uuid 给到 boheyun-1 → 走 containerService,本地 docker 必须 0 触
    assert.equal(captured.stopped, 0, "本地 docker.stop 不应被调");
    assert.equal(captured.removed, 0, "本地 docker.remove 不应被调");
    assert.equal(calls.length, 2, "containerService 应被调 stop + remove 两次");
    assert.deepEqual(calls[0], { op: "stop", hostId: "boheyun-1", cid: "8654750e" });
    assert.deepEqual(calls[1], { op: "remove", hostId: "boheyun-1", cid: "8654750e" });
    assert.equal(pool.rows[0]!.state, "vanished");
  });

  test("v1.0.22: caller 无 host_uuid + DB host=selfHostId → 走本地 docker", async () => {
    const { docker, captured } = makeDocker();
    const pool = new FakePool();
    pool.rows.push({
      id: 50,
      user_id: 7,
      host_uuid: "self",
      bound_ip: "172.30.0.50",
      image: TEST_IMAGE,
      secret_hash: Buffer.alloc(32),
      state: "active",
      port: 18789,
      container_internal_id: "selfcid",
      last_ws_activity: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    });
    const { cs, calls } = makeContainerServiceStub();

    await stopAndRemoveV3Container(
      {
        docker,
        pool: pool as unknown as Pool,
        image: TEST_IMAGE,
        // biome-ignore lint/suspicious/noExplicitAny: containerService 类型只在这里 stub
        containerService: cs as any,
        selfHostId: "self",
      },
      { id: 50, container_internal_id: "selfcid" },
    );

    assert.equal(captured.stopped, 1, "本地 docker.stop 必须被调");
    assert.ok(captured.removed >= 1, "本地 docker.remove 必须被调");
    assert.equal(calls.length, 0, "containerService 不应被调");
    assert.equal(pool.rows[0]!.state, "vanished");
  });

  test("v1.0.22: caller 无 host_uuid + DB host=null + 单机模式 → 走本地 docker(legacy)", async () => {
    // selfHostId 缺失 → isMultiHost=false → host_uuid=null 被允许走本地
    const { docker, captured } = makeDocker();
    const pool = new FakePool();
    pool.rows.push({
      id: 60,
      user_id: 8,
      host_uuid: null,
      bound_ip: "172.30.0.60",
      image: TEST_IMAGE,
      secret_hash: Buffer.alloc(32),
      state: "active",
      port: 18789,
      container_internal_id: "legacycid",
      last_ws_activity: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    });

    await stopAndRemoveV3Container(
      { docker, pool: pool as unknown as Pool, image: TEST_IMAGE }, // 不注入 selfHostId/containerService
      { id: 60, container_internal_id: "legacycid" },
    );

    assert.equal(captured.stopped, 1);
    assert.ok(captured.removed >= 1);
    assert.equal(pool.rows[0]!.state, "vanished");
  });

  test("v1.0.22 / P1d: caller 无 host_uuid + UPDATE 0 行(row 已删/跨 channel) → skip docker + warn", async () => {
    // FakePool 没插任何 row → UPDATE rowCount=0。P1d 起:rowCount=0 统一早返回 false 跳过 docker
    // 清理(不再用 caller 的 container_internal_id 误清,跨 channel 安全),docker 残骸交 orphanReconcile;
    // 非守卫路径(requireNoOpenMigration 未设)记一条诊断 warn。
    const { docker, captured } = makeDocker();
    const pool = new FakePool();
    const { cs, calls } = makeContainerServiceStub();

    const { warns } = await withCapturedWarns(async () => {
      await stopAndRemoveV3Container(
        {
          docker,
          pool: pool as unknown as Pool,
          image: TEST_IMAGE,
          // biome-ignore lint/suspicious/noExplicitAny: containerService 类型只在这里 stub
          containerService: cs as any,
          selfHostId: "self",
        },
        { id: 9999, container_internal_id: "ghostcid" },
      );
    });

    assert.equal(captured.stopped, 0, "rowCount=0 不应触本地 docker");
    assert.equal(captured.removed, 0);
    assert.equal(calls.length, 0, "containerService 也不应被调");
    assert.ok(
      warns.some((w) => /rowCount=0.*skipping docker cleanup/.test(w)),
      `rowCount=0 诊断 warn 必须写 console:实际 warns=${JSON.stringify(warns)}`,
    );
  });

  test("v1.0.22: caller 显式 remote host + DB host=null → caller 优先,走 containerService", async () => {
    // 模拟 reconcile 路径已显式传 host_uuid 但 DB 里 host_uuid 还没补全 / 并发改
    const { docker, captured } = makeDocker();
    const pool = new FakePool();
    pool.rows.push({
      id: 70,
      user_id: 9,
      host_uuid: null, // DB 没填
      bound_ip: "172.30.3.70",
      image: TEST_IMAGE,
      secret_hash: Buffer.alloc(32),
      state: "active",
      port: 18789,
      container_internal_id: "callercid",
      last_ws_activity: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    });
    const { cs, calls } = makeContainerServiceStub();

    await stopAndRemoveV3Container(
      {
        docker,
        pool: pool as unknown as Pool,
        image: TEST_IMAGE,
        // biome-ignore lint/suspicious/noExplicitAny: containerService 类型只在这里 stub
        containerService: cs as any,
        selfHostId: "self",
      },
      { id: 70, container_internal_id: "callercid", host_uuid: "boheyun-1" },
    );

    assert.equal(captured.stopped, 0);
    assert.equal(captured.removed, 0);
    assert.equal(calls.length, 2, "caller 显式 host 必须走 containerService");
    assert.equal(calls[0]!.hostId, "boheyun-1");
    assert.equal(calls[1]!.hostId, "boheyun-1");
  });

  test("v1.0.22: caller 显式 self + DB host=remote → caller 优先,走本地 + warn 不一致", async () => {
    // 反向 case:caller 自信本地,DB 里却是 remote;按 caller 走但留诊断 warn
    const { docker, captured } = makeDocker();
    const pool = new FakePool();
    pool.rows.push({
      id: 80,
      user_id: 10,
      host_uuid: "boheyun-1", // DB 里是远端
      bound_ip: "172.30.0.80",
      image: TEST_IMAGE,
      secret_hash: Buffer.alloc(32),
      state: "active",
      port: 18789,
      container_internal_id: "reversecid",
      last_ws_activity: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    });
    const { cs, calls } = makeContainerServiceStub();

    const { warns } = await withCapturedWarns(async () => {
      await stopAndRemoveV3Container(
        {
          docker,
          pool: pool as unknown as Pool,
          image: TEST_IMAGE,
          // biome-ignore lint/suspicious/noExplicitAny: containerService 类型只在这里 stub
          containerService: cs as any,
          selfHostId: "self",
        },
        { id: 80, container_internal_id: "reversecid", host_uuid: "self" }, // caller 说本地
      );
    });

    assert.equal(captured.stopped, 1, "caller=self → 必须走本地 docker");
    assert.ok(captured.removed >= 1);
    assert.equal(calls.length, 0, "containerService 不应被调");
    assert.ok(
      warns.some((w) => /caller host_uuid != db host_uuid/.test(w)),
      `不一致 warn 必须写 console:实际 warns=${JSON.stringify(warns)}`,
    );
  });

  test("v1.0.22: caller 无 host_uuid + DB host=remote + containerService 缺失 → skip + warn", async () => {
    // gate B:cross-host 但缺 containerService(配置漏装) → 不静默回退本地
    const { docker, captured } = makeDocker();
    const pool = new FakePool();
    pool.rows.push({
      id: 90,
      user_id: 11,
      host_uuid: "boheyun-1",
      bound_ip: "172.30.4.90",
      image: TEST_IMAGE,
      secret_hash: Buffer.alloc(32),
      state: "active",
      port: 18789,
      container_internal_id: "noservicecid",
      last_ws_activity: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    });

    const { warns } = await withCapturedWarns(async () => {
      await stopAndRemoveV3Container(
        {
          docker,
          pool: pool as unknown as Pool,
          image: TEST_IMAGE,
          selfHostId: "self",
          // 故意不注入 containerService
        },
        { id: 90, container_internal_id: "noservicecid" },
      );
    });

    assert.equal(captured.stopped, 0, "cross-host + 无 service 不能回退本地 docker");
    assert.equal(captured.removed, 0);
    assert.ok(
      warns.some((w) => /cross-host row but containerService missing/.test(w)),
      `gate B warn 必须写 console:实际 warns=${JSON.stringify(warns)}`,
    );
    // row 仍 vanished(DB 意图已落库)
    assert.equal(pool.rows[0]!.state, "vanished");
  });
});

// ───────────────────────────────────────────────────────────────────────
//  getV3ContainerStatus
// ───────────────────────────────────────────────────────────────────────

describe("getV3ContainerStatus", () => {
  // 第 2 / 第 5 个 sub-test 会调 provisionV3Container 顺手起一行;OC_V3_CCB_BASELINE_OPTIONAL
  // 必须置 "1" 让 baseline 缺失走 warn+skip,否则 provision 抛 CcbBaselineMissing。基线本身
  // 不是本 describe 关心范围(那是上面 `provisionV3Container — CCB baseline 挂载分支`),所以
  // 这里复用「OPTIONAL=1 屏蔽」模式,跟 `provisionV3Container` / `per-host max_containers cap`
  // 两个 describe 一致(:447-452 / :1372-1377)。
  let prevOptional: string | undefined;
  before(() => {
    prevOptional = process.env.OC_V3_CCB_BASELINE_OPTIONAL;
    process.env.OC_V3_CCB_BASELINE_OPTIONAL = "1";
  });
  after(() => {
    if (prevOptional === undefined) delete process.env.OC_V3_CCB_BASELINE_OPTIONAL;
    else process.env.OC_V3_CCB_BASELINE_OPTIONAL = prevOptional;
  });

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
      { docker, pool: pool as unknown as Pool, image: TEST_IMAGE, selfHostId: TEST_HOST, randomIp: () => "172.30.10.10", randomSecret: fixedSecret("a".repeat(64)) },
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
      image: TEST_IMAGE,
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

  test("active row 但 container_internal_id 为 NULL + age<15s → state='provisioning'(saga 中段合法在途,ensureRunning 等待而非销毁)", async () => {
    const { docker } = makeDocker();
    const pool = new FakePool();
    pool.rows.push({
      id: 1,
      user_id: 5,
      host_uuid: null,
      bound_ip: "172.30.12.12",
      image: TEST_IMAGE,
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
    // saga 修复(Codex MAJOR):young cid=NULL 是并发 provision 在途态,不再是可销毁的 'stopped'。
    assert.equal(r!.state, "provisioning");
    assert.equal(r!.dockerContainerId, "");
  });

  test("active row + container_internal_id NULL + age>=15s → state='missing'(孤儿 row 自愈,v1.0.8)", async () => {
    const { docker } = makeDocker();
    const pool = new FakePool();
    // row 1120-style 孤儿:created_at 30s 之前,container_internal_id 仍 NULL
    // → 不可能是合法 in-flight provision,视作 missing,让 ensureRunning 走
    //   stopAndRemove + re-provision 自愈,而不是死在 "stopped" 5s 重连循环。
    pool.rows.push({
      id: 1,
      user_id: 5,
      host_uuid: null,
      bound_ip: "172.30.12.13",
      image: TEST_IMAGE,
      secret_hash: Buffer.alloc(32),
      state: "active",
      port: 18789,
      container_internal_id: null,
      last_ws_activity: new Date(),
      created_at: new Date(Date.now() - 30_000),
      updated_at: new Date(Date.now() - 30_000),
    });
    const r = await getV3ContainerStatus(
      { docker, pool: pool as unknown as Pool, image: TEST_IMAGE },
      5,
    );
    assert.ok(r);
    assert.equal(r!.state, "missing");
    assert.equal(r!.dockerContainerId, "");
  });
});

// ───────────────────────────────────────────────────────────────────────
//  V3 Phase 3I — per-host max_containers cap(原 MAX_RUNNING_CONTAINERS 全局 cap 已删,
//  权威源现在是 compute_hosts.max_containers,admin UI 管理,per-host 各自独立)
// ───────────────────────────────────────────────────────────────────────

describe("provisionV3Container — per-host max_containers cap (3I)", () => {
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
  function seedActiveRows(n: number, hostUuid: string = TEST_HOST): void {
    for (let i = 0; i < n; i++) {
      const now = new Date();
      pool.rows.push({
        id: pool.nextId++,
        user_id: 1000 + pool.nextId,
        host_uuid: hostUuid,
        bound_ip: `172.30.100.${pool.nextId}`,
        image: TEST_IMAGE,
        secret_hash: Buffer.alloc(32),
        state: "active",
        port: V3_CONTAINER_PORT,
        container_internal_id: `seed-${pool.nextId}`,
        last_ws_activity: now,
        created_at: now,
        updated_at: now,
      });
    }
  }

  test("active < cap → 正常 provision(host max=3,2 active)", async () => {
    const { docker } = makeDocker();
    pool.setHostMax(TEST_HOST, 3);
    seedActiveRows(2);
    const r = await provisionV3Container(
      {
        docker,
        pool: pool as unknown as Pool,
        image: TEST_IMAGE,
        selfHostId: TEST_HOST,
        randomIp: () => "172.30.50.1",
        randomSecret: fixedSecret("0".repeat(64)),
      },
      777,
    );
    assert.ok(r.containerId > 0);
    assert.equal(r.boundIp, "172.30.50.1");
    // 第三行成功落了
    assert.equal(
      pool.rows.filter((x) => x.state === "active" && x.host_uuid === TEST_HOST).length,
      3,
    );
  });

  test("active = cap → 抛 SupervisorError('HostFull') 在事务内 + 不动 docker", async () => {
    const { docker, captured } = makeDocker();
    pool.setHostMax(TEST_HOST, 3);
    seedActiveRows(3);
    await assert.rejects(
      provisionV3Container(
        {
          docker,
          pool: pool as unknown as Pool,
          image: TEST_IMAGE,
          selfHostId: TEST_HOST,
          randomIp: () => "172.30.50.99",
          randomSecret: fixedSecret("1".repeat(64)),
        },
        9001,
      ),
      (err: Error) => err instanceof SupervisorError && err.code === "HostFull",
    );
    // cap 检查在事务内,与 host-cap 锁串行,撞 cap 时 BEGIN 已经发生但走 ROLLBACK,docker 一字未动
    assert.deepEqual(pool.clientLog, ["BEGIN", "ROLLBACK"]);
    assert.equal(captured.containersCreated.length, 0);
    assert.equal(captured.volumesCreated.length, 0);
    // 行数不变(事务回滚)
    assert.equal(pool.rows.length, 3);
  });

  test("active > cap(运维手动塞了多)→ 仍然 HostFull,不会绕过", async () => {
    const { docker } = makeDocker();
    pool.setHostMax(TEST_HOST, 3);
    seedActiveRows(5);
    await assert.rejects(
      provisionV3Container(
        {
          docker,
          pool: pool as unknown as Pool,
          image: TEST_IMAGE,
          selfHostId: TEST_HOST,
          randomIp: () => "172.30.51.1",
          randomSecret: fixedSecret("2".repeat(64)),
        },
        9002,
      ),
      (err: Error) => err instanceof SupervisorError && err.code === "HostFull",
    );
  });

  test("vanished 行不计入 cap(已死容器不占容量)", async () => {
    const { docker } = makeDocker();
    pool.setHostMax(TEST_HOST, 3);
    seedActiveRows(2);
    // 再塞 5 个 vanished 行,模拟 idle sweep / orphan reconcile 已经清掉
    for (let i = 0; i < 5; i++) {
      const now = new Date();
      pool.rows.push({
        id: pool.nextId++,
        user_id: 8000 + i,
        host_uuid: TEST_HOST,
        bound_ip: `172.30.200.${i + 1}`,
        image: TEST_IMAGE,
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
        selfHostId: TEST_HOST,
        randomIp: () => "172.30.50.55",
        randomSecret: fixedSecret("3".repeat(64)),
      },
      9003,
    );
    assert.ok(r.containerId > 0);
  });

  test("两个 host 各自独立 cap(hostA 满,hostB 空 → hostB 仍可 provision)", async () => {
    const { docker } = makeDocker();
    // hostA cap=2,塞满 2 个 active
    pool.setHostMax(TEST_HOST, 2);
    seedActiveRows(2, TEST_HOST);
    // hostB cap=2,空
    pool.setHostMax(TEST_HOST_ALT, 2);

    // hostA 再 provision 应该被 HostFull 挡
    await assert.rejects(
      provisionV3Container(
        {
          docker,
          pool: pool as unknown as Pool,
          image: TEST_IMAGE,
          selfHostId: TEST_HOST,
          randomIp: () => "172.30.60.1",
          randomSecret: fixedSecret("a".repeat(64)),
        },
        9101,
      ),
      (err: Error) => err instanceof SupervisorError && err.code === "HostFull",
    );

    // hostB 不受影响
    const r = await provisionV3Container(
      {
        docker,
        pool: pool as unknown as Pool,
        image: TEST_IMAGE,
        selfHostId: TEST_HOST_ALT,
        randomIp: () => "172.30.60.2",
        randomSecret: fixedSecret("b".repeat(64)),
      },
      9102,
    );
    assert.ok(r.containerId > 0);
    // 校验落在 hostB
    const inserted = pool.rows.find((x) => x.user_id === 9102);
    assert.ok(inserted);
    assert.equal(inserted!.host_uuid, TEST_HOST_ALT);
    // hostA 行数没变
    assert.equal(
      pool.rows.filter((x) => x.state === "active" && x.host_uuid === TEST_HOST).length,
      2,
    );
  });

  test("effectiveHostUuid 缺失(无 hostId 也无 selfHostId)→ InvalidArgument fail-closed", async () => {
    const { docker, captured } = makeDocker();
    pool.setHostMax(TEST_HOST, 10);
    await assert.rejects(
      provisionV3Container(
        {
          docker,
          pool: pool as unknown as Pool,
          image: TEST_IMAGE,
          // 故意不给 selfHostId,也不传 hostId
          randomIp: () => "172.30.61.1",
          randomSecret: fixedSecret("c".repeat(64)),
        },
        9103,
      ),
      (err: Error) =>
        err instanceof SupervisorError && err.code === "InvalidArgument",
    );
    // 没碰 docker / 没插行
    assert.equal(captured.containersCreated.length, 0);
    assert.equal(pool.rows.length, 0);
  });

  test("compute_hosts 行 missing(max_containers IS NULL)→ InvalidArgument", async () => {
    const { docker } = makeDocker();
    // 显式置 null,模拟 compute_hosts 里没有这个 host 的行
    pool.setHostMax(TEST_HOST, null);
    await assert.rejects(
      provisionV3Container(
        {
          docker,
          pool: pool as unknown as Pool,
          image: TEST_IMAGE,
          selfHostId: TEST_HOST,
          randomIp: () => "172.30.62.1",
          randomSecret: fixedSecret("d".repeat(64)),
        },
        9104,
      ),
      (err: Error) =>
        err instanceof SupervisorError && err.code === "InvalidArgument",
    );
    // 事务起了又回滚
    assert.deepEqual(pool.clientLog, ["BEGIN", "ROLLBACK"]);
    assert.equal(pool.rows.length, 0);
  });

  test("非 canonical UUID(大写/缺位/带空格)→ InvalidArgument fail-closed", async () => {
    const { docker } = makeDocker();
    pool.setHostMax(TEST_HOST, 10);
    // 大写 — canonical 必须全小写
    await assert.rejects(
      provisionV3Container(
        {
          docker,
          pool: pool as unknown as Pool,
          image: TEST_IMAGE,
          selfHostId: "11111111-1111-1111-1111-11111111111A",
          randomIp: () => "172.30.63.1",
          randomSecret: fixedSecret("e".repeat(64)),
        },
        9105,
      ),
      (err: Error) =>
        err instanceof SupervisorError && err.code === "InvalidArgument",
    );
    // 短一位
    await assert.rejects(
      provisionV3Container(
        {
          docker,
          pool: pool as unknown as Pool,
          image: TEST_IMAGE,
          selfHostId: "11111111-1111-1111-1111-11111111111",
          randomIp: () => "172.30.63.2",
          randomSecret: fixedSecret("f".repeat(64)),
        },
        9106,
      ),
      (err: Error) =>
        err instanceof SupervisorError && err.code === "InvalidArgument",
    );
    // multi-host 路径(containerService 存在 + hostId ≠ selfHostId)+ 非 canonical hostId
    // → 必须在 assertImageHasV3Sink 之前 fail-closed,inspectImage 不能被触
    // (否则错误形态会被 facade 改写成 "unknown hostId" / PG cast 失败,不再统一)。
    let inspectImageCalls = 0;
    const cs = {
      ensureVolume: async () => {},
      removeVolume: async () => {},
      inspectVolume: async () => ({ exists: false }),
      createAndStart: async () => ({ containerInternalId: "" }),
      stop: async () => {},
      remove: async () => {},
      inspect: async () => { throw new Error("not used"); },
      inspectImage: async () => {
        inspectImageCalls++;
        return { id: "sha256:x", repoTags: [], labels: {} };
      },
      isRemote: async () => true,
      resolveBaselinePaths: async () => ({
        agentsMdHostPath: "/tmp/x/AGENTS.md",
        claudeMdHostPath: "/tmp/x/CLAUDE.md",
        skillsDirHostPath: "/tmp/x/skills",
      }),
    };
    await assert.rejects(
      provisionV3Container(
        {
          docker,
          pool: pool as unknown as Pool,
          image: TEST_IMAGE,
          selfHostId: TEST_HOST,
          // biome-ignore lint/suspicious/noExplicitAny: containerService stub
          containerService: cs as any,
          randomIp: () => "172.30.63.3",
          randomSecret: fixedSecret("a".repeat(64)),
        },
        9107,
        "NOT-A-UUID", // hostId 非法,但 ≠ selfHostId → 会走 useRemote 路径
      ),
      (err: Error) =>
        err instanceof SupervisorError && err.code === "InvalidArgument",
    );
    assert.equal(
      inspectImageCalls,
      0,
      "canonical 校验必须早于 assertImageHasV3Sink — inspectImage 不应被触发",
    );
  });

  test('hostId="" + selfHostId 合法 → InvalidArgument (拒绝静默退化为 selfHostId)', async () => {
    // 守 effectiveHostUuid SSOT 不被 `||` 短路吃掉空串:
    // 旧实现 `(typeof hostId === "string" ? hostId : "") || selfHostId` 会让 hostId=""
    // 静默退化到 selfHostId,但 raw hostId 又会驱动 useRemote 走远端路径,
    // 形成"lock/cap 用 selfHostId、docker 操作用 ''"双源错位。
    const { docker } = makeDocker();
    pool.setHostMax(TEST_HOST, 10);
    let inspectImageCalls = 0;
    const cs = {
      ensureVolume: async () => {},
      removeVolume: async () => {},
      inspectVolume: async () => ({ exists: false }),
      createAndStart: async () => ({ containerInternalId: "" }),
      stop: async () => {},
      remove: async () => {},
      inspect: async () => { throw new Error("not used"); },
      inspectImage: async () => {
        inspectImageCalls++;
        return { id: "sha256:x", repoTags: [], labels: {} };
      },
      isRemote: async () => true,
      resolveBaselinePaths: async () => ({
        agentsMdHostPath: "/tmp/x/AGENTS.md",
        claudeMdHostPath: "/tmp/x/CLAUDE.md",
        skillsDirHostPath: "/tmp/x/skills",
      }),
    };
    await assert.rejects(
      provisionV3Container(
        {
          docker,
          pool: pool as unknown as Pool,
          image: TEST_IMAGE,
          selfHostId: TEST_HOST,
          // biome-ignore lint/suspicious/noExplicitAny: containerService stub
          containerService: cs as any,
          randomIp: () => "172.30.63.4",
          randomSecret: fixedSecret("b".repeat(64)),
        },
        9108,
        "", // 空串 hostId — 必须被 fail-closed 拒,不能静默退化到 selfHostId
      ),
      (err: Error) =>
        err instanceof SupervisorError && err.code === "InvalidArgument",
    );
    assert.equal(inspectImageCalls, 0, "空 hostId 必须早于任何外部副作用拒绝");
    assert.equal(
      pool.rows.length,
      0,
      "空 hostId 不能让 selfHostId 兜底 → 无 INSERT 副作用",
    );
  });

  test("env OC_MAX_RUNNING_CONTAINERS 已废弃 → no-op,只看 compute_hosts.max_containers", async () => {
    const { docker } = makeDocker();
    const original = process.env.OC_MAX_RUNNING_CONTAINERS;
    try {
      // 故意把 env 设到 1(老语义会挡),但权威源是 compute_hosts.max_containers=5
      process.env.OC_MAX_RUNNING_CONTAINERS = "1";
      pool.setHostMax(TEST_HOST, 5);
      seedActiveRows(2);
      const r = await provisionV3Container(
        {
          docker,
          pool: pool as unknown as Pool,
          image: TEST_IMAGE,
          selfHostId: TEST_HOST,
          randomIp: () => "172.30.64.1",
          randomSecret: fixedSecret("9".repeat(64)),
        },
        9107,
      );
      // env=1 没生效,host max=5 放行 → 3 个 active
      assert.ok(r.containerId > 0);
      assert.equal(
        pool.rows.filter((x) => x.state === "active" && x.host_uuid === TEST_HOST).length,
        3,
      );
    } finally {
      if (original === undefined) delete process.env.OC_MAX_RUNNING_CONTAINERS;
      else process.env.OC_MAX_RUNNING_CONTAINERS = original;
    }
  });

  test("INSERT 行的 host_uuid = effectiveHostUuid(selfHostId 兜底时)", async () => {
    const { docker } = makeDocker();
    pool.setHostMax(TEST_HOST_ALT, 10);
    const r = await provisionV3Container(
      {
        docker,
        pool: pool as unknown as Pool,
        image: TEST_IMAGE,
        selfHostId: TEST_HOST_ALT,
        // 不传 hostId,走 selfHostId 兜底
        randomIp: () => "172.30.65.1",
        randomSecret: fixedSecret("7".repeat(64)),
      },
      9108,
    );
    assert.equal(r.hostId, TEST_HOST_ALT);
    const inserted = pool.rows.find((x) => x.user_id === 9108);
    assert.ok(inserted);
    assert.equal(inserted!.host_uuid, TEST_HOST_ALT);
  });

  test("INSERT 行的 host_uuid = effectiveHostUuid(hostId 优先于 selfHostId)", async () => {
    const { docker } = makeDocker();
    // 注意:hostId !== selfHostId 时 useRemote 会激活(若 containerService 存在);
    // 这里不传 containerService → useRemote=false → 走单机路径,effectiveHostUuid=hostId,
    // 行落到 TEST_HOST_ALT
    pool.setHostMax(TEST_HOST_ALT, 10);
    const r = await provisionV3Container(
      {
        docker,
        pool: pool as unknown as Pool,
        image: TEST_IMAGE,
        // selfHostId 是 TEST_HOST,但显式传 hostId=TEST_HOST_ALT,后者赢
        selfHostId: TEST_HOST,
        randomIp: () => "172.30.65.2",
        randomSecret: fixedSecret("8".repeat(64)),
      },
      9109,
      TEST_HOST_ALT, // hostId(positional 3rd arg)
    );
    assert.equal(r.hostId, TEST_HOST_ALT);
    const inserted = pool.rows.find((x) => x.user_id === 9109);
    assert.ok(inserted);
    assert.equal(inserted!.host_uuid, TEST_HOST_ALT);
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

  // v1.0.8 — node-agent VOL_CREATE_FAIL 几乎都是 host 级 docker daemon 问题,
  // 归 TransientHostFault 让 v3ensureRunning 标该 host 60s cooldown 自动换台。
  test("VOL_CREATE_FAIL → TransientHostFault(不依赖文案,任何 VOL_CREATE_FAIL 都归)", async () => {
    const { AgentAppError } = await import("../compute-pool/nodeAgentClient.js");
    const { wrapDockerError } = await import("../agent-sandbox/v3supervisor.js");
    const err = new AgentAppError(
      "h",
      500,
      "VOL_CREATE_FAIL",
      "agent returned 500: {code:VOL_CREATE_FAIL,error:create volume oc-v3-data-u28: ...}",
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
//  CCB baseline (Codex AGENTS.md + 平台守则 CLAUDE.md + baseline skills 只读注入)
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
 * 注入全部 `V3_CCB_BASELINE_SKILL_NAMES` 里的 skill(完整 manifest),
 * 所有 SKILL.md 都写;`withAllSkillMd=false` 时故意漏第一条 skill 的 SKILL.md,
 * 用来覆盖"一条 skill 缺 SKILL.md → 整个 resolve 返 null"分支(fail-all)。
 */
function makeFakeBaseline(withAllSkillMd = true): { dir: string; cleanup: () => void } | null {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    return null;
  }
  const dir = mkdtempSync(pathJoin(tmpdir(), "ccb-baseline-test-"));
  writeFileSync(pathJoin(dir, "AGENTS.md"), "# test codex baseline\n", { mode: 0o644 });
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
      existsSync(pathJoin(baselineDir, "AGENTS.md")),
      `shipped baseline AGENTS.md missing at ${baselineDir}`,
    );
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

  test("(root only) happy path returns AGENTS.md + CLAUDE.md + skills/ realpaths", () => {
    const b = makeFakeBaseline();
    if (!b) return; // 非 root 跳过
    try {
      const got = resolveCcbBaselineMounts(b.dir);
      assert.ok(got, "expected non-null result");
      assert.equal(got!.agentsMdHostPath, pathJoin(b.dir, "AGENTS.md"));
      assert.equal(got!.claudeMdHostPath, pathJoin(b.dir, "CLAUDE.md"));
      assert.equal(got!.skillsDirHostPath, pathJoin(b.dir, "skills"));
    } finally {
      b.cleanup();
    }
  });

  test("(root only) rejects missing AGENTS.md (Codex native rules must be mounted)", () => {
    const b = makeFakeBaseline();
    if (!b) return; // 非 root 跳过
    try {
      rmSync(pathJoin(b.dir, "AGENTS.md"));
      assert.equal(resolveCcbBaselineMounts(b.dir), null);
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
          image: TEST_IMAGE, selfHostId: TEST_HOST,
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

  test("baseline 缺失 + OC_V3_CCB_BASELINE_OPTIONAL=1 → warn 并继续(7 条 Binds:5 volume + codex-auth + ssh,无 baseline ro)", async () => {
    process.env.OC_V3_CCB_BASELINE_OPTIONAL = "1";
    const { docker, captured } = makeDocker();
    await provisionV3Container(
      {
        docker,
        pool: pool as unknown as Pool,
        image: TEST_IMAGE, selfHostId: TEST_HOST,
        randomIp: () => "172.30.6.7",
        randomSecret: fixedSecret("b".repeat(64)),
        ccbBaselineDir: "/definitely/not/a/baseline/dir",
      },
      124,
    );
    const opts = captured.containersCreated[0]!;
    // D2 全套 5 条 volume bind + codex-auth legacy ro + ssh-user-run ro,不追加 baseline ro
    // (baselineMounts=null 因为 OPTIONAL=1 + 假目录)
    assert.deepEqual(opts.HostConfig?.Binds, [
      `oc-v3-data-u124:${V3_VOLUME_MOUNT}:rw`,
      `oc-v3-proj-u124:${V3_PROJECTS_MOUNT}:rw`,
      `oc-v3-codex-u124:${V3_CODEX_HOME_MOUNT}:rw`,
      `oc-v3-userlocal-u124:${V3_USER_LOCAL_MOUNT}:rw`,
      `oc-v3-userconfig-u124:${V3_USER_CONFIG_MOUNT}:rw`,
      "/var/lib/openclaude-v3/codex-container-auth:/run/oc/codex-auth:ro",
      "/run/ccb-ssh/u124:/run/ccb-ssh:ro",
    ]);
  });

  test("(root only) baseline 齐全 → 10 条 Binds(5 volume + codex-auth + ssh + AGENTS.md + CLAUDE.md + skills 父目录)", async () => {
    const b = makeFakeBaseline();
    if (!b) return; // 非 root 跳过
    try {
      const { docker, captured } = makeDocker();
      await provisionV3Container(
        {
          docker,
          pool: pool as unknown as Pool,
          image: TEST_IMAGE, selfHostId: TEST_HOST,
          randomIp: () => "172.30.6.8",
          randomSecret: fixedSecret("c".repeat(64)),
          ccbBaselineDir: b.dir,
        },
        125,
      );
      const opts = captured.containersCreated[0]!;
      // 顺序匹配 v3supervisor.ts:base 5 → codex-auth → ssh → baseline AGENTS/CLAUDE/skills。
      assert.deepEqual(opts.HostConfig?.Binds, [
        `oc-v3-data-u125:${V3_VOLUME_MOUNT}:rw`,
        `oc-v3-proj-u125:${V3_PROJECTS_MOUNT}:rw`,
        `oc-v3-codex-u125:${V3_CODEX_HOME_MOUNT}:rw`,
        `oc-v3-userlocal-u125:${V3_USER_LOCAL_MOUNT}:rw`,
        `oc-v3-userconfig-u125:${V3_USER_CONFIG_MOUNT}:rw`,
        "/var/lib/openclaude-v3/codex-container-auth:/run/oc/codex-auth:ro",
        "/run/ccb-ssh/u125:/run/ccb-ssh:ro",
        `${pathJoin(b.dir, "AGENTS.md")}:/opt/openclaude/AGENTS.md:ro`,
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

// ───────────────────────────────────────────────────────────────────────
//  v1.0.8 — RemoteContractViolation 守门:node-agent 返回空 containerInternalId
//  防止孤儿 row(state='active' + container_internal_id IS NULL)入库,根因
//  覆盖 v1.0.7 报告的 "5秒后重连" 死循环 bug。
// ───────────────────────────────────────────────────────────────────────

describe("provisionV3Container — RemoteContractViolation 守门(v1.0.8)", () => {
  let prevOptional: string | undefined;
  before(() => {
    prevOptional = process.env.OC_V3_CCB_BASELINE_OPTIONAL;
    process.env.OC_V3_CCB_BASELINE_OPTIONAL = "1";
  });
  after(() => {
    if (prevOptional === undefined) delete process.env.OC_V3_CCB_BASELINE_OPTIONAL;
    else process.env.OC_V3_CCB_BASELINE_OPTIONAL = prevOptional;
  });

  // 远端路径需要 hostId !== selfHostId + containerService 注入,触发 useRemote=true 分支。
  const SELF_HOST = "00000000-0000-0000-0000-00000000aaaa";
  const REMOTE_HOST = "00000000-0000-0000-0000-00000000bbbb";

  function makeStubContainerService(createAndStartReturn: unknown) {
    return {
      ensureVolume: async () => undefined,
      removeVolume: async () => undefined,
      inspectVolume: async () => ({ exists: true }),
      createAndStart: async () => createAndStartReturn as { containerInternalId: string },
      stop: async () => undefined,
      remove: async () => undefined,
      inspect: async () => {
        throw new Error("unused in test");
      },
      // v1.0.84 PR #4 image guard:默认 labels 含 v3-sink → 这些 RemoteContractViolation
      // 用例不被 guard 拦,继续验证原 createAndStart 协议。
      inspectImage: async () => ({
        id: "sha256:fakeimage",
        repoTags: [TEST_IMAGE],
        labels: { "oc.runtime.features": "file-proxy-v1 v3-sink" },
      }),
      isRemote: async () => true,
      resolveBaselinePaths: async () => ({
        agentsMdHostPath: "/var/lib/openclaude/baseline/AGENTS.md",
        claudeMdHostPath: "/var/lib/openclaude/baseline/CLAUDE.md",
        skillsDirHostPath: "/var/lib/openclaude/baseline/skills",
      }),
    };
  }

  async function runRemoteProvisionExpectViolation(badReturn: unknown): Promise<{ pool: FakePool; err: Error }> {
    const { docker } = makeDocker();
    const pool = new FakePool();
    const containerService = makeStubContainerService(badReturn);
    let caught: Error | undefined;
    try {
      await provisionV3Container(
        {
          docker,
          pool: pool as unknown as Pool,
          image: TEST_IMAGE,
          containerService: containerService as unknown as Parameters<typeof provisionV3Container>[0]["containerService"],
          selfHostId: SELF_HOST,
          randomIp: () => "172.30.42.42",
          randomSecret: fixedSecret("a".repeat(64)),
        },
        88,
        REMOTE_HOST,
        undefined,
        "172.30.42.0/24",
      );
    } catch (e) {
      caught = e as Error;
    }
    assert.ok(caught, "expected provisionV3Container to throw");
    return { pool, err: caught! };
  }

  // saga:RemoteContractViolation 在无事务中段抛出(createAndStart 返回空 cid),
  // 此时 Tx1 已提交占位行(BEGIN→COMMIT)→ 补偿翻 vanished,绝不留 active 孤儿 row。
  // createdDockerId 从未被赋值(违约检查早于赋值)→ 补偿无 docker 实体可清。
  function assertRemoteViolationCompensated(pool: FakePool, err: Error): void {
    assert.ok(err instanceof SupervisorError);
    assert.equal((err as SupervisorError).code, "RemoteContractViolation");
    assert.deepEqual(pool.clientLog, ["BEGIN", "COMMIT"]);
    assert.equal(pool.rows.length, 1, "Tx1 占位行已提交");
    assert.equal(pool.rows[0]!.state, "vanished", "中段违约 → 补偿翻 vanished(无 active 孤儿)");
    assert.equal(pool.rows[0]!.container_internal_id, null);
  }

  test("createAndStart 返回 {containerInternalId: ''} → RemoteContractViolation + 补偿翻 vanished", async () => {
    const { pool, err } = await runRemoteProvisionExpectViolation({ containerInternalId: "" });
    assertRemoteViolationCompensated(pool, err);
  });

  test("createAndStart 返回 {containerInternalId: undefined} → RemoteContractViolation + 补偿翻 vanished", async () => {
    const { pool, err } = await runRemoteProvisionExpectViolation({ containerInternalId: undefined });
    assertRemoteViolationCompensated(pool, err);
  });

  test("createAndStart 返回 null(整个响应缺失)→ RemoteContractViolation + 补偿翻 vanished", async () => {
    const { pool, err } = await runRemoteProvisionExpectViolation(null);
    assertRemoteViolationCompensated(pool, err);
  });

  test("createAndStart 返回 {containerInternalId: '   '} (纯空白) → RemoteContractViolation + 补偿翻 vanished", async () => {
    const { pool, err } = await runRemoteProvisionExpectViolation({ containerInternalId: "   " });
    assertRemoteViolationCompensated(pool, err);
  });
});

// ───────────────────────────────────────────────────────────────────────
//  per-host bridge gateway IP — fix for cross-host WS 1008 unauthorized
//
//  Bug 现象:test2 (tk1, bridge_cidr=172.30.2.0/24) / test3 (boheyun, 172.30.1.0/24)
//  登录后 WS 立即 1008 close、前端弹"Token 失效"。根因:
//    OPENCLAUDE_TRUST_BRIDGE_IP=V3_GATEWAY_IP("172.30.0.1")硬编码,远端容器
//    实际看到的 source IP 是本机 bridge gateway(172.30.2.1 / 172.30.1.1)→
//    mismatch → 走 token 校验 → master tunnel 不带 token → 1008。
//  修复:gatewayIpFromV3Cidr(host.bridge_cidr) 计算 per-host 真实 .1。
// ───────────────────────────────────────────────────────────────────────

describe("gatewayIpFromV3Cidr — helper unit", () => {
  test("X.Y.Z.0/24 → X.Y.Z.1", () => {
    assert.equal(gatewayIpFromV3Cidr("172.30.0.0/24"), "172.30.0.1");
    assert.equal(gatewayIpFromV3Cidr("172.30.1.0/24"), "172.30.1.1");
    assert.equal(gatewayIpFromV3Cidr("172.30.2.0/24"), "172.30.2.1");
    assert.equal(gatewayIpFromV3Cidr("10.99.5.0/24"), "10.99.5.1");
  });

  test("trim 前后空白", () => {
    assert.equal(gatewayIpFromV3Cidr("  172.30.7.0/24\n"), "172.30.7.1");
  });

  test("形状不符 → InvalidArgument(防止真 CIDR 计算被静默接受)", () => {
    const cases = [
      "",
      "not-a-cidr",
      "172.30.0.0",                  // 缺 /24
      "172.30.0.0/16",               // 错 prefix
      "172.30.0.16/28",              // 错 prefix + 非 .0 base
      "172.30.0.1/24",               // base 不是 .0
      "172.30.0.0/24/extra",
    ];
    for (const c of cases) {
      assert.throws(
        () => gatewayIpFromV3Cidr(c),
        (err: Error) => err instanceof SupervisorError && err.code === "InvalidArgument",
        `expected InvalidArgument for cidr="${c}"`,
      );
    }
  });

  test("octet 越界 → InvalidArgument", () => {
    // regex \d{1,3} 会接受 999;靠 Number 校验 0..255 兜底
    assert.throws(
      () => gatewayIpFromV3Cidr("999.30.0.0/24"),
      (err: Error) => err instanceof SupervisorError && err.code === "InvalidArgument",
    );
    assert.throws(
      () => gatewayIpFromV3Cidr("172.300.0.0/24"),
      (err: Error) => err instanceof SupervisorError && err.code === "InvalidArgument",
    );
  });
});

describe("provisionV3Container — per-host bridge gateway env injection", () => {
  let prevOptional: string | undefined;
  before(() => {
    prevOptional = process.env.OC_V3_CCB_BASELINE_OPTIONAL;
    process.env.OC_V3_CCB_BASELINE_OPTIONAL = "1";
  });
  after(() => {
    if (prevOptional === undefined) delete process.env.OC_V3_CCB_BASELINE_OPTIONAL;
    else process.env.OC_V3_CCB_BASELINE_OPTIONAL = prevOptional;
  });

  const SELF_HOST = "00000000-0000-0000-0000-00000000aaaa";
  const REMOTE_HOST = "00000000-0000-0000-0000-00000000bbbb";

  // 远端路径 createAndStart 收的是 ContainerSpec(env 是 Record<string,string>),
  // 不是 docker.createContainer 的 Env 数组。stub 把它捕获起来供断言查证。
  function makeRemoteContainerService() {
    const captured: { spec?: { env: Record<string, string>; binds?: unknown } } = {};
    const svc = {
      ensureVolume: async () => undefined,
      removeVolume: async () => undefined,
      inspectVolume: async () => ({ exists: true }),
      createAndStart: async (_hostId: string, spec: { env: Record<string, string>; binds?: unknown }) => {
        captured.spec = spec;
        return { containerInternalId: "remote-cid-1" };
      },
      stop: async () => undefined,
      remove: async () => undefined,
      inspect: async () => {
        throw new Error("unused in test");
      },
      // v1.0.84 PR #4 image guard:默认 labels 含 v3-sink → remote-spec 测试不被
      // guard 拦,继续验证 ContainerSpec 装配。
      inspectImage: async () => ({
        id: "sha256:fakeimage",
        repoTags: [TEST_IMAGE],
        labels: { "oc.runtime.features": "file-proxy-v1 v3-sink" },
      }),
      isRemote: async () => true,
      resolveBaselinePaths: async () => ({
        agentsMdHostPath: "/var/lib/openclaude/baseline/AGENTS.md",
        claudeMdHostPath: "/var/lib/openclaude/baseline/CLAUDE.md",
        skillsDirHostPath: "/var/lib/openclaude/baseline/skills",
      }),
    };
    return { svc, captured };
  }

  test("self host 默认路径(monolith)→ env 仍是 V3_GATEWAY_IP=172.30.0.1", async () => {
    const { docker, captured } = makeDocker();
    const pool = new FakePool();
    await provisionV3Container(
      {
        docker,
        pool: pool as unknown as Pool,
        image: TEST_IMAGE, selfHostId: TEST_HOST,
        randomIp: () => "172.30.0.42",
        randomSecret: fixedSecret("a".repeat(64)),
      },
      555,
    );
    const env = captured.containersCreated[0]!.Env ?? [];
    // 行为不变 — self host 注入 V3_GATEWAY_IP / V3_INTERNAL_PROXY_URL
    assert.ok(env.includes(`OPENCLAUDE_TRUST_BRIDGE_IP=${V3_GATEWAY_IP}`));
    assert.ok(env.includes(`ANTHROPIC_BASE_URL=${V3_INTERNAL_PROXY_URL}`));
    assert.ok(!env.includes("OC_CONTAINER_PREVIEW_ENABLED=1"));
  });

  test("remote host + bridgeCidr=172.30.2.0/24(tk1)→ env 注入 172.30.2.1", async () => {
    const { docker } = makeDocker();
    const pool = new FakePool();
    const { svc, captured } = makeRemoteContainerService();
    await provisionV3Container(
      {
        docker,
        pool: pool as unknown as Pool,
        image: TEST_IMAGE,
        containerService: svc as unknown as Parameters<typeof provisionV3Container>[0]["containerService"],
        selfHostId: SELF_HOST,
        randomIp: () => "172.30.2.10",
        randomSecret: fixedSecret("b".repeat(64)),
      },
      888,
      REMOTE_HOST,
      undefined,
      "172.30.2.0/24",
    );
    assert.ok(captured.spec, "containerService.createAndStart must be called");
    const env = captured.spec!.env;
    assert.equal(env.OPENCLAUDE_TRUST_BRIDGE_IP, "172.30.2.1");
    assert.equal(env.ANTHROPIC_BASE_URL, "http://172.30.2.1:18791");
    // 严格断言:不能再有任何 172.30.0.1 残留
    for (const [k, v] of Object.entries(env)) {
      assert.ok(
        !v.includes("172.30.0.1"),
        `remote-host env[${k}] must NOT contain self-host gateway 172.30.0.1, got ${v}`,
      );
    }
  });

  test("remote host + bridgeCidr=172.30.1.0/24(boheyun)→ env 注入 172.30.1.1", async () => {
    const { docker } = makeDocker();
    const pool = new FakePool();
    const { svc, captured } = makeRemoteContainerService();
    await provisionV3Container(
      {
        docker,
        pool: pool as unknown as Pool,
        image: TEST_IMAGE,
        containerService: svc as unknown as Parameters<typeof provisionV3Container>[0]["containerService"],
        selfHostId: SELF_HOST,
        randomIp: () => "172.30.1.10",
        randomSecret: fixedSecret("c".repeat(64)),
      },
      889,
      REMOTE_HOST,
      undefined,
      "172.30.1.0/24",
    );
    const env = captured.spec!.env;
    assert.equal(env.OPENCLAUDE_TRUST_BRIDGE_IP, "172.30.1.1");
    assert.equal(env.ANTHROPIC_BASE_URL, "http://172.30.1.1:18791");
  });

  test("remote host + 缺 bridgeCidr → InvalidArgument(fail-fast,不静默退化为 self IP)", async () => {
    const { docker } = makeDocker();
    const pool = new FakePool();
    const { svc } = makeRemoteContainerService();
    let caught: Error | undefined;
    try {
      await provisionV3Container(
        {
          docker,
          pool: pool as unknown as Pool,
          image: TEST_IMAGE,
          containerService: svc as unknown as Parameters<typeof provisionV3Container>[0]["containerService"],
          selfHostId: SELF_HOST,
          randomIp: () => "172.30.9.10",
          randomSecret: fixedSecret("d".repeat(64)),
        },
        890,
        REMOTE_HOST,
        // boundIp / bridgeCidr 都不传
      );
    } catch (e) {
      caught = e as Error;
    }
    assert.ok(caught, "expected fail-fast for remote without bridgeCidr");
    assert.ok(caught instanceof SupervisorError);
    assert.equal((caught as SupervisorError).code, "InvalidArgument");
    // saga:bridgeCidr 校验在无事务中段(hostGatewayIp 组装),Tx1 已提交(BEGIN→COMMIT)
    // → 补偿翻 vanished,绝不留 active row。
    assert.deepEqual(pool.clientLog, ["BEGIN", "COMMIT"]);
    assert.equal(pool.rows[0]!.state, "vanished");
  });

  test("remote host + bridgeCidr 形状不符 → InvalidArgument(docker create 前拦截)", async () => {
    const { docker } = makeDocker();
    const pool = new FakePool();
    const { svc, captured } = makeRemoteContainerService();
    let caught: Error | undefined;
    try {
      await provisionV3Container(
        {
          docker,
          pool: pool as unknown as Pool,
          image: TEST_IMAGE,
          containerService: svc as unknown as Parameters<typeof provisionV3Container>[0]["containerService"],
          selfHostId: SELF_HOST,
          randomIp: () => "172.30.5.10",
          randomSecret: fixedSecret("e".repeat(64)),
        },
        891,
        REMOTE_HOST,
        undefined,
        "172.30.0.16/28", // 不是 v3 拓扑接受的形态
      );
    } catch (e) {
      caught = e as Error;
    }
    assert.ok(caught, "expected fail-fast for invalid bridgeCidr shape");
    assert.ok(caught instanceof SupervisorError);
    assert.equal((caught as SupervisorError).code, "InvalidArgument");
    // 不能进到 createAndStart
    assert.equal(captured.spec, undefined);
    // saga:形状校验在无事务中段,Tx1 已提交 → 补偿翻 vanished。
    assert.deepEqual(pool.clientLog, ["BEGIN", "COMMIT"]);
    assert.equal(pool.rows[0]!.state, "vanished");
  });
});

// ───────────────────────────────────────────────────────────────────────
//  v1.0.84 PR #4 — image label guard(supply-chain check before docker create)
//
//  覆盖目的:guard 进 BEGIN 前必须 inspectImage,labels 缺
//  oc.runtime.features=v3-sink 直接拒 provision。模式 enforce/warn/off。
//  错误归一化契约:inspectImage 自身抛 → wrapDockerError;ImageOutdated
//  SupervisorError pass-through 到 v3ensureRunning。
// ───────────────────────────────────────────────────────────────────────

describe("provisionV3Container — image label guard (v1.0.84 PR #4)", () => {
  let pool: FakePool;
  let prevOptional: string | undefined;
  let prevGuard: string | undefined;

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
    prevGuard = process.env.OC_V3_IMAGE_GUARD;
  });

  function restoreGuardEnv() {
    if (prevGuard === undefined) delete process.env.OC_V3_IMAGE_GUARD;
    else process.env.OC_V3_IMAGE_GUARD = prevGuard;
  }

  /** 简化的 facade stub:只关心 inspectImage 行为,其它方法没用上。 */
  function makeFacadeWithInspectImage(
    impl: () => Promise<{ id: string; repoTags: string[]; labels: Record<string, string> } | null>,
    counters: { inspectImageCalls: number },
  ) {
    return {
      ensureVolume: async () => undefined,
      removeVolume: async () => undefined,
      inspectVolume: async () => ({ exists: true }),
      createAndStart: async () => ({ containerInternalId: "remote-cid-x" }),
      stop: async () => undefined,
      remove: async () => undefined,
      inspect: async () => {
        throw new Error("inspect should not be called by guard");
      },
      inspectImage: async () => {
        counters.inspectImageCalls++;
        return impl();
      },
      isRemote: async () => true,
      resolveBaselinePaths: async () => ({
        agentsMdHostPath: "/var/lib/openclaude/baseline/AGENTS.md",
        claudeMdHostPath: "/var/lib/openclaude/baseline/CLAUDE.md",
        skillsDirHostPath: "/var/lib/openclaude/baseline/skills",
      }),
    };
  }

  // ─── monolith fallback 路径(deps.containerService 未注入时走 docker.getImage)──

  test("monolith fallback + features 含 v3-sink → provision 正常,docker.getImage 被调 1 次", async () => {
    try {
      const { docker, captured } = makeDocker({
        imageInspect: { kind: "labels", labels: { "oc.runtime.features": "file-proxy-v1 v3-sink" } },
      });
      delete process.env.OC_V3_IMAGE_GUARD; // 默认 enforce
      await provisionV3Container(
        {
          docker,
          pool: pool as unknown as Pool,
          image: TEST_IMAGE, selfHostId: TEST_HOST,
          randomIp: () => "172.30.7.1",
          randomSecret: fixedSecret("a".repeat(64)),
        },
        9001,
      );
      assert.equal(captured.imageInspected, 1, "guard 必须 inspect image 一次");
      assert.equal(captured.containersCreated.length, 1, "image 合规 → docker create 走通");
    } finally {
      restoreGuardEnv();
    }
  });

  test("enforce + features 缺 v3-sink → SupervisorError code=ImageOutdated;无 BEGIN/INSERT/createContainer 副作用", async () => {
    try {
      const { docker, captured } = makeDocker({
        imageInspect: { kind: "labels", labels: { "oc.runtime.features": "file-proxy-v1" } },
      });
      delete process.env.OC_V3_IMAGE_GUARD;
      let caught: Error | undefined;
      try {
        await provisionV3Container(
          {
            docker,
            pool: pool as unknown as Pool,
            image: TEST_IMAGE, selfHostId: TEST_HOST,
            randomIp: () => "172.30.7.2",
            randomSecret: fixedSecret("b".repeat(64)),
          },
          9002,
        );
      } catch (e) {
        caught = e as Error;
      }
      assert.ok(caught, "expected ImageOutdated throw");
      assert.ok(caught instanceof SupervisorError);
      assert.equal((caught as SupervisorError).code, "ImageOutdated");
      // detail 必须含 image / 实际 features 值,方便运维定位
      assert.match(caught!.message, /image=openclaude\/openclaude-runtime:test/);
      assert.match(caught!.message, /v3-sink/);
      // 副作用:guard 抛在 BEGIN 之前,pool.connect 都没被调
      assert.equal(pool.clientLog.length, 0, "guard 必须早于 BEGIN,pool 不应有事务记录");
      assert.equal(captured.volumesCreated.length, 0, "无 volume 创建");
      assert.equal(captured.containersCreated.length, 0, "无 container 创建");
    } finally {
      restoreGuardEnv();
    }
  });

  test("enforce + 完全无 oc.runtime.features key → ImageOutdated", async () => {
    try {
      const { docker } = makeDocker({
        imageInspect: { kind: "labels", labels: {} },
      });
      delete process.env.OC_V3_IMAGE_GUARD;
      let caught: Error | undefined;
      try {
        await provisionV3Container(
          { docker, pool: pool as unknown as Pool, image: TEST_IMAGE, selfHostId: TEST_HOST, randomIp: () => "172.30.7.3", randomSecret: fixedSecret("c".repeat(64)) },
          9003,
        );
      } catch (e) {
        caught = e as Error;
      }
      assert.ok(caught instanceof SupervisorError);
      assert.equal((caught as SupervisorError).code, "ImageOutdated");
    } finally {
      restoreGuardEnv();
    }
  });

  test("enforce + features 是 v3-sink-extra(子串非 token)→ ImageOutdated", async () => {
    try {
      const { docker } = makeDocker({
        imageInspect: { kind: "labels", labels: { "oc.runtime.features": "v3-sink-extra" } },
      });
      delete process.env.OC_V3_IMAGE_GUARD;
      let caught: Error | undefined;
      try {
        await provisionV3Container(
          { docker, pool: pool as unknown as Pool, image: TEST_IMAGE, selfHostId: TEST_HOST, randomIp: () => "172.30.7.4", randomSecret: fixedSecret("d".repeat(64)) },
          9004,
        );
      } catch (e) {
        caught = e as Error;
      }
      assert.ok(caught instanceof SupervisorError);
      assert.equal((caught as SupervisorError).code, "ImageOutdated", "v3-sink-extra 是子串,token 整体匹配应拒绝");
    } finally {
      restoreGuardEnv();
    }
  });

  test("enforce + getImage().inspect() 抛 statusCode=404(image absent)→ guard 放行;后续撞 ImageNotFound 走原路径", async () => {
    try {
      const { docker } = makeDocker({
        imageMissing: true, // createContainer 那条线也会抛 404
        imageInspect: { kind: "missing" }, // guard 这条线也得到 404
      });
      delete process.env.OC_V3_IMAGE_GUARD;
      let caught: Error | undefined;
      try {
        await provisionV3Container(
          { docker, pool: pool as unknown as Pool, image: TEST_IMAGE, selfHostId: TEST_HOST, randomIp: () => "172.30.7.5", randomSecret: fixedSecret("e".repeat(64)) },
          9005,
        );
      } catch (e) {
        caught = e as Error;
      }
      assert.ok(caught instanceof SupervisorError);
      assert.equal(
        (caught as SupervisorError).code,
        "ImageNotFound",
        "guard 不抢 ImageNotFound 路径",
      );
    } finally {
      restoreGuardEnv();
    }
  });

  test("enforce + getImage().inspect() 抛 generic Error → 透 wrapDockerError,非 ImageOutdated", async () => {
    try {
      const { docker, captured } = makeDocker({
        imageInspect: { kind: "throw", err: new Error("daemon down") },
      });
      delete process.env.OC_V3_IMAGE_GUARD;
      let caught: Error | undefined;
      try {
        await provisionV3Container(
          { docker, pool: pool as unknown as Pool, image: TEST_IMAGE, selfHostId: TEST_HOST, randomIp: () => "172.30.7.6", randomSecret: fixedSecret("f".repeat(64)) },
          9006,
        );
      } catch (e) {
        caught = e as Error;
      }
      // round-2 Codex 建议:不硬绑具体 code,锁住 SupervisorError + 非 ImageOutdated。
      assert.ok(caught instanceof SupervisorError, "generic Error 必须被 wrapDockerError 归一化");
      assert.notEqual(
        (caught as SupervisorError).code,
        "ImageOutdated",
        "daemon down 不应被误标成 ImageOutdated",
      );
      assert.equal(captured.containersCreated.length, 0);
    } finally {
      restoreGuardEnv();
    }
  });

  test("warn 模式 + features 缺 v3-sink → console.warn 一次,provision 仍成功", async () => {
    try {
      const { docker, captured } = makeDocker({
        imageInspect: { kind: "labels", labels: { "oc.runtime.features": "file-proxy-v1" } },
      });
      process.env.OC_V3_IMAGE_GUARD = "warn";

      const warns: string[] = [];
      const origWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warns.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      };
      try {
        await provisionV3Container(
          { docker, pool: pool as unknown as Pool, image: TEST_IMAGE, selfHostId: TEST_HOST, randomIp: () => "172.30.7.7", randomSecret: fixedSecret("0".repeat(64)) },
          9007,
        );
      } finally {
        console.warn = origWarn;
      }
      // 别的路径(codex account binding 等)也会触发 console.warn,只筛 guard 相关一条。
      const guardWarns = warns.filter((w) => /image guard FAIL but mode=warn/.test(w));
      assert.equal(guardWarns.length, 1, "warn 模式应触发一次 image-guard 专属 console.warn");
      assert.match(guardWarns[0]!, /image=openclaude\/openclaude-runtime:test/);
      assert.match(guardWarns[0]!, /file-proxy-v1/);
      assert.equal(captured.containersCreated.length, 1, "warn 模式必须放行 provision");
    } finally {
      restoreGuardEnv();
    }
  });

  test("off 模式 → guard 完全 short-circuit,docker.getImage 不被调", async () => {
    try {
      const { docker, captured } = makeDocker({
        // 故意给一个 guard 会拒的 labels — off 模式下根本不应被读
        imageInspect: { kind: "labels", labels: { "oc.runtime.features": "file-proxy-v1" } },
      });
      process.env.OC_V3_IMAGE_GUARD = "off";
      await provisionV3Container(
        { docker, pool: pool as unknown as Pool, image: TEST_IMAGE, selfHostId: TEST_HOST, randomIp: () => "172.30.7.8", randomSecret: fixedSecret("1".repeat(64)) },
        9008,
      );
      assert.equal(captured.imageInspected, 0, "off 模式不应触发 docker.getImage");
      assert.equal(captured.containersCreated.length, 1, "provision 应通过");
    } finally {
      restoreGuardEnv();
    }
  });

  test("默认值(env 未设)= enforce → 缺 v3-sink 仍抛 ImageOutdated", async () => {
    try {
      const { docker } = makeDocker({
        imageInspect: { kind: "labels", labels: { "oc.runtime.features": "file-proxy-v1" } },
      });
      delete process.env.OC_V3_IMAGE_GUARD;
      let caught: Error | undefined;
      try {
        await provisionV3Container(
          { docker, pool: pool as unknown as Pool, image: TEST_IMAGE, selfHostId: TEST_HOST, randomIp: () => "172.30.7.9", randomSecret: fixedSecret("2".repeat(64)) },
          9009,
        );
      } catch (e) {
        caught = e as Error;
      }
      assert.ok(caught instanceof SupervisorError);
      assert.equal((caught as SupervisorError).code, "ImageOutdated");
    } finally {
      restoreGuardEnv();
    }
  });

  test("非法值(env=garbage)走 enforce 默认 → 缺 v3-sink 抛 ImageOutdated", async () => {
    try {
      const { docker } = makeDocker({
        imageInspect: { kind: "labels", labels: { "oc.runtime.features": "file-proxy-v1" } },
      });
      process.env.OC_V3_IMAGE_GUARD = "yes-please-skip";
      let caught: Error | undefined;
      try {
        await provisionV3Container(
          { docker, pool: pool as unknown as Pool, image: TEST_IMAGE, selfHostId: TEST_HOST, randomIp: () => "172.30.7.10", randomSecret: fixedSecret("3".repeat(64)) },
          9010,
        );
      } catch (e) {
        caught = e as Error;
      }
      assert.ok(caught instanceof SupervisorError);
      assert.equal((caught as SupervisorError).code, "ImageOutdated", "非法 env 必须 fail-closed");
    } finally {
      restoreGuardEnv();
    }
  });

  // ─── facade 路径(useRemote=true,走 containerService.inspectImage)────

  const SELF_HOST = "00000000-0000-0000-0000-00000000aaaa";
  const REMOTE_HOST = "00000000-0000-0000-0000-00000000bbbb";

  test("facade 路径 + features 含 v3-sink → 走 containerService.inspectImage,docker.getImage 不被触", async () => {
    try {
      const { docker, captured } = makeDocker();
      const counters = { inspectImageCalls: 0 };
      const cs = makeFacadeWithInspectImage(
        async () => ({
          id: "sha256:remote-fake",
          repoTags: [TEST_IMAGE],
          labels: { "oc.runtime.features": "file-proxy-v1 v3-sink" },
        }),
        counters,
      );
      delete process.env.OC_V3_IMAGE_GUARD;
      await provisionV3Container(
        {
          docker,
          pool: pool as unknown as Pool,
          image: TEST_IMAGE,
          containerService: cs as unknown as Parameters<typeof provisionV3Container>[0]["containerService"],
          selfHostId: SELF_HOST,
          randomIp: () => "172.30.42.1",
          randomSecret: fixedSecret("4".repeat(64)),
        },
        9011,
        REMOTE_HOST,
        undefined,
        "172.30.42.0/24",
      );
      assert.equal(counters.inspectImageCalls, 1, "facade 路径应调 containerService.inspectImage 一次");
      assert.equal(captured.imageInspected, 0, "facade 路径绝不能 fallback 到本机 docker.getImage");
    } finally {
      restoreGuardEnv();
    }
  });

  test("facade 路径 + features 缺 v3-sink → ImageOutdated;detail 含 resolved hostId(非 'self')", async () => {
    try {
      const { docker, captured } = makeDocker();
      const counters = { inspectImageCalls: 0 };
      const cs = makeFacadeWithInspectImage(
        async () => ({
          id: "sha256:remote-fake",
          repoTags: [TEST_IMAGE],
          labels: { "oc.runtime.features": "file-proxy-v1" },
        }),
        counters,
      );
      delete process.env.OC_V3_IMAGE_GUARD;
      let caught: Error | undefined;
      try {
        await provisionV3Container(
          {
            docker,
            pool: pool as unknown as Pool,
            image: TEST_IMAGE,
            containerService: cs as unknown as Parameters<typeof provisionV3Container>[0]["containerService"],
            selfHostId: SELF_HOST,
            randomIp: () => "172.30.42.2",
            randomSecret: fixedSecret("5".repeat(64)),
          },
          9012,
          REMOTE_HOST,
          undefined,
          "172.30.42.0/24",
        );
      } catch (e) {
        caught = e as Error;
      }
      assert.ok(caught instanceof SupervisorError);
      assert.equal((caught as SupervisorError).code, "ImageOutdated");
      // round-2 Codex 建议:detail 用 resolved host id(传入的 hostId,非 selfHostId)
      assert.match(caught!.message, new RegExp(`host=${REMOTE_HOST}`));
      assert.equal(captured.containersCreated.length, 0);
    } finally {
      restoreGuardEnv();
    }
  });

  test("facade 路径 + inspectImage 返 null(image absent)→ guard 放行(不抢 ImageNotFound)", async () => {
    try {
      const { docker } = makeDocker();
      const counters = { inspectImageCalls: 0 };
      const cs = makeFacadeWithInspectImage(async () => null, counters);
      delete process.env.OC_V3_IMAGE_GUARD;
      await provisionV3Container(
        {
          docker,
          pool: pool as unknown as Pool,
          image: TEST_IMAGE,
          containerService: cs as unknown as Parameters<typeof provisionV3Container>[0]["containerService"],
          selfHostId: SELF_HOST,
          randomIp: () => "172.30.42.3",
          randomSecret: fixedSecret("6".repeat(64)),
        },
        9013,
        REMOTE_HOST,
        undefined,
        "172.30.42.0/24",
      );
      assert.equal(counters.inspectImageCalls, 1);
      assert.ok(pool.clientLog.includes("BEGIN"));
      assert.ok(pool.clientLog.includes("COMMIT"));
    } finally {
      restoreGuardEnv();
    }
  });

  test("facade 路径 + inspectImage 抛 generic Error → wrapDockerError,非 ImageOutdated", async () => {
    try {
      const { docker, captured } = makeDocker();
      const counters = { inspectImageCalls: 0 };
      const cs = makeFacadeWithInspectImage(async () => {
        throw new Error("agent connection refused");
      }, counters);
      delete process.env.OC_V3_IMAGE_GUARD;
      let caught: Error | undefined;
      try {
        await provisionV3Container(
          {
            docker,
            pool: pool as unknown as Pool,
            image: TEST_IMAGE,
            containerService: cs as unknown as Parameters<typeof provisionV3Container>[0]["containerService"],
            selfHostId: SELF_HOST,
            randomIp: () => "172.30.42.4",
            randomSecret: fixedSecret("7".repeat(64)),
          },
          9014,
          REMOTE_HOST,
          undefined,
          "172.30.42.0/24",
        );
      } catch (e) {
        caught = e as Error;
      }
      assert.ok(caught instanceof SupervisorError);
      assert.notEqual((caught as SupervisorError).code, "ImageOutdated");
      assert.equal(captured.containersCreated.length, 0);
    } finally {
      restoreGuardEnv();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────
// R2-M5:激活窗口错误码分离 —— classifyRuntimeArtifactFailure 两码路径的重试秒数 + 告警行为
// (v3ensureRunning 的 provision 失败分级单一权威;pure fn,免搭 ensureRunning harness)。
// ───────────────────────────────────────────────────────────────────────
describe("R2-M5 classifyRuntimeArtifactFailure(激活中间态 vs 部署级坏产物)", () => {
  test("RuntimeActivationInProgress → 5s 短重试 + 不告警(与 provisioning 同级)", () => {
    const c = classifyRuntimeArtifactFailure("RuntimeActivationInProgress");
    assert.ok(c, "激活中间态必须被本分级识别(非 null)");
    assert.equal(c!.retryAfterSec, 5, "激活窗口走 5s 短重试(秒级 saga 窗口,非长退避)");
    assert.equal(c!.critical, false, "激活窗口不发 critical 告警(避免秒级窗口刷噪声)");
    assert.equal(c!.reason, "activation_in_progress");
  });

  test("PlatformBundleInvalid / RuntimeReleaseInvalid / RuntimePlacementInvalid → 300s 长重试 + critical 告警", () => {
    for (const [code, reason] of [
      ["PlatformBundleInvalid", "platform_bundle_invalid"],
      ["RuntimeReleaseInvalid", "runtime_release_invalid"],
      ["RuntimePlacementInvalid", "runtime_placement_invalid"],
    ] as const) {
      const c = classifyRuntimeArtifactFailure(code);
      assert.ok(c, `${code} 必须被本分级识别`);
      assert.equal(c!.retryAfterSec, 300, `${code} 走 300s 长退避(部署级坏产物 / 多机 placement 硬门)`);
      assert.equal(c!.critical, true, `${code} 必须发 critical 告警(运维介入)`);
      assert.equal(c!.reason, reason);
    }
  });

  test("非本类错误码 → null(交回 catch-all / 其它专用块)", () => {
    for (const code of ["NameConflict", "HostFull", "MigratedToV5", "CcbBaselineMissing", "Unknown"] as const) {
      assert.equal(classifyRuntimeArtifactFailure(code), null, `${code} 不属 runtime artifact 分级`);
    }
  });
});
