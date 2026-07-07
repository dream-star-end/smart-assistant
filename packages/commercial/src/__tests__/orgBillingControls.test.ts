/**
 * 企业版(P3.1 三期 · 批次 H)行为测试 —— 真 DB round-trip。
 *
 * 隔离策略:专属数据库 openclaude_orgh_test(before CREATE / after DROP),不碰共享
 * openclaude_test.public —— 与 orgEnterprise/orgBilling.test.ts 同手法,避开 unit 套件
 * 并发时的整库竞争。
 *
 * 覆盖(方案 §17.1-§17.4):
 *   - billing 伪角色三态:owner 通 / billing_delegate 通 / 纯 admin(未委派)403(requireOrgRole)。
 *   - 委派授予 owner-only:admin 改 billing_delegate → 403(数据层 updateMember 事务内判)。
 *   - 成员月度预算钳制:预算内 org 付 / 超限落个人 / budget=null 不限 / org 资金<剩余预算取小 /
 *     跨月重置口径(上月支出不计入本月已用)。
 *   - resolveOrgBillingContext 带 monthly_org_budget;settle 端到端预算钳制。
 *   - 低水位:无订阅 org 阈值 2000 边界 / 带订阅阈值(10%×池满)边界 / 去重 / 清标记后再触发。
 *   - plans scope 参数(user 默认 / org 含 min_seats)。
 *   - month_org_spent 口径一致(listMembers 与 spendTwoBucket 预算钳制同一 SUM)。
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { Client } from "pg";
import { createPool, closePool, getPool, setPoolOverride, resetPool } from "../db/index.js";
import { query, tx } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { signAccess } from "../auth/jwt.js";
import { requireOrgRole } from "../org/requireOrgRole.js";
import { createOrg } from "../org/orgs.js";
import { updateMember, listMembers } from "../org/memberships.js";
import {
  resolveOrgBillingContext,
  sumMemberOrgMonthSpend,
  mapOrgMonthSpendByMember,
} from "../org/orgBilling.js";
import { spendTwoBucket } from "../billing/spend.js";
import { settleUsageAndLedger } from "../billing/proxyBilling.js";
import { sweepOrgLowBalance } from "../org/orgLowBalance.js";
import { adjustOrgCredits } from "../admin/orgs.js";
import { handleListSubscriptionPlans } from "../http/subscription.js";
import { OrgError, type OrgRole } from "../org/types.js";
import type { TokenUsage } from "../billing/calculator.js";
import type { Mailer } from "../auth/mail.js";

const BASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const MY_DB = "openclaude_orgh_test";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";
const JWT_SECRET = "z".repeat(64);

function withDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}
const MY_URL = withDb(BASE_URL, MY_DB);

let pgAvailable = false;

async function adminExec(sql: string): Promise<void> {
  const c = new Client({ connectionString: BASE_URL, connectionTimeoutMillis: 1500 });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

before(async () => {
  try {
    await adminExec("SELECT 1");
    pgAvailable = true;
  } catch {
    pgAvailable = false;
  }
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error("Postgres test fixture required");
    return;
  }
  await adminExec(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${MY_DB}' AND pid <> pg_backend_pid()`,
  ).catch(() => {});
  await adminExec(`DROP DATABASE IF EXISTS ${MY_DB}`);
  await adminExec(`CREATE DATABASE ${MY_DB} TEMPLATE template0`);

  await resetPool();
  setPoolOverride(createPool({ connectionString: MY_URL, max: 10 }));
  await runMigrations();
});

after(async () => {
  if (!pgAvailable) return;
  await closePool();
  await adminExec(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${MY_DB}' AND pid <> pg_backend_pid()`,
  ).catch(() => {});
  await adminExec(`DROP DATABASE IF EXISTS ${MY_DB}`).catch(() => {});
});

beforeEach(async () => {
  if (!pgAvailable) return;
  await query(
    `TRUNCATE TABLE orders, credit_ledger, usage_records, org_memberships, org_subscriptions,
       orgs, user_subscriptions, users, admin_audit, inbox_messages, inbox_message_reads
     RESTART IDENTITY CASCADE`,
  );
});

function skipIfNoPg(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) {
    t.skip("pg not running");
    return true;
  }
  return false;
}

// ─── fixtures ───────────────────────────────────────────────────────

async function createUser(email: string, walletCredits = 0n): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO users(email, password_hash, role, status, email_verified, free_bootstrap_settled, credits)
     VALUES ($1, 'argon2$stub', 'user', 'active', TRUE, TRUE, $2) RETURNING id::text AS id`,
    [email, walletCredits.toString()],
  );
  return r.rows[0].id;
}

let orgSeq = 0;

/** 建 org(内部 throwaway owner),设 credits/status。返回 { orgId, ownerId }。 */
async function makeOrg(
  credits = 0n,
  opts: { status?: string } = {},
): Promise<{ orgId: string; ownerId: string }> {
  const ownerId = await createUser(`org-owner-${++orgSeq}@x.com`);
  const orgId = await tx(async (client) => {
    const o = await createOrg(
      { name: `Acme-${orgSeq}`, ownerUserId: ownerId, createdBy: null, maxMembers: 100 },
      client,
    );
    return o.id;
  });
  await query(`UPDATE orgs SET credits = $1, status = $2 WHERE id = $3::bigint`, [
    credits.toString(),
    opts.status ?? "active",
    orgId,
  ]);
  return { orgId, ownerId };
}

