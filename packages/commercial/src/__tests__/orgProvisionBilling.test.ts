/**
 * 企业版(P3.1 二期 · 批次 F)org 购买/自助开通/席位闸/权限收紧 —— 真 DB round-trip。
 *
 * 隔离策略:专属数据库 openclaude_orgf_test(before CREATE / after DROP),不碰共享
 * openclaude_test.public —— 与 orgSubscriptions.test.ts / orgBilling.test.ts 同手法,避开
 * unit 套件里 DROP SCHEMA 型测试并发时的整库竞争(基线失败集含此类跨文件 race)。
 *
 * 覆盖(方案 §11-§14,计费/开通=错账风险区,断言宁多勿少):
 *   - org 订阅单建单校验矩阵(非 org 档 / 席位 <min_seats / >max_members / org 非 active 拒)
 *     + fulfill(grantOrgSubscriptionTx 建订阅池)+ 幂等重放。
 *   - org 加席单(kind='upgrade',plan_seats=增量,from_plan_code=NULL)+ fulfill 即时入池;
 *     订阅在窗口内过期 → fulfill 降级把等额积分入 org 钱包(不丢款)。
 *   - 自助开通全链(建单→fulfill 原子建 org+owner+订阅+回填 org_id;fulfill 时已入他 org →
 *     paid + critical 告警 + 不建 org;金额篡改拒)。
 *   - 席位闸(有订阅以 min(seats,max_members) 为准拦邀请/接受;无订阅回退 max_members;
 *     存量超编只拦新进不动存量)。
 *   - 权限收紧(路由表 minRole:topup/subscribe/seats/invoice 写面=owner;读面不动)——纯断言。
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query, tx } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { createOrg } from "../org/orgs.js";
import { getActiveMembership } from "../org/memberships.js";
import { getOrgSubscription, grantOrgSubscriptionTx } from "../org/orgSubscriptions.js";
import { createInvitation, acceptInvitation } from "../org/invitations.js";
import {
  createOrgSubscriptionOrder,
  createOrgSeatsOrder,
  createOrgProvisionOrder,
  markOrderPaid,
  getOrderByNo,
  OrderCallbackTamperedError,
} from "../payment/orders.js";
import { OrgError } from "../org/types.js";
import { billingRoutes } from "../http/org/billingRoutes.js";
import { invoicesRoutes } from "../http/org/invoicesRoutes.js";
import type { OrgRoute } from "../http/org/routeTypes.js";
import { EVENTS } from "../admin/alertEvents.js";

const BASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const MY_DB = "openclaude_orgf_test";
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
    `TRUNCATE TABLE admin_alert_outbox, admin_alert_channels, orders, credit_ledger, usage_records,
       org_invitations, org_subscriptions, org_memberships, orgs, user_subscriptions, users, admin_audit
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

let userSeq = 0;
let orgSeq = 0;

async function createUser(email?: string): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO users(email, password_hash, role, status, email_verified, free_bootstrap_settled, credits)
     VALUES ($1, 'argon2$stub', 'user', 'active', TRUE, TRUE, 0) RETURNING id::text AS id`,
    [email ?? `f-user-${++userSeq}@x.com`],
  );
  return r.rows[0].id;
}

/** 建 org(带 owner membership)。返回 {orgId, ownerId}。 */
async function makeOrg(
  opts: { maxMembers?: number; status?: string; credits?: bigint } = {},
): Promise<{ orgId: string; ownerId: string }> {
  const ownerId = await createUser(`f-org-owner-${++orgSeq}@x.com`);
  const orgId = await tx(async (client) => {
    const o = await createOrg(
      { name: `Acme-${orgSeq}`, ownerUserId: ownerId, createdBy: null, maxMembers: opts.maxMembers ?? 100 },
      client,
    );
    return o.id;
  });
  await query(`UPDATE orgs SET credits = $1, status = $2 WHERE id = $3::bigint`, [
    (opts.credits ?? 0n).toString(),
    opts.status ?? "active",
    orgId,
  ]);
  return { orgId, ownerId };
}

