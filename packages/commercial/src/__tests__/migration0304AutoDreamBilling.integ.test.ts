/**
 * 0304 Auto-Dream billing workload (OCV5-392): CHECKs widened, journal-proven rows
 * relabelled with a backup, amounts untouched, rollback restores 'chat'.
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0304AutoDreamBilling.integ.test.ts'
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../db/migrate.js";
import { query } from "../db/queries.js";
import { resetAndMigrateBefore, useDedicatedTestDatabase } from "./helpers/db.js";

const db = useDedicatedTestDatabase("auto_dream_billing_0304_test");
const VERSION = "0304_auto_dream_billing_workload";
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

const labels = async (usageId: string) => ({
  mode: (await query<{ mode: string }>("SELECT mode FROM usage_records WHERE id=$1", [usageId])).rows[0]!.mode,
  reasons: (await query<{ reason: string }>(
    "SELECT reason FROM credit_ledger WHERE ref_type='usage_record' AND ref_id=$1 ORDER BY id", [usageId])).rows.map((r) => r.reason),
});

describe("0304 auto_dream billing workload", () => {
  test("relabels only journal-proven usage rows with a backup; the append-only ledger keeps its history", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    await resetAndMigrateBefore("0304");
    const a = await user("a@0304.test");
    const b = await user("b@0304.test");
    const dream = await settled(a, "req-dream", { workload: "auto-dream", source: "ccb_proxy" });
    const chat = await settled(a, "req-chat", { source: "ccb_proxy" });
    const cron = await settled(a, "req-cron", { workload: "cron" });
    const aborted = await settled(b, "req-aborted", { workload: "auto-dream" }, "aborted");
    const sum = async () => (await query<{ s: string }>("SELECT SUM(delta)::text AS s FROM credit_ledger")).rows[0]!.s;
    const before = await sum();

    assert.deepEqual((await runMigrations()).applied, [VERSION]);

    assert.deepEqual(await labels(dream.usageId), { mode: "auto_dream", reasons: ["chat", "chat"] });
    for (const other of [chat, cron, aborted]) {
      assert.deepEqual(await labels(other.usageId), { mode: "chat", reasons: ["chat", "chat"] });
    }
    const backup = await query<{ table_name: string; row_id: string; old_value: string }>(
      "SELECT table_name, row_id::text, old_value FROM billing_workload_0304_backup ORDER BY row_id");
    assert.deepEqual(backup.rows.map((r) => [r.table_name, r.row_id, r.old_value]), [["usage_records", dream.usageId, "chat"]]);
    assert.equal(await sum(), before, "no amount changes");

    // New debits may carry the label (insert-only); unknown labels are still refused.
    await query("INSERT INTO credit_ledger(user_id, delta, balance_after, reason) VALUES ($1, -1, 0, 'auto_dream')", [a]);
    await assert.rejects(
      query("INSERT INTO credit_ledger(user_id, delta, balance_after, reason) VALUES ($1, -1, 0, 'dream')", [a]), /check/i);
    await assert.rejects(query("UPDATE usage_records SET mode='cron' WHERE id=$1", [chat.usageId]), /check/i);
    assert.deepEqual((await runMigrations()).applied, [], "applied once");

    // Rollback with an append-only auto_dream ledger row: usage reverts, ledger CHECK stays widened.
    await query(await readFile(rollbackPath, "utf8"));
    assert.deepEqual(await labels(dream.usageId), { mode: "chat", reasons: ["chat", "chat"] });
    await assert.rejects(query("UPDATE usage_records SET mode='auto_dream' WHERE id=$1", [dream.usageId]), /check/i);
    assert.equal((await query("SELECT 1 FROM credit_ledger WHERE reason='auto_dream'")).rowCount, 1);
    assert.equal((await query("SELECT 1 FROM schema_migrations WHERE version=$1", [VERSION])).rowCount, 0);
    assert.equal((await query("SELECT count(*)::int AS n FROM billing_workload_0304_backup")).rows[0]!.n, 1, "backup kept");

    // Re-apply relabels again without duplicating the backup.
    assert.deepEqual((await runMigrations()).applied, [VERSION]);
    assert.deepEqual(await labels(dream.usageId), { mode: "auto_dream", reasons: ["chat", "chat"] });
    assert.equal((await query("SELECT count(*)::int AS n FROM billing_workload_0304_backup")).rows[0]!.n, 1);
  });

  test("rollback restores the old ledger CHECK when no auto_dream debit exists", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    await resetAndMigrateBefore("0304");
    const a = await user("c@0304.test");
    assert.deepEqual((await runMigrations()).applied, [VERSION]);
    await query(await readFile(rollbackPath, "utf8"));
    await assert.rejects(
      query("INSERT INTO credit_ledger(user_id, delta, balance_after, reason) VALUES ($1, -1, 0, 'auto_dream')", [a]), /check/i);
  });
});
