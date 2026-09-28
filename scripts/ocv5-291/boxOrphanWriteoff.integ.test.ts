import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { runOrphanWriteoff } from "./boxOrphanWriteoff.js";

const root = "a317076592979b517ba71abe492bad22";
const leaf = "91da5d7643ecdc67b30f476b4449072a";
const environment = {
  OC_USER_ID: "3", OC_SESSION_KEY: "agent:main:webchat:dm:webmuehg8n99a9p4i",
  OCV5_291_TICKET: "OCV5-291", OCV5_291_EXPECT_ROOT: root,
  OCV5_291_EXPECT_LEAF: leaf,
  OCV5_291_EXPECT_RUN_NONCE: "2892e254b7cff66b38a0e54f",
  OCV5_291_EXPECT_LEASE_EPOCH: "38ac2b0f25ad98156d558f3191c60fb1",
  OCV5_291_EXPECT_BOX_SESSION_ID: "4cdb42f1-e3f9-4347-acac-cf327eee08d3",
  OCV5_291_EXPECT_TURN_KEY:
    "1e4f9a2ded21ca1f2a1f6ba7709eb6adab9eca45fa753ebb7922dd4d7df70c41",
  OCV5_291_EXPECT_OLD_CONTAINER: "521", OCV5_291_EXPECT_CURRENT_CONTAINER: "526",
  OCV5_291_EXPECT_SPOOL_SHA256:
    "93f12b4a764ff7faec2cfb5f56d28613e8b942c673b4cd38e950be2ee3f2f926",
  OCV5_291_EXPECT_EVIDENCE_SHA256: createHash("sha256")
    .update(readFileSync(new URL("./boxOrphanEvidence.json", import.meta.url)))
    .digest("hex"),
  OCV5_291_EXCEPTION_RELEASE_ACK: "1",
  OCV5_291_APPROVAL_REF:
    "agent:main:webchat:dm:webmuehg8n99a9p4i:20260928T0429Z:box_no_current_proof",
};