async function addMember(
  orgId: string,
  userId: string,
  role: "owner" | "admin" | "member" = "member",
): Promise<void> {
  await query(
    `INSERT INTO org_memberships(org_id, user_id, org_role, status, billing_enabled)
     VALUES ($1::bigint, $2::bigint, $3, 'active', TRUE)`,
    [orgId, userId, role],
  );
}

async function orgCredits(orgId: string): Promise<bigint> {
  const r = await query<{ credits: string }>(`SELECT credits::text AS credits FROM orgs WHERE id=$1::bigint`, [orgId]);
  return BigInt(r.rows[0].credits);
}

async function activeMemberCount(orgId: string): Promise<number> {
  const r = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM org_memberships WHERE org_id=$1::bigint AND status='active'`,
    [orgId],
  );
  return Number(r.rows[0].n);
}

/** 制造一封已发出的邀请(直落 DB,返回明文 token)。email 归一化交给 createInvitation 处理。 */
async function seedInvitation(orgId: string, email: string, invitedBy: string): Promise<string> {
  const r = await createInvitation({ orgId, email, orgRole: "member", invitedBy });
  return r.rawToken;
}

/** seed 一个可派发的告警通道(enabled + pending + severity_min=warning + 订阅全部事件)。 */
async function seedAlertChannel(adminId: string): Promise<void> {
  await query(
    `INSERT INTO admin_alert_channels (admin_id, channel_type, label, enabled, severity_min, activation_status)
     VALUES ($1::bigint, 'ilink_wechat', 'orgf-test', TRUE, 'warning', 'pending')`,
    [adminId],
  );
}

async function outboxCount(eventType: string, dedupeKey: string): Promise<number> {
  const r = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM admin_alert_outbox WHERE event_type=$1 AND dedupe_key=$2`,
    [eventType, dedupeKey],
  );
  return Number(r.rows[0].n);
}

// ====================================================================
// org 订阅单 — 建单校验矩阵 + fulfill + 幂等
// ====================================================================

