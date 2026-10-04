import assert from "node:assert/strict";
import test from "node:test";
import * as finger from "./boxCallFingerprint.js";
import { deriveBoxContextHash, hashBoxAssistantContent, hashBoxAssistantEchoContent,
  hashBoxAssistantNoCallerContent, incomingAssistantAccepted } from "./boxCallFingerprint.js";
import { hashBoxToolInput } from "./boxToolInputHash.js";
import { comparableAssistantContent } from "./boxToolInputEcho.js";
import { matchBoxToolResults } from "./boxToolResultMatcher.js";
import { compileBoxToolCatalog } from "./boxToolCatalog.js";
const editSchema = {
  type: "object",
  required: ["file_path", "old_string", "new_string"],
  properties: {
    file_path: { type: "string" }, old_string: { type: "string" },
    new_string: { type: "string" }, replace_all: { type: "boolean", default: false },
  },
};
function editTool(schema: Record<string, unknown> = editSchema) {
  return { name: "Edit", description: "edit", input_schema: schema };
}
function readTool() {
  return { name: "Read", description: "read", input_schema: {
    type: "object", required: ["file_path"],
    properties: { file_path: { type: "string" }, replace_all: { type: "boolean", default: false } },
  } };
}

test("binding hash covers replace_all type, default and required", () => {
  const base = compileBoxToolCatalog([editTool()]);
  const changedDefault = structuredClone(editSchema);
  (changedDefault.properties.replace_all as { default: unknown }).default = true;
  const required = structuredClone(editSchema);
  required.required = [...editSchema.required, "replace_all"];
  const changedType = structuredClone(editSchema);
  (changedType.properties.replace_all as { type: string }).type = "string";
  assert.notEqual(compileBoxToolCatalog([editTool(changedDefault)]).bindingSha256, base.bindingSha256);
  assert.notEqual(compileBoxToolCatalog([editTool(required)]).bindingSha256, base.bindingSha256);
  assert.notEqual(compileBoxToolCatalog([editTool(changedType)]).bindingSha256, base.bindingSha256);
});

test("mixed omit and false match, and a tampered caller is not stripped into acceptance", () => {
  const catalog = compileBoxToolCatalog([editTool()]);
  const plain = { file_path: "/tmp/synthetic/a.txt", old_string: "left", new_string: "right" };
  const explicit = { ...plain, replace_all: false as const };
  const stored = [
    { type: "tool_use", id: "toolu_mix_a", name: "Edit", input: plain },
    { type: "tool_use", id: "toolu_mix_b", name: "Edit", input: explicit,
      caller: { type: "direct" } },
  ];
  const echoed = [
    { type: "tool_use", id: "toolu_mix_a", name: "Edit", input: explicit },
    { type: "tool_use", id: "toolu_mix_b", name: "Edit", input: { ...plain, replace_all: false },
      caller: { type: "direct" } },
  ];
  const expected = [
    { id: "toolu_mix_a", clientName: "Edit", boxName: "mcp__ocbridge__t0",
      inputHash: hashBoxToolInput(plain) },
    { id: "toolu_mix_b", clientName: "Edit", boxName: "mcp__ocbridge__t0",
      inputHash: hashBoxToolInput(explicit) },
  ];
  const body = { model: "box-api-claude-opus-5-5", messages: [
    { role: "user", content: "go" },
    { role: "assistant", content: echoed },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_mix_a", content: "ok" },
      { type: "tool_result", tool_use_id: "toolu_mix_b", content: "ok" },
    ] },
  ] };
  const snapshot = JSON.stringify(body);
  assert.throws(() => matchBoxToolResults(body as never, expected), /BOX_TOOL_RESULT_HISTORY_MISMATCH/);
  assert.equal(matchBoxToolResults(body as never, expected, catalog).length, 2);
  assert.equal(JSON.stringify(body), snapshot);
  const ctx = deriveBoxContextHash(body as never);
  assert.equal(deriveBoxContextHash(body as never), ctx);
  assert.equal(deriveBoxContextHash(body as never, true), deriveBoxContextHash(body as never, true));
  const view = comparableAssistantContent(echoed, expected, catalog);
  const storedHashes = {
    assistantContentHash: hashBoxAssistantContent(stored),
    assistantNoCallerHash: hashBoxAssistantNoCallerContent(stored),
    assistantEchoHash: hashBoxAssistantEchoContent(stored),
  };
  assert.equal(hashBoxAssistantContent(view), storedHashes.assistantContentHash);
  assert.equal(incomingAssistantAccepted(view, storedHashes), true);
  const tampered = echoed.map((block, index) => index === 1
    ? { ...block, caller: { type: "changed" } } : block);
  const tamperedView = comparableAssistantContent(tampered, expected, catalog);
  const oldPredicate = hashBoxAssistantNoCallerContent(tamperedView) === storedHashes.assistantNoCallerHash;
  assert.equal(oldPredicate, true);
  assert.equal(incomingAssistantAccepted(tamperedView, storedHashes), false);
});

