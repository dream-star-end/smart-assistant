import test from "node:test";
import assert from "node:assert/strict";
import { hashBoxAssistantContent } from "../../packages/commercial/src/http/proxy/boxCallFingerprint.js";
import { makeBoxNativeHistoryBasis, matchesBoxNativeHistory } from
  "../../packages/commercial/src/http/proxy/boxNativeHistory.js";
import type { ProxyBody } from "../../packages/commercial/src/http/proxy/shared.js";
import { makeBoxThirdTurnBody } from "./boxThirdTurnPlan.js";

const second: ProxyBody = { model: "box-api-claude-opus-5-5", max_tokens: 8192,
  stream: true, system: "Stable synthetic system", tool_choice: { type: "auto" },
  tools: [{ name: "local_echo", input_schema: { type: "object" } }],
  messages: [
    { role: "user", content: "ask tool" },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_A",
      name: "local_echo", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_A",
      content: "synthetic-private-token" }] },
  ] } as ProxyBody;

test("third signed turn exactly extends the completed second request", () => {
  const content = [{ type: "text", text: "synthetic-private-token" }];
  const basis = makeBoxNativeHistoryBasis(second, content);
  const third = makeBoxThirdTurnBody({ second, fullAssistantContent: content,
    assistantContentHash: hashBoxAssistantContent(content),
    sessionId: "session-291", turnKey: "a".repeat(64),
    userPrompt: "Recall the prior tool result. Do not call tools." });
  assert.deepEqual(third.messages.slice(0, second.messages.length), second.messages);
  assert.equal(third.messages.length, second.messages.length + 2);
  assert.equal(matchesBoxNativeHistory(third, basis), true);
  assert.equal(matchesBoxNativeHistory({ ...third,
    messages: [...second.messages, ...third.messages] } as ProxyBody, basis), false);
  assert.throws(() => makeBoxThirdTurnBody({ second,
    fullAssistantContent: [{ type: "text", text: "forged" }],
    assistantContentHash: hashBoxAssistantContent(content),
    sessionId: "session-291", turnKey: "b".repeat(64), userPrompt: "next" }),
  /BOX_NATIVE_THIRD_FIXTURE_INVALID/);
});
