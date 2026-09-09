import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildFreshRetentionTables,
  compareFreshRetentionCoverage,
  FRESH_RETENTION_TABLES,
  HISTORICAL_MANUAL_TABLES,
  RETENTION_REGISTRY,
  type HistoricalManualTable,
  type RetentionDisposition,
} from "../admin/retentionRegistry.js";
import { AUDIT_RETENTION_POLICIES, PERMANENT_OPS_LEDGER_TABLES, resolveRetentionPolicies } from "../admin/auditRetention.js";

const historical = "model_pricing_0903_cw_backup";
const metadata = HISTORICAL_MANUAL_TABLES[historical]!;
const clean = { undeclared: [], phantom: [] };

describe("retention source presence contract (OCV5-180)", () => {
  test("only the exact historical table is optional on fresh installs, never other backups", () => {
    assert.deepEqual(Object.keys(HISTORICAL_MANUAL_TABLES), [historical]);
    assert.deepEqual(FRESH_RETENTION_TABLES, Object.keys(RETENTION_REGISTRY).filter((t) => t !== historical).sort());
    assert.ok(FRESH_RETENTION_TABLES.includes("model_pricing_0270_backup"));
    assert.deepEqual(compareFreshRetentionCoverage(FRESH_RETENTION_TABLES), clean);
    assert.deepEqual(compareFreshRetentionCoverage([...FRESH_RETENTION_TABLES, historical]), clean);
  });

  test("each migration-owned table missing from observation is still a phantom", () => {
    for (const table of FRESH_RETENTION_TABLES) {
      assert.deepEqual(compareFreshRetentionCoverage(FRESH_RETENTION_TABLES.filter((t) => t !== table)),
        { undeclared: [], phantom: [table] }, table);
    }
  });

  test("unknown names, typo backups, and inherited object names cannot borrow registration", () => {
    for (const table of ["new_undeclared_table", `${historical}_typo`, "model_pricing_0904_cw_backup", "toString", "__proto__"]) {
      assert.deepEqual(compareFreshRetentionCoverage([...FRESH_RETENTION_TABLES, table]),
        { undeclared: [table], phantom: [] }, table);
    }
  });

  test("metadata cannot grant registration or permanent identity", () => {
    assert.throws(() => buildFreshRetentionTables(RETENTION_REGISTRY,
      { unknown_table: metadata }), /not registered/);
    assert.throws(() => buildFreshRetentionTables(RETENTION_REGISTRY,
      { toString: metadata }), /not registered/);
    const kinds: RetentionDisposition[] = [
      { kind: "durable" }, { kind: "ttl" }, { kind: "permanent-compliance" },
      { kind: "bespoke-sweeper", sweeper: "test" },
      { kind: "deferred", owner: "test", dueDate: "2026-12-31", note: "test" },
    ];
    for (const disposition of kinds) {
      assert.throws(() => buildFreshRetentionTables({ ...RETENTION_REGISTRY, [historical]: disposition }),
        /must already be permanent-ledger and not TTL/);
    }
  });

  test("independent TTL source overlap fails even with permanent registry kind", () => {
    assert.throws(() => buildFreshRetentionTables(RETENTION_REGISTRY, HISTORICAL_MANUAL_TABLES,
      [...AUDIT_RETENTION_POLICIES.map((p) => p.table), historical]), /not TTL/);
  });

  test("historical source, owner and evidence are mandatory at the shared builder", () => {
    const invalid: HistoricalManualTable[] = [
      { ...metadata, source: "optional" as HistoricalManualTable["source"] },
      { ...metadata, owner: " " }, { ...metadata, evidence: "" },
      { ...metadata, evidence: 1 as unknown as string },
    ];
    for (const item of invalid) {
      assert.throws(() => buildFreshRetentionTables(RETENTION_REGISTRY, { [historical]: item }), /invalid historical/);
    }
  });

  test("removing the historical declaration restores required presence, not an implicit name exemption", () => {
    assert.deepEqual(buildFreshRetentionTables(RETENTION_REGISTRY, {}), Object.keys(RETENTION_REGISTRY).sort());
  });

  test("all permanent ledgers stay outside actual TTL policy resolution, including override attempts", (t) => {
    t.mock.method(console, "warn", () => undefined);
    assert.equal(RETENTION_REGISTRY[historical]?.kind, "permanent-ledger");
    const policies = resolveRetentionPolicies(PERMANENT_OPS_LEDGER_TABLES.map((table) => `${table}=1`).join(","));
    assert.deepEqual(policies, resolveRetentionPolicies(""));
    for (const table of PERMANENT_OPS_LEDGER_TABLES) {
      assert.equal(policies.some((p) => p.table === table), false, table);
    }
  });
});
