/**
 * 0282 scnet glm-5.3 switch + glm-5.3-flash public + hide glm-5.3-zai.
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit --test-concurrency=1 --test-timeout=180000 \
 *    packages/commercial/src/__tests__/migration0282.integ.test.ts'
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { splitSqlStatements } from "../db/migrate.js";
import { query } from "../db/queries.js";
import { resetAndMigrateBefore, useDedicatedTestDatabase } from "./helpers/db.js";

const db = useDedicatedTestDatabase("models_0282_test");
const here = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.resolve(here, "../db/migrations/0282_scnet_glm53_flash.sql");

async function apply0282(): Promise<void> {
  const sql = await readFile(migrationPath, "utf8");
  for (const stmt of splitSqlStatements(sql)) {
    await query(stmt);
  }
}

describe("0282 scnet glm-5.3 / flash", () => {
  test("switches glm-5.3 to scnet, publishes flash, hides zai refs", { timeout: 180000 }, async (t) => {
    if (db.skipIfUnavailable(t)) return;
    await resetAndMigrateBefore("0282");
    await apply0282();

    const glm = await query<{
      provider_id: string;
      upstream_model_id: string;
      state: string;
    }>(
      `SELECT provider_id, upstream_model_id, state
         FROM model_catalog WHERE model_id='glm-5.3' AND state='active'`,
    );
    assert.equal(glm.rows.length, 1);
    assert.equal(glm.rows[0]?.provider_id, "scnet");
    assert.equal(glm.rows[0]?.upstream_model_id, "GLM-5.3");

    const flash = await query<{
      provider_id: string;
      upstream_model_id: string;
      state: string;
    }>(
      `SELECT provider_id, upstream_model_id, state
         FROM model_catalog WHERE model_id='glm-5.3-flash' AND state='active'`,
    );
    assert.equal(flash.rows.length, 1);
    assert.equal(flash.rows[0]?.provider_id, "scnet");
    assert.equal(flash.rows[0]?.upstream_model_id, "GLM-5.3-Flash");

    const flashPrice = await query<{ enabled: boolean; visibility: string; display_name: string }>(
      `SELECT enabled, visibility, display_name FROM model_pricing WHERE model_id='glm-5.3-flash'`,
    );
    assert.equal(flashPrice.rows[0]?.enabled, true);
    assert.equal(flashPrice.rows[0]?.visibility, "public");
    assert.equal(flashPrice.rows[0]?.display_name, "GLM-5.3-Flash");

    const zaiPrice = await query<{ visibility: string }>(
      `SELECT visibility FROM model_pricing WHERE model_id='glm-5.3-zai'`,
    );
    if (zaiPrice.rows.length > 0) {
      assert.equal(zaiPrice.rows[0]?.visibility, "hidden");
    }

    const helpers = await query<{ p: string; f: string; z: string }>(
      `SELECT fn_model_catalog_provider('glm-5.3') AS p,
              fn_model_catalog_provider('glm-5.3-flash') AS f,
              fn_model_catalog_provider('glm-5.3-zai') AS z`,
    );
    assert.equal(helpers.rows[0]?.p, "scnet");
    assert.equal(helpers.rows[0]?.f, "scnet");
    assert.equal(helpers.rows[0]?.z, "zai");

    const leftover = await query<{ n: string }>(
      `SELECT 'prefs' AS n FROM user_preferences WHERE prefs->>'default_model'='glm-5.3-zai'
       UNION ALL
       SELECT 'sessions' FROM client_sessions WHERE deleted_at IS NULL AND model_id='glm-5.3-zai'`,
    );
    assert.equal(leftover.rows.length, 0);

    await apply0282();
    const again = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM model_catalog
        WHERE model_id='glm-5.3' AND state='active' AND provider_id='scnet'`,
    );
    assert.equal(again.rows[0]?.n, "1");
  });
});
