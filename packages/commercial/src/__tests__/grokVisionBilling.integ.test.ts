/**
 * 集成:Grok 识图后端(/internal/v3/grok-vision)的计费落账,真实 Postgres。
 *
 * 单测(grokVisionProxyHandler.test.ts)用假的计费函数锁调用顺序;这里把
 * preCheckWithCost / startInflightJournal / settleDurableCodexBilling / abortInflightJournal
 * 全部换成真的,只有上游 HTTP 是假的,断言三处账一致:
 *   usage_records.cost_credits = ceil((input×价 + output×价 + cache_read×价) × 倍率 / 1e6)
 *   request_finalize_journal: committed,final_credits、usage_id、ledger_id 指向同一笔
 *   credit_ledger: 一条扣减,users.credits 同步减少
 * 以及失败路径一分不扣:journal aborted、无 usage 行、无流水、预扣已释放。
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";

import { InMemoryPreCheckRedis } from "../billing/preCheck.js";
import { PricingCache } from "../billing/pricing.js";
import type { ModelCatalogSnapshot } from "../billing/modelCatalog.js";
import type { UserModelAuthz } from "../auth/userModelAuthz.js";
import { closePool, createPool, getPool, resetPool, setPoolOverride } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { query } from "../db/queries.js";
import {
  GROK_VISION_JOURNAL_SOURCE,
  __resetGrokVisionRateState,
  makeGrokVisionHandler,
} from "../grok/visionProxy.js";
import { resetTestSchemaForTest } from "./helpers/db.js";
import {
  GROK_TOKEN_BYTES,
  PNG_BASE64,
  PUBLIC_VISION_AUTHZ,
  VISION_CTX,
  grokVisionSnapshot,
  grokVisionUpstreamPayload,
  visionIdentityRepo,
  visionReq,
  visionRes,
  visionToken,
} from "./helpers/grokVisionFixtures.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://test:test@127.0.0.1:55432/openclaude_test";

const REQUIRE_TEST_DB =
  process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

let pgAvailable = false;

async function probe(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 });
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
          "See packages/commercial/README.md for bootstrap.",
      );
    }
    return;
  }
  await resetPool();
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 10 }));
  await resetTestSchemaForTest();
  await runMigrations();
});

after(async () => {
  if (pgAvailable) {
    try { await resetTestSchemaForTest(); } catch { /* ignore */ }
    await closePool();
  }
});

beforeEach(async () => {
  if (!pgAvailable) return;
  __resetGrokVisionRateState();
  await query(
    "TRUNCATE TABLE request_finalize_journal, agent_containers, admin_audit, usage_records, credit_ledger, refresh_tokens, email_verifications, users RESTART IDENTITY CASCADE",
  );
});

function skipIfNoPg(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) {
    t.skip("pg not running");
    return true;
  }
  return false;
}

async function createUser(credits: bigint): Promise<bigint> {
  const r = await query<{ id: string }>(
    "INSERT INTO users(email, password_hash, credits, role) VALUES ($1, 'argon2$stub', $2, 'user') RETURNING id::text AS id",
    [`vision-${randomBytes(4).toString("hex")}@example.com`, credits.toString()],
  );
  return BigInt(r.rows[0]!.id);
}

async function createContainer(uid: bigint): Promise<number> {
  const r = await query<{ id: string }>(
    `INSERT INTO agent_containers(user_id,secret_hash,state,runtime_channel)
     VALUES ($1,$2,'active','v5') RETURNING id::text AS id`,
    [uid.toString(), randomBytes(32)],
  );
  return Number(r.rows[0]!.id);
}

