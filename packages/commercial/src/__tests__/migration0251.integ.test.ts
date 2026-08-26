/**
 * 0251 Cursor sand mode switch.
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0251.integ.test.ts'
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { generatePersona } from "../account-pool/persona.js";
import { query } from "../db/queries.js";
import { resetAndMigrateBefore, useDedicatedTestDatabase } from "./helpers/db.js";

const db = useDedicatedTestDatabase("cursor_sand_0251_test");
const here = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.resolve(here, "../db/migrations/0251_cursor_sand_mode.sql");

async function loadSql(): Promise<string> {
  return readFile(migrationPath, "utf8");
}

describe("0251 cursor sand mode", () => {
  test("adds cursor_sand_enabled with false default", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    await resetAndMigrateBefore("0251");
    await query(await loadSql());

    const col = await query<{ column_default: string | null; is_nullable: string }>(
      `SELECT column_default, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'claude_accounts' AND column_name = 'cursor_sand_enabled'`,
    );
    assert.equal(col.rows[0]?.is_nullable, "NO");
    assert.match(col.rows[0]?.column_default ?? "", /false/i);

    const inserted = await query<{ sand: boolean }>(
      `INSERT INTO claude_accounts(
         provider, label, plan,
         oauth_token_enc, oauth_nonce,
         egress_proxy, egress_proxy_id,
         runtime_channel, persona
       ) VALUES (
         'cursor', 'cursor-sand-test', 'max',
         decode('00','hex'), decode('000000000000000000000000','hex'),
         NULL, NULL,
         'v5', $1::jsonb
       ) RETURNING cursor_sand_enabled AS sand`,
      [JSON.stringify(generatePersona())],
    );
    assert.equal(inserted.rows[0]?.sand, false);

    const updated = await query<{ sand: boolean }>(
      `UPDATE claude_accounts SET cursor_sand_enabled = TRUE WHERE label = 'cursor-sand-test' RETURNING cursor_sand_enabled AS sand`,
    );
    assert.equal(updated.rows[0]?.sand, true);
  });
});
