import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { Client, Pool } from "pg";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query, tx } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";

/**
 * 模型权威批次 · 0136 加固(Codex 代码审 R1:BLOCKER-1 + MAJOR-1)—— 真实 PG。
 *
 * 覆盖:
 *   ① BLOCKER-1:model_visibility_grants 的 INSERT/UPDATE/DELETE → 同事务 bump security epoch
 *      + NOTIFY(撤权对消费侧的 fence 立刻可见)
 *   ② MAJOR-1 边界(**对 owner 也生效的 trigger 层**):
 *      · INSERT 只能生于 staged(直插 active/disabled 拒)
 *      · DELETE 只允许 staged(active/disabled/retired = 历史,不可物理删除)
 *      · TRUNCATE 三表全拒
 *      · epoch 只能 +1 单调(回退/跳变/删行全拒)
 *      · execution 字段只有 staged 行可改(0135 只冻 active → disabled 行可被原地改写)
 *      · DELETE FROM model_pricing 改**软退役**(0135 会物理删光全部版本历史)
 *   ③ MAJOR-1 权限层(**割接后**的形态,用真实受限角色连库验证):
 *      应用角色对 catalog/aliases/epoch 零 DML、内部 DEFINER 过程不可直接调,
 *      但既有业务写(model_pricing / grants)与受控状态机过程全部照常可用
 *   ④ 受控过程矩阵:stage → activate → disable → retire / switch_version / drop_staged / alias
 *
 * fixture:与 migrate_full.integ / modelCatalogDb.integ 同一 PG(见 packages/commercial/README.md)。
 */

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";

const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

/** 受限角色(模拟割接后的 app 角色)。名字带后缀防与并行套件撞车。 */
const APP_ROLE = "oc_authz_probe_role";
const APP_ROLE_PW = "probe-pw";

let pgAvailable = false;
let appPool: Pool | null = null;
let testUserId: string | null = null;

const CAPABILITY = '{"supports_vision":false,"reasoning":{"supported":[],"codex_model_default":null}}';

function skipIfNoPg(t: TestContext): boolean {
  if (!pgAvailable) {
    t.skip("postgres fixture unavailable");
    return true;
  }
  return false;
}

async function probe(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 });
  try {
    await p.query("SELECT 1");
    await p.end();
    return true;
  } catch {
    try {
      await p.end();
    } catch {
      /* ignore */
    }
    return false;
  }
}

async function dropSchema(): Promise<void> {
  const rows = await query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  );
  if (rows.rows.length > 0) {
    const quoted = rows.rows.map((r) => `"${r.table_name.replaceAll('"', '""')}"`).join(", ");
    await query(`DROP TABLE IF EXISTS ${quoted} CASCADE`);
  }
}

/** 期望 SQL 被 DB 拒绝,并且错误信息命中 needle。 */
async function expectRejected(sql: string, needle: string, params: unknown[] = []): Promise<void> {
  await assert.rejects(
    () => query(sql, params),
    (err: Error) => {
      assert.match(err.message, new RegExp(needle, "i"), `expected rejection matching /${needle}/`);
      return true;
    },
    `expected DB to reject: ${sql}`,
  );
}

async function epochNow(): Promise<bigint> {
  const r = await query<{ epoch: string }>("SELECT epoch::text AS epoch FROM model_security_epoch");
  return BigInt(r.rows[0].epoch);
}

async function statesOf(modelId: string): Promise<Array<{ entry_id: string; state: string }>> {
  // ORDER BY **必须限定表名**:输出列 `entry_id` 是 text(::text),不限定的话 SQL 会先匹配
  // 输出列名 → 变成字典序('15' < '6'),多版本时排序就错了。
  const r = await query<{ entry_id: string; state: string }>(
    `SELECT c.entry_id::text AS entry_id, c.state
       FROM model_catalog c WHERE c.model_id=$1 ORDER BY c.entry_id`,
    [modelId],
  );
  return r.rows;
}

