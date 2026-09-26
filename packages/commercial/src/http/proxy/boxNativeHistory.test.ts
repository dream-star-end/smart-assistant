import test from "node:test";
import assert from "node:assert/strict";
import type { ProxyBody } from "./shared.js";
import { makeBoxNativeHistoryBasis, matchesBoxNativeHistory } from "./boxNativeHistory.js";
import { deriveBoxContextHash, hashBoxAssistantContent } from "./boxCallFingerprint.js";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const body = (messages: unknown[]): ProxyBody => ({ model: "box-api-claude-opus-5-5",
  stream: true, max_tokens: 256, system: "Stable OpenClaude memory and Skills",
  messages } as ProxyBody);

test("completed text turn hits only its exact authenticated prefix and assistant", () => {
  const previous = body([user("prior question")]);
  const final = [{ type: "text", text: "READY" }];
  const basis = makeBoxNativeHistoryBasis(previous, final);
  const next = body([user("prior question"), assistant("READY"), user("new question")]);
  assert.equal(deriveBoxContextHash({ ...next, messages: next.messages.slice(0, -2) }),
    basis.contextHashBeforeFinal);
  assert.equal(hashBoxAssistantContent((next.messages[1] as { content: unknown }).content),
    basis.assistantContentHash);
  assert.equal(matchesBoxNativeHistory(next, basis), true);
  assert.equal(matchesBoxNativeHistory(body([user("edited question"), assistant("READY"),
    user("new question")]), basis), false);
  assert.equal(matchesBoxNativeHistory(body([user("prior question"), assistant("forged"),
    user("new question")]), basis), false);
  assert.equal(matchesBoxNativeHistory({ ...body([user("prior question"), assistant("READY"),
    user("new question")]), system: "changed system" }, basis), false);
  assert.equal(matchesBoxNativeHistory(body([user("prior question"),
    user("new question")]), basis), false);
});

test("tool result budget telemetry is normalized before matching completed turn", () => {
  const toolUse = { role: "assistant", content: [{ type: "tool_use",
    id: "toolu_native_probe", name: "local_echo", input: { value: "x" } }] };
  const toolResult = { role: "user", content: [{ type: "tool_result",
    tool_use_id: "toolu_native_probe", content: "synthetic-result" }] };
  const budget = { role: "system", content: [{ type: "text",
    text: "<total_tokens>1234 tokens left</total_tokens>",
    cache_control: { type: "ephemeral" } }] };
  const previous = body([user("call tool"), toolUse, toolResult, budget]);
  const basis = makeBoxNativeHistoryBasis(previous, [{ type: "text", text: "done" }]);
  const next = body([user("call tool"), toolUse, toolResult, budget,
    assistant("done"), user("follow up")]);
  assert.equal(matchesBoxNativeHistory(next, basis), true);
  assert.equal(matchesBoxNativeHistory(body([user("call tool"), toolUse,
    { ...toolResult, content: [{ ...toolResult.content[0], content: "changed" }] },
    budget, assistant("done"), user("follow up")]), basis), false);
  const wrongBudget = { ...budget, content: [{ ...budget.content[0],
    text: "<total_tokens>untrusted hint</total_tokens>" }] };
  assert.equal(matchesBoxNativeHistory(body([user("call tool"), toolUse, toolResult,
    wrongBudget, assistant("done"), user("follow up")]), basis), false);
});

test("omitted thinking and pending tool results are cache misses, not permissive resumes", () => {
  const previous = body([user("x")]);
  const basis = makeBoxNativeHistoryBasis(previous, [
    { type: "thinking", thinking: "private reasoning", signature: "synthetic-signature" },
    { type: "text", text: "answer" },
  ]);
  assert.equal(matchesBoxNativeHistory(body([user("x"), assistant("answer"),
    user("next")]), basis), false);
  const plain = makeBoxNativeHistoryBasis(previous, [{ type: "text", text: "answer" }]);
  assert.equal(matchesBoxNativeHistory(body([user("x"), assistant("answer"),
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_x",
      content: "pending" }] }]), plain), false);
});
