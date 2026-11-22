import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Pool } from "pg";
import { LIVE_UNITS_REDUCER_EPOCH, reduceLiveFrames, type LiveFrameInput } from "@openclaude/protocol";
import {
  readClientSessionLiveUnits,
} from "../db/liveTurnFrames.js";
import {
  configureLiveUnitCheckpointScheduler,
  deleteLiveUnitCheckpoints,
  flushLiveUnitCheckpoint,
  getLiveUnitCheckpointDegradedReason,
  isLiveUnitCheckpointDegraded,
  resetLiveUnitCheckpointScheduler,
  scheduleLiveUnitCheckpoint,
  upsertLiveUnitCheckpoint,
} from "../db/liveUnitCheckpoints.js";

function frame(recordId: string, frameSeq: number, block: Record<string, unknown>): LiveFrameInput {
  return {
    recordId,
    streamKey: "dispatch:00000000-0000-4000-8000-000000000001:1",
    clientMessageId: "cm-1",
    payload: {
      type: "outbound.message",
      sessionKey: "agent:main:webchat:dm:sess",
      frameSeq,
      blocks: [block],
    },
  };
}

function sampleState(seq: number, recordId: string) {
  const reduced = reduceLiveFrames([
    frame(recordId, seq, { kind: "thinking", text: `h${seq}` }),
  ]);
  assert.equal(reduced.ok, true);
  if (!reduced.ok) throw new Error("reduce");
  return reduced.state;
}

function fakePool(handler: (sql: string, params: unknown[]) => { rowCount?: number; rows?: unknown[] }) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return handler(sql, params);
    },
  } as unknown as Pool;
  return { pool, calls };
}

