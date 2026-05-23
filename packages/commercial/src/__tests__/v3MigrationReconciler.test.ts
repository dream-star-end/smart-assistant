/**
 * Phase 2.C — agent_migrations reconciler 真实 integ 测(R6.11 §14.2.6)。
 *
 * 锁三条 reader-单点 invariant 中**Phase 2.C 范围内**两条:
 *   - INV-2 open migration 期间 docker 破坏性写(stop/remove/start)单点归 reconciler —
 *     idle sweep / orphan reconcile 必须从 SELECT 层用 NOT EXISTS 把 mid-migration 行
 *     排除掉;SELECT-then-UPDATE 之间的 race 由 stopAndRemoveV3Container 的
 *     requireNoOpenMigration 守卫兜底,UPDATE rowCount=0 时静默 skip 不进 docker。
 *     Direction A 还需把 mid-migration 两侧 cid 拉回 dbActiveCids 保护集,防把
 *     migration 中的旧/新 host 容器当 docker 孤儿误删。
 *   - INV-10 planned phase 兜底 — phase='planned' + updated_at 超 staleSec →
 *     reconciler markRolledBack +(paused_at 非空时)unpause 旧容器;agent_containers
 *     行 state/host_id 不动;新 host 上可能残留 created-not-started 容器 → §3H docker
 *     orphan reconciler 兜底,本文件**不**测 docker 残留清理(02-DEVELOPMENT-PLAN.md:1935-1948)。
 *
 * INV-7(attached_route ACK re-fire)留 test.todo,延后到 Phase 2.D:依赖
 * `compute_hosts.host_state_version` schema 列 + `pollHostAgentApplyVersion` poller
 * 都未就绪,2.C 不强行落地避免引入未稳定 cross-cutting API。
 *
 * **不混淆**:老 `v3OrphanReconcile.test.ts:286` 测的是 v2 direction-B 行为
 * (`agent_containers.container_internal_id IS NULL → 不 inspect / 不 vanish`),那是
 * `agent_containers` 表的字段,与 R6.11 `agent_migrations.new_container_internal_id`
 * 完全不同字段。Phase 2.C 落地 INV-10 时**不**翻转 v3OrphanReconcile.test.ts:286 —
 * 那个测试行为不动,继续锁 v2 direction-B 语义。
 *
 * **Phase 2 完工硬门**:本文件不允许 ship 时仍含 `test.todo`(同 v3MigrationLedger.test.ts);
 * INV-7 占位的 test.todo 留在原位,Phase 2.D 一并清掉。
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
  type MigrationPhase,
} from "../agent-sandbox/v3migrationLedger.js";
import { runMigrationReconcileTick } from "../agent-sandbox/v3migrationReconciler.js";
import { runIdleSweepTick } from "../agent-sandbox/v3idleSweep.js";
import { runOrphanReconcileTick } from "../agent-sandbox/v3orphanReconcile.js";
import {
  stopAndRemoveV3Container,
  type V3SupervisorDeps,
} from "../agent-sandbox/v3supervisor.js";

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
const OLD_CID = "old-cid-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW_CID = "new-cid-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

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
 *   - 拿 self host 当 reader 所在 host(hostUuid),另插 host B 当 migration 目标 host
 *   - 种 1 个 active agent_container 给 TEST_UID, container_internal_id=OLD_CID
 */
beforeEach(async () => {
  if (!pgAvailable) return;
  await query("TRUNCATE TABLE agent_migrations RESTART IDENTITY CASCADE");
  await query("DELETE FROM agent_containers");
  await query("DELETE FROM users WHERE id = 1");
  await query(
    `INSERT INTO users (id, email, password_hash) VALUES (1, 'reconciler-test@example.com', '$argon2id$placeholder')
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
       $2,
       decode(repeat('aa', 32), 'hex'),
       'active', now() - interval '2 hours'
     )
     RETURNING id`,
    [hostUuid, OLD_CID],
  );
  containerId = BigInt(cRow.rows[0]!.id);
});

