/** Real PostgreSQL admission test using a session-local TEMP shadow table. */
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { BoxDurableJournal, BoxDurableJournalError } from "./boxDurableJournal.js";

const databaseUrl = process.env.OCV5_289_JOURNAL_TEST_DATABASE_URL
  ?? process.env.TEST_DATABASE_URL;

test("one Box account admits two independent runs, not three or a second same-session run",
  { skip: !databaseUrl }, async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    const client = await pool.connect();
    try {
      await client.query(`CREATE TEMP TABLE request_finalize_journal (
        request_id text PRIMARY KEY, user_id bigint NOT NULL, container_id bigint,
        state text NOT NULL, ctx jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(), error_msg text,
        failure_code text, final_credits bigint)`);
      const sameConnection = { connect: async () => ({
        query: (sql: string, params?: unknown[]) => client.query(sql, params),
        release: () => {},
      }), query: (sql: string, params?: unknown[]) => client.query(sql, params) } as never;
      const journal = new BoxDurableJournal(sameConnection,
        (uid, accountId) => uid === 3n && accountId === 20n ? 2 : 1);
      const suffix = randomBytes(6).toString("hex");
      const model = "box-api-claude-opus-5-5";
      const make = (name: string, sessionId: string, digit: string) => ({
        requestId: `parallel-${name}-${suffix}`, uid: 3n, accountId: 20n,
        model, runNonce: digit.repeat(24), leaseEpoch: digit.repeat(32),
        fingerprint: { sessionId, turnKey: digit.repeat(64),
          requestHash: digit.repeat(64), replayFingerprint: digit.repeat(64) },
      });
      const a = make("a", `session-a-${suffix}`, "a");
      const b = make("b", `session-b-${suffix}`, "b");
      const c = make("c", `session-c-${suffix}`, "c");
      const sameSession = make("same", a.fingerprint.sessionId, "d");
      const put = async (input: typeof a) => client.query(
        `INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
         VALUES ($1,3,'inflight',$2::jsonb)`, [input.requestId, JSON.stringify({
          model, boxInvocationRecovery: "v1",
          billingPricing: { v: 1, modelId: model, displayName: "Opus",
            inputPerMtok: "1", outputPerMtok: "1", cacheReadPerMtok: "1",
            cacheWritePerMtok: "1", multiplier: "1" },
          boxBillingContext: { v: 1, sessionId: input.fingerprint.sessionId,
            mode: "chat", parentSessionId: null, delegateAgentId: null,
            turnKey: input.fingerprint.turnKey, parentTurnKey: null,
            authority: null, dispatchId: null, attemptNo: null,
            verificationSponsorship: null, apiKeyId: null },
        })]);
      for (const input of [a, b, c, sameSession]) await put(input);
      await journal.admit(a);
      // A linked HTTP row is still one remote run, not a second account slot.
      for (let round = 0; round < 128; round++) {
        await client.query(`INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
          VALUES ($1,3,'inflight',$2::jsonb)`, [`parallel-linked-${round}-${suffix}`,
          JSON.stringify({ boxState: "linked", boxAccountId: "20",
            boxSessionId: a.fingerprint.sessionId, boxRunNonce: a.runNonce,
            boxLeaseEpoch: a.leaseEpoch })]);
      }
      await journal.admit(b);
      const held = (error: unknown) => error instanceof BoxDurableJournalError
        && error.code === "BOX_CAPACITY_HELD";
      await assert.rejects(() => journal.admit(c), held);
      await assert.rejects(() => journal.admit(sameSession), held);
      // Closing A's group frees only A; B stays active and still blocks its session.
      await journal.markPrestartStopped(a);
      await client.query(`UPDATE request_finalize_journal
        SET ctx=jsonb_set(ctx,'{boxState}','"complete"'::jsonb)
        WHERE ctx->>'boxRunNonce'=$1 AND ctx->>'boxState'='linked'`, [a.runNonce]);
      await journal.admit(c);
      await assert.rejects(() => journal.admit(sameSession), held);

      const malformed = make("malformed", `session-malformed-${suffix}`, "e");
      malformed.accountId = 21n;
      await put(malformed);
      await client.query(`INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
        VALUES ($1,3,'inflight',$2::jsonb)`, [`parallel-corrupt-${suffix}`,
        JSON.stringify({ boxState: "running", boxAccountId: "21",
          boxSessionId: "corrupt", boxRunNonce: "bad", boxLeaseEpoch: "bad" })]);
      await assert.rejects(() => journal.admit(malformed), held);
    } finally { client.release(); await pool.end(); }
  });
