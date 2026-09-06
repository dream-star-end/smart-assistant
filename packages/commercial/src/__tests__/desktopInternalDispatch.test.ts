import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DESKTOP_ENGINE_NOT_ENABLED,
  classifyDesktopPath,
  desktopRuntimeManifestAction,
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

  test("Grok/Codex/ZCode prefixes are 404 on the TLS face (W-01; 403 stays on turn admission)", () => {
    assert.equal(classifyDesktopPath("POST", GROK_RELAY_PREFIX), "not_found");
    assert.equal(classifyDesktopPath("POST", `${CODEX_RELAY_PREFIX}/x`), "not_found");
    assert.equal(classifyDesktopPath("POST", `${ZCODE_RELAY_PREFIX}/y`), "not_found");
    assert.equal(DESKTOP_ENGINE_NOT_ENABLED, "ENGINE_NOT_ENABLED");
  });

  test("token mint/refresh are master whitelist paths", () => {
    assert.equal(classifyDesktopPath("POST", "/api/desktop/token"), "tokenMint");
    assert.equal(classifyDesktopPath("POST", "/api/desktop/token/refresh"), "tokenRefresh");
    assert.equal(classifyDesktopPath("GET", "/api/desktop/token"), "not_found");
  });

  test("runtime-manifest GET is whitelisted on 18445; other methods/bootstrap are not", () => {
    assert.equal(classifyDesktopPath("GET", "/api/desktop/runtime-manifest"), "runtimeManifest");
    assert.equal(classifyDesktopPath("POST", "/api/desktop/runtime-manifest"), "not_found");
    assert.equal(classifyDesktopPath("PUT", "/api/desktop/runtime-manifest"), "not_found");
    assert.equal(classifyDesktopPath("GET", "/api/desktop/bootstrap"), "not_found");
    assert.equal(desktopRuntimeManifestAction("master", "runtimeManifest"), "handle");
    assert.equal(desktopRuntimeManifestAction("egress", "runtimeManifest"), "not_found");
    assert.equal(desktopRuntimeManifestAction("master", "tokenMint"), "not_found");
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