function skipIfNoPg(t: { skip: (r: string) => void }): boolean {
  if (!pgAvailable) { t.skip("pg not available"); return true; }
  return false;
}

/** open phase 子集 — markPhase 编译期排除终态 */
type OpenMigrationPhase = Exclude<MigrationPhase, "committed" | "rolled_back">;

/** 把刚 INSERT 的 migration 行的 updated_at 推回 N 秒前(让 listStale 视为 stale) */
async function ageMigration(migrationId: bigint, ageSec: number): Promise<void> {
  await query(
    `UPDATE agent_migrations SET updated_at = now() - ($1 * interval '1 second') WHERE id = $2`,
    [ageSec, migrationId.toString()],
  );
}

/** 在 ledger 里给 TEST_UID 的 container 种一个 open phase 行 */
async function seedOpenMigration(
  phase: OpenMigrationPhase,
  opts: {
    pausedAt?: Date;
    /** 改用别的 oldHost(测远端守门用) */
    oldHostId?: string;
    /**
     * 改用别的 newHost。**默认 hostUuidB(跨 host migration)**。Direction A
     * 同机保护测必须把它显式压到 hostUuid — 同机 migration(recreate-in-place)
     * 时新旧 cid 才会同时出现在 self 的 docker.listContainers 里。
     */
    newHostId?: string;
    newCid?: string;
  } = {},
): Promise<bigint> {
  const { migrationId } = await createPlannedMigration({
    agentContainerId: containerId,
    oldHostId: opts.oldHostId ?? hostUuid,
    oldContainerInternalId: OLD_CID,
    newHostId: opts.newHostId ?? hostUuidB,
  });
  if (phase === "planned") {
    if (opts.pausedAt !== undefined) {
      // planned 阶段 paused_at 通常不设(③ pause 与 ④bis markPhase('detached')
      // 同事务写),但 INV-10 注释也允许"planned + pausedAt"中间窗口:writer 在
      // ③ pause 同事务推 'detached' 前如果先写了 paused_at 又崩,paused_at 会
      // 残留于 planned 行;reconciler 兜底必须 unpause。直接 SQL 写,绕过 markPhase
      // (它推进到 'detached' 才让 patch.pausedAt 生效)。
      await query(
        `UPDATE agent_migrations SET paused_at = $1 WHERE id = $2`,
        [opts.pausedAt, migrationId.toString()],
      );
    }
    return migrationId;
  }
  // 推进到目标 open phase。'created' 起需 new_cid;后续 phase 不需 patch。
  const newCid = opts.newCid ?? NEW_CID;
  await markPhase(migrationId, "created", { newContainerInternalId: newCid });
  if (phase !== "created") {
    // detached 之后才支持 paused_at(③ pause),沿用 markPhase 的 patch 槽
    if (phase === "detached" && opts.pausedAt !== undefined) {
      await markPhase(migrationId, "detached", { pausedAt: opts.pausedAt });
    } else {
      await markPhase(migrationId, phase);
    }
  }
  return migrationId;
}

/**
 * Docker stub 工厂:
 *   - `forbidden`: 任何方法被调都 assert.fail(用于断言"完全不进 docker")
 *   - `unpause()` 可被 opts.unpauseHandler 拦截做 spy + 可控失败
 *   - `listContainers()` 返 opts.list(用于 Direction A 测)
 *   - `getContainer(id).stop/.remove` 默认 noop,可被 opts.stopThrows/removeThrows 拦
 *   - `getContainer(id).inspect()` 默认 404(模拟 docker→DB direction B 找不到)
 */
interface DockerCaptured {
  unpaused: string[];
  stopped: string[];
  removed: string[];
  startedContainers: string[];
  inspected: string[];
}

interface DockerStubOpts {
  /** unpause(cid) 被调用后的处理 — 默认 noop;返 throw → tryUnpause 进 unpauseFailures */
  unpauseHandler?: (cid: string) => Promise<void> | void;
  /** listContainers 返回值 */
  listContainers?: Array<{ Id: string; Created: number; Labels?: Record<string, string> }>;
  /** stop(cid) 抛 set */
  stopThrows?: Set<string>;
  /** remove(cid) 抛 set */
  removeThrows?: Set<string>;
  /** inspect(cid) 返回值;默认 404 */
  inspectHandler?: (cid: string) => Promise<unknown>;
}

