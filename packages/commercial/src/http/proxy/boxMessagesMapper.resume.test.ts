import test from "node:test";
import assert from "node:assert/strict";
import { BOX_CLI_RESUME_PROMPT, BoxMessagesShapeError, compileBoxCliSyntheticTurn } from "./boxMessagesMapper.js";
import type { ProxyBody } from "./shared.js";

const cwd = "/tmp/ocv5-289-run-" + "a".repeat(24);
const use = { type: "tool_use", id: "toolu_S", name: "Skill", input: { skill: "x" } };
const result = { type: "tool_result", tool_use_id: "toolu_S", content: "Launching skill: x" };
const body = (last: unknown[]) => ({ model: "claude-opus-5-5", max_tokens: 64, messages: [
  { role: "user", content: "deploy" }, { role: "assistant", content: [use] },
  { role: "user", content: last }] }) as unknown as ProxyBody;
const fails = (b: ProxyBody, opts: object, code: string) => assert.throws(
  () => compileBoxCliSyntheticTurn(b, { cwd, cliVersion: "2.1.280", ...opts }),
  (error: unknown) => error instanceof BoxMessagesShapeError && error.code === code, code);

test("OCV5-304 an answered tool exchange is staged as history and resumed with Claude Code's sentence", () => {
  const turn = compileBoxCliSyntheticTurn(body([result]), { cwd, cliVersion: "2.1.280", resumeToolResults: true });
  const records = turn.snapshotJsonl.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(records.map((r) => r.type), ["user", "assistant", "user"]);
  assert.deepEqual(records[2].message.content, [result]);
  assert.equal(records[1].message.stop_reason, "tool_use");
  assert.deepEqual(JSON.parse(turn.stdinJsonl).message.content, BOX_CLI_RESUME_PROMPT);
});

test("without the flag, with other content, or unpaired ids the old rejection stays", () => {
  fails(body([result]), {}, "BOX_TOOL_RESULT_REQUIRES_LIVE_INVOCATION");
  // (a Skill launch would legitimately absorb its body, OCV5-303; use another tool)
  const read = { type: "tool_use", id: "toolu_R", name: "Read", input: { file_path: "/a" } };
  const readBody = { model: "claude-opus-5-5", max_tokens: 64, messages: [
    { role: "user", content: "read" }, { role: "assistant", content: [read] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_R", content: "file" },
      { type: "text", text: "and more" }] }] } as unknown as ProxyBody;
  fails(readBody, { resumeToolResults: true }, "BOX_TOOL_RESULT_REQUIRES_LIVE_INVOCATION");
  fails(body([{ ...result, tool_use_id: "toolu_other" }]), { resumeToolResults: true },
    "BOX_TOOL_HISTORY_INVALID");
});
