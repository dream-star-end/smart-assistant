import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { LosslessTurnTapeFinalizeRequest } from "@openclaude/protocol";

import {
  LOSSLESS_TURN_RECORD_STAGE_BATCH_SIZE,
  _createFinalizeSingleflight,
  _losslessFinalizeSingleflightKey,
  _losslessTurnRecordStageBatches,
} from "../db/pgSessionsBackend.js";

const FINALIZE: LosslessTurnTapeFinalizeRequest = {
  protocolVersion: 2,
  action: "finalize",
  sessionId: "session-finalize-test",
  agentId: "main",
  turnIndex: 7,
  status: "completed",
  turnKey: "a".repeat(64),
  tapeId: "b".repeat(64),
  tapeSha256: "c".repeat(64),
  totalBytes: 400_000,
  partCount: 3,
  createdAt: 1_784_700_000_000,
};

describe("lossless finalize singleflight", () => {
  test("identical concurrent work runs once and shares the same promise", async () => {
    const singleflight = _createFinalizeSingleflight<number>();
    let runs = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const first = singleflight("same", async () => {
      runs++;
      await barrier;
      return 42;
    });
    const second = singleflight("same", async () => {
      runs++;
      return 99;
    });
    assert.equal(first.shared, false);
    assert.equal(second.shared, true);
    assert.equal(first.promise, second.promise);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runs, 1);
    release();
    assert.deepEqual(await Promise.all([first.promise, second.promise]), [42, 42]);
  });

  test("different immutable identities do not share", async () => {
    const singleflight = _createFinalizeSingleflight<string>();
    let runs = 0;
    const first = singleflight("one", async () => { runs++; return "one"; });
    const second = singleflight("two", async () => { runs++; return "two"; });
    assert.equal(first.shared, false);
    assert.equal(second.shared, false);
    assert.deepEqual(await Promise.all([first.promise, second.promise]), ["one", "two"]);
    assert.equal(runs, 2);
  });

  test("rejection clears the key so the next retry can run", async () => {
    const singleflight = _createFinalizeSingleflight<number>();
    let runs = 0;
    const failed = singleflight("retry", async () => {
      runs++;
      throw new Error("first failed");
    });
    await assert.rejects(failed.promise, /first failed/);
    const retry = singleflight("retry", async () => { runs++; return 2; });
    assert.equal(retry.shared, false);
    assert.equal(await retry.promise, 2);
    assert.equal(runs, 2);
  });

  test("every immutable header field participates in the key", () => {
    const base = _losslessFinalizeSingleflightKey("c:1", FINALIZE);
    const variants: Array<[string, LosslessTurnTapeFinalizeRequest]> = [
      ["sessionId", { ...FINALIZE, sessionId: "session-finalize-other" }],
      ["tapeId", { ...FINALIZE, tapeId: "d".repeat(64) }],
      ["agentId", { ...FINALIZE, agentId: "reviewer" }],
      ["turnIndex", { ...FINALIZE, turnIndex: 8 }],
      ["status", { ...FINALIZE, status: "crashed" }],
      ["turnKey", { ...FINALIZE, turnKey: "e".repeat(64) }],
      ["tapeSha256", { ...FINALIZE, tapeSha256: "f".repeat(64) }],
      ["totalBytes", { ...FINALIZE, totalBytes: FINALIZE.totalBytes + 1 }],
      ["partCount", { ...FINALIZE, partCount: FINALIZE.partCount + 1 }],
      ["createdAt", { ...FINALIZE, createdAt: FINALIZE.createdAt + 1 }],
      ["waiveReason", { ...FINALIZE, waiveReason: "idle_timeout" }],
      ["dispatchId", { ...FINALIZE, dispatchId: "d".repeat(64), attemptNo: 1 }],
    ];
    assert.notEqual(_losslessFinalizeSingleflightKey("c:2", FINALIZE), base, "userId");
    for (const [field, request] of variants) {
      assert.notEqual(_losslessFinalizeSingleflightKey("c:1", request), base, field);
    }
    const dispatchBase = { ...FINALIZE, dispatchId: "d".repeat(64), attemptNo: 1 };
    assert.notEqual(
      _losslessFinalizeSingleflightKey("c:1", { ...dispatchBase, attemptNo: 2 }),
      _losslessFinalizeSingleflightKey("c:1", dispatchBase),
      "attemptNo",
    );
  });
});

describe("lossless record staging batches", () => {
  test("127/128/129 boundaries and exact-ordinal skips", () => {
    assert.equal(LOSSLESS_TURN_RECORD_STAGE_BATCH_SIZE, 128);
    assert.deepEqual(_losslessTurnRecordStageBatches(127, new Set()).map((b) => b.length), [127]);
    assert.deepEqual(_losslessTurnRecordStageBatches(128, new Set()).map((b) => b.length), [128]);
    assert.deepEqual(_losslessTurnRecordStageBatches(129, new Set()).map((b) => b.length), [128, 1]);
    const skipped = _losslessTurnRecordStageBatches(130, new Set([0, 64, 129]));
    assert.deepEqual(skipped.map((b) => b.length), [127]);
    assert.ok(!skipped.flat().some((ordinal) => ordinal === 0 || ordinal === 64 || ordinal === 129));
  });
});
