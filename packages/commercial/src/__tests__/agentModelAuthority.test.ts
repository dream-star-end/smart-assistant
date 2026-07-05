import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CODEX_ENGINE_MODEL } from "@openclaude/protocol";

import { PLATFORM_DEFAULT_MODEL, PLATFORM_HIDDEN_REVIEWER_MODEL } from "../platformDefaults.js";
import { buildAgentModelSnapshot } from "../ws/agentModelAuthority.js";

describe("agentModelAuthority builtin seed mirror", () => {
  test("master snapshot includes all runtime builtin seed agents", () => {
    const snapshot = buildAgentModelSnapshot([], []);

    assert.equal(snapshot.get("main"), PLATFORM_DEFAULT_MODEL);
    assert.equal(snapshot.get("codex"), DEFAULT_CODEX_ENGINE_MODEL);
    assert.equal(snapshot.get("hidden-reviewer"), PLATFORM_HIDDEN_REVIEWER_MODEL);
  });
});
