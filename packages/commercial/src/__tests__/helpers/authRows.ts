import assert from "node:assert/strict";
import { query, tx, type QueryRunner } from "../../db/queries.js";
import { truncateAllForTest } from "./db.js";

/** Auth-only fixture: keep real multi-connection business transactions outside reset. */
export async function prepareAuthRowResetForTest(): Promise<() => Promise<void>> {
  // Preserve the original clean start after the complete production migration chain.
  await truncateAllForTest(["refresh_tokens", "email_verifications", "users"]);
  const closure = await query<{ schema: string; name: string }>(`
    WITH RECURSIVE edges(child, parent) AS (
      SELECT conrelid, confrelid FROM pg_constraint WHERE contype = 'f'
      UNION SELECT inhrelid, inhparent FROM pg_inherits
    ), affected(oid) AS (
      SELECT unnest(ARRAY['public.users'::regclass::oid,
        'public.refresh_tokens'::regclass::oid, 'public.email_verifications'::regclass::oid])
      UNION SELECT edges.child FROM edges JOIN affected ON edges.parent = affected.oid
    )
    SELECT n.nspname AS schema, c.relname AS name
    FROM affected JOIN pg_class c USING (oid) JOIN pg_namespace n ON n.oid = c.relnamespace
    ORDER BY n.nspname, c.relname
  `);
  assert.ok(closure.rows.length >= 3, "auth fixture must discover its real FK/partition closure");
  const quote = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;
  const emptinessSql = closure.rows.map(({ schema, name }, index) =>
    `SELECT ${index} AS leftover WHERE EXISTS (SELECT 1 FROM ${quote(schema)}.${quote(name)})`,
  ).join(" UNION ALL ");
  return async () => {
    await tx(async (client) => {
      // These append-only tables reject DELETE by design. Reuse the existing _test
      // database guard and let PostgreSQL discover their much smaller CASCADE closure.
      await truncateAllForTest(["credit_ledger", "admin_audit"], client as unknown as QueryRunner);
      // user_subscriptions is RESTRICT, not CASCADE. Auth token deletion retains
      // the original reset semantics even for a nullable/unowned token row.
      await client.query("DELETE FROM user_subscriptions");
      await client.query("DELETE FROM refresh_tokens");
      await client.query("DELETE FROM email_verifications");
      await client.query("DELETE FROM users");
      const leftovers = await client.query<{ leftover: number }>(emptinessSql);
      assert.deepEqual(leftovers.rows.map(({ leftover }) => closure.rows[leftover]), [],
        "auth reset must leave the entire original FK/partition closure empty");
    });
  };
}
