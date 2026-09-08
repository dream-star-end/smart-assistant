import assert from "node:assert/strict";
import { query, tx, type QueryRunner } from "../../db/queries.js";
import { truncateAllForTest } from "./db.js";

/** Auth-only fixture: keep real multi-connection business transactions outside reset. */
export async function prepareAuthRowResetForTest(
  beforeUserCleanup?: (runner: QueryRunner) => Promise<void>,
): Promise<() => Promise<void>> {
  // Preserve the original clean start after the complete production migration chain.
  await truncateAllForTest(["refresh_tokens", "email_verifications", "users"]);
  const closure = await query<{ schema: string; name: string; append_only_reset: boolean }>(`
    WITH RECURSIVE edges(child, parent) AS (
      SELECT conrelid, confrelid FROM pg_constraint WHERE contype = 'f'
      UNION SELECT inhrelid, inhparent FROM pg_inherits
    ), affected(oid) AS (
      SELECT unnest(ARRAY['public.users'::regclass::oid,
        'public.refresh_tokens'::regclass::oid, 'public.email_verifications'::regclass::oid])
      UNION SELECT edges.child FROM edges JOIN affected ON edges.parent = affected.oid
    ), append_affected(oid) AS (
      SELECT unnest(ARRAY['public.credit_ledger'::regclass::oid, 'public.admin_audit'::regclass::oid])
      UNION SELECT edges.child FROM edges JOIN append_affected ON edges.parent = append_affected.oid
    )
    SELECT n.nspname AS schema, c.relname AS name,
      c.oid IN (SELECT oid FROM append_affected) AS append_only_reset
    FROM affected JOIN pg_class c USING (oid) JOIN pg_namespace n ON n.oid = c.relnamespace
    ORDER BY n.nspname, c.relname
  `);
  assert.ok(closure.rows.length >= 3, "auth fixture must discover its real FK/partition closure");
  const quote = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;
  const emptinessSql = closure.rows.map(({ schema, name }, index) =>
    `SELECT ${index} AS leftover WHERE EXISTS (SELECT 1 FROM ${quote(schema)}.${quote(name)})`,
  ).join(" UNION ALL ");
  // Cache schema identity, never row state. Nullable FK children can contain rows
  // even when both append-only roots are empty; inspect their complete closure.
  const appendTables = closure.rows.filter((row) => row.append_only_reset);
  assert.ok(appendTables.some((row) => row.schema === "public" && row.name === "credit_ledger"));
  assert.ok(appendTables.some((row) => row.schema === "public" && row.name === "admin_audit"));
  const appendNames = appendTables.map(({ schema, name }) => `${quote(schema)}.${quote(name)}`);
  const appendEmptySql = appendNames.map((name) =>
    `SELECT 1 WHERE EXISTS (SELECT 1 FROM ${name})`,
  ).join(" UNION ALL ");
  return async () => {
    await tx(async (client) => {
      // Preserve the _test guard even on the empty fast path. Lock the same full
      // closure as TRUNCATE, in stable schema/name order, before checking rows.
      const identity = await client.query<{ db: string; schema: string }>("SELECT current_database() AS db, current_schema() AS schema");
      assert.match(identity.rows[0]?.db ?? "", /_test$/);
      assert.equal(identity.rows[0]?.schema, "public");
      await client.query(`LOCK TABLE ${appendNames.join(", ")} IN ACCESS EXCLUSIVE MODE`);
      if ((await client.query(appendEmptySql)).rowCount) {
        // DELETE is forbidden here; any root/nullable-child data still takes the
        // original guarded TRUNCATE. Empty tables need no physical rewrite.
        await truncateAllForTest(["credit_ledger", "admin_audit"], client as unknown as QueryRunner);
      }
      // HTTP-only SET NULL/anonymous rows are cleared under the same _test guard.
      if (beforeUserCleanup) await beforeUserCleanup(client as unknown as QueryRunner);
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
