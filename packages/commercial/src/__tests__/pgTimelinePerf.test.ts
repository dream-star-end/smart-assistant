/**
 * OCV5-824: Timeline perf helpers, GET /api/sessions/:id single-read & true
 * incremental ?since=, sidebar listClientSessions short-circuit, sessionSnapshot
 * O(1) pointers / bounded fallback / batch single-tx sequential execution, and
 * migration 0350 contract (all PG-free mock/unit tests).
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/pgTimelinePerf.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import { createPgSessionsBackend } from "../db/pgSessionsBackend.js";
import {
  computeSessionLastPreviewRaw,
  computeSupersededApiErrorFlags,
  evaluateTimelinePartialFastPath,
  precomputedTapePayloadBytesSql,
  serializeLastDispatchSummary,
} from "../db/pgTimelinePerf.js";
import {
  buildSessionSnapshot,
  readSessionSnapshotsBatch,
  SESSION_SNAPSHOT_FACTS_MAX_PAGES,
} from "../db/sessionSnapshot.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("pgTimelinePerf pure helpers (OCV5-824)", () => {
  test("computeSupersededApiErrorFlags marks only superseded assistant API errors", () => {
    const records = [
      { role: "user" },
      { role: "assistant" }, // ordinal 1: API Error, superseded by ordinal 3
      { role: "tool" },
      { role: "assistant" }, // ordinal 3: API Error, superseded by ordinal 4
      { role: "assistant" }, // ordinal 4: final answer
    ];
    const sidecars = [
      [{ role: "user", semanticText: "hello" }],
      [{ role: "assistant", semanticText: "API Error: 529 overloaded" }],
      [{ role: "tool", semanticText: "API Error: not an assistant" }],
      [{ role: "assistant", semanticText: "API Error: 500 transient" }],
      [{ role: "assistant", semanticText: "Recovered answer" }],
    ];
    assert.deepEqual(computeSupersededApiErrorFlags(records, sidecars), [
      false,
      true,
      false,
      true,
      false,
    ]);

    // Terminal API Error (no later assistant record) MUST remain visible (false).
    const terminalFail = computeSupersededApiErrorFlags(
      [{ role: "user" }, { role: "assistant" }, { role: "assistant" }],
      [
        [{ role: "user", semanticText: "hi" }],
        [{ role: "assistant", semanticText: "API Error: attempt 1" }],
        [{ role: "assistant", semanticText: "API Error: terminal failure" }],
      ],
    );
    assert.deepEqual(terminalFail, [false, true, false]);
  });

  test("computeSessionLastPreviewRaw matches SQL tail semantics and distinguishes '' from NULL", () => {
    assert.equal(computeSessionLastPreviewRaw([]), "");
    assert.equal(computeSessionLastPreviewRaw([{ role: "assistant", text: "   " }]), "");
    assert.equal(
      computeSessionLastPreviewRaw([
        { role: "user", text: "earlier prompt" },
        { role: "assistant", text: "  " },
      ]),
      "earlier prompt",
    );
    const longText = "x".repeat(300);
    assert.equal(computeSessionLastPreviewRaw([{ role: "assistant", text: `  ${longText}  ` }]).length, 240);
    // Message beyond LAST_MESSAGE_PREVIEW_TAIL_MAX (20) is ignored.
    const olderPlus20Empty = [
      { role: "user", text: "too old" },
      ...Array.from({ length: 20 }, () => ({ role: "assistant", text: "" })),
    ];
    assert.equal(computeSessionLastPreviewRaw(olderPlus20Empty), "");
  });

  test("evaluateTimelinePartialFastPath enforces strict revision/generation/seq safety", () => {
    assert.deepEqual(
      evaluateTimelinePartialFastPath({
        sinceSeq: 12,
        sinceHistoryRevision: 5,
        sinceTimelineGeneration: 2,
        historyRevision: 5,
        timelineGeneration: 2,
        snapshotMaxSeq: 12,
        anyMissingSeq: false,
        hotCount: 10,
      }),
      { hit: true, snapshotMaxSeq: 12, hotCount: 10 },
    );

    // Revision jump -> fallback full
    assert.deepEqual(
      evaluateTimelinePartialFastPath({
        sinceSeq: 12,
        sinceHistoryRevision: 4,
        historyRevision: 5,
        timelineGeneration: 2,
        snapshotMaxSeq: 12,
        anyMissingSeq: false,
        hotCount: 10,
      }),
      { hit: false, reason: "revision_mismatch" },
    );

    // Timeline generation mismatch -> fallback full
    assert.deepEqual(
      evaluateTimelinePartialFastPath({
        sinceSeq: 12,
        sinceHistoryRevision: 5,
        sinceTimelineGeneration: 1,
        historyRevision: 5,
        timelineGeneration: 2,
        snapshotMaxSeq: 12,
        anyMissingSeq: false,
        hotCount: 10,
      }),
      { hit: false, reason: "generation_mismatch" },
    );

    // Newer messages exist -> fallback full
    assert.deepEqual(
      evaluateTimelinePartialFastPath({
        sinceSeq: 10,
        sinceHistoryRevision: 5,
        historyRevision: 5,
        timelineGeneration: 2,
        snapshotMaxSeq: 12,
        anyMissingSeq: false,
        hotCount: 10,
      }),
      { hit: false, reason: "newer_messages" },
    );

    // Out-of-order cursor ahead of server -> fallback full
    assert.deepEqual(
      evaluateTimelinePartialFastPath({
        sinceSeq: 15,
        sinceHistoryRevision: 5,
        historyRevision: 5,
        timelineGeneration: 2,
        snapshotMaxSeq: 12,
        anyMissingSeq: false,
        hotCount: 10,
      }),
      { hit: false, reason: "cursor_ahead" },
    );

    // Legacy row missing _seq -> fallback full
    assert.deepEqual(
      evaluateTimelinePartialFastPath({
        sinceSeq: 12,
        sinceHistoryRevision: 5,
        historyRevision: 5,
        timelineGeneration: 2,
        snapshotMaxSeq: 12,
        anyMissingSeq: true,
        hotCount: 10,
      }),
      { hit: false, reason: "missing_seq" },
    );
  });

  test("serializeLastDispatchSummary produces compact JSON or null", () => {
    assert.equal(serializeLastDispatchSummary({ outcome: null, failureCode: null, terminalAtMs: 1000 }), null);
    assert.deepEqual(
      JSON.parse(serializeLastDispatchSummary({ outcome: "completed", failureCode: null, terminalAtMs: 1700000000123.9 })!),
      { outcome: "completed", failureCode: null, terminalAtMs: 1700000000123 },
    );
    assert.match(precomputedTapePayloadBytesSql("r"), /COALESCE\(r\.visible_payload_bytes/);
  });
});

describe("pgSessionsBackend timeline & sidebar perf paths (mock PG)", () => {
  function makeMockPool(hotMessages: unknown[], overrides?: { historyRevision?: number; timelineGeneration?: number }) {
    const sqlCalls: string[] = [];
    const sessionRow = {
      id: "sess-perf-1",
      user_id: "c:7",
      agent_id: "main",
      title: "Perf Test",
      pinned: 0,
      created_at: "1000",
      last_at: "2000",
      messages: JSON.stringify(hotMessages),
      updated_at: "2000",
      archived_through_seq: 0,
      archived_count: "0",
      history_revision: String(overrides?.historyRevision ?? 3),
      timeline_generation: String(overrides?.timelineGeneration ?? 2),
      model_id: null,
    };
    const handleQuery = async (sql: string) => {
      sqlCalls.push(sql);
      if (sql.includes("FROM client_sessions cs")) return { rows: [sessionRow], rowCount: 1 };
      if (sql.includes("FROM client_sessions")) return { rows: [sessionRow], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    const pool = {
      query: handleQuery,
      async connect() {
        return {
          query: handleQuery,
          release() {},
        };
      },
    } as unknown as Pool;
    return { pool, sqlCalls };
  }

  test("getClientSession(view='timeline') queries client_sessions only ONCE (no duplicate SELECT)", async () => {
    const { pool, sqlCalls } = makeMockPool([
      { id: "m1", role: "user", text: "hi", ts: 1000, _seq: 1 },
      { id: "m2", role: "assistant", text: "hello", ts: 1001, _seq: 2 },
    ]);
    const backend = createPgSessionsBackend(pool, { expectedGeneration: 1 });
    const session = await backend.getClientSession("sess-perf-1", "c:7", { view: "timeline" });
    assert.ok(session);
    assert.equal(session.messages.length, 2);
    const clientSessionSelects = sqlCalls.filter((s) => /FROM client_sessions\b/.test(s));
    assert.equal(clientSessionSelects.length, 1, "must not re-SELECT client_sessions inside readClientTimelinePageImpl");
  });

  test("getClientSessionPartial(view='timeline') fast-returns empty delta isPartial:true on unchanged revision+seq and falls back safely on mismatch", async () => {
    const hot = [
      {
        id: "u1", role: "user", text: "q", ts: 1000, _seq: 1,
      },
      {
        id: "t1", role: "assistant", text: "a", ts: 1001, _seq: 2,
        _turnTapeComplete: true, _turnTapeId: "tape-1", _turnTapeSha256: "a".repeat(64),
      },
    ];
    // Fast-path hit: sinceSeq === 2, sinceHistoryRevision === 3
    {
      const { pool, sqlCalls } = makeMockPool(hot, { historyRevision: 3, timelineGeneration: 2 });
      const backend = createPgSessionsBackend(pool, { expectedGeneration: 1 });
      const res = await backend.getClientSessionPartial("sess-perf-1", "c:7", 2, {
        view: "timeline",
        sinceHistoryRevision: 3,
      });
      assert.ok(res);
      assert.equal(res.isPartial, true);
      assert.deepEqual(res.messages, []);
      assert.equal(res.maxSeq, 2);
      assert.equal(res.historyRevision, 3);
      // Must NOT emit timelineGeneration/timelineCursor on empty partial delta (preserves client pagination cursor).
      assert.equal(res.timelineGeneration, undefined);
      assert.equal(res.timelineCursor, undefined);
      // Zero tape queries executed!
      assert.equal(sqlCalls.some((s) => s.includes("client_session_turn_tapes")), false);
      assert.equal(sqlCalls.some((s) => s.includes("client_session_turn_tape_records")), false);
    }

    // Revision mismatch -> safe fallback to full page (isPartial: false), still only 1 client_sessions SELECT!
    {
      const { pool, sqlCalls } = makeMockPool(hot, { historyRevision: 4, timelineGeneration: 2 });
      const backend = createPgSessionsBackend(pool, { expectedGeneration: 1 });
      const res = await backend.getClientSessionPartial("sess-perf-1", "c:7", 2, {
        view: "timeline",
        sinceHistoryRevision: 3,
      });
      assert.ok(res);
      assert.equal(res.isPartial, false);
      assert.equal(res.historyRevision, 4);
      assert.equal(res.timelineGeneration, 2);
      const clientSessionSelects = sqlCalls.filter((s) => /FROM client_sessions\b/.test(s));
      assert.equal(clientSessionSelects.length, 1);
      assert.equal(sqlCalls.some((s) => s.includes("is_superseded_api_error")), true);
    }

    // Out-of-order cursor ahead (sinceSeq > snapshotMaxSeq) -> safe fallback to full page
    {
      const { pool } = makeMockPool(hot, { historyRevision: 3, timelineGeneration: 2 });
      const backend = createPgSessionsBackend(pool, { expectedGeneration: 1 });
      const res = await backend.getClientSessionPartial("sess-perf-1", "c:7", 99, {
        view: "timeline",
        sinceHistoryRevision: 3,
      });
      assert.ok(res);
      assert.equal(res.isPartial, false);
    }
  });

  test("listClientSessions uses precomputed last_preview / last_dispatch_summary with LATERAL fallback", async () => {
    let listSql = "";
    const pool = {
      async query(sql: string) {
        listSql = sql;
        return {
          rows: [{
            id: "s1",
            agent_id: "main",
            title: "T",
            pinned: 0,
            created_at: "100",
            last_at: "200",
            updated_at: "200",
            msg_count: 2,
            model_id: null,
            project_id: null,
            archived_at: null,
            last_preview_raw: "cached preview",
            run_state: "idle",
            last_outcome: "completed",
            last_error_code: null,
            unread: true,
          }],
        };
      },
    } as unknown as Pool;
    const backend = createPgSessionsBackend(pool, { expectedGeneration: 1 });
    const out = await backend.listClientSessions("c:7", { limit: 20 });
    assert.equal(out.sessions.length, 1);
    assert.equal(out.sessions[0]?.lastMessagePreview, "cached preview");
    assert.equal(out.sessions[0]?.lastOutcome, "completed");
    assert.equal(out.sessions[0]?.unread, true);
    assert.match(listSql, /WHEN cs\.last_preview IS NOT NULL THEN cs\.last_preview/);
    assert.match(listSql, /cs\.last_dispatch_summary/);
    assert.match(listSql, /LEFT JOIN LATERAL/);
    assert.equal(listSql.includes("ROW_NUMBER() OVER"), false, "full-table ROW_NUMBER window scan removed");
  });
});

describe("sessionSnapshot O(1) pointers, bounded fallback & single-tx batch (mock PG)", () => {
  test("O(1) pointer columns skip session-snapshot-facts BYTEA scan and omit recovery SAVEPOINT", async () => {
    const sqls: string[] = [];
    const client = {
      async query(sql: string) {
        sqls.push(sql);
        if (sql.includes("session-snapshot-owner")) return { rows: [{ as_of: "5000" }] };
        if (sql.includes("session-snapshot-dispatch")) {
          return {
            rows: [{
              dispatch_id: "00000000-0000-4000-8000-000000000001",
              client_message_id: "cm-1",
              agent_id: "main",
              status: "accepted",
              outcome: null,
              attempt_no: 1,
              admitted_at: new Date(1000),
              accepted_at: new Date(2000),
              terminal_at: null,
            }],
          };
        }
        if (sql.includes("session-snapshot-watermark")) {
          return {
            rows: [{
              projection_source: "live",
              provenance: {},
              latest_turn_status_json: { frameSeq: 10, type: "outbound.turn_status", status: "working", detail: "tool" },
              latest_turn_usage_json: { frameSeq: 9, usage: { totalTokens: 55, inputTokens: 30, outputTokens: 25 } },
              frame_seq: "10",
              created_at: new Date(4000),
            }],
          };
        }
        if (sql.includes("open-dispatch-engine-ready")) {
          return { rows: [{ payload: Buffer.from('{"type":"outbound.message"}') }] };
        }
        return { rows: [] };
      },
    } as unknown as PoolClient;

    const snap = await buildSessionSnapshot(client, "3", "s-1");
    assert.ok(snap);
    assert.equal(snap.turnStatus?.status, "working");
    assert.equal(snap.turnStatus?.detail, "tool");
    assert.equal(snap.usage?.frameSeq, 9);
    assert.equal(snap.usage?.usage.totalTokens, 55);
    assert.equal(sqls.some((s) => s.includes("session-snapshot-facts")), false, "must skip BYTEA scan");
    assert.equal(sqls.some((s) => s.includes("SAVEPOINT session_snapshot_recovery")), false, "no recovery SAVEPOINT");
  });

  test("legacy NULL pointer fallback caps BYTEA fact scan at SESSION_SNAPSHOT_FACTS_MAX_PAGES", async () => {
    let factPages = 0;
    const client = {
      async query(sql: string) {
        if (sql.includes("session-snapshot-owner")) return { rows: [{ as_of: "5000" }] };
        if (sql.includes("session-snapshot-dispatch")) {
          return {
            rows: [{
              dispatch_id: "00000000-0000-4000-8000-000000000001",
              client_message_id: "cm-1",
              agent_id: "main",
              status: "accepted",
              outcome: null,
              attempt_no: 1,
              admitted_at: new Date(1000),
              accepted_at: new Date(2000),
              terminal_at: null,
            }],
          };
        }
        if (sql.includes("session-snapshot-watermark")) {
          return {
            rows: [{
              projection_source: "live",
              provenance: {},
              latest_turn_status_json: null,
              latest_turn_usage_json: null,
              frame_seq: "99999",
              created_at: new Date(4000),
            }],
          };
        }
        if (sql.includes("session-snapshot-facts")) {
          factPages += 1;
          // Always return 64 false-positive rows (nested turn_usage) to try to trigger an unbounded loop.
          return {
            rows: Array.from({ length: 64 }, (_, i) => ({
              record_id: String(10000 - factPages * 64 - i),
              frame_seq: String(10000 - factPages * 64 - i),
              payload: Buffer.from('{"type":"outbound.message","nested":{"type":"outbound.turn_usage"}}'),
            })),
          };
        }
        return { rows: [] };
      },
    } as unknown as PoolClient;

    const snap = await buildSessionSnapshot(client, "3", "s-unbounded");
    assert.ok(snap);
    assert.equal(factPages, SESSION_SNAPSHOT_FACTS_MAX_PAGES, "fallback BYTEA scan must be strictly bounded");
  });

  test("readSessionSnapshotsBatch executes strictly sequentially in 1 tx and releases on error", async () => {
    let connects = 0;
    let releases = 0;
    let activeOnClient = 0;
    let maxConcurrentOnClient = 0;
    const pool = {
      async connect() {
        connects += 1;
        return {
          async query(sql: string, params?: unknown[]) {
            activeOnClient += 1;
            if (activeOnClient > maxConcurrentOnClient) maxConcurrentOnClient = activeOnClient;
            await Promise.resolve();
            try {
              if (sql.includes("session-snapshot-batch-owner")) {
                const ids = (params?.[1] as string[]) ?? [];
                return { rows: ids.map((id) => ({ session_id: id, as_of: "9000" })) };
              }
              if (sql.includes("session-snapshot-batch-container-cursor")) {
                return { rows: [{ session_id: "s-1", agent_container_id: "700" }] };
              }
              return { rows: [] };
            } finally {
              activeOnClient -= 1;
            }
          },
          release() {
            releases += 1;
          },
        };
      },
    } as unknown as Pool;

    const targets = Array.from({ length: 20 }, (_, i) => ({
      sessionId: `s-${i + 1}`,
      options: { afterSeq: 10 },
    }));
    const map = await readSessionSnapshotsBatch(pool, "3", targets, { containerId: 700 });
    assert.equal(map.size, 20);
    assert.equal(connects, 1);
    assert.equal(releases, 1);
    assert.equal(maxConcurrentOnClient, 1, "NEVER run concurrent Promise.all queries on one pg.PoolClient");
    assert.equal(map.get("s-1")?.gap, null, "same container -> no cursor_reset");
    assert.deepEqual(map.get("s-2")?.gap, { reason: "cursor_reset" }, "missing/different container -> cursor_reset");

    // Error path must ROLLBACK and release the PoolClient.
    let rolledBack = false;
    let errorReleased = false;
    const failingPool = {
      async connect() {
        return {
          async query(sql: string) {
            if (sql === "ROLLBACK") rolledBack = true;
            if (sql.includes("session-snapshot-batch-owner")) throw new Error("boom");
            return { rows: [] };
          },
          release() {
            errorReleased = true;
          },
        };
      },
    } as unknown as Pool;
    await assert.rejects(readSessionSnapshotsBatch(failingPool, "3", [{ sessionId: "s-1" }]), /boom/);
    assert.equal(rolledBack, true);
    assert.equal(errorReleased, true);
  });
});

describe("0350_perf_timeline_and_live_snapshot migration contract", () => {
  test("migration, rollback, and release-metadata.json stay aligned", () => {
    const mig = readFileSync(
      join(here, "../db/migrations/0350_perf_timeline_and_live_snapshot.sql"),
      "utf8",
    );
    const rb = readFileSync(
      join(here, "../db/rollbacks/0350_perf_timeline_and_live_snapshot.sql"),
      "utf8",
    );
    const meta = JSON.parse(
      readFileSync(join(here, "../../../../deploy/v5/release-metadata.json"), "utf8"),
    ) as { requiredMigrations: string[] };

    assert.match(mig, /^-- order-dependency: 0349_user_site_collaborators/m);
    for (const col of [
      "payload_bytes",
      "visible_payload_bytes",
      "is_superseded_api_error",
      "last_preview",
      "last_dispatch_summary",
      "latest_turn_status_json",
      "latest_turn_usage_json",
    ]) {
      assert.ok(mig.includes(col), `migration missing ${col}`);
      assert.ok(rb.includes(col), `rollback missing ${col}`);
    }
    assert.ok(meta.requiredMigrations.includes("0350_perf_timeline_and_live_snapshot"));
  });
});
