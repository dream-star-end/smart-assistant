import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { recoverBoxBillingRequest } from "./boxBillingRecovery.js";

test("missing proof or usage cannot be turned into a Box settlement", async () => {
  const queries: string[] = [];
  const pool = { async query(sql: string) {
    queries.push(sql);
    if (sql.includes("SELECT request_id,user_id::text,state,ctx")) return {
      rows: [{ request_id: "box-test", user_id: "3", state: "inflight",
        ctx: { boxInvocationRecovery: "v1", boxState: "terminal",
          model: "box-api-claude-opus-5-5", boxUsage: {
            inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } } }],
      rowCount: 1 };
    if (sql.includes("FROM usage_records ur")) return { rows: [], rowCount: 0 };
    throw new Error(`unexpected recovery SQL: ${sql.slice(0, 80)}`);
  } } as unknown as Pool;
  assert.equal(await recoverBoxBillingRequest(pool, "box-test", 3n), "manual");
  assert.equal(queries.length, 2);
  assert.ok(!queries.some((sql) => sql.includes("SET state='finalizing'")));
});

test("committed Box journal needs permanent usage truth before ACK", async () => {
  const makePool = (present: boolean) => ({ async query(sql: string) {
    if (sql.includes("SELECT request_id,user_id::text,state,ctx")) return {
      rows: [{ request_id: "box-test", user_id: "3", state: "committed",
        ctx: { boxInvocationRecovery: "v1" } }], rowCount: 1 };
    if (sql.includes("SELECT EXISTS(SELECT 1 FROM usage_records")) return {
      rows: [{ present }], rowCount: 1 };
    throw new Error(`unexpected recovery SQL: ${sql.slice(0, 80)}`);
  } }) as unknown as Pool;
  assert.equal(await recoverBoxBillingRequest(makePool(false), "box-test", 3n), "manual");
  assert.equal(await recoverBoxBillingRequest(makePool(true), "box-test", 3n),
    "already_committed");
});

test("fresh terminal evidence cannot race the live proxy finalizer", async () => {
  const turnKey = "a".repeat(64), nonce = "b".repeat(24), epoch = "c".repeat(32);
  const ctx = { boxInvocationRecovery: "v1", boxState: "terminal",
    model: "box-api-claude-opus-5-5", boxRunNonce: nonce, boxLeaseEpoch: epoch,
    boxAccountId: "20", boxReplayFingerprint: "d".repeat(64), boxTurnKey: turnKey,
    boxTerminalProof: { runNonce: nonce, leaseEpoch: epoch, keeperPid: 101,
      cliPid: 102, reason: "worker_complete", revision: 1 },
    boxUsage: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
    billingPricing: { v: 1, modelId: "box-api-claude-opus-5-5", displayName: "Opus",
      inputPerMtok: "1", outputPerMtok: "1", cacheReadPerMtok: "1",
      cacheWritePerMtok: "1", multiplier: "1" },
    boxBillingContext: { v: 1, sessionId: "web-test", mode: "chat",
      parentSessionId: null, delegateAgentId: null, turnKey, parentTurnKey: null,
      authority: null, dispatchId: null, attemptNo: null,
      verificationSponsorship: null, apiKeyId: null } };
  const queries: string[] = [];
  const pool = { async query(sql: string) {
    queries.push(sql);
    if (sql.includes("SELECT request_id,user_id::text,state,ctx,updated_at")) return {
      rows: [{ request_id: "box-test", user_id: "3", state: "inflight",
        ctx, updated_at: new Date() }], rowCount: 1 };
    if (sql.includes("FROM usage_records ur")) return { rows: [], rowCount: 0 };
    throw new Error(`unexpected recovery SQL: ${sql.slice(0, 80)}`);
  } } as unknown as Pool;
  assert.equal(await recoverBoxBillingRequest(pool, "box-test", 3n), "pending");
  assert.equal(queries.length, 2, "fresh live request must not be claimed or debited");
});
