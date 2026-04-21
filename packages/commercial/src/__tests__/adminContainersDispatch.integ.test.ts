/**
 * HIGH#6 — admin/containers v2/v3 行 dispatch 集成测试。
 *
 * 真 PG fixture(test:test@127.0.0.1:55432);docker 用 mock(只验"我们告诉
 * docker 的内容是对的",不真起容器)。
 *
 * 覆盖:
 *   1. v2 行(docker_name 非空)→ adminRestart 调 docker.restart;adminStop/Remove
 *      调 supervisor stop/remove(本测复用 dockerode mock 验直传)
 *   2. v3 行(docker_name=NULL,container_internal_id 非空)→ 三个动作都调
 *      stopAndRemoveV3Container,行 state 变 vanished
 *   3. v3 行 + 没传 v3Supervisor → V3SupervisorMissingError(http 层翻 503)
 *   4. 不存在 id → ContainerNotFoundError
 *   5. v3 行 + container_internal_id=NULL(provision 中途行)→ 不调 docker,
 *      仍 UPDATE state='vanished'(stopAndRemoveV3Container 兼容)
 *
 * 不覆盖:
 *   - HTTP 层错误翻译(由 http/admin.ts handler 直传 HttpError;V3SupervisorMissingError
 *     → 503,在 admin.ts 改动同时手测过)
 *   - admin_audit 写入(best-effort,失败不阻塞;另有 audit.ts 单测)
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type Docker from "dockerode";
import { createPool, closePool, setPoolOverride, resetPool, getPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import {
  adminRestartContainer,
  adminStopContainer,
  adminRemoveContainer,
  ContainerNotFoundError,
  V3SupervisorMissingError,
  listContainers,
} from "../admin/containers.js";
import type { V3SupervisorDeps } from "../agent-sandbox/v3supervisor.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

const COMMERCIAL_TABLES = [
  "rate_limit_events",
  "admin_audit",
  "agent_audit",
  "agent_containers",
  "agent_subscriptions",
  "user_preferences",
  "request_finalize_journal",
  "orders",
  "topup_plans",
  "usage_records",
  "credit_ledger",
  "model_pricing",
  "claude_accounts",
  "refresh_tokens",
  "email_verifications",
  "system_settings",
  "users",
  "schema_migrations",
];

let pgAvailable = false;

async function probe(): Promise<boolean> {
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
    try { await p.end(); } catch { /* */ }
    return false;
  }
}

async function cleanCommercialSchema(): Promise<void> {
  const sql = `DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`;
  await query(sql);
}

before(async () => {
  pgAvailable = await probe();
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) {
      throw new Error("Postgres test fixture required (CI=true or REQUIRE_TEST_DB=1)");
    }
    return;
  }
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 4 }));
  await cleanCommercialSchema();
  await runMigrations();
});

after(async () => {
  if (!pgAvailable) return;
  try { await cleanCommercialSchema(); } catch { /* */ }
  await closePool();
  resetPool();
});

beforeEach(async () => {
  if (!pgAvailable) return;
  await query(`TRUNCATE
    admin_audit,
    agent_containers,
    agent_subscriptions,
    credit_ledger,
    users
    RESTART IDENTITY CASCADE`);
});

// ───────────────────────────────────────────────────────────────────────
// fixtures
// ───────────────────────────────────────────────────────────────────────

async function insertUser(): Promise<number> {
  const r = await query<{ id: string }>(
    `INSERT INTO users (email, password_hash, status)
     VALUES ($1, $2, 'active')
     RETURNING id::text AS id`,
    [`u${Date.now()}-${Math.random().toString(36).slice(2)}@x.test`, "x".repeat(60)],
  );
  return Number(r.rows[0]!.id);
}

/** v2 行:docker_name + workspace_volume + home_volume + image 非空 */
async function insertV2Container(uid: number): Promise<bigint> {
  // 先建一条 active subscription(plan/status/start_at/end_at NOT NULL)
  const sub = await query<{ id: string }>(
    `INSERT INTO agent_subscriptions
       (user_id, plan, status, start_at, end_at, auto_renew)
     VALUES ($1::bigint, 'basic', 'active', NOW(), NOW() + INTERVAL '30 days', false)
     RETURNING id::text`,
    [String(uid)],
  );
  const r = await query<{ id: string }>(
    `INSERT INTO agent_containers
       (user_id, subscription_id, docker_name, workspace_volume, home_volume, image, status)
     VALUES ($1::bigint, $2::bigint, $3, $4, $5, $6, 'running')
     RETURNING id::text`,
    [
      String(uid),
      sub.rows[0]!.id,
      `oc-agent-u${uid}`,
      `oc-ws-u${uid}`,
      `oc-home-u${uid}`,
      "openclaude/agent-runtime:test",
    ],
  );
  return BigInt(r.rows[0]!.id);
}

