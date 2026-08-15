import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query, tx } from "../db/queries.js";
import { runMigrations, MigrationIntegrityError } from "../db/migrate.js";
import { PricingCache } from "../billing/pricing.js";
import { resetTestSchemaForTest } from "./helpers/db.js";

/**
 * T-02 迁移系统集成测试。
 *
 * 与 db.integ 共用测试库(openclaude_test),但每个 test 前先 DROP 掉商业化相关的表,
 * 保证干净起点。库名硬要求以 `_test` 结尾 —— 防止手滑跑到生产库。
 *
 * 需要本地起 PG/Redis fixture — 见 packages/commercial/README.md。
 * CI 或 REQUIRE_TEST_DB=1 时,pg 未就绪 → 直接 fail(不 skip)。
 */

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://test:test@127.0.0.1:55432/openclaude_test";

const REQUIRE_TEST_DB =
  process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

let pgAvailable = false;

/** 所有商业化表 + schema_migrations。用 DROP ... CASCADE,顺序无所谓,
 *  但仍列全,方便未来新增迁移时保持清理同步。 */
async function cleanCommercialSchema(): Promise<void> {
  // DROP 时用 CASCADE 避免被 ON DELETE RESTRICT / INDEX 挡住。
  // 注意:不 drop 其他不相关的表(比如 db.integ 的 _db_integ_demo),
  // 但它在另一个测试进程,不会在本 pool 看到残留。
  await resetTestSchemaForTest();
}

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
    try { await p.end(); } catch { /* ignore */ }
    return false;
  }
}

before(async () => {
  pgAvailable = await probe();
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) {
      throw new Error(
        "Postgres test fixture required (CI=true or REQUIRE_TEST_DB=1). " +
          "See packages/commercial/README.md for bootstrap.",
      );
    }
    return;
  }
  // 为整个套件注入一个专用 pool;不继承 db.integ 的 pool(虽然跨文件是隔离的)。
  await resetPool();
  const pool = createPool({ connectionString: TEST_DB_URL, max: 5 });
  setPoolOverride(pool);
});

after(async () => {
  if (pgAvailable) {
    try { await cleanCommercialSchema(); } catch { /* ignore */ }
    await closePool();
  }
});

beforeEach(async () => {
  if (!pgAvailable) return;
  await cleanCommercialSchema();
});

function skipIfNoPg(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) {
    t.skip("pg not running");
    return true;
  }
  return false;
}

function testedManualRollbackSql(migrationSql: string, version: "0194" | "0195"): string {
  const start = `-- BEGIN TESTED MANUAL ROLLBACK ${version}`;
  const end = `-- END TESTED MANUAL ROLLBACK ${version}`;
  assert.ok(migrationSql.includes(start) && migrationSql.includes(end));
  const body = migrationSql.slice(
    migrationSql.indexOf(start) + start.length,
    migrationSql.indexOf(end),
  );
  return body
    .split("\n")
    .map((line) => line.replace(/^-- ?/, ""))
    .join("\n");
}

