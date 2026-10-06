import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../db/migrate.js";
import { query } from "../db/queries.js";
import { generatePersona } from "../account-pool/persona.js";
import { resetAndMigrateBefore, useDedicatedTestDatabase } from "./helpers/db.js";
import { BoxProfileSelectionError, listBoxProfiles, recordBoxDiscovery, setBoxProfileSelection, boxProfilesAvailable,
  writeBoxProfileHealth, type BoxDiscoveredProfile } from "../http/proxy/boxClaudeProfileStore.js";

const db = useDedicatedTestDatabase("commercial_box_claude_profiles_0299_test");
const sqlPath = fileURLToPath(new URL("../db/migrations/0299_commercial_box_claude_profiles.sql", import.meta.url));

async function account(label: string): Promise<bigint> {
  const r = await query<{ id: string }>(
    `INSERT INTO claude_accounts(label, plan, provider, oauth_token_enc, oauth_nonce, persona) VALUES ($1,'pro','cursor',$2,$3,$4::jsonb) RETURNING id::text AS id`,
    [label, Buffer.from("x"), Buffer.from("n"), JSON.stringify(generatePersona())]);
  return BigInt(r.rows[0]!.id);
}
const found = (profile: string, over: Partial<BoxDiscoveredProfile> = {}): BoxDiscoveredProfile => ({ profile,
  loginState: "logged_in", projectsMode: profile === "default" ? "root" : "shared", emailHint: "a***@b***.com",
  accountFingerprint: profile.padEnd(12, "0").slice(0, 12).replace(/[^0-9a-f]/g, "a"), orgType: "claude_pro", ...over });
const rollbackBlock = async () => {
  const block = /-- BEGIN TESTED MANUAL ROLLBACK 0299\n([\s\S]*?)-- END TESTED MANUAL ROLLBACK 0299/.exec(await readFile(sqlPath, "utf8"))![1]!;
  return block.split("\n").map((line) => line.replace(/^-- ?/, "")).join("\n");
};

