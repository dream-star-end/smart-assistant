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

  test("admits concurrent tapes while their physical reservations fit", () => {
    const acquire = _createPhysicalFinalizeAdmission(() => ({
      availableSystemBytes: 1_000,
      heapAvailableBytes: 1_000,
      heapLimitBytes: 1_000,
    }));
    const releaseFirst = acquire(100);
    const releaseSecond = acquire(100);
    releaseSecond();
    releaseFirst();
  });

  test("does not attribute unrelated live memory pressure to an outstanding reservation", () => {
    let readCount = 0;
    const acquire = _createPhysicalFinalizeAdmission(() => {
      readCount += 1;
      return readCount === 1
        ? { availableSystemBytes: 1_000, heapAvailableBytes: 1_000, heapLimitBytes: 1_000 }
        : { availableSystemBytes: 400, heapAvailableBytes: 1_000, heapLimitBytes: 1_000 };
    });
    const releaseFirst = acquire(100);
    assert.throws(
      () => acquire(100),
      (err: unknown) => (err as { retryable?: unknown }).retryable === true,
    );
    releaseFirst();
    const releaseSecond = acquire(100);
    releaseSecond();
  });

  test("external reservations reject only the request beyond real capacity and release exactly once", () => {
    const acquire = _createPhysicalFinalizeAdmission(() => ({
      availableSystemBytes: 700,
      heapAvailableBytes: 10_000,
      heapLimitBytes: 10_000,
    }));
    const releaseFirst = acquire(100);
    const releaseSecond = acquire(100);
    assert.throws(
      () => acquire(100),
      (err: unknown) => (err as { retryable?: unknown }).retryable === true,
    );
    releaseFirst();
    releaseFirst();
    const releaseThird = acquire(100);
    releaseThird();
    releaseSecond();
  });

  test("heap reservations enforce their independent physical boundary", () => {
    const acquire = _createPhysicalFinalizeAdmission(() => ({
      availableSystemBytes: 10_000,
      heapAvailableBytes: 450,
      heapLimitBytes: 10_000,
    }));
    const releaseFirst = acquire(100);
    const releaseSecond = acquire(100);
    assert.throws(
      () => acquire(100),
      (err: unknown) => (err as { retryable?: unknown }).retryable === true,
    );
    releaseSecond();
    releaseFirst();
  });
});
