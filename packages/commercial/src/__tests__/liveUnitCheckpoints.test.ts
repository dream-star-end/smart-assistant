import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Pool } from "pg";
import { LIVE_UNITS_REDUCER_EPOCH, reduceLiveFrames, type LiveFrameInput } from "@openclaude/protocol";
import {
  configureLiveUnitCheckpointScheduler,
  deleteLiveUnitCheckpoints,
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
