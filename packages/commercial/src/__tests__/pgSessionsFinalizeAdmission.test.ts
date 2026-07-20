import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { _createPhysicalFinalizeAdmission } from "../db/pgSessionsBackend.js";

describe("lossless tape physical finalize admission", () => {
  test("an impossible tape is retryable and cannot poison the following normal admission", () => {
    const acquire = _createPhysicalFinalizeAdmission(() => ({
      availableSystemBytes: 1_000,
      heapAvailableBytes: 1_000,
      heapLimitBytes: 1_000,
    }));

    assert.throws(
      () => acquire(600),
      (err: unknown) => {
        assert.equal((err as { retryable?: unknown }).retryable, true);
        assert.equal((err as { code?: unknown }).code, "OC_TURN_TAPE_FINALIZE_CAPACITY");
        return true;
      },
    );
    const release = acquire(100);
    release();
  });

  test("a busy materializer returns retryable instead of creating an unbounded FIFO wait", () => {
    const acquire = _createPhysicalFinalizeAdmission(() => ({
      availableSystemBytes: 10_000,
      heapAvailableBytes: 10_000,
      heapLimitBytes: 10_000,
    }));
    const releaseFirst = acquire(100);
    assert.throws(
      () => acquire(100),
      (err: unknown) => (err as { retryable?: unknown }).retryable === true,
    );
    releaseFirst();
    const releaseNext = acquire(100);
    releaseNext();
  });
});
