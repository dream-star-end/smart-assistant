import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCapabilityProfile } from "../../billing/modelCatalog.js";
import {
  BOX_NATIVE_CONTEXT_ROUTE_READY,
  getBoxNativeContextOwner,
  signedCcbCapability,
} from "./boxNativeContextOwner.js";

const base = {
  supports_vision: false,
  reasoning: { supported: ["high"], codex_model_default: null },
  ccb: { capability_zero: false, supports_thinking: true },
};

describe("box native context owner", () => {
  it("ready signed box model issues box-native-v1 and the default route is off", () => {
    assert.equal(BOX_NATIVE_CONTEXT_ROUTE_READY, false);
    const declared = parseCapabilityProfile("box-api-claude-opus-5-5", {
      ...base,
      ccb: { ...base.ccb, context_owner: "box-native-v1" },
    });
    assert.equal(declared.ccb.contextOwner, "box-native-v1");
    const off = signedCcbCapability({
      canonicalModel: "box-api-claude-opus-5-5",
      providerId: "box_cli",
      capabilityZero: false,
      supportsThinking: true,
      declaredContextOwner: declared.ccb.contextOwner,
    });
    assert.equal(off.contextOwner, undefined);
    const on = signedCcbCapability({
      canonicalModel: "box-api-claude-opus-5-5",
      providerId: "box_cli",
      capabilityZero: false,
      supportsThinking: true,
      declaredContextOwner: declared.ccb.contextOwner,
      routeReady: true,
    });
    assert.deepEqual(on, {
      capabilityZero: false,
      supportsThinking: true,
      contextOwner: "box-native-v1",
    });
    assert.equal(
      getBoxNativeContextOwner(
        { kind: "bridge_signed", profile: { ccb: { contextOwner: on.contextOwner } } },
        { kind: "box" },
      ),
      "box-native-v1",
    );
  });

  it("wrong model, provider, fake token, and non-box route do not issue or read", () => {
    assert.throws(() => parseCapabilityProfile("box-api-claude-opus-5-5", {
      ...base,
      ccb: { ...base.ccb, context_owner: "body-said-so" },
    }));
    const args = {
      capabilityZero: false,
      supportsThinking: true,
      declaredContextOwner: "box-native-v1",
      routeReady: true,
    };
    assert.equal(signedCcbCapability({
      ...args,
      canonicalModel: "glm-5.2",
      providerId: "box_cli",
    }).contextOwner, undefined);
    assert.equal(signedCcbCapability({
      ...args,
      canonicalModel: "box-api-claude-opus-5-5",
      providerId: "ark",
    }).contextOwner, undefined);
    assert.equal(signedCcbCapability({
      ...args,
      canonicalModel: "box-api-claude-opus-5-5",
      providerId: "box_cli",
      declaredContextOwner: undefined,
    }).contextOwner, undefined);
    assert.equal(getBoxNativeContextOwner(
      { kind: "local_catalog", profile: { ccb: { contextOwner: "box-native-v1" } } },
      { kind: "box" },
    ), null);
    assert.equal(getBoxNativeContextOwner(
      { kind: "bridge_signed", profile: { ccb: { contextOwner: "box-native-v1" } } },
      { kind: "static" },
    ), null);
    assert.equal(getBoxNativeContextOwner(
      { kind: "bridge_signed", profile: { ccb: { contextOwner: "fake" } } },
      { kind: "box" },
    ), null);
  });
});
