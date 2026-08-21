/**
 * GET /api/me/usage/report —— 个人版用量报表聚合真 PG 集成测试。
 *
 * 锁 billing/usageReport.ts getUserUsageReport + http handleGetMyUsageReport 的读侧语义:
 *   1. 7d 全契约:summary 各字段 / 趋势补零 + 桶数(7) / models 排序(credits DESC, model ASC)/
 *      ledger credited·debited / by_reason 只含支出侧;status='error' 行与窗口外行均被排除。
 *   2. window=24h → 用量趋势 + 流水趋势各 24 桶;40h 前的行落在 24h 窗口外被排除。
 *   3. 缺省 window = 7d。
 *   4. 非法 window → 400;未鉴权 → 401。
 *
 * harness 与 usageDelegateRollup.integ.test.ts 同款:probe 55432 fixture,不可用则 skip
 * (CI / REQUIRE_TEST_DB=1 下强制要求)。
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createPool,
  closePool,
  setPoolOverride,
  resetPool,
} from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { signAccess } from "../auth/jwt.js";
import {
  handleGetMyUsageReport,
  type CommercialHttpDeps,
  type RequestContext,
} from "../http/handlers.js";
import { HttpError } from "../http/util.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://test:test@127.0.0.1:55432/openclaude_test";

const REQUIRE_TEST_DB =
  process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

const JWT_SECRET = "u".repeat(64);

let pgAvailable = false;
let server: Server | null = null;
let baseUrl = "";

function assertTestDatabase(url: string): void {
  let dbName: string;
  try {
    dbName = new URL(url).pathname.replace(/^\//, "");
  } catch {
    throw new Error(`invalid TEST_DATABASE_URL: ${url}`);
  }
  if (!dbName.endsWith("_test")) {
    throw new Error(
      `refusing to reset non-test database: ${dbName} (must end with _test)`,
    );
  }
}

async function cleanCommercialSchema(): Promise<void> {
  assertTestDatabase(TEST_DB_URL);
  await query("DROP SCHEMA IF EXISTS public CASCADE");
  await query("CREATE SCHEMA public");
  await query("GRANT ALL ON SCHEMA public TO public");
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
      throw new Error(
        "Postgres test fixture required (CI=true or REQUIRE_TEST_DB=1). " +
          "See docs/V5_CI.md for bootstrap.",
      );
    }
    return;
  }
  await resetPool();
  const pool = createPool({ connectionString: TEST_DB_URL, max: 10 });
  setPoolOverride(pool);
  await cleanCommercialSchema();
  await runMigrations();

  // 最小 HTTP harness:handleGetMyUsageReport 只消费 deps.jwtSecret,ctx 未使用。
  server = createServer((req, res) => {
    void handleGetMyUsageReport(
      req,
      res,
      {} as RequestContext,
      { jwtSecret: JWT_SECRET } as unknown as CommercialHttpDeps,
    ).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (!res.headersSent) {
        res.writeHead(status, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: String((err as Error)?.message ?? err) }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  if (pgAvailable) {
    try { await cleanCommercialSchema(); } catch { /* ignore */ }
    await closePool();
  }
});

beforeEach(async () => {
  if (!pgAvailable) return;
  await query(
    "TRUNCATE TABLE usage_records, credit_ledger, users RESTART IDENTITY CASCADE",
  );
});

function skipIfNoPg(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) {
    t.skip("pg not running");
    return true;
  }
  return false;
}

async function createUser(email: string): Promise<bigint> {
  const r = await query<{ id: string }>(
    "INSERT INTO users(email, password_hash, credits, role) VALUES ($1, 'argon2$stub', 0, 'user') RETURNING id::text AS id",
    [email],
  );
  return BigInt(r.rows[0]!.id);
}

let reqSeq = 0;

/** 直插 usage_records 造数(读侧测试);ageHours 控制 created_at(距 NOW() 回退小时数)。 */
async function insertUsage(opts: {
  userId: bigint;
  model?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: bigint;
  status?: "success" | "error";
  ageHours?: number;
}): Promise<void> {
  reqSeq += 1;
  await query(
    `INSERT INTO usage_records
       (user_id, session_id, mode, model,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        price_snapshot, cost_credits, request_id, status, created_at)
     VALUES ($1, $2, 'chat', $3, $4, $5, $6, $7, '{}'::jsonb, $8, $9, $10,
             NOW() - ($11::numeric * INTERVAL '1 hour'))`,
    [
      opts.userId.toString(),
      `sess-${reqSeq}`,
      opts.model ?? "glm-5.2",
      opts.input ?? 0,
      opts.output ?? 0,
      opts.cacheRead ?? 0,
      opts.cacheWrite ?? 0,
      (opts.cost ?? 0n).toString(),
      `req-${reqSeq}`,
      opts.status ?? "success",
      opts.ageHours ?? 0,
    ],
  );
}

