/** Real PostgreSQL test against session-local TEMP shadow tables (same
 * technique as boxUnreachableClose.test.ts). No live table is touched. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Pool, type PoolClient } from "pg";
import { BoxLegacyLeafCloseError, closeLegacyReleasedLeaf,
  type LegacyReleasedLeaf } from "./boxLegacyReleasedLeafClose.js";

const testDatabaseUrl = process.env.OCV5_289_JOURNAL_TEST_DATABASE_URL
  ?? process.env.TEST_DATABASE_URL;
const proof = { cliPid: 407740, reason: "worker_complete", revision: 1,
  runNonce: "2".repeat(24), keeperPid: 407738, leaseEpoch: "6".repeat(32) };
const release = { v: 1, operationId: "ocv5-296-r43-completed-release-v1",
  appliedAt: "2026-09-30T12:52:08.120Z", before: { state: "inflight", final_credits: null },
  evidence: { proof, unsettled: { count: 3, stopReasons: ["tool_use", "tool_use", "end_turn"] } },
  financialDisposition: "unsettled_preserved_no_adjustment" };
const baseCtx = { model: "box-api-claude-opus-5-5", boxInvocationRecovery: "v1",
  boxInvocationMode: "detached_tool", boxAccountId: "20", boxRunNonce: proof.runNonce,
  boxLeaseEpoch: proof.leaseEpoch, boxSessionId: "sess-legacy", boxRoundNo: 46,
  boxOwnerRequestId: "legacy-parent", boxState: "operator_completed_released",
  boxUnknownPhase: "continuation_unknown", boxOperatorCompletedRelease: release };

async function withDb(fn: (db: { client: PoolClient; pool: never;
  seed(ctx?: Record<string, unknown>, state?: string, credits?: number | null): Promise<LegacyReleasedLeaf>;
  row(): Promise<{ state: string; final_credits: string | null; failure_code: string | null;
    ctx: Record<string, unknown> }>;
  snapshot(): Promise<string> }) => Promise<void>): Promise<void> {
  const real = new Pool({ connectionString: testDatabaseUrl, max: 1 });
  const client = await real.connect();
  try {
    await client.query(`CREATE TEMP TABLE request_finalize_journal (
      request_id text PRIMARY KEY, user_id bigint NOT NULL, container_id bigint,
      state text NOT NULL, ctx jsonb NOT NULL, final_credits bigint, failure_code text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now())`);
    await client.query(`CREATE TEMP TABLE usage_records (
      request_id text NOT NULL, user_id bigint NOT NULL)`);
    await client.query(`CREATE TEMP TABLE claude_accounts (
      id bigint PRIMARY KEY, provider text NOT NULL, status text NOT NULL)`);
    await client.query("INSERT INTO claude_accounts VALUES (20,'cursor','disabled')");
    const pool = { connect: async () => ({ query: client.query.bind(client),
      release: () => {} }) } as never;
    const seed = async (ctx: Record<string, unknown> = {}, state = "inflight",
      credits: number | null = null): Promise<LegacyReleasedLeaf> => {
      await client.query("DELETE FROM request_finalize_journal");
      await client.query(`INSERT INTO request_finalize_journal
        (request_id,user_id,state,ctx,final_credits,updated_at)
        VALUES ('legacy-leaf',3,$1,$2::jsonb,$3,NOW()-INTERVAL '4 days')`,
      [state, JSON.stringify({ ...baseCtx, ...ctx }), credits]);
      // The pin is the hash of the marker exactly as PostgreSQL stores it.
      const stored = await client.query<{ text: string }>(
        `SELECT (to_jsonb($1::json))::text AS text`, [JSON.stringify(release)]);
      return { requestId: "legacy-leaf", uid: "3", accountId: "20", runNonce: proof.runNonce,
        leaseEpoch: proof.leaseEpoch,
        markerSha256: createHash("sha256").update(stored.rows[0]!.text).digest("hex") };
    };
    const row = async () => (await client.query<{ state: string; final_credits: string | null;
      failure_code: string | null; ctx: Record<string, unknown> }>(
      `SELECT state,final_credits::text AS final_credits,failure_code,ctx
         FROM request_finalize_journal WHERE request_id='legacy-leaf'`)).rows[0]!;
    const snapshot = async () => JSON.stringify((await client.query(
      `SELECT request_id,state,final_credits,failure_code,updated_at,ctx::text AS ctx
         FROM request_finalize_journal`)).rows);
    await fn({ client, pool, seed, row, snapshot });
  } finally { client.release(); await real.end(); }
}

test("the released leaf is settled as undelivered and unbilled; nothing else changes",
  { skip: !testDatabaseUrl }, async () => withDb(async (db) => {
  const leaf = await db.seed();
  const before = await db.snapshot();
  assert.deepEqual(await closeLegacyReleasedLeaf(db.pool, { ticket: "OCV5-313", apply: false, leaf }),
    { requestId: "legacy-leaf", action: "would_close" });
  assert.equal(await db.snapshot(), before, "dry-run runs the same statement and rolls back");
  const updatedAt = (await db.client.query<{ at: string }>(
    "SELECT updated_at::text AS at FROM request_finalize_journal")).rows[0]!.at;
  assert.deepEqual(await closeLegacyReleasedLeaf(db.pool, { ticket: "OCV5-313", apply: true, leaf }),
    { requestId: "legacy-leaf", action: "closed" });
  const row = await db.row();
  assert.deepEqual([row.state, row.final_credits, row.failure_code], ["aborted", "0", "STREAM_FAILED"]);
  assert.equal(row.ctx.boxState, "operator_completed_released");
  assert.deepEqual(row.ctx.boxOperatorCompletedRelease, release, "the release marker is kept");
  const settle = row.ctx.boxOperatorLeafSettle as Record<string, unknown>;
  assert.deepEqual({ ...settle, atMs: 0 }, { v: 1, ticket: "OCV5-313", atMs: 0,
    priorState: "inflight", outcome: "undelivered_unbilled" });
  assert.equal((await db.client.query<{ at: string }>(
    "SELECT updated_at::text AS at FROM request_finalize_journal")).rows[0]!.at, updatedAt);
  // A second run finds nothing left to settle.
  await assert.rejects(closeLegacyReleasedLeaf(db.pool, { ticket: "OCV5-313", apply: true, leaf }),
    (error: unknown) => error instanceof BoxLegacyLeafCloseError
      && error.code === "BOX_LEGACY_LEAF_FENCE_LOST");
}));

test("any other row, edited evidence or disposition, usage or an enabled account is refused",
  { skip: !testDatabaseUrl }, async () => withDb(async (db) => {
  const refused = async (name: string, expected: string, arrange: () => Promise<{
    leaf: LegacyReleasedLeaf; undo?: () => Promise<unknown> }>) => {
    const { leaf, undo } = await arrange();
    const before = await db.snapshot();
    await assert.rejects(closeLegacyReleasedLeaf(db.pool, { ticket: "OCV5-313", apply: true, leaf }),
      (error: unknown) => error instanceof BoxLegacyLeafCloseError && error.code === expected, name);
    assert.equal(await db.snapshot(), before, `${name}: nothing changed`);
    await undo?.();
  };
  const edited = (change: Record<string, unknown>) => async () => {
    const leaf = await db.seed();
    await db.client.query(`UPDATE request_finalize_journal
      SET ctx=jsonb_set(ctx,'{boxOperatorCompletedRelease}',$1::jsonb)`,
    [JSON.stringify({ ...release, ...change })]);
    return { leaf };
  };
  const lost = "BOX_LEGACY_LEAF_FENCE_LOST";
  await refused("nested evidence", lost, edited({ evidence: { ...release.evidence,
    unsettled: { count: 2, stopReasons: ["tool_use", "end_turn"] } } }));
  await refused("nested proof", lost, edited({ evidence: { ...release.evidence,
    proof: { ...proof, reason: "keeper_stopped" } } }));
  await refused("financial disposition", lost, edited({ financialDisposition: "refunded" }));
  await refused("operation", lost, edited({ operationId: "another-operation" }));
  await refused("marker missing", lost, async () => ({ leaf: await db.seed({
    boxOperatorCompletedRelease: undefined }) }));
  await refused("other nonce", lost, async () => ({ leaf: { ...await db.seed(),
    runNonce: "3".repeat(24) } }));
  await refused("other epoch", lost, async () => ({ leaf: { ...await db.seed(),
    leaseEpoch: "3".repeat(32) } }));
  await refused("other box state", lost, async () => ({ leaf: await db.seed({ boxState: "unknown" }) }));
  await refused("handoff present", lost, async () => ({ leaf: await db.seed({ boxToolHandoff: {} }) }));
  await refused("proof present", lost, async () => ({ leaf: await db.seed({ boxTerminalProof: proof }) }));
  await refused("settlement claim", lost, async () => ({ leaf: await db.seed({ settlementClaimId: "c" }) }));
  await refused("already settled", lost, async () => ({ leaf: await db.seed({}, "committed", 5) }));
  await refused("credits present", lost, async () => ({ leaf: await db.seed({}, "inflight", 0) }));
  await refused("usage", "BOX_LEGACY_LEAF_USAGE_PRESENT", async () => {
    const leaf = await db.seed();
    await db.client.query("INSERT INTO usage_records VALUES ('legacy-leaf',3)");
    return { leaf, undo: () => db.client.query("DELETE FROM usage_records") };
  });
  await refused("enabled account", "BOX_LEGACY_LEAF_ACCOUNT_NOT_DISABLED", async () => {
    const leaf = await db.seed();
    await db.client.query("UPDATE claude_accounts SET status='active' WHERE id=20");
    return { leaf, undo: () => db.client.query(
      "UPDATE claude_accounts SET status='disabled' WHERE id=20") };
  });
  await refused("missing row", "BOX_LEGACY_LEAF_ROW_MISSING", async () => ({
    leaf: { ...await db.seed(), requestId: "no-such-row" } }));
  await assert.rejects(closeLegacyReleasedLeaf(db.pool, { ticket: "nope", apply: true,
    leaf: await db.seed() }), (error: unknown) => error instanceof BoxLegacyLeafCloseError
      && error.code === "BOX_LEGACY_LEAF_INPUT_INVALID");
}));