async function addMember(
  orgId: string,
  userId: string,
  role: OrgRole = "member",
  opts: { billingEnabled?: boolean; billingDelegate?: boolean; monthlyBudget?: bigint | null } = {},
): Promise<void> {
  await query(
    `INSERT INTO org_memberships(org_id, user_id, org_role, status, billing_enabled,
        billing_delegate, monthly_org_budget)
     VALUES ($1::bigint, $2::bigint, $3, 'active', $4, $5, $6)`,
    [
      orgId,
      userId,
      role,
      opts.billingEnabled ?? true,
      opts.billingDelegate ?? false,
      opts.monthlyBudget == null ? null : opts.monthlyBudget.toString(),
    ],
  );
}

/** 给 org 建 active 期内池订阅(seats × plan)。periodEnd 默认 +30d。 */
async function makeOrgSub(
  orgId: string,
  planCode: string,
  seats: number,
  periodCredits: bigint,
): Promise<void> {
  await query(
    `INSERT INTO org_subscriptions(org_id, plan_code, seats, status, period_start, period_end, period_credits)
     VALUES ($1::bigint, $2, $3, 'active', NOW(), NOW() + INTERVAL '30 days', $4)`,
    [orgId, planCode, seats, periodCredits.toString()],
  );
}

/** 直接写一条 org 桶消费流水(用于跨月 SUM 口径测试)。 */
async function insertOrgSpendLedger(
  orgId: string,
  userId: string,
  bucket: "org_wallet" | "org_period",
  amount: bigint,
  createdAt: string,
): Promise<void> {
  await query(
    `INSERT INTO credit_ledger(user_id, org_id, delta, balance_after, reason, bucket, created_at)
     VALUES ($1::bigint, $2::bigint, $3, 0, 'chat', $4, $5::timestamptz)`,
    [userId, orgId, (-amount).toString(), bucket, createdAt],
  );
}

async function userWallet(uid: string): Promise<bigint> {
  const r = await query<{ credits: string }>(
    `SELECT credits::text AS credits FROM users WHERE id=$1::bigint`,
    [uid],
  );
  return BigInt(r.rows[0].credits);
}
async function orgWalletCredits(orgId: string): Promise<bigint> {
  const r = await query<{ credits: string }>(
    `SELECT credits::text AS credits FROM orgs WHERE id=$1::bigint`,
    [orgId],
  );
  return BigInt(r.rows[0].credits);
}

async function token(uid: string): Promise<string> {
  const r = await signAccess({ sub: uid, role: "user" }, JWT_SECRET);
  return r.token;
}

function makeReq(method: string, path: string, tok?: string): Readable {
  const req = Readable.from([]) as Readable & {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    socket?: { remoteAddress: string };
  };
  req.method = method;
  req.url = path;
  req.headers = { host: "x.invalid", ...(tok ? { authorization: `Bearer ${tok}` } : {}) };
  req.socket = { remoteAddress: "127.0.0.1" };
  return req;
}