async function setup(opts: {
  credits?: bigint;
  snapshot?: ModelCatalogSnapshot;
  authz?: UserModelAuthz;
  upstream?: { statusCode: number; payload: unknown };
} = {}) {
  const uid = await createUser(opts.credits ?? 1000n);
  const cid = await createContainer(uid);
  const redis = new InMemoryPreCheckRedis();
  let upstreamCalls = 0;
  const handler = makeGrokVisionHandler({
    identityRepo: visionIdentityRepo(cid, Number(uid)),
    getPool,
    preCheckRedis: redis,
    // Empty on purpose: the charged price must come from the journal, frozen at admit.
    pricing: new PricingCache(),
    catalog: { assertFresh: async () => opts.snapshot ?? grokVisionSnapshot() },
    loadUserModelAuthz: async () => opts.authz ?? PUBLIC_VISION_AUTHZ,
    pickAccountId: async () => 24n,
    freshToken: async () => Buffer.from(GROK_TOKEN_BYTES),
    recordStatus: async () => {},
    requestFn: async () => {
      upstreamCalls += 1;
      const up = opts.upstream ?? { statusCode: 200, payload: grokVisionUpstreamPayload() };
      return { statusCode: up.statusCode, body: { text: async () => JSON.stringify(up.payload) } };
    },
  });
  const run = async () => {
    const { res, json } = visionRes();
    await handler(
      visionReq("POST", { image: { mediaType: "image/png", data: PNG_BASE64 }, prompt: "图片上写的数字是什么？" }, visionToken(cid)),
      res,
      VISION_CTX,
    );
    return { status: res.statusCode, json: json() };
  };
  return { uid, cid, redis, run, upstreamCalls: () => upstreamCalls };
}

async function books(uid: bigint) {
  const usage = await query<Record<string, string | null>>(
    `SELECT id::text, request_id, model, status, mode, session_id, input_tokens::text, output_tokens::text,
            cache_read_tokens::text, cache_write_tokens::text, cost_credits::text, ledger_id::text
       FROM usage_records WHERE user_id=$1 ORDER BY id`,
    [uid.toString()],
  );
  const journal = await query<Record<string, string | null>>(
    `SELECT request_id, state, container_id::text, precheck_credits::text, final_credits::text,
            usage_id::text, ledger_id::text, ctx->>'source' AS source, ctx->>'model' AS model
       FROM request_finalize_journal WHERE user_id=$1 ORDER BY created_at`,
    [uid.toString()],
  );
  const ledger = await query<Record<string, string | null>>(
    "SELECT id::text, delta::text, balance_after::text, reason FROM credit_ledger WHERE user_id=$1 ORDER BY id",
    [uid.toString()],
  );
  const user = await query<{ credits: string }>("SELECT credits::text FROM users WHERE id=$1", [uid.toString()]);
  return { usage: usage.rows, journal: journal.rows, ledger: ledger.rows, credits: BigInt(user.rows[0]!.credits) };
}

