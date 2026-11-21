/**
 * OCV5-824: pruneRetiredLiveFrames (B2 + N1) + live stream fact pointer
 * extraction/persistence (B5) — PG-free unit tests.
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/liveTurnFrames.pruneRetired.test.ts
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Pool } from "pg";
import {
  DEFAULT_RETIRED_PRUNE_OLDER_THAN_DAYS,
  extractSafeLiveStreamFactPointers,
  parseStrictRetiredAtMs,
  persistGatewayLiveFrame,
  pruneRetiredLiveFrames,
} from "../db/liveTurnFrames.js";

describe("parseStrictRetiredAtMs (OCV5-824 N1)", () => {
  test("accepts valid ISO-8601 and PG NOW()::text timestamps", () => {
    assert.equal(parseStrictRetiredAtMs("2026-01-15T12:30:45.123Z"), Date.UTC(2026, 0, 15, 12, 30, 45, 123));
    assert.equal(parseStrictRetiredAtMs("2026-01-15 12:30:45+00"), Date.UTC(2026, 0, 15, 12, 30, 45));
    assert.equal(parseStrictRetiredAtMs("2026-01-15 20:30:45.5+08:00"), Date.UTC(2026, 0, 15, 12, 30, 45, 500));
    assert.equal(parseStrictRetiredAtMs("2024-02-29T00:00:00Z"), Date.UTC(2024, 1, 29, 0, 0, 0));
  });

  test("rejects invalid calendar dates, garbage strings, and non-strings (never guesses)", () => {
    assert.equal(parseStrictRetiredAtMs("2026-02-30 00:00:00+00"), null);
    assert.equal(parseStrictRetiredAtMs("2026-13-01T00:00:00Z"), null);
    assert.equal(parseStrictRetiredAtMs("2025-02-29T00:00:00Z"), null);
    assert.equal(parseStrictRetiredAtMs("2026-01-01T25:00:00Z"), null);
    assert.equal(parseStrictRetiredAtMs("2026-01-01T00:00:00Z trailing"), null);
    assert.equal(parseStrictRetiredAtMs("not-a-date"), null);
    assert.equal(parseStrictRetiredAtMs(""), null);
    assert.equal(parseStrictRetiredAtMs(null), null);
    assert.equal(parseStrictRetiredAtMs(123456), null);
  });
});

describe("pruneRetiredLiveFrames (OCV5-824 B2 + N1)", () => {
  test("prunes ONLY tape-recoverable retired streams, retains uniqueCopy/unrecoverable streams, and skips malformed retired_at", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const nowMs = Date.UTC(2026, 10, 21, 0, 0, 0);
    const oldRetiredAt = "2026-11-01T00:00:00Z"; // 20 days old
    const recentRetiredAt = "2026-11-20T00:00:00Z"; // 1 day old (< 7d)

    const pool = {
      async query(sql: string, params: unknown[] = []) {
        queries.push({ sql, params });
        if (sql.includes("AS tape_recoverable")) {
          return {
            rowCount: 5,
            rows: [
              { stream_key: "dispatch:recoverable-1:1", retired_at_raw: oldRetiredAt, tape_recoverable: true },
              { stream_key: "dispatch:unique-copy:1", retired_at_raw: oldRetiredAt, tape_recoverable: false },
              { stream_key: "dispatch:invalid-ts:1", retired_at_raw: "2026-02-30 00:00:00+00", tape_recoverable: true },
              { stream_key: "dispatch:too-new:1", retired_at_raw: recentRetiredAt, tape_recoverable: true },
              { stream_key: "legacy:1:recoverable-2", retired_at_raw: oldRetiredAt, tape_recoverable: true },
            ],
          };
        }
        if (sql.includes("DELETE FROM client_session_live_frames")) {
          return {
            rowCount: 3,
            rows: [
              { stream_key: "dispatch:recoverable-1:1" },
              { stream_key: "dispatch:recoverable-1:1" },
              { stream_key: "legacy:1:recoverable-2" },
            ],
          };
        }
        if (sql.includes("DELETE FROM client_session_live_unit_checkpoints")) {
          return { rowCount: 2, rows: [] };
        }
        if (sql.includes("DELETE FROM client_session_live_streams")) {
          return {
            rowCount: 2,
            rows: [
              { stream_key: "dispatch:recoverable-1:1" },
              { stream_key: "legacy:1:recoverable-2" },
            ],
          };
        }
        throw new Error(`unexpected sql: ${sql}`);
      },
    } as unknown as Pool;

    const result = await pruneRetiredLiveFrames(pool, {
      olderThanDays: 7,
      batchSize: 500,
      nowMs,
    });
    assert.deepEqual(result, {
      deletedFrames: 3,
      prunedStreams: 2,
      deletedStreams: 2,
      retainedStreams: 1,
      skippedInvalidRetiredAt: 1,
    });

    const scanSql = queries.find((q) => q.sql.includes("AS tape_recoverable"));
    assert.ok(scanSql);
    assert.match(scanSql.sql, /s\.source='gateway'/);
    assert.match(scanSql.sql, /d\.status='terminal'/);
    assert.match(scanSql.sql, /'manual_reconcile'/);
    assert.match(scanSql.sql, /turn_recovery_jobs/);
    assert.match(scanSql.sql, /client_session_turn_tapes/);
    assert.match(scanSql.sql, /client_session_turn_tape_records/);
    assert.equal(scanSql.sql.includes("ELSE s.updated_at"), false, "N1: never fallback malformed retired_at to updated_at");

    const frameSql = queries.find((q) => q.sql.includes("DELETE FROM client_session_live_frames"));
    assert.ok(frameSql);
    assert.deepEqual(frameSql.params[0], ["dispatch:recoverable-1:1", "legacy:1:recoverable-2"]);

    const checkpointSql = queries.find((q) => q.sql.includes("client_session_live_unit_checkpoints"));
    assert.ok(checkpointSql);
    assert.deepEqual(
      new Set((checkpointSql.params[0] as string[]) ?? []),
      new Set(["dispatch:recoverable-1:1", "legacy:1:recoverable-2"]),
    );

    const streamSql = queries.find((q) => q.sql.includes("DELETE FROM client_session_live_streams"));
    assert.ok(streamSql);
    assert.deepEqual(streamSql.params[0], ["dispatch:recoverable-1:1", "legacy:1:recoverable-2"]);
    assert.match(streamSql.sql, /s\.projection_source='live'/);
    assert.match(streamSql.sql, /NOT EXISTS \(\s*SELECT 1 FROM client_session_live_frames/);
  });

  test("respects maxBatches cap and default olderThanDays=7", async () => {
    const scanParams: unknown[][] = [];
    let frameDeletes = 0;
    const pool = {
      async query(sql: string, params: unknown[] = []) {
        if (sql.includes("AS tape_recoverable")) {
          scanParams.push(params);
          return {
            rowCount: 1,
            rows: [{ stream_key: "dispatch:old:1", retired_at_raw: "2020-01-01T00:00:00Z", tape_recoverable: true }],
          };
        }
        if (sql.includes("DELETE FROM client_session_live_frames")) {
          frameDeletes += 1;
          return { rowCount: 2, rows: [{ stream_key: "dispatch:old:1" }, { stream_key: "dispatch:old:1" }] };
        }
        if (sql.includes("DELETE FROM client_session_live_unit_checkpoints")) {
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes("DELETE FROM client_session_live_streams")) {
          return { rowCount: 0, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      },
    } as unknown as Pool;

    const result = await pruneRetiredLiveFrames(pool, { batchSize: 2, maxBatches: 2 });
    assert.equal(frameDeletes, 2);
    assert.equal(result.deletedFrames, 4);
    assert.equal(scanParams[0]?.[1], DEFAULT_RETIRED_PRUNE_OLDER_THAN_DAYS);
  });

  test("idempotent no-op when no retired streams match", async () => {
    let calls = 0;
    const pool = {
      async query(sql: string) {
        calls += 1;
        assert.equal(sql.includes("DELETE FROM"), false);
        return { rowCount: 0, rows: [] };
      },
    } as unknown as Pool;
    const out = await pruneRetiredLiveFrames(pool);
    assert.deepEqual(out, {
      deletedFrames: 0,
      prunedStreams: 0,
      deletedStreams: 0,
      retainedStreams: 0,
      skippedInvalidRetiredAt: 0,
    });
    assert.equal(calls, 1);
  });
});

describe("extractSafeLiveStreamFactPointers & monotonic seq/pointer writes (B5)", () => {
  test("fast-paths non-status/non-usage payloads without parsing", () => {
    assert.deepEqual(
      extractSafeLiveStreamFactPointers('{"type":"outbound.message","text":"hi"}', 5),
      { isStatus: false, statusJson: null, isUsage: false, usageJson: null },
    );
    assert.deepEqual(
      extractSafeLiveStreamFactPointers('{"type":"outbound.message","nested":{"type":"outbound.turn_usage"}}', 6),
      { isStatus: false, statusJson: null, isUsage: false, usageJson: null },
    );
  });

  test("extracts turn_status and turn_usage pointers and marks non-JSONB NUL/surrogates with isStatus=true, statusJson=null", () => {
    const status = extractSafeLiveStreamFactPointers(
      JSON.stringify({ type: "outbound.turn_status", status: "working", detail: "bash", retry: { attempt: 1 } }),
      12,
    );
    assert.equal(status.isStatus, true);
    assert.equal(status.isUsage, false);
    assert.equal(status.usageJson, null);
    assert.deepEqual(JSON.parse(status.statusJson!), {
      frameSeq: 12,
      type: "outbound.turn_status",
      status: "working",
      retry: { attempt: 1 },
      detail: "bash",
    });

    const usage = extractSafeLiveStreamFactPointers(
      JSON.stringify({ type: "outbound.turn_usage", usage: { totalTokens: 100, inputTokens: 60, outputTokens: 40 } }),
      15,
    );
    assert.equal(usage.isUsage, true);
    assert.equal(usage.isStatus, false);
    assert.deepEqual(JSON.parse(usage.usageJson!), {
      frameSeq: 15,
      usage: { totalTokens: 100, inputTokens: 60, outputTokens: 40 },
    });

    // B5: NUL and lone surrogate MUST set isStatus=true with statusJson=null so seq advances and invalidates stale JSONB.
    const nulStatus = extractSafeLiveStreamFactPointers(
      JSON.stringify({ type: "outbound.turn_status", status: "working", detail: "bad\u0000text" }),
      16,
    );
    assert.equal(nulStatus.isStatus, true);
    assert.equal(nulStatus.statusJson, null);

    const loneSurrogateStatus = extractSafeLiveStreamFactPointers(
      '{"type":"outbound.turn_status","status":"working","detail":"bad\\ud800text"}',
      17,
    );
    assert.equal(loneSurrogateStatus.isStatus, true);
    assert.equal(loneSurrogateStatus.statusJson, null);
  });

  test("persistGatewayLiveFrame writes seq+pointer columns and clears retired_at on legacy reuse", async () => {
    let streamSql = "";
    let streamParams: unknown[] = [];
    const pool = {
      async connect() {
        return {
          async query(sql: string, params: unknown[] = []) {
            if (sql.includes("INSERT INTO client_session_live_streams")) {
              streamSql = sql;
              streamParams = params;
              return { rowCount: 1, rows: [{ stream_key: "legacy:1:s" }] };
            }
            if (sql.includes("INSERT INTO client_session_live_frames")) {
              return { rowCount: 1, rows: [{ record_id: "1" }] };
            }
            return { rowCount: 0, rows: [] };
          },
          release() {},
        };
      },
      async query() {
        return { rowCount: 0, rows: [] };
      },
    } as unknown as Pool;

    await persistGatewayLiveFrame(pool, {
      uid: 3n,
      sessionId: "sess-ptr",
      clientMessageId: null,
      agentContainerId: 1,
      sessionKey: "agent:main:webchat:dm:sess-ptr",
      frameSeq: 42,
      payload: JSON.stringify({ type: "outbound.turn_usage", usage: { totalTokens: 99 } }),
    });
    assert.match(streamSql, /latest_turn_status_seq/);
    assert.match(streamSql, /latest_turn_usage_seq/);
    assert.match(streamSql, /provenance - 'retired_at'/);
    assert.match(streamSql, /latest_turn_usage_seq <= \$14::bigint/);
    assert.equal(streamParams[11], null);
    assert.deepEqual(JSON.parse(String(streamParams[12])), { frameSeq: 42, usage: { totalTokens: 99 } });
    assert.equal(streamParams[13], 42);
    assert.equal(streamParams[14], false);
    assert.equal(streamParams[15], true);
  });
});