before(async () => {
  pgAvailable = await probe();
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) {
      throw new Error("Postgres test fixture required (CI=true or REQUIRE_TEST_DB=1).");
    }
    return;
  }
  await resetPool();
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 5 }));
  await dropSchema();
  await runMigrations();

  // grants 需要一个真实 user(FK)。
  const u = await query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, status)
     VALUES ('authz-guard@example.com', 'x', 'user', 'active')
     ON CONFLICT (email) DO UPDATE SET status='active'
     RETURNING id::text AS id`,
  );
  testUserId = u.rows[0].id;

  await query("CREATE TABLE _fxg_catalog AS TABLE model_catalog");
  await query("CREATE TABLE _fxg_pricing AS TABLE model_pricing");

  // 受限角色(割接后的 app 角色形态)。CREATE ROLE 需要 superuser —— 本地/CI 的 fixture
  // PG 都是 POSTGRES_USER=test 引导的超级用户(见 packages/commercial/README.md)。
  await query(`DROP ROLE IF EXISTS ${APP_ROLE}`).catch(() => undefined);
  await query(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_ROLE_PW}'`);
  await query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
  await query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`);
  await query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`);
  // 0136 的权限策略(单一权威):三张权威表只留 SELECT + 受控过程 EXECUTE。
  await query(`SELECT fn_model_authority_grant_app_role('${APP_ROLE}')`);

  const url = new URL(TEST_DB_URL);
  url.username = APP_ROLE;
  url.password = APP_ROLE_PW;
  appPool = new Pool({ connectionString: url.toString(), max: 2 });
});

after(async () => {
  if (!pgAvailable) return;
  if (appPool) {
    await appPool.end();
    appPool = null;
  }
  try {
    await query(`DROP OWNED BY ${APP_ROLE}`);
    await query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
  } catch {
    /* ignore */
  }
  try {
    await dropSchema();
  } catch {
    /* ignore */
  }
  await closePool();
  await resetPool();
});

/**
 * 每个用例从回填态开始。还原绕过 trigger(状态机单向:retired 不可复活;还原不是安全事件)——
 * `SET LOCAL session_replication_role = replica` 关掉 ORIGIN trigger,必须与后续语句同一 client。
 */
