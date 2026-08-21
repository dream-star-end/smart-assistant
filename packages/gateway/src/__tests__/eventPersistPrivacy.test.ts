import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ToolCalledEvent } from "@openclaude/protocol";

import { serializeEventForPersistence } from "../eventPersist.js";

const saved = process.env.OC_REDACT_TOOL_EVENT_PREVIEWS;
afterEach(() => {
  if (saved === undefined) delete process.env.OC_REDACT_TOOL_EVENT_PREVIEWS;
  else process.env.OC_REDACT_TOOL_EVENT_PREVIEWS = saved;
});

test("commercial privacy mode drops tool input/output previews before SQLite persistence", () => {
  process.env.OC_REDACT_TOOL_EVENT_PREVIEWS = "1";
  const raw = serializeEventForPersistence({
    id: "tool-1", type: "tool.called", schemaVersion: 1, timestamp: 1,
    agentId: "main", sessionKey: "s", turnIndex: 1, toolName: "Bash",
    durationMs: 2, isError: true, inputPreview: "secret command", outputPreview: "secret output",
  } as ToolCalledEvent);
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  assert.equal(parsed.toolName, "Bash");
  assert.equal("inputPreview" in parsed, false);
  assert.equal("outputPreview" in parsed, false);
});
