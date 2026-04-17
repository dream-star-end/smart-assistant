/**
 * T-53 集成:agent 订阅 DB 层(真 Postgres)。
 *
 * 覆盖(对齐 07-TASKS.md T-53 Acceptance):
 *   1. openAgentSubscription 正常:扣费 + INSERT agent_subscriptions + INSERT agent_containers(status=provisioning)
 *   2. open 同用户第二次 → AgentAlreadyActiveError(对应 HTTP 409)
 *   3. open 余额不足 → AgentInsufficientCreditsError(事务回滚:sub/container 均无新增)
 *   4. 状态查询 getAgentStatus
 *   5. cancel:auto_renew=false(本期仍有效)+ 幂等(再 cancel 无 was_auto_renew)
 *   6. markExpiredSubscriptions:人工改 end_at 到过去 → sweep 出 1 条,status='expired'
 *   7. markContainerStoppedAfterExpiry:volume_gc_at 被设成 now + N 天
 *   8. listVolumeGcCandidates:把 volume_gc_at 手动改到过去 → 出现在候选里
 *   9. markContainerRunning / markContainerError:状态迁移 + last_error 截断 2048
 *   10. 过期后再次 open(续订):subscription_id 变新;agent_containers row 同一条,status 重置 provisioning
 *
 * 不覆盖(docker-only 或属于 integ):
 *   - provisionContainer / runLifecycleTick(需要真 docker,留给 supervisor integ)
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import {
  openAgentSubscription,
  getAgentStatus,
  cancelAgentSubscription,
  markContainerRunning,
  markContainerError,
  markExpiredSubscriptions,
  markContainerStoppedAfterExpiry,
  listVolumeGcCandidates,
  markContainerRemoved,
  AgentAlreadyActiveError,
  AgentInsufficientCreditsError,
  AgentNotSubscribedError,
  DEFAULT_AGENT_PLAN_PRICE_CREDITS,
  DEFAULT_AGENT_VOLUME_GC_DAYS,
} from "../agent/index.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://test:test@127.0.0.1:55432/openclaude_test";

const REQUIRE_TEST_DB =
  process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

let pgAvailable = false;

const COMMERCIAL_TABLES = [
  "rate_limit_events",
  "admin_audit",
  "agent_audit",
  "agent_containers",
  "agent_subscriptions",
  "orders",
  "topup_plans",
  "usage_records",
  "credit_ledger",
  "model_pricing",
  "claude_accounts",
  "refresh_tokens",
  "email_verifications",
  "users",
  "schema_migrations",
];

async function cleanCommercialSchema(): Promise<void> {
  const sql = `DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`;
  await query(sql);
}

async function probe(): Promise<boolean> {
  const p = createPool({
    connectionString: TEST_DB_URL,
    max: 2,
    connectionTimeoutMillis: 1500,
  });
  try {
    await p.query("SELECT 1");
    await p.end();
    return true;
  } catch {
    try { await p.end(); } catch { /* ignore */ }
    return false;
  }
}

before(async () => {
  pgAvailable = await probe();
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) {
      throw new Error("Postgres test fixture required (CI=true or REQUIRE_TEST_DB=1)");
    }
    return;
  }
  await resetPool();
  const pool = createPool({ connectionString: TEST_DB_URL, max: 10 });
  setPoolOverride(pool);
  await cleanCommercialSchema();
  await runMigrations();
});

after(async () => {
  if (pgAvailable) {
    try { await cleanCommercialSchema(); } catch { /* ignore */ }
    await closePool();
  }
});

beforeEach(async () => {
  if (!pgAvailable) return;
  await query(
    "TRUNCATE TABLE agent_audit, agent_containers, agent_subscriptions, admin_audit, usage_records, credit_ledger, refresh_tokens, email_verifications, users RESTART IDENTITY CASCADE",
  );
});

function skipIfNoPg(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) { t.skip("pg not running"); return true; }
  return false;
}

