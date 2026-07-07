/**
 * provisionV3Container saga(两段短事务)真 PG 集成测试 —— P1 事务窗口收窄验收。
 *
 * 覆盖(全部需真 advisory lock + 真 idle-in-transaction 语义,fake pool 测不出):
 *   1. 判决性:idle_in_transaction_session_timeout=1s 下,fake docker create 睡 2s →
 *      provision 仍成功、连接不被 PG 强断(证明 docker 慢 IO 不在开着的事务里跑)。
 *      —— 旧单长事务设计下 tx1Client 会 idle-in-tx >1s 被 PG kill,COMMIT/后续 query 抛。
 *   2. 去串行:同 host 两个不同 uid 并发,fake docker 睡 3s → 两者 Tx1 亚毫秒各自完成
 *      不互相阻塞(总墙钟 ≈ 3s 而非 6s;旧设计 per-host 锁跨整个 docker → 串行 ≈6s)。
 *   3. cap 无超卖:max_containers=N,并发 N+1(fake docker 慢)→ 恰 N 条 active,第 N+1 HostFull。
 *   4. 同 uid 并发:第二个命中 per-uid 锁内 dup 复查 → NameConflict(不留双 active 行)。
 *   5. 补偿:中段 docker 失败 → 占位行翻 vanished + slot 释放(重试可复用 uid/IP);
 *      start 失败 → docker rm 被调 + 行翻 vanished。
 *
 * 本地运行:
 *   TEST_DATABASE_URL=postgres://test:test@127.0.0.1:55432/openclaude_test \
 *   REQUIRE_TEST_DB=1 npx tsx --test src/__tests__/v3ProvisionTxWindow.integ.test.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { Pool } from "pg";
import type Docker from "dockerode";

process.env.OPENCLAUDE_KMS_KEY ??= Buffer.alloc(32, 0x3a).toString("base64");
// v5 channel:跳过 v3MayServe 迁移门(不依赖 channel_migration_state),走 local-only 直建路径。
process.env.OC_RUNTIME_CHANNEL = "v5";
// 基线缺失降级为 warn(测试环境无 CCB 基线目录),避免 CcbBaselineMissing。
process.env.OC_V3_CCB_BASELINE_OPTIONAL = "1";
// 关镜像 supply-chain guard(fake docker 无真 image labels)。
process.env.OC_V3_IMAGE_GUARD = "off";

import {
  provisionV3Container,
  getV3ContainerStatus,
  makeUidSingleflight,
  SupervisorError,
  type V3SupervisorDeps,
} from "../agent-sandbox/index.js";
import { listContainers } from "../admin/containers.js";
import { userHasRunningContainer } from "../compute-pool/queries.js";
import { closePool, createPool, resetPool, setPoolOverride } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { query } from "../db/queries.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";
const TEST_IMAGE = "openclaude/openclaude-runtime:test";

let pgAvailable = false;

function assertTestDatabase(url: string): void {
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!dbName.endsWith("_test")) throw new Error(`refusing non-test database: ${dbName}`);
}

async function probe(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 });
  try {
    await p.query("SELECT 1");
    await p.end();
    return true;
  } catch {
    try { await p.end(); } catch { /* ignore */ }
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── fake docker:可配置 create 延时 / 抛错 / start 抛错;满足 ensureV3Volumes + create + start ──
type IntegDockerOpts = { createDelayMs?: number; createThrows?: boolean; startThrows?: boolean };
function makeIntegFakeDocker(opts: IntegDockerOpts = {}): {
  docker: Docker;
  captured: { created: number; started: number; removed: number };
} {
  const captured = { created: 0, started: 0, removed: 0 };
  const volLabels = new Map<string, Record<string, string>>();
  const docker = {
    createVolume: async (o: { Name?: string; Labels?: Record<string, string> }) => {
      if (o.Name) volLabels.set(o.Name, o.Labels ?? {});
      return {};
    },
    getVolume: (name: string) => ({
      inspect: async () => ({ Name: name, Driver: "local", Labels: volLabels.get(name) ?? {}, Options: null }),
      remove: async () => { /* noop */ },
    }),
    createContainer: async () => {
      captured.created++;
      if (opts.createDelayMs) await sleep(opts.createDelayMs);
      if (opts.createThrows) {
        const e = new Error("docker create boom") as Error & { statusCode: number };
        e.statusCode = 500;
        throw e;
      }
      const id = `dockerid-${captured.created}`;
      return {
        id,
        start: async () => {
          if (opts.startThrows) {
            const e = new Error("docker start boom") as Error & { statusCode: number };
            e.statusCode = 500;
            throw e;
          }
          captured.started++;
        },
        remove: async () => { captured.removed++; },
      };
    },
    getContainer: (id: string) => ({
      inspect: async () => ({ Id: id, State: { Running: true, Status: "running" } }),
      stop: async () => { /* noop */ },
      remove: async () => { captured.removed++; },
    }),
    getImage: () => ({ inspect: async () => ({ Config: { Labels: { "oc.runtime.features": "v3-sink" } } }) }),
  } as unknown as Docker;
  return { docker, captured };
}