test("orphan exception atomically releases only two TEMP rows without user debit",
  { skip: !process.env.OCV5_291_JOURNAL_TEST_DATABASE_URL }, async () => {
    const pool = new Pool({ connectionString: process.env.OCV5_291_JOURNAL_TEST_DATABASE_URL,
      max: 1 });
    const client = await pool.connect();
    const old = Object.fromEntries(Object.keys(environment)
      .map((key) => [key, process.env[key]]));
    Object.assign(process.env, environment);
    try {
      for (const table of ["request_finalize_journal", "agent_containers",
        "usage_records", "credit_ledger"]) {
        await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
      }
      await client.query(`INSERT INTO pg_temp.request_finalize_journal
        SELECT * FROM public.request_finalize_journal WHERE request_id=ANY($1::text[])`,
      [[root, leaf]]);
      await client.query(`INSERT INTO pg_temp.agent_containers
        SELECT * FROM public.agent_containers WHERE id IN (521,526)`);
      await client.query(`INSERT INTO pg_temp.usage_records
        SELECT * FROM public.usage_records WHERE request_id=ANY($1::text[])`,
      [[root, leaf]]);
      await client.query(`INSERT INTO pg_temp.credit_ledger
        SELECT * FROM public.credit_ledger WHERE ref_type='usage_record'
        AND ref_id IN ('20474','20475')`);
      await client.query("SET search_path TO pg_temp");
      const boundQuery = (sql: string, params?: unknown[]) => {
        assert.doesNotMatch(sql, /\bpublic\.|\b(?:SET|RESET)\s+(?:LOCAL\s+)?search_path\b/i);
        return client.query(sql, params);
      };
      const sameConnection = { query: boundQuery,
        connect: async () => ({ query: boundQuery, release() {} }) } as unknown as Pool;
      const before = await client.query<{ request_id: string; ctx: Record<string, unknown> }>(
        "SELECT request_id,ctx FROM request_finalize_journal ORDER BY request_id");
      const dry = await runOrphanWriteoff(sameConnection, "--dry-run");
      assert.equal(dry.mode, "dry_run");
      assert.equal(dry.writeOffFen, "10");
      assert.equal(dry.walletWrites, 0);
      const afterDry = await client.query(
        "SELECT request_id,ctx FROM request_finalize_journal ORDER BY request_id");
      assert.deepEqual(afterDry.rows, before.rows);
      const originalSession = process.env.OC_SESSION_KEY;
      process.env.OC_SESSION_KEY = "agent:main:webchat:dm:other";
      await assert.rejects(() => runOrphanWriteoff(sameConnection, "--dry-run"),
        /BOX_ORPHAN_SELFHOST_BOUNDARY_INVALID/);
      process.env.OC_SESSION_KEY = originalSession;
      const originalApproval = process.env.OCV5_291_APPROVAL_REF;
      process.env.OCV5_291_APPROVAL_REF = "wrong-approval";
      await assert.rejects(() => runOrphanWriteoff(sameConnection, "--release"),
        /BOX_ORPHAN_APPROVAL_REQUIRED/);
      process.env.OCV5_291_APPROVAL_REF = originalApproval;
      await client.query(`CREATE FUNCTION pg_temp.reject_leaf_once() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_id='${leaf}' THEN
          RAISE EXCEPTION 'synthetic leaf CAS failure'; END IF; RETURN NEW; END $$`);
      await client.query(`CREATE TRIGGER reject_leaf BEFORE UPDATE
        ON pg_temp.request_finalize_journal FOR EACH ROW
        EXECUTE FUNCTION pg_temp.reject_leaf_once()`);
      await assert.rejects(() => runOrphanWriteoff(sameConnection, "--release"),
        /synthetic leaf CAS failure/);
      const afterRollback = await client.query(
        "SELECT request_id,ctx FROM request_finalize_journal ORDER BY request_id");
      assert.deepEqual(afterRollback.rows, before.rows);
      await client.query("DROP TRIGGER reject_leaf ON pg_temp.request_finalize_journal");
      const result = await runOrphanWriteoff(sameConnection, "--release");
      assert.equal(result.status, "exception_closed");
      assert.equal(result.walletWrites, 0);
      const terminal = await client.query<{ request_id: string; state: string;
        ctx: Record<string, unknown> }>(
        "SELECT request_id,state,ctx FROM request_finalize_journal ORDER BY request_id");
      assert.equal(terminal.rows.length, 2);
      for (const row of terminal.rows) {
        assert.equal(row.state, "committed");
        assert.equal(row.ctx.boxState, "orphan_exception_closed");
        assert.equal(row.ctx.boxRemoteCleanup, "unverified");
        assert.equal(row.ctx.boxRemotePrivacy, "unknown");
        assert.equal(row.ctx.boxTerminalProof, undefined);
        assert.equal(row.ctx.boxUsage, undefined);
        assert.equal(row.ctx.boxToolHandoff, undefined);
        assert.equal(row.ctx.boxReplayMessage, undefined);
        assert.match(String(row.ctx.boxReplayFingerprint), /^[a-f0-9]{64}$/);
        assert.match(String(row.ctx.boxFallbackAlias), /^[a-f0-9]{64}$/);
        const audit = row.ctx.boxOrphanException as Record<string, unknown>;
        assert.equal(audit.writeOffFen, "10");
        assert.equal(audit.userDebitFen, "0");
        assert.equal(audit.currentRemoteProof, "unavailable");
      }
      const again = await runOrphanWriteoff(sameConnection, "--release");
      assert.equal(again.status, "already_closed");
      const usage = await client.query("SELECT request_id,cost_credits FROM usage_records ORDER BY request_id");
      assert.deepEqual(usage.rows.map((row) => String(row.cost_credits)), ["4", "5"]);
      const ledger = await client.query("SELECT count(*)::int AS n FROM credit_ledger");
      assert.equal(ledger.rows[0]?.n, 2);
    } finally {
      for (const [key, value] of Object.entries(old)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      client.release(); await pool.end();
    }
  });
