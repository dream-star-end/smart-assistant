/**
 * OCV5-824: Timeline perf helpers, GET /api/sessions/:id single-read, sidebar
 * listClientSessions last_preview + indexed LATERAL, sessionSnapshot O(1)
 * 3-state seq pointers / scanned-row-bounded legacy fallback / batch single-tx
 * sequential execution & B6 permission quota safety, and 0350/0351 migration
 * contract (all PG-free mock/unit tests).
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
  precomputedTapePayloadBytesSql,
  sanitizePgTextForPreview,
} from "../db/pgTimelinePerf.js";
import {
  buildSessionSnapshot,
  readSessionSnapshotsBatch,
  SESSION_SNAPSHOT_FACTS_MAX_PAGES,
  SESSION_SNAPSHOT_FACTS_SCAN_WINDOW,
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

  test("computeSessionLastPreviewRaw matches SQL tail semantics, strips NUL/lone surrogates (B4), and distinguishes '' from NULL", () => {
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

    // B4: NUL and unpaired UTF-16 surrogates are stripped while preserving valid emoji surrogate pairs.
    assert.equal(sanitizePgTextForPreview("a\u0000b\ud800c\udfffd🚀"), "abcd🚀");
    assert.equal(
      computeSessionLastPreviewRaw([{ role: "user", text: "hello\u0000world\ud800!" }]),
      "helloworld!",
    );
    // Only NUL bytes -> falls back to earlier non-empty message.
    assert.equal(
      computeSessionLastPreviewRaw([
        { role: "user", text: "fallback ok" },
        { role: "assistant", text: "\u0000\u0000   " },
      ]),
      "fallback ok",
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

  test("getClientSessionPartial(view='timeline') preserves full timeline pagination contract (B3) with single client_sessions SELECT", async () => {
    const hot = [
      { id: "u1", role: "user", text: "q", ts: 1000, _seq: 1 },
      {
        id: "t1", role: "assistant", text: "a", ts: 1001, _seq: 2,
        _turnTapeComplete: true, _turnTapeId: "tape-1", _turnTapeSha256: "a".repeat(64),
      },
    ];
    const { pool, sqlCalls } = makeMockPool(hot, { historyRevision: 3, timelineGeneration: 2 });
    const backend = createPgSessionsBackend(pool, { expectedGeneration: 1 });
    const res = await backend.getClientSessionPartial("sess-perf-1", "c:7", 2, {
      view: "timeline",
      sinceHistoryRevision: 3,
    });
    assert.ok(res);
    // B3: Must NEVER emit isPartial:true with messages:[] on view='timeline' (web-react treats timeline partial responses without pagination as unpaginated full replacement).
    assert.equal(res.isPartial, false);
    assert.equal(res.historyRevision, 3);
    assert.equal(res.timelineGeneration, 2);
    assert.equal(res.timelineHasMore, false);
    assert.equal(res.timelineSnapshotMaxSeq, 2);
    const clientSessionSelects = sqlCalls.filter((s) => /FROM client_sessions\b/.test(s));
    assert.equal(clientSessionSelects.length, 1, "still avoids duplicate SELECT on client_sessions");
    assert.equal(sqlCalls.some((s) => s.includes("is_superseded_api_error")), true);
  });

  test("listClientSessions uses precomputed last_preview with authoritative indexed LATERAL (B7)", async () => {
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
    assert.equal(listSql.includes("last_dispatch_summary"), false, "B7: authoritative LATERAL replaces unmaintained summary cache");
    assert.match(listSql, /LEFT JOIN LATERAL/);
    assert.equal(listSql.includes("ROW_NUMBER() OVER"), false, "full-table ROW_NUMBER window scan removed");
  });
});

describe("sessionSnapshot O(1) 3-state pointers, bounded fallback & single-tx batch (mock PG)", () => {
  test("tracked stream with seq=0 (no status/usage emitted) skips BYTEA scan completely (B5)", async () => {
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
              latest_turn_status_json: null,
              latest_turn_usage_json: null,
              latest_turn_status_seq: "0",
              latest_turn_usage_seq: "0",
              frame_seq: "4096",
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

    const snap = await buildSessionSnapshot(client, "3", "s-no-facts");
    assert.ok(snap);
    assert.equal(snap.usage, null);
    assert.equal(sqls.some((s) => s.includes("session-snapshot-facts")), false, "seq=0 must skip BYTEA scan");
    assert.equal(sqls.some((s) => s.includes("session-snapshot-fact-by-seq")), false, "seq=0 must skip exact-seq fetch");
  });

  test("tracked stream with seq>0 + NULL json (non-JSONB payload) fetches exact frame_seq without stale pointer (B5)", async () => {
    const sqls: string[] = [];
    let exactParams: unknown[] = [];
    const client = {
      async query(sql: string, params?: unknown[]) {
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
              latest_turn_status_json: null,
              latest_turn_usage_json: { frameSeq: 9, usage: { totalTokens: 55, inputTokens: 30, outputTokens: 25 } },
              latest_turn_status_seq: "12",
              latest_turn_usage_seq: "9",
              frame_seq: "12",
              created_at: new Date(4000),
            }],
          };
        }
        if (sql.includes("session-snapshot-fact-by-seq")) {
          exactParams = params ?? [];
          return {
            rows: [{
              frame_seq: "12",
              payload: Buffer.from(JSON.stringify({ type: "outbound.turn_status", status: "retrying", detail: "err\u0000x" })),
            }],
          };
        }
        if (sql.includes("open-dispatch-engine-ready")) {
          return { rows: [{ payload: Buffer.from('{"type":"outbound.message"}') }] };
        }
        return { rows: [] };
      },
    } as unknown as PoolClient;

    const snap = await buildSessionSnapshot(client, "3", "s-exact");
    assert.ok(snap);
    assert.equal(snap.turnStatus?.status, "retrying");
    assert.equal(snap.turnStatus?.detail, "err\u0000x");
    assert.equal(snap.usage?.frameSeq, 9);
    assert.deepEqual(exactParams[1], [12]);
    assert.equal(sqls.some((s) => s.includes("session-snapshot-facts")), false, "exact-seq avoids legacy scan");
  });

  test("legacy NULL-seq fallback caps scanned rows via MATERIALIZED frame_seq DESC window and emits explicit gap when budget exhausted", async () => {
    let factPages = 0;
    let factSql = "";
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
              latest_turn_status_seq: null,
              latest_turn_usage_seq: null,
              frame_seq: "99999",
              created_at: new Date(4000),
            }],
          };
        }
        if (sql.includes("session-snapshot-facts")) {
          factPages += 1;
          factSql = sql;
          // Sentinel row: full 256-row window scanned with 0 matching facts and more earlier rows remaining.
          return {
            rows: [{
              record_id: null,
              frame_seq: null,
              payload: null,
              scanned_count: SESSION_SNAPSHOT_FACTS_SCAN_WINDOW,
              has_more_earlier: true,
              min_frame_seq: String(99999 - factPages * SESSION_SNAPSHOT_FACTS_SCAN_WINDOW),
              min_record_id: String(100000 - factPages * SESSION_SNAPSHOT_FACTS_SCAN_WINDOW),
            }],
          };
        }
        return { rows: [] };
      },
    } as unknown as PoolClient;

    const snap = await buildSessionSnapshot(client, "3", "s-legacy-unbounded");
    assert.ok(snap);
    assert.equal(factPages, SESSION_SNAPSHOT_FACTS_MAX_PAGES, "fallback BYTEA scan must be strictly bounded");
    assert.match(factSql, /WITH win_plus AS MATERIALIZED/);
    assert.match(factSql, /ORDER BY frame_seq DESC, record_id DESC/);
    assert.equal(snap.gap?.reason, "sequence_gap", "budget exhaustion with earlier unscanned frames must emit explicit gap");
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

describe("0350 + 0351 migration split contract (B1)", () => {
  test("0350 short DDL + trigger, 0351 -- no-transaction CONCURRENTLY indexes + preflight/postflight, rollbacks & metadata aligned", () => {
    const mig350 = readFileSync(
      join(here, "../db/migrations/0350_perf_timeline_and_live_snapshot.sql"),
      "utf8",
    );
    const rb350 = readFileSync(
      join(here, "../db/rollbacks/0350_perf_timeline_and_live_snapshot.sql"),
      "utf8",
    );
    const mig351 = readFileSync(
      join(here, "../db/migrations/0351_perf_timeline_and_live_snapshot_indexes.sql"),
      "utf8",
    );
    const rb351 = readFileSync(
      join(here, "../db/rollbacks/0351_perf_timeline_and_live_snapshot_indexes.sql"),
      "utf8",
    );
    const meta = JSON.parse(
      readFileSync(join(here, "../../../../deploy/v5/release-metadata.json"), "utf8"),
    ) as { requiredMigrations: string[] };

    assert.match(mig350, /^-- order-dependency: 0349_user_site_collaborators/m);
    assert.match(mig350, /SET LOCAL lock_timeout = '5s';/);
    const mig350NonComments = mig350.replace(/^--.*$/gm, "");
    assert.equal(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(mig350NonComments), false, "B1: 0350 must NOT execute CREATE INDEX");
    assert.equal(mig350.includes("last_dispatch_summary"), false, "B7: dropped unmaintained summary column");
    assert.match(mig350, /trg_client_sessions_invalidate_last_preview/);
    assert.match(rb350, /trg_client_sessions_invalidate_last_preview/);
    for (const col of [
      "payload_bytes",
      "visible_payload_bytes",
      "is_superseded_api_error",
      "last_preview",
      "latest_turn_status_json",
      "latest_turn_usage_json",
      "latest_turn_status_seq",
      "latest_turn_usage_seq",
    ]) {
      assert.ok(mig350.includes(col), `0350 missing ${col}`);
      assert.ok(rb350.includes(col), `0350 rollback missing ${col}`);
    }

    assert.match(mig351, /^-- no-transaction/m);
    assert.match(mig351, /^-- order-dependency: 0350_perf_timeline_and_live_snapshot/m);
    assert.match(mig351, /NOT\s+i\.indisvalid|indisvalid\s*=\s*false/i, "B1: preflight must fail loud on INVALID indexes");
    assert.match(mig351, /i\.indisvalid\b/i, "B1: postflight must verify VALID indexes");
    for (const idx of [
      "idx_turn_dispatches_user_session_terminal",
      "idx_turn_dispatches_user_session_open",
      "idx_live_streams_retired_updated",
      "idx_live_frames_stream_frame_seq",
    ]) {
      assert.ok(mig351.includes(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${idx}`), `0351 missing CONCURRENTLY ${idx}`);
      assert.ok(rb351.includes(`DROP INDEX CONCURRENTLY IF EXISTS ${idx}`), `0351 rollback missing ${idx}`);
    }

    assert.ok(meta.requiredMigrations.includes("0350_perf_timeline_and_live_snapshot"));
    assert.ok(meta.requiredMigrations.includes("0351_perf_timeline_and_live_snapshot_indexes"));
  });
});