describe("grok vision billing (real Postgres)", () => {
  test("a successful call is charged once at the grok-build price, in all three books", async (t) => {
    if (skipIfNoPg(t)) return;
    const s = await setup({
      upstream: {
        statusCode: 200,
        payload: grokVisionUpstreamPayload({
          usage: {
            input_tokens: 12_000,
            input_tokens_details: { cached_tokens: 2_000 },
            output_tokens: 800,
            output_tokens_details: { reasoning_tokens: 300 },
          },
        }),
      },
    });
    const out = await s.run();
    assert.equal(out.status, 200);
    assert.deepEqual(out.json, { text: "785941", model: "grok-build" });

    // (10000 x 250 + 2000 x 25 + 800 x 1500) x 1.000 / 1e6 = 3.75 -> 4
    const b = await books(s.uid);
    assert.equal(b.usage.length, 1);
    const usage = b.usage[0]!;
    assert.equal(usage.model, "grok-build");
    assert.equal(usage.status, "success");
    assert.equal(usage.mode, "chat");
    assert.equal(usage.input_tokens, "10000");
    assert.equal(usage.cache_read_tokens, "2000");
    assert.equal(usage.cache_write_tokens, "0");
    assert.equal(usage.output_tokens, "800");
    assert.equal(usage.cost_credits, "4");

    assert.equal(b.journal.length, 1);
    const journal = b.journal[0]!;
    assert.equal(journal.state, "committed");
    assert.equal(journal.source, GROK_VISION_JOURNAL_SOURCE);
    assert.equal(journal.model, "grok-build");
    assert.equal(journal.container_id, String(s.cid));
    assert.equal(journal.request_id, usage.request_id);
    assert.equal(journal.precheck_credits, "12");
    assert.equal(journal.final_credits, "4");
    assert.equal(journal.usage_id, usage.id);
    assert.equal(journal.ledger_id, usage.ledger_id);

    assert.equal(b.ledger.length, 1);
    assert.equal(b.ledger[0]!.id, usage.ledger_id);
    assert.equal(b.ledger[0]!.delta, "-4");
    assert.equal(b.ledger[0]!.balance_after, "996");
    assert.equal(b.credits, 996n);
    assert.equal(s.redis.totalLocked(s.uid), 0n, "reservation released after settle");
  });

  test("the 2026-10-06 probe usage (1367 in / 54 out) costs 1 credit", async (t) => {
    if (skipIfNoPg(t)) return;
    const s = await setup();
    assert.equal((await s.run()).status, 200);
    const b = await books(s.uid);
    // (1367 x 250 + 54 x 1500) / 1e6 = 0.42275 -> 1
    assert.equal(b.usage[0]!.input_tokens, "1367");
    assert.equal(b.usage[0]!.output_tokens, "54");
    assert.equal(b.usage[0]!.cost_credits, "1");
    assert.equal(b.credits, 999n);
  });

  test("the multiplier frozen at admit is applied", async (t) => {
    if (skipIfNoPg(t)) return;
    const s = await setup({
      snapshot: grokVisionSnapshot({ price: { multiplier: "2.500" } }),
      upstream: { statusCode: 200, payload: grokVisionUpstreamPayload({ usage: { input_tokens: 4_000, output_tokens: 1_000 } }) },
    });
    assert.equal((await s.run()).status, 200);
    const b = await books(s.uid);
    // (4000 x 250 + 1000 x 1500) x 2.5 / 1e6 = 6.25 -> 7
    assert.equal(b.usage[0]!.cost_credits, "7");
    assert.equal(b.journal[0]!.final_credits, "7");
    assert.equal(b.ledger[0]!.delta, "-7");
  });

  test("two calls are two separate charges", async (t) => {
    if (skipIfNoPg(t)) return;
    const s = await setup();
    assert.equal((await s.run()).status, 200);
    assert.equal((await s.run()).status, 200);
    const b = await books(s.uid);
    assert.equal(b.usage.length, 2);
    assert.notEqual(b.usage[0]!.request_id, b.usage[1]!.request_id);
    assert.equal(b.journal.filter((j) => j.state === "committed").length, 2);
    assert.equal(b.ledger.length, 2);
    assert.equal(b.credits, 998n);
  });

  for (const [name, upstream] of [
    ["upstream 500", { statusCode: 500, payload: {} }],
    ["no usage in the response", { statusCode: 200, payload: grokVisionUpstreamPayload({ usage: null }) }],
    ["no answer text", { statusCode: 200, payload: grokVisionUpstreamPayload({ text: "" }) }],
  ] as const) {
    test(`${name}: nothing is charged and the journal row is aborted`, async (t) => {
      if (skipIfNoPg(t)) return;
      const s = await setup({ upstream });
      const out = await s.run();
      assert.equal(out.status, 502);
      const b = await books(s.uid);
      assert.equal(b.usage.length, 0);
      assert.equal(b.ledger.length, 0);
      assert.equal(b.credits, 1000n);
      assert.equal(b.journal.length, 1);
      assert.equal(b.journal[0]!.state, "aborted");
      assert.equal(b.journal[0]!.final_credits, "0");
      assert.equal(b.journal[0]!.usage_id, null);
      assert.equal(b.journal[0]!.ledger_id, null);
      assert.equal(s.redis.totalLocked(s.uid), 0n, "reservation released");
    });
  }

  test("no credits: rejected before any journal row or upstream call", async (t) => {
    if (skipIfNoPg(t)) return;
    const s = await setup({ credits: 0n });
    const out = await s.run();
    assert.equal(out.status, 402);
    const b = await books(s.uid);
    assert.equal(b.journal.length, 0);
    assert.equal(b.usage.length, 0);
    assert.equal(s.upstreamCalls(), 0);
  });

  test("a user who may not use grok-build: rejected before any journal row or upstream call", async (t) => {
    if (skipIfNoPg(t)) return;
    const s = await setup({ authz: { ...PUBLIC_VISION_AUTHZ, deniedModelIds: new Set(["grok-build"]) } });
    const out = await s.run();
    assert.equal(out.status, 403);
    const b = await books(s.uid);
    assert.equal(b.journal.length, 0);
    assert.equal(b.usage.length, 0);
    assert.equal(b.credits, 1000n);
    assert.equal(s.upstreamCalls(), 0);
  });

  test("a balance below the reservation still works and is charged the real cost only", async (t) => {
    if (skipIfNoPg(t)) return;
    const s = await setup({ credits: 5n });
    assert.equal((await s.run()).status, 200);
    const b = await books(s.uid);
    assert.equal(b.journal[0]!.precheck_credits, "5");
    assert.equal(b.usage[0]!.cost_credits, "1");
    assert.equal(b.credits, 4n);
  });
});