describe("createOrgSubscriptionOrder — 建单校验 + fulfill(grant 建池)", () => {
  test("happy:kind='subscription' + org_id + plan_seats;金额=每席价×seats", async (t) => {
    if (skipIfNoPg(t)) return;
    const { orgId, ownerId } = await makeOrg();
    const order = await createOrgSubscriptionOrder({ orgId, planCode: "org-pro", seats: 3, operatorUserId: ownerId });
    assert.equal(order.kind, "subscription");
    assert.equal(order.org_id?.toString(), orgId);
    assert.equal(order.plan_code, "org-pro");
    assert.equal(order.plan_seats, 3);
    assert.equal(order.amount_cents, 8800n * 3n); // 26400(0117 与个人版对齐)
    assert.equal(order.credits, 10000n * 3n); // 30000(展示快照)
    assert.equal(order.status, "pending");
  });

  test("非 org 档 → PLAN_NOT_ORG;seats<min_seats → SEAT_BELOW_MIN;seats>max_members → SEAT_ABOVE_MAX;org 非 active → ORG_UNAVAILABLE", async (t) => {
    if (skipIfNoPg(t)) return;
    const { orgId, ownerId } = await makeOrg({ maxMembers: 5 });
    await assert.rejects(
      () => createOrgSubscriptionOrder({ orgId, planCode: "pro", seats: 2, operatorUserId: ownerId }),
      (e: unknown) => e instanceof OrgError && e.code === "PLAN_NOT_ORG",
    );
    await assert.rejects(
      () => createOrgSubscriptionOrder({ orgId, planCode: "org-pro", seats: 1, operatorUserId: ownerId }),
      (e: unknown) => e instanceof OrgError && e.code === "SEAT_BELOW_MIN",
    );
    await assert.rejects(
      () => createOrgSubscriptionOrder({ orgId, planCode: "org-pro", seats: 6, operatorUserId: ownerId }),
      (e: unknown) => e instanceof OrgError && e.code === "SEAT_ABOVE_MAX",
    );
    // org 非 active
    const { orgId: suspId, ownerId: suspOwner } = await makeOrg({ status: "suspended" });
    await assert.rejects(
      () => createOrgSubscriptionOrder({ orgId: suspId, planCode: "org-pro", seats: 2, operatorUserId: suspOwner }),
      (e: unknown) => e instanceof OrgError && e.code === "ORG_UNAVAILABLE",
    );
    // 全部拒绝后无订单落库
    const cnt = await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM orders`);
    assert.equal(cnt.rows[0].n, "0");
  });

  test("fulfill:markOrderPaid → grantOrgSubscriptionTx 建订阅池;幂等重放不重复入账", async (t) => {
    if (skipIfNoPg(t)) return;
    const { orgId, ownerId } = await makeOrg();
    const order = await createOrgSubscriptionOrder({ orgId, planCode: "org-pro", seats: 3, operatorUserId: ownerId });

    const first = await markOrderPaid({ orderNo: order.order_no, callbackPayload: {}, expectedAmountCents: 26400n });
    assert.equal(first.newlyPaid, true);
    assert.equal(first.order.status, "paid");

    const sub = await getOrgSubscription(orgId);
    assert.ok(sub);
    assert.equal(sub!.planCode, "org-pro");
    assert.equal(sub!.seats, 3);
    assert.equal(sub!.periodCredits, 30000n); // 3×10000 池化
    assert.equal(sub!.status, "active");

    // 幂等重放:不再翻状态、不再加池
    const replay = await markOrderPaid({ orderNo: order.order_no, callbackPayload: {}, expectedAmountCents: 26400n });
    assert.equal(replay.newlyPaid, false);
    const sub2 = await getOrgSubscription(orgId);
    assert.equal(sub2!.periodCredits, 30000n, "重放不重复入池");
  });
});

// ====================================================================
// org 加席单 — build + fulfill + 过期降级入钱包
// ====================================================================

describe("createOrgSeatsOrder — 加席(kind='upgrade' 增量)+ fulfill", () => {
  test("happy:kind='upgrade' + plan_seats=增量 + from_plan_code=NULL;fulfill 即时入池", async (t) => {
    if (skipIfNoPg(t)) return;
    const { orgId, ownerId } = await makeOrg();
    await tx((c) => grantOrgSubscriptionTx(c, { orgId, planCode: "org-pro", seats: 2, operatorUserId: ownerId }));

    const order = await createOrgSeatsOrder({ orgId, seats: 3, operatorUserId: ownerId });
    assert.equal(order.kind, "upgrade");
    assert.equal(order.org_id?.toString(), orgId);
    assert.equal(order.plan_seats, 3); // 增量
    assert.equal(order.from_plan_code, null);
    assert.equal(order.amount_cents, 8800n * 3n);

    await markOrderPaid({ orderNo: order.order_no, callbackPayload: {}, expectedAmountCents: 26400n });
    const sub = await getOrgSubscription(orgId);
    assert.equal(sub!.seats, 5); // 2 + 3
    assert.equal(sub!.periodCredits, 50000n); // 20000 + 3×10000
  });

  test("无订阅加席 → NO_ORG_SUBSCRIPTION(建单拒)", async (t) => {
    if (skipIfNoPg(t)) return;
    const { orgId, ownerId } = await makeOrg();
    await assert.rejects(
      () => createOrgSeatsOrder({ orgId, seats: 1, operatorUserId: ownerId }),
      (e: unknown) => e instanceof OrgError && e.code === "NO_ORG_SUBSCRIPTION",
    );
  });

  test("订阅在窗口内过期 → fulfill 降级把等额积分入 org 钱包(不丢款)", async (t) => {
    if (skipIfNoPg(t)) return;
    const { orgId, ownerId } = await makeOrg({ credits: 0n });
    await tx((c) => grantOrgSubscriptionTx(c, { orgId, planCode: "org-pro", seats: 2, operatorUserId: ownerId }));
    const order = await createOrgSeatsOrder({ orgId, seats: 3, operatorUserId: ownerId }); // credits=30000

    // 建单后、支付前订阅过期(sweeper 尚未轮转)
    await query(`UPDATE org_subscriptions SET period_end = NOW() - INTERVAL '1 day' WHERE org_id=$1::bigint`, [orgId]);

    const r = await markOrderPaid({ orderNo: order.order_no, callbackPayload: {}, expectedAmountCents: 26400n });
    assert.equal(r.order.status, "paid");
    // 降级:等额 30000 入 org 钱包,不进期内池
    assert.equal(await orgCredits(orgId), 30000n);
    const sub = await getOrgSubscription(orgId);
    assert.equal(sub!.seats, 2, "席位未变(未走加席)");
    // org_wallet 流水存在
    const w = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM credit_ledger WHERE org_id=$1::bigint AND bucket='org_wallet'`,
      [orgId],
    );
    assert.equal(w.rows[0].n, "1");
  });
});

