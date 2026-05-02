/**
 * PR2 v1.0.66 — codexFinalizer 单元测试。
 *
 * 跑法: npx tsx --test src/__tests__/codexFinalizer.test.ts
 *
 * 覆盖(只测 codexFinalizer 自身的逻辑,不复测 settleUsageAndLedger / preCheck Redis lua):
 *   - tagged union idempotency:
 *       commit → commit(返同 promise,settle 只跑一次)
 *       fail   → fail  (返同 promise,abort 只跑一次)
 *       commit → fail  (fail no-op,不再 abort journal)
 *       fail   → commit(返 SKIPPED_RESULT,debitedCredits=null)
 *   - settleStatus 选择:cost>0→success / cost=0+success→success / cost=0+error→error
 *   - usage 透传:reasoning 已由 caller fold,这里只验 4 维 token 落库参数
 *   - releasePreCheck 在 commit / fail / commit 抛错路径都会执行
 *   - settle throw → catch 里 abortInflightJournal 兜底 + rethrow 给 caller log
 *
 * 测试夹具:fake Pool(模式匹配 SQL 路由)+ InMemoryPreCheckRedis。
 * 不真起 PG / Redis,纯 in-memory。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Pool, PoolClient } from "pg";
import { makeCodexFinalizer } from "../billing/codexFinalizer.js";
import type { CodexFinalizeContext } from "../billing/codexFinalizer.js";
import type { ModelPricing } from "../billing/pricing.js";
import type { TokenUsage } from "../billing/calculator.js";
import type { ReservationHandle } from "../billing/preCheck.js";
import { InMemoryPreCheckRedis } from "../billing/preCheck.js";

// ---------- fixtures --------------------------------------------------------

const PRICING: ModelPricing = {
  model_id: "gpt-5.5",
  display_name: "GPT 5.5",
  input_per_mtok: 1000n,
  output_per_mtok: 5000n,
  cache_read_per_mtok: 100n,
  cache_write_per_mtok: 500n,
  multiplier: "1.000",
  enabled: true,
  sort_order: 0,
  visibility: "public",
  updated_at: new Date(0),
};

function usage(
  input: number,
  output: number,
  cacheRead = 0,
  cacheWrite = 0,
): TokenUsage {
  return {
    input_tokens: BigInt(input),
    output_tokens: BigInt(output),
    cache_read_tokens: BigInt(cacheRead),
    cache_write_tokens: BigInt(cacheWrite),
  };
}

interface QueryRecord {
  sql: string;
  params: unknown[] | undefined;
}

interface FakePoolControl {
  pool: Pool;
  queries: QueryRecord[];
  /** 让下一次 INSERT INTO usage_records 抛 errToThrow,触发 codexFinalizer 的 catch + abort 兜底。 */
  injectInsertUsageError(err: Error): void;
}

