/**
 * PR2 v1.0.66 — codexFinalizer 单元测试(M1b v5 形态适配)。
 *
 * 跑法: npx tsx --test src/__tests__/codexFinalizer.test.ts
 *
 * v5 适配(0096 双钱包 + M1b 计费红线):
 *   - fake pool 兜住 spendTwoBucket 的 SQL 序列(users FOR UPDATE /
 *     user_subscriptions FOR UPDATE / UPDATE users / credit_ledger 分桶),
 *     默认无 active 订阅 → 纯钱包扣;
 *   - ctx 用 engineSessionId(oceng-<48hex>)替换旧 containerId 占位,accountId 移除;
 *   - 新增:零输出免单 / account_id NULL / session_id 口径 / 形状 fail-closed。
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
import {
  ENGINE_SESSION_ID_RE,
  JournalSettlementClaimLostError,
  deriveEngineSessionId,
  makeCodexFinalizer,
} from "../billing/codexFinalizer.js";
import type { CodexFinalizeContext } from "../billing/codexFinalizer.js";
import type { ModelPricing } from "../billing/pricing.js";
import type { TokenUsage } from "../billing/calculator.js";
import type { ReservationHandle } from "../billing/preCheck.js";
import { InMemoryPreCheckRedis } from "../billing/preCheck.js";

// ---------- fixtures --------------------------------------------------------

const PRICING: ModelPricing = {
  model_id: "gpt-5.6-sol",
  display_name: "GPT 5.5",
  input_per_mtok: 1000n,
  output_per_mtok: 5000n,
  cache_read_per_mtok: 100n,
  cache_write_per_mtok: 500n,
  multiplier: "1.000",
  enabled: true,
  sort_order: 0,
  visibility: "public",
  extra_system_prompt: null,
  default_effort: null,
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
  injectCommitError(err: Error): void;
}

function makeFakePool(opts: {
  userBalance?: bigint;
  finalizingClaimed?: boolean;
} = {}): FakePoolControl {
  const queries: QueryRecord[] = [];
  let pendingUsageInsertErr: Error | null = null;
  let pendingCommitErr: Error | null = null;
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
      if (trimmed === "COMMIT" && pendingCommitErr !== null) {
        const e = pendingCommitErr;
        pendingCommitErr = null;
        throw e;
      }
      if (trimmed === "BEGIN" || trimmed === "COMMIT" || trimmed === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      // 0112 企业版:settle 收口 tx 内的 org 归属解析(resolveOrgBillingContext)。
      // 本套件不测 org 计费 → 无成员归属,返回空 → orgCtx=null(纯个人扣费,行为不变)。
      if (trimmed.startsWith("SELECT m.org_id")) {
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
      // 0096 spendTwoBucket:期内桶 FOR UPDATE。默认无 active 订阅(rows 空)
      // → period=0,全额走持久钱包 —— 单桶断言与旧测试语义保持一致。
      if (trimmed.startsWith("SELECT id::text AS id, period_credits::text")) {
        return { rows: [], rowCount: 0 };
      }
      if (trimmed.startsWith("UPDATE user_subscriptions SET period_credits")) {
        return { rows: [], rowCount: 1 };
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
      // Settle-time WorkProject snapshot. Suites without chat/project rows stay unattributed.
      if (/FROM client_sessions cs/.test(trimmed) && /board_project_id/.test(trimmed)) {
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
        if (/SET state='finalizing'/.test(trimmed)) {
          return { rows: [], rowCount: opts.finalizingClaimed === false ? 0 : 1 };
        }
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
    injectCommitError(err: Error) {
      pendingCommitErr = err;
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
  finalizingClaimed?: boolean;
} = {}): Promise<FixtureBundle> {
  const poolCtrl = makeFakePool({
    userBalance: opts.userBalance,
    finalizingClaimed: opts.finalizingClaimed,
  });
  const redis = new InMemoryPreCheckRedis();
  const userId = 7n;
  const requestId = opts.requestId ?? "req-test-0001";
  const reservation = await preReserveBalance(redis, userId, requestId);
  const ctx: CodexFinalizeContext = {
    pgPool: poolCtrl.pool,
    preCheckRedis: redis,
    userId,
    requestId,
    // v5 口径:session_id 必须是 deriveEngineSessionId 产物(oceng-<48hex>)。
    engineSessionId: deriveEngineSessionId(`test-session:${requestId}`),
    model: "gpt-5.6-sol",
    derivedPricing: PRICING,
    reservation,
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
    const status = ins.params?.[14]; // 第 15 个参数(status,见 SQL;0104 归因列插入后位移)
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
    assert.equal(ins.params?.[14], "success");
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
    await fz.commit(usage(0, 0, 0, 0), "error");

    const ins = poolCtrl.queries.find((q) =>
      q.sql.trim().startsWith("INSERT INTO usage_records"),
    );
    assert.ok(ins);
    assert.equal(ins.params?.[14], "error");
    // snapshotJson 只含稳定终态码，不持久化引擎原始错误文本。
    const snapshotJson = ins.params?.[8] as string;
    const snap = JSON.parse(snapshotJson);
    assert.equal(snap.codex_status, "error");
    assert.equal(snap.codex_terminal_code, "CODEX_ERROR");
    assert.equal(snap.codex_error_reason, undefined);
  });

  test("interrupted partial usage persists USER_CANCELLED without raw reason", async () => {
    const { poolCtrl, ctx } = await makeFixture({ userBalance: 1_000_000n });
    const fz = makeCodexFinalizer(ctx);
    await fz.commit(usage(1000, 200), "error", {
      terminalCode: "USER_CANCELLED",
    });
    const ins = poolCtrl.queries.find((q) =>
      q.sql.trim().startsWith("INSERT INTO usage_records"),
    );
    assert.ok(ins);
    const snap = JSON.parse(ins.params?.[8] as string);
    assert.equal(snap.codex_status, "error");
    assert.equal(snap.codex_terminal_code, "USER_CANCELLED");
    assert.equal(JSON.stringify(snap).includes("must-not-be-persisted"), false);
  });
});

describe("makeCodexFinalizer / settle failure path", () => {
  test("reconciler 已先 abort → late billing frame 不产生 usage/ledger 或扣费", async () => {
    const { poolCtrl, redis, ctx } = await makeFixture({ finalizingClaimed: false });
    const fz = makeCodexFinalizer(ctx);

    await assert.rejects(
      () => fz.commit(usage(100, 100), "success"),
      JournalSettlementClaimLostError,
    );
    assert.equal(
      poolCtrl.queries.some((q) =>
        q.sql.includes("INSERT INTO usage_records") ||
        q.sql.includes("INSERT INTO credit_ledger") ||
        q.sql.includes("UPDATE users SET credits"),
      ),
      false,
      "lost finalizing CAS must stop before any financial settlement",
    );
    assert.equal(await reservationStillHeld(redis, ctx.reservation), false);
  });

  test("settle throw → journal stays recoverable + rethrow + reservation released", async () => {
    const { poolCtrl, redis, ctx } = await makeFixture();
    poolCtrl.injectInsertUsageError(new Error("simulated DB outage"));
    const fz = makeCodexFinalizer(ctx);

    await assert.rejects(
      () => fz.commit(usage(100, 100), "success"),
      /simulated DB outage/,
    );

    // A known pre-COMMIT failure is rolled back only by the claim owner. The
    // unmarked aborted row is explicitly reopenable by immutable tape replay.
    assert.ok(
      poolCtrl.queries.some((q) =>
        /state='aborted'/.test(q.sql) &&
        q.sql.includes("settlementClaimId") &&
        typeof q.params?.[3] === "string"
      ),
      "known transaction failure must owner-rollback for durable replay",
    );
    // reservation 仍然被释放(finally 块)
    assert.equal(await reservationStillHeld(redis, ctx.reservation), false);
  });

  test("COMMIT outcome unknown → 保留 owner finalizing，绝不回滚成 aborted", async () => {
    const { poolCtrl, redis, ctx } = await makeFixture();
    poolCtrl.injectCommitError(new Error("connection lost after COMMIT"));
    const fz = makeCodexFinalizer(ctx);

    await assert.rejects(
      () => fz.commit(usage(100, 100), "success"),
      /COMMIT outcome is unknown/,
    );
    assert.equal(
      poolCtrl.queries.some((q) => /state='aborted'/.test(q.sql)),
      false,
      "indeterminate commit may already have debited and must retain the claim",
    );
    assert.equal(await reservationStillHeld(redis, ctx.reservation), false);
  });

  test("settle throw 后 fail call no-op, journal remains recoverable", async () => {
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
    assert.equal(ins.params?.[4], "11");
    assert.equal(ins.params?.[5], "22");
    assert.equal(ins.params?.[6], "33");
    assert.equal(ins.params?.[7], "44");
  });

  test("codex authority stamp 写入 usage_records 四个证据列", async () => {
    const { poolCtrl, ctx } = await makeFixture();
    const fz = makeCodexFinalizer({
      ...ctx,
      authority: {
        executionRevision: "a".repeat(64),
        projectionRevision: null,
        securityEpoch: 9007199254740993n,
        kind: "bridge_signed",
      },
    });
    await fz.commit(usage(11, 22), "success");
    const ins = poolCtrl.queries.find((q) => q.sql.trim().startsWith("INSERT INTO usage_records"));
    assert.ok(ins);
    assert.deepEqual(ins.params?.slice(16, 20), [
      "a".repeat(64),
      null,
      "9007199254740993",
      "bridge_signed",
    ]);
  });
});

describe("makeCodexFinalizer / v5 计费红线(M1b)", () => {
  test("deriveEngineSessionId:形状稳定 + 同 key 幂等 + 不同 key 不同值", () => {
    const a = deriveEngineSessionId("session-key-A");
    const b = deriveEngineSessionId("session-key-A");
    const c = deriveEngineSessionId("session-key-B");
    assert.match(a, ENGINE_SESSION_ID_RE);
    assert.equal(a.length, 54, "oceng- + 48 hex = 54 chars");
    assert.equal(a, b, "same key must derive same id");
    assert.notEqual(a, c);
    assert.throws(() => deriveEngineSessionId(""), TypeError);
  });

  test("engineSessionId 形状不合法 → 构造期 TypeError fail-closed", async () => {
    const { ctx } = await makeFixture();
    for (const bad of ["ctr-fake-1", "oceng-XYZ", "oceng-" + "a".repeat(47), ""]) {
      assert.throws(
        () => makeCodexFinalizer({ ...ctx, engineSessionId: bad }),
        TypeError,
        `must reject ${JSON.stringify(bad)}`,
      );
    }
  });

  test("usage_records.account_id 恒写 SQL NULL(不用假账号)", async () => {
    const { poolCtrl, ctx } = await makeFixture();
    const fz = makeCodexFinalizer(ctx);
    await fz.commit(usage(100, 100), "success");
    const ins = poolCtrl.queries.find((q) =>
      q.sql.trim().startsWith("INSERT INTO usage_records"),
    );
    assert.ok(ins);
    // $2 = account_id(参数下标 1)
    assert.equal(ins.params?.[2], null, "codex 记账 account_id 必须是 NULL");
  });

  test("usage_records.session_id = engineSessionId(稳定会话口径)", async () => {
    const { poolCtrl, ctx } = await makeFixture();
    const fz = makeCodexFinalizer(ctx);
    await fz.commit(usage(100, 100), "success");
    const ins = poolCtrl.queries.find((q) =>
      q.sql.trim().startsWith("INSERT INTO usage_records"),
    );
    assert.ok(ins);
    // $10 = session_id(参数下标 9)
    assert.equal(ins.params?.[10], ctx.engineSessionId);
    assert.match(String(ins.params?.[10]), ENGINE_SESSION_ID_RE);
  });

  test("零输出免单:success + output=0 但本有成本 → cost=0 落库,不 debit,snapshot 记 waived", async () => {
    const { poolCtrl, ctx } = await makeFixture();
    const fz = makeCodexFinalizer(ctx);
    // 纯 input 成本(1M input @ 1000/mtok > 0),零输出 → 免单。
    const r = await fz.commit(usage(1_000_000, 0), "success");

    assert.equal(r.debitedCredits, null, "waived turn must not debit");
    assert.equal(r.costCredits, 0n, "effective cost must be 0 after waive");

    const ins = poolCtrl.queries.find((q) =>
      q.sql.trim().startsWith("INSERT INTO usage_records"),
    );
    assert.ok(ins);
    // $9 = cost_credits(参数下标 8)落 0;$12 = status 仍 success(audit 痕)。
    assert.equal(ins.params?.[9], "0");
    assert.equal(ins.params?.[14], "success");
    const snap = JSON.parse(ins.params?.[8] as string);
    assert.equal(snap.waived, "no_output");
    assert.ok(BigInt(snap.wouldHaveCharged) > 0n, "audit must keep would-have-charged amount");
    // 免单 → 不写 credit_ledger
    assert.ok(
      !poolCtrl.queries.some((q) => q.sql.trim().startsWith("INSERT INTO credit_ledger")),
      "waived turn must not write ledger",
    );
  });

  test("零输出但 status=error → 走 error 语义(不免单标记,也不扣费)", async () => {
    const { poolCtrl, ctx } = await makeFixture();
    const fz = makeCodexFinalizer(ctx);
    await fz.commit(usage(1_000_000, 0), "error");
    const ins = poolCtrl.queries.find((q) =>
      q.sql.trim().startsWith("INSERT INTO usage_records"),
    );
    assert.ok(ins);
    // cost>0 → settleStatus=success(有正 token 就 charge 的既有语义),但零输出免单
    // 覆盖其上 → cost=0。error 状态只落 snapshot。
    const snap = JSON.parse(ins.params?.[8] as string);
    assert.equal(snap.codex_status, "error");
    assert.ok(
      !poolCtrl.queries.some((q) => q.sql.trim().startsWith("INSERT INTO credit_ledger")),
      "zero-output error turn must not charge",
    );
  });

  test("有输出的正常 turn 不受免单影响(wallet-only debit,balanceAfter=总可用)", async () => {
    const { poolCtrl, ctx } = await makeFixture({ userBalance: 1_000_000n });
    const fz = makeCodexFinalizer(ctx);
    const r = await fz.commit(usage(1000, 2000), "success");
    assert.ok((r.debitedCredits ?? 0n) > 0n);
    // fake 无 active 订阅 → period=0,balanceAfter = walletAfter(双钱包总可用)。
    assert.equal(r.balanceAfter, 1_000_000n - (r.debitedCredits ?? 0n));
    // 单桶扣 → 恰一条 credit_ledger,bucket='wallet'($5,下标 4)。
    const ledgers = poolCtrl.queries.filter((q) =>
      q.sql.trim().startsWith("INSERT INTO credit_ledger"),
    );
    assert.equal(ledgers.length, 1);
    assert.equal(ledgers[0].params?.[4], "wallet");
  });
});
