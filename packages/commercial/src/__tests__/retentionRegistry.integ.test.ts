/**
 * retention 反向对账门(批D D3)—— 范式照搬 aa0ab0ee 的 scheduler smoke allowlist 反向门。
 *
 * 权威集 = 跑完全量迁移后 information_schema 里的**全部 base table**;
 * 声明集 = retentionRegistry.ts 的 RETENTION_REGISTRY(六档离场语义之一)。
 * 双向校验: DB ⊆ 全注册集, migration-owned 注册集 ⊆ DB。
 * 精确 historical-manual 来源不要求 fresh 凭空建表,永久身份和 live 全集不变:
 *   - 有表未登记离场语义 → 红(消灭"新表静默无界增长"这一整类风险);
 *   - 注册表有幽灵条目(表已删/改名)→ 红(防注册表腐烂)。
 *
 * 另含**不连库**的注册表内部自洽断言(ttl/永久档必须与三个既有权威源逐一对齐,
 * deferred 必须带 owner+到期日),这些在无 PG 环境也跑。
 *
 * 跑法(需测试 PG,见 packages/commercial/README.md):
 *   TEST_DATABASE_URL=... npx tsx --test packages/commercial/src/__tests__/retentionRegistry.integ.test.ts
 */
import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { resetTestSchemaForTest } from "./helpers/db.js";
import {
  AUDIT_RETENTION_POLICIES,
  PERMANENT_AUDIT_TABLES,
  PERMANENT_OPS_LEDGER_TABLES,
} from "../admin/auditRetention.js";
import {
  RETENTION_REGISTRY,
  FRESH_RETENTION_TABLES,
  HISTORICAL_MANUAL_TABLES,
  compareFreshRetentionCoverage,
  DEFERRED_TABLES,
  BESPOKE_SWEEPER_TABLES,
  DURABLE_TABLES,
  type RetentionDisposition,
} from "../admin/retentionRegistry.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://test:test@127.0.0.1:55432/openclaude_test";
const REQUIRE_TEST_DB =
  process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

let pgAvailable = false;

async function cleanCommercialSchema(): Promise<void> {
  // 全量迁移不只创建表，也创建 function/type/trigger。仅 DROP TABLE 会让下一套从零
  // 迁移在残留 function 上撞 already-exists；统一走带 `_test` 库名硬防护的 schema reset。
  await resetTestSchemaForTest();
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

before(async () => {
  pgAvailable = await probe();
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) {
      throw new Error(
        "Postgres test fixture required (CI=true or REQUIRE_TEST_DB=1). See packages/commercial/README.md.",
      );
    }
    return;
  }
  await resetPool();
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 5 }));
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

const kindsOf = (want: RetentionDisposition["kind"]): string[] =>
  Object.entries(RETENTION_REGISTRY)
    .filter(([, d]) => d.kind === want)
    .map(([t]) => t)
    .sort();

describe("retention 注册表内部自洽(不连库)", () => {
  test("ttl 档 === AUDIT_RETENTION_POLICIES 的表集(单一权威对齐)", () => {
    assert.deepEqual(
      kindsOf("ttl"),
      [...AUDIT_RETENTION_POLICIES.map((p) => p.table)].sort(),
      "注册表 ttl 档必须与 AUDIT_RETENTION_POLICIES 逐表一致(引用聚合,不得手改漂移)",
    );
  });

  test("permanent-compliance 档 === PERMANENT_AUDIT_TABLES", () => {
    assert.deepEqual(kindsOf("permanent-compliance"), [...PERMANENT_AUDIT_TABLES].sort());
  });

  test("permanent-ledger 档 === PERMANENT_OPS_LEDGER_TABLES", () => {
    assert.deepEqual(kindsOf("permanent-ledger"), [...PERMANENT_OPS_LEDGER_TABLES].sort());
  });

  test("每个 deferred 条目都带 owner + 到期日 + 说明", () => {
    const deferred = Object.entries(RETENTION_REGISTRY).filter(([, d]) => d.kind === "deferred");
    assert.ok(deferred.length > 0, "deferred 档不应为空(至少 marketplace/response/wechat_audit)");
    for (const [table, d] of deferred) {
      assert.equal(d.kind, "deferred");
      const meta = d as Extract<RetentionDisposition, { kind: "deferred" }>;
      assert.ok(meta.owner.length > 0, `${table} deferred 缺 owner`);
      assert.match(meta.dueDate, /^\d{4}-\d{2}-\d{2}$/, `${table} deferred 到期日格式应为 YYYY-MM-DD`);
      assert.ok(meta.note.length > 0, `${table} deferred 缺说明`);
    }
  });

  test("六档互斥无重叠,总数 = 各档之和(buildRetentionRegistry 已 fail-fast,此处再核)", () => {
    const total = Object.keys(RETENTION_REGISTRY).length;
    const sum =
      AUDIT_RETENTION_POLICIES.length +
      PERMANENT_AUDIT_TABLES.length +
      PERMANENT_OPS_LEDGER_TABLES.length +
      Object.keys(BESPOKE_SWEEPER_TABLES).length +
      DURABLE_TABLES.length +
      Object.keys(DEFERRED_TABLES).length;
    assert.equal(total, sum, "注册表总数应等于六档之和(有重叠则 buildRetentionRegistry 会抛)");
  });
});

describe("retention 反向对账门(连库跑全量迁移)", () => {
  test("information_schema 全部 base table 都在 RETENTION_REGISTRY(未声明即红)", async (t) => {
    if (skipIfNoPg(t)) return;
    await runMigrations();
    const rows = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`,
    );
    const dbTables = new Set(rows.rows.map((r) => r.table_name));
    const { undeclared, phantom } = compareFreshRetentionCoverage(dbTables);

    // ① DB ⊆ 注册表:有表没登记离场语义 → 红。
    assert.deepEqual(
      undeclared,
      [],
      `以下 base table 未在 retentionRegistry.ts 登记离场语义(未声明即红,防静默无界增长):` +
        `${undeclared.join(", ")};修法=在 RETENTION_REGISTRY 六档之一给它一个 disposition。`,
    );

    // ② migration-owned 注册集 ⊆ DB:任意应由迁移创建的表缺失仍红。
    assert.deepEqual(
      phantom,
      [],
      `以下 migration-owned 表在 RETENTION_REGISTRY 里但库里不存在:${phantom.join(", ")}`,
    );

    // Pure observation mutations over the REAL migrated inventory, not fake backup DDL.
    for (const table of FRESH_RETENTION_TABLES) {
      const missing = new Set(dbTables);
      missing.delete(table);
      assert.deepEqual(compareFreshRetentionCoverage(missing).phantom, [table], `missing ${table} must remain red`);
    }
    for (const table of Object.keys(HISTORICAL_MANUAL_TABLES)) {
      assert.equal(RETENTION_REGISTRY[table]?.kind, "permanent-ledger");
      const absent = new Set(dbTables);
      absent.delete(table);
      assert.deepEqual(compareFreshRetentionCoverage(absent), { undeclared: [], phantom: [] });
      assert.deepEqual(compareFreshRetentionCoverage([...absent, table]), { undeclared: [], phantom: [] });
      const typo = `${table}_typo`;
      assert.deepEqual(compareFreshRetentionCoverage([...absent, typo]).undeclared, [typo]);
    }
    assert.deepEqual(compareFreshRetentionCoverage([...dbTables, "undeclared_retention_probe"]).undeclared,
      ["undeclared_retention_probe"]);

  });
});
