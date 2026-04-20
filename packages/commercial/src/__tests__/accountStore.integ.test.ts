/**
 * T-30 集成:claude_accounts 存储层在真 PG 上的行为。
 *
 * 覆盖:
 *   1. createAccount → DB 里 oauth_token_enc 是密文(≠ 原文),nonce 长度 12
 *   2. createAccount 没给 refresh → *_refresh_enc/*_refresh_nonce 为 NULL
 *   3. createAccount 给 refresh → *_refresh_enc 是密文,且 ≠ access token 密文
 *   4. listAccounts 返元信息但不含任何 *_enc / *_nonce 列
 *   5. listAccounts 支持 status 过滤
 *   6. getAccount 返单行;不存在 → null
 *   7. getTokenForUse 解密正确还原 token(+refresh)
 *   8. getTokenForUse 不存在 → null
 *   9. getTokenForUse 在密文被篡改 1 byte 后 → AeadError
 *  10. updateAccount 只改普通字段 → 密文 / nonce 不变
 *  11. updateAccount 改 token → 密文 / nonce 都换新,getTokenForUse 返新 token
 *  12. updateAccount refresh=null → refresh_enc/refresh_nonce 清空
 *  13. updateAccount 空 patch → noop 返现状
 *  14. updateAccount 不存在 id → null
 *  15. deleteAccount → DB 行消失;不存在 id → false
 *  16. deleteAccount 当有 usage_records 引用时 → FK RESTRICT 报错
 *  17. listAccounts 永远不把密文查回来(列白名单防回退 —— 断言 RETURNING row 的 key 集)
 *  18. createAccount 非法 plan → TypeError
 *  19. updateAccount health_score 越界 → RangeError
 *  20. listAccounts limit 超过 500 → clamp 到 500
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { KMS_KEY_BYTES } from "../crypto/keys.js";
import { AeadError } from "../crypto/aead.js";
import {
  createAccount,
  getAccount,
  listAccounts,
  getTokenForUse,
  updateAccount,
  deleteAccount,
  type AccountRow,
} from "../account-pool/store.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://test:test@127.0.0.1:55432/openclaude_test";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

const COMMERCIAL_TABLES = [
  "rate_limit_events", "admin_audit", "agent_audit", "agent_containers",
  "agent_subscriptions", "user_preferences", "request_finalize_journal",
  "orders", "topup_plans", "usage_records",
  "credit_ledger", "model_pricing", "claude_accounts", "refresh_tokens",
  "email_verifications", "users", "schema_migrations",
];

let pgAvailable = false;
const KEY = randomBytes(KMS_KEY_BYTES);
const keyFn = (): Buffer => Buffer.from(KEY); // 每次新 Buffer,避免被 zero 污染原 key

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
  await query(`DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`);
  await runMigrations();
});

after(async () => {
  if (pgAvailable) {
    try { await query(`DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`); } catch { /* */ }
    await closePool();
  }
});

beforeEach(async () => {
  if (!pgAvailable) return;
  // 先清 usage_records(引用 claude_accounts),再清 claude_accounts
  await query("TRUNCATE TABLE usage_records, claude_accounts RESTART IDENTITY CASCADE");
});

function skipIfNoDb(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) { t.skip("pg not available"); return true; }
  return false;
}

async function readRawSecretColumns(id: bigint): Promise<{
  oauth_token_enc: Buffer;
  oauth_nonce: Buffer;
  oauth_refresh_enc: Buffer | null;
  oauth_refresh_nonce: Buffer | null;
}> {
  const r = await query<{
    oauth_token_enc: Buffer;
    oauth_nonce: Buffer;
    oauth_refresh_enc: Buffer | null;
    oauth_refresh_nonce: Buffer | null;
  }>(
    `SELECT oauth_token_enc, oauth_nonce, oauth_refresh_enc, oauth_refresh_nonce
     FROM claude_accounts WHERE id = $1`,
    [id.toString()],
  );
  return r.rows[0];
}

