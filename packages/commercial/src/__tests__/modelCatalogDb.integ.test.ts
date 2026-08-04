import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import {
  CODEX_ENGINE_MODELS,
  findRouteProviderForModel,
  isCodexEngineModel,
  modelReasoningPolicy,
} from "@openclaude/protocol";
import { createPool, closePool, setPoolOverride, resetPool, getPool } from "../db/index.js";
import { query, tx } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { loadCatalogSnapshot } from "../billing/modelCatalog.js";
import { PricingCache } from "../billing/pricing.js";
import { resetTestSchemaForTest } from "./helpers/db.js";

/**
 * 模型权威批次 · 切片 1 — DB 层集成测试(真实 PG)。
 *
 * 覆盖(方案 §8 单测清单的 DB 面):
 *   ① 回填 == protocol 常量(逐模型等价,一致性锚)
 *   ② 状态机 trigger 矩阵:合法/非法转移、retired 单向、active execution 字段不可变、
 *      被 alias 引用禁退休、alias 只可指向 staged/active
 *   ③ 安全敏感写自动 bump epoch;展示面写不 bump;同事务只 bump 一次
 *   ④ 版本切换存储过程(engine 变更:旧 retire + 新 active + alias 重指,单事务)
 *   ⑤ **兼容地板**:既有代码的读写 SQL 一字不改照跑(ON CONFLICT / FOR UPDATE / RETURNING /
 *      enabled 读写),且 enabled 恒等于 catalog.state='active'
 *   ⑥ PricingCache.enabled 走 catalog 权威(不读镜像列)
 *
 * fixture:与 migrate_full.integ 同一 PG(见 packages/commercial/README.md)。
 */

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";

const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

let pgAvailable = false;

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
  await resetTestSchemaForTest();
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
  // 全量迁移一次(含 0143),把"刚回填完"的 catalog/pricing 存成 fixture 快照,
  // 每个用例从该快照原样还原(状态机是单向的,不能靠 UPDATE 复位 —— retired 行不可逆)。
  await dropSchema();
  await runMigrations();
  await query("CREATE TABLE _fx_catalog AS TABLE model_catalog");
  await query("CREATE TABLE _fx_pricing AS TABLE model_pricing");
});

after(async () => {
  if (!pgAvailable) return;
  try {
    await dropSchema();
  } catch {
    /* ignore */
  }
  await closePool();
  await resetPool();
});

/**
 * 每个用例从回填态开始。还原必须**绕过 trigger**(状态机单向:retired 不可复活;
 * 且还原本身不是安全事件,不该 bump epoch)—— 用 tx 内 `SET LOCAL session_replication_role
 * = replica`(COMMIT 时自动恢复 origin,且必须与后续语句同一 client → 走 tx() 而非 query())。
 */
