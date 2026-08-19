/**
 * 0227 ZCode engine CHECK + hidden staged canary.
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0227.integ.test.ts'
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { query, tx } from "../db/queries.js";
import { resetAndMigrateBefore, useDedicatedTestDatabase } from "./helpers/db.js";

const db = useDedicatedTestDatabase("zcode_engine_0227_test");
const here = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.resolve(here, "../db/migrations/0227_zcode_engine.sql");

async function loadSql(): Promise<string> {
  return readFile(migrationPath, "utf8");
}

async function canaryRow() {
  const result = await query<{
    model_id: string;
    engine: string;
    state: string;
    enabled: boolean;
    visibility: string;
  }>(
    `SELECT c.model_id, c.engine, c.state, p.enabled, p.visibility
       FROM model_catalog c
       JOIN model_pricing p USING (model_id)
      WHERE c.model_id = 'zcode-experimental'`,
  );
  return result.rows;
}

async function glm53Zai() {
  const result = await query<{ engine: string; state: string }>(
    `SELECT engine, state FROM model_catalog WHERE model_id = 'glm-5.3-zai'`,
  );
  return result.rows;
}

describe("0227_zcode_engine", () => {
  test("inserts staged hidden canary and keeps public glm-5.3-zai on ccb", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    await resetAndMigrateBefore("0227");
    await query(await loadSql());
    assert.deepEqual(await canaryRow(), [
      {
        model_id: "zcode-experimental",
        engine: "zcode",
        state: "staged",
        enabled: false,
        visibility: "hidden",
      },
    ]);
    assert.deepEqual(await glm53Zai(), [{ engine: "ccb", state: "active" }]);
    const check = await query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = 'model_catalog'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%engine%'`,
    );
    assert.match(check.rows[0]?.def ?? "", /zcode/);
    const audit = await query<{ t: string | null }>(
      `SELECT to_regclass('zcode_external_usage_audit')::text AS t`,
    );
    assert.equal(audit.rows[0]?.t, "zcode_external_usage_audit");
  });

  test("rolls the whole 0227 transaction back", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    await resetAndMigrateBefore("0227");
    const sql = await loadSql();
    await assert.rejects(
      () =>
        tx(async (client) => {
          await client.query(sql);
          const born = await client.query<{ state: string }>(
            `SELECT state FROM model_catalog WHERE model_id = 'zcode-experimental'`,
          );
          assert.equal(born.rows[0]?.state, "staged");
          throw new Error("intentional-rollback");
        }),
      /intentional-rollback/,
    );
    assert.deepEqual(await canaryRow(), []);
    assert.deepEqual(await glm53Zai(), [{ engine: "ccb", state: "active" }]);
    const audit = await query<{ t: string | null }>(
      `SELECT to_regclass('zcode_external_usage_audit')::text AS t`,
    );
    assert.equal(audit.rows[0]?.t, null);
    const check = await query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = 'model_catalog'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%engine%'`,
    );
    assert.doesNotMatch(check.rows[0]?.def ?? "", /zcode/);
  });
});