async function runBuiltInMigrationsBefore0194(): Promise<void> {
  const source = fileURLToPath(new URL("../db/migrations/", import.meta.url));
  const dir = await mkdtemp(path.join(tmpdir(), "mig-before-0194-"));
  try {
    for (const file of await readdir(source)) {
      if (file.endsWith(".sql") && file < "0194_deepseek_1m_context.sql") {
        await copyFile(path.join(source, file), path.join(dir, file));
      }
    }
    await runMigrations({ dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runBuiltInMigrationsThrough(file: string): Promise<Awaited<ReturnType<typeof runMigrations>>> {
  const source = fileURLToPath(new URL("../db/migrations/", import.meta.url));
  const dir = await mkdtemp(path.join(tmpdir(), "mig-through-"));
  try {
    for (const candidate of await readdir(source)) {
      if (candidate.endsWith(".sql") && candidate <= file) {
        await copyFile(path.join(source, candidate), path.join(dir, candidate));
      }
    }
    return await runMigrations({ dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("migrate.runMigrations", () => {
  test("empty DB → apply all built-in migrations → tables + schema_migrations rows exist", async (t) => {
    if (skipIfNoPg(t)) return;
    const r = await runMigrations();
    // 目前 built-in 迁移:0001 / 0002(按 07-TASKS T-02 范围)
    assert.ok(r.applied.length >= 2, `expected >=2 applied, got ${r.applied.length}`);
    assert.equal(r.skipped.length, 0);

    // 关键表存在(T-02 范围:users/email_verifications/refresh_tokens/model_pricing/credit_ledger/usage_records)
    const tableRows = await query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public'",
    );
    const tables = new Set(tableRows.rows.map((r) => r.table_name));
    for (const expected of [
      "users",
      "email_verifications",
      "refresh_tokens",
      "model_pricing",
      "credit_ledger",
      "usage_records",
      "media_generation_inputs",
      "media_generation_job_inputs",
      "media_generation_jobs",
      "video_project_shots",
      "video_projects",
      "prompt_queue_heads",
      "prompt_queue_items",
      "prompt_queue_item_attachments",
      "prompt_queue_mutations",
      "provider_quota_blocks",
      "schema_migrations",
    ]) {
      assert.ok(tables.has(expected), `table ${expected} missing`);
    }

    // schema_migrations 记录数量 == 实际 applied
    const cnt = await query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM schema_migrations",
    );
    assert.equal(cnt.rows[0].cnt, String(r.applied.length));

    const cursorModels = await query<{
      model_id: string;
      upstream_model_id: string | null;
      state: string;
      enabled: boolean;
      visibility: string;
    }>(
      `SELECT c.model_id, c.upstream_model_id, c.state, p.enabled, p.visibility
         FROM model_catalog c
         JOIN model_pricing p ON p.model_id = c.model_id
        WHERE c.engine = 'cursor'
        ORDER BY c.model_id`,
    );
    assert.deepEqual(cursorModels.rows, [
      { model_id: "cursor-auto", upstream_model_id: null, state: "active", enabled: true, visibility: "hidden" },
      { model_id: "cursor-composer-2.5-fast", upstream_model_id: "composer-2.5-fast", state: "active", enabled: true, visibility: "hidden" },
      { model_id: "cursor-fable-5-high", upstream_model_id: "claude-fable-5-thinking-high", state: "active", enabled: true, visibility: "hidden" },
      { model_id: "cursor-grok-4.5-high", upstream_model_id: "cursor-grok-4.5-high", state: "active", enabled: true, visibility: "hidden" },
      { model_id: "cursor-grok-4.6-high", upstream_model_id: "cursor-grok-4.6-high", state: "active", enabled: true, visibility: "hidden" },
      { model_id: "cursor-opus-5-high", upstream_model_id: "claude-opus-5-thinking-high", state: "active", enabled: true, visibility: "hidden" },
    ]);
  });

  test("0210 activates Cursor and grants only users 1/4 with append-only audit", async (t) => {
    if (skipIfNoPg(t)) return;
    await runBuiltInMigrationsThrough("0209_cursor_multimodel_shared_credential.sql");
    await query(
      `INSERT INTO users(id, email, email_verified, password_hash, role)
       VALUES
         (1, 'cursor-admin@example.com', TRUE, 'argon2$stub', 'admin'),
         (4, 'cursor-user@example.com', TRUE, 'argon2$stub', 'user')`,
    );
    await query(
      `INSERT INTO model_visibility_grants(user_id, model_id, granted_by)
       VALUES (4, 'cursor-auto', 1)`,
    );

    const applied = await runBuiltInMigrationsThrough("0210_cursor_multimodel_activation.sql");
    assert.deepEqual(applied.applied, ["0210_cursor_multimodel_activation"]);

    const grants = await query<{ user_id: string; model_id: string }>(
      `SELECT user_id::text AS user_id, model_id
         FROM model_visibility_grants
        WHERE model_id LIKE 'cursor-%'
        ORDER BY user_id, model_id`,
    );
    assert.equal(grants.rows.length, 12);
    assert.deepEqual(new Set(grants.rows.map((row) => row.user_id)), new Set(["1", "4"]));

    const audit = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM admin_audit
        WHERE action = 'model_grant.add'
          AND after->>'source' = 'migration:0210'`,
    );
    assert.equal(audit.rows[0].count, "11", "existing user4 Auto grant must not duplicate its audit");
  });

  test("running migrate again is idempotent (no duplicate inserts, no changes)", async (t) => {
    if (skipIfNoPg(t)) return;
    const r1 = await runMigrations();
    const before = r1.applied.length;
    const r2 = await runMigrations();
    assert.equal(r2.applied.length, 0, "second run should apply nothing");
    assert.equal(r2.skipped.length, before, "second run should skip all");
    const cnt = await query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM schema_migrations",
    );
    assert.equal(cnt.rows[0].cnt, String(before), "schema_migrations count unchanged");
  });

  test("0194 rollback → 0195 reactivates exact DeepSeek V4 models and both rollbacks fail closed", async (t) => {
    if (skipIfNoPg(t)) return;
    await runBuiltInMigrationsBefore0194();
    // Production pricing legitimately differs from the historical seed.  The
    // context migration must accept and preserve the current commercial values.
    await query(
      `UPDATE model_pricing
          SET input_per_mtok = CASE model_id WHEN 'deepseek-v4-flash' THEN 150 ELSE 400 END,
              output_per_mtok = CASE model_id WHEN 'deepseek-v4-flash' THEN 300 ELSE 1500 END,
              cache_read_per_mtok = CASE model_id WHEN 'deepseek-v4-flash' THEN 5 ELSE 50 END,
              sort_order = CASE model_id WHEN 'deepseek-v4-flash' THEN 120 ELSE 80 END
        WHERE model_id IN ('deepseek-v4-flash', 'deepseek-v4-pro')`,
    );
    const applied = await runBuiltInMigrationsThrough("0194_deepseek_1m_context.sql");
    assert.deepEqual(applied.applied, ["0194_deepseek_1m_context"]);

    const expectedProfile = {
      supports_vision: false,
      reasoning: {
        supported: ["low", "medium", "high", "xhigh", "max"],
        codex_model_default: null,
      },
      ccb: { capability_zero: false, supports_thinking: true },
    };
    const readCatalog = () => query<{
      entry_id: string;
      model_id: string;
      engine: string;
      provider_id: string;
      upstream_model_id: string | null;
      context_window: number;
      capability_profile: Record<string, unknown>;
      capability_schema_version: number;
      state: string;
    }>(
      `SELECT entry_id::text, model_id, engine, provider_id, upstream_model_id,
              context_window, capability_profile, capability_schema_version, state
         FROM model_catalog
        WHERE model_id IN ('deepseek-v4-flash', 'deepseek-v4-pro')
        ORDER BY model_id, entry_id`,
    );
    const pricing = await query<{
      model_id: string;
      display_name: string;
      input_per_mtok: string;
      output_per_mtok: string;
      cache_read_per_mtok: string;
      cache_write_per_mtok: string;
      multiplier: string;
      enabled: boolean;
      sort_order: number;
      visibility: string;
    }>(
      `SELECT model_id, display_name, input_per_mtok::text, output_per_mtok::text,
              cache_read_per_mtok::text, cache_write_per_mtok::text,
              multiplier::text, enabled, sort_order, visibility
         FROM model_pricing
        WHERE model_id IN ('deepseek-v4-flash', 'deepseek-v4-pro')
        ORDER BY model_id`,
    );
    assert.deepEqual(pricing.rows, [
      {
        model_id: "deepseek-v4-flash", display_name: "DeepSeek V4 Flash (1M)",
        input_per_mtok: "150", output_per_mtok: "300", cache_read_per_mtok: "5",
        cache_write_per_mtok: "0", multiplier: "1.000", enabled: true,
        sort_order: 120, visibility: "public",
      },
      {
        model_id: "deepseek-v4-pro", display_name: "DeepSeek V4 Pro (1M)",
        input_per_mtok: "400", output_per_mtok: "1500", cache_read_per_mtok: "50",
        cache_write_per_mtok: "0", multiplier: "1.000", enabled: true,
        sort_order: 80, visibility: "public",
      },
    ]);

    const migrated = await readCatalog();
    assert.equal(migrated.rows.length, 4);
    for (const modelId of ["deepseek-v4-flash", "deepseek-v4-pro"]) {
      const rows = migrated.rows.filter((row) => row.model_id === modelId);
      assert.equal(rows.length, 2);
      const retired = rows.find((row) => row.state === "retired")!;
      const active = rows.find((row) => row.state === "active")!;
      assert.equal(retired.context_window, 200_000);
      assert.equal(active.context_window, 1_000_000);
      assert.ok(BigInt(active.entry_id) > BigInt(retired.entry_id));
      for (const row of rows) {
        assert.equal(row.engine, "ccb");
        assert.equal(row.provider_id, "deepseek");
        assert.equal(row.upstream_model_id, null);
        assert.equal(row.capability_schema_version, 1);
        assert.deepEqual(row.capability_profile, expectedProfile);
      }
    }

    const migrationSql = await readFile(
      new URL("../db/migrations/0194_deepseek_1m_context.sql", import.meta.url),
      "utf8",
    );
    await query(migrationSql);
    assert.deepEqual((await readCatalog()).rows, migrated.rows, "direct reapply must not add versions");

    const rollbackSql = testedManualRollbackSql(migrationSql, "0194");
    await tx(async (client) => { await client.query(rollbackSql); });
    const rolledBack = await readCatalog();
    assert.equal(rolledBack.rows.length, 6);
    for (const modelId of ["deepseek-v4-flash", "deepseek-v4-pro"]) {
      const rows = rolledBack.rows.filter((row) => row.model_id === modelId);
      assert.equal(rows.filter((row) => row.state === "active" && row.context_window === 200_000).length, 1);
      assert.equal(rows.filter((row) => row.state === "retired" && row.context_window === 1_000_000).length, 1);
      assert.equal(rows.filter((row) => row.state === "retired" && row.context_window === 200_000).length, 1);
    }
    const derived = await query<{ flash: number; pro: number }>(
      `SELECT fn_model_catalog_context_window('deepseek-v4-flash') AS flash,
              fn_model_catalog_context_window('deepseek-v4-pro') AS pro`,
    );
    assert.deepEqual(derived.rows, [{ flash: 200_000, pro: 200_000 }]);
    const ledger = await query<{ present: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM schema_migrations
                      WHERE version = '0194_deepseek_1m_context') AS present`,
    );
    assert.equal(ledger.rows[0].present, true, "manual rollback must retain the 0194 ledger");

    const beforeRejectedRerun = (await readCatalog()).rows;
    await assert.rejects(
      tx(async (client) => { await client.query(rollbackSql); }),
      /0194 rollback:/,
    );
    assert.deepEqual(
      (await readCatalog()).rows,
      beforeRejectedRerun,
      "rejected rollback re-run must not create another catalog version",
    );
    assert.deepEqual((await query(
      `SELECT model_id, display_name, input_per_mtok::text, output_per_mtok::text,
              cache_read_per_mtok::text, cache_write_per_mtok::text,
              multiplier::text, enabled, sort_order, visibility
         FROM model_pricing
        WHERE model_id IN ('deepseek-v4-flash', 'deepseek-v4-pro')
        ORDER BY model_id`,
    )).rows, pricing.rows, "0194 forward/rollback must not change pricing");

    const applied0195 = await runBuiltInMigrationsThrough(
      "0195_deepseek_1m_reactivate.sql",
    );
    assert.deepEqual(applied0195.applied, ["0195_deepseek_1m_reactivate"]);
    const reactivated = await readCatalog();
    assert.equal(reactivated.rows.length, 8);
    for (const modelId of ["deepseek-v4-flash", "deepseek-v4-pro"]) {
      const rows = reactivated.rows.filter((row) => row.model_id === modelId);
      assert.equal(rows.length, 4);
      assert.equal(
        rows.filter(
          (row) => row.state === "active" && row.context_window === 1_000_000,
        ).length,
        1,
      );
      assert.equal(
        rows.filter(
          (row) => row.state === "retired" && row.context_window === 1_000_000,
        ).length,
        1,
      );
      assert.equal(
        rows.filter(
          (row) => row.state === "retired" && row.context_window === 200_000,
        ).length,
        2,
      );
      for (const row of rows) {
        assert.equal(row.engine, "ccb");
        assert.equal(row.provider_id, "deepseek");
        assert.equal(row.upstream_model_id, null);
        assert.equal(row.capability_schema_version, 1);
        assert.deepEqual(row.capability_profile, expectedProfile);
      }
    }
    assert.deepEqual(
      (
        await query<{ flash: number; pro: number }>(
          `SELECT fn_model_catalog_context_window('deepseek-v4-flash') AS flash,
              fn_model_catalog_context_window('deepseek-v4-pro') AS pro`,
        )
      ).rows,
      [{ flash: 1_000_000, pro: 1_000_000 }],
    );

    const migration0195Sql = await readFile(
      new URL(
        "../db/migrations/0195_deepseek_1m_reactivate.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await query(migration0195Sql);
    assert.deepEqual(
      (await readCatalog()).rows,
      reactivated.rows,
      "0195 direct reapply must not add versions",
    );

    const rollback0195Sql = testedManualRollbackSql(migration0195Sql, "0195");
    await tx(async (client) => {
      await client.query(rollback0195Sql);
    });
    const rolledBack0195 = await readCatalog();
    assert.equal(rolledBack0195.rows.length, 10);
    for (const modelId of ["deepseek-v4-flash", "deepseek-v4-pro"]) {
      const rows = rolledBack0195.rows.filter(
        (row) => row.model_id === modelId,
      );
      assert.equal(rows.length, 5);
      assert.equal(
        rows.filter(
          (row) => row.state === "active" && row.context_window === 200_000,
        ).length,
        1,
      );
      assert.equal(
        rows.filter(
          (row) => row.state === "retired" && row.context_window === 1_000_000,
        ).length,
        2,
      );
      assert.equal(
        rows.filter(
          (row) => row.state === "retired" && row.context_window === 200_000,
        ).length,
        2,
      );
    }
    assert.deepEqual(
      (
        await query<{ flash: number; pro: number }>(
          `SELECT fn_model_catalog_context_window('deepseek-v4-flash') AS flash,
              fn_model_catalog_context_window('deepseek-v4-pro') AS pro`,
        )
      ).rows,
      [{ flash: 200_000, pro: 200_000 }],
    );
    const ledgers = await query<{ version: string }>(
      `SELECT version FROM schema_migrations
        WHERE version IN ('0194_deepseek_1m_context', '0195_deepseek_1m_reactivate')
        ORDER BY version`,
    );
    assert.deepEqual(
      ledgers.rows.map((row) => row.version),
      ["0194_deepseek_1m_context", "0195_deepseek_1m_reactivate"],
    );

    const before0195RejectedRerun = (await readCatalog()).rows;
    await assert.rejects(
      tx(async (client) => {
        await client.query(rollback0195Sql);
      }),
      /0195 rollback:/,
    );
    assert.deepEqual(
      (await readCatalog()).rows,
      before0195RejectedRerun,
      "rejected 0195 rollback re-run must not create another catalog version",
    );
    assert.deepEqual(
      (
        await query(
          `SELECT model_id, display_name, input_per_mtok::text, output_per_mtok::text,
              cache_read_per_mtok::text, cache_write_per_mtok::text,
              multiplier::text, enabled, sort_order, visibility
         FROM model_pricing
        WHERE model_id IN ('deepseek-v4-flash', 'deepseek-v4-pro')
        ORDER BY model_id`,
        )
      ).rows,
      pricing.rows,
      "0195 forward/rollback must not change pricing",
    );
  });

  test("0195 reapply/rollback refuse the later 0215 Flash provider lineage atomically", async (t) => {
    if (skipIfNoPg(t)) return;
    const first = await runMigrations();
    assert.ok(first.applied.includes("0194_deepseek_1m_context"));
    assert.ok(first.applied.includes("0195_deepseek_1m_reactivate"));
    const readLineage = () =>
      query<{
        model_id: string;
        state: string;
        context_window: number;
        provider_id: string | null;
      }>(
        `SELECT model_id, state, context_window, provider_id
         FROM model_catalog
        WHERE model_id IN ('deepseek-v4-flash', 'deepseek-v4-pro')
        ORDER BY model_id, entry_id`,
      );
    const clean = await readLineage();
    assert.equal(clean.rows.length, 5);
    assert.deepEqual(
      clean.rows
        .filter((row) => row.model_id === "deepseek-v4-flash")
        .map((row) => [row.state, row.context_window, row.provider_id]),
      [
        ["retired", 200_000, "deepseek"],
        ["retired", 1_000_000, "deepseek"],
        ["active", 1_000_000, "opencodego"],
      ],
    );
    assert.deepEqual(
      clean.rows
        .filter((row) => row.model_id === "deepseek-v4-pro")
        .map((row) => [row.state, row.context_window, row.provider_id]),
      [
        ["retired", 200_000, "deepseek"],
        ["disabled", 1_000_000, "deepseek"],
      ],
    );
    const migration0195Sql = await readFile(
      new URL(
        "../db/migrations/0195_deepseek_1m_reactivate.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await assert.rejects(query(migration0195Sql), /0195: DeepSeek pricing precondition failed|execution descriptor history drifted/);
    assert.deepEqual(
      (await readLineage()).rows,
      clean.rows,
      "0195 direct reapply must refuse the later 0215 provider lineage atomically",
    );
    const rollback0195Sql = testedManualRollbackSql(migration0195Sql, "0195");
    await assert.rejects(
      tx(async (client) => {
        await client.query(rollback0195Sql);
      }),
      /0195 rollback:/,
    );
    assert.deepEqual(
      (await readLineage()).rows,
      clean.rows,
      "0195 rollback must not undo clean 0194 lineage",
    );

    await query(
      `SELECT fn_model_switch_version(
         model_id, engine, provider_id, upstream_model_id, 200000,
         capability_profile, capability_schema_version, NULL, lock_version
       )
         FROM model_catalog
        WHERE model_id = 'deepseek-v4-flash' AND state = 'active'`,
    );
    const mixed = await readLineage();
    await assert.rejects(query(migration0195Sql), /0195: DeepSeek pricing precondition failed|execution descriptor history drifted/);
    assert.deepEqual(
      (await readLineage()).rows,
      mixed.rows,
      "0195 must keep rejecting after a later Flash version switch",
    );
    assert.deepEqual(
      (
        await query<{ flash: number; pro: number }>(
          `SELECT fn_model_catalog_context_window('deepseek-v4-flash') AS flash,
                  fn_model_catalog_context_window('deepseek-v4-pro') AS pro`,
        )
      ).rows,
      [{ flash: 1_000_000, pro: 1_000_000 }],
      "rejected mixed-lineage migration must not change the helper",
    );
    const second = await runMigrations();
    assert.equal(second.applied.length, 0);
  });

  test("0179/0186 publishes Ark K3 with the official K3 pricing", async (t) => {
    if (skipIfNoPg(t)) return;
    await runMigrations();

    const catalog = await query<{
      engine: string;
      provider_id: string;
      upstream_model_id: string;
      context_window: number;
      capability_profile: Record<string, unknown>;
      capability_schema_version: number;
      state: string;
    }>(
      `SELECT engine, provider_id, upstream_model_id, context_window,
              capability_profile, capability_schema_version, state
         FROM model_catalog
        WHERE model_id = 'kimi-k3-ark'`,
    );
    assert.equal(catalog.rows.length, 1);
    assert.equal(catalog.rows[0].engine, "ccb");
    assert.equal(catalog.rows[0].provider_id, "ark-k3");
    assert.equal(catalog.rows[0].upstream_model_id, "kimi-k3");
    assert.equal(catalog.rows[0].context_window, 1_048_576);
    assert.equal(catalog.rows[0].capability_schema_version, 1);
    assert.equal(catalog.rows[0].state, "active");
    assert.deepEqual(catalog.rows[0].capability_profile, {
      supports_vision: true,
      reasoning: { supported: [], codex_model_default: null },
      ccb: { capability_zero: true, supports_thinking: true },
    });

    const pricing = await query<{
      model_id: string;
      display_name: string;
      input_per_mtok: string;
      output_per_mtok: string;
      cache_read_per_mtok: string;
      cache_write_per_mtok: string;
      multiplier: string;
      enabled: boolean;
      sort_order: number;
      visibility: string;
    }>(
      `SELECT model_id, display_name,
              input_per_mtok::text, output_per_mtok::text,
              cache_read_per_mtok::text, cache_write_per_mtok::text,
              multiplier::text, enabled, sort_order, visibility
         FROM model_pricing
        WHERE model_id IN ('kimi-k3', 'kimi-k3-ark')
        ORDER BY model_id`,
    );
    assert.equal(pricing.rows.length, 2);
    const source = pricing.rows.find((row) => row.model_id === "kimi-k3")!;
    const target = pricing.rows.find((row) => row.model_id === "kimi-k3-ark")!;
    assert.equal(target.display_name, "Kimi K3（ark）");
    for (const field of [
      "input_per_mtok",
      "output_per_mtok",
      "cache_read_per_mtok",
      "cache_write_per_mtok",
      "multiplier",
      "enabled",
    ] as const) {
      assert.equal(target[field], source[field], field);
    }
    assert.equal(target.sort_order, 89);
    assert.equal(target.visibility, "public");

    const cache = new PricingCache();
    await cache.load();
    try {
      assert.ok(
        cache.listForUser({ role: "admin", grantedModelIds: new Set() })
          .some((model) => model.id === "kimi-k3-ark"),
      );
      assert.ok(
        cache.listForUser({ role: "user", grantedModelIds: new Set() })
          .some((model) => model.id === "kimi-k3-ark"),
      );
    } finally {
      await cache.shutdown();
    }

    const live = await query<{ lock_version: number }>(
      `SELECT lock_version
         FROM model_catalog
        WHERE model_id = 'kimi-k3-ark' AND state = 'active'`,
    );
    await query(
      `SELECT fn_model_switch_version(
         'kimi-k3-ark', 'ccb', 'moonshot', 'kimi-k3', 1048576,
         '{
           "supports_vision": true,
           "reasoning": { "supported": [], "codex_model_default": null },
           "ccb": { "capability_zero": true, "supports_thinking": true }
         }'::jsonb,
         1, NULL, $1
       )`,
      [live.rows[0].lock_version],
    );
    const migrationSql = await readFile(
      new URL("../db/migrations/0179_ark_plan_kimi_k3.sql", import.meta.url),
      "utf8",
    );
    await assert.rejects(
      query(migrationSql),
      /0179 kimi-k3-ark catalog verification failed/,
      "reapplying 0179 must fail closed when an existing live catalog row has drifted",
    );
  });

  test("0197/0199 preserve admin pricing while switching Qwen3.8 Max to Codex Responses", async (t) => {
    if (skipIfNoPg(t)) return;
    await runMigrations();

    const catalog = await query<{
      engine: string;
      provider_id: string;
      upstream_model_id: string;
      context_window: number;
      capability_profile: Record<string, unknown>;
      capability_schema_version: number;
      state: string;
    }>(
      `SELECT engine, provider_id, upstream_model_id, context_window,
              capability_profile, capability_schema_version, state
         FROM model_catalog
        WHERE model_id = 'qwen3.8-max'
        ORDER BY entry_id`,
    );
    assert.deepEqual(catalog.rows, [
      {
        engine: "ccb",
        provider_id: "bailian",
        upstream_model_id: "qwen3.8-max",
        context_window: 983_616,
        capability_profile: {
          supports_vision: true,
          reasoning: { supported: [], codex_model_default: null },
          ccb: { capability_zero: true, supports_thinking: true },
        },
        capability_schema_version: 1,
        state: "retired",
      },
      {
        engine: "codex",
        provider_id: "codex",
        upstream_model_id: "qwen3.8-max",
        context_window: 983_616,
        capability_profile: {
          supports_vision: true,
          reasoning: {
            supported: ["low", "medium", "xhigh"],
            codex_model_default: "xhigh",
          },
          ccb: { capability_zero: false, supports_thinking: false },
        },
        capability_schema_version: 1,
        state: "active",
      },
    ]);

    const pricing = await query<{
      model_id: string;
      display_name: string;
      input_per_mtok: string;
      output_per_mtok: string;
      cache_read_per_mtok: string;
      cache_write_per_mtok: string;
      multiplier: string;
      enabled: boolean;
      sort_order: number;
      visibility: string;
      default_effort: string | null;
    }>(
      `SELECT model_id, display_name,
              input_per_mtok::text, output_per_mtok::text,
              cache_read_per_mtok::text, cache_write_per_mtok::text,
              multiplier::text, enabled, sort_order, visibility, default_effort
         FROM model_pricing
        WHERE model_id IN ('qwen3.7-max', 'qwen3.8-max')
        ORDER BY model_id`,
    );
    assert.equal(pricing.rows.length, 2);
    const source = pricing.rows.find((row) => row.model_id === "qwen3.7-max")!;
    const target = pricing.rows.find((row) => row.model_id === "qwen3.8-max")!;
    for (const field of [
      "input_per_mtok",
      "output_per_mtok",
      "cache_read_per_mtok",
      "cache_write_per_mtok",
      "multiplier",
    ] as const) {
      assert.equal(target[field], source[field], field);
    }
    assert.equal(source.enabled, false);
    assert.equal(target.enabled, true);
    assert.equal(target.display_name, "Qwen3.8 Max");
    assert.equal(target.sort_order, 88);
    assert.equal(target.visibility, "admin");
    assert.equal(target.default_effort, "xhigh");

    const cache = new PricingCache();
    await cache.load();
    try {
      assert.ok(
        cache.listForUser({ role: "admin", grantedModelIds: new Set() })
          .some((model) => model.id === "qwen3.8-max"),
      );
      assert.ok(
        !cache.listForUser({ role: "user", grantedModelIds: new Set() })
          .some((model) => model.id === "qwen3.8-max"),
      );
    } finally {
      await cache.shutdown();
    }

    const migrationSql = await readFile(
      new URL("../db/migrations/0199_qwen38_codex_responses.sql", import.meta.url),
      "utf8",
    );
    await query(migrationSql);
    const active = await query<{ lock_version: number }>(
      `SELECT lock_version FROM model_catalog
        WHERE model_id = 'qwen3.8-max' AND state = 'active'`,
    );
    await query(
      `SELECT fn_model_switch_version(
         'qwen3.8-max', 'ccb', 'bailian', 'qwen3.8-max', 983616,
         '{
           "supports_vision": true,
           "reasoning": { "supported": [], "codex_model_default": null },
           "ccb": { "capability_zero": true, "supports_thinking": true }
         }'::jsonb,
         1, NULL, $1
       )`,
      [active.rows[0].lock_version],
    );
    await assert.rejects(
      query(migrationSql),
      /0199 qwen3.8-max catalog predecessor\/terminal verification failed/,
      "reapplying 0199 must fail closed when catalog history/current state drifted",
    );
  });

  test("0183/0184 activate hidden Luna and create release-bound verification fences", async (t) => {
    if (skipIfNoPg(t)) return;
    await runMigrations();

    const luna = await query<{
      state: string;
      enabled: boolean;
      visibility: string;
      default_effort: string;
      capability_profile: Record<string, unknown>;
    }>(
      `SELECT c.state,p.enabled,p.visibility,p.default_effort,c.capability_profile
         FROM model_catalog c
         JOIN model_pricing p ON p.model_id=c.model_id
        WHERE c.model_id='gpt-5.6-luna' AND c.state='active'`,
    );
    assert.deepEqual(luna.rows, [{
      state: "active",
      enabled: true,
      visibility: "hidden",
      default_effort: "medium",
      capability_profile: {
        ccb: { capability_zero: false, supports_thinking: false },
        reasoning: {
          supported: ["low", "medium", "high", "xhigh", "max"],
          codex_model_default: "medium",
        },
        supports_vision: true,
      },
    }]);

    const tables = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public'
          AND table_name IN (
            'verification_runs','verification_sponsored_requests',
            'release_verification_evidence','release_egress_transitions',
            'emergency_containment_authorizations','emergency_containment_debts'
          )
        ORDER BY table_name`,
    );
    assert.deepEqual(tables.rows.map((row) => row.table_name), [
      "emergency_containment_authorizations",
      "emergency_containment_debts",
      "release_egress_transitions",
      "release_verification_evidence",
      "verification_runs",
      "verification_sponsored_requests",
    ]);
  });

  test("bad migration rolls back that migration's DDL (0001 stays, 0002 doesn't)", async (t) => {
    if (skipIfNoPg(t)) return;

    const dir = await mkdtemp(path.join(tmpdir(), "mig-bad-"));
    try {
      await writeFile(
        path.join(dir, "0001_good.sql"),
        "CREATE TABLE good_one (id BIGSERIAL PRIMARY KEY);",
        "utf8",
      );
      // 0002 故意 SQL 错误:引用不存在的表
      await writeFile(
        path.join(dir, "0002_bad.sql"),
        "CREATE TABLE bad_two (id BIGSERIAL PRIMARY KEY); INSERT INTO nonexistent_table VALUES (1);",
        "utf8",
      );

      await assert.rejects(runMigrations({ dir }), /nonexistent_table/i);

      // 0001 的 good_one 表应该已经独立提交并存活
      const tbls = await query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('good_one','bad_two')",
      );
      const names = new Set(tbls.rows.map((r) => r.table_name));
      assert.ok(names.has("good_one"), "0001 table must survive");
      assert.ok(!names.has("bad_two"), "0002 table must be rolled back");

      // schema_migrations 只应有 0001
      const versions = await query<{ version: string }>(
        "SELECT version FROM schema_migrations ORDER BY version",
      );
      assert.deepEqual(versions.rows.map((r) => r.version), ["0001_good"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
      // 清理遗留
      await query("DROP TABLE IF EXISTS good_one, bad_two CASCADE");
    }
  });

  test("migrations are applied in lexical filename order", async (t) => {
    if (skipIfNoPg(t)) return;
    const dir = await mkdtemp(path.join(tmpdir(), "mig-order-"));
    try {
      await writeFile(
        path.join(dir, "0010_late.sql"),
        "CREATE TABLE _order_a (id BIGSERIAL PRIMARY KEY);",
        "utf8",
      );
      await writeFile(
        path.join(dir, "0001_early.sql"),
        "CREATE TABLE _order_b (id BIGSERIAL PRIMARY KEY);",
        "utf8",
      );
      await writeFile(
        path.join(dir, "0005_middle.sql"),
        "CREATE TABLE _order_c (id BIGSERIAL PRIMARY KEY);",
        "utf8",
      );

      const r = await runMigrations({ dir });
      assert.deepEqual(r.applied, ["0001_early", "0005_middle", "0010_late"]);

      const versions = await query<{ version: string }>(
        "SELECT version FROM schema_migrations ORDER BY applied_at, version",
      );
      assert.deepEqual(
        versions.rows.map((r) => r.version),
        ["0001_early", "0005_middle", "0010_late"],
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
      await query("DROP TABLE IF EXISTS _order_a, _order_b, _order_c CASCADE");
    }
  });

  test("ignores non-.sql files in migrations dir", async (t) => {
    if (skipIfNoPg(t)) return;
    const dir = await mkdtemp(path.join(tmpdir(), "mig-filter-"));
    try {
      await writeFile(path.join(dir, "0001_a.sql"), "CREATE TABLE _flt_a (id INTEGER);", "utf8");
      await writeFile(path.join(dir, "README.md"), "not a migration", "utf8");
      await writeFile(path.join(dir, "0002_b.sql.bak"), "should be ignored", "utf8");

      const r = await runMigrations({ dir });
      assert.deepEqual(r.applied, ["0001_a"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await query("DROP TABLE IF EXISTS _flt_a CASCADE");
    }
  });

  test("built-in 0001 creates expected columns (regression against DDL drift)", async (t) => {
    if (skipIfNoPg(t)) return;
    await runMigrations();
    const cols = await query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='users' ORDER BY ordinal_position",
    );
    const names = cols.rows.map((r) => r.column_name);
    // 不做完整断言,挑几个关键字段
    for (const expected of ["id", "email", "password_hash", "role", "credits", "status"]) {
      assert.ok(names.includes(expected), `users.${expected} missing`);
    }
  });

  test("fails when a previously-applied migration is missing from dir (integrity drift)", async (t) => {
    if (skipIfNoPg(t)) return;
    const dir = await mkdtemp(path.join(tmpdir(), "mig-drift-"));
    try {
      await writeFile(
        path.join(dir, "0001_keep.sql"),
        "CREATE TABLE _drift_a (id BIGSERIAL PRIMARY KEY);",
        "utf8",
      );
      await writeFile(
        path.join(dir, "0002_will_be_deleted.sql"),
        "CREATE TABLE _drift_b (id BIGSERIAL PRIMARY KEY);",
        "utf8",
      );
      await runMigrations({ dir });

      // 模拟有人删了 0002 文件
      await rm(path.join(dir, "0002_will_be_deleted.sql"));

      await assert.rejects(
        runMigrations({ dir }),
        (err: unknown) =>
          err instanceof MigrationIntegrityError &&
          /0002_will_be_deleted/.test(err.message),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
      await query("DROP TABLE IF EXISTS _drift_a, _drift_b CASCADE");
    }
  });

  test("fails when a new migration has a version <= max(applied) (out-of-order)", async (t) => {
    if (skipIfNoPg(t)) return;
    const dir = await mkdtemp(path.join(tmpdir(), "mig-ooo-"));
    try {
      await writeFile(
        path.join(dir, "0001_first.sql"),
        "CREATE TABLE _ooo_a (id BIGSERIAL PRIMARY KEY);",
        "utf8",
      );
      await writeFile(
        path.join(dir, "0005_fifth.sql"),
        "CREATE TABLE _ooo_b (id BIGSERIAL PRIMARY KEY);",
        "utf8",
      );
      await runMigrations({ dir });

      // 有人后来塞了一个 0003,版本小于已 applied 的 0005
      await writeFile(
        path.join(dir, "0003_backfill.sql"),
        "CREATE TABLE _ooo_c (id BIGSERIAL PRIMARY KEY);",
        "utf8",
      );

      await assert.rejects(
        runMigrations({ dir }),
        (err: unknown) =>
          err instanceof MigrationIntegrityError &&
          /out-of-order/.test(err.message) &&
          /0003_backfill/.test(err.message),
      );

      // 确保 0003 的表没被偷偷建
      const tbls = await query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = '_ooo_c'",
      );
      assert.equal(tbls.rows.length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await query("DROP TABLE IF EXISTS _ooo_a, _ooo_b, _ooo_c CASCADE");
    }
  });

  test("credit_ledger UPDATE/DELETE are no-ops (append-only RULE)", async (t) => {
    if (skipIfNoPg(t)) return;
    await runMigrations();
    // 插入一条 test user
    const u = await query<{ id: string }>(
      "INSERT INTO users(email, password_hash) VALUES ($1, $2) RETURNING id",
      ["rule-test@example.com", "argon2$stub"],
    );
    const userId = u.rows[0].id;
    await query(
      "INSERT INTO credit_ledger(user_id, delta, balance_after, reason) VALUES ($1, $2, $3, $4)",
      [userId, 100, 100, "topup"],
    );

    await query(
      "UPDATE credit_ledger SET delta = 999 WHERE user_id = $1",
      [userId],
    );
    await query("DELETE FROM credit_ledger WHERE user_id = $1", [userId]);

    const check = await query<{ delta: string; cnt: string }>(
      "SELECT delta::text AS delta, COUNT(*) OVER()::text AS cnt FROM credit_ledger WHERE user_id = $1",
      [userId],
    );
    assert.equal(check.rows.length, 1, "row must still exist (DELETE blocked)");
    assert.equal(check.rows[0].delta, "100", "delta must be unchanged (UPDATE blocked)");
  });
});