beforeEach(async () => {
  if (!pgAvailable) return;
  await tx(async (c) => {
    await c.query("SET LOCAL session_replication_role = replica");
    await c.query("DELETE FROM model_aliases");
    await c.query("DELETE FROM model_catalog");
    await c.query("DELETE FROM model_pricing");
    await c.query("INSERT INTO model_pricing SELECT * FROM _fx_pricing");
    await c.query("INSERT INTO model_catalog SELECT * FROM _fx_catalog");
    await c.query(
      "SELECT setval('model_catalog_entry_id_seq', (SELECT MAX(entry_id) FROM model_catalog))",
    );
    await c.query("UPDATE model_security_epoch SET epoch = 1 WHERE id");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ① 回填 == protocol 常量(一致性锚)
// ─────────────────────────────────────────────────────────────────────────

/**
 * per-model context window 的期望值。权威 = CCB
 * claude-code-best/src/utils/model/staticKeyModels.ts STATIC_MODEL_CONTEXT_WINDOW
 * + context.ts MODEL_CONTEXT_WINDOW_DEFAULT(200_000);CCB 非 workspace 成员无法 import,
 * 故在此镜像。**改 CCB 那张表必须同步这里**(本断言就是漂移守卫)。
 * codex 型号:平台无 context window 常量 → NULL(不臆造)。
 */
function expectedContextWindow(modelId: string): number | null {
  if (modelId === "qwen3.8-max") return 983_616;
  if (isCodexEngineModel(modelId)) return null;
  const m = modelId.trim().toLowerCase();
  if (m === "minimax-m3") return 512_000;
  if (m === "deepseek-v4-flash" || m === "deepseek-v4-pro") return 1_000_000;
  if (m === "glm-5.2") return 1_000_000;
  if (m === "glm-5.1") return 200_000;
  if (m === "qwen3.7-max" || m === "qwen3.7-plus") return 1_000_000;
  if (m === "kimi-k2.7-code") return 256_000;
  if (m === "kimi-k3" || m === "kimi-k3-ark") return 1_048_576;
  return 200_000;
}

describe("0143 回填 + 后续 catalog engine 迁移", () => {
  test("每个 model_pricing 行都有唯一 live catalog 行，静态基线与 protocol 等价、显式 engine 迁移匹配 catalog 终态", async (t) => {
    if (skipIfNoPg(t)) return;

    const rows = await query<{
      model_id: string;
      engine: string;
      provider_id: string | null;
      upstream_model_id: string | null;
      context_window: number | null;
      capability_profile: {
        supports_vision: boolean;
        reasoning: { supported: string[]; codex_model_default: string | null };
      };
      capability_schema_version: number;
      state: string;
      enabled: boolean;
    }>(
      `SELECT c.model_id, c.engine, c.provider_id, c.upstream_model_id, c.context_window,
              c.capability_profile, c.capability_schema_version, c.state, p.enabled
         FROM model_catalog c JOIN model_pricing p USING (model_id)
        WHERE c.state IN ('staged', 'active', 'disabled')`,
    );
    assert.ok(rows.rows.length >= 14, `expected the seeded model set, got ${rows.rows.length}`);

    for (const r of rows.rows) {
      const id = r.model_id;
      // 0199 有意只通过签名 catalog authority 把正式 qwen3.8-max 切到 Codex；
      // baked registry 保持 0197 回退地板语义，不成为第二执行权威。
      const catalogSwitchedQwen = id === "qwen3.8-max";
      const codex = isCodexEngineModel(id) || catalogSwitchedQwen;
      const provider = findRouteProviderForModel(id);
      const policy = modelReasoningPolicy(id);

      // engine:与 protocol isCodexEngineModel 精确一致
      assert.equal(r.engine, codex ? "codex" : "ccb", `${id}: engine`);

      // provider_id:静态 provider 归属 / codex 虚拟条目 / anthropic OAuth 池
      const expectedProvider = codex ? "codex" : (provider?.id ?? "anthropic");
      assert.equal(r.provider_id, expectedProvider, `${id}: provider_id`);
      // engine='ccb' → provider_id 必非空(DB CHECK 的语义复核)
      if (r.engine === "ccb") assert.ok(r.provider_id, `${id}: ccb must carry provider_id`);

      // Ark K3 uses the platform alias kimi-k3-ark for pricing and rewrites only upstream.
      assert.equal(
        r.upstream_model_id,
        id === "kimi-k3-ark" ? "kimi-k3" : (catalogSwitchedQwen ? "qwen3.8-max" : null),
        `${id}: upstream_model_id`,
      );

      // context_window
      assert.equal(r.context_window, expectedContextWindow(id), `${id}: context_window`);

      // Luna's later verified version enables vision; other live rows mirror the provider registry.
      assert.equal(
        r.capability_profile.supports_vision,
        id === "gpt-5.6-luna" || catalogSwitchedQwen
          ? true
          : (provider?.supportsVision ?? false),
        `${id}: supports_vision`,
      );

      // capability_profile.reasoning == protocol modelReasoningPolicy(id)
      assert.deepEqual(
        r.capability_profile.reasoning.supported,
        catalogSwitchedQwen ? ["low", "medium", "xhigh"] : [...policy.supported],
        `${id}: reasoning.supported`,
      );
      assert.equal(
        r.capability_profile.reasoning.codex_model_default,
        catalogSwitchedQwen ? "xhigh" : policy.codexModelDefault,
        `${id}: codex_model_default`,
      );

      assert.equal(r.capability_schema_version, 1, `${id}: capability_schema_version`);

      // state 与 enabled 等价(active ⇔ enabled)
      assert.equal(r.state === "active", r.enabled, `${id}: state/enabled equivalence`);
    }
  });

  test("codex 三型号的默认思考深度回填正确(Sol/Terra=xhigh, Luna=medium)", async (t) => {
    if (skipIfNoPg(t)) return;
    for (const m of CODEX_ENGINE_MODELS) {
      const r = await query<{ def: string | null; engine: string }>(
        `SELECT capability_profile->'reasoning'->>'codex_model_default' AS def, engine
           FROM model_catalog WHERE model_id = $1 AND state = 'active'`,
        [m.id],
      );
      assert.equal(r.rows.length, 1, `${m.id} must exist in catalog`);
      assert.equal(r.rows[0].engine, "codex");
      assert.equal(r.rows[0].def, m.defaultReasoningEffort, `${m.id}: default effort`);
    }
  });

  test("基线 epoch = 1", async (t) => {
    if (skipIfNoPg(t)) return;
    const r = await query<{ epoch: string }>("SELECT epoch::text AS epoch FROM model_security_epoch");
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].epoch, "1");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ② 状态机 trigger 矩阵
// ─────────────────────────────────────────────────────────────────────────

async function stateOf(modelId: string): Promise<string[]> {
  const r = await query<{ state: string }>(
    "SELECT state FROM model_catalog WHERE model_id = $1 ORDER BY entry_id",
    [modelId],
  );
  return r.rows.map((x) => x.state);
}

async function epoch(): Promise<bigint> {
  const r = await query<{ epoch: string }>("SELECT epoch::text AS epoch FROM model_security_epoch");
  return BigInt(r.rows[0].epoch);
}

describe("0143 状态机 trigger", () => {
  test("合法转移:active→disabled→active→disabled→retired", async (t) => {
    if (skipIfNoPg(t)) return;
    await query("UPDATE model_catalog SET state='disabled' WHERE model_id='glm-5.1'");
    assert.deepEqual(await stateOf("glm-5.1"), ["disabled"]);
    await query("UPDATE model_catalog SET state='active' WHERE model_id='glm-5.1'");
    assert.deepEqual(await stateOf("glm-5.1"), ["active"]);
    await query("UPDATE model_catalog SET state='disabled' WHERE model_id='glm-5.1'");
    await query("UPDATE model_catalog SET state='retired' WHERE model_id='glm-5.1'");
    assert.deepEqual(await stateOf("glm-5.1"), ["retired"]);
  });

  test("非法转移全拒:active→retired / active→staged / disabled→staged / staged 直接跳过校验", async (t) => {
    if (skipIfNoPg(t)) return;
    await assert.rejects(
      () => query("UPDATE model_catalog SET state='retired' WHERE model_id='glm-5.1'"),
      /illegal state transition active→retired/,
    );
    await assert.rejects(
      () => query("UPDATE model_catalog SET state='staged' WHERE model_id='glm-5.1'"),
      /illegal state transition active→staged/,
    );
    await query("UPDATE model_catalog SET state='disabled' WHERE model_id='glm-5.1'");
    await assert.rejects(
      () => query("UPDATE model_catalog SET state='staged' WHERE model_id='glm-5.1'"),
      /illegal state transition disabled→staged/,
    );
  });

  test("retired 单向终态:任何后续修改都拒(含审计列)", async (t) => {
    if (skipIfNoPg(t)) return;
    await query("UPDATE model_catalog SET state='disabled' WHERE model_id='glm-5.1'");
    await query("UPDATE model_catalog SET state='retired' WHERE model_id='glm-5.1'");
    await assert.rejects(
      () => query("UPDATE model_catalog SET state='active' WHERE model_id='glm-5.1'"),
      /retired entry .* is immutable/,
    );
    await assert.rejects(
      () => query("UPDATE model_catalog SET updated_by=1 WHERE model_id='glm-5.1'"),
      /retired entry .* is immutable/,
    );
  });

  // 0144 收紧:新行**只能生于 staged**(0143 允许直插 active/disabled,只拒 retired)。
  // 边界矩阵与权限层的完整覆盖在 modelAuthorityDbGuards.integ.test.ts。
  test("新行只能生于 staged(retired/active/disabled 直插全拒;0144)", async (t) => {
    if (skipIfNoPg(t)) return;
    for (const state of ["retired", "active", "disabled"]) {
      await assert.rejects(
        () =>
          query(
            `INSERT INTO model_catalog(model_id, engine, provider_id, capability_profile, state)
             VALUES ('zzz-new','ccb','ark','{}'::jsonb,'${state}')`,
          ),
        /must be born in staged state/,
        `直插 ${state} 必须被拒`,
      );
    }
  });

  test("execution 字段:active **与 disabled** 都不可变,只有 staged 可编辑(0144 收紧)", async (t) => {
    if (skipIfNoPg(t)) return;
    const mutations: Array<[string, RegExp]> = [
      ["engine='codex', provider_id='codex'", /execution fields of a active entry are immutable/],
      ["provider_id='deepseek'", /immutable/],
      ["upstream_model_id='glm-5.2-0712'", /immutable/],
      ["context_window=123456", /immutable/],
      [`capability_profile='{"supports_vision": true, "reasoning": {"supported": [], "codex_model_default": null}}'::jsonb`, /immutable/],
      ["capability_schema_version=2", /immutable/],
      ["model_id='glm-5.2-renamed'", /immutable/],
    ];
    for (const [set, re] of mutations) {
      await assert.rejects(
        () => query(`UPDATE model_catalog SET ${set} WHERE model_id='glm-5.1'`),
        re,
        `mutation should be rejected: ${set}`,
      );
    }
    // 0144:**disabled 行也冻结**。0143 允许原地改写 disabled 行再 disabled→active,
    // 同一 entry_id 的执行语义被静默篡改(历史不再是历史,usage_records 的
    // execution_revision 归因失效)。改执行语义必须产生新版本(fn_model_switch_version)。
    await query("UPDATE model_catalog SET state='disabled' WHERE model_id='glm-5.1'");
    await assert.rejects(
      () => query("UPDATE model_catalog SET context_window=123456 WHERE model_id='glm-5.1'"),
      /execution fields of a disabled entry are immutable/,
    );
    // staged 行是唯一的编辑面
    await query(
      `INSERT INTO model_catalog(model_id, engine, provider_id, capability_profile, state)
       VALUES ('zzz-staged','ccb','ark','{"supports_vision":false,"reasoning":{"supported":[],"codex_model_default":null}}'::jsonb,'staged')`,
    );
    await query("UPDATE model_catalog SET context_window=123456 WHERE model_id='zzz-staged'");
    const r = await query<{ context_window: number }>(
      "SELECT context_window FROM model_catalog WHERE model_id='zzz-staged'",
    );
    assert.equal(r.rows[0].context_window, 123456);
  });

  test("部分唯一索引:同 model_id 在 staged∪active 中至多一行", async (t) => {
    if (skipIfNoPg(t)) return;
    await assert.rejects(
      () =>
        query(
          `INSERT INTO model_catalog(model_id, engine, provider_id, capability_profile, state)
           VALUES ('glm-5.2','ccb','ark','{}'::jsonb,'staged')`,
        ),
      /uq_model_catalog_live/,
    );
  });

  test("engine='ccb' 必须带 provider_id(CHECK)", async (t) => {
    if (skipIfNoPg(t)) return;
    await assert.rejects(
      () =>
        query(
          `INSERT INTO model_catalog(model_id, engine, provider_id, capability_profile, state)
           VALUES ('zzz-noprov','ccb',NULL,'{}'::jsonb,'staged')`,
        ),
      /model_catalog_ccb_needs_provider/,
    );
    // codex 行允许 provider_id NULL
    await query(
      `INSERT INTO model_catalog(model_id, engine, provider_id, capability_profile, state)
       VALUES ('zzz-codex','codex',NULL,'{}'::jsonb,'staged')`,
    );
  });
});

describe("0143 alias trigger", () => {
  async function activeEntryId(modelId: string): Promise<number> {
    const r = await query<{ entry_id: string }>(
      "SELECT entry_id::text AS entry_id FROM model_catalog WHERE model_id=$1 AND state='active'",
      [modelId],
    );
    return Number(r.rows[0].entry_id);
  }

  test("alias 可指向 active/staged;不可指向 disabled/retired", async (t) => {
    if (skipIfNoPg(t)) return;
    const glm = await activeEntryId("glm-5.1");
    await query("INSERT INTO model_aliases(alias, entry_id) VALUES ('glm-latest', $1)", [glm]);

    await query("UPDATE model_catalog SET state='disabled' WHERE model_id='glm-5.1'");
    const disabled = await query<{ entry_id: string }>(
      "SELECT entry_id::text AS entry_id FROM model_catalog WHERE model_id='glm-5.1'",
    );
    await assert.rejects(
      () =>
        query("INSERT INTO model_aliases(alias, entry_id) VALUES ('glm51-alias', $1)", [
          Number(disabled.rows[0].entry_id),
        ]),
      /may only point at a staged\/active entry/,
    );
  });

  test("alias 不得与 live canonical model_id 撞名", async (t) => {
    if (skipIfNoPg(t)) return;
    const glm = await activeEntryId("glm-5.2");
    await assert.rejects(
      () => query("INSERT INTO model_aliases(alias, entry_id) VALUES ('glm-5.1', $1)", [glm]),
      /collides with a live canonical model_id/,
    );
  });

  test("被 alias 引用的行禁止 retire;但允许 disable(disable 不需要先删 alias)", async (t) => {
    if (skipIfNoPg(t)) return;
    const glm = await activeEntryId("glm-5.1");
    await query("INSERT INTO model_aliases(alias, entry_id) VALUES ('glm-latest', $1)", [glm]);

    await query("UPDATE model_catalog SET state='disabled' WHERE entry_id=$1", [glm]); // 允许
    await assert.rejects(
      () => query("UPDATE model_catalog SET state='retired' WHERE entry_id=$1", [glm]),
      /referenced by alias\(es\); repoint them before retiring/,
    );
  });

  test("alias 变更 bump epoch", async (t) => {
    if (skipIfNoPg(t)) return;
    const glm = await activeEntryId("glm-5.2");
    const before = await epoch();
    await query("INSERT INTO model_aliases(alias, entry_id) VALUES ('glm-latest', $1)", [glm]);
    const afterInsert = await epoch();
    assert.equal(afterInsert, before + 1n);
    await query("DELETE FROM model_aliases WHERE alias='glm-latest'");
    assert.equal(await epoch(), afterInsert + 1n);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ③ epoch bump 语义
// ─────────────────────────────────────────────────────────────────────────

describe("0143 security epoch", () => {
  test("state 离开 active → bump", async (t) => {
    if (skipIfNoPg(t)) return;
    const before = await epoch();
    await query("UPDATE model_catalog SET state='disabled' WHERE model_id='glm-5.1'");
    assert.equal(await epoch(), before + 1n);
  });

  test("价格 / multiplier / visibility / default_effort 变更 → bump", async (t) => {
    if (skipIfNoPg(t)) return;
    for (const sql of [
      "UPDATE model_pricing SET input_per_mtok = input_per_mtok + 1 WHERE model_id='glm-5.2'",
      "UPDATE model_pricing SET multiplier = 3.000 WHERE model_id='glm-5.2'",
      "UPDATE model_pricing SET visibility = 'hidden' WHERE model_id='glm-5.2'",
      "UPDATE model_pricing SET default_effort = 'max' WHERE model_id='glm-5.2'",
    ]) {
      const before = await epoch();
      await query(sql);
      assert.equal(await epoch(), before + 1n, `should bump: ${sql}`);
    }
  });

  test("纯展示面变更(display_name / sort_order / extra_system_prompt)→ 不 bump(不打断在途 turn)", async (t) => {
    if (skipIfNoPg(t)) return;
    const before = await epoch();
    await query(
      "UPDATE model_pricing SET display_name='X', sort_order=7, extra_system_prompt='hi' WHERE model_id='glm-5.2'",
    );
    assert.equal(await epoch(), before, "display-only change must not bump epoch");
  });

  test("同一事务内多次安全写 → 只 bump 一次(epoch 是 fence,不是计数器)", async (t) => {
    if (skipIfNoPg(t)) return;
    const before = await epoch();
    await tx(async (c) => {
      await c.query("UPDATE model_pricing SET multiplier=3.000 WHERE model_id IN ('glm-5.2','glm-5.1','MiniMax-M3')");
      await c.query("UPDATE model_catalog SET state='disabled' WHERE model_id='glm-5.1'");
    });
    assert.equal(await epoch(), before + 1n);
  });

  // 0144:epoch 表加 guard —— 只接受 fn_model_security_epoch_bump 的 +1 写。
  // (0143 只有 CHECK(epoch >= 1):`SET epoch = 1` 这种**回退**是合法的,而回退会让
  //  所有陈旧快照重新通过 fence = fence 机制被直接旁路。)
  test("epoch 单调:回退/清零/跳变全拒(0144)", async (t) => {
    if (skipIfNoPg(t)) return;
    await assert.rejects(
      () => query("UPDATE model_security_epoch SET epoch = 0 WHERE id"),
      /advance by exactly 1/,
    );
    await query("UPDATE model_pricing SET multiplier=9.000 WHERE model_id='glm-5.2'"); // 抬到 2
    await assert.rejects(
      () => query("UPDATE model_security_epoch SET epoch = 1 WHERE id"),
      /advance by exactly 1/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ④ 版本切换存储过程(R3-M8)
// ─────────────────────────────────────────────────────────────────────────

describe("0143 fn_model_switch_version", () => {
  test("engine 变更:旧行 retired + 新行 active + alias 重指 + 可用性不变 + epoch bump 一次", async (t) => {
    if (skipIfNoPg(t)) return;
    const old = await query<{ entry_id: string }>(
      "SELECT entry_id::text AS entry_id FROM model_catalog WHERE model_id='glm-5.2' AND state='active'",
    );
    const oldId = Number(old.rows[0].entry_id);
    await query("INSERT INTO model_aliases(alias, entry_id) VALUES ('glm-latest', $1)", [oldId]);
    const before = await epoch();

    const r = await query<{ new_entry: string }>(
      `SELECT fn_model_switch_version('glm-5.2','codex','codex',NULL,NULL,
         '{"supports_vision": false, "reasoning": {"supported": ["low","medium","high","xhigh","max"], "codex_model_default": "high"}}'::jsonb,
         1, NULL, 0)::text AS new_entry`,
    );
    const newId = Number(r.rows[0].new_entry);
    assert.notEqual(newId, oldId);

    // ORDER BY 必须限定表名:输出列 `entry_id` 是 text 转换,裸 ORDER BY entry_id 会按
    // **文本**排序('15' < '6'),排出错误顺序(PG 的 output-column-name 优先规则)。
    const rows = await query<{ eid: string; state: string; engine: string }>(
      `SELECT entry_id::text AS eid, state, engine
         FROM model_catalog WHERE model_id='glm-5.2' ORDER BY model_catalog.entry_id`,
    );
    assert.deepEqual(
      rows.rows.map((x) => [Number(x.eid), x.state, x.engine]),
      [
        [oldId, "retired", "ccb"],
        [newId, "active", "codex"],
      ],
    );

    const alias = await query<{ entry_id: string }>(
      "SELECT entry_id::text AS entry_id FROM model_aliases WHERE alias='glm-latest'",
    );
    assert.equal(Number(alias.rows[0].entry_id), newId, "alias must be repointed to the new entry");

    const mirror = await query<{ enabled: boolean }>(
      "SELECT enabled FROM model_pricing WHERE model_id='glm-5.2'",
    );
    assert.equal(mirror.rows[0].enabled, true, "switching an active model keeps it available");
    assert.equal(await epoch(), before + 1n, "one tx = one bump");
  });

  test("切换 disabled 模型:新行停在 staged,不擅自开启可用性", async (t) => {
    if (skipIfNoPg(t)) return;
    await query(
      `SELECT fn_model_switch_version('gpt-5.5','codex','codex',NULL,NULL,
         '{"supports_vision": false, "reasoning": {"supported": [], "codex_model_default": null}}'::jsonb, 1, NULL, 0)`,
    );
    assert.deepEqual(await stateOf("gpt-5.5"), ["retired", "staged"]);
    const mirror = await query<{ enabled: boolean }>(
      "SELECT enabled FROM model_pricing WHERE model_id='gpt-5.5'",
    );
    assert.equal(mirror.rows[0].enabled, false);
  });

  test("已有 staged 版本时再切 → 拒(禁止多请求手工拼装)", async (t) => {
    if (skipIfNoPg(t)) return;
    await query(
      `SELECT fn_model_switch_version('gpt-5.5','codex','codex',NULL,NULL,'{"supports_vision": false, "reasoning": {"supported": [], "codex_model_default": null}}'::jsonb, 1, NULL, 0)`,
    );
    await assert.rejects(
      () =>
        query(
          `SELECT fn_model_switch_version('gpt-5.5','ccb','deepseek',NULL,200000,'{"supports_vision": false, "reasoning": {"supported": [], "codex_model_default": null}}'::jsonb, 1, NULL, 0)`,
        ),
      /already has a pending staged version/,
    );
  });

  test("未知模型 → 拒", async (t) => {
    if (skipIfNoPg(t)) return;
    await assert.rejects(
      () =>
        query(
          `SELECT fn_model_switch_version('nope','ccb','ark',NULL,1,'{"supports_vision": false, "reasoning": {"supported": [], "codex_model_default": null}}'::jsonb, 1, NULL, 0)`,
        ),
      /no live entry for model/,
    );
  });

  test("中间态不外泄:整个切换在调用方事务内(回滚 → 目录零变化)", async (t) => {
    if (skipIfNoPg(t)) return;
    const before = await stateOf("glm-5.2");
    await assert.rejects(
      () =>
        tx(async (c) => {
          await c.query(
            `SELECT fn_model_switch_version('glm-5.2','codex','codex',NULL,NULL,'{"supports_vision": false, "reasoning": {"supported": [], "codex_model_default": null}}'::jsonb, 1, NULL, 0)`,
          );
          throw new Error("boom");
        }),
      /boom/,
    );
    assert.deepEqual(await stateOf("glm-5.2"), before, "rolled back switch must leave no trace");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ⑤ 兼容地板:既有代码 SQL 一字不改照跑
// ─────────────────────────────────────────────────────────────────────────

describe("0143 兼容地板(旧 master 回滚后的读写路径)", () => {
  async function enabledOf(modelId: string): Promise<boolean> {
    const r = await query<{ enabled: boolean }>("SELECT enabled FROM model_pricing WHERE model_id=$1", [modelId]);
    return r.rows[0].enabled;
  }
  async function catalogState(modelId: string): Promise<string | undefined> {
    const r = await query<{ state: string }>(
      "SELECT state FROM model_catalog WHERE model_id=$1 AND state IN ('staged','active','disabled')",
      [modelId],
    );
    return r.rows[0]?.state;
  }

  test("legacy `UPDATE model_pricing SET enabled=...` → 路由到 catalog 状态机", async (t) => {
    if (skipIfNoPg(t)) return;
    await query("UPDATE model_pricing SET enabled=false WHERE model_id='qwen3.7-max'");
    assert.equal(await catalogState("qwen3.7-max"), "disabled");
    assert.equal(await enabledOf("qwen3.7-max"), false);

    await query("UPDATE model_pricing SET enabled=true WHERE model_id='qwen3.7-max'");
    assert.equal(await catalogState("qwen3.7-max"), "active");
    assert.equal(await enabledOf("qwen3.7-max"), true);
  });

  test("catalog 状态机写 → enabled 镜像同步(反向)", async (t) => {
    if (skipIfNoPg(t)) return;
    await query("UPDATE model_catalog SET state='disabled' WHERE model_id='glm-5.1'");
    assert.equal(await enabledOf("glm-5.1"), false);
    await query("UPDATE model_catalog SET state='active' WHERE model_id='glm-5.1'");
    assert.equal(await enabledOf("glm-5.1"), true);
  });

  test("INSERT ... ON CONFLICT DO UPDATE(adminPricing.integ / 历史 seed 迁移的写法)照跑", async (t) => {
    if (skipIfNoPg(t)) return;
    await query(
      `INSERT INTO model_pricing(
         model_id, display_name, input_per_mtok, output_per_mtok,
         cache_read_per_mtok, cache_write_per_mtok, multiplier, enabled, sort_order
       ) VALUES ('claude-sonnet-4-6','Claude Sonnet 4.6',300,1500,30,375,2.0,TRUE,100)
       ON CONFLICT (model_id) DO UPDATE SET
         multiplier = EXCLUDED.multiplier, enabled = EXCLUDED.enabled, updated_by = NULL`,
    );
    assert.equal(await enabledOf("claude-sonnet-4-6"), true);
    assert.equal(await catalogState("claude-sonnet-4-6"), "active");
  });

  test("INSERT 新模型(catalog 无行)→ 按 protocol 派生建 catalog 行", async (t) => {
    if (skipIfNoPg(t)) return;
    await query(
      `INSERT INTO model_pricing(model_id, display_name, input_per_mtok, output_per_mtok,
         cache_read_per_mtok, cache_write_per_mtok, multiplier, enabled, sort_order)
       VALUES ('deepseek-v9-test','DS9',1,1,1,1,1.0,TRUE,199)`,
    );
    const r = await query<{ engine: string; provider_id: string; state: string; context_window: number }>(
      "SELECT engine, provider_id, state, context_window FROM model_catalog WHERE model_id='deepseek-v9-test'",
    );
    assert.equal(r.rows[0].engine, "ccb");
    assert.equal(r.rows[0].provider_id, "deepseek", "deepseek- 前缀家族(与 protocol matchesRoute 同口径)");
    assert.equal(r.rows[0].state, "active");
    assert.equal(r.rows[0].context_window, 200_000);
    await query("DELETE FROM model_pricing WHERE model_id='deepseek-v9-test'");
  });

  test("admin/pricing.ts 的 SELECT ... FOR UPDATE + UPDATE ... RETURNING 形状照跑", async (t) => {
    if (skipIfNoPg(t)) return;
    const out = await tx(async (c) => {
      const before = await c.query<{ lock_version: number; enabled: boolean }>(
        "SELECT model_id, enabled, lock_version FROM model_pricing WHERE model_id='glm-5.1' FOR UPDATE",
      );
      assert.equal(before.rows.length, 1);
      const after = await c.query<{ enabled: boolean; lock_version: number; multiplier: string }>(
        `UPDATE model_pricing SET multiplier=$1, enabled=$2, lock_version = lock_version + 1, updated_at = NOW()
          WHERE model_id='glm-5.1'
          RETURNING enabled, lock_version, multiplier::text AS multiplier`,
        ["3.000", false],
      );
      return { before: before.rows[0], after: after.rows[0] };
    });
    assert.equal(out.after.enabled, false, "RETURNING 必须反映权威后态");
    assert.equal(out.after.lock_version, out.before.lock_version + 1);
    assert.equal(await catalogState("glm-5.1"), "disabled");
  });

  // 0144:DELETE FROM model_pricing 从「级联物理删除 catalog 全部版本」改为**软退役**。
  //   0143 的形态:一条 `DELETE FROM model_pricing` 就能把该模型的**全部历史**(含 retired)
  //   抹掉 —— 计费行(usage_records.execution_revision)从此无从回溯。
  test("DELETE FROM model_pricing → catalog 行**软退役**(历史保留,不留孤儿 active;0144)", async (t) => {
    if (skipIfNoPg(t)) return;
    await query("DELETE FROM model_pricing WHERE model_id='glm-5.1'");
    const r = await query<{ state: string }>(
      "SELECT state FROM model_catalog WHERE model_id='glm-5.1'",
    );
    assert.equal(r.rows.length, 1, "历史行必须还在");
    assert.equal(r.rows[0].state, "retired", "不再可路由,但不物理删除");
    // 复位(下个用例的 beforeEach 只复位状态,不重建行)。重新 INSERT pricing 会派生新 entry。
    await query(
      `INSERT INTO model_pricing(model_id, display_name, input_per_mtok, output_per_mtok,
         cache_read_per_mtok, cache_write_per_mtok, multiplier, enabled, sort_order, visibility)
       VALUES ('glm-5.1','GLM 5.1',684,2880,137,0,1.000,TRUE,88,'public')`,
    );
    const revived = await query<{ state: string }>(
      "SELECT state FROM model_catalog WHERE model_id='glm-5.1' ORDER BY entry_id",
    );
    assert.deepEqual(revived.rows.map((x) => x.state), ["retired", "active"]);
  });

  test("不变量:model_pricing.enabled 恒等于 (catalog 有 active 行)", async (t) => {
    if (skipIfNoPg(t)) return;
    await query("UPDATE model_pricing SET enabled=false WHERE model_id='qwen3.7-plus'");
    await query("UPDATE model_catalog SET state='disabled' WHERE model_id='glm-5.1'");
    await query("UPDATE model_catalog SET state='active' WHERE model_id='gpt-5.5'");
    const drift = await query<{ model_id: string }>(
      `SELECT p.model_id FROM model_pricing p
        WHERE p.enabled IS DISTINCT FROM EXISTS (
          SELECT 1 FROM model_catalog c WHERE c.model_id = p.model_id AND c.state = 'active')`,
    );
    assert.deepEqual(drift.rows, [], "enabled 镜像与 catalog 权威不允许漂移");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ⑥ 消费侧:snapshot / PricingCache 都走 catalog 权威
// ─────────────────────────────────────────────────────────────────────────

describe("0143 消费侧", () => {
  test("loadCatalogSnapshot:一致快照 + revision 稳定 + epoch 随载", async (t) => {
    if (skipIfNoPg(t)) return;
    const s1 = await loadCatalogSnapshot(getPool());
    const s2 = await loadCatalogSnapshot(getPool());
    assert.equal(s1.executionRevision, s2.executionRevision, "同一 DB 状态 → 同一 revision");
    assert.equal(s1.securityEpoch, 1n);
    assert.equal(s1.isRoutable("glm-5.2"), true);
    assert.equal(s1.isCodexModel("gpt-5.6-sol"), true);
    assert.equal(s1.isRoutable("gpt-5.5"), false, "disabled 模型不可路由");
    const d = s1.resolve("gpt-5.6-sol");
    assert.equal(d?.engine, "codex");
    assert.equal(d?.capabilityProfile.reasoning.codexModelDefault, "xhigh");

    // 安全写 → epoch + revision 都变
    await query("UPDATE model_catalog SET state='disabled' WHERE model_id='glm-5.1'");
    const s3 = await loadCatalogSnapshot(getPool());
    assert.equal(s3.securityEpoch, 2n);
    assert.notEqual(s3.executionRevision, s1.executionRevision);
    assert.equal(s3.isRoutable("glm-5.1"), false);
  });

  test("PricingCache.enabled 来自 catalog 权威(镜像列被写歪也不受影响)", async (t) => {
    if (skipIfNoPg(t)) return;
    const cache = new PricingCache();
    await cache.load();
    assert.equal(cache.get("glm-5.1")?.enabled, true);

    // 绕过 trigger 直接把镜像列写歪(模拟外力/回滚事故):catalog 仍是 active。
    // 必须同一 client(session GUC),故走 tx() 而不是 pool 上的两条独立 query()。
    await tx(async (c) => {
      await c.query("SET LOCAL session_replication_role = replica");
      await c.query("UPDATE model_pricing SET enabled=false WHERE model_id='glm-5.1'");
    });
    const crooked = await query<{ enabled: boolean }>(
      "SELECT enabled FROM model_pricing WHERE model_id='glm-5.1'",
    );
    assert.equal(crooked.rows[0].enabled, false, "前提:镜像列确实被写歪了");

    await cache.load();
    assert.equal(
      cache.get("glm-5.1")?.enabled,
      true,
      "PricingCache 必须读 catalog.state,而不是被写歪的 enabled 镜像列",
    );

    // 真正的权威写 → 立刻反映
    await query("UPDATE model_catalog SET state='disabled' WHERE model_id='glm-5.1'");
    await cache.load();
    assert.equal(cache.get("glm-5.1")?.enabled, false);
  });
});
