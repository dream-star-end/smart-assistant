import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCapabilityProfile } from "../../billing/modelCatalog.js";
import {
  BOX_NATIVE_CONTEXT_ROUTE_READY,
  getBoxNativeContextOwner,
  selectBoxNativeByteBudget,
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
    const gate = {
      authorityKind: "bridge_signed" as const,
      verifiedSignedContextOwner: on.contextOwner,
      descriptor: {
        canonicalModel: "box-api-claude-opus-5-5",
        providerId: "box_cli",
        capabilityProfile: { ccb: { contextOwner: on.contextOwner } },
      },
    };
    assert.equal(getBoxNativeContextOwner(gate, { kind: "box" }), null);
    assert.equal(getBoxNativeContextOwner(gate, { kind: "box" }, true), "box-native-v1");
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
    const declaredGate = {
      verifiedSignedContextOwner: "box-native-v1" as const,
      descriptor: {
        canonicalModel: "box-api-claude-opus-5-5",
        providerId: "box_cli",
        capabilityProfile: { ccb: { contextOwner: "box-native-v1" } },
      },
    };
    const localGate = { ...declaredGate, authorityKind: "local_catalog" as const, verifiedSignedContextOwner: null };
    assert.equal(getBoxNativeContextOwner(localGate, { kind: "box" }, true), null);
    const localBudget = {
      authorityKind: "local_catalog" as const,
      routeKind: "box",
      canonicalModel: "box-api-claude-opus-5-5",
      providerId: "box_cli",
      declaredContextOwner: "box-native-v1",
      verifiedSignedContextOwner: null,
      routeReady: true,
      containerId: 7n,
      externalApiKey: false,
      transportConfigured: true,
    };
    assert.equal(selectBoxNativeByteBudget(localBudget), "box-native-v1");
    assert.equal(selectBoxNativeByteBudget({ ...localBudget, routeReady: false }), "legacy");
    assert.equal(selectBoxNativeByteBudget({ ...localBudget, externalApiKey: true }), "legacy");
    assert.equal(selectBoxNativeByteBudget({ ...localBudget, containerId: null }), "legacy");
    assert.equal(selectBoxNativeByteBudget({ ...localBudget, transportConfigured: false }), "legacy");
    assert.equal(selectBoxNativeByteBudget({ ...localBudget, declaredContextOwner: "client-said" }), "legacy");
    assert.equal(selectBoxNativeByteBudget({ ...localBudget, providerId: "ark" }), "legacy");
    assert.equal(selectBoxNativeByteBudget({
      ...localBudget,
      verifiedSignedContextOwner: "box-native-v1",
    }), "box-native-v1");
    assert.equal(getBoxNativeContextOwner({
      ...localGate,
      verifiedSignedContextOwner: "box-native-v1",
    }, { kind: "box" }, true), null);
    assert.equal(getBoxNativeContextOwner(
      { ...declaredGate, authorityKind: "bridge_signed", verifiedSignedContextOwner: null },
      { kind: "box" },
      true,
    ), null);
    assert.equal(getBoxNativeContextOwner(
      { ...declaredGate, authorityKind: "bridge_signed" },
      { kind: "static" },
      true,
    ), null);
    assert.equal(getBoxNativeContextOwner(
      {
        authorityKind: "bridge_signed",
        verifiedSignedContextOwner: "box-native-v1",
        descriptor: {
          canonicalModel: "box-api-claude-opus-5-5",
          providerId: "box_cli",
          capabilityProfile: { ccb: { contextOwner: "fake" } },
        },
      },
      { kind: "box" },
      true,
    ), null);
  });
});
