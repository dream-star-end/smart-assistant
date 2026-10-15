/**
 * OCV5-424 集成:分服务池 + 统一调度策略在真 PG 上的行为(migration 0306)。
 *
 * 覆盖:
 *   1. 认证失效不再写 disabled:auth 冷却 + next_probe_at,写 pool_events
 *   2. 半开只恢复普通冷却,认证冷却等探测;探测成功回 active、失败加大退避
 *   3. 探测失败但冷却已被刷新路径推后 → 不重复加级
 *   4. 429 按 Retry-After 立即冷却;管理员停用的账号不被策略改动
 *   5. 管理员停用在同一条 UPDATE 写 disabled_by='admin',启用清除
 *   6. session pin:认证冷却对 pin 视同终态,短限流冷却仍是瞬时
 *   7. API-key 池:导入/去重/选 key/上报冷却/半开/管理员启停/env 轮换
 *   8. Gemini 池:Antigravity 订阅账号(gemini_oauth_accounts)是服务池成员,认证冷却由
 *      共享 actor 探测(refresh 成功回 active,invalid_grant 加大退避,未配置时稍后再探)
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { KMS_KEY_BYTES } from "../crypto/keys.js";
import { createAccount, getAccount, readAccountRecoveryHint, updateAccount } from "../account-pool/store.js";
import { AccountHealthTracker, InMemoryHealthRedis } from "../account-pool/health.js";
import {
  apiKeyPoolConfiguredServices,
  apiKeyPoolHasMembers,
  createApiKeyPoolAdapter,
  importEnvApiKeys,
  invalidateApiKeyPoolCache,
  listApiKeyMembers,
  reportApiKeyOutcome,
  selectApiKey,
  setApiKeyAdminStatus,
  upsertApiKey,
} from "../account-pool/apiKeyPool.js";
import { createGeminiPoolAdapter } from "../account-pool/geminiPoolAdapter.js";
import { pickAntigravityAccount, reportAntigravityOutcome } from "../account-pool/antigravityPool.js";
import { AntigravityOAuthError } from "../account-pool/antigravityOAuth.js";
import { GEMINI_OAUTH_MEMBERS, applyTableMemberOutcome } from "../account-pool/policy/tableMembers.js";
import { _resetPoolRegistryForTest, registerPoolAdapter } from "../account-pool/policy/registry.js";
import { collectPools } from "../http/admin/pools.js";
import { resetTestSchemaForTest } from "./helpers/db.js";
import { insertTestEgressProxy } from "./helpers/accountFixture.js";

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
  await query("TRUNCATE TABLE usage_records, claude_accounts, pool_api_keys, pool_events, gemini_oauth_accounts RESTART IDENTITY CASCADE");
  invalidateApiKeyPoolCache();
});

function skipIfNoDb(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) { t.skip("pg not available"); return true; }
  return false;
}

async function freshAccount(): Promise<bigint> {
  const a = await createAccount({ runtime_channel: "v3", label: "pool-test", plan: "pro", token: "T", egress_proxy_id: await insertTestEgressProxy(KEY) }, keyFn);
  return a.id;
}

async function row(id: bigint) {
  const r = await query<{ status: string; cooldown_reason: string | null; cooldown_until: Date | null; next_probe_at: Date | null; backoff_level: number; health_score: number; disabled_by: string | null }>(
    "SELECT status, cooldown_reason, cooldown_until, next_probe_at, backoff_level, health_score, disabled_by FROM claude_accounts WHERE id = $1",
    [id.toString()],
  );
  return r.rows[0];
}

const tracker = () => new AccountHealthTracker({ redis: new InMemoryHealthRedis() });

describe("shared policy on claude_accounts", () => {
  test("auth_invalid cools with a probe instead of disabling, and logs a pool_event", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await freshAccount();
    const h = await tracker().applyOutcome(id, { kind: "auth_invalid", detail: "refresh_http_400" }, { errorMsg: "refresh_http_400" });
    assert.equal(h?.status, "cooldown");
    const r = await row(id);
    assert.equal(r.status, "cooldown");
    assert.equal(r.cooldown_reason, "auth");
    assert.ok(r.next_probe_at, "auth cooldown carries next_probe_at");
    assert.equal(r.backoff_level, 1);
    assert.equal(r.disabled_by, null);
    const ev = await query<{ outcome: string; to_status: string }>("SELECT outcome, to_status FROM pool_events WHERE member_id = $1", [id.toString()]);
    assert.equal(ev.rows.length, 1);
    assert.equal(ev.rows[0].to_status, "cooldown");
  });

  test("halfOpen reactivates plain cooldowns only; auth waits for the probe", async (t) => {
    if (skipIfNoDb(t)) return;
    const plain = await freshAccount();
    const auth = await freshAccount();
    const tr = tracker();
    await tr.applyOutcome(plain, { kind: "rate_limited", retryAfterMs: 20_000 });
    await tr.applyOutcome(auth, { kind: "auth_invalid" });
    await query("UPDATE claude_accounts SET cooldown_until = NOW() - INTERVAL '1 second'");
    const recovered = await tr.halfOpen();
    assert.deepEqual(recovered.map((h) => h.id), [plain]);
    assert.equal((await row(auth)).status, "cooldown");
    const due = await tr.listDueProbes(10);
    assert.deepEqual(due.map((d) => d.id), [auth]);
  });

  test("probe success reactivates at half health; probe failure escalates the backoff", async (t) => {
    if (skipIfNoDb(t)) return;
    const a = await freshAccount();
    const b = await freshAccount();
    const tr = tracker();
    await tr.applyOutcome(a, { kind: "auth_invalid" });
    await tr.applyOutcome(b, { kind: "credential_corrupt" });
    await query("UPDATE claude_accounts SET cooldown_until = NOW() - INTERVAL '1 second'");
    await tr.applyProbeResult(a, { ok: true });
    const ra = await row(a);
    assert.equal(ra.status, "active");
    assert.equal(ra.health_score, 50);
    assert.equal(ra.cooldown_reason, null);
    await tr.applyProbeResult(b, { ok: false, detail: "decrypt_failed" });
    const rb = await row(b);
    assert.equal(rb.status, "cooldown");
    assert.equal(rb.cooldown_reason, "credential");
    assert.equal(rb.backoff_level, 2);
    assert.ok(rb.cooldown_until && rb.cooldown_until.getTime() > Date.now() + 50 * 60_000);
  });

  test("a failed probe does not escalate twice when the refresh path already pushed the cooldown", async (t) => {
    if (skipIfNoDb(t)) return;
    const a = await freshAccount();
    const tr = tracker();
    await tr.applyOutcome(a, { kind: "auth_invalid" });
    await query("UPDATE claude_accounts SET cooldown_until = NOW() - INTERVAL '1 second'");
    // refresh.ts disableOnFailure → applyOutcome(auth) during the probe
    await tr.applyOutcome(a, { kind: "auth_invalid" });
    const mid = await row(a);
    assert.equal(mid.backoff_level, 2);
    await tr.applyProbeResult(a, { ok: false, detail: "refresh_http_error" });
    assert.equal((await row(a)).backoff_level, 2);
  });

  test("transient probe results re-check soon without escalating", async (t) => {
    if (skipIfNoDb(t)) return;
    const a = await freshAccount();
    const tr = tracker();
    await tr.applyOutcome(a, { kind: "auth_invalid" });
    await query("UPDATE claude_accounts SET cooldown_until = NOW() - INTERVAL '1 second'");
    await tr.applyProbeResult(a, { ok: false, transient: true, detail: "egress_unavailable" });
    const r = await row(a);
    assert.equal(r.status, "cooldown");
    assert.equal(r.backoff_level, 1);
    assert.ok(r.cooldown_until && r.cooldown_until.getTime() > Date.now());
  });

  test("429 cools immediately for Retry-After; an admin-disabled account is never touched", async (t) => {
    if (skipIfNoDb(t)) return;
    const a = await freshAccount();
    const tr = tracker();
    const t0 = Date.now();
    await tr.applyOutcome(a, { kind: "rate_limited", retryAfterMs: 120_000 });
    const r = await row(a);
    assert.equal(r.cooldown_reason, "rate_limited");
    assert.ok(r.cooldown_until!.getTime() >= t0 + 119_000 && r.cooldown_until!.getTime() <= Date.now() + 121_000);

    const d = await freshAccount();
    await updateAccount(d, { status: "disabled" }, keyFn);
    await tr.applyOutcome(d, { kind: "auth_invalid" });
    await tr.applyOutcome(d, { kind: "rate_limited" });
    const rd = await row(d);
    assert.equal(rd.status, "disabled");
    assert.equal(rd.disabled_by, "admin");
  });

  test("admin disable/enable records and clears disabled_by in the same write", async (t) => {
    if (skipIfNoDb(t)) return;
    const a = await freshAccount();
    await tracker().applyOutcome(a, { kind: "auth_invalid" });
    await updateAccount(a, { status: "disabled" }, keyFn);
    let r = await row(a);
    assert.equal(r.disabled_by, "admin");
    assert.equal(r.cooldown_reason, null);
    await updateAccount(a, { status: "active" }, keyFn);
    r = await row(a);
    assert.equal(r.status, "active");
    assert.equal(r.disabled_by, null);
    assert.equal(r.backoff_level, 0);
    assert.equal((await getAccount(a))?.status, "active");
  });

  test("session pins: auth cooldown is terminal, a short rate-limit cooldown stays transient", async (t) => {
    if (skipIfNoDb(t)) return;
    const a = await freshAccount();
    const b = await freshAccount();
    const tr = tracker();
    await tr.applyOutcome(a, { kind: "auth_invalid" });
    await tr.applyOutcome(b, { kind: "rate_limited", retryAfterMs: 30_000 });
    assert.equal((await readAccountRecoveryHint(a))?.kind, "terminal");
    assert.equal((await readAccountRecoveryHint(b))?.kind, "transient");
  });
});

describe("API-key pools (pool_api_keys)", () => {
  test("upsert is idempotent per service+key and only the hint is stored in clear", async (t) => {
    if (skipIfNoDb(t)) return;
    const first = await upsertApiKey({ service: "deepseek", apiKey: "sk-test-aaaaaaaa1111", source: "admin", label: "a", keyFn });
    const again = await upsertApiKey({ service: "deepseek", apiKey: "sk-test-aaaaaaaa1111", source: "admin", keyFn });
    assert.equal(first.created, true);
    assert.equal(again.created, false);
    assert.equal(again.id, first.id);
    const members = await listApiKeyMembers();
    assert.equal(members.length, 1);
    assert.equal(members[0].key_hint, "…1111");
    const raw = await query<{ key_enc: Buffer }>("SELECT key_enc FROM pool_api_keys");
    assert.ok(!raw.rows[0].key_enc.toString("utf8").includes("sk-test"));
  });

  test("selection skips cooling members and fails over to the next key on the next request", async (t) => {
    if (skipIfNoDb(t)) return;
    const k1 = await upsertApiKey({ service: "zai", apiKey: "zai-key-number-one-1111", source: "admin", keyFn });
    const k2 = await upsertApiKey({ service: "zai", apiKey: "zai-key-number-two-2222", source: "admin", keyFn });
    invalidateApiKeyPoolCache();
    const firstPick = await selectApiKey("zai", "session-x", keyFn);
    assert.ok(firstPick);
    await reportApiKeyOutcome(firstPick.memberId, { kind: "rate_limited", retryAfterMs: 60_000 });
    invalidateApiKeyPoolCache();
    const second = await selectApiKey("zai", "session-x", keyFn);
    assert.ok(second);
    assert.notEqual(second.memberId, firstPick.memberId);
    assert.ok([k1.id, k2.id].includes(second.memberId));
    assert.equal(await selectApiKey("bailian", "session-x", keyFn), null);
  });

  test("a provider 5xx is not a key strike; marking the cache stale keeps the service configured", async (t) => {
    if (skipIfNoDb(t)) return;
    const k = await upsertApiKey({ service: "ark", apiKey: "ark-key-only-one-9999", source: "admin", keyFn });
    invalidateApiKeyPoolCache();
    assert.ok(await selectApiKey("ark", "s", keyFn));
    for (let i = 0; i < 5; i += 1) await reportApiKeyOutcome(k.id, { kind: "upstream_error", detail: "http_503" });
    const [m] = await listApiKeyMembers();
    assert.equal(m.status, "active", "five provider 5xx must not cool the only key");
    // A key-specific 429 cools it; the cache is marked stale but the service stays configured.
    await reportApiKeyOutcome(k.id, { kind: "rate_limited", retryAfterMs: 60_000 });
    assert.equal(apiKeyPoolConfiguredServices().has("ark"), true);
    assert.equal(apiKeyPoolHasMembers("ark"), true);
    assert.equal(await selectApiKey("ark", "s", keyFn), null, "the cooling key is not selected");
  });

  test("API-key cooldowns recover through the shared adapter", async (t) => {
    if (skipIfNoDb(t)) return;
    const k = await upsertApiKey({ service: "gemini", apiKey: "gemini-key-abcdefgh", source: "admin", keyFn });
    await reportApiKeyOutcome(k.id, { kind: "auth_invalid", detail: "http_401" });
    const adapter = createApiKeyPoolAdapter(keyFn);
    await query("UPDATE pool_api_keys SET cooldown_until = NOW() - INTERVAL '1 second'");
    assert.equal(await adapter.halfOpenDue(), 0, "auth cooldown waits for a probe");
    const due = await adapter.listDueProbes(5);
    assert.equal(due.length, 1);
    const result = await adapter.probe(due[0]);
    assert.equal(result.ok, true);
    await adapter.applyProbeResult(due[0], result);
    const [m] = await listApiKeyMembers();
    assert.equal(m.status, "active");
    assert.equal(m.backoff_level, 1, "the level survives reactivation so repeat failures back off longer");
  });

  test("admin disable is the only way a key leaves the pool for good", async (t) => {
    if (skipIfNoDb(t)) return;
    const k = await upsertApiKey({ service: "minimax", apiKey: "minimax-key-12345678", source: "admin", keyFn });
    const off = await setApiKeyAdminStatus(k.id, "disabled");
    assert.equal(off?.status, "disabled");
    assert.equal(off?.disabled_by, "admin");
    await reportApiKeyOutcome(k.id, { kind: "success" });
    assert.equal((await listApiKeyMembers())[0].status, "disabled");
    const on = await setApiKeyAdminStatus(k.id, "active");
    assert.equal(on?.status, "active");
    assert.equal(on?.disabled_by, null);
  });

  test("env import is idempotent and a rotated env key replaces the old env member", async (t) => {
    if (skipIfNoDb(t)) return;
    const created = await importEnvApiKeys({ moonshot: "moon-key-old-0001", deepseek: undefined }, keyFn);
    assert.equal(created, 1);
    assert.equal(await importEnvApiKeys({ moonshot: "moon-key-old-0001" }, keyFn), 0);
    await importEnvApiKeys({ moonshot: "moon-key-new-0002" }, keyFn);
    const members = (await listApiKeyMembers()).filter((m) => m.service === "moonshot");
    assert.equal(members.length, 1);
    assert.equal(members[0].key_hint, "…0002");
    assert.equal(members[0].source, "env");
  });
});

describe("gemini pool: Antigravity subscription accounts (gemini_oauth_accounts)", () => {
  async function googleAccount(email: string): Promise<string> {
    const r = await query<{ id: string }>(
      `INSERT INTO gemini_oauth_accounts (label, email, refresh_token_enc, refresh_token_nonce)
       VALUES ($1, $2, $3, $4) RETURNING id::text AS id`,
      [email.split("@")[0], email, randomBytes(48), randomBytes(12)],
    );
    return r.rows[0].id;
  }
  async function gemRow(id: string) {
    const r = await query<{ status: string; cooldown_reason: string | null; backoff_level: number; next_probe_at: Date | null }>(
      "SELECT status, cooldown_reason, backoff_level, next_probe_at FROM gemini_oauth_accounts WHERE id = $1",
      [id],
    );
    return r.rows[0];
  }

  test("the admin 服务池 lists them as gemini subscription members next to gemini API keys", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await googleAccount("eckersonhanner@gmail.com");
    await upsertApiKey({ service: "gemini", apiKey: "gemini-key-abcdefgh", source: "admin", keyFn });
    _resetPoolRegistryForTest();
    registerPoolAdapter(createApiKeyPoolAdapter(keyFn));
    registerPoolAdapter(createGeminiPoolAdapter({ clientSecret: () => "secret" }));
    try {
      const gemini = (await collectPools()).find((p) => p.service === "gemini");
      assert.ok(gemini, "gemini pool present");
      const sub = gemini.members.find((m) => m.credentialType === "subscription");
      assert.ok(sub, "the Google account is a member");
      assert.equal(sub.id, id);
      assert.equal(sub.memberKind, "account");
      assert.equal(sub.label, "eckersonhanner@gmail.com");
      assert.equal(sub.status, "active");
      assert.equal(sub.healthScore, 100);
      assert.equal(gemini.members.filter((m) => m.credentialType === "api_key").length, 1);
      assert.equal(gemini.counts.total, 2);
    } finally {
      _resetPoolRegistryForTest();
    }
  });

  test("an auth cooldown waits for the probe; refresh success reactivates, invalid_grant backs off further", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await googleAccount("a1@example.com");
    await applyTableMemberOutcome(GEMINI_OAUTH_MEMBERS, id, { kind: "auth_invalid", detail: "http_401" });
    let r = await gemRow(id);
    assert.equal(r.status, "cooldown");
    assert.equal(r.cooldown_reason, "auth");
    assert.ok(r.next_probe_at, "auth cooldown schedules a probe");
    const ev = await query<{ service: string; member_kind: string }>("SELECT service, member_kind FROM pool_events");
    assert.deepEqual(ev.rows.map((e) => [e.service, e.member_kind]), [["gemini", "account"]]);

    let refreshed = 0;
    const adapter = createGeminiPoolAdapter({
      clientSecret: () => "secret",
      freshToken: async () => {
        refreshed += 1;
        return Buffer.from("access-token");
      },
    });
    await query("UPDATE gemini_oauth_accounts SET cooldown_until = NOW() - INTERVAL '1 second', next_probe_at = NOW() - INTERVAL '1 second'");
    assert.equal(await adapter.halfOpenDue(), 0, "auth cooldown is not half-opened by time alone");
    const due = await adapter.listDueProbes(5);
    assert.deepEqual(due.map((d) => [d.id, d.service, d.reason]), [[id, "gemini", "auth"]]);
    const ok = await adapter.probe(due[0]);
    assert.deepEqual(ok, { ok: true });
    assert.equal(refreshed, 1);
    await adapter.applyProbeResult(due[0], ok);
    r = await gemRow(id);
    assert.equal(r.status, "active");

    await applyTableMemberOutcome(GEMINI_OAUTH_MEMBERS, id, { kind: "auth_invalid", detail: "http_401" });
    const levelBefore = (await gemRow(id)).backoff_level;
    await query("UPDATE gemini_oauth_accounts SET cooldown_until = NOW() - INTERVAL '1 second', next_probe_at = NOW() - INTERVAL '1 second'");
    const dead = createGeminiPoolAdapter({
      clientSecret: () => "secret",
      freshToken: async () => {
        throw new AntigravityOAuthError(400, "invalid_grant");
      },
    });
    const [m] = await dead.listDueProbes(5);
    const bad = await dead.probe(m);
    assert.equal(bad.ok, false);
    assert.equal("transient" in bad, false, "invalid_grant is a real failure");
    await dead.applyProbeResult(m, bad);
    r = await gemRow(id);
    assert.equal(r.status, "cooldown");
    assert.ok(r.backoff_level > levelBefore, "a failed probe backs off further");
  });

  test("turn outcomes use the shared policy: auth cools with a probe and expires the cached token", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await googleAccount("a3@example.com");
    await query("UPDATE gemini_oauth_accounts SET access_token_enc = $2, access_token_nonce = $3, access_expires_at = NOW() + INTERVAL '50 minutes' WHERE id = $1", [id, randomBytes(40), randomBytes(12)]);
    await reportAntigravityOutcome(BigInt(id), { kind: "auth_invalid" }, "antigravity_http_401");
    const r = await query<{ status: string; cooldown_reason: string; next_probe_at: Date | null; expired: boolean; last_error: string }>(
      "SELECT status, cooldown_reason, next_probe_at, access_expires_at <= NOW() AS expired, last_error FROM gemini_oauth_accounts WHERE id = $1",
      [id],
    );
    assert.equal(r.rows[0].status, "cooldown");
    assert.equal(r.rows[0].cooldown_reason, "auth");
    assert.ok(r.rows[0].next_probe_at);
    assert.equal(r.rows[0].expired, true, "a dead grant is not served from the token cache");
    assert.equal(r.rows[0].last_error, "antigravity_http_401");
    await reportAntigravityOutcome(BigInt(id), { kind: "model_unavailable" }, "antigravity_http_503");
    assert.equal((await gemRow(id)).cooldown_reason, "auth", "a model 5xx never touches account state");
  });

  test("selection: active first, expired plain cooldowns half-open, expired auth cooldowns wait for the probe", async (t) => {
    if (skipIfNoDb(t)) return;
    const auth = await googleAccount("auth@example.com");
    const limited = await googleAccount("limited@example.com");
    const off = await googleAccount("off@example.com");
    await reportAntigravityOutcome(BigInt(auth), { kind: "auth_invalid" }, null);
    await reportAntigravityOutcome(BigInt(limited), { kind: "rate_limited", retryAfterMs: 60_000 }, null);
    await query("UPDATE gemini_oauth_accounts SET status = 'disabled', disabled_by = 'admin' WHERE id = $1", [off]);
    await query("UPDATE gemini_oauth_accounts SET cooldown_until = NOW() - INTERVAL '1 second' WHERE status = 'cooldown'");
    const pick = await pickAntigravityAccount();
    assert.equal(pick?.accountId.toString(), limited, "the expired rate-limit cooldown is half-open");
    assert.equal(
      (await pickAntigravityAccount({ skip: async (accountId) => accountId.toString() === limited })),
      null,
      "an auth cooldown is not retried by traffic and a disabled account never",
    );
    const fresh = await googleAccount("fresh@example.com");
    assert.equal((await pickAntigravityAccount())?.accountId.toString(), fresh, "an active account comes first");
  });

  test("without the OAuth client secret the probe re-checks later instead of escalating", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await googleAccount("a2@example.com");
    await applyTableMemberOutcome(GEMINI_OAUTH_MEMBERS, id, { kind: "auth_invalid" });
    const adapter = createGeminiPoolAdapter({ clientSecret: () => "" });
    const res = await adapter.probe({ id, service: "gemini", reason: "auth" });
    assert.deepEqual(res, { ok: false, transient: true, detail: "oauth_not_configured" });
  });
});