interface FakeRes {
  statusCode: number;
  _body: string;
  setHeader(k: string, v: unknown): void;
  getHeader(k: string): unknown;
  end(b?: string): void;
  headersSent: boolean;
}
function makeRes(): FakeRes {
  const headers: Record<string, unknown> = {};
  return {
    statusCode: 200,
    _body: "",
    setHeader(k, v) {
      headers[k.toLowerCase()] = v;
    },
    getHeader(k) {
      return headers[k.toLowerCase()];
    },
    end(b) {
      this._body = b ?? "";
    },
    headersSent: false,
  };
}

function usage(input = 100, output = 50): TokenUsage {
  return { input_tokens: input, output_tokens: output, cache_read_tokens: 0, cache_write_tokens: 0 };
}

// ====================================================================
// §17.3 — billing 伪角色三态 + 委派授予 owner-only
// ====================================================================

describe("§17.3 billing 伪角色 + 委派授予 owner-only", () => {
  test("owner 满足 minRole=billing;billing_delegate 满足;纯 admin 未委派 → 403", async (t) => {
    if (skipIfNoPg(t)) return;
    const { orgId, ownerId } = await makeOrg();
    const delegate = await createUser("delegate@x.com");
    const plainAdmin = await createUser("admin@x.com");
    await addMember(orgId, delegate, "member", { billingDelegate: true });
    await addMember(orgId, plainAdmin, "admin", { billingDelegate: false });

    // owner 通(且 billingDelegate 归一化为 true)
    const ownerCtx = await requireOrgRole(makeReq("POST", "/api/org/topup", await token(ownerId)) as never, JWT_SECRET, getPool(), "billing");
    assert.equal(ownerCtx.orgRole, "owner");
    assert.equal(ownerCtx.billingDelegate, true);

    // billing_delegate 成员通
    const delCtx = await requireOrgRole(makeReq("POST", "/api/org/topup", await token(delegate)) as never, JWT_SECRET, getPool(), "billing");
    assert.equal(delCtx.orgRole, "member");
    assert.equal(delCtx.billingDelegate, true);

    // 纯 admin(未委派)→ minRole=billing 403;但仍满足 minRole=admin(读面不受影响)
    const adminReq = makeReq("POST", "/api/org/topup", await token(plainAdmin)) as never;
    await assert.rejects(
      () => requireOrgRole(adminReq, JWT_SECRET, getPool(), "billing"),
      (e: any) => e.status === 403,
    );
    const adminReq2 = makeReq("GET", "/api/org/members", await token(plainAdmin)) as never;
    assert.equal((await requireOrgRole(adminReq2, JWT_SECRET, getPool(), "admin")).orgRole, "admin");
  });

  test("委派授予 owner-only:admin 改 billing_delegate → 403(数据层)", async (t) => {
    if (skipIfNoPg(t)) return;
    const { orgId } = await makeOrg();
    const admin = await createUser("admin2@x.com");
    const target = await createUser("target@x.com");
    await addMember(orgId, admin, "admin");
    await addMember(orgId, target, "member");

    // admin 尝试给 member 授予委派 → 403 FORBIDDEN(actor.role !== 'owner')
    await assert.rejects(
      () =>
        tx((c) => updateMember(orgId, target, { billingDelegate: true }, c, { role: "admin", userId: admin })),
      (e: unknown) => e instanceof OrgError && e.status === 403,
    );

    // owner 授予成功
    const owner = (await query<{ user_id: string }>(
      `SELECT user_id::text AS user_id FROM org_memberships WHERE org_id=$1::bigint AND org_role='owner'`,
      [orgId],
    )).rows[0].user_id;
    const updated = await tx((c) =>
      updateMember(orgId, target, { billingDelegate: true }, c, { role: "owner", userId: owner }),
    );
    assert.equal(updated.billing_delegate, true);
  });

  test("admin 可改 monthly_org_budget(支出策略,非动钱);null 清除;<=0 拒", async (t) => {
    if (skipIfNoPg(t)) return;
    const { orgId } = await makeOrg();
    const admin = await createUser("admin3@x.com");
    const target = await createUser("target2@x.com");
    await addMember(orgId, admin, "admin");
    await addMember(orgId, target, "member");

    const set = await tx((c) =>
      updateMember(orgId, target, { monthlyOrgBudget: 5000n }, c, { role: "admin", userId: admin }),
    );
    assert.equal(set.monthly_org_budget, 5000n);

    const cleared = await tx((c) =>
      updateMember(orgId, target, { monthlyOrgBudget: null }, c, { role: "admin", userId: admin }),
    );
    assert.equal(cleared.monthly_org_budget, null);

    await assert.rejects(
      () => tx((c) => updateMember(orgId, target, { monthlyOrgBudget: 0n }, c, { role: "admin", userId: admin })),
      (e: unknown) => e instanceof OrgError && e.status === 400,
    );
  });
});

