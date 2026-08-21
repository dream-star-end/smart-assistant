import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import {
  assertSettlementMatchesCanonical,
  classifyUnifiedTimelineIntegrityError,
  clipVisibleText,
  phaseAVisibleHeadText,
  pickTapeDisplayFallbackText,
  resetTapeDisplayDegradeLogForTests,
  sanitizeJsonBytesForPgJsonb,
  sanitizeValueForPgJsonb,
  settlementAuthorityHash,
  settlementPayloadEqual,
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

  test("ignores object key insertion order recursively", () => {
    const left = [{ requestId: "r1", usage: { output_tokens: 2, input_tokens: 1 }, status: "success" }];
    const right = [{ status: "success", usage: { input_tokens: 1, output_tokens: 2 }, requestId: "r1" }];
    assert.equal(settlementPayloadEqual(left, right), true);
    assert.equal(
      settlementAuthorityHash({ billingAnchorId: "a", requestId: "r1", engineBillings: left }),
      settlementAuthorityHash({ billingAnchorId: "a", requestId: "r1", engineBillings: right }),
    );
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
  test("empty settlement text falls back to live frames", () => {
    assert.equal(phaseAVisibleHeadText({
      hasSettlement: true,
      settlementText: "",
      liveFrameText: "partial from frames",
    }), "partial from frames");
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
  test("legacy order-sensitive hash is upgraded only when structured authority matches", () => {
    const legacyBillings = [{ model: "x", requestId: "1".repeat(32) }];
    const legacyHash = createHash("sha256").update(JSON.stringify({
      billingAnchorId: canonical.canonicalAnchorId,
      requestId: canonical.canonicalRequestId,
      engineBillings: legacyBillings,
    })).digest("hex");
    const stableHash = settlementAuthorityHash({
      billingAnchorId: canonical.canonicalAnchorId,
      requestId: canonical.canonicalRequestId,
      engineBillings: billings,
    });
    assert.notEqual(legacyHash, stableHash);
    assert.equal(
      assertSettlementMatchesCanonical({
        ...canonical,
        persistedHash: legacyHash,
        persistedAuthority: {
          billingAnchorId: canonical.canonicalAnchorId,
          requestId: canonical.canonicalRequestId,
          engineBillings: legacyBillings,
        },
      }),
      stableHash,
    );
    assert.throws(
      () => assertSettlementMatchesCanonical({
        ...canonical,
        persistedHash: legacyHash,
        persistedAuthority: {
          billingAnchorId: canonical.canonicalAnchorId,
          requestId: "wrong",
          engineBillings: legacyBillings,
        },
      }),
      /settlement hash mismatch/,
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

describe("tape display degrade helpers", () => {
  test("classify maps hydrate-chain integrity errors", () => {
    assert.equal(
      classifyUnifiedTimelineIntegrityError(new Error("[pgSessions] unified timeline tape record missing: t\\00")),
      "record_missing",
    );
    assert.equal(
      classifyUnifiedTimelineIntegrityError(new Error("[pgSessions] unified timeline visible payload hash mismatch: t")),
      "visible_payload_hash_mismatch",
    );
    assert.equal(
      classifyUnifiedTimelineIntegrityError(new Error("[pgSessions] unified timeline record malformed: t")),
      "record_malformed",
    );
    assert.equal(
      classifyUnifiedTimelineIntegrityError(new Error("[pgSessions] unified timeline record JSON invalid: t: not object")),
      "record_json_invalid",
    );
    assert.equal(
      classifyUnifiedTimelineIntegrityError(new Error("[pgSessions] unified timeline hydrated group missing")),
      "hydrated_group_missing",
    );
    assert.equal(
      classifyUnifiedTimelineIntegrityError(new Error("[pgSessions] unified timeline finalized tape missing: t")),
      "finalized_tape_missing",
    );
    assert.equal(
      classifyUnifiedTimelineIntegrityError(new Error("[pgSessions] unified timeline tape hash mismatch: t")),
      "tape_hash_mismatch",
    );
  });

  test("fallback prefers visible_head, then anchor, then placeholder", () => {
    assert.deepEqual(
      pickTapeDisplayFallbackText({ visibleHead: { text: "full visible head" }, anchorText: "first sentence" }),
      { text: "full visible head", source: "visible_head" },
    );
    assert.deepEqual(
      pickTapeDisplayFallbackText({ visibleHead: { text: "" }, anchorText: "anchor body" }),
      { text: "anchor body", source: "anchor" },
    );
    assert.equal(pickTapeDisplayFallbackText({}).source, "placeholder");
    assert.equal(
      pickTapeDisplayFallbackText({ reason: "records_unpublished" }).text,
      "过程记录正在整理，稍后会自动补齐思考与工具卡片。",
    );
    assert.match(
      pickTapeDisplayFallbackText({ reason: "records_failed" }).text,
      /物化异常/,
    );
  });

  test("sanitizeJsonBytesForPgJsonb strips NUL and unpaired surrogates", () => {
    resetTapeDisplayDegradeLogForTests();
    const sqliteDump = { tool: "Read", dump: "SQLite format 3\u0000page" };
    const raw = Buffer.from(JSON.stringify(sqliteDump), "utf8");
    const sanitized = sanitizeJsonBytesForPgJsonb(raw);
    assert.equal(sanitized.changed, true);
    assert.equal(sanitized.bytes.includes(0), false);
    const parsed = JSON.parse(sanitized.bytes.toString("utf8")) as { dump: string };
    assert.equal(parsed.dump.includes("\u0000"), false);
    assert.equal(parsed.dump.includes("\uFFFD"), true);
    const lone = sanitizeValueForPgJsonb("ok\uD800end");
    assert.equal(lone, "ok\uFFFDend");
  });
});