/** 种一个 users 行(显式 id = uid,满足 agent_containers.user_id FK)。 */
async function seedUser(uid: number): Promise<void> {
  await query(
    `INSERT INTO users(id, email, password_hash, status)
       VALUES ($1::bigint, $2, 'argon2$stub', 'active')
     ON CONFLICT (id) DO NOTHING`,
    [String(uid), `u${uid}@tx-window.test`],
  );
}

/** 种一台 compute_hosts(canonical uuid),供 cap query + acquireHostCapLock + INSERT host_uuid。 */
async function insertSelfHost(maxContainers: number): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO compute_hosts(
       name, host, ssh_port, ssh_user, agent_port,
       ssh_password_nonce, ssh_password_ct, agent_psk_nonce, agent_psk_ct,
       max_containers, bridge_cidr, status
     ) VALUES (
       'self', '127.0.0.1', 22, 'root', 9443,
       '\\x01'::bytea, '\\x01'::bytea, '\\x01'::bytea, '\\x01'::bytea,
       $1, '172.31.0.0/16', 'ready'
     ) RETURNING id::text AS id`,
    [maxContainers],
  );
  return r.rows[0]!.id;
}

function makeDeps(pool: Pool, docker: Docker, selfHostId: string): V3SupervisorDeps {
  return {
    docker,
    pool,
    image: TEST_IMAGE,
    selfHostId,
    randomSecret: () => "a".repeat(64),
  };
}

before(async () => {
  pgAvailable = await probe();
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error("Postgres test fixture required");
    return;
  }
  assertTestDatabase(TEST_DB_URL);
  await resetPool();
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 20 }));
  await query("DROP SCHEMA IF EXISTS public CASCADE");
  await query("CREATE SCHEMA public");
  await query("GRANT ALL ON SCHEMA public TO public");
  await runMigrations();
});

after(async () => {
  if (pgAvailable) await closePool();
});

beforeEach(async () => {
  if (!pgAvailable) return;
  // TRUNCATE users CASCADE 连带清 agent_containers(FK),再删 compute_hosts。
  await query("TRUNCATE TABLE users RESTART IDENTITY CASCADE");
  await query("DELETE FROM compute_hosts");
});

function skip(t: { skip: (r: string) => void }): boolean {
  if (!pgAvailable) {
    t.skip("pg not available");
    return true;
  }
  return false;
}

describe("provisionV3Container saga — 真 PG 事务窗口", () => {
  test("判决性:idle_in_transaction_session_timeout=1s + docker create 睡 2s → provision 成功,连接不被强断", async (t) => {
    if (skip(t)) return;
    const hostId = await insertSelfHost(10);
    await seedUser(4201);
    // 专用 raw pool:idle-in-tx 上限 1s(远小于 docker 的 2s 延时)。
    // 旧单长事务设计下,tx1Client 在 BEGIN 后 idle >1s 会被 PG kill → COMMIT/后续 query 抛。
    // saga 下 docker 慢 IO 不在事务里 → 无连接 idle-in-tx → 不被断。
    const strictPool = new Pool({
      connectionString: TEST_DB_URL,
      max: 4,
      idle_in_transaction_session_timeout: 1000,
      statement_timeout: 15_000,
    } as ConstructorParameters<typeof Pool>[0]);
    try {
      const { docker } = makeIntegFakeDocker({ createDelayMs: 2000 });
      const res = await provisionV3Container(makeDeps(strictPool, docker, hostId), 4201, hostId);
      assert.ok(res.containerId > 0);
      assert.equal(res.dockerContainerId, "dockerid-1");
      // 行落库:active + cid 已写(Tx2)。
      const row = await query<{ state: string; cid: string | null }>(
        `SELECT state, container_internal_id AS cid FROM agent_containers WHERE id = $1`,
        [String(res.containerId)],
      );
      assert.equal(row.rows[0]!.state, "active");
      assert.equal(row.rows[0]!.cid, "dockerid-1");
    } finally {
      await strictPool.end();
    }
  });

  test("去串行:同 host 两个不同 uid 并发,docker 睡 3s → 两者 Tx1 不互相阻塞(墙钟 ≈3s 非 6s)", async (t) => {
    if (skip(t)) return;
    const hostId = await insertSelfHost(10);
    const pool = createPool({ connectionString: TEST_DB_URL, max: 10 });
    try {
      const { docker } = makeIntegFakeDocker({ createDelayMs: 3000 });
      await seedUser(4210);
      await seedUser(4211);
      const t0 = Date.now();
      const [a, b] = await Promise.all([
        provisionV3Container(makeDeps(pool, docker, hostId), 4210, hostId),
        provisionV3Container(makeDeps(pool, docker, hostId), 4211, hostId),
      ]);
      const elapsed = Date.now() - t0;
      assert.ok(a.containerId > 0 && b.containerId > 0);
      // 并行:两个 3s docker 中段并发 → ≈3s。旧设计 per-host 锁跨整个 docker → 串行 ≈6s。
      assert.ok(elapsed < 4500, `期望并行墙钟<4500ms,实际 ${elapsed}ms(疑似退回长事务串行)`);
      const cnt = await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM agent_containers WHERE state='active' AND host_uuid=$1::uuid`,
        [hostId],
      );
      assert.equal(cnt.rows[0]!.n, "2");
    } finally {
      await pool.end();
    }
  });

  test("cap 无超卖:max=2,并发 3 个不同 uid(docker 慢)→ 恰 2 条 active,第 3 个 HostFull", async (t) => {
    if (skip(t)) return;
    const hostId = await insertSelfHost(2);
    const pool = createPool({ connectionString: TEST_DB_URL, max: 10 });
    try {
      const { docker } = makeIntegFakeDocker({ createDelayMs: 800 });
      await seedUser(4220);
      await seedUser(4221);
      await seedUser(4222);
      const results = await Promise.allSettled([
        provisionV3Container(makeDeps(pool, docker, hostId), 4220, hostId),
        provisionV3Container(makeDeps(pool, docker, hostId), 4221, hostId),
        provisionV3Container(makeDeps(pool, docker, hostId), 4222, hostId),
      ]);
      const ok = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      assert.equal(ok.length, 2, "恰 2 个成功");
      assert.equal(rejected.length, 1, "恰 1 个被拒");
      assert.ok(
        rejected[0]!.reason instanceof SupervisorError &&
          (rejected[0]!.reason as SupervisorError).code === "HostFull",
        "第 3 个必须是 HostFull(cap+INSERT 同 Tx1 持锁,无超卖)",
      );
      const cnt = await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM agent_containers WHERE state='active' AND host_uuid=$1::uuid`,
        [hostId],
      );
      assert.equal(cnt.rows[0]!.n, "2", "active 行恰 2(未超卖)");
    } finally {
      await pool.end();
    }
  });

  test("同 uid 并发:第二个命中 per-uid 锁内 dup 复查 → NameConflict(不留双 active 行)", async (t) => {
    if (skip(t)) return;
    const hostId = await insertSelfHost(10);
    const pool = createPool({ connectionString: TEST_DB_URL, max: 10 });
    try {
      const { docker } = makeIntegFakeDocker({ createDelayMs: 300 });
      await seedUser(4230);
      const results = await Promise.allSettled([
        provisionV3Container(makeDeps(pool, docker, hostId), 4230, hostId),
        provisionV3Container(makeDeps(pool, docker, hostId), 4230, hostId),
      ]);
      const ok = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      assert.equal(ok.length, 1, "恰 1 个成功");
      assert.equal(rejected.length, 1, "恰 1 个 NameConflict");
      assert.ok(
        rejected[0]!.reason instanceof SupervisorError &&
          (rejected[0]!.reason as SupervisorError).code === "NameConflict",
      );
      const cnt = await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM agent_containers WHERE user_id=$1::bigint AND state='active'`,
        ["4230"],
      );
      assert.equal(cnt.rows[0]!.n, "1", "同 uid 恰 1 条 active(uniq 仲裁)");
    } finally {
      await pool.end();
    }
  });

  test("补偿(docker create 失败):Tx1 提交后中段失败 → 行翻 vanished + slot 释放(同 uid 可重试成功)", async (t) => {
    if (skip(t)) return;
    const hostId = await insertSelfHost(10);
    const pool = createPool({ connectionString: TEST_DB_URL, max: 10 });
    try {
      await seedUser(4240);
      // 第一次:docker create 抛错 → 补偿翻 vanished。
      const { docker: failDocker } = makeIntegFakeDocker({ createThrows: true });
      await assert.rejects(
        provisionV3Container(makeDeps(pool, failDocker, hostId), 4240, hostId),
        (e: Error) => e instanceof SupervisorError,
      );
      const after1 = await query<{ state: string; cid: string | null }>(
        `SELECT state, container_internal_id AS cid FROM agent_containers WHERE user_id=$1::bigint`,
        ["4240"],
      );
      assert.equal(after1.rows.length, 1, "Tx1 占位行已提交");
      assert.equal(after1.rows[0]!.state, "vanished", "中段失败 → 补偿翻 vanished");
      assert.equal(after1.rows[0]!.cid, null, "cid 从未写(Tx2 未跑)");
      // 无 active 行 → getV3ContainerStatus 返回 null(不留孤儿)。
      assert.equal(await getV3ContainerStatus(makeDeps(pool, failDocker, hostId), 4240), null);

      // 第二次:slot 已释放(uniq_ac_user_id_active partial),重试成功。
      const { docker: okDocker } = makeIntegFakeDocker({});
      const res = await provisionV3Container(makeDeps(pool, okDocker, hostId), 4240, hostId);
      assert.ok(res.containerId > 0, "补偿释放 slot 后同 uid 可重新 provision");
      const active = await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM agent_containers WHERE user_id=$1::bigint AND state='active'`,
        ["4240"],
      );
      assert.equal(active.rows[0]!.n, "1");
    } finally {
      await pool.end();
    }
  });

  test("补偿(docker start 失败):容器已 create → docker rm 被调 + 行翻 vanished", async (t) => {
    if (skip(t)) return;
    const hostId = await insertSelfHost(10);
    const pool = createPool({ connectionString: TEST_DB_URL, max: 10 });
    try {
      const { docker, captured } = makeIntegFakeDocker({ startThrows: true });
      await seedUser(4250);
      await assert.rejects(
        provisionV3Container(makeDeps(pool, docker, hostId), 4250, hostId),
        (e: Error) => e instanceof SupervisorError,
      );
      assert.equal(captured.created, 1, "容器已 create");
      assert.ok(captured.removed >= 1, "start 失败后 docker rm 被调(就近回收 + 补偿兜底)");
      const row = await query<{ state: string }>(
        `SELECT state FROM agent_containers WHERE user_id=$1::bigint`,
        ["4250"],
      );
      assert.equal(row.rows[0]!.state, "vanished");
    } finally {
      await pool.end();
    }
  });

  test("在途 provisioning 可见性:中段(cid=NULL)并发观察者 getV3ContainerStatus → 'provisioning' 且不扰动在途行(Codex MAJOR)", async (t) => {
    if (skip(t)) return;
    const hostId = await insertSelfHost(10);
    const pool = createPool({ connectionString: TEST_DB_URL, max: 10 });
    try {
      await seedUser(4260);
      const { docker } = makeIntegFakeDocker({ createDelayMs: 1500 });
      // 不 await:provision 停在中段(docker create 睡 1.5s),Tx1 已提交 active/cid=NULL 占位行。
      const inflight = provisionV3Container(makeDeps(pool, docker, hostId), 4260, hostId);
      await sleep(500); // Tx1 已提交但仍在中段(< createDelayMs)
      // 观察者(模拟另一闭包的 WS ensureRunning 先手 getV3ContainerStatus)看到在途态。
      const mid = await getV3ContainerStatus(makeDeps(pool, docker, hostId), 4260);
      assert.ok(mid, "中段占位行可见");
      assert.strictEqual(mid!.state, "provisioning", "young cid=NULL → provisioning(非可销毁的 stopped)");
      assert.strictEqual(mid!.dockerContainerId, "");
      const midRow = await query<{ state: string }>(
        `SELECT state FROM agent_containers WHERE user_id=$1::bigint`,
        ["4260"],
      );
      assert.strictEqual(midRow.rows[0]!.state, "active", "在途行未被观察者销毁");
      // provision 完成 → running + cid 落库(观察者若曾 provisioning-wait,下轮命中 running)。
      const res = await inflight;
      assert.ok(res.containerId > 0);
      const done = await getV3ContainerStatus(makeDeps(pool, docker, hostId), 4260);
      assert.strictEqual(done!.state, "running");
      assert.strictEqual(done!.dockerContainerId, "dockerid-1");
    } finally {
      await pool.end();
    }
  });

  test("单一 singleflight 统一:并发同 uid 经同一 wrapper 合并 → 只跑一次 provision、在途行不被销毁(>15s 慢 IO 亦然)", async (t) => {
    if (skip(t)) return;
    const hostId = await insertSelfHost(10);
    const pool = createPool({ connectionString: TEST_DB_URL, max: 10 });
    try {
      await seedUser(4270);
      // 慢中段(1.2s;语义上任意慢——join 不看时长):即使超过 15s grace,后来者也是 join 而非观察。
      const { docker, captured } = makeIntegFakeDocker({ createDelayMs: 1200 });
      // 模拟 index.ts sharedEnsureRunning:所有 provision 入口(WS/media/cronWake/prewarm)统一进
      // 唯一 makeUidSingleflight。并发同 uid → 后来者 join 同一 in-flight promise,绝不独立走
      // getV3ContainerStatus 观察 cid=NULL 在途行去销毁它(修 Codex MAJOR 的根治保证)。
      const shared = makeUidSingleflight((uid: bigint) =>
        provisionV3Container(makeDeps(pool, docker, hostId), Number(uid), hostId),
      );
      const [a, b] = await Promise.all([shared(4270n), shared(4270n)]);
      assert.strictEqual(a, b, "并发同 uid 必须 join 同一 promise(拿同一结果对象)");
      assert.strictEqual(captured.created, 1, "只跑一次 provision(第二路 join,未另起观察/销毁)");
      const rows = await query<{ n: string; v: string }>(
        `SELECT count(*) FILTER (WHERE state='active')::text AS n,
                count(*) FILTER (WHERE state='vanished')::text AS v
           FROM agent_containers WHERE user_id=$1::bigint`,
        ["4270"],
      );
      assert.strictEqual(rows.rows[0]!.n, "1", "恰一条 active");
      assert.strictEqual(rows.rows[0]!.v, "0", "在途行绝不被并发观察者销毁翻 vanished");
    } finally {
      await pool.end();
    }
  });

  test("admin 列表:v3 active+cid=NULL grace 内显 'provisioning' / grace 外显 'missing',不再误显示 running(Codex MINOR)", async (t) => {
    if (skip(t)) return;
    const hostId = await insertSelfHost(10);
    // listContainers / query 走 before() 装配的全局 pool(getPool());无需本地 pool。
    await seedUser(4280);
    await seedUser(4281);
    await seedUser(4282);
    const insertRow = (uid: string, ip: string, cid: string | null, ageSec: number) =>
      query(
        `INSERT INTO agent_containers(user_id, host_uuid, bound_ip, secret_hash, state, port,
             runtime_channel, container_internal_id, created_at, updated_at)
         VALUES ($1::bigint, $2::uuid, $3::inet, decode(repeat('01', 32), 'hex'), 'active', 18789, 'v5', $4,
             NOW() - ($5::text || ' seconds')::interval, NOW())`,
        [uid, hostId, ip, cid, String(ageSec)],
      );
    await insertRow("4280", "172.31.9.10", null, 1); // young cid=NULL
    await insertRow("4281", "172.31.9.11", null, 60); // old cid=NULL(>grace)
    await insertRow("4282", "172.31.9.12", "deadbeefcid", 1); // 正常 running

    const list = await listContainers({ limit: 100 });
    const lc = (uid: string) => list.find((r) => r.user_id === uid)?.lifecycle;
    assert.strictEqual(lc("4280"), "provisioning", "young cid=NULL → provisioning(不再 running)");
    assert.strictEqual(lc("4281"), "missing", "old cid=NULL → missing");
    assert.strictEqual(lc("4282"), "active", "cid 已落 → active(running)");

    // 过滤一致性:running 过滤排除 cid=NULL 行;provisioning 过滤含 young cid=NULL 行。
    const running = await listContainers({ status: "running", limit: 100 });
    assert.ok(
      running.every((r) => r.user_id !== "4280" && r.user_id !== "4281"),
      "running 过滤不含 cid=NULL 行",
    );
    assert.ok(running.some((r) => r.user_id === "4282"), "running 过滤含正常 running 行");
    const prov = await listContainers({ status: "provisioning", limit: 100 });
    assert.ok(prov.some((r) => r.user_id === "4280"), "provisioning 过滤含 young cid=NULL 行");
    assert.ok(prov.every((r) => r.user_id !== "4281"), "provisioning 过滤不含 old(>grace)cid=NULL 行");

    // Codex MINOR:'missing' 入白名单可筛选 = grace 外 cid=NULL 孤儿(与 provisioning 互补)。
    const missing = await listContainers({ status: "missing", limit: 100 });
    assert.ok(missing.some((r) => r.user_id === "4281"), "missing 过滤含 old(>grace)cid=NULL 行");
    assert.ok(
      missing.every((r) => r.user_id !== "4280" && r.user_id !== "4282"),
      "missing 过滤不含 young cid=NULL / 正常 running 行",
    );
  });

  test("cronWake 自愈:isContainerActive(userHasRunningContainer)对 active+cid=NULL 孤儿返 false → 不 skip、照常唤醒(Codex MAJOR)", async (t) => {
    if (skip(t)) return;
    const hostId = await insertSelfHost(10);
    await seedUser(4290); // active + cid=NULL 孤儿(saga Tx1 提交、Tx2 前崩溃)
    await seedUser(4291); // active + cid 已落库(真·在跑)
    await seedUser(4292); // vanished
    const ins = (uid: string, ip: string, cid: string | null, state: string) =>
      query(
        `INSERT INTO agent_containers(user_id, host_uuid, bound_ip, secret_hash, state, port,
             runtime_channel, container_internal_id, last_ws_activity, created_at, updated_at)
         VALUES ($1::bigint, $2::uuid, $3::inet, decode(repeat('01',32),'hex'), $4, 18789, 'v5', $5, NOW(), NOW(), NOW())`,
        [uid, hostId, ip, state, cid],
      );
    await ins("4290", "172.31.8.20", null, "active");
    await ins("4291", "172.31.8.21", "runningcid", "active");
    await ins("4292", "172.31.8.22", "vanishedcid", "vanished");

    // 修复语义:cid=NULL 孤儿**不算**在跑 → false → cronWake 不 skip、照常 wakeContainer→
    // sharedEnsureRunning 自愈(否则 heartbeat 等 cron 永不 fire)。
    assert.strictEqual(await userHasRunningContainer(4290), false, "active+cid=NULL 孤儿 → false(照常唤醒)");
    assert.strictEqual(await userHasRunningContainer(4291), true, "active+cid 已落 → true(在跑,跳过唤醒)");
    assert.strictEqual(await userHasRunningContainer(4292), false, "vanished → false");
    assert.strictEqual(await userHasRunningContainer(999999), false, "无行 → false");

    // 语义闭合:isContainerActive 闭包(= cronWake 注入的那个)对孤儿返回 false。
    const isContainerActive = (uid: bigint) => userHasRunningContainer(Number(uid));
    assert.strictEqual(await isContainerActive(4290n), false, "cronWake 预检不把孤儿当 active");
  });
});