function makeDocker(opts: DockerStubOpts = {}): { docker: Docker; captured: DockerCaptured } {
  const captured: DockerCaptured = {
    unpaused: [], stopped: [], removed: [], startedContainers: [], inspected: [],
  };
  const docker = {
    listContainers: async () => opts.listContainers ?? [],
    getContainer: (id: string) => ({
      unpause: async () => {
        captured.unpaused.push(id);
        if (opts.unpauseHandler) await opts.unpauseHandler(id);
      },
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
      start: async () => {
        captured.startedContainers.push(id);
      },
      inspect: async () => {
        captured.inspected.push(id);
        if (opts.inspectHandler) return opts.inspectHandler(id);
        const e = new Error(`no such container: ${id}`) as Error & { statusCode: number };
        e.statusCode = 404;
        throw e;
      },
    }),
  } as unknown as Docker;
  return { docker, captured };
}

/** 完全 refuse 的 docker — 任何调用都 throw,用于"绝不进 docker"断言 */
function makeForbiddenDocker(): Docker {
  const refuse = (call: string) => () => {
    throw new Error(
      `docker.${call} called — INV-2/INV-10 期望 sweeper/reconciler 在该路径完全不进 docker`,
    );
  };
  return {
    listContainers: refuse("listContainers"),
    getContainer: refuse("getContainer"),
    createContainer: refuse("createContainer"),
    getVolume: refuse("getVolume"),
    createVolume: refuse("createVolume"),
    getImage: refuse("getImage"),
  } as unknown as Docker;
}

function makeDeps(docker: Docker, overrides: Partial<V3SupervisorDeps> = {}): V3SupervisorDeps {
  return {
    docker,
    pool: getPool(),
    image: "openclaude/openclaude-runtime:test",
    selfHostId: hostUuid,
    randomIp: () => "172.30.99.99",
    randomSecret: () => "a".repeat(64),
    ...overrides,
  };
}

// ───────────────────────────────────────────────────────────────────────
// INV-10 — planned phase 兜底(5 tests)
// ───────────────────────────────────────────────────────────────────────

