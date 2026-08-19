import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  assertSettlementMatchesCanonical,
  clipVisibleText,
  phaseAVisibleHeadText,
  settlementAuthorityHash,
  VISIBLE_HEAD_TEXT_MAX_BYTES,
} from "../db/visibleFinalize.js";

describe("clipVisibleText", () => {
  test("single UTF-8 buffer cut keeps character boundary", () => {
    const text = "é".repeat(VISIBLE_HEAD_TEXT_MAX_BYTES);
    const clipped = clipVisibleText(text);
    assert.equal(clipped.truncated, true);
    assert.ok(Buffer.byteLength(clipped.text, "utf8") <= VISIBLE_HEAD_TEXT_MAX_BYTES);
    assert.doesNotMatch(clipped.text, /\uFFFD/);
  });
});

describe("settlementAuthorityHash", () => {
  test("stable for the same envelope", () => {
    const a = settlementAuthorityHash({
      billingAnchorId: "srv-s-t1",
      requestId: "r1",
      engineBillings: [{ requestId: "r1", model: "x" }],
    });
    const b = settlementAuthorityHash({
      billingAnchorId: "srv-s-t1",
      requestId: "r1",
      engineBillings: [{ requestId: "r1", model: "x" }],
    });
    const c = settlementAuthorityHash({
      billingAnchorId: "srv-s-t1",
      requestId: "r2",
      engineBillings: [{ requestId: "r1", model: "x" }],
    });
    assert.equal(a, b);
    assert.notEqual(a, c);
  });
});

describe("phaseAVisibleHeadText", () => {
  test("without settlement uses live-frame text, never invents tape-part body", () => {
    assert.equal(phaseAVisibleHeadText({
      hasSettlement: false,
      liveFrameText: "from frames",
      settlementText: "from envelope",
    }), "from frames");
    assert.equal(phaseAVisibleHeadText({ hasSettlement: false }), "");
  });
  test("with settlement uses envelope text only", () => {
    assert.equal(phaseAVisibleHeadText({
      hasSettlement: true,
      settlementText: "from envelope",
      liveFrameText: "from frames",
    }), "from envelope");
  });
});

describe("assertSettlementMatchesCanonical", () => {
  const billings = [{ requestId: "1".repeat(32), model: "x" }];
  const canonical = {
    canonicalAnchorId: "srv-s-main-t1",
    canonicalRequestId: "1".repeat(32),
    canonicalBillings: billings,
  };
  test("wrong billingAnchorId with matching billings is rejected", () => {
    const persisted = settlementAuthorityHash({
      billingAnchorId: "srv-s-main-t1-WRONG",
      requestId: "1".repeat(32),
      engineBillings: billings,
    });
    assert.throws(
      () => assertSettlementMatchesCanonical({
        ...canonical,
        envelope: {
          billingAnchorId: "srv-s-main-t1-WRONG",
          requestId: "1".repeat(32),
          engineBillings: billings,
        },
        persistedHash: persisted,
      }),
      /billingAnchorId mismatch/,
    );
  });
  test("matching envelope and persisted hash equal to canonical is accepted", () => {
    const hash = settlementAuthorityHash({
      billingAnchorId: canonical.canonicalAnchorId,
      requestId: canonical.canonicalRequestId,
      engineBillings: billings,
    });
    assert.equal(
      assertSettlementMatchesCanonical({
        ...canonical,
        envelope: {
          billingAnchorId: canonical.canonicalAnchorId,
          requestId: canonical.canonicalRequestId,
          engineBillings: billings,
        },
        persistedHash: hash,
      }),
      hash,
    );
  });
});
