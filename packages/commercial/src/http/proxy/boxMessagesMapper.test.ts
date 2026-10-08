import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { compileBoxCliSyntheticTurn, BoxMessagesShapeError } from "./boxMessagesMapper.js";
import type { ProxyBody } from "./shared.js";

const args = { cwd: "/tmp/ocv5-289-run-aaaaaaaaaaaaaaaaaaaaaaaa", cliVersion: "2.1.280" };
function body(messages: unknown[], system?: unknown): ProxyBody {
  return { model: "claude-opus-5-5", max_tokens: 256, messages, ...(system === undefined ? {} : { system }) } as ProxyBody;
}
function code(input: ProxyBody): string {
  try { compileBoxCliSyntheticTurn(input, args); return "ACCEPTED"; }
  catch (error) {
    assert.ok(error instanceof BoxMessagesShapeError);
    return error.code;
  }
}

describe("Box Messages → Claude CLI synthetic session boundary", () => {
  it("keeps current user in one stdin turn and lifts trailing CCB system text", () => {
    const output = compileBoxCliSyntheticTurn(body([
      { role: "user", content: [{ type: "text", text: "current" }] },
      { role: "system", content: [{ type: "text", text: "OpenClaude memory and skills" }] },
    ], "top system"), args);
    assert.equal(output.snapshotJsonl, "");
    assert.deepEqual(JSON.parse(output.stdinJsonl).message.content,
      [{ type: "text", text: "current" }]);
    assert.equal(output.systemPrompt, "top system\n\nOpenClaude memory and skills");
  });

  it("serializes completed tool history in order without changing roles or IDs", () => {
    const messages = [
      { role: "user", content: "prior question" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1",
        name: "mcp__fixture__local_echo", input: { value: "ping" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1",
        content: [{ type: "text", text: "local result" }] }] },
      { role: "assistant", content: [{ type: "text", text: "prior answer" }] },
      { role: "user", content: "new question" },
    ];
    const before = structuredClone(messages);
    const output = compileBoxCliSyntheticTurn(body(messages), args);
    const records = output.snapshotJsonl.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.length, 4);
    assert.deepEqual(records.map((record) => record.type), ["user", "assistant", "user", "assistant"]);
    assert.equal(records[1].message.content[0].id, "toolu_1");
    assert.equal(records[2].message.content[0].tool_use_id, "toolu_1");
    assert.equal(records[2].message.content[0].content[0].text, "local result");
    assert.deepEqual(records.map((record) => record.parentUuid),
      [null, records[0].uuid, records[1].uuid, records[2].uuid]);
    assert.equal(JSON.parse(output.stdinJsonl).message.content, "new question");
    assert.deepEqual(messages, before);
  });

  it("preserves signed thinking and redacted thinking in completed assistant history", () => {
    const history = [
      { role: "user", content: "prior" },
      { role: "assistant", content: [
        { type: "thinking", thinking: "prior private reasoning", signature: "signed" },
        { type: "redacted_thinking", data: "ciphertext" },
        { type: "text", text: "prior answer" },
      ] },
      { role: "user", content: "next question" },
    ];
    const output = compileBoxCliSyntheticTurn(body(history), args);
    const records = output.snapshotJsonl.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(records[1].message.content, history[1]!.content);
    assert.equal(JSON.parse(output.stdinJsonl).message.content, "next question");
    assert.equal(code(body([{ role: "assistant", content: [
      { type: "thinking", thinking: "x", signature: 123 },
    ] }, { role: "user", content: "next" }])), "BOX_BLOCK_UNSUPPORTED");
  });

  it("rejects a current tool result: only the held live CLI may consume it", () => {
    assert.equal(code(body([
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "x", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "v" }] },
    ])), "BOX_TOOL_RESULT_REQUIRES_LIVE_INVOCATION");
  });

  it("rejects a completed-history snapshot with a pending tool", () => {
    assert.equal(code(body([
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "x", input: {} }] },
      { role: "user", content: "wrong continuation" },
    ])), "BOX_PENDING_TOOL_REQUIRES_LIVE_INVOCATION");
  });

  it("rejects mismatched tool IDs and unsupported image instead of flattening", () => {
    assert.equal(code(body([
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "x", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_wrong", content: "v" }] },
      { role: "user", content: "current" },
    ])), "BOX_TOOL_HISTORY_INVALID");
    assert.equal(code(body([{ role: "user", content: [{ type: "image", source: { type: "base64", data: "abc" } }] }])),
      "BOX_BLOCK_UNSUPPORTED");
  });

  it("rejects unsupported nested tool media and wrong block roles", () => {
    assert.equal(code(body([
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "x", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1",
        content: [{ type: "image", source: { type: "base64", data: "abc" } }] }] },
      { role: "assistant", content: "done" },
      { role: "user", content: "current" },
    ])), "BOX_BLOCK_UNSUPPORTED");
    assert.equal(code(body([{ role: "user", content: [
      { type: "tool_use", id: "toolu_1", name: "x", input: {} },
    ] }])), "BOX_BLOCK_UNSUPPORTED");
    assert.equal(code(body([{ role: "assistant", content: [
      { type: "tool_result", tool_use_id: "toolu_1", content: "x" },
    ] }, { role: "user", content: "current" }])), "BOX_BLOCK_UNSUPPORTED");
  });

  it("pins the private Claude session format to the verified CLI version", () => {
    assert.throws(() => compileBoxCliSyntheticTurn(body([{ role: "user", content: "x" }]),
      { ...args, cliVersion: "99.0.0" }),
    (error: unknown) => error instanceof BoxMessagesShapeError
      && error.code === "BOX_RUN_IDENTITY_INVALID");
  });
});

