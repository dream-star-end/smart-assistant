import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