function makeFakePool(opts: { userBalance?: bigint } = {}): FakePoolControl {
  const queries: QueryRecord[] = [];
  let pendingUsageInsertErr: Error | null = null;
  const balance = opts.userBalance ?? 1_000_000n;

  function record(sql: string, params: unknown[] | undefined): void {
    queries.push({ sql, params });
  }

  // 用 unknown[] 避免 pg 类型对 any 行的反向推断,我们 fakeClient 只保 .query / .release 这两面。
  // pg 的 query 重载太多,用 any cast 让 fake 通过 typecheck。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fakeClient: any = {
    async query(sqlOrCfg: unknown, params?: unknown[]): Promise<unknown> {
      const sql =
        typeof sqlOrCfg === "string"
          ? sqlOrCfg
          : (sqlOrCfg as { text: string }).text;
      record(sql, params);
      const trimmed = sql.trim();
      if (trimmed === "BEGIN" || trimmed === "COMMIT" || trimmed === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (trimmed.startsWith("INSERT INTO usage_records")) {
        if (pendingUsageInsertErr !== null) {
          const e = pendingUsageInsertErr;
          pendingUsageInsertErr = null;
          throw e;
        }
        return { rows: [{ id: "100" }], rowCount: 1 };
      }
      if (
        trimmed.startsWith("SELECT credits") ||
        trimmed.startsWith("SELECT credits::text")
      ) {
        return { rows: [{ credits: balance.toString() }], rowCount: 1 };
      }
      if (trimmed.startsWith("UPDATE users SET credits")) {
        return { rows: [], rowCount: 1 };
      }
      if (trimmed.startsWith("INSERT INTO credit_ledger")) {
        return { rows: [{ id: "200" }], rowCount: 1 };
      }
      if (trimmed.startsWith("UPDATE usage_records SET ledger_id")) {
        return { rows: [], rowCount: 1 };
      }
      if (trimmed.startsWith("SELECT id::text AS id, ledger_id")) {
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`fakeClient: unhandled SQL: ${trimmed.slice(0, 80)}`);
    },
    release(): void {
      /* noop */
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fakePool: any = {
    async connect(): Promise<PoolClient> {
      return fakeClient as PoolClient;
    },
    async query(sqlOrCfg: unknown, params?: unknown[]): Promise<unknown> {
      const sql =
        typeof sqlOrCfg === "string"
          ? sqlOrCfg
          : (sqlOrCfg as { text: string }).text;
      record(sql, params);
      const trimmed = sql.trim();
      // finalizeInflightJournal / abortInflightJournal 都走 pool.query,UPDATE noop 即可。
      if (trimmed.startsWith("UPDATE request_finalize_journal")) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`fakePool: unhandled SQL: ${trimmed.slice(0, 80)}`);
    },
  };

  return {
    pool: fakePool as Pool,
    queries,
    injectInsertUsageError(err: Error) {
      pendingUsageInsertErr = err;
    },
  };
}

async function preReserveBalance(
  redis: InMemoryPreCheckRedis,
  userId: bigint,
  requestId: string,
): Promise<ReservationHandle> {
  // 用 atomicReserve 写一条假 lock,这样 releasePreCheck 删除时返回 true 可观测。
  await redis.atomicReserve({
    userId: userId.toString(),
    requestId,
    balance: 100_000n,
    maxCost: 10n,
    ttlSeconds: 60,
  });
  return { userId: userId.toString(), requestId };
}

interface FixtureBundle {
  poolCtrl: FakePoolControl;
  redis: InMemoryPreCheckRedis;
  ctx: CodexFinalizeContext;
}

async function makeFixture(opts: {
  requestId?: string;
  userBalance?: bigint;
} = {}): Promise<FixtureBundle> {
  const poolCtrl = makeFakePool({ userBalance: opts.userBalance });
  const redis = new InMemoryPreCheckRedis();
  const userId = 7n;
  const requestId = opts.requestId ?? "req-test-0001";
  const reservation = await preReserveBalance(redis, userId, requestId);
  const ctx: CodexFinalizeContext = {
    pgPool: poolCtrl.pool,
    preCheckRedis: redis,
    userId,
    requestId,
    containerId: "ctr-fake-1",
    model: "gpt-5.5",
    derivedPricing: PRICING,
    reservation,
    accountId: 42n,
  };
  return { poolCtrl, redis, ctx };
}

// 检查 reservation 是否还在 Redis 里(用 atomicReserve 时返回的 locked > 0 / 不存在则 0n)。
async function reservationStillHeld(
  redis: InMemoryPreCheckRedis,
  reservation: ReservationHandle,
): Promise<boolean> {
  // atomicReserve 又写一笔同 reqId(覆写语义):
  // 如果原本还在,我们再写就把它换掉(覆写返回 locked 包含旧)。
  // 简化:直接调 releaseReservation,true=仍在 / false=已释放;然后再写回去恢复语义。
  const removed = await redis.releaseReservation({
    userId: reservation.userId,
    requestId: reservation.requestId,
  });
  if (removed) {
    // 恢复:写回去防影响后续判断(虽然测试用例多半不再查)
    await redis.atomicReserve({
      userId: reservation.userId,
      requestId: reservation.requestId,
      balance: 100_000n,
      maxCost: 10n,
      ttlSeconds: 60,
    });
  }
  return removed;
}

// ---------- tests -----------------------------------------------------------

describe("makeCodexFinalizer / commit happy path", () => {
  test("commit settles + finalizes + releases preCheck", async () => {
    const { poolCtrl, redis, ctx } = await makeFixture();
    const fz = makeCodexFinalizer(ctx);
    const r = await fz.commit(usage(1000, 2000), "success");

    // settle 走完 → debitedCredits 取 ledger debit(cost>0)
    assert.equal(typeof r.debitedCredits, "bigint");
    assert.ok((r.debitedCredits ?? 0n) > 0n, "debit should be positive");
    assert.ok(r.costCredits > 0n);
    assert.equal(r.clamped, false);

    // pre-check 已释放 → 再 release 拿 false
    assert.equal(await reservationStillHeld(redis, ctx.reservation), false);

    // SQL 序列检查:有 BEGIN + INSERT usage_records + SELECT credits FOR UPDATE
    //   + INSERT credit_ledger + COMMIT + UPDATE request_finalize_journal SET state='committed'
    const sqls = poolCtrl.queries.map((q) => q.sql.trim().split("\n")[0]);
    assert.ok(sqls.some((s) => s === "BEGIN"));
    assert.ok(sqls.some((s) => s.startsWith("INSERT INTO usage_records")));
    assert.ok(sqls.some((s) => s.startsWith("INSERT INTO credit_ledger")));
    assert.ok(
      sqls.some((s) =>
        /UPDATE request_finalize_journal/.test(s),
      ),
      "must call finalizeInflightJournal",
    );
    // 不应出现 abort
    assert.ok(
      !poolCtrl.queries.some((q) =>
        /state='aborted'/.test(q.sql),
      ),
      "happy path must not abort journal",
    );
  });
});

describe("makeCodexFinalizer / tagged union idempotency", () => {
  test("commit twice returns same promise (no double settle)", async () => {
    const { poolCtrl, ctx } = await makeFixture();
    const fz = makeCodexFinalizer(ctx);

    const u = usage(500, 1000);
    const p1 = fz.commit(u, "success");
    const p2 = fz.commit(u, "success");
    const [r1, r2] = await Promise.all([p1, p2]);

    // 同一对象引用 → 同 promise
    assert.equal(r1, r2);

    // INSERT usage_records 只发一次
    const insertCount = poolCtrl.queries.filter((q) =>
      q.sql.trim().startsWith("INSERT INTO usage_records"),
    ).length;
    assert.equal(insertCount, 1, "settle must run exactly once");
  });

  test("fail twice triggers abortInflightJournal once", async () => {
    const { poolCtrl, ctx } = await makeFixture();
    const fz = makeCodexFinalizer(ctx);

    await fz.fail("first reason");
    await fz.fail("second reason");

    const aborts = poolCtrl.queries.filter((q) =>
      /state='aborted'/.test(q.sql),
    );
    assert.equal(aborts.length, 1, "abort journal must run exactly once");
  });

  test("commit-after-fail returns SKIPPED_RESULT (debitedCredits=null)", async () => {
    const { poolCtrl, ctx } = await makeFixture();
    const fz = makeCodexFinalizer(ctx);

    await fz.fail("user disconnected");
    const r = await fz.commit(usage(100, 200), "success");

    assert.equal(r.debitedCredits, null, "must not double-charge");
    assert.equal(r.balanceAfter, null);
    assert.equal(r.costCredits, 0n);
    assert.equal(r.clamped, false);

    // 不应再发 usage_records insert
    const inserts = poolCtrl.queries.filter((q) =>
      q.sql.trim().startsWith("INSERT INTO usage_records"),
    );
    assert.equal(inserts.length, 0, "commit-after-fail must not settle");
  });

  test("fail-after-commit no-ops (no abort, no double-release)", async () => {
    const { poolCtrl, ctx } = await makeFixture();
    const fz = makeCodexFinalizer(ctx);

    const r = await fz.commit(usage(100, 200), "success");
    assert.ok((r.debitedCredits ?? 0n) > 0n);
    await fz.fail("late cleanup");

    // 不应有 abort journal
    assert.ok(
      !poolCtrl.queries.some((q) => /state='aborted'/.test(q.sql)),
      "fail-after-commit must not abort",
    );
  });
});

describe("makeCodexFinalizer / settleStatus selection", () => {
  test("cost>0 → status=success", async () => {
    const { poolCtrl, ctx } = await makeFixture();
    const fz = makeCodexFinalizer(ctx);
    await fz.commit(usage(100, 100), "success");

    const ins = poolCtrl.queries.find((q) =>
      q.sql.trim().startsWith("INSERT INTO usage_records"),
    );
    assert.ok(ins, "INSERT INTO usage_records expected");
    const status = ins.params?.[11]; // 第 12 个参数(status,见 SQL)
    assert.equal(status, "success");
  });

  test("cost=0 + status=success → status=success (audit)", async () => {
    const { poolCtrl, ctx } = await makeFixture();
    const fz = makeCodexFinalizer(ctx);
    // 全 0 token → cost = 0n
    await fz.commit(usage(0, 0, 0, 0), "success");

    const ins = poolCtrl.queries.find((q) =>
      q.sql.trim().startsWith("INSERT INTO usage_records"),
    );
    assert.ok(ins);
    assert.equal(ins.params?.[11], "success");
    // 0 cost 不走 ledger
    assert.ok(
      !poolCtrl.queries.some((q) =>
        q.sql.trim().startsWith("INSERT INTO credit_ledger"),
      ),
      "cost=0 must not insert ledger",
    );
  });

  test("cost=0 + status=error → status=error", async () => {
    const { poolCtrl, ctx } = await makeFixture();
    const fz = makeCodexFinalizer(ctx);
    await fz.commit(usage(0, 0, 0, 0), "error", "container_crashed");

    const ins = poolCtrl.queries.find((q) =>
      q.sql.trim().startsWith("INSERT INTO usage_records"),
    );
    assert.ok(ins);
    assert.equal(ins.params?.[11], "error");
    // snapshotJson 应含 codex_status + codex_error_reason
    const snapshotJson = ins.params?.[7] as string;
    const snap = JSON.parse(snapshotJson);
    assert.equal(snap.codex_status, "error");
    assert.equal(snap.codex_error_reason, "container_crashed");
  });
});

describe("makeCodexFinalizer / settle failure path", () => {
  test("settle throw → abortInflightJournal called + rethrow + reservation released", async () => {
    const { poolCtrl, redis, ctx } = await makeFixture();
    poolCtrl.injectInsertUsageError(new Error("simulated DB outage"));
    const fz = makeCodexFinalizer(ctx);

    await assert.rejects(
      () => fz.commit(usage(100, 100), "success"),
      /simulated DB outage/,
    );

    // 自动 abort journal 兜底
    assert.ok(
      poolCtrl.queries.some((q) => /state='aborted'/.test(q.sql)),
      "settle throw must auto-abort journal",
    );
    // reservation 仍然被释放(finally 块)
    assert.equal(await reservationStillHeld(redis, ctx.reservation), false);
  });

  test("settle throw 后 fail call no-op, 不再 abort", async () => {
    const { poolCtrl, ctx } = await makeFixture();
    poolCtrl.injectInsertUsageError(new Error("boom"));
    const fz = makeCodexFinalizer(ctx);

    await assert.rejects(() => fz.commit(usage(50, 50), "success"));
    // commit 已 _done = {kind:"commit"};后续 fail 共享 commit promise → swallow,不再 abort
    const abortsBefore = poolCtrl.queries.filter((q) =>
      /state='aborted'/.test(q.sql),
    ).length;
    await fz.fail("late");
    const abortsAfter = poolCtrl.queries.filter((q) =>
      /state='aborted'/.test(q.sql),
    ).length;
    assert.equal(abortsAfter, abortsBefore, "fail-after-commit-throw must not double-abort");
  });
});

describe("makeCodexFinalizer / usage field plumbing", () => {
  test("4-tuple usage tokens passed through to settle params", async () => {
    const { poolCtrl, ctx } = await makeFixture();
    const fz = makeCodexFinalizer(ctx);
    await fz.commit(usage(11, 22, 33, 44), "success");

    const ins = poolCtrl.queries.find((q) =>
      q.sql.trim().startsWith("INSERT INTO usage_records"),
    );
    assert.ok(ins);
    // 参数顺序见 settleUsageAndLedger:
    //   $1 user_id, $2 account_id, $3 model,
    //   $4 input, $5 output, $6 cache_read, $7 cache_write,
    //   $8 snapshot, $9 cost, $10 session, $11 request, $12 status
    assert.equal(ins.params?.[3], "11");
    assert.equal(ins.params?.[4], "22");
    assert.equal(ins.params?.[5], "33");
    assert.equal(ins.params?.[6], "44");
  });
});