// ====================================================================
// §17.4 — 成员月度预算钳制(spendTwoBucket)
// ====================================================================

describe("§17.4 spendTwoBucket 预算钳制", () => {
  test("预算内:org 付全额(budget 未耗尽)", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("m1@x.com", 0n);
    const { orgId } = await makeOrg(10_000n);
    await addMember(orgId, uid, "member", { monthlyBudget: 5000n });

    const r = await tx((c) =>
      spendTwoBucket(c, { userId: uid, amount: 300n, reason: "chat", orgId, monthlyOrgBudget: 5000n }),
    );
    assert.equal(r.fromOrg, 300n);
    assert.equal(r.fromWallet, 0n);
    assert.equal(await orgWalletCredits(orgId), 9700n);
  });

  test("超限:预算耗尽 → org 出 0,静默落个人桶(不报错)", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("m2@x.com", 1000n);
    const { orgId } = await makeOrg(10_000n);
    await addMember(orgId, uid, "member", { monthlyBudget: 500n });
    // 先花 500(=预算),打满
    await tx((c) =>
      spendTwoBucket(c, { userId: uid, amount: 500n, reason: "chat", orgId, monthlyOrgBudget: 500n }),
    );
    assert.equal(await orgWalletCredits(orgId), 9500n);

    // 再花 200:预算已耗尽 → org 桶出 0,落个人钱包
    const r = await tx((c) =>
      spendTwoBucket(c, { userId: uid, amount: 200n, reason: "chat", orgId, monthlyOrgBudget: 500n }),
    );
    assert.equal(r.fromOrg, 0n);
    assert.equal(r.fromOrgPeriod, 0n);
    assert.equal(r.fromWallet, 200n);
    assert.equal(await orgWalletCredits(orgId), 9500n); // org 不再动
    assert.equal(await userWallet(uid), 800n);
  });

  test("部分钳制:剩余预算 < 请求 → org 出剩余预算,其余落个人", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("m3@x.com", 1000n);
    const { orgId } = await makeOrg(10_000n);
    await addMember(orgId, uid, "member", { monthlyBudget: 500n });
    // 先花 400 → 剩余预算 100
    await tx((c) =>
      spendTwoBucket(c, { userId: uid, amount: 400n, reason: "chat", orgId, monthlyOrgBudget: 500n }),
    );
    // 再请求 300:org 只能出 100(剩余预算),200 落个人
    const r = await tx((c) =>
      spendTwoBucket(c, { userId: uid, amount: 300n, reason: "chat", orgId, monthlyOrgBudget: 500n }),
    );
    assert.equal(r.fromOrg, 100n);
    assert.equal(r.fromWallet, 200n);
    assert.equal(await userWallet(uid), 800n);
  });

  test("budget=null:不限(org 全额付,不受钳制)", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("m4@x.com", 0n);
    const { orgId } = await makeOrg(10_000n);
    await addMember(orgId, uid, "member", { monthlyBudget: null });
    const r = await tx((c) =>
      spendTwoBucket(c, { userId: uid, amount: 8000n, reason: "chat", orgId, monthlyOrgBudget: null }),
    );
    assert.equal(r.fromOrg, 8000n);
    assert.equal(r.fromWallet, 0n);
  });

  test("org 资金 < 剩余预算 → 取小(org 资金上限约束)", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("m5@x.com", 1000n);
    const { orgId } = await makeOrg(200n); // org 只有 200
    await addMember(orgId, uid, "member", { monthlyBudget: 5000n }); // 预算 5000 远大于 org 资金
    const r = await tx((c) =>
      spendTwoBucket(c, { userId: uid, amount: 500n, reason: "chat", orgId, monthlyOrgBudget: 5000n }),
    );
    // org 只能出 200(资金上限,非预算上限),300 落个人
    assert.equal(r.fromOrg, 200n);
    assert.equal(r.fromWallet, 300n);
    assert.equal(await orgWalletCredits(orgId), 0n);
  });

  test("org_period 优先于 org_wallet 消耗,受预算钳制的总额分配正确", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("m6@x.com", 0n);
    const { orgId } = await makeOrg(10_000n); // org 钱包
    await makeOrgSub(orgId, "org-pro", 2, 300n); // org 期内池 300
    await addMember(orgId, uid, "member", { monthlyBudget: 500n });
    // 请求 500:org_period 300 先耗,再 org_wallet 200(总 500=预算)
    const r = await tx((c) =>
      spendTwoBucket(c, { userId: uid, amount: 500n, reason: "chat", orgId, monthlyOrgBudget: 500n }),
    );
    assert.equal(r.fromOrgPeriod, 300n);
    assert.equal(r.fromOrg, 200n);
    assert.equal(r.fromWallet, 0n);
  });

  test("跨月口径:上月的 org 支出不计入本月已用(预算按本自然月)", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("m7@x.com", 0n);
    const { orgId } = await makeOrg(10_000n);
    await addMember(orgId, uid, "member", { monthlyBudget: 500n });
    // 上月已花 400(不应计入本月)
    await insertOrgSpendLedger(orgId, uid, "org_wallet", 400n, "2020-01-15T00:00:00Z");
    // 本月请求 500:上月不计 → 本月已用 0 → 预算 500 可全付
    const spent = await tx((c) => sumMemberOrgMonthSpend(c, orgId, uid));
    assert.equal(spent, 0n, "上月支出不计入本月已用");
    const r = await tx((c) =>
      spendTwoBucket(c, { userId: uid, amount: 500n, reason: "chat", orgId, monthlyOrgBudget: 500n }),
    );
    assert.equal(r.fromOrg, 500n);
    assert.equal(r.fromWallet, 0n);
  });

  test("正 delta(充值)不计入月度已用(只计支出)", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("m8@x.com", 0n);
    const { orgId } = await makeOrg(10_000n);
    await addMember(orgId, uid, "member", { monthlyBudget: 500n });
    // 本月一条正 delta(充值语义)+ 一条负 delta(支出 100)
    await query(
      `INSERT INTO credit_ledger(user_id, org_id, delta, balance_after, reason, bucket, created_at)
       VALUES ($1::bigint, $2::bigint, 9999, 0, 'topup', 'org_wallet', NOW())`,
      [uid, orgId],
    );
    await insertOrgSpendLedger(orgId, uid, "org_wallet", 100n, new Date().toISOString());
    const spent = await tx((c) => sumMemberOrgMonthSpend(c, orgId, uid));
    assert.equal(spent, 100n, "只计负 delta(支出),正 delta 不计");
  });
});