// ====================================================================
// 自助开通 — 建单 → fulfill 原子建 org / 冲突 / 篡改
// ====================================================================

describe("createOrgProvisionOrder + fulfill — 自助开通全链", () => {
  test("happy:fulfill 原子建 org+owner+订阅 + 回填 orders.org_id", async (t) => {
    if (skipIfNoPg(t)) return;
    const payer = await createUser("f-payer@x.com");
    const order = await createOrgProvisionOrder({ userId: payer, orgName: "新公司", planCode: "org-pro", seats: 2 });
    assert.equal(order.kind, "org_provision");
    assert.equal(order.org_id, null);
    assert.equal(order.org_name, "新公司");
    assert.equal(order.plan_seats, 2);
    assert.equal(order.amount_cents, 8800n * 2n);

    const r = await markOrderPaid({ orderNo: order.order_no, callbackPayload: {}, expectedAmountCents: 17600n });
    assert.equal(r.order.status, "paid");
    assert.notEqual(r.order.org_id, null, "开通单回填 org_id");

    // payer 现在是新 org 的 owner
    const m = await getActiveMembership(payer);
    assert.ok(m);
    assert.equal(m!.org_role, "owner");
    // 新 org 有订阅池
    const sub = await getOrgSubscription(m!.org_id);
    assert.equal(sub!.seats, 2);
    assert.equal(sub!.periodCredits, 20000n);
    // 回填的 org_id 与新 org 一致
    const back = await getOrderByNo(order.order_no);
    assert.equal(back!.org_id?.toString(), m!.org_id);
  });

  test("建单预检:已属于某 org → ALREADY_IN_ORG", async (t) => {
    if (skipIfNoPg(t)) return;
    const payer = await createUser("f-payer2@x.com");
    const { orgId } = await makeOrg();
    await addMember(orgId, payer, "member");
    await assert.rejects(
      () => createOrgProvisionOrder({ userId: payer, orgName: "X", planCode: "org-pro", seats: 2 }),
      (e: unknown) => e instanceof OrgError && e.code === "ALREADY_IN_ORG",
    );
  });

  test("fulfill 时已入他 org → 订单 paid + critical 告警 + 不建 org(§13)", async (t) => {
    if (skipIfNoPg(t)) return;
    const admin = await createUser("f-admin@x.com");
    await seedAlertChannel(admin);
    const payer = await createUser("f-payer3@x.com");

    // 1) 无 org 时建开通单(预检通过)
    const order = await createOrgProvisionOrder({ userId: payer, orgName: "Late", planCode: "org-pro", seats: 2 });
    // 2) 支付前 payer 被加入他人 org(uq_user_active_org 窗口)
    const { orgId: otherOrg } = await makeOrg();
    await addMember(otherOrg, payer, "member");

    // 3) fulfill:检测冲突 → paid + 告警 + 不建 org
    const r = await markOrderPaid({ orderNo: order.order_no, callbackPayload: {}, expectedAmountCents: 17600n });
    assert.equal(r.order.status, "paid", "订单照常 paid");
    assert.equal(r.order.org_id, null, "冲突单不回填 org_id");

    // payer 仍只属于 otherOrg,且非 owner(没有新建 org)
    const m = await getActiveMembership(payer);
    assert.equal(m!.org_id, otherOrg);
    assert.equal(m!.org_role, "member");
    assert.equal(await activeMemberCount(otherOrg), 2);
    // 没有以 payer 为 owner 的新 org
    const owned = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM org_memberships WHERE user_id=$1::bigint AND org_role='owner'`,
      [payer],
    );
    assert.equal(owned.rows[0].n, "0", "未建以 payer 为 owner 的新 org");

    // critical 告警已 durable 入 outbox
    assert.equal(
      await outboxCount(EVENTS.PAYMENT_CALLBACK_CONFLICT, `org.provision_conflict:${order.order_no}`),
      1,
      "冲突告警入队",
    );
  });

  test("金额篡改:expectedAmountCents 不符 → OrderCallbackTamperedError,不建 org", async (t) => {
    if (skipIfNoPg(t)) return;
    const payer = await createUser("f-payer4@x.com");
    const order = await createOrgProvisionOrder({ userId: payer, orgName: "Tamper", planCode: "org-pro", seats: 2 });
    await assert.rejects(
      () => markOrderPaid({ orderNo: order.order_no, callbackPayload: {}, expectedAmountCents: 100n }),
      (e: unknown) => e instanceof OrderCallbackTamperedError && e.field === "amount_cents",
    );
    // 订单仍 pending,未建 org
    const back = await getOrderByNo(order.order_no);
    assert.equal(back!.status, "pending");
    assert.equal(await getActiveMembership(payer), null);
  });
});

// ====================================================================
// 席位闸(§14:只拦新进)
// ====================================================================

describe("席位闸 — min(seats, max_members) 拦新进,存量不受影响", () => {
  test("有订阅 seats<max_members:以 seats 为准拦邀请创建 + 接受", async (t) => {
    if (skipIfNoPg(t)) return;
    const { orgId, ownerId } = await makeOrg({ maxMembers: 100 });
    await tx((c) => grantOrgSubscriptionTx(c, { orgId, planCode: "org-pro", seats: 2, operatorUserId: ownerId }));
    // active=1(owner),cap=min(2,100)=2 → 还能进 1 人。
    const m1 = await createUser("f-m1@x.com");
    const m2 = await createUser("f-m2@x.com");
    // 趁 active=1(<2)造两封邀请(软闸都放行)
    const t1 = await seedInvitation(orgId, "f-m1@x.com", ownerId);
    const t2 = await seedInvitation(orgId, "f-m2@x.com", ownerId);
    // 接受第一封 → active=2
    await acceptInvitation(t1, m1);
    assert.equal(await activeMemberCount(orgId), 2);
    // 接受第二封 → 权威席位闸(active 2 >= cap 2)拒
    await assert.rejects(
      () => acceptInvitation(t2, m2),
      (e: unknown) => e instanceof OrgError && e.code === "SEATS_FULL",
    );
    // 满员后创建新邀请也被软闸拒
    await assert.rejects(
      () => createInvitation({ orgId, email: "f-m3@x.com", orgRole: "member", invitedBy: ownerId }),
      (e: unknown) => e instanceof OrgError && e.code === "SEATS_FULL",
    );
    assert.equal(await activeMemberCount(orgId), 2, "存量未变");
  });

  test("无订阅:席位闸回退 max_members", async (t) => {
    if (skipIfNoPg(t)) return;
    const { orgId, ownerId } = await makeOrg({ maxMembers: 2 });
    // 无订阅 → cap=max_members=2;active=1(owner) → 还能进 1。
    const m1 = await createUser("f-n1@x.com");
    const t1 = await seedInvitation(orgId, "f-n1@x.com", ownerId);
    await acceptInvitation(t1, m1);
    assert.equal(await activeMemberCount(orgId), 2);
    // 满(active 2 >= max 2)→ 新邀请拒
    await assert.rejects(
      () => createInvitation({ orgId, email: "f-n2@x.com", orgRole: "member", invitedBy: ownerId }),
      (e: unknown) => e instanceof OrgError && e.code === "SEATS_FULL",
    );
  });

  test("存量超编(seats<现有成员):只拦新进,不动存量成员", async (t) => {
    if (skipIfNoPg(t)) return;
    const { orgId, ownerId } = await makeOrg({ maxMembers: 100 });
    // 先塞 3 个活跃成员(owner + 2),再把订阅席位设为 2(降席/少买场景)。
    await addMember(orgId, await createUser("f-o1@x.com"), "member");
    await addMember(orgId, await createUser("f-o2@x.com"), "member");
    await tx((c) => grantOrgSubscriptionTx(c, { orgId, planCode: "org-pro", seats: 2, operatorUserId: ownerId }));
    assert.equal(await activeMemberCount(orgId), 3); // 超编:3 > cap 2

    // 新进被拦
    await assert.rejects(
      () => createInvitation({ orgId, email: "f-new@x.com", orgRole: "member", invitedBy: ownerId }),
      (e: unknown) => e instanceof OrgError && e.code === "SEATS_FULL",
    );
    // 存量 3 人原封不动
    assert.equal(await activeMemberCount(orgId), 3);
  });
});

// ====================================================================
// 权限收紧(§14)—— 路由表 minRole 声明式断言(结构性 gate)
// ====================================================================

// 计费写面门:§14 owner-only → §17.3(批次 H)放开给财务委派,minRole 从 'owner' 改
// 'billing'(=owner ∥ billing_delegate,requireOrgRole 单独判)。此结构断言随之更新。
describe("权限门 — 计费写面 billing(owner ∥ 委派),读面不动", () => {
  function roleOf(routes: OrgRoute[], method: string, pattern: string): string | null | undefined {
    return routes.find((r) => r.method === method && r.pattern === pattern)?.minRole;
  }

  test("billingRoutes:写面 billing,读面 member/admin,自助开通 null", () => {
    // 纯路由表断言,不需 DB。
    assert.equal(roleOf(billingRoutes, "POST", "/api/org/topup"), "billing");
    assert.equal(roleOf(billingRoutes, "POST", "/api/org/subscribe"), "billing");
    assert.equal(roleOf(billingRoutes, "POST", "/api/org/seats"), "billing");
    assert.equal(roleOf(billingRoutes, "GET", "/api/org/subscription"), "member");
    assert.equal(roleOf(billingRoutes, "GET", "/api/org/balance"), "member");
    assert.equal(roleOf(billingRoutes, "GET", "/api/org/orders"), "admin");
    assert.equal(roleOf(billingRoutes, "GET", "/api/org/ledger"), "admin");
    assert.equal(roleOf(billingRoutes, "POST", "/api/org/provision"), null);
    assert.equal(roleOf(billingRoutes, "GET", "/api/org/plans"), null);
  });

  test("invoicesRoutes:写面(PUT profile / POST invoices)billing,读面 admin", () => {
    assert.equal(roleOf(invoicesRoutes, "PUT", "/api/org/invoice-profile"), "billing");
    assert.equal(roleOf(invoicesRoutes, "POST", "/api/org/invoices"), "billing");
    assert.equal(roleOf(invoicesRoutes, "GET", "/api/org/invoice-profile"), "admin");
    assert.equal(roleOf(invoicesRoutes, "GET", "/api/org/invoices"), "admin");
  });
});
