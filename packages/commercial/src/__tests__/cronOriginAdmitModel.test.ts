/**
 * Origin-session cron must stamp the conversation model, not the process default.
 * Run: npx tsx --test packages/commercial/src/__tests__/cronOriginAdmitModel.test.ts
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { resolveCronOriginAdmitModel } from "../ws/userChatBridge.js";

describe("resolveCronOriginAdmitModel", () => {
  test("keeps a grok-build origin session on grok-build", () => {
    assert.equal(resolveCronOriginAdmitModel("grok-build"), "grok-build");
  });

  test("trims whitespace", () => {
    assert.equal(resolveCronOriginAdmitModel("  glm-5.3-zai  "), "glm-5.3-zai");
  });

  test("falls back when the session has no model", () => {
    assert.equal(resolveCronOriginAdmitModel(null), null);
    assert.equal(resolveCronOriginAdmitModel(undefined), null);
    assert.equal(resolveCronOriginAdmitModel(""), null);
    assert.equal(resolveCronOriginAdmitModel("   "), null);
  });

  test("rejects values that cannot be a dispatch model", () => {
    assert.equal(resolveCronOriginAdmitModel("bad model"), null);
    assert.equal(resolveCronOriginAdmitModel("a".repeat(65)), null);
    assert.equal(resolveCronOriginAdmitModel("glm/5.3"), null);
  });
});