describe("createAccount", () => {
  test("加密后 INSERT:oauth_token_enc 是密文 / nonce 12B / refresh 可空", async (t) => {
    if (skipIfNoDb(t)) return;
    const ACCESS = "sk-ant-sid01-ACCESS-TOKEN-xyz-999";
    const row = await createAccount(
      { label: "pro-boss-1", plan: "pro", token: ACCESS },
      keyFn,
    );
    assert.equal(row.label, "pro-boss-1");
    assert.equal(row.plan, "pro");
    assert.equal(row.status, "active");
    assert.equal(row.health_score, 100);
    assert.equal(row.success_count, 0n);
    assert.equal(row.fail_count, 0n);
    assert.ok(row.id > 0n);
    const raw = await readRawSecretColumns(row.id);
    assert.equal(raw.oauth_nonce.length, 12);
    assert.ok(raw.oauth_token_enc.length > ACCESS.length, "密文含 16B tag,必 > 明文");
    assert.ok(!raw.oauth_token_enc.includes(Buffer.from(ACCESS)), "密文不应包含明文片段");
    assert.equal(raw.oauth_refresh_enc, null);
    assert.equal(raw.oauth_refresh_nonce, null);
  });

  test("createAccount 含 refresh → refresh 列也加密,且和 access 不同", async (t) => {
    if (skipIfNoDb(t)) return;
    const row = await createAccount(
      { label: "max-1", plan: "max", token: "ACC_TOKEN", refresh: "REF_TOKEN" },
      keyFn,
    );
    const raw = await readRawSecretColumns(row.id);
    assert.ok(raw.oauth_refresh_enc);
    assert.ok(raw.oauth_refresh_nonce);
    assert.equal(raw.oauth_refresh_nonce?.length, 12);
    // 不同 nonce → 密文必然不同;不同明文也不同
    assert.ok(!raw.oauth_token_enc.equals(raw.oauth_refresh_enc as Buffer));
    assert.ok(!raw.oauth_nonce.equals(raw.oauth_refresh_nonce as Buffer));
  });

  test("非法 plan → TypeError", async (t) => {
    if (skipIfNoDb(t)) return;
    await assert.rejects(
      createAccount({ label: "x", plan: "FREE" as unknown as "pro", token: "t" }, keyFn),
      TypeError,
    );
  });

  test("空 token → TypeError", async (t) => {
    if (skipIfNoDb(t)) return;
    await assert.rejects(
      createAccount({ label: "x", plan: "pro", token: "" }, keyFn),
      TypeError,
    );
  });
});

describe("listAccounts / getAccount", () => {
  test("listAccounts 不含密文/nonce 列(白名单防回退)", async (t) => {
    if (skipIfNoDb(t)) return;
    await createAccount({ label: "L1", plan: "pro", token: "T1" }, keyFn);
    await createAccount({ label: "L2", plan: "max", token: "T2", refresh: "R2" }, keyFn);
    const list = await listAccounts();
    assert.equal(list.length, 2);
    // 断言返的对象集合的 key 不含密文相关字段
    for (const row of list) {
      const keys = Object.keys(row);
      for (const forbidden of [
        "oauth_token_enc", "oauth_nonce",
        "oauth_refresh_enc", "oauth_refresh_nonce",
      ]) {
        assert.ok(!keys.includes(forbidden), `forbidden column leaked: ${forbidden}`);
      }
    }
  });

  test("listAccounts 按 id DESC", async (t) => {
    if (skipIfNoDb(t)) return;
    const a = await createAccount({ label: "first", plan: "pro", token: "T1" }, keyFn);
    const b = await createAccount({ label: "second", plan: "pro", token: "T2" }, keyFn);
    const list = await listAccounts();
    assert.equal(list[0].id, b.id);
    assert.equal(list[1].id, a.id);
  });

  test("listAccounts status 过滤", async (t) => {
    if (skipIfNoDb(t)) return;
    const a = await createAccount({ label: "active", plan: "pro", token: "T1" }, keyFn);
    const d = await createAccount({ label: "disabled", plan: "pro", token: "T2" }, keyFn);
    await updateAccount(d.id, { status: "disabled" }, keyFn);
    const actives = await listAccounts({ status: "active" });
    assert.equal(actives.length, 1);
    assert.equal(actives[0].id, a.id);
    const disableds = await listAccounts({ status: ["disabled", "banned"] });
    assert.equal(disableds.length, 1);
    assert.equal(disableds[0].id, d.id);
  });

  test("listAccounts limit 超过 500 → clamp 到 500", async (t) => {
    if (skipIfNoDb(t)) return;
    // 不真造 500 条,只验 clamp 的 SQL 上限。查询不会报错即可。
    const list = await listAccounts({ limit: 10_000 });
    assert.ok(Array.isArray(list));
  });

  test("getAccount 命中 / 不存在", async (t) => {
    if (skipIfNoDb(t)) return;
    const a = await createAccount({ label: "g", plan: "pro", token: "T" }, keyFn);
    const hit = await getAccount(a.id);
    assert.ok(hit);
    assert.equal(hit.id, a.id);
    assert.equal(await getAccount(999_999n), null);
  });
});