async function createUser(email: string, credits = 0n, status = "active"): Promise<bigint> {
  const r = await query<{ id: string }>(
    "INSERT INTO users(email, password_hash, credits, role, status) VALUES ($1, 'argon2$stub', $2, 'user', $3) RETURNING id::text AS id",
    [email, credits.toString(), status],
  );
  return BigInt(r.rows[0].id);
}

const IMAGE = "openclaude/agent-runtime:latest";

// ============================================================
//  open
// ============================================================

describe("openAgentSubscription", () => {
  test("happy path: 扣 2900 积分 + INSERT sub + UPSERT container(provisioning)", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("open-ok@x.com", 3000n);
    const r = await openAgentSubscription({ userId: uid, image: IMAGE });
    assert.equal(r.balance_after, 3000n - DEFAULT_AGENT_PLAN_PRICE_CREDITS);
    assert.ok(r.subscription_id > 0n);
    assert.ok(r.container_id > 0n);
    assert.equal(r.docker_name, `agent-u${uid}`);
    assert.equal(r.workspace_volume, `agent-u${uid}-workspace`);
    assert.equal(r.home_volume, `agent-u${uid}-home`);
    // 订阅持续大约 30 天 ± 1s(PG NOW + interval)
    const dur = r.end_at.getTime() - r.start_at.getTime();
    assert.ok(dur > 29 * 86400_000 && dur < 31 * 86400_000, `duration ${dur}ms out of range`);

    // DB 侧字段验证
    const subRow = await query<{ status: string; plan: string; auto_renew: boolean }>(
      "SELECT status, plan, auto_renew FROM agent_subscriptions WHERE id = $1",
      [r.subscription_id.toString()],
    );
    assert.equal(subRow.rows[0].status, "active");
    assert.equal(subRow.rows[0].plan, "basic");
    assert.equal(subRow.rows[0].auto_renew, false);

    const conRow = await query<{ status: string; docker_id: string | null; image: string }>(
      "SELECT status, docker_id, image FROM agent_containers WHERE id = $1",
      [r.container_id.toString()],
    );
    assert.equal(conRow.rows[0].status, "provisioning");
    assert.equal(conRow.rows[0].docker_id, null);
    assert.equal(conRow.rows[0].image, IMAGE);

    // 流水 reason = agent_subscription, delta < 0
    const ledger = await query<{ delta: string; reason: string; ref_type: string | null; ref_id: string | null }>(
      "SELECT delta::text, reason, ref_type, ref_id FROM credit_ledger WHERE id = $1",
      [r.ledger_id.toString()],
    );
    assert.equal(ledger.rows[0].reason, "agent_subscription");
    assert.equal(ledger.rows[0].ref_type, "agent_sub");
    assert.equal(ledger.rows[0].ref_id, r.subscription_id.toString());
    assert.equal(ledger.rows[0].delta, `-${DEFAULT_AGENT_PLAN_PRICE_CREDITS}`);
  });

  test("重复 open 同用户 → AgentAlreadyActiveError", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("open-dup@x.com", 6000n);
    const first = await openAgentSubscription({ userId: uid, image: IMAGE });
    await assert.rejects(
      () => openAgentSubscription({ userId: uid, image: IMAGE }),
      (err: unknown) => {
        assert.ok(err instanceof AgentAlreadyActiveError);
        assert.equal((err as AgentAlreadyActiveError).subscription_id, first.subscription_id);
        assert.ok((err as AgentAlreadyActiveError).end_at instanceof Date);
        return true;
      },
    );
    // 第二次调用没扣费(users.credits 减去一次 2900)
    const bal = await query<{ credits: string }>(
      "SELECT credits::text FROM users WHERE id = $1",
      [uid.toString()],
    );
    assert.equal(BigInt(bal.rows[0].credits), 6000n - DEFAULT_AGENT_PLAN_PRICE_CREDITS);
    // 只有一条 sub 和一条 container
    const subCount = await query<{ c: string }>(
      "SELECT COUNT(*)::text AS c FROM agent_subscriptions WHERE user_id = $1",
      [uid.toString()],
    );
    assert.equal(subCount.rows[0].c, "1");
  });

  test("余额不足 → AgentInsufficientCreditsError,事务回滚 (无 sub / 无 container / 无 ledger)", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("open-poor@x.com", 100n);
    await assert.rejects(
      () => openAgentSubscription({ userId: uid, image: IMAGE }),
      (err: unknown) => {
        assert.ok(err instanceof AgentInsufficientCreditsError);
        assert.equal((err as AgentInsufficientCreditsError).balance, 100n);
        assert.equal((err as AgentInsufficientCreditsError).required, DEFAULT_AGENT_PLAN_PRICE_CREDITS);
        return true;
      },
    );
    const subCount = await query<{ c: string }>(
      "SELECT COUNT(*)::text AS c FROM agent_subscriptions WHERE user_id = $1",
      [uid.toString()],
    );
    assert.equal(subCount.rows[0].c, "0");
    const conCount = await query<{ c: string }>(
      "SELECT COUNT(*)::text AS c FROM agent_containers WHERE user_id = $1",
      [uid.toString()],
    );
    assert.equal(conCount.rows[0].c, "0");
    const ledgerCount = await query<{ c: string }>(
      "SELECT COUNT(*)::text AS c FROM credit_ledger WHERE user_id = $1",
      [uid.toString()],
    );
    assert.equal(ledgerCount.rows[0].c, "0");
    const bal = await query<{ credits: string }>(
      "SELECT credits::text FROM users WHERE id = $1",
      [uid.toString()],
    );
    assert.equal(BigInt(bal.rows[0].credits), 100n);
  });

  test("被封禁用户(status='banned')→ AgentNotSubscribedError", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("open-banned@x.com", 5000n, "banned");
    await assert.rejects(
      () => openAgentSubscription({ userId: uid, image: IMAGE }),
      (err: unknown) => err instanceof AgentNotSubscribedError,
    );
  });

  test("自定义价格 + 时长", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("open-custom@x.com", 10_000n);
    const r = await openAgentSubscription({
      userId: uid,
      priceCredits: 5000n,
      durationDays: 7,
      image: IMAGE,
    });
    assert.equal(r.balance_after, 5000n);
    const dur = r.end_at.getTime() - r.start_at.getTime();
    assert.ok(dur > 6.9 * 86400_000 && dur < 7.1 * 86400_000);
  });
});

