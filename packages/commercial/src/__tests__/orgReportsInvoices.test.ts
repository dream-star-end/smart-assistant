/**
 * 企业版(P3.1)批次 D 行为测试 —— 真 DB round-trip。
 *
 * 隔离:专属库 openclaude_orgd_test(before CREATE / after DROP),不碰共享 openclaude_test.public
 * (仿批次 A orgEnterprise.test.ts,规避并发 unit 的 DROP SCHEMA 竞争)。
 *
 * 覆盖:
 *   - 报表聚合(orgReports):summary / 按成员(delegate 归队长)/ 按模型 / 趋势桶数;
 *     org 隔离(他 org 用量不计)+ 窗口过滤(超窗行不计)。
 *   - 发票(orgInvoices):抬头 upsert;createInvoiceRequest 校验矩阵(无抬头 / 非本 org 订单 /
 *     未付 / 重复占用)+ happy(金额合计 + 快照);admin 队列 + 处理状态机(issued/rejected/幂等 409)。
 *
 * org_id 列由批次 B 的 0112 迁移落到 usage_records/orders;为让本文件在批次 B 缺席时仍自洽,
 * before 里补一次 `ADD COLUMN IF NOT EXISTS`(与 0112 幂等,0112 已应用则 no-op)。
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { createPool, closePool, resetPool, setPoolOverride } from "../db/index.js";
import { query, tx } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { createOrg } from "../org/orgs.js";
import { OrgError } from "../org/types.js";
import { getOrgUsageReport } from "../org/orgReports.js";
import {
  upsertInvoiceProfile,
  getInvoiceProfile,
  createInvoiceRequest,
  listInvoiceRequests,
  listAdminInvoiceRequests,
  processInvoiceRequest,
} from "../org/orgInvoices.js";

const BASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const MY_DB = "openclaude_orgd_test";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

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
  // 批次 B(0112)缺席时的自洽兜底:补 org_id 列(与 0112 幂等)。
  await query(`ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS org_id BIGINT`);
  await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS org_id BIGINT`);
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
    `TRUNCATE TABLE orgs, org_memberships, users, admin_audit, usage_records, orders,
       org_invoice_profiles, org_invoice_requests, credit_ledger
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

async function createUser(email: string, displayName?: string): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO users(email, password_hash, role, status, email_verified, free_bootstrap_settled, display_name)
     VALUES ($1, 'argon2$stub', 'user', 'active', TRUE, TRUE, $2) RETURNING id::text AS id`,
    [email, displayName ?? null],
  );
  return r.rows[0].id;
}

async function makeOrg(ownerId: string, name = "Acme"): Promise<string> {
  return tx(async (client) => {
    const o = await createOrg({ name, ownerUserId: ownerId, createdBy: null }, client);
    return o.id;
  });
}

async function addMember(orgId: string, userId: string, role: "admin" | "member" = "member"): Promise<void> {
  await query(
    `INSERT INTO org_memberships(org_id, user_id, org_role, status, billing_enabled)
     VALUES ($1::bigint, $2::bigint, $3, 'active', TRUE)`,
    [orgId, userId, role],
  );
}

let usageSeq = 0;
interface UsageOpts {
  orgId: string | null;
  userId: string;
  model?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
  mode?: "chat" | "delegate";
  parentSession?: string | null;
  delegateAgent?: string | null;
  ageHours?: number;
}
async function insertUsage(o: UsageOpts): Promise<void> {
  usageSeq += 1;
  await query(
    `INSERT INTO usage_records
       (user_id, org_id, session_id, mode, model, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, price_snapshot, cost_credits, request_id,
        status, parent_session_id, delegate_agent_id, created_at)
     VALUES ($1::bigint, $2::bigint, $3, $4, $5, $6, $7, $8, $9, '{}'::jsonb, $10, $11, 'success',
             $12, $13, NOW() - ($14::numeric * INTERVAL '1 hour'))`,
    [
      o.userId,
      o.orgId,
      `sess-${usageSeq}`,
      o.mode ?? "chat",
      o.model ?? "glm-5.2",
      o.input ?? 0,
      o.output ?? 0,
      o.cacheRead ?? 0,
      o.cacheWrite ?? 0,
      o.cost ?? 0,
      `req-${usageSeq}`,
      o.parentSession ?? null,
      o.delegateAgent ?? null,
      o.ageHours ?? 0,
    ],
  );
}

let orderSeq = 0;
async function insertOrder(
  orgId: string | null,
  userId: string,
  opts: { amountCents: number; credits?: number; status?: string } = { amountCents: 10000 },
): Promise<string> {
  orderSeq += 1;
  const r = await query<{ id: string }>(
    `INSERT INTO orders(order_no, user_id, org_id, provider, amount_cents, credits, status, expires_at, paid_at, created_at)
     VALUES ($1, $2::bigint, $3::bigint, 'hupijiao', $4, $5, $6, NOW() + INTERVAL '1 day', $7, NOW())
     RETURNING id::text AS id`,
    [
      `ord-${orderSeq}-${Date.now()}`,
      userId,
      orgId,
      opts.amountCents,
      opts.credits ?? opts.amountCents,
      opts.status ?? "paid",
      opts.status === "paid" || opts.status === undefined ? new Date() : null,
    ],
  );
  return r.rows[0].id;
}

// ====================================================================
// 报表聚合
// ====================================================================

describe("orgReports — 用量聚合", () => {
  test("summary / 按成员(delegate 归队长)/ 按模型 / 趋势桶数", async (t) => {
    if (skipIfNoPg(t)) return;
    const owner = await createUser("owner@x.com", "队长");
    const orgId = await makeOrg(owner);
    const member = await createUser("m@x.com", "成员乙");
    await addMember(orgId, member);

    // 队长两次 chat + 一条 delegate(归队长 user_id);成员一次 chat。
    await insertUsage({ orgId, userId: owner, model: "glm-5.2", input: 100, output: 50, cost: 10 });
    await insertUsage({ orgId, userId: owner, model: "claude", input: 200, output: 80, cost: 20 });
    await insertUsage({
      orgId, userId: owner, model: "glm-5.2", input: 40, output: 20, cost: 5,
      mode: "delegate", parentSession: "web-1", delegateAgent: "coder",
    });
    await insertUsage({ orgId, userId: member, model: "glm-5.2", input: 300, output: 100, cost: 30 });

    const rep = await getOrgUsageReport(orgId, "7d");

    // summary:4 行,cost 合计 65,input 合计 640。
    assert.equal(rep.summary.requests, "4");
    assert.equal(rep.summary.credits, "65");
    assert.equal(rep.summary.input_tokens, "640");
    assert.equal(rep.summary.output_tokens, "250");

    // 按成员:2 行,队长含 delegate(10+20+5=35),成员 30。
    assert.equal(rep.members.length, 2);
    const leaderRow = rep.members.find((r) => r.user_id === owner);
    const memberRow = rep.members.find((r) => r.user_id === member);
    assert.ok(leaderRow && memberRow);
    assert.equal(leaderRow.credits, "35");
    assert.equal(leaderRow.email, "owner@x.com");
    assert.equal(leaderRow.display_name, "队长");
    assert.equal(leaderRow.requests, "3"); // 含 delegate 行
    assert.equal(memberRow.credits, "30");
    // 排序:credits desc → 队长(35)在前。
    assert.equal(rep.members[0].user_id, owner);

    // 按模型:glm-5.2(10+5+30=45) + claude(20)。
    const glm = rep.models.find((r) => r.model === "glm-5.2");
    const claude = rep.models.find((r) => r.model === "claude");
    assert.equal(glm?.credits, "45");
    assert.equal(claude?.credits, "20");
    assert.equal(rep.models[0].model, "glm-5.2"); // credits desc

    // 趋势:7d → 7 桶(按天),末桶含今日数据。
    assert.equal(rep.trend.length, 7);
    const last = rep.trend[rep.trend.length - 1];
    assert.equal(last.requests, "4");
  });

  test("org 隔离:他 org 用量不计入本 org", async (t) => {
    if (skipIfNoPg(t)) return;
    const ownerA = await createUser("oa@x.com");
    const orgA = await makeOrg(ownerA, "A");
    const ownerB = await createUser("ob@x.com");
    const orgB = await makeOrg(ownerB, "B");
    await insertUsage({ orgId: orgA, userId: ownerA, cost: 10 });
    await insertUsage({ orgId: orgB, userId: ownerB, cost: 99 });

    const repA = await getOrgUsageReport(orgA, "7d");
    assert.equal(repA.summary.requests, "1");
    assert.equal(repA.summary.credits, "10");
  });

  test("窗口过滤:超窗行不计(24h 排除 40h 前;7d 含之)", async (t) => {
    if (skipIfNoPg(t)) return;
    const owner = await createUser("owner@x.com");
    const orgId = await makeOrg(owner);
    await insertUsage({ orgId, userId: owner, cost: 5, ageHours: 1 });   // 窗内
    await insertUsage({ orgId, userId: owner, cost: 50, ageHours: 40 }); // 24h 外,7d 内

    const rep24 = await getOrgUsageReport(orgId, "24h");
    assert.equal(rep24.summary.requests, "1");
    assert.equal(rep24.summary.credits, "5");
    assert.equal(rep24.trend.length, 24); // 24h → 24 小时桶

    const rep7 = await getOrgUsageReport(orgId, "7d");
    assert.equal(rep7.summary.requests, "2");
    assert.equal(rep7.summary.credits, "55");
  });

  test("空 org → 全零 + 趋势桶齐全", async (t) => {
    if (skipIfNoPg(t)) return;
    const owner = await createUser("owner@x.com");
    const orgId = await makeOrg(owner);
    const rep = await getOrgUsageReport(orgId, "30d");
    assert.equal(rep.summary.requests, "0");
    assert.equal(rep.summary.credits, "0");
    assert.equal(rep.members.length, 0);
    assert.equal(rep.models.length, 0);
    assert.equal(rep.trend.length, 30);
    assert.ok(rep.trend.every((p) => p.requests === "0"));
  });
});

// ====================================================================
// 发票
// ====================================================================

describe("orgInvoices — 抬头 + 申请校验矩阵", () => {
  test("抬头 upsert → get 反映最新", async (t) => {
    if (skipIfNoPg(t)) return;
    const owner = await createUser("owner@x.com");
    const orgId = await makeOrg(owner);
    await upsertInvoiceProfile(orgId, { title: "甲公司", taxId: "91310000X", email: "fin@a.com" }, owner);
    let p = await getInvoiceProfile(orgId);
    assert.equal(p?.title, "甲公司");
    assert.equal(p?.tax_id, "91310000X");
    assert.equal(p?.email, "fin@a.com");
    // upsert 覆盖
    await upsertInvoiceProfile(orgId, { title: "甲公司改", address: "上海" }, owner);
    p = await getInvoiceProfile(orgId);
    assert.equal(p?.title, "甲公司改");
    assert.equal(p?.address, "上海");
    assert.equal(p?.tax_id, null); // 未传 → 归 null
  });

  test("无抬头 → PROFILE_REQUIRED", async (t) => {
    if (skipIfNoPg(t)) return;
    const owner = await createUser("owner@x.com");
    const orgId = await makeOrg(owner);
    const oid = await insertOrder(orgId, owner, { amountCents: 10000 });
    await assert.rejects(
      () => createInvoiceRequest(orgId, [oid], owner),
      (e: unknown) => e instanceof OrgError && e.code === "PROFILE_REQUIRED",
    );
  });

  test("非本 org 订单 → INVALID_ORDERS", async (t) => {
    if (skipIfNoPg(t)) return;
    const owner = await createUser("owner@x.com");
    const orgId = await makeOrg(owner);
    await upsertInvoiceProfile(orgId, { title: "甲" }, owner);
    const ownerB = await createUser("ob@x.com");
    const orgB = await makeOrg(ownerB, "B");
    const foreign = await insertOrder(orgB, ownerB, { amountCents: 10000 });
    await assert.rejects(
      () => createInvoiceRequest(orgId, [foreign], owner),
      (e: unknown) => e instanceof OrgError && e.code === "INVALID_ORDERS",
    );
  });

  test("未付订单 → INVALID_ORDERS", async (t) => {
    if (skipIfNoPg(t)) return;
    const owner = await createUser("owner@x.com");
    const orgId = await makeOrg(owner);
    await upsertInvoiceProfile(orgId, { title: "甲" }, owner);
    const pending = await insertOrder(orgId, owner, { amountCents: 10000, status: "pending" });
    await assert.rejects(
      () => createInvoiceRequest(orgId, [pending], owner),
      (e: unknown) => e instanceof OrgError && e.code === "INVALID_ORDERS",
    );
  });

  test("happy:金额=合计,快照抬头,status pending", async (t) => {
    if (skipIfNoPg(t)) return;
    const owner = await createUser("owner@x.com");
    const orgId = await makeOrg(owner);
    await upsertInvoiceProfile(orgId, { title: "甲公司", taxId: "TAX1" }, owner);
    const o1 = await insertOrder(orgId, owner, { amountCents: 10000 });
    const o2 = await insertOrder(orgId, owner, { amountCents: 25000 });
    const req = await createInvoiceRequest(orgId, [o1, o2], owner);
    assert.equal(req.amount_cents, "35000");
    assert.equal(req.status, "pending");
    assert.deepEqual(new Set(req.order_ids), new Set([o1, o2]));
    const snap = req.profile_snapshot as { title: string; tax_id: string | null };
    assert.equal(snap.title, "甲公司");
    assert.equal(snap.tax_id, "TAX1");
    const list = await listInvoiceRequests(orgId);
    assert.equal(list.length, 1);
  });

  test("重复占用:已在未拒绝申请中的订单 → ORDER_ALREADY_REQUESTED", async (t) => {
    if (skipIfNoPg(t)) return;
    const owner = await createUser("owner@x.com");
    const orgId = await makeOrg(owner);
    await upsertInvoiceProfile(orgId, { title: "甲" }, owner);
    const o1 = await insertOrder(orgId, owner, { amountCents: 10000 });
    const o2 = await insertOrder(orgId, owner, { amountCents: 20000 });
    await createInvoiceRequest(orgId, [o1], owner);
    // o1 已被占用;含 o1 的新申请应拒
    await assert.rejects(
      () => createInvoiceRequest(orgId, [o1, o2], owner),
      (e: unknown) => e instanceof OrgError && e.code === "ORDER_ALREADY_REQUESTED",
    );
    // 未占用的 o2 单独申请可以
    const ok = await createInvoiceRequest(orgId, [o2], owner);
    assert.equal(ok.amount_cents, "20000");
  });

  test("被拒申请释放订单 → 可重新申请", async (t) => {
    if (skipIfNoPg(t)) return;
    const admin = await createUser("admin@x.com");
    const owner = await createUser("owner@x.com");
    const orgId = await makeOrg(owner);
    await upsertInvoiceProfile(orgId, { title: "甲" }, owner);
    const o1 = await insertOrder(orgId, owner, { amountCents: 10000 });
    const first = await createInvoiceRequest(orgId, [o1], owner);
    await processInvoiceRequest(first.id, "rejected", "信息不全", { adminId: admin });
    // 拒绝后 o1 释放,可再申请
    const again = await createInvoiceRequest(orgId, [o1], owner);
    assert.equal(again.status, "pending");
  });
});

// ====================================================================
// 平台处理状态机
// ====================================================================

describe("orgInvoices — admin 队列 + 处理", () => {
  async function setup() {
    const admin = await createUser("admin@x.com");
    const owner = await createUser("owner@x.com");
    const orgId = await makeOrg(owner, "甲公司");
    await upsertInvoiceProfile(orgId, { title: "甲公司" }, owner);
    const o1 = await insertOrder(orgId, owner, { amountCents: 10000 });
    const req = await createInvoiceRequest(orgId, [o1], owner);
    return { admin, owner, orgId, req };
  }

  test("列表带 org_name + status 过滤", async (t) => {
    if (skipIfNoPg(t)) return;
    const { req } = await setup();
    const all = await listAdminInvoiceRequests({});
    assert.equal(all.rows.length, 1);
    assert.equal(all.rows[0].org_name, "甲公司");
    assert.equal(all.rows[0].id, req.id);
    const pending = await listAdminInvoiceRequests({ status: "pending" });
    assert.equal(pending.rows.length, 1);
    const issued = await listAdminInvoiceRequests({ status: "issued" });
    assert.equal(issued.rows.length, 0);
  });

  test("pending → issued(+备注)+ 审计;二次处理 → ALREADY_PROCESSED(409)", async (t) => {
    if (skipIfNoPg(t)) return;
    const { admin, req } = await setup();
    const done = await processInvoiceRequest(req.id, "issued", "已寄出 SF123", { adminId: admin });
    assert.equal(done.status, "issued");
    assert.equal(done.admin_note, "已寄出 SF123");
    assert.equal(done.processed_by, admin);
    assert.ok(done.processed_at);
    // 审计
    const audit = await query<{ action: string; target: string }>(
      `SELECT action, target FROM admin_audit ORDER BY id DESC LIMIT 1`,
    );
    assert.equal(audit.rows[0].action, "org.invoice.process");
    assert.equal(audit.rows[0].target, `org_invoice:${req.id}`);
    // 幂等:已终态不可再处理
    await assert.rejects(
      () => processInvoiceRequest(req.id, "rejected", null, { adminId: admin }),
      (e: unknown) => e instanceof OrgError && e.status === 409 && e.code === "ALREADY_PROCESSED",
    );
  });

  test("处理不存在的申请 → 404", async (t) => {
    if (skipIfNoPg(t)) return;
    const admin = await createUser("admin@x.com");
    await assert.rejects(
      () => processInvoiceRequest("999999", "issued", null, { adminId: admin }),
      (e: unknown) => e instanceof OrgError && e.status === 404,
    );
  });
});