/** v3 行:docker_name=NULL,container_internal_id 可选(provision 中途为 NULL) */
async function insertV3Container(
  uid: number,
  containerInternalId: string | null,
): Promise<bigint> {
  // V3 行不依赖 subscription_id(0012 起 nullable);保留 ephemeral 字段
  const ip = `172.30.${Math.floor(Math.random() * 256)}.${10 + Math.floor(Math.random() * 200)}`;
  const r = await query<{ id: string }>(
    `INSERT INTO agent_containers
       (user_id, bound_ip, port, secret_hash, state, container_internal_id, last_ws_activity, status)
     VALUES ($1::bigint, $2::inet, 18789, $3::bytea, 'active', $4, NOW(), 'running')
     RETURNING id::text`,
    [
      String(uid),
      ip,
      Buffer.alloc(32, 1), // dummy 32-byte hash
      containerInternalId,
    ],
  );
  return BigInt(r.rows[0]!.id);
}

// ───────────────────────────────────────────────────────────────────────
// docker mocks(各动作捕获参数)
// ───────────────────────────────────────────────────────────────────────

interface DockerCapture {
  restartCalled: boolean;
  restartName: string | null;
  stopCalled: boolean;
  stopName: string | null;
  removeCalled: boolean;
  removeName: string | null;
}

function makeDocker(capture: DockerCapture): Docker {
  return {
    getContainer: (name: string) => ({
      restart: async (_opts?: { t?: number }) => {
        capture.restartCalled = true;
        capture.restartName = name;
      },
      stop: async (_opts?: { t?: number }) => {
        capture.stopCalled = true;
        capture.stopName = name;
      },
      remove: async (_opts?: { force?: boolean }) => {
        capture.removeCalled = true;
        capture.removeName = name;
      },
    }),
  } as unknown as Docker;
}

function freshCapture(): DockerCapture {
  return {
    restartCalled: false, restartName: null,
    stopCalled: false, stopName: null,
    removeCalled: false, removeName: null,
  };
}

/** writeAdminAudit FK 到 users(id);测试中我们不关心审计成功,onAuditError 吞错保安静。 */
function makeAuditCtx(adminId: bigint | number = 1) {
  return {
    adminId,
    ip: "127.0.0.1",
    userAgent: "test",
    onAuditError: () => { /* silenced — best-effort audit, see admin/accounts.bestEffortAudit */ },
  };
}

// ───────────────────────────────────────────────────────────────────────
// 测试
// ───────────────────────────────────────────────────────────────────────