// ============================================================
//  status
// ============================================================

describe("getAgentStatus", () => {
  test("未订阅用户:subscription 和 container 都为 null", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("status-empty@x.com", 0n);
    const v = await getAgentStatus(uid);
    assert.equal(v.subscription, null);
    assert.equal(v.container, null);
  });

  test("已订阅:返回 active 订阅 + provisioning 容器", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("status-on@x.com", 5000n);
    await openAgentSubscription({ userId: uid, image: IMAGE });
    const v = await getAgentStatus(uid);
    assert.equal(v.subscription?.status, "active");
    assert.equal(v.subscription?.plan, "basic");
    assert.equal(v.subscription?.auto_renew, false);
    assert.equal(v.container?.status, "provisioning");
    assert.equal(v.container?.docker_id, null);
  });
});

// ============================================================
//  cancel
// ============================================================

describe("cancelAgentSubscription", () => {
  test("设 auto_renew=false;本期仍有效(status=active / end_at 不变)", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("cancel-ok@x.com", 5000n);
    const opened = await openAgentSubscription({
      userId: uid,
      image: IMAGE,
      autoRenew: true,
    });
    const r = await cancelAgentSubscription(uid);
    assert.equal(r.subscription_id, opened.subscription_id);
    assert.equal(r.was_auto_renew, true);
    const after = await query<{ status: string; auto_renew: boolean; end_at: Date }>(
      "SELECT status, auto_renew, end_at FROM agent_subscriptions WHERE id = $1",
      [opened.subscription_id.toString()],
    );
    assert.equal(after.rows[0].status, "active");
    assert.equal(after.rows[0].auto_renew, false);
    assert.equal(after.rows[0].end_at.getTime(), opened.end_at.getTime());
  });

  test("无 active 订阅 → AgentNotSubscribedError", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("cancel-none@x.com", 0n);
    await assert.rejects(
      () => cancelAgentSubscription(uid),
      (err: unknown) => err instanceof AgentNotSubscribedError,
    );
  });

  test("再 cancel 幂等(was_auto_renew=false)", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("cancel-idem@x.com", 5000n);
    await openAgentSubscription({ userId: uid, image: IMAGE, autoRenew: false });
    const r = await cancelAgentSubscription(uid);
    assert.equal(r.was_auto_renew, false);
  });
});