beforeEach(async () => {
  if (!pgAvailable) return;
  await tx(async (c) => {
    await c.query("SET LOCAL session_replication_role = replica");
    await c.query("DELETE FROM model_visibility_grants");
    await c.query("DELETE FROM model_aliases");
    await c.query("DELETE FROM model_catalog");
    await c.query("DELETE FROM model_pricing");
    await c.query("INSERT INTO model_pricing SELECT * FROM _fxg_pricing");
    await c.query("INSERT INTO model_catalog SELECT * FROM _fxg_catalog");
    await c.query(
      "SELECT setval('model_catalog_entry_id_seq', (SELECT MAX(entry_id) FROM model_catalog))",
    );
    await c.query("UPDATE model_security_epoch SET epoch = 1 WHERE id");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ① BLOCKER-1:grants → epoch + NOTIFY
// ═══════════════════════════════════════════════════════════════════════════

describe("0136 ① grants 写 → security epoch", () => {
  test("INSERT / UPDATE / DELETE 三种写都 bump epoch(撤权不再有 stale window)", async (t) => {
    if (skipIfNoPg(t)) return;
    const e0 = await epochNow();

    await query("INSERT INTO model_visibility_grants (user_id, model_id) VALUES ($1::bigint, 'gpt-5.5')", [
      testUserId,
    ]);
    const e1 = await epochNow();
    assert.ok(e1 > e0, `授权(INSERT)应 bump epoch:${e0} → ${e1}`);

    await query(
      "UPDATE model_visibility_grants SET model_id='glm-5.2' WHERE user_id=$1::bigint AND model_id='gpt-5.5'",
      [testUserId],
    );
    const e2 = await epochNow();
    assert.ok(e2 > e1, `改授权(UPDATE:对原模型是收窄)应 bump epoch:${e1} → ${e2}`);

    await query("DELETE FROM model_visibility_grants WHERE user_id=$1::bigint", [testUserId]);
    const e3 = await epochNow();
    assert.ok(e3 > e2, `**撤权(DELETE)**必须 bump epoch(BLOCKER-1):${e2} → ${e3}`);
  });

  test("撤权发 NOTIFY(model_security_epoch / model_catalog_changed)—— 消费侧靠它标 unknown", async (t) => {
    if (skipIfNoPg(t)) return;
    const listener = new Client({ connectionString: TEST_DB_URL });
    await listener.connect();
    const got: Array<{ channel: string; payload: string }> = [];
    listener.on("notification", (m) => got.push({ channel: m.channel, payload: m.payload ?? "" }));
    await listener.query("LISTEN model_security_epoch");
    await listener.query("LISTEN model_catalog_changed");

    try {
      await query("INSERT INTO model_visibility_grants (user_id, model_id) VALUES ($1::bigint, 'gpt-5.5')", [
        testUserId,
      ]);
      await query("DELETE FROM model_visibility_grants WHERE user_id=$1::bigint", [testUserId]);

      // NOTIFY 在 COMMIT 后异步投递
      const deadline = Date.now() + 3000;
      while (got.filter((g) => g.channel === "model_security_epoch").length < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
        await listener.query("SELECT 1"); // 驱动 notification 派发
      }

      const epochNotifies = got.filter((g) => g.channel === "model_security_epoch");
      assert.ok(epochNotifies.length >= 2, `期望授权 + 撤权各一条 epoch NOTIFY,实收 ${epochNotifies.length}`);
      assert.equal(epochNotifies.at(-1)?.payload, (await epochNow()).toString(), "payload = 新 epoch");
      assert.ok(
        got.some((g) => g.channel === "model_catalog_changed"),
        "同时发 model_catalog_changed(旧快照重建通道)",
      );
    } finally {
      await listener.end();
    }
  });

  test("同一事务内批量 grant 写只 bump 一次(epoch 是 fence,不是计数器)", async (t) => {
    if (skipIfNoPg(t)) return;
    const e0 = await epochNow();
    await tx(async (c) => {
      await c.query(
        "INSERT INTO model_visibility_grants (user_id, model_id) VALUES ($1::bigint,'gpt-5.5'),($1::bigint,'glm-5.2')",
        [testUserId],
      );
      await c.query("DELETE FROM model_visibility_grants WHERE user_id=$1::bigint", [testUserId]);
    });
    assert.equal(await epochNow(), e0 + 1n, "事务内幂等:多条写只抬一格");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ② MAJOR-1:trigger 层边界(owner 也绕不过)
// ═══════════════════════════════════════════════════════════════════════════

describe("0136 ② catalog 状态机边界", () => {
  test("INSERT 只能生于 staged(直插 active / disabled 拒)", async (t) => {
    if (skipIfNoPg(t)) return;
    await expectRejected(
      `INSERT INTO model_catalog (model_id, engine, provider_id, capability_profile, state)
       VALUES ('evil','ccb','deepseek','${CAPABILITY}','active')`,
      "must be born in staged state",
    );
    await expectRejected(
      `INSERT INTO model_catalog (model_id, engine, provider_id, capability_profile, state)
       VALUES ('evil','ccb','deepseek','${CAPABILITY}','disabled')`,
      "must be born in staged state",
    );
    await expectRejected(
      `INSERT INTO model_catalog (model_id, engine, provider_id, capability_profile, state)
       VALUES ('evil','ccb','deepseek','${CAPABILITY}','retired')`,
      "must be born in staged state",
    );

    // staged 合法,且**不 bump epoch**(staged 对消费侧不可见)
    const e0 = await epochNow();
    await query(
      `INSERT INTO model_catalog (model_id, engine, provider_id, capability_profile, state)
       VALUES ('probe','ccb','deepseek','${CAPABILITY}','staged')`,
    );
    assert.equal((await statesOf("probe"))[0].state, "staged");
    assert.equal(await epochNow(), e0, "建 staged 行不是安全事件 → 不抬 epoch");
  });

  test("DELETE 只允许 staged 行 —— active/disabled/retired 是历史,不可物理删除", async (t) => {
    if (skipIfNoPg(t)) return;
    await expectRejected(
      "DELETE FROM model_catalog WHERE model_id='glm-5.2'",
      "cannot be deleted",
    );
    await expectRejected(
      "DELETE FROM model_catalog WHERE model_id='gpt-5.5'", // 回填态 = disabled
      "cannot be deleted",
    );

    await query(
      `INSERT INTO model_catalog (model_id, engine, provider_id, capability_profile, state)
       VALUES ('probe','ccb','deepseek','${CAPABILITY}','staged')`,
    );
    await query("DELETE FROM model_catalog WHERE model_id='probe'");
    assert.deepEqual(await statesOf("probe"), [], "staged 行可删(从未可执行 → 无审计价值)");
  });

  test("TRUNCATE 三表全拒(TRUNCATE 绕过行级 trigger,必须 statement 级补)", async (t) => {
    if (skipIfNoPg(t)) return;
    await expectRejected("TRUNCATE model_catalog CASCADE", "TRUNCATE on model_catalog is forbidden");
    await expectRejected("TRUNCATE model_aliases", "TRUNCATE on model_aliases is forbidden");
    await expectRejected(
      "TRUNCATE model_security_epoch",
      "TRUNCATE on model_security_epoch is forbidden",
    );
  });

  test("epoch 只能 +1 单调(回退 = fence 直接失效)", async (t) => {
    if (skipIfNoPg(t)) return;
    await expectRejected("UPDATE model_security_epoch SET epoch = 1 WHERE id", "advance by exactly 1");
    await expectRejected(
      "UPDATE model_security_epoch SET epoch = epoch + 5 WHERE id",
      "advance by exactly 1",
    );
    await expectRejected("DELETE FROM model_security_epoch", "not deletable");
    await expectRejected(
      "INSERT INTO model_security_epoch (id, epoch) VALUES (TRUE, 99)",
      "singleton|duplicate key",
    );
    assert.equal(await epochNow(), 1n, "epoch 原封不动");
  });

  test("execution 字段只有 staged 行可改(0135 只冻 active → disabled 行可被原地改写后 activate)", async (t) => {
    if (skipIfNoPg(t)) return;
    await expectRejected(
      "UPDATE model_catalog SET engine='codex' WHERE model_id='gpt-5.5'", // disabled
      "execution fields of a disabled entry are immutable",
    );
    await expectRejected(
      "UPDATE model_catalog SET provider_id='codex' WHERE model_id='glm-5.2'", // active
      "execution fields of a active entry are immutable",
    );
    // staged 行可编辑(它是唯一的编辑面)
    await query(
      `INSERT INTO model_catalog (model_id, engine, provider_id, capability_profile, state)
       VALUES ('probe','ccb','deepseek','${CAPABILITY}','staged')`,
    );
    await query("UPDATE model_catalog SET context_window=123456 WHERE model_id='probe'");
    const r = await query<{ context_window: number }>(
      "SELECT context_window FROM model_catalog WHERE model_id='probe'",
    );
    assert.equal(r.rows[0].context_window, 123_456);
  });

  test("状态转移矩阵不变(retired 单向;被 alias 引用禁退休)", async (t) => {
    if (skipIfNoPg(t)) return;
    // alias 必须在行还是 active/staged 时挂上(alias 不可指向 disabled/retired)
    await query("SELECT fn_model_alias_set('glm-latest','glm-5.2')");
    await query("UPDATE model_catalog SET state='disabled' WHERE model_id='glm-5.2'");
    await expectRejected(
      "UPDATE model_catalog SET state='staged' WHERE model_id='glm-5.2'",
      "illegal state transition",
    );
    // 被 alias 引用的行禁止退休(alias 在 disable 后保留 —— disable 不需要先删 alias)
    await expectRejected(
      "UPDATE model_catalog SET state='retired' WHERE model_id='glm-5.2'",
      "referenced by alias",
    );
    await query("SELECT fn_model_alias_remove('glm-latest')");
    await query("UPDATE model_catalog SET state='retired' WHERE model_id='glm-5.2'");
    await expectRejected(
      "UPDATE model_catalog SET updated_by=1 WHERE model_id='glm-5.2'",
      "retired entry .* is immutable",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ③ 兼容层:pricing 写路由 + 软退役
// ═══════════════════════════════════════════════════════════════════════════

describe("0136 ③ model_pricing 兼容层", () => {
  test("DELETE FROM model_pricing → **软退役**(0135 会物理删光全部版本历史)", async (t) => {
    if (skipIfNoPg(t)) return;
    const before = await statesOf("kimi-k2.7-code");
    assert.equal(before.length, 1);
    assert.equal(before[0].state, "active");

    await query("DELETE FROM model_pricing WHERE model_id='kimi-k2.7-code'");

    const after = await statesOf("kimi-k2.7-code");
    assert.equal(after.length, 1, "catalog 历史行必须还在(不是物理删除)");
    assert.equal(after[0].state, "retired");
    assert.equal(after[0].entry_id, before[0].entry_id, "同一 entry_id —— 历史可回溯");

    // 重新 INSERT pricing → 派生**新 entry**(retired 不占 (staged∪active) 部分唯一索引)
    await query(
      `INSERT INTO model_pricing(model_id, display_name, input_per_mtok, output_per_mtok,
         cache_read_per_mtok, cache_write_per_mtok, multiplier, enabled, sort_order, visibility)
       VALUES ('kimi-k2.7-code','Kimi',684,2880,137,0,1.000,TRUE,88,'public')`,
    );
    const revived = await statesOf("kimi-k2.7-code");
    assert.equal(revived.length, 2, "旧 retired 历史 + 新 active");
    assert.deepEqual(revived.map((r) => r.state), ["retired", "active"]);
  });

  test("INSERT INTO model_pricing:enabled=TRUE → staged→active 两步;enabled=FALSE → 停在 staged", async (t) => {
    if (skipIfNoPg(t)) return;
    await query(
      `INSERT INTO model_pricing(model_id, display_name, input_per_mtok, output_per_mtok,
         cache_read_per_mtok, cache_write_per_mtok, multiplier, enabled, sort_order)
       VALUES ('deepseek-v9-on','DS9',1,1,1,1,1.0,TRUE,199)`,
    );
    const on = await query<{ engine: string; provider_id: string; state: string }>(
      "SELECT engine, provider_id, state FROM model_catalog WHERE model_id='deepseek-v9-on'",
    );
    assert.equal(on.rows[0].state, "active");
    assert.equal(on.rows[0].engine, "ccb");
    assert.equal(on.rows[0].provider_id, "deepseek", "执行语义由 protocol 派生,不接受调用方传值");

    await query(
      `INSERT INTO model_pricing(model_id, display_name, input_per_mtok, output_per_mtok,
         cache_read_per_mtok, cache_write_per_mtok, multiplier, enabled, sort_order)
       VALUES ('deepseek-v9-off','DS9',1,1,1,1,1.0,FALSE,199)`,
    );
    assert.equal((await statesOf("deepseek-v9-off"))[0].state, "staged");
    const mirror = await query<{ enabled: boolean }>(
      "SELECT enabled FROM model_pricing WHERE model_id='deepseek-v9-off'",
    );
    assert.equal(mirror.rows[0].enabled, false, "无 active 行 → 镜像 FALSE");
  });

  test("不变量:model_pricing.enabled 恒等于 (catalog 有 active 行)", async (t) => {
    if (skipIfNoPg(t)) return;
    await query("UPDATE model_pricing SET enabled=false WHERE model_id='glm-5.2'");
    await query("UPDATE model_pricing SET enabled=true  WHERE model_id='gpt-5.5'");
    await query("DELETE FROM model_pricing WHERE model_id='kimi-k2.7-code'");
    const drift = await query<{ model_id: string }>(
      `SELECT p.model_id FROM model_pricing p
        WHERE p.enabled IS DISTINCT FROM EXISTS (
          SELECT 1 FROM model_catalog c WHERE c.model_id = p.model_id AND c.state='active')`,
    );
    assert.deepEqual(drift.rows, [], "镜像与权威不允许漂移");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ④ 受控存储过程
// ═══════════════════════════════════════════════════════════════════════════

describe("0136 ④ 受控状态机过程", () => {
  test("stage → activate → disable → retire 全链 + epoch 只在可执行性变化时抬", async (t) => {
    if (skipIfNoPg(t)) return;
    const e0 = await epochNow();
    await query(
      `SELECT fn_model_stage_version('newmod','ccb','deepseek',NULL,200000,'${CAPABILITY}'::jsonb,1,NULL)`,
    );
    assert.equal((await statesOf("newmod"))[0].state, "staged");
    assert.equal(await epochNow(), e0, "staged 不抬 epoch");

    await query("SELECT fn_model_activate('newmod')");
    assert.equal((await statesOf("newmod"))[0].state, "active");
    assert.ok((await epochNow()) > e0, "激活 = 可执行性变化 → 抬 epoch");

    await query("SELECT fn_model_disable('newmod')");
    assert.equal((await statesOf("newmod"))[0].state, "disabled");

    const entryId = (await statesOf("newmod"))[0].entry_id;
    await query("SELECT fn_model_retire_entry($1::bigint)", [entryId]);
    assert.equal((await statesOf("newmod"))[0].state, "retired");
  });

  test("已有 active 版本时 stage 被拒(改执行语义必须产生新版本)", async (t) => {
    if (skipIfNoPg(t)) return;
    await assert.rejects(
      () =>
        query(
          `SELECT fn_model_stage_version('glm-5.2','codex','codex',NULL,NULL,'${CAPABILITY}'::jsonb,1,NULL)`,
        ),
      /already has a active version/i,
    );
  });

  test("switch_version:旧行 retire + 新行 active + alias 重指(单事务,历史保留)", async (t) => {
    if (skipIfNoPg(t)) return;
    await query("SELECT fn_model_alias_set('glm-latest','glm-5.2')");
    const oldEntry = (await statesOf("glm-5.2"))[0].entry_id;

    await query(
      `SELECT fn_model_switch_version('glm-5.2','codex','codex',NULL,NULL,
         '{"supports_vision":false,"reasoning":{"supported":["low","medium","high","xhigh","max"],"codex_model_default":"xhigh"}}'::jsonb,
         1,NULL)`,
    );

    const rows = await query<{ entry_id: string; engine: string; state: string }>(
      `SELECT c.entry_id::text AS entry_id, c.engine, c.state
         FROM model_catalog c WHERE c.model_id='glm-5.2' ORDER BY c.entry_id`,
    );
    assert.equal(rows.rows.length, 2);
    assert.deepEqual(
      rows.rows.map((r) => [r.engine, r.state]),
      [
        ["ccb", "retired"],
        ["codex", "active"],
      ],
    );
    assert.equal(rows.rows[0].entry_id, oldEntry, "旧版本原地保留为 retired 历史");

    const alias = await query<{ entry_id: string; state: string }>(
      `SELECT a.entry_id::text AS entry_id, c.state
         FROM model_aliases a JOIN model_catalog c USING (entry_id) WHERE a.alias='glm-latest'`,
    );
    assert.equal(alias.rows[0].entry_id, rows.rows[1].entry_id, "alias 重指到新 active 版本");
  });

  test("drop_staged:放弃待激活版本(alias 一并摘掉)", async (t) => {
    if (skipIfNoPg(t)) return;
    await query(
      `SELECT fn_model_stage_version('newmod','ccb','deepseek',NULL,200000,'${CAPABILITY}'::jsonb,1,NULL)`,
    );
    await query("SELECT fn_model_alias_set('newmod-latest','newmod')");
    await query("SELECT fn_model_drop_staged('newmod')");
    assert.deepEqual(await statesOf("newmod"), []);
    const a = await query("SELECT 1 FROM model_aliases WHERE alias='newmod-latest'");
    assert.equal(a.rows.length, 0, "指向被删 staged 行的 alias 必须一并消失(FK 现在是 RESTRICT)");
  });

  test("entry + 乐观锁变体(admin catalog API 的形状:割接后 modelCatalogOps 换用它们)", async (t) => {
    if (skipIfNoPg(t)) return;
    const staged = await query<{ entry_id: string }>(
      `SELECT fn_model_stage_version('newmod','ccb','deepseek',NULL,200000,'${CAPABILITY}'::jsonb,1,NULL)::text AS entry_id`,
    );
    const entryId = staged.rows[0].entry_id;
    const lock = await query<{ lock_version: number }>(
      "SELECT lock_version FROM model_catalog WHERE entry_id=$1::bigint",
      [entryId],
    );

    await assert.rejects(
      () => query("SELECT fn_model_activate_entry($1::bigint, 999, NULL)", [entryId]),
      /lock_version mismatch/i,
      "乐观锁不符 → 拒(与 admin 现有的 409 语义一致)",
    );

    await query("SELECT fn_model_activate_entry($1::bigint, $2::int, NULL)", [
      entryId,
      lock.rows[0].lock_version,
    ]);
    assert.equal((await statesOf("newmod"))[0].state, "active");

    const lock2 = await query<{ lock_version: number }>(
      "SELECT lock_version FROM model_catalog WHERE entry_id=$1::bigint",
      [entryId],
    );
    await query("SELECT fn_model_disable_entry($1::bigint, $2::int, NULL)", [
      entryId,
      lock2.rows[0].lock_version,
    ]);
    assert.equal((await statesOf("newmod"))[0].state, "disabled");

    await assert.rejects(
      () => query("SELECT fn_model_disable_entry($1::bigint, NULL, NULL)", [entryId]),
      /only active can be disabled/i,
    );
  });

  test("alias 不可指向 disabled/retired 行", async (t) => {
    if (skipIfNoPg(t)) return;
    await query("UPDATE model_catalog SET state='disabled' WHERE model_id='glm-5.2'");
    await assert.rejects(
      () => query("SELECT fn_model_alias_set('glm-latest','glm-5.2')"),
      /has no staged\/active version/i,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑤ 权限边界(真实受限角色连库)
// ═══════════════════════════════════════════════════════════════════════════

describe("0136 ⑤ 应用角色权限边界(割接后形态)", () => {
  /** 期望受限角色执行 SQL 被权限拒绝。 */
  async function expectDenied(sql: string, params: unknown[] = []): Promise<void> {
    assert.ok(appPool);
    await assert.rejects(
      () => appPool!.query(sql, params as unknown[]),
      (err: Error) => {
        assert.match(err.message, /permission denied/i, `expected permission denied for: ${sql}`);
        return true;
      },
      `expected permission denied: ${sql}`,
    );
  }

  test("catalog / aliases / epoch:零表级 DML(INSERT/UPDATE/DELETE/TRUNCATE 全 permission denied)", async (t) => {
    if (skipIfNoPg(t)) return;
    await expectDenied(
      `INSERT INTO model_catalog (model_id, engine, provider_id, capability_profile, state)
       VALUES ('app-evil','ccb','deepseek','${CAPABILITY}','staged')`,
    );
    await expectDenied("UPDATE model_catalog SET state='active' WHERE model_id='gpt-5.5'");
    await expectDenied("DELETE FROM model_catalog WHERE model_id='glm-5.2'");
    await expectDenied("TRUNCATE model_catalog");
    await expectDenied("INSERT INTO model_aliases (alias, entry_id) VALUES ('x', 1)");
    await expectDenied("DELETE FROM model_aliases");
    await expectDenied("UPDATE model_security_epoch SET epoch = epoch + 1 WHERE id");
  });

  test("内部 DEFINER 过程不可直接调(否则等于把 owner 权限白送)", async (t) => {
    if (skipIfNoPg(t)) return;
    await expectDenied("SELECT fn_model_catalog_apply_enabled('gpt-5.5', TRUE, NULL)");
    await expectDenied("SELECT fn_model_security_epoch_bump()");
    await expectDenied("SELECT fn_model_catalog_retire_all('glm-5.2', NULL)");
    await expectDenied("SELECT fn_model_catalog_ensure_for_pricing('x', TRUE, NULL)");
  });

  test("SELECT 可用(快照加载 / epoch fence 是应用的唯一 catalog 读路径)", async (t) => {
    if (skipIfNoPg(t)) return;
    assert.ok(appPool);
    const c = await appPool.query("SELECT count(*)::int AS n FROM model_catalog");
    assert.ok((c.rows[0] as { n: number }).n > 0);
    const e = await appPool.query("SELECT epoch FROM model_security_epoch");
    assert.equal(e.rows.length, 1);
    await appPool.query("SELECT alias FROM model_aliases");
  });

  test("既有业务写照常:model_pricing.enabled → 状态机 + epoch bump(admin PATCH 的真实路径)", async (t) => {
    if (skipIfNoPg(t)) return;
    assert.ok(appPool);
    const e0 = await epochNow();
    await appPool.query("UPDATE model_pricing SET enabled=false WHERE model_id='glm-5.2'");
    assert.equal((await statesOf("glm-5.2"))[0].state, "disabled", "写 pricing 镜像列 → 路由到 catalog 状态机");
    assert.ok((await epochNow()) > e0, "安全写 → epoch bump(经 DEFINER trigger,受限角色也能触发)");

    // admin/pricing.ts 的真实形状:SELECT FOR UPDATE + UPDATE ... RETURNING
    const out = await appPool.query<{ enabled: boolean }>(
      `UPDATE model_pricing SET multiplier=$1, lock_version=lock_version+1, updated_at=NOW()
        WHERE model_id='glm-5.2' RETURNING enabled`,
      ["3.000"],
    );
    assert.equal(out.rows[0].enabled, false, "RETURNING 反映权威后态");
  });

  test("grants CRUD 照常(admin/modelGrants.ts 的真实路径)→ 撤权 bump epoch", async (t) => {
    if (skipIfNoPg(t)) return;
    assert.ok(appPool);
    await appPool.query(
      "INSERT INTO model_visibility_grants (user_id, model_id) VALUES ($1::bigint,'gpt-5.5')",
      [testUserId],
    );
    const e1 = await epochNow();
    await appPool.query("DELETE FROM model_visibility_grants WHERE user_id=$1::bigint", [testUserId]);
    assert.ok((await epochNow()) > e1, "受限角色撤权同样 bump epoch");
  });

  test("受控状态机过程可用(应用角色的唯一 catalog 写入口)", async (t) => {
    if (skipIfNoPg(t)) return;
    assert.ok(appPool);
    await appPool.query(
      `SELECT fn_model_stage_version('app-mod','ccb','deepseek',NULL,200000,'${CAPABILITY}'::jsonb,1,NULL)`,
    );
    assert.equal((await statesOf("app-mod"))[0].state, "staged");
    await appPool.query("SELECT fn_model_activate('app-mod')");
    assert.equal((await statesOf("app-mod"))[0].state, "active");
    await appPool.query("SELECT fn_model_disable('app-mod')");
    await appPool.query("SELECT fn_model_alias_set('app-alias','glm-5.2')");
    await appPool.query("SELECT fn_model_alias_remove('app-alias')");
    // 过程内部照样受 trigger 约束(状态机不因 DEFINER 而放宽)
    await assert.rejects(
      () =>
        appPool!.query(
          `SELECT fn_model_stage_version('glm-5.2','codex','codex',NULL,NULL,'${CAPABILITY}'::jsonb,1,NULL)`,
        ),
      /already has a active version/i,
    );
  });
});
