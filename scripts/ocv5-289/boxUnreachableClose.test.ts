/** Real PostgreSQL test against session-local TEMP shadow tables (same
 * technique as boxDurableJournal.integ.test.ts). No live table is touched. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool, type PoolClient } from "pg";
import { BoxDurableJournal } from
  "../../packages/commercial/src/http/proxy/boxDurableJournal.js";
import { BOX_UNREACHABLE_CLOSED_STATE, closeUnreachableBoxRows }
  from "./boxUnreachableClose.js";

const testDatabaseUrl = process.env.OCV5_289_JOURNAL_TEST_DATABASE_URL
  ?? process.env.TEST_DATABASE_URL;
const LEAF = { requestId: "leaf-unbilled", runNonce: "a".repeat(24) };
const HANDOFF = { requestId: "handoff-billed", runNonce: "b".repeat(24) };
const CONTROL = "control-other-account";

function ctx(run: { runNonce: string }, extra: Record<string, unknown>): Record<string, unknown> {
  return { model: "box-api-claude-opus-5-5", boxInvocationRecovery: "v1",
    boxInvocationMode: "detached_tool", boxAccountId: "20", boxRunNonce: run.runNonce,
    boxLeaseEpoch: "c".repeat(32), boxSessionId: `session-${run.runNonce.slice(0, 4)}`,
    boxTurnKey: "d".repeat(64), ...extra };
}

async function withDb(fn: (db: { client: PoolClient; pool: never; journal: BoxDurableJournal;
  put(id: string, state: string, ctx: Record<string, unknown>, credits: number | null,
    age?: string): Promise<void>;
  snapshot(): Promise<string> }) => Promise<void>): Promise<void> {
  // One connection: TEMP tables are session-local and shadow the real ones.
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
    await client.query(`INSERT INTO claude_accounts VALUES (20,'cursor','disabled'),
      (25,'cursor','active')`);
    const pool = { connect: async () => ({ query: client.query.bind(client),
      release: () => {} }), query: client.query.bind(client) } as never;
    const put = async (id: string, state: string, value: Record<string, unknown>,
      credits: number | null, age = "6 hours"): Promise<void> => {
      await client.query(`INSERT INTO request_finalize_journal
        (request_id,user_id,state,ctx,final_credits,created_at,updated_at)
        VALUES ($1,3,$2,$3::jsonb,$4,now()-$5::interval,now()-$5::interval)`,
      [id, state, JSON.stringify(value), credits, age]);
      if (credits !== null) {
        await client.query("INSERT INTO usage_records VALUES ($1,3)", [id]);
      }
    };
    const snapshot = async (): Promise<string> => JSON.stringify((await client.query(
      `SELECT request_id,state,ctx,final_credits,failure_code,created_at,updated_at
         FROM request_finalize_journal ORDER BY request_id`)).rows);
    await fn({ client, pool, journal: new BoxDurableJournal(pool), put, snapshot });
  } finally { client.release(true); await real.end(); }
}

async function seed(db: { put: (id: string, state: string, ctx: Record<string, unknown>,
  credits: number | null, age?: string) => Promise<void> },
leafExtra: Record<string, unknown> = {}, leafAge = "6 hours"): Promise<void> {
  await db.put(LEAF.requestId, "inflight", ctx(LEAF, { boxState: "unknown",
    boxUnknownPhase: "resume_publish_unknown", boxOwnerRequestId: "owner-1",
    boxRoundNo: 2, ...leafExtra }), null, leafAge);
  await db.put(HANDOFF.requestId, "committed", ctx(HANDOFF, { boxState: "handoff",
    boxToolHandoff: { roundNo: 1 }, boxHandoffRevision: "r" }), 20);
  await db.put(CONTROL, "inflight", { ...ctx({ runNonce: "e".repeat(24) },
    { boxState: "unknown" }), boxAccountId: "25" }, null);
}
const input = (apply: boolean, runs = [LEAF, HANDOFF]) =>
  ({ uid: 3n, accountId: 20n, runs, ticket: "OCV5-312", apply });

test("closes both shapes: no stop probe, no cleanup, billing columns untouched",
  { skip: !testDatabaseUrl }, async () => {
  await withDb(async (db) => {
    await seed(db);
    const probed = async () => (await db.journal.listStoppedFailureProbeCandidates(20))
      .map((row) => row.requestId).sort();
    assert.deepEqual(await probed(), [CONTROL, HANDOFF.requestId, LEAF.requestId].sort());
    const before = (await db.client.query(`SELECT request_id,state,final_credits,
      failure_code,created_at,updated_at FROM request_finalize_journal ORDER BY 1`)).rows;

    assert.deepEqual(await closeUnreachableBoxRows(db.pool, input(true)), [
      { requestId: LEAF.requestId, shape: "unbilled_leaf", action: "closed",
        priorBoxState: "unknown" },
      { requestId: HANDOFF.requestId, shape: "billed_handoff", action: "closed",
        priorBoxState: "handoff" }]);

    assert.deepEqual(await probed(), [CONTROL]);
    assert.deepEqual(await db.journal.listRemoteCleanupCandidates(20), []);
    assert.deepEqual((await db.client.query(`SELECT request_id,state,final_credits,
      failure_code,created_at,updated_at FROM request_finalize_journal ORDER BY 1`)).rows, before);
    const rows = (await db.client.query<{ request_id: string; ctx: Record<string, any> }>(
      "SELECT request_id,ctx FROM request_finalize_journal ORDER BY 1")).rows;
    for (const row of rows.filter((item) => item.request_id !== CONTROL)) {
      assert.equal(row.ctx.boxState, BOX_UNREACHABLE_CLOSED_STATE);
      const { atMs, ...marker } = row.ctx.boxOperatorUnreachableClose;
      assert.ok(Number.isSafeInteger(atMs) && Math.abs(Date.now() - atMs) < 60_000);
      assert.deepEqual(marker, { v: 1, ticket: "OCV5-312", accountStatus: "disabled",
        priorBoxState: row.request_id === LEAF.requestId ? "unknown" : "handoff",
        terminalProof: false, remoteCleanup: false });
      assert.equal(row.ctx.boxTerminalProof, undefined);
    }
    assert.equal(rows.find((row) => row.request_id === CONTROL)?.ctx.boxState, "unknown");

    // Idempotent: a second run reports the stored prior state and writes nothing.
    const closed = await db.snapshot();
    assert.deepEqual((await closeUnreachableBoxRows(db.pool, input(true)))
      .map((row) => [row.action, row.priorBoxState]),
    [["already_closed", "unknown"], ["already_closed", "handoff"]]);
    assert.equal(await db.snapshot(), closed);
  });
});

test("dry-run reports the same rows and leaves the journal byte-identical",
  { skip: !testDatabaseUrl }, async () => {
  await withDb(async (db) => {
    await seed(db);
    const before = await db.snapshot();
    assert.deepEqual((await closeUnreachableBoxRows(db.pool, input(false)))
      .map((row) => row.action), ["would_close", "would_close"]);
    assert.equal(await db.snapshot(), before);
    assert.equal((await db.journal.listStoppedFailureProbeCandidates(20)).length, 3);
  });
});

const REJECTED: [string, string, (db: Parameters<Parameters<typeof withDb>[0]>[0]) => Promise<void>][] = [
  ["account re-enabled", "BOX_UNREACHABLE_ACCOUNT_NOT_DISABLED", async (db) => {
    await seed(db);
    await db.client.query("UPDATE claude_accounts SET status='active' WHERE id=20");
  }],
  ["run may still be alive", "BOX_UNREACHABLE_RUN_NOT_EXPIRED",
    async (db) => seed(db, {}, "4 hours")],
  ["nonce differs from the allowlist", "BOX_UNREACHABLE_IDENTITY_MISMATCH",
    async (db) => seed(db, { boxRunNonce: "f".repeat(24) })],
  ["row belongs to another account", "BOX_UNREACHABLE_IDENTITY_MISMATCH",
    async (db) => seed(db, { boxAccountId: "25" })],
  ["keeper proof exists (normal path owns it)", "BOX_UNREACHABLE_EVIDENCE_PRESENT",
    async (db) => seed(db, { boxTerminalProof: { reason: "keeper_stopped" } })],
  ["row was resumed", "BOX_UNREACHABLE_EVIDENCE_PRESENT",
    async (db) => seed(db, { boxResumeRequestId: "next" })],
  ["billing settlement in flight", "BOX_UNREACHABLE_EVIDENCE_PRESENT",
    async (db) => seed(db, { settlementClaimId: "claim" })],
  ["leaf already terminal", "BOX_UNREACHABLE_SHAPE_INVALID",
    async (db) => seed(db, { boxState: "terminal" })],
  ["finalizing row", "BOX_UNREACHABLE_SHAPE_INVALID", async (db) => {
    await seed(db);
    await db.client.query("UPDATE request_finalize_journal SET state='finalizing' WHERE request_id=$1",
      [LEAF.requestId]);
  }],
  ["unbilled leaf that has usage", "BOX_UNREACHABLE_SHAPE_INVALID", async (db) => {
    await seed(db);
    await db.client.query("INSERT INTO usage_records VALUES ($1,3)", [LEAF.requestId]);
  }],
  ["handoff without usage", "BOX_UNREACHABLE_SHAPE_INVALID", async (db) => {
    await seed(db);
    await db.client.query("DELETE FROM usage_records WHERE request_id=$1", [HANDOFF.requestId]);
  }],
  ["closed state without the operator marker", "BOX_UNREACHABLE_SHAPE_INVALID",
    async (db) => seed(db, { boxState: BOX_UNREACHABLE_CLOSED_STATE })],
  ...([["another ticket", { ticket: "OCV5-1" }], ["a claimed keeper proof", { terminalProof: true }],
    ["a claimed remote cleanup", { remoteCleanup: true }], ["no timestamp", { atMs: undefined }],
    ["an unknown field", { extra: 1 }], ["an active account", { accountStatus: "active" }],
    ["an impossible prior state", { priorBoxState: "terminal" }],
  ] as const).map(([name, patch]): typeof REJECTED[number] =>
    [`closed marker carries ${name}`, "BOX_UNREACHABLE_SHAPE_INVALID", async (db) => seed(db, {
      boxState: BOX_UNREACHABLE_CLOSED_STATE, boxOperatorUnreachableClose: { v: 1,
        ticket: "OCV5-312", atMs: Date.now(), priorBoxState: "unknown",
        accountStatus: "disabled", terminalProof: false, remoteCleanup: false, ...patch } })]),
  ["row missing", "BOX_UNREACHABLE_ROW_MISSING", async (db) => {
    await seed(db);
    await db.client.query("DELETE FROM request_finalize_journal WHERE request_id=$1",
      [LEAF.requestId]);
  }],
];
for (const [name, code, arrange] of REJECTED) {
  test(`rejects all rows when ${name}`, { skip: !testDatabaseUrl }, async () => {
    await withDb(async (db) => {
      await arrange(db);
      const before = await db.snapshot();
      // The valid handoff row is first, so a partial write would be visible.
      await assert.rejects(closeUnreachableBoxRows(db.pool, input(true, [HANDOFF, LEAF])),
        (error: Error & { code?: string }) => error.code === code);
      assert.equal(await db.snapshot(), before);
    });
  });
}

test("input outside the exact identity contract is refused before any query", async () => {
  const pool = { connect: async () => { throw new Error("must not connect"); } };
  for (const bad of [{ ...input(true), runs: [] }, { ...input(true), uid: 0n },
    { ...input(true), ticket: "none" }, { ...input(true), runs: [LEAF, LEAF] },
    { ...input(true), runs: [{ requestId: "x", runNonce: "short" }] }]) {
    await assert.rejects(closeUnreachableBoxRows(pool as never, bad),
      { code: "BOX_UNREACHABLE_INPUT_INVALID" });
  }
});
