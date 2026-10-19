import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../db/migrate.js";
import { query } from "../db/queries.js";
import { generatePersona } from "../account-pool/persona.js";
import { resetAndMigrateBefore, useDedicatedTestDatabase } from "./helpers/db.js";
import { listBoxProfileQuotas, writeBoxProfileHealth } from "../http/proxy/boxClaudeProfileStore.js";
import { collectBoxClaude } from "../http/admin/boxClaudePool.js";

const db = useDedicatedTestDatabase("box_profile_quota_0309_test");
const sqlPath = fileURLToPath(new URL("../db/migrations/0309_box_profile_quota_windows.sql", import.meta.url));

async function login(label: string, profile: string): Promise<bigint> {
  const r = await query<{ id: string }>(
    `INSERT INTO claude_accounts(label, plan, provider, oauth_token_enc, oauth_nonce, persona) VALUES ($1,'pro','cursor',$2,$3,$4::jsonb) RETURNING id::text AS id`,
    [label, Buffer.from("x"), Buffer.from("n"), JSON.stringify(generatePersona())]);
  const id = BigInt(r.rows[0]!.id);
  await query("INSERT INTO box_claude_profiles(account_id, profile, enabled, is_default, login_state) VALUES ($1,$2,true,true,'logged_in')",
    [id.toString(), profile]);
  return id;
}
const state = (at: number, windows?: object) => ({ utilization: 0.3, cooldownUntilMs: null, lastReason: null, updatedAtMs: at, ...(windows ? { windows } : {}) });

describe("0309 box_claude_profiles quota windows", () => {
  test("windows persist per window; a missing window keeps its value; an older report is dropped", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    const id = await login("q1", "default");
    const t0 = Date.now();
    await writeBoxProfileHealth(id, "default", state(t0, {
      fiveHour: { utilization: 0.12, resetsAtMs: t0 + 7_200_000 }, sevenDay: { utilization: 0.4, resetsAtMs: t0 + 86_400_000 } }));
    await writeBoxProfileHealth(id, "default", state(t0 + 1_000, { fiveHour: { utilization: 0.2, resetsAtMs: null } }));
    await writeBoxProfileHealth(id, "default", state(t0 - 60_000, { fiveHour: { utilization: 0.9, resetsAtMs: null } }));
    const [q] = (await listBoxProfileQuotas()).filter((x) => x.accountId === id);
    assert.ok(Math.abs(q!.quota5h! - 0.2) < 1e-6);
    assert.equal(q!.quota5hResetsAt, null);
    assert.ok(Math.abs(q!.quota7d! - 0.4) < 1e-6);
    assert.equal(q!.quota7dResetsAt!.getTime(), t0 + 86_400_000);
  });

  test("the admin view shows the windows, the two routes and the caps", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    const id = await login("q2", "default");
    const at = Date.now();
    await writeBoxProfileHealth(id, "default", state(at, { sevenDay: { utilization: 0.5, resetsAtMs: at + 3_600_000 } }));
    const view = await collectBoxClaude(async () => ({ by_model: { "box-claude-opus-5-5": { current: 2, peak: 4, peak_at: "" } }, source: "local", started_at: "" }),
      { OC_BOX_MAX_RUNS_PER_ACCOUNT: "3" });
    assert.deepEqual(view.routes.map((r) => r.key), ["A", "B"]);
    assert.ok(view.routes[0]!.models.every((m) => m.id.startsWith("box-api-")));
    assert.deepEqual(view.routes[1]!.models.find((m) => m.id === "box-claude-opus-5-5")!.inflight, { current: 2, peak: 4 });
    assert.equal(view.caps.max_runs_per_account, 3);
    const mine = view.logins.find((l) => l.account_id === id.toString())!;
    assert.equal(mine.quota.five_hour, null);
    assert.deepEqual(mine.quota.weekly, { used: 0.5, resets_at: new Date(at + 3_600_000).toISOString() });
    assert.equal(mine.quota.reason, null);
  });

  test("the rollback block drops the columns; the reader and writer degrade; the migration applies again", { timeout: 240000 }, async (t) => {
    if (db.skipIfUnavailable(t)) return;
    // Roll back the real 0309 boundary, even when the full chain has later migrations.
    await resetAndMigrateBefore("0310");
    await login("rollback-boundary", "default");
    const block = /-- BEGIN TESTED MANUAL ROLLBACK 0309\n([\s\S]*?)-- END TESTED MANUAL ROLLBACK 0309/.exec(await readFile(sqlPath, "utf8"))![1]!;
    await query(block.split("\n").map((line) => line.replace(/^-- ?/, "")).join("\n"));
    assert.deepEqual(await listBoxProfileQuotas(), []);
    const id = await login("q3", "default");
    await writeBoxProfileHealth(id, "default", state(Date.now(), { fiveHour: { utilization: 0.1, resetsAtMs: null } }));
    assert.ok((await runMigrations()).applied.includes("0309_box_profile_quota_windows"));
    assert.deepEqual((await runMigrations()).applied, []);
  });
});