// ====================================================================
// resolveOrgBillingContext + settle 端到端预算钳制
// ====================================================================

describe("resolveOrgBillingContext + settle 预算钳制", () => {
  test("resolveOrgBillingContext 返回 monthly_org_budget", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("r1@x.com");
    const { orgId } = await makeOrg(1000n);
    await addMember(orgId, uid, "member", { monthlyBudget: 777n });
    const ctx = await resolveOrgBillingContext(getPool() as never, uid);
    assert.ok(ctx);
    assert.equal(ctx!.orgId, orgId);
    assert.equal(ctx!.billingEnabled, true);
    assert.equal(ctx!.monthlyOrgBudget, 777n);

    // 无预算 → null
    const uid2 = await createUser("r2@x.com");
    await addMember(orgId, uid2, "member", { monthlyBudget: null });
    const ctx2 = await resolveOrgBillingContext(getPool() as never, uid2);
    assert.equal(ctx2!.monthlyOrgBudget, null);
  });

  test("settle 端到端:预算耗尽后 settle 不再从 org 扣(落个人桶)", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("s1@x.com", 100_000n);
    const { orgId } = await makeOrg(1_000_000n);
    await addMember(orgId, uid, "member", { monthlyBudget: 500n });
    const pool = getPool();

    // 第一次 settle:cost 400 从 org 扣(预算内)
    await settleUsageAndLedger(pool, {
      requestId: "req-1",
      userId: BigInt(uid),
      accountId: null,
      model: "deepseek-v4",
      usage: usage(),
      snapshotJson: "{}",
      costCredits: 400n,
      status: "success",
      sessionId: null,
    });
    const orgAfter1 = await orgWalletCredits(orgId);
    assert.equal(orgAfter1, 999_600n, "预算内:org 扣 400");

    // 第二次 settle:cost 400,但仅剩 100 预算 → org 出 100,300 落个人钱包
    await settleUsageAndLedger(pool, {
      requestId: "req-2",
      userId: BigInt(uid),
      accountId: null,
      model: "deepseek-v4",
      usage: usage(),
      snapshotJson: "{}",
      costCredits: 400n,
      status: "success",
      sessionId: null,
    });
    assert.equal(await orgWalletCredits(orgId), 999_500n, "org 只再扣 100(剩余预算)");
    assert.equal(await userWallet(uid), 99_700n, "300 落个人钱包");
  });
});

