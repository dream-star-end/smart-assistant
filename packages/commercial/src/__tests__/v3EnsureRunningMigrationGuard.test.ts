/**
 * Phase 2.B — R6.11 §13.3 ensureRunning open-migration reader guard 真实测。
 *
 * 锁两条 invariant:
 *   - INV-3:`ensureRunning(uid)` 进入后,早于任何 docker / scheduler 入口先查
 *     `findOpenByUser(uid)`;命中 open ledger 行 → throw `ContainerUnreadyError(2,
 *     "migration_in_progress")`;断言 docker 0 副作用(无 getContainer / createContainer /
 *     getVolume / getImage 等调用)。
 *   - INV-4(NOT EXISTS half):`getV3ContainerStatus(deps, uid)` SELECT 必须用
 *     `NOT EXISTS (SELECT 1 FROM agent_migrations m WHERE m.agent_container_id =
 *     agent_containers.id AND m.phase NOT IN ('committed','rolled_back'))` 过滤。
 *     行为测:有 open migration 的 active 行 → 返 null;committed / rolled_back / 无
 *     migration → 仍返 row。
 *
 * 与 `v3MigrationLedger.test.ts` 的边界:
 *   - 那边测 ledger 模块本身(createPlannedMigration / markPhase / find* 等);本文件测
 *     **完整 reader 路径**(ensureRunning SQL + 503 reason + 不进 docker)。
 *   - 两者独立写,避免任何一条 invariant 的红测被另一边染色。
 *
 * Phase 2 完工硬门:本文件不允许 ship 时仍含 `test.todo`(R6.11 dev plan 硬要求)。
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type Docker from "dockerode";
import { createPool, closePool, setPoolOverride, resetPool, getPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import {
  createPlannedMigration,
  markPhase,
  markCommitted,
  markRolledBack,
  type MigrationPhase,
} from "../agent-sandbox/v3migrationLedger.js";
import {
  makeV3EnsureRunning,
} from "../agent-sandbox/v3ensureRunning.js";
import {
  getV3ContainerStatus,
  V3_CONTAINER_PORT,
  type V3SupervisorDeps,
} from "../agent-sandbox/v3supervisor.js";
import { ContainerUnreadyError } from "../ws/userChatBridge.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://test:test@127.0.0.1:55432/openclaude_test";
const REQUIRE_TEST_DB =
  process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

function assertTestDatabase(url: string): void {
  let dbName: string;
  try {
    dbName = new URL(url).pathname.replace(/^\//, "");
  } catch {
    throw new Error(`invalid TEST_DATABASE_URL: ${url}`);
  }
  if (!dbName.endsWith("_test")) {
    throw new Error(`refusing to reset non-test database: ${dbName}`);
  }
}

async function cleanCommercialSchema(): Promise<void> {
  assertTestDatabase(TEST_DB_URL);
  await query("DROP SCHEMA IF EXISTS public CASCADE");
  await query("CREATE SCHEMA public");
  await query("GRANT ALL ON SCHEMA public TO public");
}

let pgAvailable = false;
let hostUuid = ""; // self host(agent_container 落在这台)
let hostUuidB = ""; // 迁移目标 host(给 createPlannedMigration 用)
let containerId = 0n;
const TEST_UID = 1n;

async function probePg(): Promise<boolean> {
  const p = createPool({
    connectionString: TEST_DB_URL,
    max: 2,
    connectionTimeoutMillis: 1500,
  });
  try {
    await p.query("SELECT 1");
    await p.end();
    return true;
  } catch {
    try { await p.end(); } catch { /* ignore */ }
    return false;
  }
}

before(async () => {
  pgAvailable = await probePg();
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error("Postgres test fixture required");
    return;
  }
  await resetPool();
  const pool = createPool({ connectionString: TEST_DB_URL, max: 5 });
  setPoolOverride(pool);
  await cleanCommercialSchema();
  await runMigrations();
});

after(async () => {
  if (pgAvailable) {
    try { await cleanCommercialSchema(); } catch { /* ignore */ }
    await closePool();
  }
});

/**
 * 每个 test:
 *   - 清 agent_migrations / agent_containers
 *   - 种 1 个 user(FK)
 *   - 取 self host 当 reader 所在 host;另插 host B 给 createPlannedMigration 用
 *   - 种 1 个 active agent_container 给 TEST_UID
 */