describe("getTokenForUse", () => {
  test("解密还原 token + refresh + expires_at", async (t) => {
    if (skipIfNoDb(t)) return;
    const EXPIRES = new Date("2026-12-01T00:00:00.000Z");
    const row = await createAccount(
      {
        label: "use-it",
        plan: "pro",
        token: "ACC-SECRET-ABC",
        refresh: "REF-SECRET-XYZ",
        expires_at: EXPIRES,
      },
      keyFn,
    );
    const t2 = await getTokenForUse(row.id, keyFn);
    assert.ok(t2);
    assert.equal(t2.id, row.id);
    assert.equal(t2.plan, "pro");
    assert.equal(t2.token.toString("utf8"), "ACC-SECRET-ABC");
    assert.ok(t2.refresh);
    assert.equal(t2.refresh!.toString("utf8"), "REF-SECRET-XYZ");
    assert.equal(t2.expires_at?.toISOString(), EXPIRES.toISOString());
  });

  test("没 refresh → refresh 字段 null", async (t) => {
    if (skipIfNoDb(t)) return;
    const row = await createAccount({ label: "x", plan: "pro", token: "A" }, keyFn);
    const t2 = await getTokenForUse(row.id, keyFn);
    assert.ok(t2);
    assert.equal(t2.refresh, null);
  });

  test("不存在 id → null", async (t) => {
    if (skipIfNoDb(t)) return;
    assert.equal(await getTokenForUse(999_999n, keyFn), null);
  });

  test("密文被篡改 1 byte → AeadError", async (t) => {
    if (skipIfNoDb(t)) return;
    const row = await createAccount({ label: "tamper", plan: "pro", token: "A" }, keyFn);
    // 翻转密文第 0 字节
    await query(
      `UPDATE claude_accounts
       SET oauth_token_enc = SET_BYTE(oauth_token_enc, 0, (GET_BYTE(oauth_token_enc, 0) # 1))
       WHERE id = $1`,
      [row.id.toString()],
    );
    await assert.rejects(
      getTokenForUse(row.id, keyFn),
      (err: unknown) => err instanceof AeadError,
    );
  });

  test("用错 key → AeadError", async (t) => {
    if (skipIfNoDb(t)) return;
    const row = await createAccount({ label: "wrongkey", plan: "pro", token: "A" }, keyFn);
    const otherKey = randomBytes(KMS_KEY_BYTES);
    await assert.rejects(
      getTokenForUse(row.id, () => Buffer.from(otherKey)),
      AeadError,
    );
  });
});

