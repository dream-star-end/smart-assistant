/**
 * OCV5-824: pruneRetiredLiveFrames + live stream fact pointer extraction/persistence (no Postgres).
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/liveTurnFrames.pruneRetired.test.ts
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Pool } from "pg";
import {
  DEFAULT_RETIRED_PRUNE_OLDER_THAN_DAYS,
  extractSafeLiveStreamFactPointers,
  persistGatewayLiveFrame,
  pruneRetiredLiveFrames,
} from "../db/liveTurnFrames.js";

describe("pruneRetiredLiveFrames (OCV5-824)", () => {
  test("deletes retired gateway frames in batches, drops checkpoints, then deletes empty retired live streams", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    let frameDeleteCall = 0;
    let streamDeleteCall = 0;
    const pool = {
      async query(sql: string, params: unknown[] = []) {
        queries.push({ sql, params });
        if (sql.includes("DELETE FROM client_session_live_frames")) {
          frameDeleteCall += 1;
          if (frameDeleteCall === 1) {
            return {
              rowCount: 3,
              rows: [
                { stream_key: "dispatch:dead-1:1" },
                { stream_key: "dispatch:dead-1:1" },
                { stream_key: "legacy:1:dead-2" },
              ],
            };
          }
          if (frameDeleteCall === 2) {
            return {
              rowCount: 1,
              rows: [{ stream_key: "legacy:1:dead-2" }],
            };
          }
          return { rowCount: 0, rows: [] };
        }
        if (sql.includes("DELETE FROM client_session_live_unit_checkpoints")) {
          return { rowCount: 2, rows: [] };
        }
        if (sql.includes("DELETE FROM client_session_live_streams")) {
          streamDeleteCall += 1;
          if (streamDeleteCall === 1) {
            return {
              rowCount: 2,
              rows: [{ stream_key: "dispatch:dead-1:1" }, { stream_key: "legacy:1:dead-2" }],
            };
          }
          return { rowCount: 0, rows: [] };
        }
        throw new Error(`unexpected sql: ${sql}`);
      },
    } as unknown as Pool;

    const result = await pruneRetiredLiveFrames(pool, {
      olderThanDays: 7,
      batchSize: 500,
    });
    assert.deepEqual(result, {
      deletedFrames: 4,
      prunedStreams: 2,
      deletedStreams: 2,
    });

    const frameSql = queries.find((q) => q.sql.includes("DELETE FROM client_session_live_frames"));
    assert.ok(frameSql);
    assert.deepEqual(frameSql.params, [500, 7]);
    // Safety predicates: gateway only, retired_at present, safe timestamptz cast fallback, never open dispatch.
    assert.match(frameSql.sql, /s\.source='gateway'/);
    assert.match(frameSql.sql, /s\.provenance \? 'retired_at'/);
    assert.match(frameSql.sql, /ELSE s\.updated_at/);
    assert.match(frameSql.sql, /status IN \('admitted','accepted','rejecting'\)/);

    const checkpointSql = queries.find((q) => q.sql.includes("client_session_live_unit_checkpoints"));
    assert.ok(checkpointSql);
    assert.deepEqual(
      new Set((checkpointSql.params[0] as string[]) ?? []),
      new Set(["dispatch:dead-1:1", "legacy:1:dead-2"]),
    );

    const streamSql = queries.find((q) => q.sql.includes("DELETE FROM client_session_live_streams"));
    assert.ok(streamSql);
    assert.deepEqual(streamSql.params, [500, 7]);
    assert.match(streamSql.sql, /s\.projection_source='live'/);
    assert.match(streamSql.sql, /NOT EXISTS \(\s*SELECT 1 FROM client_session_live_frames/);
  });

  test("respects maxBatches cap and default olderThanDays=7", async () => {
    const paramsSeen: unknown[][] = [];
    const pool = {
      async query(sql: string, params: unknown[] = []) {
        paramsSeen.push(params);
        if (sql.includes("DELETE FROM client_session_live_frames")) {
          return { rowCount: 2, rows: [{ stream_key: "dispatch:old:1" }, { stream_key: "dispatch:old:1" }] };
        }
        if (sql.includes("DELETE FROM client_session_live_unit_checkpoints")) {
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes("DELETE FROM client_session_live_streams")) {
          return { rowCount: 1, rows: [{ stream_key: "dispatch:old:1" }] };
        }
        return { rowCount: 0, rows: [] };
      },
    } as unknown as Pool;

    const result = await pruneRetiredLiveFrames(pool, { batchSize: 2, maxBatches: 2 });
    assert.equal(result.deletedFrames, 4);
    assert.equal(result.deletedStreams, 2);
    assert.equal(paramsSeen[0]?.[0], 2);
    assert.equal(paramsSeen[0]?.[1], DEFAULT_RETIRED_PRUNE_OLDER_THAN_DAYS);
  });

  test("idempotent no-op when no retired streams exceed retention", async () => {
    let calls = 0;
    const pool = {
      async query(sql: string) {
        calls += 1;
        assert.equal(sql.includes("client_session_live_unit_checkpoints"), false);
        return { rowCount: 0, rows: [] };
      },
    } as unknown as Pool;
    const out = await pruneRetiredLiveFrames(pool);
    assert.deepEqual(out, { deletedFrames: 0, prunedStreams: 0, deletedStreams: 0 });
    assert.equal(calls, 2, "1 frame check + 1 stream check, 0 checkpoint deletes");
  });
});

describe("extractSafeLiveStreamFactPointers & monotonic stream pointer writes", () => {
  test("fast-paths non-status/non-usage payloads without parsing", () => {
    assert.deepEqual(
      extractSafeLiveStreamFactPointers('{"type":"outbound.message","text":"hi"}', 5),
      { statusJson: null, usageJson: null },
    );
    assert.deepEqual(
      extractSafeLiveStreamFactPointers('{"type":"outbound.message","nested":{"type":"outbound.turn_usage"}}', 6),
      { statusJson: null, usageJson: null },
    );
  });

  test("extracts turn_status and turn_usage pointers and rejects PG-unsafe NUL/surrogates", () => {
    const status = extractSafeLiveStreamFactPointers(
      JSON.stringify({ type: "outbound.turn_status", status: "working", detail: "bash", retry: { attempt: 1 } }),
      12,
    );
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
    assert.equal(usage.statusJson, null);
    assert.deepEqual(JSON.parse(usage.usageJson!), {
      frameSeq: 15,
      usage: { totalTokens: 100, inputTokens: 60, outputTokens: 40 },
    });

    // NUL and lone surrogate must not be written into JSONB pointer columns.
    assert.equal(
      extractSafeLiveStreamFactPointers(
        JSON.stringify({ type: "outbound.turn_status", status: "working", detail: "bad\u0000text" }),
        16,
      ).statusJson,
      null,
    );
    assert.equal(
      extractSafeLiveStreamFactPointers(
        '{"type":"outbound.turn_status","status":"working","detail":"bad\\ud800text"}',
        17,
      ).statusJson,
      null,
    );
  });

  test("persistGatewayLiveFrame writes pointer columns with monotonic frameSeq guard", async () => {
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
    assert.match(streamSql, /latest_turn_status_json/);
    assert.match(streamSql, /latest_turn_usage_json/);
    assert.match(streamSql, /->>'frameSeq'\)::bigint, 0\) <= \$14::bigint/);
    assert.equal(streamParams[11], null);
    assert.deepEqual(JSON.parse(String(streamParams[12])), { frameSeq: 42, usage: { totalTokens: 99 } });
    assert.equal(streamParams[13], 42);
  });
});