describe("v3 agent_migrations reconciler — INV-10 (planned phase bottom-line, R6.11 §14.2.6)", () => {
  test("planned + paused_at NULL + stale → markRolledBack + agent_containers 不动 + 0 docker 副作用", async (t) => {
    if (skipIfNoPg(t)) return;
    const migrationId = await seedOpenMigration("planned");
    await ageMigration(migrationId, 700); // > 600s 默认 staleSec

    const { captured } = makeDocker();
    const docker = makeForbiddenDocker(); // paused_at=null → 不该 unpause
    const r = await runMigrationReconcileTick(makeDeps(docker), { staleSec: 600 });

    assert.equal(r.scanned, 1);
    assert.equal(r.recoveredPlanned, 1, "planned 行应被 markRolledBack");
    assert.equal(r.unpauseFailures, 0, "paused_at=null 不该 unpause");
    assert.equal(r.skippedRemote, 0);
    assert.deepEqual(r.skippedPhases, {});
    assert.equal(r.errors.length, 0);
    assert.equal(captured.unpaused.length, 0);

    // ledger 行翻 rolled_back
    const ledger = await query<{ phase: string; committed_at: Date | null }>(
      `SELECT phase, committed_at FROM agent_migrations WHERE id = $1`,
      [migrationId.toString()],
    );
    assert.equal(ledger.rows[0]!.phase, "rolled_back");
    assert.equal(ledger.rows[0]!.committed_at, null, "rolled_back 终态 committed_at 保 NULL");

    // agent_containers 行 state/host_uuid 全程不动(planned 阶段 ⑥c PG flip 还没发生)
    const c = await query<{ state: string; host_uuid: string }>(
      `SELECT state, host_uuid FROM agent_containers WHERE id = $1`,
      [containerId.toString()],
    );
    assert.equal(c.rows[0]!.state, "active", "planned 阶段 state 不应被 reconciler 改");
    assert.equal(c.rows[0]!.host_uuid, hostUuid, "planned 阶段 host_uuid 不应被 reconciler 改");
  });

  test("planned + paused_at 非空 + stale → tryUnpause(OLD_CID) 一次 + markRolledBack", async (t) => {
    if (skipIfNoPg(t)) return;
    const migrationId = await seedOpenMigration("planned", {
      pausedAt: new Date(Date.now() - 60_000),
    });
    await ageMigration(migrationId, 700);

    const { docker, captured } = makeDocker();
    const r = await runMigrationReconcileTick(makeDeps(docker), { staleSec: 600 });

    assert.equal(r.scanned, 1);
    assert.equal(r.recoveredPlanned, 1);
    assert.equal(r.unpauseFailures, 0);
    assert.deepEqual(captured.unpaused, [OLD_CID], "应仅对 OLD_CID 调一次 unpause");
    // 没碰 start / stop / remove
    assert.equal(captured.startedContainers.length, 0);
    assert.equal(captured.stopped.length, 0);
    assert.equal(captured.removed.length, 0);

    const ledger = await query<{ phase: string }>(
      `SELECT phase FROM agent_migrations WHERE id = $1`,
      [migrationId.toString()],
    );
    assert.equal(ledger.rows[0]!.phase, "rolled_back");
  });

  test("planned + paused_at 非空 + unpause 抛 → unpauseFailures++ 但 markRolledBack 仍成功", async (t) => {
    if (skipIfNoPg(t)) return;
    const migrationId = await seedOpenMigration("planned", {
      pausedAt: new Date(Date.now() - 60_000),
    });
    await ageMigration(migrationId, 700);

    const { docker, captured } = makeDocker({
      unpauseHandler: () => {
        const e = new Error("docker daemon 抖动") as Error & { statusCode: number };
        e.statusCode = 500;
        throw e;
      },
    });
    const r = await runMigrationReconcileTick(makeDeps(docker), { staleSec: 600 });

    assert.equal(r.scanned, 1);
    assert.equal(r.recoveredPlanned, 1,
      "unpause 抛不应阻塞 markRolledBack — 02-DEVELOPMENT-PLAN.md:1942 ledger 终态优先");
    assert.equal(r.unpauseFailures, 1, "unpause 抛应累加 unpauseFailures");
    assert.equal(r.errors.length, 0, "best-effort unpause 失败不进 errors[]");
    assert.deepEqual(captured.unpaused, [OLD_CID]);

    const ledger = await query<{ phase: string }>(
      `SELECT phase FROM agent_migrations WHERE id = $1`,
      [migrationId.toString()],
    );
    assert.equal(ledger.rows[0]!.phase, "rolled_back",
      "unpause 失败也必须 markRolledBack 完成 — ledger 终态语义优先于 docker side effect");
  });

  test("planned + 未 stale(updated_at 在 staleSec 内)→ 0 scanned 0 recovered", async (t) => {
    if (skipIfNoPg(t)) return;
    const migrationId = await seedOpenMigration("planned");
    // 不 age — 行刚刚 INSERT,updated_at = now()

    const { docker, captured } = makeDocker();
    const r = await runMigrationReconcileTick(makeDeps(docker), { staleSec: 600 });

    assert.equal(r.scanned, 0, "未 stale 行不应进 listStale 视野");
    assert.equal(r.recoveredPlanned, 0);
    assert.equal(captured.unpaused.length, 0);

    // 行仍 open(planned)
    const ledger = await query<{ phase: string }>(
      `SELECT phase FROM agent_migrations WHERE id = $1`,
      [migrationId.toString()],
    );
    assert.equal(ledger.rows[0]!.phase, "planned", "未 stale 行 phase 不应被改");
  });

  test("planned + oldHost ≠ selfHostId(远端)→ skippedRemote++ + 0 docker 副作用", async (t) => {
    if (skipIfNoPg(t)) return;
    // 用 host B 当 oldHost(远端);self 是 hostUuid(host A)
    const migrationId = await seedOpenMigration("planned", { oldHostId: hostUuidB });
    await ageMigration(migrationId, 700);

    const docker = makeForbiddenDocker();
    const r = await runMigrationReconcileTick(makeDeps(docker), { staleSec: 600 });

    assert.equal(r.scanned, 1);
    assert.equal(r.skippedRemote, 1,
      "oldHostId !== selfHostId 应 skippedRemote++(MVP 不处理跨 host docker)");
    assert.equal(r.recoveredPlanned, 0);
    assert.equal(r.unpauseFailures, 0);

    // 行仍 open(reconciler 没动)— Phase 2.D 引入 remote unpause API 后再处理
    const ledger = await query<{ phase: string }>(
      `SELECT phase FROM agent_migrations WHERE id = $1`,
      [migrationId.toString()],
    );
    assert.equal(ledger.rows[0]!.phase, "planned");
  });
});

