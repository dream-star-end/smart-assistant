import assert from "node:assert/strict";
import test from "node:test";
import { assembleIdleArtifact } from "../../boxIdleCompact.js";
import { assertRecoveredContent } from "./idleCrashFixture.js";

test("recovery oracle is pinned to prepared tools and images, not recovered metadata", () => {
  const tail = [
    { uuid: "a", parentUuid: null, message: { uuid: "a", type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "call", name: "Read", input: { file_path: "a" } }] } } },
    { uuid: "u", parentUuid: "a", message: { uuid: "u", type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: "body" }, { type: "image", source: { type: "base64", data: "test-image" } }] } } },
  ];
  const frozen = { opId: "same-op", sessionId: "same-session", revision: "same-revision", summaryText: "summary", modelCalls: 1, frozenTail: tail, attachments: [] };
  const native = { ...structuredClone(frozen), applied: true, artifact: assembleIdleArtifact({ opId: frozen.opId, summaryText: frozen.summaryText, tail, attachments: [] }) };
  const prefix = [{ uuid: "boundary", type: "system", subtype: "compact_boundary", compactMetadata: { idleOpId: frozen.opId } }, { uuid: "summary", type: "user", isCompactSummary: true, message: { content: frozen.summaryText } }];
  const loaded = [...prefix, ...tail.map(row => row.message)];
  assert.doesNotThrow(() => assertRecoveredContent(loaded, native, frozen));
  const dropped = structuredClone(native); dropped.frozenTail = [];
  assert.throws(() => assertRecoveredContent(prefix, dropped, frozen), /immutable prepared frozenTail/);
  const changed = structuredClone(native); changed.frozenTail[1]!.message.message.content = [];
  assert.throws(() => assertRecoveredContent(prefix, changed, frozen), /immutable prepared frozenTail/);
  assert.throws(() => assertRecoveredContent([...prefix, ...tail.map(row => row.message).reverse()], native, frozen), /preserved UUIDs/);
  const missing = structuredClone(loaded); missing.pop();
  assert.throws(() => assertRecoveredContent(missing, native, frozen), /preserved UUIDs/);
});