let ledgerSeq = 0;

/** 直插 credit_ledger 造数;delta 正=进账 / 负=出账;ageHours 控制 created_at。 */
async function insertLedger(opts: {
  userId: bigint;
  delta: bigint;
  reason: string;
  ageHours?: number;
}): Promise<void> {
  ledgerSeq += 1;
  await query(
    `INSERT INTO credit_ledger (user_id, delta, balance_after, reason, created_at)
     VALUES ($1, $2, 0, $3, NOW() - ($4::numeric * INTERVAL '1 hour'))`,
    [opts.userId.toString(), opts.delta.toString(), opts.reason, opts.ageHours ?? 0],
  );
}

type ReportResponse = {
  window: string;
  summary: {
    requests: string;
    input_tokens: string;
    output_tokens: string;
    cache_read_tokens: string;
    cache_write_tokens: string;
    credits: string;
  };
  trend: Array<{ bucket: string; requests: string; credits: string }>;
  models: Array<{
    model: string;
    requests: string;
    credits: string;
    input_tokens: string;
    output_tokens: string;
    cache_read_tokens: string;
    cache_write_tokens: string;
  }>;
  ledger: {
    trend: Array<{ bucket: string; credited: string; debited: string }>;
    by_reason: Array<{ reason: string; debited: string }>;
  };
};