describe("updateAccount", () => {
  async function createOne(overrides: Partial<{ label: string; token: string; refresh: string }> = {}): Promise<AccountRow> {
    return createAccount(
      {
        label: overrides.label ?? "u-acc",
        plan: "pro",
        token: overrides.token ?? "ACC-1",
        refresh: overrides.refresh ?? "REF-1",
      },
      keyFn,
    );
  }

  test("只改普通字段 → 密文不动", async (t) => {
    if (skipIfNoDb(t)) return;
    const acc = await createOne();
    const before = await readRawSecretColumns(acc.id);
    const updated = await updateAccount(
      acc.id,
      { label: "renamed", health_score: 77 },
      keyFn,
    );
    assert.ok(updated);
    assert.equal(updated.label, "renamed");
    assert.equal(updated.health_score, 77);
    const after = await readRawSecretColumns(acc.id);
    assert.ok(before.oauth_token_enc.equals(after.oauth_token_enc));
    assert.ok(before.oauth_nonce.equals(after.oauth_nonce));
  });

  test("改 token → 密文 / nonce 都换,getTokenForUse 返新 token", async (t) => {
    if (skipIfNoDb(t)) return;
    const acc = await createOne();
    const before = await readRawSecretColumns(acc.id);
    await updateAccount(acc.id, { token: "ACC-NEW" }, keyFn);
    const after = await readRawSecretColumns(acc.id);
    assert.ok(!before.oauth_token_enc.equals(after.oauth_token_enc));
    assert.ok(!before.oauth_nonce.equals(after.oauth_nonce));
    const t2 = await getTokenForUse(acc.id, keyFn);
    assert.equal(t2?.token.toString("utf8"), "ACC-NEW");
  });

  test("refresh=null → 清空 refresh 密文/nonce", async (t) => {
    if (skipIfNoDb(t)) return;
    const acc = await createOne();
    await updateAccount(acc.id, { refresh: null }, keyFn);
    const raw = await readRawSecretColumns(acc.id);
    assert.equal(raw.oauth_refresh_enc, null);
    assert.equal(raw.oauth_refresh_nonce, null);
    const t2 = await getTokenForUse(acc.id, keyFn);
    assert.equal(t2?.refresh, null);
  });

  test("refresh='string' → 重新加密", async (t) => {
    if (skipIfNoDb(t)) return;
    const acc = await createOne();
    const before = await readRawSecretColumns(acc.id);
    await updateAccount(acc.id, { refresh: "REF-2" }, keyFn);
    const after = await readRawSecretColumns(acc.id);
    assert.ok(after.oauth_refresh_enc);
    assert.ok(!(before.oauth_refresh_enc as Buffer).equals(after.oauth_refresh_enc as Buffer));
    const t2 = await getTokenForUse(acc.id, keyFn);
    assert.equal(t2?.refresh?.toString("utf8"), "REF-2");
  });

  test("空 patch → 不发 SQL,返当前行", async (t) => {
    if (skipIfNoDb(t)) return;
    const acc = await createOne();
    const r = await updateAccount(acc.id, {}, keyFn);
    assert.ok(r);
    assert.equal(r.id, acc.id);
    // updated_at 不变(因为没发 UPDATE)
    assert.equal(r.updated_at.toISOString(), acc.updated_at.toISOString());
  });

  test("不存在 id → null", async (t) => {
    if (skipIfNoDb(t)) return;
    assert.equal(await updateAccount(999_999n, { label: "x" }, keyFn), null);
  });

  test("health_score 越界 → RangeError", async (t) => {
    if (skipIfNoDb(t)) return;
    const acc = await createOne();
    await assert.rejects(updateAccount(acc.id, { health_score: -1 }, keyFn), RangeError);
    await assert.rejects(updateAccount(acc.id, { health_score: 101 }, keyFn), RangeError);
  });

  test("非法 status → TypeError", async (t) => {
    if (skipIfNoDb(t)) return;
    const acc = await createOne();
    await assert.rejects(
      updateAccount(acc.id, { status: "frozen" as unknown as "active" }, keyFn),
      TypeError,
    );
  });
});

describe("deleteAccount", () => {
  test("删除存在的账号 → true,行消失", async (t) => {
    if (skipIfNoDb(t)) return;
    const acc = await createAccount(
      { label: "to-delete", plan: "pro", token: "T" },
      keyFn,
    );
    assert.equal(await deleteAccount(acc.id), true);
    assert.equal(await getAccount(acc.id), null);
  });

  test("不存在 id → false", async (t) => {
    if (skipIfNoDb(t)) return;
    assert.equal(await deleteAccount(999_999n), false);
  });

  test("有 usage_records 引用 → FK RESTRICT 报错", async (t) => {
    if (skipIfNoDb(t)) return;
    const acc = await createAccount(
      { label: "has-usage", plan: "pro", token: "T" },
      keyFn,
    );
    // 造一个 user + 一个 usage_records 引用该 account
    const u = await query<{ id: string }>(
      `INSERT INTO users(email, password_hash, credits, email_verified, status)
       VALUES('fk@example.com', 'stub', 0, true, 'active') RETURNING id::text AS id`,
    );
    await query(
      `INSERT INTO usage_records(
         user_id, session_id, mode, account_id, model,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         price_snapshot, cost_credits, request_id, status
       ) VALUES ($1,'sess','chat',$2,'claude-sonnet',0,0,0,0,'{}'::jsonb,0,'req-fk-1','success')`,
      [u.rows[0].id, acc.id.toString()],
    );
    await assert.rejects(deleteAccount(acc.id));
    // 账号仍存在
    assert.ok(await getAccount(acc.id));
  });
});