describe("OCV5-299 historical tool names are staged callable-only", () => {
  const history = [
    { role: "user", content: "check the environment" },
    { role: "assistant", content: [
      { type: "text", text: "Checking." },
      { type: "tool_use", id: "toolu_hist_bash", name: "Bash", input: { command: "hostname" } },
      { type: "tool_use", id: "toolu_hist_gone", name: "LegacyTool", input: { q: "x" } },
    ] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_hist_bash", content: "v3-dev-sg" },
      { type: "tool_result", tool_use_id: "toolu_hist_gone", is_error: true,
        content: [{ type: "text", text: "boom" }] },
    ] },
    { role: "assistant", content: [{ type: "text", text: "Host is v3-dev-sg." }] },
    { role: "user", content: "继续" },
  ];
  const snapshot = (aliases?: ReadonlyMap<string, string>) =>
    compileBoxCliSyntheticTurn(body(history), { ...args, ...(aliases ? { toolAliases: aliases } : {}) })
      .snapshotJsonl.trim().split("\n").map((line) => JSON.parse(line) as {
        message: { role: string; content: unknown; stop_reason?: string } });

  it("renames a call of a catalog tool to this invocation's alias and keeps its result paired", () => {
    const records = snapshot(new Map([["Bash", "mcp__ocbridge__t4"]]));
    const call = records[1]!.message.content as Array<Record<string, unknown>>;
    assert.equal(call[1]!.type, "tool_use");
    assert.equal(call[1]!.name, "mcp__ocbridge__t4");
    assert.equal(call[1]!.id, "toolu_hist_bash");
    assert.deepEqual(call[1]!.input, { command: "hostname" });
    assert.equal(records[1]!.message.stop_reason, "tool_use");
    const results = records[2]!.message.content as Array<Record<string, unknown>>;
    assert.deepEqual(results[0], { type: "tool_result", tool_use_id: "toolu_hist_bash", content: "v3-dev-sg" });
    // No client name the CLI cannot call survives anywhere in the transcript.
    const text = JSON.stringify(records);
    assert.ok(!text.includes('"name":"Bash"'));
    assert.ok(!text.includes('"name":"LegacyTool"'));
  });

  it("demotes a call of a tool outside the catalog, and its result, to plain text", () => {
    const records = snapshot(new Map([["Bash", "mcp__ocbridge__t4"]]));
    const call = records[1]!.message.content as Array<Record<string, unknown>>;
    assert.equal(call[2]!.type, "text");
    assert.match(String(call[2]!.text), /Earlier call to tool "LegacyTool", not available in this turn/);
    assert.match(String(call[2]!.text), /"q":"x"/);
    const results = records[2]!.message.content as Array<Record<string, unknown>>;
    assert.equal(results[1]!.type, "text");
    assert.match(String(results[1]!.text), /Result of earlier "LegacyTool" call \(error\): boom/);
  });

  it("a tool-less text turn stages every historical call as text", () => {
    const records = snapshot(new Map());
    const text = JSON.stringify(records);
    assert.ok(!text.includes('"type":"tool_use"'));
    assert.ok(!text.includes('"type":"tool_result"'));
    assert.equal(records[1]!.message.stop_reason, "end_turn");
    assert.match(text, /Earlier call to tool \\"Bash\\"/);
    assert.match(text, /v3-dev-sg/);
  });

  it("without aliases the staged history is unchanged (request-gate validation path)", () => {
    const records = snapshot();
    const call = records[1]!.message.content as Array<Record<string, unknown>>;
    assert.equal(call[1]!.name, "Bash");
    assert.equal(call[2]!.name, "LegacyTool");
  });

  it("the current user turn and the canonical body are never rewritten", () => {
    const input = body(history);
    const before = JSON.stringify(input);
    const output = compileBoxCliSyntheticTurn(input, { ...args, toolAliases: new Map() });
    assert.equal(JSON.stringify(input), before);
    assert.equal(output.stdinJsonl.trim(), JSON.stringify({ type: "user",
      message: { role: "user", content: "继续" } }));
  });
});

