/** Box invocation fence on the existing request_finalize_journal.ctx JSONB.
 * No schema change. This is deliberately stricter than HTTP idempotency: an
 * identical body in one signed turn remains ambiguous and is never re-run. */
import type { Pool, PoolClient } from "pg";
import type { BoxCallFingerprint } from "./boxCallFingerprint.js";
import type { BoxTerminalProof } from "./boxTerminalProof.js";

const ACTIVE = ["reserved", "starting", "running", "unknown", "handoff", "resuming"];

export class BoxDurableJournalError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxDurableJournalError"; }
}

export interface BoxUsageEvidence {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface BoxJournalAdmission {
  requestId: string;
  uid: bigint;
  accountId: bigint;
  model: string;
  fingerprint: BoxCallFingerprint;
  runNonce: string;
  leaseEpoch: string;
}

export interface BoxJournalPort {
  admit(input: BoxJournalAdmission): Promise<void>;
  markRunning(input: Pick<BoxJournalAdmission, "requestId" | "uid" | "leaseEpoch">): Promise<void>;
  markPrestartStopped(input: Pick<BoxJournalAdmission, "requestId" | "uid" | "leaseEpoch">): Promise<void>;
  markUnknown(input: Pick<BoxJournalAdmission, "requestId" | "uid" | "leaseEpoch"> &
    { phase: string }): Promise<void>;
  complete(input: Pick<BoxJournalAdmission, "requestId" | "uid" | "leaseEpoch"> &
    { proof: BoxTerminalProof; usage: BoxUsageEvidence }): Promise<void>;
}

function goodId(input: BoxJournalAdmission): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.requestId)
    || input.uid <= 0n || input.accountId <= 0n
    || !/^[a-f0-9]{24}$/.test(input.runNonce)
    || !/^[a-f0-9]{32}$/.test(input.leaseEpoch)
    || !/^[a-f0-9]{64}$/.test(input.fingerprint.replayFingerprint)
    || !/^[a-f0-9]{64}$/.test(input.fingerprint.requestHash)
    || !/^[a-f0-9]{64}$/.test(input.fingerprint.turnKey)
    || !/^[A-Za-z0-9._:-]{1,256}$/.test(input.fingerprint.sessionId)
    || !/^(?:box-api-)?claude-[a-z0-9-]{3,64}$/.test(input.model)) {
    throw new BoxDurableJournalError("BOX_JOURNAL_IDENTITY_INVALID");
  }
}

async function lock(client: PoolClient, keys: string[]): Promise<void> {
  for (const key of [...keys].sort()) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [key]);
  }
}

export class BoxDurableJournal implements BoxJournalPort {
  constructor(private readonly pool: Pick<Pool, "connect" | "query">) {}

  async admit(input: BoxJournalAdmission): Promise<void> {
    goodId(input);
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      await lock(client, [
        `box:account:${input.accountId}`, `box:fingerprint:${input.fingerprint.replayFingerprint}`,
        `box:session:${input.uid}:${input.fingerprint.sessionId}`,
      ]);
      const duplicate = await client.query(
        "SELECT 1 FROM request_finalize_journal WHERE ctx->>'boxReplayFingerprint' = $1 LIMIT 1",
        [input.fingerprint.replayFingerprint]);
      if (duplicate.rowCount) throw new BoxDurableJournalError("BOX_CALL_AMBIGUOUS");
      const occupied = await client.query(
        `SELECT 1 FROM request_finalize_journal
          WHERE ctx->>'boxState' = ANY($1::text[])
            AND (ctx->>'boxAccountId' = $2 OR
              (user_id = $3 AND ctx->>'boxSessionId' = $4)) LIMIT 1`,
        [ACTIVE, input.accountId.toString(), input.uid.toString(), input.fingerprint.sessionId]);
      if (occupied.rowCount) throw new BoxDurableJournalError("BOX_CAPACITY_HELD");
      const identity = { boxInvocationRecovery: "v1", boxState: "reserved",
        boxAccountId: input.accountId.toString(),
        boxReplayFingerprint: input.fingerprint.replayFingerprint,
        boxRequestHash: input.fingerprint.requestHash,
        boxTurnKey: input.fingerprint.turnKey,
        boxSessionId: input.fingerprint.sessionId,
        boxRunNonce: input.runNonce, boxLeaseEpoch: input.leaseEpoch };
      const updated = await client.query(
        `UPDATE request_finalize_journal
            SET ctx = ctx || $4::jsonb, updated_at = NOW()
          WHERE request_id = $1 AND user_id = $2 AND state = 'inflight'
            AND ctx->>'model' = $3 AND ctx->>'boxInvocationRecovery' = 'v1'
            AND ctx ? 'billingPricing' AND NOT (ctx ? 'boxState')`,
        [input.requestId, input.uid.toString(), input.model, JSON.stringify(identity)]);
      if (updated.rowCount !== 1) throw new BoxDurableJournalError("BOX_JOURNAL_NOT_INFLIGHT");
      await client.query("COMMIT");
      committed = true;
    } finally {
      if (!committed) await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  }