// ====================================================================
// month_org_spent 口径一致(listMembers vs spendTwoBucket SUM)
// ====================================================================

describe("month_org_spent 口径一致", () => {
  test("listMembers.month_org_spent 与 sumMemberOrgMonthSpend 同口径", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("c1@x.com", 0n);
    const { orgId } = await makeOrg(10_000n);
    await addMember(orgId, uid, "member", { monthlyBudget: 5000n });
    // 花 350
    await tx((c) => spendTwoBucket(c, { userId: uid, amount: 350n, reason: "chat", orgId, monthlyOrgBudget: 5000n }));

    const viaSum = await tx((c) => sumMemberOrgMonthSpend(c, orgId, uid));
    const viaMap = await mapOrgMonthSpendByMember(orgId);
    const members = await listMembers(orgId);
    const row = members.find((m) => m.user_id === uid)!;
    assert.equal(viaSum, 350n);
    assert.equal(viaMap.get(uid), 350n);
    assert.equal(row.month_org_spent, 350n);
    assert.equal(row.monthly_org_budget, 5000n);
    assert.equal(row.billing_delegate, false);
  });
});

// ====================================================================
// §17.2 — 低水位预警
// ====================================================================

describe("§17.2 低水位预警 sweeper", () => {
  function captureMailer(): { mailer: Mailer; sent: Array<{ to: string; subject: string }> } {
    const sent: Array<{ to: string; subject: string }> = [];
    return {
      sent,
      mailer: {
        async send(m) {
          sent.push({ to: m.to, subject: m.subject });
        },
      },
    };
  }

  async function ownerInboxCount(orgId: string): Promise<number> {
    const owner = (await query<{ user_id: string }>(
      `SELECT user_id::text AS user_id FROM org_memberships WHERE org_id=$1::bigint AND org_role='owner'`,
      [orgId],
    )).rows[0].user_id;
    const r = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM inbox_messages WHERE audience='user' AND user_id=$1::bigint`,
      [owner],
    );
    return Number(r.rows[0].n);
  }
  async function markedAt(orgId: string): Promise<Date | null> {
    const r = await query<{ t: Date | null }>(
      `SELECT low_balance_notified_at AS t FROM orgs WHERE id=$1::bigint`,
      [orgId],
    );
    return r.rows[0].t;
  }

  test("无订阅 org 阈值 2000:1999 触发,2000 不触发", async (t) => {
    if (skipIfNoPg(t)) return;
    const low = await makeOrg(1999n);
    const boundary = await makeOrg(2000n);
    const cap = captureMailer();

    const n = await sweepOrgLowBalance({ mailer: cap.mailer });
    assert.equal(n, 1, "只有 1999 的 org 被预警");
    assert.notEqual(await markedAt(low.orgId), null);
    assert.equal(await markedAt(boundary.orgId), null);
    assert.equal(await ownerInboxCount(low.orgId), 1);
    assert.equal(cap.sent.length, 1);
  });

  test("带订阅阈值 = 10%×池满(seats×每席积分)", async (t) => {
    if (skipIfNoPg(t)) return;
    // org-max: 每席 35000。seats=10 → 池满 350000 → 阈值 35000。
    // org 钱包 20000 + 期内池 10000 = 30000 < 35000 → 触发。
    const below = await makeOrg(20_000n);
    await makeOrgSub(below.orgId, "org-max", 10, 10_000n);
    // 另一 org:钱包 30000 + 期内池 10000 = 40000 > 35000 → 不触发。
    const above = await makeOrg(30_000n);
    await makeOrgSub(above.orgId, "org-max", 10, 10_000n);

    const cap = captureMailer();
    const n = await sweepOrgLowBalance({ mailer: cap.mailer });
    assert.equal(n, 1);
    assert.notEqual(await markedAt(below.orgId), null);
    assert.equal(await markedAt(above.orgId), null);
  });

  test("去重:已打戳的 org 第二次不再预警", async (t) => {
    if (skipIfNoPg(t)) return;
    const low = await makeOrg(1000n);
    const cap = captureMailer();
    assert.equal(await sweepOrgLowBalance({ mailer: cap.mailer }), 1);
    assert.equal(await sweepOrgLowBalance({ mailer: cap.mailer }), 0, "第二次去重");
    assert.equal(cap.sent.length, 1);
    assert.equal(await ownerInboxCount(low.orgId), 1);
  });

  test("清标记后再触发:充值清戳(adjustOrgCredits 正调)→ 跌破再预警", async (t) => {
    if (skipIfNoPg(t)) return;
    const low = await makeOrg(1000n);
    const cap = captureMailer();
    assert.equal(await sweepOrgLowBalance({ mailer: cap.mailer }), 1);
    // 正向调额 +5000(> 阈值)→ 清戳 + 抬高余额;此时不再低于阈值
    const owner = (await query<{ user_id: string }>(
      `SELECT user_id::text AS user_id FROM org_memberships WHERE org_id=$1::bigint AND org_role='owner'`,
      [low.orgId],
    )).rows[0].user_id;
    await adjustOrgCredits({ orgId: low.orgId, delta: 5000n, memo: "top up", adminId: owner });
    assert.equal(await markedAt(low.orgId), null, "正向调额清戳");
    assert.equal(await sweepOrgLowBalance({ mailer: cap.mailer }), 0, "余额已高于阈值,不预警");

    // 再把余额扣回低位(负调),标记为 null → 再次触发
    await adjustOrgCredits({ orgId: low.orgId, delta: -5500n, memo: "spend down", adminId: owner });
    assert.equal(await sweepOrgLowBalance({ mailer: cap.mailer }), 1, "跌破后再次预警");
    assert.equal(cap.sent.length, 2);
  });

  test("suspended org 不预警(只扫 active)", async (t) => {
    if (skipIfNoPg(t)) return;
    const susp = await makeOrg(100n, { status: "suspended" });
    const cap = captureMailer();
    assert.equal(await sweepOrgLowBalance({ mailer: cap.mailer }), 0);
    assert.equal(await markedAt(susp.orgId), null);
  });
});

// ====================================================================
// §17.1 — plans scope 参数
// ====================================================================

describe("§17.1 plans scope 参数", () => {
  async function callPlans(qs: string): Promise<any> {
    const req = makeReq("GET", `/api/subscription/plans${qs}`) as never;
    const res = makeRes();
    await handleListSubscriptionPlans(req, res as never);
    return JSON.parse(res._body);
  }

  test("默认(无 scope)返回个人档,无 min_seats", async (t) => {
    if (skipIfNoPg(t)) return;
    const out = await callPlans("");
    assert.equal(out.ok, true);
    assert.ok(Array.isArray(out.data.plans));
    // 个人档不含 min_seats;至少含一个非 org code
    for (const p of out.data.plans) {
      assert.equal(p.min_seats, undefined);
      assert.ok(!String(p.code).startsWith("org-"));
    }
  });

  test("scope=org 返回企业档,含 min_seats", async (t) => {
    if (skipIfNoPg(t)) return;
    const out = await callPlans("?scope=org");
    assert.equal(out.ok, true);
    const codes = out.data.plans.map((p: any) => p.code);
    assert.ok(codes.includes("org-pro"));
    assert.ok(codes.includes("org-max"));
    assert.ok(codes.includes("org-ultra"));
    for (const p of out.data.plans) {
      assert.equal(typeof p.min_seats, "number");
      assert.ok(p.min_seats >= 1);
    }
  });
});
