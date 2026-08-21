/**
 * 0221 Cursor official pricing.
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0221.integ.test.ts'
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { query } from "../db/queries.js";
import { resetAndMigrateBefore, useDedicatedTestDatabase } from "./helpers/db.js";

const db = useDedicatedTestDatabase("models_0221_test");
const here = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.resolve(here, "../db/migrations/0221_cursor_official_pricing.sql");

async function prices() {
  const result = await query<{
    model_id: string;
    input_per_mtok: string;
    output_per_mtok: string;
    cache_read_per_mtok: string;
    cache_write_per_mtok: string;
    multiplier: string;
    visibility: string;
    enabled: boolean;
  }>(
    `SELECT model_id, input_per_mtok::text, output_per_mtok::text,
            cache_read_per_mtok::text, cache_write_per_mtok::text,
            multiplier::text, visibility, enabled
       FROM model_pricing
      WHERE model_id LIKE 'cursor-%'
      ORDER BY model_id`,
  );
  return result.rows;
}

describe("0221_cursor_official_pricing", () => {
  test("writes official unit prices and x2 fast multipliers without touching visibility", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    await resetAndMigrateBefore("0221");
    const before = await prices();
    const visibilityBefore = Object.fromEntries(before.map((row) => [row.model_id, row.visibility]));
    await query(await readFile(migrationPath, "utf8"));
    const after = await prices();
    assert.deepEqual(
      after.map((row) => ({
        model_id: row.model_id,
        input_per_mtok: row.input_per_mtok,
        output_per_mtok: row.output_per_mtok,
        cache_read_per_mtok: row.cache_read_per_mtok,
        cache_write_per_mtok: row.cache_write_per_mtok,
        multiplier: row.multiplier,
      })),
      [
        { model_id: "cursor-auto", input_per_mtok: "0", output_per_mtok: "0", cache_read_per_mtok: "0", cache_write_per_mtok: "0", multiplier: "1.000" },
        { model_id: "cursor-composer-2.5-fast", input_per_mtok: "50", output_per_mtok: "250", cache_read_per_mtok: "20", cache_write_per_mtok: "0", multiplier: "2.000" },
        { model_id: "cursor-fable-5-high", input_per_mtok: "1000", output_per_mtok: "5000", cache_read_per_mtok: "100", cache_write_per_mtok: "1250", multiplier: "1.000" },
        { model_id: "cursor-grok-4.5-high", input_per_mtok: "200", output_per_mtok: "600", cache_read_per_mtok: "50", cache_write_per_mtok: "0", multiplier: "1.000" },
        { model_id: "cursor-grok-4.6-high", input_per_mtok: "200", output_per_mtok: "600", cache_read_per_mtok: "50", cache_write_per_mtok: "0", multiplier: "1.000" },
        { model_id: "cursor-grok-4.6-high-fast", input_per_mtok: "200", output_per_mtok: "600", cache_read_per_mtok: "50", cache_write_per_mtok: "0", multiplier: "2.000" },
        { model_id: "cursor-opus-5-high", input_per_mtok: "500", output_per_mtok: "2500", cache_read_per_mtok: "50", cache_write_per_mtok: "625", multiplier: "1.000" },
      ],
    );
    for (const row of after) {
      assert.equal(row.visibility, visibilityBefore[row.model_id], row.model_id);
      assert.equal(row.enabled, true, row.model_id);
    }
  });
});