beforeEach(async () => {
  if (!pgAvailable) return;
  await query("TRUNCATE TABLE agent_migrations RESTART IDENTITY CASCADE");
  await query("DELETE FROM agent_containers");
  await query("DELETE FROM users WHERE id = 1");
  await query(
    `INSERT INTO users (id, email, password_hash) VALUES (1, 'reader-guard-test@example.com', '$argon2id$placeholder')
     ON CONFLICT (id) DO NOTHING`,
  );
  const selfRow = await query<{ id: string }>(
    "SELECT id FROM compute_hosts WHERE name = 'self' LIMIT 1",
  );
  hostUuid = selfRow.rows[0]!.id;
  const hostBRow = await query<{ id: string }>(
    `INSERT INTO compute_hosts (
       name, host, ssh_port, ssh_user, agent_port,
       ssh_password_nonce, ssh_password_ct,
       agent_psk_nonce, agent_psk_ct,
       max_containers, bridge_cidr, status
     ) VALUES (
       'test-host-b', '10.0.0.99', 22, 'root', 9443,
       E'\\\\x01'::bytea, E'\\\\x01'::bytea,
       E'\\\\x01'::bytea, E'\\\\x01'::bytea,
       50, '172.30.99.0/24', 'ready'
     )
     ON CONFLICT (name) DO UPDATE SET host = EXCLUDED.host
     RETURNING id`,
  );
  hostUuidB = hostBRow.rows[0]!.id;
  const cRow = await query<{ id: string }>(
    `INSERT INTO agent_containers (
       user_id, host_uuid, host_id, bound_ip, port,
       container_internal_id, secret_hash, state, last_ws_activity
     ) VALUES (
       1, $1, NULL, '172.30.0.10'::inet, 8000,
       'old-cid-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
       decode(repeat('aa', 32), 'hex'),
       'active', now()
     )
     RETURNING id`,
    [hostUuid],
  );
  containerId = BigInt(cRow.rows[0]!.id);
});

function skipIfNoPg(t: { skip: (r: string) => void }): boolean {
  if (!pgAvailable) { t.skip("pg not available"); return true; }
  return false;
}

/** open phase 子集 — markPhase 编译期排除终态,这里同步收窄 */
type OpenMigrationPhase = Exclude<MigrationPhase, "committed" | "rolled_back">;

/**
 * 在 ledger 里给 TEST_UID 的 container 种一个 open phase 行(planned 由 createPlannedMigration,
 * 之后用 markPhase 推到指定 phase)。
 */
