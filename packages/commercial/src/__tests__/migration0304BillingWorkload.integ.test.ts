/**
 * 0304 billing workload column (OCV5-392): additive columns, journal-proven usage rows
 * tagged with a backup, mode/reason and amounts untouched, rollback clears the tag.
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0304BillingWorkload.integ.test.ts'
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../db/migrate.js";
import { query } from "../db/queries.js";
import { resetAndMigrateBefore, useDedicatedTestDatabase } from "./helpers/db.js";

const db = useDedicatedTestDatabase("billing_workload_0304_test");
const VERSION = "0304_billing_workload_column";
const rollbackPath = fileURLToPath(new URL(`../db/rollbacks/${VERSION}.sql`, import.meta.url));

async function user(email: string): Promise<string> {
  const r = await query<{ id: string }>(
    "INSERT INTO users(email,password_hash,role) VALUES ($1,'x','user') RETURNING id::text AS id", [email]);
  return r.rows[0]!.id;
}

/** One settled call: usage row, two-bucket ledger debits, journal row with the given ctx/state. */
async function settled(uid: string, requestId: string, ctx: Record<string, unknown>, state = "committed") {
  const u = await query<{ id: string }>(
    `INSERT INTO usage_records(user_id, mode, model, price_snapshot, cost_credits, request_id, status)
     VALUES ($1, 'chat', 'deepseek-v4-flash', '{}'::jsonb, 5, $2, 'success') RETURNING id::text AS id`,
    [uid, requestId]);
  const usageId = u.rows[0]!.id;
  const ledger: string[] = [];
  for (const [delta, bucket] of [[-3, "period"], [-2, "wallet"]] as const) {
    const l = await query<{ id: string }>(
      `INSERT INTO credit_ledger(user_id, delta, balance_after, reason, ref_type, ref_id, bucket)
       VALUES ($1, $2, 0, 'chat', 'usage_record', $3, $4) RETURNING id::text AS id`,
      [uid, delta, usageId, bucket]);
    ledger.push(l.rows[0]!.id);
  }
  await query(
    `INSERT INTO request_finalize_journal(request_id, user_id, state, ctx, precheck_credits, final_credits, usage_id, ledger_id)
     VALUES ($1, $2, $3, $4::jsonb, 20, 5, $5, $6)`,
    [requestId, uid, state, JSON.stringify({ model: "deepseek-v4-flash", ...ctx }), usageId, ledger[0]]);
  return { usageId, ledger };
}

const tags = async (usageId: string) => ({
  usage: (await query<{ mode: string; workload: string | null }>(
    "SELECT mode, workload FROM usage_records WHERE id=$1", [usageId])).rows[0],
  ledger: (await query<{ reason: string; workload: string | null }>(
    "SELECT reason, workload FROM credit_ledger WHERE ref_type='usage_record' AND ref_id=$1 ORDER BY id", [usageId])).rows,
});
const CHAT_LEDGER = [{ reason: "chat", workload: null }, { reason: "chat", workload: null }];

describe("0304 billing workload column", () => {
  test("tags only journal-proven usage rows with a backup; mode, reason and amounts are untouched", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    await resetAndMigrateBefore("0304");
    const a = await user("a@0304.test");
    const b = await user("b@0304.test");
    const dream = await settled(a, "req-dream", { workload: "auto-dream", source: "ccb_proxy" });
    const chat = await settled(a, "req-chat", { source: "ccb_proxy" });
    const cron = await settled(a, "req-cron", { workload: "cron" });
    const aborted = await settled(b, "req-aborted", { workload: "auto-dream" }, "aborted");
    const sums = async () => (await query<{ l: string; u: string }>(
      "SELECT (SELECT SUM(delta) FROM credit_ledger)::text AS l, (SELECT SUM(cost_credits) FROM usage_records)::text AS u")).rows[0];
    const before = await sums();

    assert.deepEqual((await runMigrations()).applied, [VERSION]);

    assert.deepEqual(await tags(dream.usageId), { usage: { mode: "chat", workload: "auto_dream" }, ledger: CHAT_LEDGER });
    for (const other of [chat, cron, aborted]) {
      assert.deepEqual(await tags(other.usageId), { usage: { mode: "chat", workload: null }, ledger: CHAT_LEDGER });
    }
    const backup = await query<{ usage_id: string }>(
      "SELECT usage_id::text AS usage_id FROM billing_workload_0304_backup ORDER BY usage_id");
    assert.deepEqual(backup.rows.map((r) => r.usage_id), [dream.usageId]);
    assert.deepEqual(await sums(), before, "no amount changes");

    // New debits may carry the tag; unknown tags are refused on both tables.
    await query("INSERT INTO credit_ledger(user_id, delta, balance_after, reason, workload) VALUES ($1, -1, 0, 'chat', 'auto_dream')", [a]);
    await assert.rejects(
      query("INSERT INTO credit_ledger(user_id, delta, balance_after, reason, workload) VALUES ($1, -1, 0, 'chat', 'cron')", [a]), /check/i);
    await assert.rejects(query("UPDATE usage_records SET workload='cron' WHERE id=$1", [chat.usageId]), /check/i);
    await assert.rejects(
      query("INSERT INTO credit_ledger(user_id, delta, balance_after, reason) VALUES ($1, -1, 0, 'auto_dream')", [a]), /check/i,
      "reason CHECK is unchanged");
    assert.deepEqual((await runMigrations()).applied, [], "applied once");

    // Rollback clears the usage tag and unregisters; the append-only ledger keeps its tagged row.
    await query(await readFile(rollbackPath, "utf8"));
    assert.deepEqual((await tags(dream.usageId)).usage, { mode: "chat", workload: null });
    assert.equal((await query("SELECT 1 FROM credit_ledger WHERE workload='auto_dream'")).rowCount, 1);
    assert.equal((await query("SELECT 1 FROM schema_migrations WHERE version=$1", [VERSION])).rowCount, 0);
    assert.equal((await query("SELECT count(*)::int AS n FROM billing_workload_0304_backup")).rows[0]!.n, 1, "backup kept");

    // Re-apply tags again without duplicating the backup.
    assert.deepEqual((await runMigrations()).applied, [VERSION]);
    assert.deepEqual((await tags(dream.usageId)).usage, { mode: "chat", workload: "auto_dream" });
    assert.equal((await query("SELECT count(*)::int AS n FROM billing_workload_0304_backup")).rows[0]!.n, 1);
  });
});
