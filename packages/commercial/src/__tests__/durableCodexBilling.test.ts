import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Pool, PoolClient } from "pg";

import type { DurableCodexBilling } from "@openclaude/protocol";

import {
  settleDurableCodexBilling,
} from "../billing/durableCodexBilling.js";
import { permanentCodexWaiverReason } from "../billing/codexFinalizer.js";
import { InMemoryPreCheckRedis } from "../billing/preCheck.js";
import { PricingCache, type ModelPricing } from "../billing/pricing.js";
import { serializeBillingPricing } from "../billing/persistedBillingPricing.js";

const USER_ID = 7n;
const REQUEST_ID = "1".repeat(32);
const TURN_KEY = "2".repeat(64);
const ENGINE_SESSION_ID = `oceng-${"3".repeat(48)}`;
const PRICING: ModelPricing = {
  model_id: "gpt-5.6-sol",
  display_name: "GPT-5.6 Sol",
  input_per_mtok: 1_000n,
  output_per_mtok: 5_000n,
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

function frame(over: Partial<DurableCodexBilling> = {}): DurableCodexBilling {
  return {
    requestId: REQUEST_ID,
    turnKey: TURN_KEY,
    engineSessionId: ENGINE_SESSION_ID,
    status: "success",
    durationMs: 1_234,
    usage: {
      input_tokens: 10,
      output_tokens: 7,
      reasoning_output_tokens: 3,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 1,
    },
    ...over,
  };
}

function pricingCache(): PricingCache {
  return new PricingCache();
}

describe("settleDurableCodexBilling", () => {
  test("best-effort recovery telemetry cannot block a successful billing ACK", async () => {
    let telemetryStarted = false;
    const pool = {
      query: async (sql: string) => {
        if (sql.includes("SELECT state, user_id::text")) {
          return {
            rows: [{
              state: "committed",
              user_id: USER_ID.toString(),
              ctx: {},
              error_msg: null,
            }],
            rowCount: 1,
          };
        }
        if (sql.includes("UPDATE product_friction_events")) {
          telemetryStarted = true;
          return await new Promise<never>(() => {});
        }
        throw new Error(`unexpected SQL: ${sql}`);
      },
    } as unknown as Pool;
    const settled = settleDurableCodexBilling({
      pgPool: pool,
      preCheckRedis: new InMemoryPreCheckRedis(),
      pricing: pricingCache(),
    }, USER_ID, frame());
    const outcome = await Promise.race([
      settled,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);
    assert.equal(outcome, "already_committed");
    assert.equal(telemetryStarted, true);
  });

  test("best-effort recovery telemetry cannot mask or delay a billing failure", async () => {
    let calls = 0;
    const pool = {
      query: async (sql: string) => {
        calls++;
        if (calls === 1) throw new Error("journal unavailable");
        if (sql.includes("UPDATE product_friction_events")) {
          return await new Promise<never>(() => {});
        }
        throw new Error(`unexpected SQL: ${sql}`);
      },
    } as unknown as Pool;
    const result = await Promise.race([
      settleDurableCodexBilling({
        pgPool: pool,
        preCheckRedis: new InMemoryPreCheckRedis(),
        pricing: pricingCache(),
      }, USER_ID, frame()).then(
        () => "resolved" as const,
        (error: unknown) => error,
      ),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);
    assert.ok(result instanceof Error);
    assert.match(result.message, /journal unavailable/);
    assert.equal(calls, 2, "the non-blocking telemetry transition was still attempted");
  });

  test("committed / explicitly permanent-waived journals are terminal", async () => {
    for (const [state, expected] of [
      ["committed", "already_committed"],
      ["aborted", "waived"],
    ] as const) {
      let connects = 0;
      const pool = {
        query: async (sql: string) => {
          if (sql.includes("SELECT state, user_id::text")) {
            return {
              rows: [{
                state,
                user_id: USER_ID.toString(),
                ctx: {},
                error_msg: state === "aborted" ? permanentCodexWaiverReason("terminal_no_usage") : null,
              }],
              rowCount: 1,
            };
          }
          if (sql.includes("FROM usage_records ur")) return { rows: [], rowCount: 0 };
          if (sql.includes("UPDATE product_friction_events")) return { rows: [], rowCount: 0 };
          throw new Error(`unexpected SQL: ${sql}`);
        },
        connect: async () => {
          connects++;
          throw new Error("must not connect");
        },
      } as unknown as Pool;
      const outcome = await settleDurableCodexBilling({
        pgPool: pool,
        preCheckRedis: new InMemoryPreCheckRedis(),
        pricing: pricingCache(),
      }, USER_ID, frame());
      assert.equal(outcome, expected);
      assert.equal(connects, 0);
    }
  });

  test("a GC'd journal ACKs only when permanent usage proves prior settlement", async () => {
    let calls = 0;
    const pool = {
      query: async () => {
        calls++;
        if (calls === 1) return { rows: [], rowCount: 0 };
        return { rows: [{ present: true }], rowCount: 1 };
      },
    } as unknown as Pool;
    assert.equal(await settleDurableCodexBilling({
      pgPool: pool,
      preCheckRedis: new InMemoryPreCheckRedis(),
      pricing: pricingCache(),
    }, USER_ID, frame()), "already_committed");
    assert.equal(calls, 3, "journal + permanent usage proof + non-blocking recovery telemetry");
  });

  test("an unmarked legacy aborted journal ACKs only when usage proves settlement", async () => {
    let calls = 0;
    const pool = {
      query: async () => {
        calls++;
        if (calls === 1) {
          return {
            rows: [{
              state: "aborted",
              user_id: USER_ID.toString(),
              ctx: {},
              error_msg: "codex_commit_failed: transient outage",
            }],
            rowCount: 1,
          };
        }
        return { rows: [{ present: true }], rowCount: 1 };
      },
    } as unknown as Pool;
    assert.equal(await settleDurableCodexBilling({
      pgPool: pool,
      preCheckRedis: new InMemoryPreCheckRedis(),
      pricing: pricingCache(),
    }, USER_ID, frame()), "already_committed");
    assert.equal(calls, 3, "journal + permanent usage proof + non-blocking recovery telemetry");
  });

  test("a permanent waiver is not ACKed when its journal update is transiently unavailable", async () => {
    let calls = 0;
    const pool = {
      query: async (sql: string) => {
        calls++;
        if (sql.includes("SELECT state, user_id::text")) {
          return {
            rows: [{
              state: "inflight",
              user_id: USER_ID.toString(),
              ctx: {},
              error_msg: null,
            }],
            rowCount: 1,
          };
        }
        throw new Error("simulated journal outage");
      },
    } as unknown as Pool;
    await assert.rejects(() => settleDurableCodexBilling({
      pgPool: pool,
      preCheckRedis: new InMemoryPreCheckRedis(),
      pricing: pricingCache(),
    }, USER_ID, frame()), /simulated journal outage/);
    assert.equal(calls, 3, "journal read + repair attempt + non-blocking telemetry");
  });

  test("claim loser 不得在 winner 尚无持久终态时 ACK immutable frame", async () => {
    let connects = 0;
    const pool = {
      query: async (sql: string) => {
        if (sql.includes("SELECT state, user_id::text")) {
          return {
            rows: [{
              state: "inflight",
              user_id: USER_ID.toString(),
              ctx: {
                model: PRICING.model_id,
                billingPricing: serializeBillingPricing(PRICING),
              },
              error_msg: null,
            }],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM usage_records ur")) return { rows: [], rowCount: 0 };
        if (sql.includes("SET state='finalizing'")) return { rows: [], rowCount: 0 };
        if (sql.includes("SELECT state, error_msg")) {
          return { rows: [{ state: "finalizing", error_msg: null }], rowCount: 1 };
        }
        if (sql.includes("UPDATE product_friction_events")) return { rows: [], rowCount: 0 };
        throw new Error(`unexpected SQL: ${sql}`);
      },
      connect: async () => {
        connects++;
        throw new Error("claim loser must not settle");
      },
    } as unknown as Pool;

    await assert.rejects(
      () => settleDurableCodexBilling({
        pgPool: pool,
        preCheckRedis: new InMemoryPreCheckRedis(),
        pricing: pricingCache(),
      }, USER_ID, frame()),
      /still owned/,
    );
    assert.equal(connects, 0);
  });

  test("claim loser 仅在 usage 持久真相出现后 ACK 并修复 journal", async () => {
    let repairCalls = 0;
    const pool = {
      query: async (sql: string) => {
        if (sql.includes("SELECT state, user_id::text")) {
          return {
            rows: [{
              state: "inflight",
              user_id: USER_ID.toString(),
              ctx: {
                model: PRICING.model_id,
                billingPricing: serializeBillingPricing(PRICING),
              },
              error_msg: null,
            }],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM usage_records ur")) {
          repairCalls++;
          return { rows: [], rowCount: repairCalls === 1 ? 0 : 1 };
        }
        if (sql.includes("SET state='finalizing'")) return { rows: [], rowCount: 0 };
        if (sql.includes("UPDATE product_friction_events")) return { rows: [], rowCount: 0 };
        throw new Error(`unexpected SQL: ${sql}`);
      },
    } as unknown as Pool;

    assert.equal(await settleDurableCodexBilling({
      pgPool: pool,
      preCheckRedis: new InMemoryPreCheckRedis(),
      pricing: pricingCache(),
    }, USER_ID, frame()), "already_committed");
    assert.equal(repairCalls, 2);
  });

  test("inflight journal replays exact frozen pricing, token fields and turn locator atomically", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const redis = new InMemoryPreCheckRedis();
    await redis.atomicReserve({
      userId: USER_ID,
      requestId: REQUEST_ID,
      balance: 1_000_000n,
      maxCost: 100n,
      ttlSeconds: 60,
    });
    const record = (sql: string, params?: unknown[]) => queries.push({ sql, params });
    const client = {
      query: async (sqlOrConfig: unknown, params?: unknown[]) => {
        const sql = typeof sqlOrConfig === "string"
          ? sqlOrConfig
          : (sqlOrConfig as { text: string }).text;
        record(sql, params);
        const trimmed = sql.trim();
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(trimmed)) {
          return { rows: [], rowCount: 0 };
        }
        if (trimmed.startsWith("SELECT m.org_id")) return { rows: [], rowCount: 0 };
        if (trimmed.startsWith("INSERT INTO usage_records")) {
          return { rows: [{ id: "100" }], rowCount: 1 };
        }
        if (trimmed.startsWith("SELECT credits::text AS credits FROM users")) {
          return { rows: [{ credits: "1000000" }], rowCount: 1 };
        }
        if (trimmed.startsWith("SELECT id::text AS id, period_credits::text")) {
          return { rows: [], rowCount: 0 };
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
        if (trimmed.startsWith("INSERT INTO pending_usage_patches")) {
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`unhandled fake client SQL: ${trimmed.slice(0, 100)}`);
      },
      release: () => {},
    } as unknown as PoolClient;
    const pool = {
      query: async (sqlOrConfig: unknown, params?: unknown[]) => {
        const sql = typeof sqlOrConfig === "string"
          ? sqlOrConfig
          : (sqlOrConfig as { text: string }).text;
        record(sql, params);
        const trimmed = sql.trim();
        if (trimmed.startsWith("SELECT state, user_id::text AS user_id, ctx")) {
          return {
            rows: [{
              state: "inflight",
              user_id: USER_ID.toString(),
              ctx: {
                model: PRICING.model_id,
                agentId: "codex",
                billingPricing: serializeBillingPricing(PRICING),
              },
            }],
            rowCount: 1,
          };
        }
        if (trimmed.includes("FROM usage_records ur")) {
          return { rows: [], rowCount: 0 };
        }
        if (trimmed.startsWith("UPDATE request_finalize_journal")) {
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`unhandled fake pool SQL: ${trimmed.slice(0, 100)}`);
      },
      connect: async () => client,
    } as unknown as Pool;

    assert.equal(await settleDurableCodexBilling({
      pgPool: pool,
      preCheckRedis: redis,
      pricing: pricingCache(),
    }, USER_ID, frame()), "committed");

    const usageInsert = queries.find(({ sql }) => sql.includes("INSERT INTO usage_records"));
    assert.ok(usageInsert?.params);
    assert.equal(usageInsert.params[4], "10");
    assert.equal(usageInsert.params[5], "10", "reasoning_output_tokens folds into billed output");
    assert.equal(usageInsert.params[6], "2");
    assert.equal(usageInsert.params[7], "1");
    assert.equal(usageInsert.params[10], ENGINE_SESSION_ID);
    assert.equal(usageInsert.params[13], REQUEST_ID);
    const locatorInsert = queries.find(({ sql }) => sql.includes("INSERT INTO pending_usage_patches"));
    assert.ok(locatorInsert?.params);
    assert.equal(locatorInsert.params[0], REQUEST_ID);
    assert.equal(locatorInsert.params[1], `c:${USER_ID.toString()}`);
    assert.equal(locatorInsert.params[5], TURN_KEY);
    assert.equal(locatorInsert.params[6], null);
    assert.equal(redis.totalLocked(USER_ID), 0n, "durable replay releases the original precheck lock");
    assert.ok(queries.some(({ sql }) =>
      sql.includes("UPDATE request_finalize_journal") && sql.includes("state='committed'")));
  });
});