async function seedOpenMigration(phase: OpenMigrationPhase): Promise<bigint> {
  const { migrationId } = await createPlannedMigration({
    agentContainerId: containerId,
    oldHostId: hostUuid,
    oldContainerInternalId: "old-cid-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    newHostId: hostUuidB,
  });
  if (phase === "planned") return migrationId;
  // 推进到目标 open phase。'created' 需 new_cid;其他 open phase 不需 patch。
  if (phase === "created") {
    await markPhase(migrationId, "created", {
      newContainerInternalId: "new-cid-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
  } else {
    // 先把 created/new_cid 写上(为了 paused 等 phase 行的内部一致性)
    await markPhase(migrationId, "created", {
      newContainerInternalId: "new-cid-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
    await markPhase(migrationId, phase);
  }
  return migrationId;
}

/**
 * 推到终态(committed / rolled_back)— 用专用 marker。
 */
async function seedClosedMigration(closed: "committed" | "rolled_back"): Promise<void> {
  const id = await seedOpenMigration("created");
  if (closed === "committed") {
    // committed 路径:经过 detached / attached_pre / attached_route / started
    await markPhase(id, "detached");
    await markPhase(id, "attached_pre");
    await markPhase(id, "attached_route");
    await markPhase(id, "started");
    await markCommitted(id);
  } else {
    await markRolledBack(id);
  }
}

/**
 * 一个会在被调用时 assert.fail 的 Docker —— 任何 docker side-effect 都会让测试爆。
 * 用法:INV-3 测试 — 容器路径不进 docker。
 */
function makeForbiddenDocker(): Docker {
  const refuse = (call: string) => () => {
    throw new Error(
      `docker.${call} called — INV-3 应该在 findOpenByUser 命中后就 throw,不该走到 docker`,
    );
  };
  return {
    getContainer: refuse("getContainer"),
    createContainer: refuse("createContainer"),
    getVolume: refuse("getVolume"),
    createVolume: refuse("createVolume"),
    getImage: refuse("getImage"),
  } as unknown as Docker;
}

function makeReaderDeps(): V3SupervisorDeps {
  return {
    docker: makeForbiddenDocker(),
    pool: getPool(),
    image: "openclaude/openclaude-runtime:test",
    selfHostId: hostUuid,
    randomIp: () => "172.30.99.99",
    randomSecret: () => "a".repeat(64),
  };
}

const OPEN_PHASES: ReadonlyArray<OpenMigrationPhase> = [
  "planned",
  "created",
  "detached",
  "attached_pre",
  "attached_route",
  "started",
];

describe("v3 supervisor.ensureRunning — open-migration guard (R6.11 §13.3)", () => {
  describe("INV-3 — ensureRunning 早 guard:open migration → 503 'migration_in_progress'", () => {
    for (const phase of ["planned", "created", "started"] as const) {
      test(`open migration phase='${phase}' → ContainerUnreadyError(2, 'migration_in_progress') + 不进 docker / readiness`, async (t) => {
        if (skipIfNoPg(t)) return;
        await seedOpenMigration(phase);
        const ensureRunning = makeV3EnsureRunning(makeReaderDeps(), {
          // probe 钩子保险:即使 INV-3 失灵走到 readiness,也不让真 HTTP/WS probe 触发
          probeHealthz: async () => {
            throw new Error("probeHealthz called — INV-3 应早就 throw");
          },
          probeWsUpgrade: async () => {
            throw new Error("probeWsUpgrade called — INV-3 应早就 throw");
          },
          sleep: async () => { /* noop */ },
          now: () => 1_000_000,
        });
        await assert.rejects(
          () => ensureRunning(TEST_UID),
          (err: unknown) => {
            assert.ok(err instanceof ContainerUnreadyError, "应抛 ContainerUnreadyError");
            const e = err as ContainerUnreadyError;
            assert.equal(e.reason, "migration_in_progress",
              `reason 应是 'migration_in_progress',实际 '${e.reason}'`);
            assert.equal(e.retryAfterSec, 2,
              `retryAfterSec 应是 2,实际 ${e.retryAfterSec}`);
            return true;
          },
        );
      });
    }

    test("无 open migration(空 ledger)→ ensureRunning 走到下一步(由 forbidden docker.getContainer 引爆,证明 INV-3 未拦)", async (t) => {
      if (skipIfNoPg(t)) return;
      // 不种任何 migration 行
      const ensureRunning = makeV3EnsureRunning(makeReaderDeps(), {
        probeHealthz: async () => true,
        probeWsUpgrade: async () => true,
        sleep: async () => { /* noop */ },
        now: () => 1_000_000,
      });
      // 期望:INV-3 不命中 → 继续走 getV3ContainerStatus → 容器有 container_internal_id 非空
      // → 走 docker.getContainer(id).inspect() → forbidden docker 抛 → ensureRunning catch 翻
      // ContainerUnreadyError reason='supervisor_error'。关键断言:reason !== 'migration_in_progress'。
      await assert.rejects(
        () => ensureRunning(TEST_UID),
        (err: unknown) => {
          assert.ok(err instanceof ContainerUnreadyError);
          const e = err as ContainerUnreadyError;
          assert.notEqual(e.reason, "migration_in_progress",
            "无 open migration 时,reason 绝不能是 'migration_in_progress'");
          return true;
        },
      );
    });
  });

  describe("INV-4 — getV3ContainerStatus NOT EXISTS half(SQL 行为锁)", () => {
    for (const phase of OPEN_PHASES) {
      test(`active row + open migration phase='${phase}' → getV3ContainerStatus 返 null`, async (t) => {
        if (skipIfNoPg(t)) return;
        await seedOpenMigration(phase);
        // 用一个 docker 不会被调的 deps —— INV-4 路径只读 DB,不进 docker(返 null 早于
        // docker inspect)。但若 SQL 没生效返了 row,会走到 docker.getContainer.inspect →
        // forbidden docker 抛,测试也会爆,正好兜两边。
        const deps = makeReaderDeps();
        const status = await getV3ContainerStatus(deps, Number(TEST_UID));
        assert.equal(status, null,
          `INV-4 失效:open phase='${phase}' 时 status 应返 null,实际返了 row`);
      });
    }

    test("active row + 无 migration → getV3ContainerStatus 返 row(baseline)", async (t) => {
      if (skipIfNoPg(t)) return;
      // 不种任何 migration 行 —— 给 docker 一个 inspect 钩子,避免 forbidden 引爆
      const docker = {
        getContainer: (_id: string) => ({
          inspect: async () => ({
            Id: _id,
            State: { Running: true, Status: "running" },
          }),
        }),
      } as unknown as Docker;
      const deps: V3SupervisorDeps = {
        ...makeReaderDeps(),
        docker,
      };
      const status = await getV3ContainerStatus(deps, Number(TEST_UID));
      assert.ok(status, "无 migration 时 status 必须非空");
      assert.equal(status!.userId, Number(TEST_UID));
      assert.equal(status!.containerId, Number(containerId));
      assert.equal(status!.state, "running");
    });

    test("active row + committed migration → getV3ContainerStatus 仍返 row(终态不阻塞 reuse)", async (t) => {
      if (skipIfNoPg(t)) return;
      await seedClosedMigration("committed");
      const docker = {
        getContainer: (_id: string) => ({
          inspect: async () => ({
            Id: _id,
            State: { Running: true, Status: "running" },
          }),
        }),
      } as unknown as Docker;
      const deps: V3SupervisorDeps = {
        ...makeReaderDeps(),
        docker,
      };
      const status = await getV3ContainerStatus(deps, Number(TEST_UID));
      assert.ok(status, "committed migration 不应阻塞 reader,status 必须非空");
    });

    test("active row + rolled_back migration → getV3ContainerStatus 仍返 row", async (t) => {
      if (skipIfNoPg(t)) return;
      await seedClosedMigration("rolled_back");
      const docker = {
        getContainer: (_id: string) => ({
          inspect: async () => ({
            Id: _id,
            State: { Running: true, Status: "running" },
          }),
        }),
      } as unknown as Docker;
      const deps: V3SupervisorDeps = {
        ...makeReaderDeps(),
        docker,
      };
      const status = await getV3ContainerStatus(deps, Number(TEST_UID));
      assert.ok(status, "rolled_back migration 不应阻塞 reader,status 必须非空");
    });

    test("不同 user 的 open migration 不阻塞本 user 的 SELECT(uid 维度隔离)", async (t) => {
      if (skipIfNoPg(t)) return;
      // 种 user=2 的 container + open migration;TEST_UID=1 不受影响
      await query(
        `INSERT INTO users (id, email, password_hash) VALUES (2, 'other-user@example.com', '$argon2id$placeholder')
         ON CONFLICT (id) DO NOTHING`,
      );
      const otherRow = await query<{ id: string }>(
        `INSERT INTO agent_containers (
           user_id, host_uuid, host_id, bound_ip, port,
           container_internal_id, secret_hash, state, last_ws_activity
         ) VALUES (
           2, $1, NULL, '172.30.0.20'::inet, 8000,
           'other-cid-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
           decode(repeat('bb', 32), 'hex'),
           'active', now()
         )
         RETURNING id`,
        [hostUuid],
      );
      const otherCid = BigInt(otherRow.rows[0]!.id);
      await createPlannedMigration({
        agentContainerId: otherCid,
        oldHostId: hostUuid,
        oldContainerInternalId: "other-cid-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        newHostId: hostUuidB,
      });
      // 本 user (TEST_UID=1) 无 migration,应正常返 row
      const docker = {
        getContainer: (_id: string) => ({
          inspect: async () => ({
            Id: _id,
            State: { Running: true, Status: "running" },
          }),
        }),
      } as unknown as Docker;
      const deps: V3SupervisorDeps = {
        ...makeReaderDeps(),
        docker,
      };
      const status = await getV3ContainerStatus(deps, Number(TEST_UID));
      assert.ok(status, "user=1 不受 user=2 的 open migration 影响,必须返 row");
      assert.equal(status!.userId, 1);
    });
  });
});
