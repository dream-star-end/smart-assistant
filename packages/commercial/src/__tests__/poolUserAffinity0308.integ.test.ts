/**
 * OCV5-424 集成:按用户粘性(migration 0308 pool_user_affinity,docs/ocv5-424-user-affinity.md)。
 *
 * 覆盖:
 *   1. 同一用户的所有请求(不同会话)落同一成员;第二个用户按负载分到另一个成员
 *   2. 持续不可用(停用)迁移并记 pool_events;原成员恢复后不迁回
 *   3. 短冷却只溢出,绑定不变
 *   4. 同一用户并发首次绑定只产生一个绑定
 *   5. Antigravity:同一用户多轮不再按最久未用轮换
 *   6. API key 池:同一用户不同会话固定同一个 key
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { KMS_KEY_BYTES } from "../crypto/keys.js";
import { resetTestSchemaForTest } from "./helpers/db.js";
import {
  _resetAffinityCapsForTest,
  _resetAffinityTouchForTest,
  readAffinity,
  resolveAffinity,
  type AffinityCandidate,
  type BoundMemberState,
} from "../account-pool/policy/affinity.js";
import { pickAntigravityAccount, reportAntigravityOutcome } from "../account-pool/antigravityPool.js";
import { invalidateApiKeyPoolCache, selectApiKey, upsertApiKey } from "../account-pool/apiKeyPool.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://test:test@127.0.0.1:55432/openclaude_test";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";
let pgAvailable = false;
const KEY = randomBytes(KMS_KEY_BYTES);
const keyFn = (): Buffer => Buffer.from(KEY);

async function probe(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 });
  try { await p.query("SELECT 1"); await p.end(); return true; }
  catch { try { await p.end(); } catch { /* */ } return false; }
}

before(async () => {
  pgAvailable = await probe();
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error("Postgres test fixture required");
    return;
  }
  await resetPool();
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 10 }));
  await resetTestSchemaForTest();
  await runMigrations();
});

after(async () => {
  if (pgAvailable) {
    try { await resetTestSchemaForTest(); } catch { /* */ }
    await closePool();
  }
});

beforeEach(async () => {
  if (!pgAvailable) return;
  await query("TRUNCATE TABLE pool_user_affinity, pool_events, gemini_oauth_accounts, pool_api_keys RESTART IDENTITY CASCADE");
  _resetAffinityTouchForTest();
  _resetAffinityCapsForTest();
  invalidateApiKeyPoolCache();
});

function skipIfNoDb(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) { t.skip("pg not available"); return true; }
  return false;
}

const c = (id: string): AffinityCandidate => ({ memberKind: "account", id, capacity: 1 });
const states = new Map<string, BoundMemberState>();
const boundState = async (b: { memberId: string }) => states.get(b.memberId) ?? { status: "active", cooldownReason: null, cooldownUntil: null };