// ============================================================
//  lifecycle primitives
// ============================================================

describe("markExpiredSubscriptions", () => {
  test("end_at < now 的 active 订阅被置 expired 并返回", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("expire-a@x.com", 5000n);
    const opened = await openAgentSubscription({ userId: uid, image: IMAGE });
    // 人工改 end_at 到过去
    await query(
      "UPDATE agent_subscriptions SET end_at = NOW() - INTERVAL '1 second' WHERE id = $1",
      [opened.subscription_id.toString()],
    );
    const expired = await markExpiredSubscriptions();
    assert.equal(expired.length, 1);
    assert.equal(expired[0].subscription_id, opened.subscription_id);
    const s = await query<{ status: string }>(
      "SELECT status FROM agent_subscriptions WHERE id = $1",
      [opened.subscription_id.toString()],
    );
    assert.equal(s.rows[0].status, "expired");
  });

  test("未到期不 sweep", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("expire-b@x.com", 5000n);
    await openAgentSubscription({ userId: uid, image: IMAGE });
    const expired = await markExpiredSubscriptions();
    assert.equal(expired.length, 0);
  });
});

describe("markContainerStoppedAfterExpiry", () => {
  test("把 container 置 stopped 并设 volume_gc_at = now + gcDays 天", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("stopped-a@x.com", 5000n);
    await openAgentSubscription({ userId: uid, image: IMAGE });
    // 模拟 provisioning → running 迁移
    await markContainerRunning(uid, "docker-id-abc");
    await markContainerStoppedAfterExpiry(uid, 30);
    const r = await query<{ status: string; volume_gc_at: Date | null; last_stopped_at: Date | null }>(
      "SELECT status, volume_gc_at, last_stopped_at FROM agent_containers WHERE user_id = $1",
      [uid.toString()],
    );
    assert.equal(r.rows[0].status, "stopped");
    assert.ok(r.rows[0].volume_gc_at);
    assert.ok(r.rows[0].last_stopped_at);
    const gap = r.rows[0].volume_gc_at!.getTime() - Date.now();
    assert.ok(gap > 29 * 86400_000 && gap < 31 * 86400_000, `gc gap ${gap}ms out of range`);
  });

  test("状态为 removed 时不 overwrite(WHERE status IN ... 排除)", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("stopped-b@x.com", 5000n);
    await openAgentSubscription({ userId: uid, image: IMAGE });
    await query(
      "UPDATE agent_containers SET status = 'removed' WHERE user_id = $1",
      [uid.toString()],
    );
    await markContainerStoppedAfterExpiry(uid, 30);
    const r = await query<{ status: string }>(
      "SELECT status FROM agent_containers WHERE user_id = $1",
      [uid.toString()],
    );
    assert.equal(r.rows[0].status, "removed");
  });
});

describe("listVolumeGcCandidates + markContainerRemoved", () => {
  test("volume_gc_at < now 的 stopped 容器出现在候选列表,markRemoved 后不再出现", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("gc-a@x.com", 5000n);
    await openAgentSubscription({ userId: uid, image: IMAGE });
    // stopped + volume_gc_at = now - 1s → 应被 GC
    await query(
      `UPDATE agent_containers
          SET status = 'stopped',
              volume_gc_at = NOW() - INTERVAL '1 second',
              last_stopped_at = NOW()
        WHERE user_id = $1`,
      [uid.toString()],
    );
    const cands = await listVolumeGcCandidates();
    assert.ok(cands.length >= 1);
    const ours = cands.find((c) => c.user_id === uid);
    assert.ok(ours);
    assert.equal(ours!.workspace_volume, `agent-u${uid}-workspace`);
    assert.equal(ours!.home_volume, `agent-u${uid}-home`);

    await markContainerRemoved(uid);
    const cands2 = await listVolumeGcCandidates();
    assert.ok(!cands2.some((c) => c.user_id === uid));

    const r = await query<{ status: string; docker_id: string | null }>(
      "SELECT status, docker_id FROM agent_containers WHERE user_id = $1",
      [uid.toString()],
    );
    assert.equal(r.rows[0].status, "removed");
    assert.equal(r.rows[0].docker_id, null);
  });

  test("未到 GC 时间的 stopped 不会出现", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("gc-b@x.com", 5000n);
    await openAgentSubscription({ userId: uid, image: IMAGE });
    await markContainerRunning(uid, "did");
    await markContainerStoppedAfterExpiry(uid, DEFAULT_AGENT_VOLUME_GC_DAYS);
    const cands = await listVolumeGcCandidates();
    assert.ok(!cands.some((c) => c.user_id === uid));
  });
});