describe("0299 box_claude_profiles", () => {
  test("the full chain creates the table and a second run changes nothing", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    assert.equal((await query("SELECT to_regclass('public.box_claude_profiles') AS t")).rows[0]!.t, "box_claude_profiles");
    assert.deepEqual((await runMigrations()).applied, []);
  });

  test("constraints: names, one default per account, a default must be enabled, cascade on delete", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    const a = await account("c1"), b = await account("c2");
    const ins = (id: bigint, profile: string, enabled: boolean, isDefault: boolean) => query(
      "INSERT INTO box_claude_profiles(account_id, profile, enabled, is_default) VALUES ($1,$2,$3,$4)", [id.toString(), profile, enabled, isDefault]);
    await ins(a, "default", true, true);
    await ins(a, "b", true, false);
    await assert.rejects(ins(a, "c", true, true), /idx_bcp_one_default/);
    await assert.rejects(ins(a, "d", false, true), /check/i);
    for (const bad of ["Default", "../x", "-x", "x".repeat(40), ""]) {
      await assert.rejects(ins(b, bad, false, false), /check/i, bad);
    }
    await ins(b, "default", true, true);   // another account may have its own default
    await query("DELETE FROM claude_accounts WHERE id=$1", [a.toString()]);
    assert.equal((await listBoxProfiles([a])).length, 0, "rows go with the account");
    assert.equal((await listBoxProfiles([b])).length, 1);
  });

  test("discovery: the first pass turns the default on, later passes keep the admin's choice and flag vanished logins", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    const id = await account("d1");
    let rows = await recordBoxDiscovery(id, [found("default"), found("b"), found("own", { projectsMode: "own" })]);
    assert.deepEqual(rows.map((r) => [r.profile, r.enabled, r.isDefault]), [["b", false, false], ["default", true, true], ["own", false, false]]);
    await setBoxProfileSelection(id, { enabled: ["default", "b"], defaultProfile: "b", updatedBy: null });
    rows = await recordBoxDiscovery(id, [found("default"), found("b", { emailHint: "z***@y***.com" })]);
    const by = Object.fromEntries(rows.map((r) => [r.profile, r]));
    assert.deepEqual([by.b!.enabled, by.b!.isDefault, by.b!.emailHint], [true, true, "z***@y***.com"]);
    assert.deepEqual([by.default!.enabled, by.default!.isDefault], [true, false]);
    assert.equal(by.own!.loginState, "logged_out", "a login that vanished from the Box is flagged, not deleted");
  });

  test("an account that is not logged in on its default login is not auto-enabled", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    const id = await account("d2");
    const rows = await recordBoxDiscovery(id, [found("default", { loginState: "logged_out" })]);
    assert.deepEqual(rows.map((r) => [r.enabled, r.isDefault]), [[false, false]]);
  });

  test("selection refuses anything that cannot serve: none, unknown, logged out, own projects, default not ticked", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    const id = await account("s1");
    await recordBoxDiscovery(id, [found("default"), found("b"), found("out", { loginState: "logged_out" }),
      found("own", { projectsMode: "own" }), found("new", { projectsMode: "absent" })]);
    const code = async (enabled: string[], d: string) => {
      try { await setBoxProfileSelection(id, { enabled, defaultProfile: d, updatedBy: null }); return "ok"; }
      catch (e) { return e instanceof BoxProfileSelectionError ? e.code : String(e); }
    };
    assert.equal(await code([], "default"), "BOX_PROFILE_NONE_ENABLED");
    assert.equal(await code(["default"], "b"), "BOX_PROFILE_DEFAULT_NOT_ENABLED");
    assert.equal(await code(["default", "ghost"], "default"), "BOX_PROFILE_UNKNOWN");
    assert.equal(await code(["default", "out"], "default"), "BOX_PROFILE_NOT_LOGGED_IN");
    assert.equal(await code(["default", "own"], "default"), "BOX_PROFILE_PROJECTS_NOT_SHARED");
    assert.equal(await code(["default", "new"], "default"), "BOX_PROFILE_PROJECTS_NOT_SHARED");
    assert.equal(await code(["default", "b"], "b"), "ok");
    assert.deepEqual((await listBoxProfiles([id])).filter((r) => r.enabled).map((r) => r.profile), ["b", "default"]);
    assert.deepEqual((await listBoxProfiles([id])).filter((r) => r.isDefault).map((r) => r.profile), ["b"]);
  });

  test("health mirror: newer wins, an older write is ignored", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    const id = await account("h1");
    await recordBoxDiscovery(id, [found("default")]);
    await writeBoxProfileHealth(id, "default", { utilization: 1.04, cooldownUntilMs: Date.now() + 3_600_000, lastReason: "quota_exhausted", updatedAtMs: Date.now() });
    await writeBoxProfileHealth(id, "default", { utilization: 0.1, cooldownUntilMs: null, lastReason: null, updatedAtMs: Date.now() - 60_000 });
    const [row] = await listBoxProfiles([id]);
    assert.equal(row!.lastReason, "quota_exhausted");
    assert.ok(row!.cooldownUntil && row!.cooldownUntil.getTime() > Date.now());
    assert.ok(Math.abs(row!.utilization! - 1.04) < 0.001);
  });

  test("the rollback block removes the table and its ledger row, and the migration applies again", { timeout: 240000 }, async (t) => {
    if (db.skipIfUnavailable(t)) return;
    await resetAndMigrateBefore("0299");
    assert.deepEqual((await runMigrations()).applied, ["0299_commercial_box_claude_profiles"]);
    await query(await rollbackBlock());
    assert.equal((await query("SELECT to_regclass('public.box_claude_profiles') AS t")).rows[0]!.t, null);
    assert.equal((await query("SELECT 1 FROM schema_migrations WHERE version='0299_commercial_box_claude_profiles'")).rowCount, 0);
    assert.deepEqual(await listBoxProfiles([1n]), [], "reads degrade to no rows when the table is gone");
    assert.equal(await boxProfilesAvailable(), false);
    assert.deepEqual((await runMigrations()).applied, ["0299_commercial_box_claude_profiles"]);
    assert.equal(await boxProfilesAvailable(), true);
  });
});
