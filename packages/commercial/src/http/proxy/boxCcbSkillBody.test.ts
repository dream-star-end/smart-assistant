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

// OCV5-314 live #72191544 (v5-0d0c1359a): Box Claude called two Skills in one
// step (v5-session-goal-start-triage + openclaude-instance-topology). Claude
// Code injected one body per launch -> the single-Skill fold left both bodies
// in the tool-result message -> 409 BOX_TOOL_RESULT_REQUIRES_LIVE_INVOCATION.
const bodyOf = (name: string, rest = "# Title\nSteps.") =>
  `Base directory for this skill: /home/agent/.openclaude/skills/${name}\n\n${rest}`;
const use = (id: string, name: string) => ({ type: "tool_use", id, name: "Skill", input: { skill: name } });
const launchOf = (id: string, name: string) => ({ type: "tool_result", tool_use_id: id,
  content: `Launching skill: ${name}` });
const txt = (text: string) => ({ type: "text", text });
const foldedOf = (id: string, name: string, ...bodies: string[]) => ({ ...launchOf(id, name),
  content: [txt(`Launching skill: ${name}`), ...bodies.map(txt)] });
const A = "v5-session-goal-start-triage";
const B = "openclaude-instance-topology";
const twoUses = [use("toolu_a", A), use("toolu_b", B)];

test("OCV5-314 parallel Skill bodies each join their own launch, in any layout", () => {
  const expected = [foldedOf("toolu_a", A, bodyOf(A)), foldedOf("toolu_b", B, bodyOf(B))];
  for (const shaped of [
    // interleaved: each body right after its own result
    body(twoUses, { role: "user", content: [launchOf("toolu_a", A), txt(bodyOf(A)),
      launchOf("toolu_b", B), txt(bodyOf(B))] }),
    // results first, bodies after (any order, cache_control on the last)
    body(twoUses, { role: "user", content: [launchOf("toolu_a", A), launchOf("toolu_b", B),
      txt(bodyOf(B)), { ...txt(bodyOf(A)), cache_control: { type: "ephemeral" } }] }),
    // bodies as following text-only user messages
    body(twoUses, { role: "user", content: [launchOf("toolu_a", A), launchOf("toolu_b", B)] },
      { role: "user", content: bodyOf(A) }, { role: "user", content: [txt(bodyOf(B))] }),
  ]) {
    const out = foldBoxCcbSkillBody(shaped);
    assert.equal(out.messages.length, 3);
    assert.deepEqual((out.messages[2] as { content: unknown[] }).content, expected);
    const classified = classifyBoxContinuation(shaped);
    assert.equal(classified.classification, "continuation_candidate", String(classified.rejectCode));
    assert.deepEqual(classified.toolIds, ["toolu_a", "toolu_b"]);
    const matched = matchBoxToolResults(shaped, [
      { id: "toolu_a", boxName: "mcp__ocbridge__Skill", clientName: "Skill", input: { skill: A } },
      { id: "toolu_b", boxName: "mcp__ocbridge__Skill", clientName: "Skill", input: { skill: B } }]);
    assert.deepEqual(matched.map((row) => row!.content), expected.map((row) => row.content));
  }
  // a headerless continuation block stays with the body before it; a plugin
  // skill name matches its directory; a parallel non-Skill result is untouched
  const plugin = "suite:deploy";
  const read = { type: "tool_result", tool_use_id: "toolu_read", content: "file" };
  const mixed = body([use("toolu_a", A), use("toolu_p", plugin), readUse], { role: "user", content: [
    launchOf("toolu_a", A), launchOf("toolu_p", plugin), read,
    txt(bodyOf("deploy")), txt(bodyOf(A)), txt("ARGUMENTS: now")] });
  assert.deepEqual((foldBoxCcbSkillBody(mixed).messages[2] as { content: unknown[] }).content, [
    foldedOf("toolu_a", A, bodyOf(A), "ARGUMENTS: now"), foldedOf("toolu_p", plugin, bodyOf("deploy")), read]);
  assert.equal(classifyBoxContinuation(mixed).classification, "continuation_candidate");
});

test("OCV5-314 unattributable parallel Skill text is not folded", () => {
  for (const shaped of [
    // header names no launch
    body(twoUses, { role: "user", content: [launchOf("toolu_a", A), launchOf("toolu_b", B),
      txt(bodyOf("other"))] }),
    // text without any header first
    body(twoUses, { role: "user", content: [launchOf("toolu_a", A), launchOf("toolu_b", B),
      txt("please also do X"), txt(bodyOf(A))] }),
    // two bodies for one launch
    body(twoUses, { role: "user", content: [launchOf("toolu_a", A), launchOf("toolu_b", B),
      txt(bodyOf(A)), txt(bodyOf(A))] }),
    // the same skill launched twice: ambiguous
    body([use("toolu_a", A), use("toolu_a2", A)], { role: "user", content: [launchOf("toolu_a", A),
      launchOf("toolu_a2", A), txt(bodyOf(A))] }),
    // a failed launch keeps its body unattributed
    body(twoUses, { role: "user", content: [launchOf("toolu_a", A),
      { ...launchOf("toolu_b", B), content: "Skill failed" }, txt(bodyOf(B))] }),
    // text before the first result
    body(twoUses, { role: "user", content: [txt(bodyOf(A)), launchOf("toolu_a", A), launchOf("toolu_b", B)] }),
    // a following user message without a header is a real user turn
    body(twoUses, { role: "user", content: [launchOf("toolu_a", A), launchOf("toolu_b", B)] },
      { role: "user", content: "and then deploy" }),
  ]) {
    assert.equal(foldBoxCcbSkillBody(shaped), shaped);
    assert.notEqual(classifyBoxContinuation(shaped).classification, "continuation_candidate");
  }
});