describe("admin/containers HIGH#6 v2/v3 dispatch", () => {
  test("v2 行:adminRestartContainer → docker.restart(docker_name)", async (t) => {
    if (!pgAvailable) return t.skip("PG fixture not available");
    const uid = await insertUser();
    const id = await insertV2Container(uid);
    const cap = freshCapture();
    const docker = makeDocker(cap);

    await adminRestartContainer(id, docker, makeAuditCtx(uid));
    assert.equal(cap.restartCalled, true, "v2 restart 必须调 docker.restart");
    assert.equal(cap.restartName, `oc-agent-u${uid}`, "用 db 里的 docker_name");
  });

  test("v3 行:adminRestartContainer → stopAndRemoveV3Container(state→vanished)", async (t) => {
    if (!pgAvailable) return t.skip("PG fixture not available");
    const uid = await insertUser();
    const id = await insertV3Container(uid, "deadbeef00112233");
    const cap = freshCapture();
    const docker = makeDocker(cap);
    const v3Deps: V3SupervisorDeps = {
      docker,
      pool: getPool(),
      image: "openclaude/openclaude-runtime:test",
    };

    await adminRestartContainer(id, docker, makeAuditCtx(uid), v3Deps);
    // v3 = stopAndRemoveV3Container = 调 docker stop + remove(用 container_internal_id)
    assert.equal(cap.stopCalled, true, "v3 restart 应调 docker stop(via stopAndRemove)");
    assert.equal(cap.stopName, "deadbeef00112233", "用 container_internal_id");
    assert.equal(cap.removeCalled, true, "v3 restart 应调 docker remove force");
    assert.equal(cap.restartCalled, false, "v3 不应走 v2 的 docker.restart");

    // DB 行应 vanished
    const r = await query<{ state: string }>(
      `SELECT state FROM agent_containers WHERE id = $1`,
      [String(id)],
    );
    assert.equal(r.rows[0]!.state, "vanished");
  });

  test("v3 行:adminStopContainer → stopAndRemove + state vanished", async (t) => {
    if (!pgAvailable) return t.skip("PG fixture not available");
    const uid = await insertUser();
    const id = await insertV3Container(uid, "deadbeefaabb");
    const cap = freshCapture();
    const docker = makeDocker(cap);
    const v3Deps: V3SupervisorDeps = { docker, pool: getPool(), image: "x" };

    await adminStopContainer(id, docker, makeAuditCtx(uid), v3Deps);
    assert.equal(cap.stopCalled, true);
    assert.equal(cap.stopName, "deadbeefaabb");
    assert.equal(cap.removeCalled, true);

    const r = await query<{ state: string }>(
      `SELECT state FROM agent_containers WHERE id = $1`,
      [String(id)],
    );
    assert.equal(r.rows[0]!.state, "vanished");
  });

  test("v3 行:adminRemoveContainer → stopAndRemove + state vanished", async (t) => {
    if (!pgAvailable) return t.skip("PG fixture not available");
    const uid = await insertUser();
    const id = await insertV3Container(uid, "ccddeeff");
    const cap = freshCapture();
    const docker = makeDocker(cap);
    const v3Deps: V3SupervisorDeps = { docker, pool: getPool(), image: "x" };

    await adminRemoveContainer(id, docker, makeAuditCtx(uid), v3Deps);
    assert.equal(cap.stopCalled, true);
    assert.equal(cap.removeCalled, true);

    const r = await query<{ state: string }>(
      `SELECT state FROM agent_containers WHERE id = $1`,
      [String(id)],
    );
    assert.equal(r.rows[0]!.state, "vanished");
  });

  test("v3 行 + 没传 v3Supervisor → V3SupervisorMissingError", async (t) => {
    if (!pgAvailable) return t.skip("PG fixture not available");
    const uid = await insertUser();
    const id = await insertV3Container(uid, "abcd1234");
    const docker = makeDocker(freshCapture());

    await assert.rejects(
      () => adminRestartContainer(id, docker, makeAuditCtx(uid), undefined),
      (err: unknown) => err instanceof V3SupervisorMissingError,
    );
    await assert.rejects(
      () => adminStopContainer(id, docker, makeAuditCtx(uid), undefined),
      (err: unknown) => err instanceof V3SupervisorMissingError,
    );
    await assert.rejects(
      () => adminRemoveContainer(id, docker, makeAuditCtx(uid), undefined),
      (err: unknown) => err instanceof V3SupervisorMissingError,
    );
  });

  test("不存在的 id → ContainerNotFoundError(无论是否传 v3Supervisor)", async (t) => {
    if (!pgAvailable) return t.skip("PG fixture not available");
    // 抛 NotFound 在 audit 之前,所以 adminId 是否存在无关
    const ctx = makeAuditCtx();
    const docker = makeDocker(freshCapture());
    const v3Deps: V3SupervisorDeps = { docker, pool: getPool(), image: "x" };

    await assert.rejects(
      () => adminRestartContainer(BigInt(999_999), docker, ctx, v3Deps),
      (err: unknown) => err instanceof ContainerNotFoundError,
    );
    await assert.rejects(
      () => adminStopContainer(BigInt(999_999), docker, ctx, v3Deps),
      (err: unknown) => err instanceof ContainerNotFoundError,
    );
    await assert.rejects(
      () => adminRemoveContainer(BigInt(999_999), docker, ctx, v3Deps),
      (err: unknown) => err instanceof ContainerNotFoundError,
    );
  });

  test("v3 行 + container_internal_id=NULL(provision 中途)→ 不调 docker, state→vanished", async (t) => {
    if (!pgAvailable) return t.skip("PG fixture not available");
    const uid = await insertUser();
    const id = await insertV3Container(uid, null);
    const cap = freshCapture();
    const docker = makeDocker(cap);
    const v3Deps: V3SupervisorDeps = { docker, pool: getPool(), image: "x" };

    await adminStopContainer(id, docker, makeAuditCtx(uid), v3Deps);
    // 没 container_internal_id 时,stopAndRemoveV3Container 不调 docker
    assert.equal(cap.stopCalled, false, "container_internal_id=NULL 时不应调 docker stop");
    assert.equal(cap.removeCalled, false, "container_internal_id=NULL 时不应调 docker remove");

    const r = await query<{ state: string }>(
      `SELECT state FROM agent_containers WHERE id = $1`,
      [String(id)],
    );
    assert.equal(r.rows[0]!.state, "vanished", "仍应 UPDATE state=vanished(掉单清理)");
  });

  // 2026-04-21 codex round 1 finding #4 part A:admin 列表必须暴露 v3 行的
  // state(原来只看 status,v3 行 status 永远为 NULL → admin 看不到真状态)。
  test("listContainers:暴露 row_kind + lifecycle,v3 行用 state,v2 行用 status", async (t) => {
    if (!pgAvailable) return t.skip("PG fixture not available");
    const uidV2 = await insertUser();
    await insertV2Container(uidV2);
    const uidV3 = await insertUser();
    await insertV3Container(uidV3, "container-internal-xyz");

    const rows = await listContainers({ limit: 10 });
    assert.ok(rows.length >= 2, `expected >=2 rows, got ${rows.length}`);

    const v2 = rows.find((r) => r.row_kind === "v2");
    const v3 = rows.find((r) => r.row_kind === "v3");
    assert.ok(v2, "v2 row must be in result");
    assert.ok(v3, "v3 row must be in result");

    // v2:lifecycle = status('running')
    assert.equal(v2!.row_kind, "v2");
    assert.equal(v2!.status, "running");
    assert.equal(v2!.lifecycle, "running", "v2 lifecycle should fall back to status");

    // v3:lifecycle = state('active');state 字段也直接暴露
    assert.equal(v3!.row_kind, "v3");
    assert.equal(v3!.state, "active");
    assert.equal(v3!.lifecycle, "active", "v3 lifecycle should come from state");
  });
});
