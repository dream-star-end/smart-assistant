/** OCV5-323: an unknown resume leaf whose publish never reached the run is
 * listed as a stale resume, and only its exact identity records stop intent. */
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { BoxDurableJournal, BoxDurableJournalError } from "./boxDurableJournal.js";

const testDatabaseUrl = process.env.OCV5_289_JOURNAL_TEST_DATABASE_URL
  ?? process.env.TEST_DATABASE_URL;

test("stale resume leaves are listed with phase and age and take one stop intent",
  { skip: !testDatabaseUrl }, async () => {
  const pool = new Pool({ connectionString: testDatabaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    // Temp table shadows the real one on this pinned connection only.
    await client.query(`CREATE TEMP TABLE request_finalize_journal (
      request_id text PRIMARY KEY, user_id bigint NOT NULL,
      container_id bigint, state text NOT NULL,
      ctx jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      error_msg text, failure_code text, final_credits bigint)`);
    const query = (sql: string, params: unknown[] = []) => client.query(sql, params);
    const journal = new BoxDurableJournal({ connect: async () => ({ query,
      release: () => {} }), query } as never);
    const suffix = randomBytes(6).toString("hex");
    const leaseEpoch = "9".repeat(32);
    const base = { boxInvocationRecovery: "v1", boxInvocationMode: "detached_tool",
      boxAccountId: "20", boxLeaseEpoch: leaseEpoch };
    const insert = async (id: string, state: string, ctx: Record<string, unknown>,
      age: string) => client.query(`INSERT INTO request_finalize_journal
        (request_id,user_id,state,ctx,created_at,updated_at)
        VALUES ($1,3,$2,$3::jsonb,NOW()-$4::interval,NOW()-$4::interval)`,
      [id, state, JSON.stringify(ctx), age]);
    const unsent = `box-unsent-${suffix}`, unknown = `box-unknown-${suffix}`;
    const other = `box-other-${suffix}`, first = `box-first-${suffix}`;
    await insert(unsent, "inflight", { ...base, boxState: "unknown",
      boxRunNonce: "1".repeat(24), boxOwnerRequestId: `box-root-${suffix}`,
      boxUnknownPhase: "resume_publish_unsent" }, "30 seconds");
    await insert(unknown, "inflight", { ...base, boxState: "unknown",
      boxRunNonce: "2".repeat(24), boxOwnerRequestId: `box-root2-${suffix}`,
      boxUnknownPhase: "resume_publish_unknown" }, "25 minutes");
    await insert(other, "inflight", { ...base, boxState: "unknown",
      boxRunNonce: "3".repeat(24), boxOwnerRequestId: `box-root3-${suffix}`,
      boxUnknownPhase: "continuation_unknown" }, "2 hours");
    await insert(first, "inflight", { ...base, boxState: "running",
      boxRunNonce: "4".repeat(24) }, "2 hours");
    // OCV5-313: a launched first round that went unknown, one that never got
    // its launch permit, and a leaf older than the run's maximum lifetime.
    const launched = `box-launched-${suffix}`, staged = `box-staged-${suffix}`;
    const ancient = `box-ancient-${suffix}`, odd = `box-odd-${suffix}`;
    await insert(launched, "inflight", { ...base, boxState: "unknown", boxLaunchPermit: true,
      boxRunNonce: "6".repeat(24), boxUnknownPhase: "first_round_unknown" }, "30 minutes");
    await insert(staged, "inflight", { ...base, boxState: "unknown",
      boxRunNonce: "7".repeat(24),
      boxUnknownPhase: "stage_transport_unknown:input_3:BOX_EXEC_TIMEOUT" }, "30 minutes");
    await insert(ancient, "inflight", { ...base, boxState: "unknown",
      boxRunNonce: "8".repeat(24), boxOwnerRequestId: `box-root8-${suffix}`,
      boxUnknownPhase: "continuation_echo_rejected" }, "5 hours");
    await insert(odd, "inflight", { ...base, boxState: "unknown",
      boxRunNonce: "a".repeat(24), boxOwnerRequestId: `box-root9-${suffix}`,
      boxUnknownPhase: "free text; DROP" }, "30 minutes");

    const listed = await journal.listStoppedFailureProbeCandidates(20);
    const byId = new Map(listed.map((item) => [item.requestId, item]));
    const unsentProbe = byId.get(unsent), unknownProbe = byId.get(unknown);
    assert.ok(unsentProbe && unknownProbe && byId.get(other) && byId.get(first));
    assert.equal(unsentProbe.linked, true);
    assert.equal(unsentProbe.staleResume?.phase, "resume_publish_unsent");
    assert.ok(unsentProbe.staleResume!.unknownForMs >= 29_000
      && unsentProbe.staleResume!.unknownForMs < 120_000);
    assert.equal(unknownProbe.staleResume?.phase, "resume_publish_unknown");
    assert.ok(unknownProbe.staleResume!.unknownForMs >= 25 * 60_000 - 1000);
    // OCV5-313: every unknown phase of a launched run is a stop candidate.
    assert.equal(byId.get(other)!.staleResume?.phase, "continuation_unknown");
    assert.ok(byId.get(other)!.staleResume!.unknownForMs >= 2 * 3_600_000 - 1000);
    assert.equal(byId.get(first)!.staleResume, undefined, "a running row is not unknown");
    assert.equal(byId.get(launched)!.staleResume?.phase, "first_round_unknown");
    assert.equal(byId.get(launched)!.linked, false);
    assert.equal(byId.get(staged)!.staleResume, undefined,
      "no launch permit: no keeper exists, prelaunch recovery owns the row");
    assert.equal(byId.get(odd)!.staleResume, undefined, "an unvalidated phase is never used");
    assert.equal(byId.get(ancient)!.staleResume?.phase, "continuation_echo_rejected");
    assert.equal(byId.get(ancient)!.expired, true);
    for (const id of [unsent, unknown, other, first, launched, staged, odd]) {
      assert.equal(byId.get(id)!.expired, undefined, "younger than the run's maximum lifetime");
    }

    // Wrong phase or identity never records intent.
    assert.equal(await journal.recordStaleResumeStop({ ...unsentProbe,
      phase: "resume_publish_unknown" }), false);
    assert.equal(await journal.recordStaleResumeStop({ ...unsentProbe,
      runNonce: "5".repeat(24), phase: "resume_publish_unsent" }), false);
    assert.equal(await journal.recordStaleResumeStop({ ...unsentProbe,
      phase: "continuation_unknown" }), false, "the phase must be the row's own");
    await assert.rejects(journal.recordStaleResumeStop({ ...unsentProbe,
      phase: "free text; DROP" }), BoxDurableJournalError);
    assert.equal(await journal.recordStaleResumeStop({ ...byId.get(other)!,
      phase: "continuation_unknown" }), true);
    assert.equal(await journal.recordStaleResumeStop({ ...byId.get(launched)!,
      phase: "first_round_unknown" }), true);

    assert.equal(await journal.recordStaleResumeStop({ ...unsentProbe,
      phase: "resume_publish_unsent" }), true);
    const marked = await client.query<{ ctx: Record<string, unknown>; age: string }>(
      `SELECT ctx,(NOW()-updated_at)::text AS age FROM request_finalize_journal
        WHERE request_id=$1`, [unsent]);
    const intent = marked.rows[0]!.ctx.boxStaleResumeStop as { phase: string; atMs: number };
    assert.equal(intent.phase, "resume_publish_unsent");
    assert.ok(Math.abs(Number(intent.atMs) - Date.now()) < 60_000);
    assert.notEqual(marked.rows[0]!.age.startsWith("00:00:0"), true,
      "intent must not refresh updated_at (billing age)");
    // Idempotent: a second worker keeps the first marker.
    assert.equal(await journal.recordStaleResumeStop({ ...unsentProbe,
      phase: "resume_publish_unsent" }), true);
    const again = await client.query<{ ctx: Record<string, unknown> }>(
      `SELECT ctx FROM request_finalize_journal WHERE request_id=$1`, [unsent]);
    assert.deepEqual(again.rows[0]!.ctx.boxStaleResumeStop, intent);

    // Once a terminal proof exists the leaf is no longer a stale resume target.
    await client.query(`UPDATE request_finalize_journal
      SET ctx=ctx || '{"boxTerminalProof":{"reason":"worker_failed"}}'::jsonb
      WHERE request_id=$1`, [unknown]);
    assert.equal(await journal.recordStaleResumeStop({ ...unknownProbe,
      phase: "resume_publish_unknown" }), false);
  } finally {
    client.release();
    await pool.end();
  }
});