async function getReport(userId: bigint, qs = ""): Promise<ReportResponse> {
  const { token } = await signAccess(
    { sub: userId.toString(), role: "user" },
    JWT_SECRET,
  );
  const res = await fetch(`${baseUrl}/api/me/usage/report${qs}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200, `GET /api/me/usage/report → ${res.status}`);
  return (await res.json()) as ReportResponse;
}

describe("GET /api/me/usage/report(integ)", () => {
  test("7d 全契约:summary / trend 补零 / models 排序 / ledger / by_reason;error+超窗行排除", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("report-7d@example.com");

    // 窗内 success 4 行(均 NOW(),落在末桶):
    await insertUsage({ userId: uid, model: "glm-5.2", cost: 10n, input: 100, output: 50, cacheRead: 5, cacheWrite: 2 });
    await insertUsage({ userId: uid, model: "glm-5.2", cost: 20n, input: 200, output: 80 });
    await insertUsage({ userId: uid, model: "claude", cost: 5n, input: 40, output: 20 });
    await insertUsage({ userId: uid, model: "minimax-m3", cost: 30n, input: 300, output: 100 });
    // error 行(应排除):
    await insertUsage({ userId: uid, model: "glm-5.2", cost: 0n, input: 999, status: "error" });
    // 窗口外(10 天前,7d=168h 外,应排除):
    await insertUsage({ userId: uid, model: "glm-5.2", cost: 100n, input: 111, ageHours: 240 });

    // 流水:进账 2(topup 1000 + refund 50)、出账 2(chat 65 + agent_chat 30);超窗 chat 100 排除。
    await insertLedger({ userId: uid, delta: 1000n, reason: "topup" });
    await insertLedger({ userId: uid, delta: 50n, reason: "refund" });
    await insertLedger({ userId: uid, delta: -65n, reason: "chat" });
    await insertLedger({ userId: uid, delta: -30n, reason: "agent_chat" });
    await insertLedger({ userId: uid, delta: -100n, reason: "chat", ageHours: 240 });

    const body = await getReport(uid, "?window=7d");
    assert.equal(body.window, "7d");

    // ── summary(error + 超窗行不计)──
    assert.equal(body.summary.requests, "4");
    assert.equal(body.summary.input_tokens, "640"); // 100+200+40+300
    assert.equal(body.summary.output_tokens, "250"); // 50+80+20+100
    assert.equal(body.summary.cache_read_tokens, "5");
    assert.equal(body.summary.cache_write_tokens, "2");
    assert.equal(body.summary.credits, "65"); // 10+20+5+30

    // ── trend:7 桶,前 6 空桶补零,末桶含全部窗内数据 ──
    assert.equal(body.trend.length, 7);
    for (let i = 0; i < 6; i++) {
      assert.equal(body.trend[i]!.requests, "0", `bucket ${i} 应补零`);
      assert.equal(body.trend[i]!.credits, "0");
    }
    const lastUsage = body.trend[6]!;
    assert.equal(lastUsage.requests, "4");
    assert.equal(lastUsage.credits, "65");
    // 升序:bucket label 单调不减
    const labels = body.trend.map((p) => p.bucket);
    assert.deepEqual(labels, [...labels].sort());

    // ── models:credits DESC, model ASC(glm 30 与 minimax 30 同分 → glm 在前)──
    assert.deepEqual(body.models, [
      { model: "glm-5.2", requests: "2", credits: "30", input_tokens: "300", output_tokens: "130", cache_read_tokens: "5", cache_write_tokens: "2" },
      { model: "minimax-m3", requests: "1", credits: "30", input_tokens: "300", output_tokens: "100", cache_read_tokens: "0", cache_write_tokens: "0" },
      { model: "claude", requests: "1", credits: "5", input_tokens: "40", output_tokens: "20", cache_read_tokens: "0", cache_write_tokens: "0" },
    ]);

    // ── ledger.trend:7 桶,末桶 credited=1050 / debited=95 ──
    assert.equal(body.ledger.trend.length, 7);
    for (let i = 0; i < 6; i++) {
      assert.equal(body.ledger.trend[i]!.credited, "0");
      assert.equal(body.ledger.trend[i]!.debited, "0");
    }
    const lastLedger = body.ledger.trend[6]!;
    assert.equal(lastLedger.credited, "1050"); // 1000 + 50
    assert.equal(lastLedger.debited, "95"); // 65 + 30

    // ── by_reason:只含支出侧,按 debited DESC(topup/refund 进账不出现)──
    assert.deepEqual(body.ledger.by_reason, [
      { reason: "chat", debited: "65" },
      { reason: "agent_chat", debited: "30" },
    ]);
  });

  test("window=24h:用量/流水趋势各 24 桶;40h 前行落窗口外被排除", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("report-24h@example.com");
    // 窗内(NOW()):
    await insertUsage({ userId: uid, model: "glm-5.2", cost: 12n, input: 10, output: 5 });
    await insertLedger({ userId: uid, delta: -12n, reason: "chat" });
    // 40h 前:7d 内、24h 外 → 24h 窗口应排除。
    await insertUsage({ userId: uid, model: "glm-5.2", cost: 99n, input: 999, ageHours: 40 });
    await insertLedger({ userId: uid, delta: -99n, reason: "chat", ageHours: 40 });

    const body = await getReport(uid, "?window=24h");
    assert.equal(body.window, "24h");
    assert.equal(body.trend.length, 24);
    assert.equal(body.ledger.trend.length, 24);
    // 只有 NOW() 那行入窗:
    assert.equal(body.summary.requests, "1");
    assert.equal(body.summary.credits, "12");
    assert.deepEqual(body.ledger.by_reason, [{ reason: "chat", debited: "12" }]);
    // hour 桶 label 形如 'MM-DD HH:00'
    assert.match(body.trend[23]!.bucket, /^\d{2}-\d{2} \d{2}:00$/);
  });

  test("缺省 window = 7d(不传参)", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("report-default@example.com");
    const body = await getReport(uid);
    assert.equal(body.window, "7d");
    assert.equal(body.trend.length, 7);
    assert.equal(body.ledger.trend.length, 7);
    // 空数据:桶齐全且全零
    assert.ok(body.trend.every((p) => p.requests === "0"));
    assert.equal(body.summary.requests, "0");
    assert.deepEqual(body.models, []);
    assert.deepEqual(body.ledger.by_reason, []);
  });

  test("非法 window → 400", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("report-bad@example.com");
    const { token } = await signAccess({ sub: uid.toString(), role: "user" }, JWT_SECRET);
    const res = await fetch(`${baseUrl}/api/me/usage/report?window=1h`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 400);
  });

  test("未鉴权 → 401", async (t) => {
    if (skipIfNoPg(t)) return;
    const res = await fetch(`${baseUrl}/api/me/usage/report?window=7d`);
    assert.equal(res.status, 401);
  });
});
