import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DESKTOP_ENGINE_NOT_ENABLED,
  classifyDesktopPath,
} from "../http/desktopInternalDispatch.js";
import { CODEX_RELAY_PREFIX, GROK_RELAY_PREFIX, ZCODE_RELAY_PREFIX } from "@openclaude/protocol";
import { desktopAllowsEngine } from "../ws/containerTransportKind.js";

describe("desktop 18445 whitelist", () => {
  test("allows P1 paths", () => {
    assert.equal(classifyDesktopPath("POST", "/v1/messages"), "messages");
    assert.equal(classifyDesktopPath("POST", "/internal/v3/server-authored-message"), "serverAuthored");
    assert.equal(classifyDesktopPath("GET", "/internal/v3/turn-tape-state"), "turnTape");
    assert.equal(classifyDesktopPath("POST", "/internal/v3/turn-lease/renew"), "turnLease");
    assert.equal(classifyDesktopPath("GET", "/internal/v3/model-catalog"), "catalog");
    assert.equal(classifyDesktopPath("GET", "/internal/v3/model-catalog-epoch"), "catalogEpoch");
  });

  test("Grok/Codex/ZCode prefixes are engine_disabled (no relay registered)", () => {
    assert.equal(classifyDesktopPath("POST", GROK_RELAY_PREFIX), "engine_disabled");
    assert.equal(classifyDesktopPath("POST", `${CODEX_RELAY_PREFIX}/x`), "engine_disabled");
    assert.equal(classifyDesktopPath("POST", `${ZCODE_RELAY_PREFIX}/y`), "engine_disabled");
    assert.equal(DESKTOP_ENGINE_NOT_ENABLED, "ENGINE_NOT_ENABLED");
  });

  test("W-01 desktop only allows ccb", () => {
    assert.equal(desktopAllowsEngine(false, "grok"), true);
    assert.equal(desktopAllowsEngine(true, "ccb"), true);
    assert.equal(desktopAllowsEngine(true, "grok"), false);
    assert.equal(desktopAllowsEngine(true, "cursor"), false);
  });

  test("everything else 404", () => {
    assert.equal(classifyDesktopPath("POST", "/internal/v5/foo"), "not_found");
    assert.equal(classifyDesktopPath("GET", "/v1/messages"), "not_found");
    assert.equal(classifyDesktopPath("POST", "/api/desktop/enroll/start"), "not_found");
  });
});
