import assert from "node:assert/strict";
import type { Pool } from "pg";
import { tx } from "../../db/queries.js";

/** Only the private pgSessionsBackend fixture; no public-schema or product caller. */
export async function prepareSessionRowResetForTest(pool: Pool, schema: string): Promise<() => Promise<void>> {
  assert.equal(schema, "oc_p2_sessions_test");
  const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
  // Same roots as the original TRUNCATE; delete the session parent last.
  const roots = ["client_session_archive_chunks", "client_session_archived_ids",
    "server_authored_request_map", "pending_usage_patches", "turn_waivers",
    "wechat_bindings", "admin_audit", "client_sessions"];
  const qualified = roots.map((name) => `${quote(schema)}.${quote(name)}`);
  const closure = await pool.query<{ schema: string; name: string }>(`
    WITH RECURSIVE edges(child, parent) AS (
      SELECT conrelid, confrelid FROM pg_constraint WHERE contype = 'f'
      UNION SELECT inhrelid, inhparent FROM pg_inherits
    ), affected(oid) AS (
      SELECT to_regclass(identifier)::oid FROM unnest($1::text[]) AS roots(identifier)
      UNION SELECT edges.child FROM edges JOIN affected ON edges.parent = affected.oid
    ) SELECT n.nspname AS schema, c.relname AS name FROM affected
      JOIN pg_class c USING (oid) JOIN pg_namespace n ON n.oid = c.relnamespace
      ORDER BY n.nspname, c.relname
  `, [qualified]);
  assert.ok(closure.rows.length >= roots.length, "session reset must discover its original FK closure");
  const emptySql = closure.rows.map(({ schema: tableSchema, name }, index) =>
    `SELECT ${index} AS leftover WHERE EXISTS (SELECT 1 FROM ${quote(tableSchema)}.${quote(name)})`,
  ).join(" UNION ALL ");
  return async () => {
    // Deferred recovery-link constraints must be checked after the entire reset,
    // not halfway through a sequence of independently committed DELETEs.
    await tx(async (client) => {
      const identity = await client.query<{ db: string; schema: string }>(
        "SELECT current_database() AS db, current_schema() AS schema",
      );
      assert.match(identity.rows[0]?.db ?? "", /_test$/);
      assert.equal(identity.rows[0]?.schema, schema);
      for (const table of qualified) await client.query(`DELETE FROM ${table}`);
      const leftovers = await client.query<{ leftover: number }>(emptySql);
      assert.deepEqual(leftovers.rows.map(({ leftover }) => closure.rows[leftover]), [],
        "session reset must leave the entire original FK/partition closure empty");
    }, pool);
  };
}
