import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { annotationsForLastHandoff, B1_BASH_HOOK, checkMatchedContent,
  classifySystemText, PROGRESS_SENTENCE } from "./matchedContentOracle.ts";
import { matchBoxToolResults } from "../../packages/commercial/src/http/proxy/boxToolResultMatcher.ts";

const budget = "<total_tokens>14999985 tokens left</total_tokens>";
const toolText = "ocv5-294-sed-line\n";

function hashOf(content: Array<{ type: string; text: string }>, isError = false): string {
  return createHash("sha256").update(JSON.stringify({ content, isError })).digest("hex");
}
function mcpSha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

test("supported hook and progress bytes are exact, and unknown text is not telemetry", () => {
  assert.equal(classifySystemText(budget).kind, "budget");
  assert.deepEqual(classifySystemText(`${B1_BASH_HOOK}\n\n${budget}`),
    { kind: "annotation", source: "b1-bash-hook" });
  assert.deepEqual(classifySystemText(`${PROGRESS_SENTENCE}\n\n${budget}`),
    { kind: "annotation", source: "ccb-silent-turn-progress" });
  assert.equal(classifySystemText(`hello\n\n${budget}`).kind, "unknown");
  assert.equal(classifySystemText(`${PROGRESS_SENTENCE}!\n\n${budget}`).kind, "unknown");
  assert.equal(classifySystemText(`${B1_BASH_HOOK}\n\n${budget}\nextra`).kind, "unknown");
});

test("the oracle binds the MCP body and one pinned annotation, rejecting copies and edits", () => {
  const content = [
    { type: "text", text: toolText },
    { type: "text", text: B1_BASH_HOOK },
  ];
  const ok = { content, isError: false, contentHash: hashOf(content),
    mcpSha256: mcpSha(toolText), toolIndexes: [0],
    annotations: [{ source: "b1-bash-hook" as const, index: 1 }] };
  assert.equal(checkMatchedContent(ok), null);
  const progress = [
    { type: "text", text: toolText },
    { type: "text", text: PROGRESS_SENTENCE },
  ];
  assert.equal(checkMatchedContent({ ...ok, content: progress, contentHash: hashOf(progress),
    annotations: [{ source: "ccb-silent-turn-progress", index: 1 }] }), null);
  assert.equal(checkMatchedContent({ ...ok, content: [content[0]!],
    contentHash: hashOf([content[0]!]) }), "ANNOTATION_POSITION");
  assert.equal(checkMatchedContent({ ...ok, content: [...content, { type: "text", text: B1_BASH_HOOK }],
    contentHash: hashOf([...content, { type: "text", text: B1_BASH_HOOK }]) }), "ANNOTATION_UNKNOWN");
  const tampered = [{ type: "text", text: toolText }, { type: "text", text: `${B1_BASH_HOOK} ` }];
  assert.equal(checkMatchedContent({ ...ok, content: tampered, contentHash: hashOf(tampered) }),
    "ANNOTATION_MISMATCH");
  assert.equal(checkMatchedContent({ ...ok, annotations: [
    { source: "b1-bash-hook", index: 1 }, { source: "b1-bash-hook", index: 1 }] }),
    "ANNOTATION_COUNT");
  assert.equal(checkMatchedContent({ ...ok, mcpSha256: "ab".repeat(32) }), "MCP_BODY");
});

test("a real matcher fold of the B1 hook agrees with the pinned literal, not with a second normalizer pass", () => {
  const marker = { type: "ephemeral" };
  const body = { model: "box-api-claude-opus-5-5", max_tokens: 32, stream: true,
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_ocv5_294_sed",
        name: "local_echo", input: { value: "sed" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_ocv5_294_sed",
        content: toolText }] },
      { role: "system", content: [{ type: "text", text: `${B1_BASH_HOOK}\n\n${budget}`,
        cache_control: marker }] },
    ] };
  const matched = matchBoxToolResults(body, [{ id: "toolu_ocv5_294_sed", clientName: "local_echo",
    boxName: "mcp__ocbridge__t0", input: { value: "sed" } }]);
  const item = matched[0]!;
  const expected = annotationsForLastHandoff(body.messages);
  assert.deepEqual(expected, { annotations: [{ source: "b1-bash-hook", index: 1 }], unknown: false });
  assert.equal(checkMatchedContent({
    content: item.content, isError: item.isError, contentHash: item.contentHash,
    mcpSha256: mcpSha(toolText), toolIndexes: [0], annotations: expected.annotations,
  }), null);
  assert.equal(item.content[1]?.text, B1_BASH_HOOK);
  assert.equal(item.content.filter((block) => block.text === B1_BASH_HOOK).length, 1);
});