describe("OCV5-337 history written by another model", () => {
  // commercial u1870 2026-10-08 10:28: k3-256k tool calls (ids tool_…) in the history of a session switched
  // to box-api-claude-opus-5-5 made every request 400 BOX_REQUEST_UNSUPPORTED (BOX_BLOCK_UNSUPPORTED).
  const k3History = (current: unknown = { role: "user", content: "now continue with Claude" }) => body([
    { role: "user", content: "list files" },
    { role: "assistant", content: [{ type: "thinking", thinking: "plan", signature: "k3-sig" },
      { type: "tool_use", id: "tool_Ab12Cd34Ef56", name: "Bash", input: { command: "ls" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_Ab12Cd34Ef56", content: "a\nb" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "call_9", name: "Read", input: { file_path: "/a" } },
      { type: "tool_use", id: "functions.Read:1", name: "Read", input: { file_path: "/b" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_9", content: "A" },
      { type: "tool_result", tool_use_id: "functions.Read:1", content: "B" }] },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
    current,
  ]);
  it("a k3 tool history compiles with paired toolu_ ids derived from the originals", () => {
    const first = compileBoxCliSyntheticTurn(k3History(), args);
    const again = compileBoxCliSyntheticTurn(k3History(), args);
    const records = first.snapshotJsonl.trim().split("\n").map((line) => JSON.parse(line));
    const uses = records.flatMap((r) => r.message.content).filter((b: { type?: string }) => b?.type === "tool_use");
    const results = records.flatMap((r) => Array.isArray(r.message.content) ? r.message.content : [])
      .filter((b: { type?: string }) => b?.type === "tool_result");
    assert.equal(uses.length, 3);
    assert.ok(uses.every((u: { id: string }) => /^toolu_oc[0-9a-f]{32}$/.test(u.id)));
    assert.deepEqual(results.map((r: { tool_use_id: string }) => r.tool_use_id), uses.map((u: { id: string }) => u.id));
    assert.equal(first.snapshotJsonl.includes("tool_Ab12Cd34Ef56") || first.snapshotJsonl.includes("call_9"), false);
    const ids = (snapshot: string) => snapshot.match(/toolu_oc[0-9a-f]{32}/g);
    assert.deepEqual(ids(again.snapshotJsonl), ids(first.snapshotJsonl), "the same history maps to the same ids");
  });
  it("other id shapes, unpaired history and a foreign current result stay rejected", () => {
    const withId = (id: string) => body([
      { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "x" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: "next" }]);
    assert.equal(code(withId("tool 1")), "BOX_BLOCK_UNSUPPORTED");
    assert.equal(code(withId("x".repeat(129))), "BOX_BLOCK_UNSUPPORTED");
    assert.equal(code(body([
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_2", content: "x" }] },
      { role: "user", content: "next" }])), "BOX_TOOL_HISTORY_INVALID");
    assert.equal(code(body([{ role: "user", content: "run" },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "x" }] }])), "BOX_BLOCK_UNSUPPORTED");
  });
  it("a foreign id whose renamed form is already used is refused", () => {
    const clash = `toolu_oc${createHash("sha256").update("call_1").digest("hex").slice(0, 32)}`;
    assert.equal(code(body([
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "Bash", input: {} },
        { type: "tool_use", id: clash, name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "x" },
        { type: "tool_result", tool_use_id: clash, content: "y" }] },
      { role: "user", content: "next" }])), "BOX_TOOL_HISTORY_INVALID");
  });
  it("a Box history keeps its own ids byte for byte", () => {
    const output = compileBoxCliSyntheticTurn(body([
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_keep", name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_keep", content: "x" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: "next" }]), args);
    assert.ok(output.snapshotJsonl.includes('"toolu_keep"'));
    assert.equal(output.snapshotJsonl.includes("toolu_oc"), false);
  });
});