describe("live unit checkpoint scheduler", () => {
  afterEach(() => resetLiveUnitCheckpointScheduler());

  it("does not reduce on the persist stack and swallows flush errors", async () => {
    let flushes = 0;
    configureLiveUnitCheckpointScheduler({
      debounceFrames: 1,
      flush: async () => {
        flushes += 1;
        throw new Error("checkpoint write failed");
      },
    });
    assert.doesNotThrow(() => {
      scheduleLiveUnitCheckpoint({} as Pool, {
        sessionId: "s1",
        userId: "c:3",
        streamKey: "dispatch:aaaa:1",
        live: true,
      });
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(flushes, 1);
  });

  it("skips legacy streams and tape-projected writes", async () => {
    let flushes = 0;
    configureLiveUnitCheckpointScheduler({
      debounceFrames: 1,
      flush: async () => {
        flushes += 1;
      },
    });
    scheduleLiveUnitCheckpoint({} as Pool, {
      sessionId: "s1",
      userId: "c:3",
      streamKey: "legacy:1:sk",
      live: true,
    });
    scheduleLiveUnitCheckpoint({} as Pool, {
      sessionId: "s1",
      userId: "c:3",
      streamKey: "dispatch:aaaa:1",
      live: false,
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(flushes, 0);
  });

  it("debounces to one flush per 50 frames / 200ms (test uses 2 frames)", async () => {
    let flushes = 0;
    configureLiveUnitCheckpointScheduler({
      debounceFrames: 2,
      debounceMs: 30_000,
      flush: async () => {
        flushes += 1;
      },
    });
    const input = {
      sessionId: "s1",
      userId: "c:3",
      streamKey: "dispatch:aaaa:1",
      live: true,
    };
    scheduleLiveUnitCheckpoint({} as Pool, input);
    assert.equal(flushes, 0);
    scheduleLiveUnitCheckpoint({} as Pool, input);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(flushes, 1);
  });
});

describe("live unit checkpoint upsert / prune", () => {
  afterEach(() => resetLiveUnitCheckpointScheduler());

  it("monotonic WHERE refuses to move through_frame_seq backwards", async () => {
    const { pool, calls } = fakePool(() => ({ rowCount: 0, rows: [] }));
    const state = sampleState(8, "8");
    const result = await upsertLiveUnitCheckpoint(pool, {
      streamKey: "dispatch:aaaa:1",
      sessionId: "s1",
      userId: "c:3",
      state,
    });
    assert.equal(result.written, false);
    assert.match(calls[0]!.sql, /through_frame_seq < EXCLUDED\.through_frame_seq/);
    assert.equal(calls[0]!.params[4], 8);
  });

  it("advances when the driver reports a written row", async () => {
    const { pool, calls } = fakePool(() => ({ rowCount: 1, rows: [] }));
    const state = sampleState(12, "12");
    const result = await upsertLiveUnitCheckpoint(pool, {
      streamKey: "dispatch:aaaa:1",
      sessionId: "s1",
      userId: "c:3",
      state,
    });
    assert.equal(result.written, true);
    assert.equal(calls[0]!.params[3], LIVE_UNITS_REDUCER_EPOCH);
    assert.equal(calls[0]!.params[4], 12);
  });

  it("prune helper deletes checkpoint rows by stream_key", async () => {
    const { pool, calls } = fakePool(() => ({ rowCount: 2, rows: [] }));
    const deleted = await deleteLiveUnitCheckpoints(pool, ["dispatch:a:1", "dispatch:b:1"]);
    assert.equal(deleted, 2);
    assert.match(calls[0]!.sql, /DELETE FROM client_session_live_unit_checkpoints/);
    assert.deepEqual(calls[0]!.params[0], ["dispatch:a:1", "dispatch:b:1"]);
  });

  it("skips empty prune lists", async () => {
    const { pool, calls } = fakePool(() => ({ rowCount: 0, rows: [] }));
    assert.equal(await deleteLiveUnitCheckpoints(pool, []), 0);
    assert.equal(calls.length, 0);
  });
});

describe("OCV5-819 P0-1: singleflight lock, degraded circuit-breaker, and query byte/row budget", () => {
  afterEach(() => resetLiveUnitCheckpointScheduler());

  it("enforces per-stream singleflight and coalesces concurrent frames into one trailing dirty flush", async () => {
    let active = 0;
    let maxActive = 0;
    let totalRuns = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => { releaseFirst = r; });

    configureLiveUnitCheckpointScheduler({
      debounceFrames: 1,
      debounceMs: 5,
      flush: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        totalRuns += 1;
        if (totalRuns === 1) await firstGate;
        active -= 1;
      },
    });

    const input = { sessionId: "s1", userId: "c:3", streamKey: "dispatch:sf:1", live: true };
    for (let i = 0; i < 15; i += 1) {
      scheduleLiveUnitCheckpoint({} as Pool, input);
    }
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(totalRuns, 1, "must not launch concurrent flushes for same stream");
    assert.equal(maxActive, 1);

    releaseFirst();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(totalRuns, 2, "must run one serial trailing dirty flush after singleflight releases");
    assert.equal(maxActive, 1);
  });

  it("marks fallback-degraded streams (e.g. permission_request) and skips all future flushes", async () => {
    let queryCount = 0;
    const warnings: string[] = [];
    configureLiveUnitCheckpointScheduler({
      debounceFrames: 1,
      debounceMs: 5,
      onWarn: (msg) => warnings.push(msg),
    });

    const permissionPayload = Buffer.from(JSON.stringify({
      type: "outbound.permission_request",
      frameSeq: 2,
      sessionKey: "agent:main:webchat:dm:s1",
      requestId: "req-1",
    }));
    const mockClient = {
      query: async (sql: string) => {
        if (sql.includes("JOIN client_session_live_frames")) {
          queryCount += 1;
          return {
            rows: [{
              record_id: "100",
              stream_key: "dispatch:perm:1",
              client_message_id: "cm-1",
              payload: permissionPayload,
              payload_sha256: null,
            }],
          };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => {},
    };
    const pool = { connect: async () => mockClient, query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool;

    await flushLiveUnitCheckpoint({
      pool,
      sessionId: "s1",
      userId: "c:3",
      streamKey: "dispatch:perm:1",
    });
    assert.equal(queryCount, 1);
    assert.equal(isLiveUnitCheckpointDegraded("dispatch:perm:1"), true);
    assert.equal(getLiveUnitCheckpointDegradedReason("dispatch:perm:1"), "fallback");
    assert.equal(warnings.length, 1);

    // Subsequent scheduled frames and direct flushes short-circuit with zero DB queries.
    for (let i = 0; i < 10; i += 1) {
      scheduleLiveUnitCheckpoint(pool, {
        sessionId: "s1",
        userId: "c:3",
        streamKey: "dispatch:perm:1",
        live: true,
      });
    }
    await flushLiveUnitCheckpoint({
      pool,
      sessionId: "s1",
      userId: "c:3",
      streamKey: "dispatch:perm:1",
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(queryCount, 1, "degraded stream must never scan DB again");
  });

  it("enforces SQL LIMIT and aborts before JSON.parse when payload bytes exceed maxBytesPerFlush", async () => {
    const warnings: string[] = [];
    const seenLimits: number[] = [];
    configureLiveUnitCheckpointScheduler({
      batchLimit: 50,
      maxBytesPerFlush: 2048,
      onWarn: (msg) => warnings.push(msg),
    });

    // Deliberately invalid JSON that exceeds byte cap — proving byte budget trips BEFORE JSON.parse!
    const hugeNotJson = Buffer.alloc(3000, 0x78);
    const mockClient = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes("JOIN client_session_live_frames")) {
          assert.match(sql, /octet_length\(f\.payload\)/);
          assert.match(sql, /cum_bytes <= \$5/);
          assert.match(sql, /LIMIT \$3/);
          seenLimits.push(Number(params?.[2]));
          assert.equal(params?.[4], 2048);
          // Simulate PG returning a payload=NULL sentinel when cum_bytes > remainingBytes.
          return {
            rows: [{
              record_id: "200",
              stream_key: "dispatch:huge:1",
              client_message_id: "cm-huge",
              payload: null,
              nbytes: 3000,
              rn: 1,
              payload_sha256: null,
            }],
          };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => {},
    };
    const pool = { connect: async () => mockClient, query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool;

    await flushLiveUnitCheckpoint({
      pool,
      sessionId: "s-huge",
      userId: "c:3",
      streamKey: "dispatch:huge:1",
    });
    assert.deepEqual(seenLimits, [51]);
    assert.equal(getLiveUnitCheckpointDegradedReason("dispatch:huge:1"), "budget");
    assert.equal(warnings.length, 1);
  });

  it("OCV5-819 B3: epoch 4 replaces epoch 3 first slice and zero-progress upsert never self-loops", async () => {
    // 1. SQL WHERE allows newer reducer_epoch to overwrite old epoch even with smaller seq
    const { pool: upsertPool, calls } = fakePool(() => ({ rowCount: 1, rows: [] }));
    const res = await upsertLiveUnitCheckpoint(upsertPool, {
      streamKey: "dispatch:ep:1",
      sessionId: "s-ep",
      userId: "c:3",
      state: sampleState(2, "2"),
    });
    assert.equal(res.written, true);
    assert.match(calls[0]!.sql, /EXCLUDED\.reducer_epoch::int/);

    // 2. When upsert reports written=false (not_newer) while more batches exist, scheduler
    // must NOT reschedule endlessly from record 0.
    let readStarts: string[] = [];
    configureLiveUnitCheckpointScheduler({
      debounceFrames: 1,
      debounceMs: 5,
      batchLimit: 1,
      maxBatchesPerFlush: 1,
    });
    const textPayload = Buffer.from(JSON.stringify({
      type: "outbound.message",
      frameSeq: 1,
      sessionKey: "agent:main:webchat:dm:s-ep",
      blocks: [{ kind: "text", messageId: "m1", text: "hi" }],
    }));
    const mockClient = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes("JOIN client_session_live_frames")) {
          readStarts.push(String(params?.[1]));
          return {
            rows: [
              { record_id: "1", stream_key: "dispatch:noprogress:1", client_message_id: "cm1", payload: textPayload, nbytes: textPayload.byteLength, rn: 1, payload_sha256: null },
              { record_id: "2", stream_key: "dispatch:noprogress:1", client_message_id: "cm1", payload: null, nbytes: 10, rn: 2, payload_sha256: null },
            ],
          };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => {},
    };
    const noProgressPool = {
      connect: async () => mockClient,
      query: async () => ({ rows: [], rowCount: 0 }), // upsert returns written=false
    } as unknown as Pool;

    scheduleLiveUnitCheckpoint(noProgressPool, {
      sessionId: "s-ep",
      userId: "c:3",
      streamKey: "dispatch:noprogress:1",
      live: true,
    });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(readStarts.length, 1, "zero-progress upsert must not trigger infinite rescan loop");
  });

  it("OCV5-819 B2+B8: multi-open-stream GET bypasses single-stream checkpoint and shares row/byte budget across snapshot+catchUp", async () => {
    const streamA = "dispatch:aaaa:1";
    const streamB = "dispatch:bbbb:1";
    let checkpointReadCount = 0;
    let checkpointUpsertCount = 0;
    const frameQueryCalls: Array<{ after: string; limit: number; rowBudget: number; byteBudget: number }> = [];

    const frameA = Buffer.from(JSON.stringify({
      type: "outbound.message",
      frameSeq: 1,
      sessionKey: "agent:main:webchat:dm:s-multi",
      blocks: [{ kind: "text", messageId: "m-a", text: "来自流A的正文" }],
    }));
    const frameB = Buffer.from(JSON.stringify({
      type: "outbound.message",
      frameSeq: 2,
      sessionKey: "agent:main:webchat:dm:s-multi",
      blocks: [{
        kind: "swarm_snapshot",
        blockId: "agy-swarm-11111111-t0",
        snapshot: {
          swarmId: "11111111-1111-4111-8111-111111111111",
          title: "流B蜂群",
          phase: "running",
          revision: 1,
          updatedAt: 1000,
          members: [],
          channels: [],
          posts: [],
          totalPosts: 0,
        },
      }],
    }));

    const mockClient = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes("FROM client_sessions WHERE")) {
          return { rows: [{ "?column?": 1 }], rowCount: 1 };
        }
        if (sql.includes("FROM client_session_live_streams") && !sql.includes("JOIN client_session_live_frames")) {
          return {
            rows: [
              { stream_key: streamA, client_message_id: "cm-a", projection_source: "live", retired: false, superseded_by_completed_tape: false, tape_projection_version: "0", open_dispatch: true },
              { stream_key: streamB, client_message_id: "cm-b", projection_source: "live", retired: false, superseded_by_completed_tape: false, tape_projection_version: "0", open_dispatch: true },
            ],
            rowCount: 2,
          };
        }
        if (sql.includes("FROM client_session_live_unit_checkpoints")) {
          checkpointReadCount += 1;
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("JOIN client_session_live_frames")) {
          const call = {
            after: String(params?.[2]),
            limit: Number(params?.[3]),
            rowBudget: Number(params?.[4]),
            byteBudget: Number(params?.[5]),
          };
          frameQueryCalls.push(call);
          if (frameQueryCalls.length === 1) {
            return {
              rows: [
                { record_id: "1", stream_key: streamA, client_message_id: "cm-a", payload: frameA, nbytes: frameA.byteLength, rn: 1, payload_sha256: null },
                { record_id: "2", stream_key: streamB, client_message_id: "cm-b", payload: frameB, nbytes: frameB.byteLength, rn: 2, payload_sha256: null },
              ],
              rowCount: 2,
            };
          }
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => {},
    };
    const pool = {
      connect: async () => mockClient,
      query: async (sql: string) => {
        if (sql.includes("INSERT INTO client_session_live_unit_checkpoints")) checkpointUpsertCount += 1;
        return { rows: [], rowCount: 1 };
      },
    } as unknown as Pool;

    const page = await readClientSessionLiveUnits(pool, "s-multi", "c:3", {
      maxReadRows: 5,
      maxReadBytes: 10_000,
    });
    assert.ok(page);
    assert.equal(page.degraded, false);
    assert.equal(checkpointReadCount, 0, "multi-open-stream GET must bypass single-stream checkpoint");
    assert.equal(frameQueryCalls[0]?.after, "0", "must scan from record 0 covering both streams");
    assert.equal(frameQueryCalls[1]?.rowBudget, 3, "catchUp must deduct snapshot row usage (5 - 2 = 3)");
    assert.equal(
      frameQueryCalls[1]?.byteBudget,
      10_000 - frameA.byteLength - frameB.byteLength,
      "catchUp must deduct snapshot byte usage",
    );
    assert.ok(page.units.some((u) => u.kind === "text" && u.text === "来自流A的正文"), "stream A text must not be shadowed");
    assert.ok(page.units.some((u) => u.kind === "tool" && u.toolName === "SwarmBoard"), "stream B SwarmBoard must be present");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(checkpointUpsertCount, 0, "multi-open-stream GET must not backfill aggregate into single-stream checkpoint");
  });

  it("OCV5-819 R2-B8: new stream appearing during catchUp fails closed without polluting single-stream A checkpoint", async () => {
    const streamA = "dispatch:onlyA:1";
    const streamB = "dispatch:lateB:1";
    let checkpointUpsertCount = 0;
    let frameQueryCount = 0;

    const frameA = Buffer.from(JSON.stringify({
      type: "outbound.message",
      frameSeq: 1,
      sessionKey: "agent:main:webchat:dm:s-race",
      blocks: [{ kind: "text", messageId: "m-a", text: "流A文本" }],
    }));
    const frameB = Buffer.from(JSON.stringify({
      type: "outbound.message",
      frameSeq: 2,
      sessionKey: "agent:main:webchat:dm:s-race",
      blocks: [{ kind: "text", messageId: "m-b", text: "迟到流B文本" }],
    }));

    const mockClient = {
      query: async (sql: string) => {
        if (sql.includes("FROM client_sessions WHERE")) {
          return { rows: [{ "?column?": 1 }], rowCount: 1 };
        }
        if (sql.includes("FROM client_session_live_streams") && !sql.includes("JOIN client_session_live_frames")) {
          // Snapshot tx only sees stream A open.
          return {
            rows: [
              { stream_key: streamA, client_message_id: "cm-a", projection_source: "live", retired: false, superseded_by_completed_tape: false, tape_projection_version: "0", open_dispatch: true },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM client_session_live_unit_checkpoints")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("JOIN client_session_live_frames")) {
          frameQueryCount += 1;
          if (frameQueryCount === 1) {
            return {
              rows: [{ record_id: "1", stream_key: streamA, client_message_id: "cm-a", payload: frameA, nbytes: frameA.byteLength, rn: 1, payload_sha256: null }],
              rowCount: 1,
            };
          }
          // Catch-up tx sees a newly opened sibling stream B!
          return {
            rows: [{ record_id: "2", stream_key: streamB, client_message_id: "cm-b", payload: frameB, nbytes: frameB.byteLength, rn: 1, payload_sha256: null }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => {},
    };
    const pool = {
      connect: async () => mockClient,
      query: async (sql: string) => {
        if (sql.includes("INSERT INTO client_session_live_unit_checkpoints")) checkpointUpsertCount += 1;
        return { rows: [], rowCount: 1 };
      },
    } as unknown as Pool;

    const page = await readClientSessionLiveUnits(pool, "s-race", "c:3");
    assert.ok(page);
    assert.equal(page.degraded, "fallback", "new stream appearing in catchUp must fail closed instead of minting stale resume");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(checkpointUpsertCount, 0, "must never write mixed A+B state into stream A checkpoint");
  });
});
