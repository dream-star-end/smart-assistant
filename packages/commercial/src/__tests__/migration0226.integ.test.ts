/**
 * 0226 Cursor two-pool quota class.
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0226.integ.test.ts'
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { query } from "../db/queries.js";
import { resetAndMigrateBefore, useDedicatedTestDatabase } from "./helpers/db.js";

const db = useDedicatedTestDatabase("cursor_quota_0226_test");

describe("0226 cursor quota class", () => {
  test("adds cursor_quota_class with unknown default and a closed check", async () => {
          await resetAndMigrateBefore("0226_cursor_quota_class");

      const col = await query<{ column_default: string | null; is_nullable: string }>(
        `SELECT column_default, is_nullable
           FROM information_schema.columns
          WHERE table_name = 'claude_accounts' AND column_name = 'cursor_quota_class'`,
      );
      assert.equal(col.rows[0]?.is_nullable, "NO");
      assert.match(col.rows[0]?.column_default ?? "", /unknown/);

      const inserted = await query<{ cls: string }>(
        `INSERT INTO claude_accounts(
           provider, label, plan,
           oauth_token_enc, oauth_nonce,
           egress_proxy, egress_proxy_id,
           runtime_channel, persona
         ) VALUES (
           'cursor', 'cursor-quota-test', 'max',
           decode('00','hex'), decode('000000000000000000000000','hex'),
           NULL, NULL,
           'v5', '{}'::jsonb
         ) RETURNING cursor_quota_class AS cls`,
      );
      assert.equal(inserted.rows[0]?.cls, "unknown");

      await assert.rejects(
        () => query(
          `UPDATE claude_accounts SET cursor_quota_class = 'admin' WHERE label = 'cursor-quota-test'`,
        ),
        /cursor_quota_class|check/i,
      );
  });
});
