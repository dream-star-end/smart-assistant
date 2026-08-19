import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  losslessBillingAnchorId,
  losslessRecordPrefix,
  LOSSLESS_TURN_TAPE_LEGACY_AGENT_ID,
} from "../losslessTurnTape.js";

describe("losslessBillingAnchorId", () => {
  test("matches materializeLosslessTurn prefix and last segment id", () => {
    assert.equal(losslessRecordPrefix("sess-1", "main", 5), "srv-sess-1-main-t5");
    assert.equal(
      losslessBillingAnchorId({
        sessionId: "sess-1",
        agentId: "main",
        turnIndex: 5,
        assistantSegments: [{ index: 0 }, { index: 1 }],
      }),
      "srv-sess-1-main-t5-s1",
    );
    assert.equal(
      losslessBillingAnchorId({
        sessionId: "sess-1",
        agentId: "main",
        turnIndex: 5,
        text: "hello",
      }),
      "srv-sess-1-main-t5",
    );
    assert.equal(
      losslessRecordPrefix("sess-1", LOSSLESS_TURN_TAPE_LEGACY_AGENT_ID, 2),
      "srv-sess-1-t2",
    );
  });
});