// ───────────────────────────────────────────────────────────────────────
// 非 planned phase 静默 skip(Phase 2.D 待实现 — 锁"非破坏性"语义)
// ───────────────────────────────────────────────────────────────────────

describe("v3 reconciler — 非 planned phase 静默 skip(Phase 2.C MVP, Phase 2.D 待落)", () => {
  test("created + stale → skippedPhases.created=1 + 0 docker 副作用 + ledger 不动", async (t) => {
    if (skipIfNoPg(t)) return;
    const migrationId = await seedOpenMigration("created");
    await ageMigration(migrationId, 700);

    const docker = makeForbiddenDocker();
    const r = await runMigrationReconcileTick(makeDeps(docker), { staleSec: 600 });

    assert.equal(r.scanned, 1);
    assert.equal(r.recoveredPlanned, 0, "non-planned phase 不进 recoverPlannedRow");
    assert.equal(r.skippedPhases.created, 1);
    assert.equal(r.skippedRemote, 0);

    // ledger 行原地不动(reconciler 在 Phase 2.D 实现前不动 non-planned)
    const ledger = await query<{ phase: string }>(
      `SELECT phase FROM agent_migrations WHERE id = $1`,
      [migrationId.toString()],
    );
    assert.equal(ledger.rows[0]!.phase, "created");
  });
});

// ───────────────────────────────────────────────────────────────────────
// INV-2 — sweeper exclusion(5 tests)
// ───────────────────────────────────────────────────────────────────────

