// OCV5-304: the full plan path (request validation + mapper) for a recovered
// tool exchange. Live: the fresh fallback still failed with BoxTextPlanError
// BOX_TOOL_RESULT_REQUIRES_LIVE_INVOCATION because validation ran the mapper
// without the resume flag.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { makeBoxToolPlan } from "./boxToolPlan.js";
import { BOX_CLI_RESUME_PROMPT } from "./boxMessagesMapper.js";
import type { ProxyBody } from "./shared.js";

const assets = { upstreamModel: "claude-opus-5-5", maxOutputTokensLimit: 128_000,
  supervisorAsset: Buffer.from("s"), keeperAsset: Buffer.from("k"), virtualMcpAsset: Buffer.from("m") };
const body = { model: "box-api-claude-opus-5-5", max_tokens: 128, stream: true,
  tools: [{ name: "Skill", description: "skill", input_schema: { type: "object", properties: {} } }],
  messages: [{ role: "user", content: "load the skill" },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_S", name: "Skill", input: { skill: "x" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_S", content: "Launching skill: x" },
      { type: "text", text: "Base directory for this skill: /x\n\n# X" },
      { type: "text", text: "继续完成刚才因临时异常中断的任务。从断点继续。" }] }] } as unknown as ProxyBody;

test("OCV5-304 a recovered tool exchange plans end to end with Claude Code's resume sentence", () => {
  assert.throws(() => makeBoxToolPlan({ ...assets, body }), /BOX_TOOL_RESULT_REQUIRES_LIVE_INVOCATION/);
  const plan = makeBoxToolPlan({ ...assets, body, resumeToolResults: true });
  const expectedStdin = JSON.stringify({ type: "user", message: { role: "user", content: BOX_CLI_RESUME_PROMPT } }) + "\n";
  assert.equal(plan.stdinHash, createHash("sha256").update(expectedStdin).digest("hex"));
  assert.ok(plan.run.args.includes("--resume"), "the answered exchange is staged as history");
});
