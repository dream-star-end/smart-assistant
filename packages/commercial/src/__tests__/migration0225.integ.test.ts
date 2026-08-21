/**
 * 0225 Cursor account-pool provider + default group.
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0225.integ.test.ts'
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { query } from "../db/queries.js";
import { resetAndMigrateBefore, useDedicatedTestDatabase } from "./helpers/db.js";

const db = useDedicatedTestDatabase("cursor_pool_0225_test");

describe("0225 cursor account pool", () => {
  test("adds cursor provider, default group, and allows cursor rows without egress", async () => {
          await resetAndMigrateBefore("0225_cursor_account_pool");

      const providers = await query<{ consrc: string }>(
        `SELECT pg_get_constraintdef(oid) AS consrc
           FROM pg_constraint
          WHERE conrelid = 'claude_accounts'::regclass
            AND conname = 'claude_accounts_provider_check'`,
      );
      assert.match(providers.rows[0]?.consrc ?? "", /cursor/);

      const groups = await query<{ provider: string; kind: string }>(
        `SELECT provider, kind FROM account_groups
          WHERE provider = 'cursor' AND kind = 'official_oauth'`,
      );
      assert.equal(groups.rows.length, 1);

      const insert = await query<{ id: string }>(
        `INSERT INTO claude_accounts(
           provider, label, plan,
           oauth_token_enc, oauth_nonce,
           egress_proxy, egress_proxy_id,
           runtime_channel, persona
         ) VALUES (
           'cursor', 'cursor-pool-test', 'max',
           decode('00','hex'), decode('000000000000000000000000','hex'),
           NULL, NULL,
           'v5', '{}'::jsonb
         ) RETURNING id::text AS id`,
      );
      assert.ok(insert.rows[0]?.id);

      await assert.rejects(
        () => query(
          `INSERT INTO claude_accounts(
             provider, label, plan,
             oauth_token_enc, oauth_nonce,
             egress_proxy, egress_proxy_id,
             runtime_channel, persona
           ) VALUES (
             'claude', 'ccb-still-needs-egress', 'max',
             decode('00','hex'), decode('000000000000000000000000','hex'),
             NULL, NULL,
             'v5', '{}'::jsonb
           )`,
        ),
        /egress|violates check/i,
      );
  });
});
