/** Operator-only native warm-turn fixture. A mismatch fails before paid Box. */
import { hashBoxAssistantContent } from "../../packages/commercial/src/http/proxy/boxCallFingerprint.js";
import type { ProxyBody } from "../../packages/commercial/src/http/proxy/shared.js";

export function makeBoxThirdTurnBody(input: {
  second: ProxyBody;
  fullAssistantContent: unknown[];
  assistantContentHash: string;
  sessionId: string;
  turnKey: string;
  userPrompt: string;
}): ProxyBody {
  if (!Array.isArray(input.second.messages)
    || !Array.isArray(input.fullAssistantContent)
    || !/^[a-f0-9]{64}$/.test(input.assistantContentHash)
    || !/^[a-f0-9]{64}$/.test(input.turnKey)
    || !/^[A-Za-z0-9._:-]{1,256}$/.test(input.sessionId)
    || !input.userPrompt || input.userPrompt.length > 4096
    || hashBoxAssistantContent(input.fullAssistantContent) !== input.assistantContentHash) {
    throw new Error("BOX_NATIVE_THIRD_FIXTURE_INVALID");
  }
  return { ...input.second, metadata: { user_id: JSON.stringify({
    oc_turn_key: input.turnKey, session_id: input.sessionId }) },
    messages: [...input.second.messages,
      { role: "assistant", content: input.fullAssistantContent },
      { role: "user", content: input.userPrompt }] } as ProxyBody;
}