  async markRunning(input: Pick<BoxJournalAdmission, "requestId" | "uid" | "leaseEpoch">): Promise<void> {
    const changed = await this.pool.query(
      `UPDATE request_finalize_journal
          SET ctx = jsonb_set(ctx, '{boxState}', '"running"'::jsonb), updated_at = NOW()
        WHERE request_id = $1 AND user_id = $2 AND state = 'inflight'
          AND ctx->>'boxLeaseEpoch' = $3 AND ctx->>'boxState' = 'reserved'`,
      [input.requestId, input.uid.toString(), input.leaseEpoch]);
    if (changed.rowCount !== 1) throw new BoxDurableJournalError("BOX_JOURNAL_START_FENCE_LOST");
  }

  /** Only the caller that has not invoked plan.run may use this transition. */
  async markPrestartStopped(input: Pick<BoxJournalAdmission, "requestId" | "uid" | "leaseEpoch">): Promise<void> {
    const changed = await this.pool.query(
      `UPDATE request_finalize_journal
          SET ctx = jsonb_set(ctx, '{boxState}', '"prestart_stopped"'::jsonb),
              updated_at = NOW()
        WHERE request_id = $1 AND user_id = $2 AND state = 'inflight'
          AND ctx->>'boxLeaseEpoch' = $3
          AND ctx->>'boxState' IN ('reserved', 'running')`,
      [input.requestId, input.uid.toString(), input.leaseEpoch]);
    if (changed.rowCount !== 1) throw new BoxDurableJournalError("BOX_JOURNAL_PRESTART_FENCE_LOST");
  }

  async markUnknown(input: Pick<BoxJournalAdmission, "requestId" | "uid" | "leaseEpoch"> &
    { phase: string }): Promise<void> {
    const changed = await this.pool.query(
      `UPDATE request_finalize_journal
          SET ctx = ctx || $4::jsonb, updated_at = NOW()
        WHERE request_id = $1 AND user_id = $2
          AND ctx->>'boxLeaseEpoch' = $3
          AND ctx->>'boxState' = ANY($5::text[])`,
      [input.requestId, input.uid.toString(), input.leaseEpoch,
        JSON.stringify({ boxState: "unknown", boxUnknownPhase: input.phase.slice(0, 80) }), ACTIVE]);
    if (changed.rowCount !== 1) throw new BoxDurableJournalError("BOX_JOURNAL_UNKNOWN_FENCE_LOST");
  }

  async complete(input: Pick<BoxJournalAdmission, "requestId" | "uid" | "leaseEpoch"> &
    { proof: BoxTerminalProof; usage: BoxUsageEvidence }): Promise<void> {
    const u = input.usage;
    if (input.proof.leaseEpoch !== input.leaseEpoch
      || input.proof.reason !== "worker_complete"
      || Object.values(u).some((n) => !Number.isSafeInteger(n) || n < 0)) {
      throw new BoxDurableJournalError("BOX_JOURNAL_EVIDENCE_INVALID");
    }
    const changed = await this.pool.query(
      `UPDATE request_finalize_journal
          SET ctx = ctx || $4::jsonb, updated_at = NOW()
        WHERE request_id = $1 AND user_id = $2 AND state = 'inflight'
          AND ctx->>'boxLeaseEpoch' = $3 AND ctx->>'boxRunNonce' = $5
          AND ctx->>'boxState' IN ('running', 'unknown')
          AND ctx ? 'billingPricing'`,
      [input.requestId, input.uid.toString(), input.leaseEpoch,
        JSON.stringify({ boxState: "terminal", boxUsage: u, boxTerminalProof: input.proof }),
        input.proof.runNonce]);
    if (changed.rowCount !== 1) throw new BoxDurableJournalError("BOX_JOURNAL_COMPLETE_FENCE_LOST");
  }
}
