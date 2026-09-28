import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { deriveBoxContextHash } from "./boxCallFingerprint.js";
import { hashBoxToolInput } from "./boxToolInputHash.js";
import { comparableAssistantContent } from "./boxToolInputEcho.js";
import { matchBoxToolResults } from "./boxToolResultMatcher.js";
import { compileBoxToolCatalog } from "./boxToolCatalog.js";
import { hashAssistantClaimViews } from "./boxCallFingerprint.js";

const WIRE = [
  "/home/agent/.openclaude/generated/ocv5-294-parallel-wire-571ebfc5862ed73a.json",
  "/var/lib/docker/volumes/oc-v5-data-u3/_data/generated/ocv5-294-parallel-wire-571ebfc5862ed73a.json",
].find((path) => existsSync(path)) ?? "";
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

test("sealed omit wire is red without a bound catalog and matched with it", () => {
  const wire = JSON.parse(readFileSync(WIRE, "utf8")) as {
    bodies: Array<{ tools?: unknown; messages?: unknown }>;
    sent: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  };
  const body = wire.bodies[2]!;
  const edits = wire.sent.filter((item) => item.name === "Edit");
  const expected = edits.map((item) => ({
    id: item.id, clientName: item.name, boxName: "mcp__ocbridge__t0",
    inputHash: hashBoxToolInput(item.input),
  }));
  assert.equal(Object.hasOwn(edits[0]!.input, "replace_all"), false);
  assert.throws(() => matchBoxToolResults(body as never, expected),
    /BOX_TOOL_RESULT_HISTORY_MISMATCH/);
  const catalog = compileBoxToolCatalog(body.tools);
  const before = JSON.stringify(body);
  const ctx = deriveBoxContextHash(body as never);
  const ctxTail = deriveBoxContextHash(body as never, true);
  const matched = matchBoxToolResults(body as never, expected, catalog);
  assert.equal(matched.length, 2);
  assert.equal(JSON.stringify(body), before);
  assert.equal(deriveBoxContextHash(body as never), ctx);
  assert.equal(deriveBoxContextHash(body as never, true), ctxTail);
  assert.equal(ctx, "cade164057d205a90d8e0b67833400cca04b38d5adf69dd378946fa624628f86");
  assert.equal(ctxTail, "7e17624b9324ebfd939d734c078985f196cc2d827c17c06d7fce38ff098a3c5a");
  const assistant = [...(body.messages as Array<{ role?: string; content?: unknown[] }>)]
    .reverse().find((message) => message.role === "assistant")!;
  const stored = assistant.content!.map((block) => {
    if (!block || typeof block !== "object" || (block as { type?: string }).type !== "tool_use") return block;
    const id = (block as { id: string }).id;
    const sent = edits.find((item) => item.id === id)!;
    return { ...(block as object), input: sent.input };
  });
  const view = comparableAssistantContent(assistant.content, expected, catalog);
  const got = hashAssistantClaimViews(view);
  const want = hashAssistantClaimViews(stored);
  assert.equal(got.full, want.full);
  assert.equal(got.noCaller, want.noCaller);
  assert.equal(got.echo, want.echo);
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
