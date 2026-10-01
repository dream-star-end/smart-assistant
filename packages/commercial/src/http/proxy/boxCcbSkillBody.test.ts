// OCV5-303 live #aacd65f7 (v5-681ee45a9): Box Claude called Skill; Claude Code
// answered "Launching skill: X" and injected the skill body as isMeta user
// text after the tool_result -> 409 BOX_TOOL_RESULT_REQUIRES_LIVE_INVOCATION
// -> "模型服务暂时中断".
import test from "node:test";
import assert from "node:assert/strict";
import { foldBoxCcbSkillBody, normalizeBoxSemanticBody } from "./boxCacheAnnotations.js";
import { classifyBoxContinuation } from "./boxPreparedContinuation.js";
import { matchBoxToolResults } from "./boxToolResultMatcher.js";
import type { ProxyBody } from "./shared.js";

const skillBody = "Base directory for this skill: /home/agent/.claude/skills/deploy\n\n# Deploy\nRun the steps.";
const tools = [{ name: "Skill", description: "skill", input_schema: { type: "object" } },
  { name: "Read", description: "read", input_schema: { type: "object" } }];
const assistant = (uses: unknown[]) => ({ role: "assistant", content: uses });
const skillUse = { type: "tool_use", id: "toolu_skill", name: "Skill", input: { skill: "deploy" } };
const readUse = { type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "/a" } };
const launch = { type: "tool_result", tool_use_id: "toolu_skill", content: "Launching skill: deploy" };
const body = (uses: unknown[], ...rest: unknown[]) => ({ model: "box-api-claude-opus-5-5", max_tokens: 64,
  tools, messages: [{ role: "user", content: "deploy it" }, assistant(uses), ...rest] }) as unknown as ProxyBody;
const folded = { ...launch, content: [{ type: "text", text: "Launching skill: deploy" },
  { type: "text", text: skillBody }] };

test("OCV5-303 the injected skill body joins its Skill result and the turn continues", () => {
  for (const shaped of [
    body([skillUse], { role: "user", content: [launch, { type: "text", text: skillBody }] }),
    body([skillUse], { role: "user", content: [launch, { type: "text", text: skillBody,
      cache_control: { type: "ephemeral" } }] }),
    body([skillUse], { role: "user", content: [launch] }, { role: "user", content: skillBody }),
  ]) {
    const out = foldBoxCcbSkillBody(shaped);
    assert.equal(out.messages.length, 3);
    assert.deepEqual((out.messages[2] as { content: unknown[] }).content, [folded]);
    const classified = classifyBoxContinuation(shaped);
    assert.equal(classified.classification, "continuation_candidate", String(classified.rejectCode));
    assert.deepEqual(classified.toolIds, ["toolu_skill"]);
    const [matched] = matchBoxToolResults(shaped, [{ id: "toolu_skill", boxName: "mcp__ocbridge__Skill",
      clientName: "Skill", input: { skill: "deploy" } }]);
    assert.deepEqual(matched!.content, folded.content);
    assert.equal(normalizeBoxSemanticBody(shaped).messages.length, 3);
  }
  // with a parallel ordinary tool result the body still goes to the Skill result
  const both = body([skillUse, readUse], { role: "user", content: [launch,
    { type: "tool_result", tool_use_id: "toolu_read", content: "file" }, { type: "text", text: skillBody }] });
  assert.equal(classifyBoxContinuation(both).classification, "continuation_candidate");
});

test("without exactly one Skill launch the trailing text is not folded", () => {
  const two = { ...skillUse, id: "toolu_skill2" };
  for (const shaped of [
    body([readUse], { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_read",
      content: "file" }, { type: "text", text: "please also do X" }] }),
    body([skillUse, two], { role: "user", content: [launch, { type: "tool_result",
      tool_use_id: "toolu_skill2", content: "Launching skill: deploy" }, { type: "text", text: skillBody }] }),
    body([skillUse], { role: "user", content: [{ ...launch, content: "Skill failed" }, { type: "text", text: skillBody }] }),
    body([skillUse], { role: "user", content: [launch, { type: "image", source: { type: "base64",
      media_type: "image/png", data: "iVBORw0KGgo=" } }] }),
    body([skillUse], { role: "user", content: [{ ...launch, tool_use_id: "toolu_other" }, { type: "text", text: skillBody }] }),
  ]) {
    assert.equal(foldBoxCcbSkillBody(shaped), shaped);
    assert.notEqual(classifyBoxContinuation(shaped).classification, "continuation_candidate");
  }
});