describe("v3 sweepers — INV-2 open migration exclusion(NOT EXISTS + UPDATE guard + Direction A 保护)", () => {
  test("idleSweep: 存在 open(planned) ledger → SELECT 层过滤,scanned=0 swept=0", async (t) => {
    if (skipIfNoPg(t)) return;
    // 行已 stale(beforeEach 设 last_ws_activity = now()-2h),无 ledger 时本来会被 sweep
    await seedOpenMigration("planned");

    const docker = makeForbiddenDocker(); // 任何 docker 调用 → 测试失败
    const r = await runIdleSweepTick(makeDeps(docker), { idleCutoffMin: 30 });

    assert.equal(r.scanned, 0, "NOT EXISTS predicate 必须把 mid-migration 行从 SELECT 排出");
    assert.equal(r.swept, 0);
    assert.equal(r.racedWithMigration, 0);
    assert.equal(r.errors.length, 0);

    // 行仍 active
    const c = await query<{ state: string }>(
      `SELECT state FROM agent_containers WHERE id = $1`,
      [containerId.toString()],
    );
    assert.equal(c.rows[0]!.state, "active");
  });

  test("orphanReconcile Direction B: 存在 open(planned) ledger → listActiveRows 排除, dbOrphansVanished=0", async (t) => {
    if (skipIfNoPg(t)) return;
    await seedOpenMigration("planned");

    // 注意:listContainers 返空数组(不触发 Direction A),但 inspect 默认 404 —
    // 若 listActiveRows NOT EXISTS 失效,Direction B 会拿到 OLD_CID,inspect 404 →
    // 走 stopAndRemoveV3Container 把行翻 vanished(误删)。
    const { docker, captured } = makeDocker({ listContainers: [] });
    const r = await runOrphanReconcileTick(makeDeps(docker), { batchLimit: 200 });

    assert.equal(r.scanned.dbActiveRows, 0,
      "NOT EXISTS 应把 mid-migration 行从 listActiveRows 排除,dbActiveRows=0");
    assert.equal(r.dbOrphansVanished, 0, "Direction B 不应 vanish mid-migration 行");
    // Direction B 没 inspect 该行,docker.getContainer.inspect 计数 = 0
    assert.equal(captured.inspected.length, 0);
    assert.equal(captured.stopped.length, 0);
    assert.equal(captured.removed.length, 0);

    // 行仍 active
    const c = await query<{ state: string }>(
      `SELECT state FROM agent_containers WHERE id = $1`,
      [containerId.toString()],
    );
    assert.equal(c.rows[0]!.state, "active");
  });

  test("ledger committed 后,sweepers 立刻看到该行,可正常推进", async (t) => {
    if (skipIfNoPg(t)) return;
    const migrationId = await seedOpenMigration("created");
    await markCommitted(migrationId);

    // idleSweep 现在应能扫到行(beforeEach 设了 stale last_ws_activity)
    const { docker, captured } = makeDocker();
    const r = await runIdleSweepTick(makeDeps(docker), { idleCutoffMin: 30 });

    assert.equal(r.scanned, 1, "committed 后 NOT EXISTS predicate 不再过滤该行");
    assert.equal(r.swept, 1);
    assert.equal(r.racedWithMigration, 0);
    // sweep 调用了 stopAndRemove,UPDATE 守卫不被 open ledger 触发(已 committed)→
    // 走到 docker stop+remove
    assert.deepEqual(captured.stopped, [OLD_CID]);
    assert.deepEqual(captured.removed, [OLD_CID]);
  });

  test("orphanReconcile Direction A: phase='created' 的 OLD_CID + NEW_CID 都进 docker.listContainers → dockerOrphansRemoved=0(mid-migration 保护)", async (t) => {
    if (skipIfNoPg(t)) return;
    // phase='created' → new_cid 已写,listMidMigrationCids 应同时纳入 OLD_CID + NEW_CID。
    // Direction A 同机保护:listContainers 拉的是 *self host* docker daemon 上的容器,
    // 必须把 migration 设成 same-host(new_host_id = old_host_id = hostUuid),否则
    // listMidMigrationCids 的 host 维度过滤(`new_host_id = $1`)会把 NEW_CID 排除掉,
    // 此时 Direction A 会把 NEW_CID 当 docker 孤儿误删 — 这是物理上 impossible
    // 的场景(NEW_CID 在跨 host migration 下根本不会出现在 self 的 docker.listContainers)。
    await seedOpenMigration("created", { newHostId: hostUuid });

    // docker.listContainers 返这两个 cid;Created 早于 SAFETY_RACE_WINDOW_SEC(300s)前
    const oldCreated = Math.floor(Date.now() / 1000) - 3600;
    const { docker, captured } = makeDocker({
      listContainers: [
        { Id: OLD_CID, Created: oldCreated, Labels: { "com.openclaude.v3.managed": "1" } },
        { Id: NEW_CID, Created: oldCreated, Labels: { "com.openclaude.v3.managed": "1" } },
      ],
    });
    const r = await runOrphanReconcileTick(makeDeps(docker), { batchLimit: 200 });

    assert.equal(r.scanned.dockerContainers, 2);
    assert.equal(r.dockerOrphansRemoved, 0,
      "Direction A 必须保护 mid-migration 两侧 cid 不被当孤儿误删");
    assert.equal(captured.stopped.length, 0, "保护起作用,docker.stop 不应被调");
    assert.equal(captured.removed.length, 0, "保护起作用,docker.remove 不应被调");
  });

  test("orphanReconcile Direction A 跨 host 目标侧:selfHostId=hostUuidB + listContainers=[NEW_CID] → NEW_CID 被 new_host_id 分支保护", async (t) => {
    if (skipIfNoPg(t)) return;
    // 模拟 R6.11 跨 host migration 的目标侧 reconciler:
    //   - 写入侧 createPlannedMigration({oldHost=hostUuid, newHost=hostUuidB}) +
    //     markPhase('created', {newCid: NEW_CID})
    //   - 目标 host(hostUuidB)的 v3supervisor 启动 orphan reconciler,selfHostId=hostUuidB
    //   - 目标 host docker daemon 上有 NEW_CID(已 create 但还没 attached_route)
    //   - listActiveRows 因 NOT EXISTS 过滤掉这条 agent_containers 行 → dbActiveCids 空
    //   - 不补 listMidMigrationCids 时 NEW_CID 会被当 docker 孤儿误删(灾难场景)
    //   - 补了 listMidMigrationCids 后,new_host_id=hostUuidB 分支命中 → NEW_CID 入保护集
    await seedOpenMigration("created"); // 默认 newHostId=hostUuidB

    const oldCreated = Math.floor(Date.now() / 1000) - 3600;
    const { docker, captured } = makeDocker({
      listContainers: [
        { Id: NEW_CID, Created: oldCreated, Labels: { "com.openclaude.v3.managed": "1" } },
      ],
    });
    // selfHostId 覆盖成 hostUuidB(模拟目标 host 上的 reconciler)
    const r = await runOrphanReconcileTick(
      makeDeps(docker, { selfHostId: hostUuidB }),
      { batchLimit: 200 },
    );

    assert.equal(r.scanned.dockerContainers, 1);
    assert.equal(r.dockerOrphansRemoved, 0,
      "目标 host 上的 NEW_CID 必须由 listMidMigrationCids 的 new_host_id 分支保护");
    assert.equal(captured.stopped.length, 0, "保护起作用,docker.stop 不应被调");
    assert.equal(captured.removed.length, 0, "保护起作用,docker.remove 不应被调");
  });

  test("stopAndRemoveV3Container({ requireNoOpenMigration: true }):SELECT 之后 INSERT ledger → UPDATE 守卫返 false + 0 docker 副作用 + 行仍 active", async (t) => {
    if (skipIfNoPg(t)) return;
    // 模拟 SELECT-then-UPDATE race:agent_containers 行已 active 没 ledger;
    // 现在 INSERT 一条 planned ledger;再调 stopAndRemove(requireNoOpenMigration=true)。
    // UPDATE 层 NOT EXISTS 子查询应命中 0 行 → 返 false → 不进 docker。
    await seedOpenMigration("planned");

    const docker = makeForbiddenDocker(); // 任何 docker 调用都失败
    const ok = await stopAndRemoveV3Container(
      makeDeps(docker),
      { id: Number(containerId), container_internal_id: OLD_CID, host_uuid: hostUuid },
      5,
      { requireNoOpenMigration: true },
    );

    assert.equal(ok, false, "open migration 在 UPDATE WHERE NOT EXISTS 处必拦截,返 false");

    // agent_containers.state 仍 active
    const c = await query<{ state: string }>(
      `SELECT state FROM agent_containers WHERE id = $1`,
      [containerId.toString()],
    );
    assert.equal(c.rows[0]!.state, "active",
      "守卫拦截时不该把行翻 vanished — 让 reconciler 单点处理");
  });
});

// ───────────────────────────────────────────────────────────────────────
// INV-7 留 todo(Phase 2.D)
// ───────────────────────────────────────────────────────────────────────

describe("v3 reconciler — INV-7 占位(Phase 2.D)", () => {
  test.todo(
    "INV-7(deferred to Phase 2.D): reconciler attached_route 恢复必须先重发 routing ACK 才 docker start — " +
      "断言调用顺序 INCREMENT host_state_version → NOTIFY → pollHostAgentApplyVersion(通过)→ " +
      "docker start → markMigration('committed'). " +
      "依赖 `compute_hosts.host_state_version` schema 列 + `pollHostAgentApplyVersion` poller, " +
      "两者均未在 Phase 2.C 范围内落地,Phase 2.D 一并实装。",
  );
});