describe("markContainerRunning / markContainerError", () => {
  test("markContainerRunning: status=running + docker_id + last_started_at", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("run-a@x.com", 5000n);
    await openAgentSubscription({ userId: uid, image: IMAGE });
    await markContainerRunning(uid, "docker-id-xyz");
    const r = await query<{ status: string; docker_id: string; last_started_at: Date; last_error: string | null }>(
      "SELECT status, docker_id, last_started_at, last_error FROM agent_containers WHERE user_id = $1",
      [uid.toString()],
    );
    assert.equal(r.rows[0].status, "running");
    assert.equal(r.rows[0].docker_id, "docker-id-xyz");
    assert.ok(r.rows[0].last_started_at);
    assert.equal(r.rows[0].last_error, null);
  });

  test("markContainerError: status=error + last_error 截断到 2048+'…'", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("err-a@x.com", 5000n);
    await openAgentSubscription({ userId: uid, image: IMAGE });
    const huge = "x".repeat(5000);
    await markContainerError(uid, huge);
    const r = await query<{ status: string; last_error: string }>(
      "SELECT status, last_error FROM agent_containers WHERE user_id = $1",
      [uid.toString()],
    );
    assert.equal(r.rows[0].status, "error");
    assert.equal(r.rows[0].last_error.length, 2049); // 2048 + '…'
    assert.ok(r.rows[0].last_error.endsWith("…"));
  });
});

// ============================================================
//  续订(过期后再次 open)
// ============================================================

describe("re-subscribe after expiry", () => {
  test("expired 订阅后再 open:sub 新建 + container 同一行(status 重置为 provisioning)", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("renew@x.com", 6000n);
    const first = await openAgentSubscription({ userId: uid, image: IMAGE });
    // 模拟过期 + stopped + volume 保留中
    await query(
      "UPDATE agent_subscriptions SET end_at = NOW() - INTERVAL '2 days', status = 'expired' WHERE id = $1",
      [first.subscription_id.toString()],
    );
    await query(
      `UPDATE agent_containers
          SET status = 'stopped',
              docker_id = 'old-id',
              last_stopped_at = NOW() - INTERVAL '2 days',
              volume_gc_at = NOW() + INTERVAL '28 days',
              last_error = 'prior msg'
        WHERE user_id = $1`,
      [uid.toString()],
    );
    // 再次 open
    const second = await openAgentSubscription({ userId: uid, image: IMAGE });
    assert.notEqual(second.subscription_id, first.subscription_id);
    assert.equal(second.container_id, first.container_id, "agent_containers 同一行");
    const r = await query<{
      status: string; docker_id: string | null; volume_gc_at: Date | null;
      last_error: string | null; subscription_id: string;
    }>(
      `SELECT status, docker_id, volume_gc_at, last_error, subscription_id::text
         FROM agent_containers WHERE user_id = $1`,
      [uid.toString()],
    );
    assert.equal(r.rows[0].status, "provisioning");
    assert.equal(r.rows[0].docker_id, null);
    assert.equal(r.rows[0].volume_gc_at, null);
    assert.equal(r.rows[0].last_error, null);
    assert.equal(r.rows[0].subscription_id, second.subscription_id.toString());
  });
});