describe("pool_user_affinity", () => {
  test("one user's requests (any session) stay on one member; a second user is spread to the other", async (t) => {
    if (skipIfNoDb(t)) return;
    states.clear();
    const first = await resolveAffinity({ service: "svc", userId: 3n, candidates: [c("1"), c("2")], boundState });
    assert.equal(first?.action, "bind");
    for (let i = 0; i < 4; i++) {
      const again = await resolveAffinity({ service: "svc", userId: 3n, candidates: [c("2"), c("1")], boundState });
      assert.equal(again?.action, "stay");
      assert.equal(again?.member.id, first?.member.id);
    }
    const other = await resolveAffinity({ service: "svc", userId: 4n, candidates: [c("1"), c("2")], boundState });
    assert.notEqual(other?.member.id, first?.member.id, "least loaded member for a new user");
    const ev = await query<{ outcome: string }>("SELECT outcome FROM pool_events ORDER BY id");
    assert.deepEqual(ev.rows.map((r) => r.outcome), ["affinity_bind", "affinity_bind"]);
  });

  test("a persistently unavailable member migrates once; recovery does not move the user back", async (t) => {
    if (skipIfNoDb(t)) return;
    states.clear();
    await resolveAffinity({ service: "svc", userId: 3n, candidates: [c("1")], boundState });
    states.set("1", { status: "disabled", cooldownReason: null, cooldownUntil: null });
    const moved = await resolveAffinity({ service: "svc", userId: 3n, candidates: [c("2")], boundState });
    assert.equal(moved?.action, "migrate");
    const b = await readAffinity("svc", 3n);
    assert.equal(b?.memberId, "2");
    const row = await query<{ prev_member_id: string; migrate_reason: string }>("SELECT prev_member_id, migrate_reason FROM pool_user_affinity");
    assert.deepEqual(row.rows[0], { prev_member_id: "1", migrate_reason: "disabled" });
    states.delete("1");
    const back = await resolveAffinity({ service: "svc", userId: 3n, candidates: [c("1"), c("2")], boundState });
    assert.equal(back?.member.id, "2", "the new member stays the target");
    const ev = await query<{ outcome: string; reason: string | null }>("SELECT outcome, reason FROM pool_events ORDER BY id");
    assert.deepEqual(ev.rows.map((r) => [r.outcome, r.reason]), [["affinity_bind", null], ["affinity_migrate", "disabled"]]);
  });

  test("a short cooldown spills for that request only; the binding is unchanged", async (t) => {
    if (skipIfNoDb(t)) return;
    states.clear();
    await resolveAffinity({ service: "svc", userId: 3n, candidates: [c("1")], boundState });
    states.set("1", { status: "cooldown", cooldownReason: "rate_limited", cooldownUntil: new Date(Date.now() + 60_000) });
    const spill = await resolveAffinity({ service: "svc", userId: 3n, candidates: [c("2")], boundState });
    assert.equal(spill?.action, "spill");
    assert.equal(spill?.member.id, "2");
    assert.equal((await readAffinity("svc", 3n))?.memberId, "1");
    states.delete("1");
    assert.equal((await resolveAffinity({ service: "svc", userId: 3n, candidates: [c("1"), c("2")], boundState }))?.member.id, "1");
  });

  test("concurrent first requests of one user end on one binding", async (t) => {
    if (skipIfNoDb(t)) return;
    states.clear();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        resolveAffinity({ service: "svc", userId: 9n, candidates: i % 2 ? [c("1"), c("2")] : [c("2"), c("1")], boundState }),
      ),
    );
    const n = await query<{ n: string }>("SELECT count(*)::text AS n FROM pool_user_affinity WHERE user_id = 9");
    assert.equal(n.rows[0].n, "1");
    const winner = (await readAffinity("svc", 9n))?.memberId;
    for (const r of results) assert.equal(r?.member.id, winner);
  });

  test("Antigravity: one user keeps one Google account across turns instead of rotating by last use", async (t) => {
    if (skipIfNoDb(t)) return;
    for (const email of ["a1@example.com", "a2@example.com"]) {
      await query(
        "INSERT INTO gemini_oauth_accounts (label, email, refresh_token_enc, refresh_token_nonce) VALUES ($1, $2, $3, $4)",
        [email, email, randomBytes(48), randomBytes(12)],
      );
    }
    const first = await pickAntigravityAccount({ userId: 3n });
    assert.equal(first?.affinity, "bind");
    for (let turn = 0; turn < 4; turn++) {
      await reportAntigravityOutcome(first!.accountId, { kind: "success" }, null); // makes it the most recently used
      const next = await pickAntigravityAccount({ userId: 3n });
      assert.equal(next?.accountId, first?.accountId, `turn ${turn + 2} stays`);
    }
    const legacy = await pickAntigravityAccount();
    assert.notEqual(legacy?.accountId, first?.accountId, "without a user the old least-recently-used order still applies");
  });

  test("API keys: one user keeps one key across sessions within the best tier", async (t) => {
    if (skipIfNoDb(t)) return;
    await upsertApiKey({ service: "deepseek", apiKey: "deepseek-key-aaaa1111", source: "admin", keyFn });
    await upsertApiKey({ service: "deepseek", apiKey: "deepseek-key-bbbb2222", source: "admin", keyFn });
    const picks = new Set<string>();
    for (let s = 0; s < 6; s++) {
      const k = await selectApiKey("deepseek", `session-${s}`, keyFn, { userId: 3n });
      picks.add(k!.memberId);
    }
    assert.equal(picks.size, 1, "same key for every session of the user");
    const b = await readAffinity("apikey:deepseek", 3n);
    assert.equal(b?.memberKind, "api_key");
  });
});