test("explicit false stays matched and strict negatives stay red", () => {
  const catalog = compileBoxToolCatalog([readTool(), editTool()]);
  const plain = { file_path: "/tmp/a", old_string: "o", new_string: "n" };
  const explicit = { ...plain, replace_all: false as const };
  const body = (input: Record<string, unknown>, name = "Edit") => ({
    model: "box-api-claude-opus-5-5",
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_one", name, input }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_one", content: "ok" }] },
    ],
  });
  assert.equal(matchBoxToolResults(body(explicit) as never, [{
    id: "toolu_one", clientName: "Edit", boxName: "mcp__ocbridge__t0", inputHash: hashBoxToolInput(explicit),
  }], catalog).length, 1);
  assert.equal(matchBoxToolResults(body(explicit) as never, [{
    id: "toolu_one", clientName: "Edit", boxName: "mcp__ocbridge__t0", inputHash: hashBoxToolInput(plain),
  }], catalog).length, 1);
  for (const bad of [
    { ...plain, replace_all: true },
    { ...plain, replace_all: "false" },
    { ...plain, replace_all: null },
    { ...plain, replace_all: 0 },
    { ...explicit, extra: true },
  ]) {
    assert.throws(() => matchBoxToolResults(body(bad as Record<string, unknown>) as never, [{
      id: "toolu_one", clientName: "Edit", boxName: "mcp__ocbridge__t0", inputHash: hashBoxToolInput(plain),
    }], catalog), /BOX_TOOL_RESULT_HISTORY_MISMATCH/);
  }
  assert.throws(() => matchBoxToolResults(body(explicit, "Read") as never, [{
    id: "toolu_one", clientName: "Read", boxName: "mcp__ocbridge__t0", inputHash: hashBoxToolInput(plain),
  }], catalog), /BOX_TOOL_RESULT_HISTORY_MISMATCH/);
  const unbound = compileBoxToolCatalog([editTool({
    ...editSchema, properties: { ...editSchema.properties, replace_all: { type: "boolean" } },
  })]);
  assert.throws(() => matchBoxToolResults(body(explicit) as never, [{
    id: "toolu_one", clientName: "Edit", boxName: "mcp__ocbridge__t0", inputHash: hashBoxToolInput(plain),
  }], unbound), /BOX_TOOL_RESULT_HISTORY_MISMATCH/);
});

/** ea572999 compared hashBoxAssistantNoCallerContent(incoming) to the stored
 * noCaller digest, so a different caller still matched. Production must not. */
