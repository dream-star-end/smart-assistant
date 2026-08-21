import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LOSSLESS_TURN_RECORD_STAGE_BATCH_BYTES,
  _losslessTurnRecordWriteChunks,
} from "../db/pgSessionsBackend.js";

test("write chunks keep ordinal order and split on byte budget", () => {
  const items = [
    { ordinal: 0, bytes: 100 },
    { ordinal: 1, bytes: 100 },
    { ordinal: 2, bytes: 400 },
    { ordinal: 3, bytes: 50 },
  ];
  assert.deepEqual(_losslessTurnRecordWriteChunks(items, 250), [
    [0, 1],
    [2],
    [3],
  ]);
});

test("a single oversized record still occupies its own chunk", () => {
  const items = [
    { ordinal: 7, bytes: LOSSLESS_TURN_RECORD_STAGE_BATCH_BYTES * 2 },
    { ordinal: 8, bytes: 10 },
  ];
  assert.deepEqual(_losslessTurnRecordWriteChunks(items), [
    [7],
    [8],
  ]);
});

test("empty write list yields no chunks", () => {
  assert.deepEqual(_losslessTurnRecordWriteChunks([]), []);
});
