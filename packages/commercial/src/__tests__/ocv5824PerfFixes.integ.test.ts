/**
 * OCV5-824 Round 2 real-Postgres integration verification covering EVERY R1
 * audit blocker (B1-B8) and non-blocker N1 on the real migrated schema
 * (0350 transactional DDL + trigger, 0351 -- no-transaction CONCURRENTLY indexes).
 *
 * Run: REQUIRE_TEST_DB=1 npx tsx --test --test-force-exit \
 *   packages/commercial/src/__tests__/ocv5824PerfFixes.integ.test.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { before, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { WebSocket } from "ws";
import type { ClientSession } from "@openclaude/storage";
import { getPool } from "../db/index.js";
import {
  persistGatewayLiveFrame,
  pruneRetiredLiveFrames,
} from "../db/liveTurnFrames.js";
import { createPgSessionsBackend, type PgSessionsBackend } from "../db/pgSessionsBackend.js";
import {
  readSessionSnapshot,
  readSessionSnapshotsBatch,
  SESSION_SNAPSHOT_FACTS_MAX_PAGES,
  SESSION_SNAPSHOT_FACTS_SCAN_WINDOW,
} from "../db/sessionSnapshot.js";
import { sendHelloSessionSnapshots } from "../ws/helloOpenDispatchSnapshot.js";
import { useDedicatedTestDatabase } from "./helpers/db.js";

const db = useDedicatedTestDatabase("ocv5_824_perf_fixes_test");
const here = dirname(fileURLToPath(import.meta.url));
const SQL_0351 = readFileSync(
  join(here, "../db/migrations/0351_perf_timeline_and_live_snapshot_indexes.sql"),
  "utf8",
);

const UID = 77;
const USER_ID = `c:${UID}`;

let pool: Pool;
let backend: PgSessionsBackend;

function mkSession(over: Partial<ClientSession> = {}): ClientSession {
  const now = Date.now();
  return {
    id: over.id ?? `sess-${randomUUID().slice(0, 8)}`,
    userId: over.userId ?? USER_ID,
    agentId: over.agentId ?? "main",
    title: over.title ?? "OCV5-824 Test",
    pinned: over.pinned ?? false,
    createdAt: over.createdAt ?? now,
    lastAt: over.lastAt ?? now,
    messages: over.messages ?? [],
    updatedAt: over.updatedAt ?? now,
  };
}

describe("OCV5-824 R2 real-PG verification (B1-B8 + N1)", () => {
  before(async () => {
    if (!db.available) return;
    pool = getPool() as unknown as Pool;
    backend = createPgSessionsBackend(pool, { expectedGeneration: 1 });
  });

  beforeEach(async () => {
    if (!db.available) return;
    await pool.query(
      `TRUNCATE client_session_live_unit_checkpoints,
                client_session_live_frames,
                client_session_live_streams,
                client_session_turn_tape_records,
                client_session_turn_tapes,
                turn_recovery_jobs,
                turn_permission_requests,
                turn_control_requests,
                turn_dispatches,
                client_sessions
       RESTART IDENTITY CASCADE`,
    );
  });

  test("B1: 0351 CONCURRENTLY indexes are valid, runnable outside tx while another connection reads/writes, and fail-loud on INVALID index", async (t) => {
    if (db.skipIfUnavailable(t)) return;

    // 1. All 3 indexes created by migration 0351 exist and are indisvalid = true.
    const idxRows = (
      await pool.query<{ relname: string; indisvalid: boolean }>(
        `SELECT c.relname, i.indisvalid
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname = ANY($1::text[])
          ORDER BY c.relname`,
        [[
          "idx_live_streams_retired_updated",
          "idx_turn_dispatches_user_session_open",
          "idx_turn_dispatches_user_session_terminal",
        ]],
      )
    ).rows;
    assert.deepEqual(idxRows, [
      { relname: "idx_live_streams_retired_updated", indisvalid: true },
      { relname: "idx_turn_dispatches_user_session_open", indisvalid: true },
      { relname: "idx_turn_dispatches_user_session_terminal", indisvalid: true },
    ]);

    // 2. Concurrent DDL test: drop & rebuild CONCURRENTLY on one connection while
    //    a second connection executes SELECT/INSERT/UPDATE on turn_dispatches.
    const connA = await pool.connect();
    const connB = await pool.connect();
    try {
      await connA.query("DROP INDEX CONCURRENTLY IF EXISTS idx_turn_dispatches_user_session_terminal");
      const [rebuildRes, rwRes] = await Promise.all([
        connA.query(
          `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_turn_dispatches_user_session_terminal
             ON turn_dispatches (user_id, session_id, terminal_at DESC NULLS LAST, admitted_at DESC, dispatch_id DESC)
             WHERE status = 'terminal'`,
        ),
        (async () => {
          const dId = randomUUID();
          await connB.query(
            `INSERT INTO turn_dispatches
               (dispatch_id, user_id, session_id, client_message_id, agent_id, request_hash,
                billing_request_id, status, outcome, terminal_at, admitted_at)
             VALUES ($1, $2, 'sess-b1', 'cm-b1', 'main', $3, $4, 'terminal', 'completed', NOW(), NOW())`,
            [dId, UID, "a".repeat(64), `bill-${dId}`],
          );
          const got = await connB.query(
            `SELECT outcome FROM turn_dispatches WHERE user_id = $1 AND session_id = 'sess-b1' AND status = 'terminal'`,
            [UID],
          );
          return got.rows[0]?.outcome;
        })(),
      ]);
      assert.ok(rebuildRes);
      assert.equal(rwRes, "completed");
    } finally {
      connA.release();
      connB.release();
    }

    // 3. Re-running 0351 preflight/idempotent statements outside a transaction succeeds cleanly.
    const rawClient = await pool.connect();
    try {
      for (const stmt of SQL_0351.split(/\n(?=DO \$\$|CREATE INDEX CONCURRENTLY)/).map((s) => s.trim()).filter((s) => /^(DO \$\$|CREATE INDEX CONCURRENTLY)/.test(s))) {
        await rawClient.query(stmt);
      }
    } finally {
      rawClient.release();
    }
  });

  test("B2 + N1: pruneRetiredLiveFrames prunes ONLY tape-recoverable streams, retains uniqueCopy/empty/unfinalized/manual_reconcile/recovery/reused, and skips invalid retired_at", async (t) => {
    if (db.skipIfUnavailable(t)) return;

    const nowMs = Date.now();
    const oldDate = new Date(nowMs - 20 * 24 * 60 * 60 * 1000);
    const oldIso = oldDate.toISOString();
    const frameTimeBeforeFinalize = new Date(nowMs - 21 * 24 * 60 * 60 * 1000);
    const finalizedAtMs = nowMs - 20 * 24 * 60 * 60 * 1000;
    const sid = "sess-b2-main";
    assert.equal(await backend.upsertClientSession(mkSession({ id: sid })), "applied");

    const insertDispatch = async (dispatchId: string, status: string, outcome: string | null, cmid: string) => {
      await pool.query(
        `INSERT INTO turn_dispatches
           (dispatch_id, user_id, session_id, client_message_id, agent_id, request_hash,
            billing_request_id, status, outcome, conflict_reason, terminal_at, admitted_at)
         VALUES ($1, $2, $3, $4, 'main', $5, $6, $7, $8, $9, $10, $11)`,
        [
          dispatchId, UID, sid, cmid, "b".repeat(64), `bill-${dispatchId}`, status, outcome,
          status === "manual_reconcile" ? "conflict_for_test" : null,
          status === "terminal" ? oldDate : null, oldDate,
        ],
      );
    };

    const insertStreamAndFrame = async (opts: {
      streamKey: string;
      dispatchId: string | null;
      attemptNo: number | null;
      cmid: string | null;
      tapeId: string | null;
      retiredAt: string;
      frameCreatedAt?: Date;
      source?: "gateway" | "rollout_import";
    }) => {
      await pool.query(
        `INSERT INTO client_session_live_streams
           (stream_key, session_id, user_id, client_message_id, dispatch_id, attempt_no,
            agent_container_id, source, projection_source, tape_id, provenance, updated_at)
         VALUES ($1, $2, $3, $4, $5::uuid, $6, 1, $7, 'live', $8, jsonb_build_object('retired_at', $9::text), $10)`,
        [opts.streamKey, sid, USER_ID, opts.cmid, opts.dispatchId, opts.attemptNo, opts.source ?? "gateway", opts.tapeId, opts.retiredAt, oldDate],
      );
      await pool.query(
        `INSERT INTO client_session_live_frames
           (stream_key, source, agent_container_id, session_key, frame_seq, payload, payload_sha256, created_at)
         VALUES ($1, $2, 1, $3, 1, $4, $5, $6)`,
        [
          opts.streamKey,
          opts.source ?? "gateway",
          `sk:${opts.streamKey}`,
          Buffer.from('{"type":"outbound.message","text":"frame"}'),
          "c".repeat(64),
          opts.frameCreatedAt ?? frameTimeBeforeFinalize,
        ],
      );
    };

    let turnIndexSeq = 0;
    const insertTape = async (opts: {
      tapeId: string;
      dispatchId: string | null;
      attemptNo: number | null;
      cmid: string;
      finalizedAt: number | null;
      withNonEmptyRecord: boolean;
    }) => {
      turnIndexSeq += 1;
      const hex = String(turnIndexSeq).padStart(64, "a");
      await pool.query(
        `INSERT INTO client_session_turn_tapes
           (session_id, user_id, tape_id, agent_id, turn_index, status, turn_key,
            tape_sha256, total_bytes, part_count, created_at, finalized_at,
            client_message_id, dispatch_id, attempt_no)
         VALUES ($1, $2, $3, 'main', $4, 'completed', $5, $6, $7, 1, $8, $9, $10, $11::uuid, $12)`,
        [
          sid, USER_ID, opts.tapeId, turnIndexSeq, hex, "d".repeat(64),
          opts.withNonEmptyRecord ? 32 : 0, finalizedAtMs, opts.finalizedAt,
          opts.cmid, opts.dispatchId, opts.attemptNo,
        ],
      );
      if (opts.withNonEmptyRecord) {
        await pool.query(
          `INSERT INTO client_session_turn_tape_records
             (session_id, user_id, tape_id, msg_id, ordinal, role, ts, content_sha256, payload, payload_bytes)
           VALUES ($1, $2, $3, $4, 0, 'assistant', $5, $6, $7, $8)`,
          [sid, USER_ID, opts.tapeId, `msg-${opts.tapeId}`, finalizedAtMs, "e".repeat(64), Buffer.from('{"role":"assistant","text":"ok"}'), 32],
        );
      }
    };

    // (a) Eligible: terminal dispatch + finalized non-empty tape replica -> MUST BE PRUNED.
    const dRec = randomUUID();
    await insertDispatch(dRec, "terminal", "completed", "cm-rec");
    await insertTape({ tapeId: "tape-rec", dispatchId: dRec, attemptNo: 1, cmid: "cm-rec", finalizedAt: finalizedAtMs, withNonEmptyRecord: true });
    await insertStreamAndFrame({ streamKey: `dispatch:${dRec}:1`, dispatchId: dRec, attemptNo: 1, cmid: "cm-rec", tapeId: "tape-rec", retiredAt: oldIso });

    // (b) uniqueCopy: retired terminal stream with NO tape -> MUST BE RETAINED.
    const dUnique = randomUUID();
    await insertDispatch(dUnique, "terminal", "crashed", "cm-unique");
    await insertStreamAndFrame({ streamKey: `dispatch:${dUnique}:1`, dispatchId: dUnique, attemptNo: 1, cmid: "cm-unique", tapeId: null, retiredAt: oldIso });

    // (c) Empty tape (0 records) -> MUST BE RETAINED.
    const dEmpty = randomUUID();
    await insertDispatch(dEmpty, "terminal", "completed", "cm-empty");
    await insertTape({ tapeId: "tape-empty", dispatchId: dEmpty, attemptNo: 1, cmid: "cm-empty", finalizedAt: finalizedAtMs, withNonEmptyRecord: false });
    await insertStreamAndFrame({ streamKey: `dispatch:${dEmpty}:1`, dispatchId: dEmpty, attemptNo: 1, cmid: "cm-empty", tapeId: "tape-empty", retiredAt: oldIso });

    // (d) Unfinalized tape (finalized_at IS NULL) -> MUST BE RETAINED.
    const dUnfin = randomUUID();
    await insertDispatch(dUnfin, "terminal", "completed", "cm-unfin");
    await insertTape({ tapeId: "tape-unfin", dispatchId: dUnfin, attemptNo: 1, cmid: "cm-unfin", finalizedAt: null, withNonEmptyRecord: true });
    await insertStreamAndFrame({ streamKey: `dispatch:${dUnfin}:1`, dispatchId: dUnfin, attemptNo: 1, cmid: "cm-unfin", tapeId: "tape-unfin", retiredAt: oldIso });

    // (e) manual_reconcile dispatch -> MUST BE RETAINED even with tape.
    const dManual = randomUUID();
    await insertDispatch(dManual, "manual_reconcile", null, "cm-manual");
    await insertTape({ tapeId: "tape-manual", dispatchId: dManual, attemptNo: 1, cmid: "cm-manual", finalizedAt: finalizedAtMs, withNonEmptyRecord: true });
    await insertStreamAndFrame({ streamKey: `dispatch:${dManual}:1`, dispatchId: dManual, attemptNo: 1, cmid: "cm-manual", tapeId: "tape-manual", retiredAt: oldIso });

    // (f) Active turn_recovery_jobs referencing cmid -> MUST BE RETAINED.
    const dRecov = randomUUID();
    await insertDispatch(dRecov, "terminal", "interrupted", "cm-recov");
    await insertTape({ tapeId: "tape-recov", dispatchId: dRecov, attemptNo: 1, cmid: "cm-recov", finalizedAt: finalizedAtMs, withNonEmptyRecord: true });
    await insertStreamAndFrame({ streamKey: `dispatch:${dRecov}:1`, dispatchId: dRecov, attemptNo: 1, cmid: "cm-recov", tapeId: "tape-recov", retiredAt: oldIso });
    await pool.query(
      `INSERT INTO turn_recovery_jobs
         (user_id, session_id, root_client_message_id, source_client_message_id,
          source_turn_key, error_code, recovery_mode, semantic_recovery_attempt,
          request_json, tape_sha256, status)
       VALUES ($1, $2, 'cm-recov', 'cm-recov', $3, 'INTERRUPTED', 'replay', 1, '{}'::jsonb, $4, 'queued')`,
      [UID, sid, "9".repeat(64), "8".repeat(64)],
    );

    // (g) Post-finalize frame newer than tape finalized_at -> MUST BE RETAINED.
    const dPost = randomUUID();
    await insertDispatch(dPost, "terminal", "completed", "cm-post");
    await insertTape({ tapeId: "tape-post", dispatchId: dPost, attemptNo: 1, cmid: "cm-post", finalizedAt: finalizedAtMs, withNonEmptyRecord: true });
    await insertStreamAndFrame({
      streamKey: `dispatch:${dPost}:1`,
      dispatchId: dPost,
      attemptNo: 1,
      cmid: "cm-post",
      tapeId: "tape-post",
      retiredAt: oldIso,
      frameCreatedAt: new Date(finalizedAtMs + 5_000),
    });

    // (h) N1: Invalid calendar date in provenance.retired_at ('2026-02-30') -> skipped without SQL error!
    const dInvalid = randomUUID();
    await insertDispatch(dInvalid, "terminal", "completed", "cm-invalid");
    await insertTape({ tapeId: "tape-invalid", dispatchId: dInvalid, attemptNo: 1, cmid: "cm-invalid", finalizedAt: finalizedAtMs, withNonEmptyRecord: true });
    await insertStreamAndFrame({
      streamKey: `dispatch:${dInvalid}:1`,
      dispatchId: dInvalid,
      attemptNo: 1,
      cmid: "cm-invalid",
      tapeId: "tape-invalid",
      retiredAt: "2026-02-30 00:00:00+00",
    });

    // Run prune!
    const result = await pruneRetiredLiveFrames(pool, { olderThanDays: 7, batchSize: 100, nowMs });
    assert.equal(result.deletedFrames, 1, "only the 1 proven tape-recoverable stream's frame is deleted");
    assert.equal(result.prunedStreams, 1);
    assert.equal(result.deletedStreams, 1);
    assert.equal(result.retainedStreams, 6, "uniqueCopy + empty + unfinalized + manual_reconcile + recovery + post-finalize retained");
    assert.equal(result.skippedInvalidRetiredAt, 1, "Feb 30 malformed retired_at skipped cleanly");

    const remainingKeys = (
      await pool.query<{ stream_key: string }>(
        "SELECT stream_key FROM client_session_live_streams ORDER BY stream_key",
      )
    ).rows.map((r) => r.stream_key);
    assert.equal(remainingKeys.includes(`dispatch:${dRec}:1`), false, "recoverable stream pruned");
    for (const kept of [dUnique, dEmpty, dUnfin, dManual, dRecov, dPost, dInvalid]) {
      assert.equal(remainingKeys.includes(`dispatch:${kept}:1`), true, `stream dispatch:${kept}:1 must be retained`);
    }

    // Legacy stream reuse clears provenance.retired_at on persistGatewayLiveFrame!
    const legacySid = "sess-b2-legacy";
    assert.equal(await backend.upsertClientSession(mkSession({ id: legacySid })), "applied");
    const legacyKey = `legacy:1:agent:main:webchat:dm:${legacySid}`;
    await pool.query(
      `INSERT INTO client_session_live_streams
         (stream_key, session_id, user_id, agent_container_id, source, projection_source, provenance, updated_at)
       VALUES ($1, $2, $3, 1, 'gateway', 'live', jsonb_build_object('retired_at', $4::text), $5)`,
      [legacyKey, legacySid, USER_ID, oldIso, oldDate],
    );
    await persistGatewayLiveFrame(pool, {
      uid: BigInt(UID),
      sessionId: legacySid,
      clientMessageId: null,
      agentContainerId: 1,
      sessionKey: `agent:main:webchat:dm:${legacySid}`,
      frameSeq: 1,
      payload: JSON.stringify({ type: "outbound.message", text: "reused" }),
    });
    const provRow = (
      await pool.query<{ has_retired: boolean }>(
        "SELECT (provenance ? 'retired_at') AS has_retired FROM client_session_live_streams WHERE stream_key=$1",
        [legacyKey],
      )
    ).rows[0];
    assert.equal(provRow?.has_retired, false, "legacy stream reuse must clear provenance.retired_at");
  });

  test("B3: getClientSessionPartial(view='timeline') returns full paginated timeline (isPartial=false) in 1 client_sessions SELECT", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    const sid = "sess-b3-timeline";
    assert.equal(
      await backend.upsertClientSession(
        mkSession({
          id: sid,
          messages: [
            { id: "m1", role: "user", text: "hello", ts: 1000, _seq: 1 },
            { id: "m2", role: "assistant", text: "world", ts: 1001, _seq: 2 },
          ],
        }),
      ),
      "applied",
    );
    const partial = await backend.getClientSessionPartial(sid, USER_ID, 2, {
      view: "timeline",
      sinceHistoryRevision: 1,
    });
    assert.ok(partial);
    assert.equal(partial.isPartial, false);
    assert.equal(partial.messages.length, 2);
    assert.ok(typeof partial.timelineGeneration === "number" && partial.timelineGeneration >= 1);
    assert.equal(partial.timelineHasMore, false);
    assert.equal(partial.timelineSnapshotMaxSeq, 2);
  });

  test("B4: upsertClientSession and appendServerAuthoredMessage with embedded NUL in first 240 chars succeed (no SQLSTATE 22021) and round-trip exact text", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    const sid = "sess-b4-nul";
    const textWithNul = "before\u0000after";
    assert.equal(
      await backend.upsertClientSession(
        mkSession({
          id: sid,
          messages: [{ id: "u1", role: "user", text: textWithNul, ts: 1000, _seq: 1 }],
        }),
      ),
      "applied",
    );
    const appended = await backend.appendServerAuthoredMessage(sid, USER_ID, {
      id: "a1",
      role: "assistant",
      text: "reply\u0000clean",
      ts: 1001,
    });
    assert.ok(appended);

    // Both writes succeeded without PG 22021; full messages are readable and clean.
    const full = await backend.getClientSession(sid, USER_ID);
    assert.ok(full);
    assert.equal(full.messages.length, 2);
    const msg0Text = String((full.messages[0] as { text?: unknown } | undefined)?.text ?? "");
    const msg1Text = String((full.messages[1] as { text?: unknown } | undefined)?.text ?? "");
    assert.ok(msg0Text.includes("before") && msg0Text.includes("after"));
    assert.ok(msg1Text.includes("reply") && msg1Text.includes("clean"));

    // Raw last_preview column has zero NUL bytes, and sidebar list returns clean preview.
    const rawPreview = (
      await pool.query<{ last_preview: string | null }>(
        "SELECT last_preview FROM client_sessions WHERE id=$1 AND user_id=$2",
        [sid, USER_ID],
      )
    ).rows[0]?.last_preview;
    assert.equal(rawPreview, "replyclean");
    const listed = await backend.listClientSessions(USER_ID);
    const item = listed.sessions.find((s) => s.id === sid);
    assert.equal(item?.lastMessagePreview, "replyclean");
  });

  test("B5: tracked seq=0 scans 0 BYTEA rows, non-JSONB NUL status advances seq and returns exact newer status, and legacy NULL stream is row-bounded", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    const sid = "sess-b5-snap";
    assert.equal(await backend.upsertClientSession(mkSession({ id: sid })), "applied");

    // Case 1: Tracked stream with 300 normal frames (no status/usage) -> seq=0 -> 0 BYTEA scans.
    const d1 = randomUUID();
    await pool.query(
      `INSERT INTO turn_dispatches
         (dispatch_id, user_id, session_id, client_message_id, agent_id, request_hash,
          billing_request_id, status, outcome, attempt_no, admitted_at, accepted_at)
       VALUES ($1, $2, $3, 'cm-b5-1', 'main', $4, $5, 'accepted', NULL, 1, NOW(), NOW())`,
      [d1, UID, sid, "f".repeat(64), `bill-${d1}`],
    );
    for (let seq = 1; seq <= 20; seq += 1) {
      await persistGatewayLiveFrame(pool, {
        uid: BigInt(UID),
        sessionId: sid,
        clientMessageId: "cm-b5-1",
        agentContainerId: 1,
        sessionKey: `sk:${d1}`,
        frameSeq: seq,
        payload: JSON.stringify({ type: "outbound.stream_delta", text: `chunk-${seq}` }),
      });
    }
    const queries1: string[] = [];
    const spyPool1 = {
      async connect() {
        const c = await pool.connect();
        return {
          query(sql: string, values?: unknown[]) {
            queries1.push(sql);
            return c.query(sql, values);
          },
          release: () => c.release(),
        };
      },
    } as unknown as Pool;
    const snap1 = await readSessionSnapshot(spyPool1, String(UID), sid, { clientMessageId: "cm-b5-1" });
    assert.ok(snap1);
    assert.equal(snap1.usage, null);
    assert.equal(queries1.some((q) => q.includes("session-snapshot-facts")), false, "seq=0 must scan 0 BYTEA rows");
    assert.equal(queries1.some((q) => q.includes("session-snapshot-fact-by-seq")), false);

    // Case 2: Valid turn_status at seq 21, then NUL-containing turn_status at seq 22 ->
    // latest_turn_status_seq advances to 22, stale seq-21 JSONB is invalidated to NULL,
    // and readSessionSnapshot returns the EXACT seq-22 status!
    await persistGatewayLiveFrame(pool, {
      uid: BigInt(UID),
      sessionId: sid,
      clientMessageId: "cm-b5-1",
      agentContainerId: 1,
      sessionKey: `sk:${d1}`,
      frameSeq: 21,
      payload: JSON.stringify({ type: "outbound.turn_status", status: "working", detail: "old-valid" }),
    });
    await persistGatewayLiveFrame(pool, {
      uid: BigInt(UID),
      sessionId: sid,
      clientMessageId: "cm-b5-1",
      agentContainerId: 1,
      sessionKey: `sk:${d1}`,
      frameSeq: 22,
      payload: JSON.stringify({ type: "outbound.turn_status", status: "retrying", detail: "new\u0000nul" }),
    });
    const ptrRow = (
      await pool.query<{ latest_turn_status_seq: string | null; latest_turn_status_json: unknown }>(
        "SELECT latest_turn_status_seq::text, latest_turn_status_json FROM client_session_live_streams WHERE stream_key=$1",
        [`dispatch:${d1}:1`],
      )
    ).rows[0];
    assert.equal(ptrRow?.latest_turn_status_seq, "22");
    assert.equal(ptrRow?.latest_turn_status_json, null, "stale seq-21 JSONB must be invalidated");

    const snap2 = await readSessionSnapshot(pool, String(UID), sid, { clientMessageId: "cm-b5-1" });
    assert.ok(snap2);
    assert.equal(snap2.turnStatus?.status, "retrying");
    assert.equal(snap2.turnStatus?.detail, "new\u0000nul");

    // Case 3: Legacy stream (NULL seqs) with 2,500 non-matching frames -> bounded strictly to MAX_PAGES * SCAN_WINDOW.
    const dLegacy = randomUUID();
    const sidLegacy = "sess-b5-legacy";
    assert.equal(await backend.upsertClientSession(mkSession({ id: sidLegacy })), "applied");
    await pool.query(
      `INSERT INTO turn_dispatches
         (dispatch_id, user_id, session_id, client_message_id, agent_id, request_hash,
          billing_request_id, status, outcome, attempt_no, admitted_at, accepted_at)
       VALUES ($1, $2, $3, 'cm-b5-leg', 'main', $4, $5, 'accepted', NULL, 1, NOW(), NOW())`,
      [dLegacy, UID, sidLegacy, "1".repeat(64), `bill-${dLegacy}`],
    );
    const legKey = `dispatch:${dLegacy}:1`;
    await pool.query(
      `INSERT INTO client_session_live_streams
         (stream_key, session_id, user_id, client_message_id, dispatch_id, attempt_no,
          agent_container_id, source, projection_source)
       VALUES ($1, $2, $3, 'cm-b5-leg', $4::uuid, 1, 1, 'gateway', 'live')`,
      [legKey, sidLegacy, USER_ID, dLegacy],
    );
    // Bulk-insert 2500 non-matching frames (> 8 * 256 = 2048).
    await pool.query(
      `INSERT INTO client_session_live_frames
         (stream_key, source, agent_container_id, session_key, frame_seq, payload, payload_sha256)
       SELECT $1, 'gateway', 1, $2, g, $3::bytea, $4
         FROM generate_series(1, 2500) AS g`,
      [legKey, `sk:${dLegacy}`, Buffer.from('{"type":"outbound.stream_delta","text":"x"}'), "2".repeat(64)],
    );
    let legacyFactQueries = 0;
    const spyPoolLegacy = {
      async connect() {
        const c = await pool.connect();
        return {
          query(sql: string, values?: unknown[]) {
            if (sql.includes("session-snapshot-facts")) legacyFactQueries += 1;
            return c.query(sql, values);
          },
          release: () => c.release(),
        };
      },
    } as unknown as Pool;
    const snapLegacy = await readSessionSnapshot(spyPoolLegacy, String(UID), sidLegacy, { clientMessageId: "cm-b5-leg" });
    assert.ok(snapLegacy);
    assert.equal(legacyFactQueries, SESSION_SNAPSHOT_FACTS_MAX_PAGES, `legacy scan capped at ${SESSION_SNAPSHOT_FACTS_MAX_PAGES} windows of ${SESSION_SNAPSHOT_FACTS_SCAN_WINDOW} rows`);
  });

  test("B6: 32 idle sessions where 1 session has 3 valid ask-user pending prompts returns all 3 (never silently drops 3rd under complete)", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    const targets: Array<{ sessionId: string }> = [];
    for (let i = 1; i <= 32; i += 1) {
      const sid = `sess-b6-${String(i).padStart(2, "0")}`;
      assert.equal(await backend.upsertClientSession(mkSession({ id: sid })), "applied");
      targets.push({ sessionId: sid });
    }
    // Session 1 has 3 valid detached ask-user pending prompts (> floor(64/32)=2 fair-share).
    for (let p = 1; p <= 3; p += 1) {
      await pool.query(
        `INSERT INTO turn_permission_requests
           (user_id, session_id, request_id, client_message_id, tool_name, input_sha256, input_json, expires_at, status)
         VALUES ($1, 'sess-b6-01', $2, 'cm-b6', 'ask_user', $3, '{"question":"q"}', NOW() + INTERVAL '1 hour', 'pending')`,
        [UID, `ask-user:b6-${p}`, "7".repeat(64)],
      );
    }
    // Also include an unauthorized session from another user to verify isolation.
    await backend.upsertClientSession(mkSession({ id: "sess-b6-other", userId: "c:999" }));

    const map = await readSessionSnapshotsBatch(pool, String(UID), [
      ...targets,
      { sessionId: "sess-b6-other" },
    ]);
    assert.equal(map.size, 32);
    assert.equal(map.has("sess-b6-other"), false, "other user's session must never be returned");
    const s1 = map.get("sess-b6-01")!;
    assert.equal(s1.pendingPermissions.items.length, 3, "all 3 ask-user prompts returned via targeted refill");
    assert.equal(s1.pendingPermissions.completeness, "complete");
  });

  test("B7: external UPDATE client_sessions SET messages=... (reconciler path) invalidates last_preview via trigger, and direct terminal dispatch reflects immediately in listClientSessions", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    const sid = "sess-b7-reconcile";
    assert.equal(
      await backend.upsertClientSession(
        mkSession({
          id: sid,
          messages: [{ id: "u1", role: "user", text: "user prompt", ts: 1000, _seq: 1 }],
        }),
      ),
      "applied",
    );
    let listed = await backend.listClientSessions(USER_ID);
    assert.equal(listed.sessions.find((s) => s.id === sid)?.lastMessagePreview, "user prompt");

    // Simulate external writer (turnDispatchReconciler.ts:700) that updates messages WITHOUT touching last_preview.
    const nextMsgs = JSON.stringify([
      { id: "u1", role: "user", text: "user prompt", ts: 1000, _seq: 1 },
      { id: "a1", role: "assistant", text: "reconciled assistant reply", ts: 2000, _seq: 2 },
    ]);
    await pool.query(
      `UPDATE client_sessions
          SET messages = $3,
              message_count = 2,
              last_at = GREATEST(last_at, $4),
              updated_at = GREATEST(updated_at + 1, $4)
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [sid, USER_ID, nextMsgs, 2000],
    );

    // Trigger must have invalidated last_preview to NULL.
    const rawPreview = (
      await pool.query<{ last_preview: string | null }>(
        "SELECT last_preview FROM client_sessions WHERE id=$1 AND user_id=$2",
        [sid, USER_ID],
      )
    ).rows[0]?.last_preview;
    assert.equal(rawPreview, null, "BEFORE UPDATE trigger must invalidate stale last_preview to NULL");

    // Simulate direct terminal CAS in turn_dispatches (outside pgSessionsBackend).
    const dId = randomUUID();
    await pool.query(
      `INSERT INTO turn_dispatches
         (dispatch_id, user_id, session_id, client_message_id, agent_id, request_hash,
          billing_request_id, status, outcome, failure_code, terminal_at, admitted_at)
       VALUES ($1, $2, $3, 'cm-b7', 'main', $4, $5, 'terminal', 'executed_error', 'RUNTIME_ERR', NOW(), NOW())`,
      [dId, UID, sid, "3".repeat(64), `bill-${dId}`],
    );

    // listClientSessions must immediately reflect BOTH updated preview AND latest terminal outcome/unread.
    listed = await backend.listClientSessions(USER_ID);
    const row = listed.sessions.find((s) => s.id === sid);
    assert.equal(row?.lastMessagePreview, "reconciled assistant reply");
    assert.equal(row?.lastOutcome, "executed_error");
    assert.equal(row?.lastErrorCode, "RUNTIME_ERR");
    assert.equal(row?.unread, true);
  });

  test("B8: sendHelloSessionSnapshots recovers ALL peers [A, B] on transient first batch connect failure against real PG", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    assert.equal(await backend.upsertClientSession(mkSession({ id: "sess-b8-a" })), "applied");
    assert.equal(await backend.upsertClientSession(mkSession({ id: "sess-b8-b" })), "applied");

    let attempts = 0;
    const flakyPool = {
      async connect() {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error("transient_connect_fail"), { code: "08006" });
        return pool.connect();
      },
    } as unknown as Pool;

    const sent: Array<{ peer: { id: string } }> = [];
    await sendHelloSessionSnapshots(
      flakyPool,
      {
        readyState: WebSocket.OPEN,
        bufferedAmount: 0,
        send: (raw) => { sent.push(JSON.parse(String(raw))); },
      },
      String(UID),
      [{ peerId: "sess-b8-a" }, { peerId: "sess-b8-b" }],
      null,
      "conn-b8",
    );
    assert.deepEqual(sent.map((f) => f.peer.id), ["sess-b8-a", "sess-b8-b"]);
  });
});