function ea572999Accepted(content: unknown, stored: {
  assistantContentHash: string; assistantNoCallerHash?: string; assistantEchoHash?: string;
}): boolean {
  const fullHash = hashBoxAssistantContent(content);
  const noCaller = hashBoxAssistantNoCallerContent(content);
  const echo = hashBoxAssistantEchoContent(content);
  const echoed = Array.isArray(content) && content.every((block) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return true;
    const type = (block as { type?: unknown }).type;
    return type !== "thinking" && type !== "redacted_thinking";
  });
  return fullHash === stored.assistantContentHash
    || (!!stored.assistantNoCallerHash && (fullHash === stored.assistantNoCallerHash
      || noCaller === stored.assistantNoCallerHash))
    || (echoed && !!stored.assistantEchoHash && (fullHash === stored.assistantEchoHash
      || echo === stored.assistantEchoHash));
}

test("full hash of the selected copy is the only claim acceptance input", () => {
  assert.equal("hashAssistantClaimViews" in finger, false);
  const catalog = compileBoxToolCatalog([editTool()]);
  const plain = { file_path: "/tmp/synthetic/a.txt", old_string: "left", new_string: "right" };
  const stored = [{ type: "tool_use", id: "toolu_keep", name: "Edit", input: plain,
    caller: { type: "direct" }, provider_meta: "keep" }];
  const storedHashes = {
    assistantContentHash: hashBoxAssistantContent(stored),
    assistantNoCallerHash: hashBoxAssistantNoCallerContent(stored),
    assistantEchoHash: hashBoxAssistantEchoContent(stored),
  };
  const echoed = [{ type: "tool_use", id: "toolu_keep", name: "Edit", input: { ...plain, replace_all: false },
    provider_meta: "keep" }];
  const expected = [{ id: "toolu_keep", clientName: "Edit", boxName: "mcp__ocbridge__t0",
    inputHash: hashBoxToolInput(plain) }];
  const view = comparableAssistantContent(echoed, expected, catalog);
  assert.equal(hashBoxAssistantContent(view), storedHashes.assistantNoCallerHash);
  assert.notEqual(hashBoxAssistantContent(view), storedHashes.assistantContentHash);
  assert.notEqual(hashBoxAssistantContent(view), storedHashes.assistantEchoHash);
  assert.equal(incomingAssistantAccepted(view, storedHashes), true);
  const tampered = [{ ...echoed[0], caller: { type: "changed" } }];
  const tamperedView = comparableAssistantContent(tampered, expected, catalog);
  assert.equal(ea572999Accepted(tamperedView, storedHashes), true);
  assert.equal(incomingAssistantAccepted(tamperedView, storedHashes), false);
  const thought = [
    { type: "thinking", thinking: "note", signature: "sig-a" },
    { type: "tool_use", id: "toolu_keep", name: "Edit", input: plain, caller: { type: "direct" } },
  ];
  const thoughtHashes = {
    assistantContentHash: hashBoxAssistantContent(thought),
    assistantNoCallerHash: hashBoxAssistantNoCallerContent(thought),
    assistantEchoHash: hashBoxAssistantEchoContent(thought),
  };
  const thoughtEcho = [{ type: "tool_use", id: "toolu_keep", name: "Edit",
    input: { ...plain, replace_all: false } }];
  const thoughtView = comparableAssistantContent(thoughtEcho, expected, catalog);
  assert.equal(hashBoxAssistantContent(thoughtView), thoughtHashes.assistantEchoHash);
  assert.equal(incomingAssistantAccepted(thoughtView, thoughtHashes), true);
  const signed = [
    { type: "thinking", thinking: "note", signature: "sig-b" },
    { type: "tool_use", id: "toolu_keep", name: "Edit", input: plain, caller: { type: "direct" } },
  ];
  assert.equal(incomingAssistantAccepted(
    comparableAssistantContent(signed, expected, catalog), thoughtHashes), false);
  const redacted = [{ type: "redacted_thinking", data: "opaque" }, ...thoughtEcho];
  const redactedView = comparableAssistantContent(redacted, expected, catalog);
  assert.equal(hashBoxAssistantEchoContent(redactedView), thoughtHashes.assistantEchoHash);
  assert.equal(incomingAssistantAccepted(redactedView, thoughtHashes), false);
});
