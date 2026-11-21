import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEFAULT_BRIDGE_MAX_FRAME_BYTES,
  MAX_BRIDGE_MAX_FRAME_BYTES,
  resolveBridgeMaxFrameBytes,
} from "./bridgeFrameBudget.js";

describe("bridgeFrameBudget (OCV5-825 B1)", () => {
  test("defaults to 16 MiB matching container gateway and supports OC_WS_MAX_PAYLOAD_BYTES override", () => {
    assert.equal(DEFAULT_BRIDGE_MAX_FRAME_BYTES, 16 * 1024 * 1024);
    assert.equal(resolveBridgeMaxFrameBytes({}), DEFAULT_BRIDGE_MAX_FRAME_BYTES);
    assert.equal(
      resolveBridgeMaxFrameBytes({ OC_WS_MAX_PAYLOAD_BYTES: String(32 * 1024 * 1024) }),
      32 * 1024 * 1024,
    );
    assert.equal(
      resolveBridgeMaxFrameBytes({ OC_WS_MAX_PAYLOAD_BYTES: "1024" }),
      DEFAULT_BRIDGE_MAX_FRAME_BYTES,
    );
    assert.equal(
      resolveBridgeMaxFrameBytes({ OC_WS_MAX_PAYLOAD_BYTES: String(999 * 1024 * 1024) }),
      MAX_BRIDGE_MAX_FRAME_BYTES,
    );
  });
});
