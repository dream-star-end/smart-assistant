// OCV5-421: tools that never got a result must not keep spinning after a terminal error,
// and must not turn into a green "完成" when the user stopped the turn.
import { describe, expect, test } from "vitest";
import { resolveToolStatus } from "../../components/tool/status";
import { addMessage, type ChatSession, createSession } from "./model";
import type { LegacyBridgeErrorWire, OutboundMessageWire } from "./frames";
import { applyLegacyBridgeError, applyOutboundMessage } from "./reducer";

const SID = "s1";
function begin(): { s: ChatSession; cmid: string } {
  const s = createSession({ id: SID, agentId: "main" });
  const user = addMessage(s, "user", "跑命令");
  s._activeClientMessageId = user.id;
  s._sendingInFlight = true;
  return { s, cmid: user.id };
}
let seq = 0;
function frame(cmid: string, over: Record<string, unknown>): OutboundMessageWire {
  return {
    type: "outbound.message", channel: "webchat", sessionKey: `agent:main:webchat:dm:${SID}`,
    peer: { id: SID, kind: "dm" }, clientMessageId: cmid, ts: Date.now(), frameSeq: ++seq,
    blocks: [], isFinal: false, ...over,
  } as unknown as OutboundMessageWire;
}
const toolUse = (cmid: string, blockId: string) =>
  frame(cmid, { blocks: [{ kind: "tool_use", blockId, toolName: "Bash", inputJson: { command: "sleep 600" } }] });
const tools = (s: ChatSession) => s.messages.filter((m) => m.role === "tool");
const status = (m: ChatSession["messages"][number]) =>
  resolveToolStatus({ name: m.toolName ?? "Bash", tool: m as never }).kind;

describe("orphan tools at turn end (OCV5-421)", () => {
  test("legacy error frame settles the active turn's running tool as cancelled", () => {
    const { s, cmid } = begin();
    applyOutboundMessage(s, toolUse(cmid, "t1"));
    expect(status(tools(s)[0])).toBe("running");
    applyLegacyBridgeError(s, { type: "error", code: "upstream_failed", message: "boom", clientMessageId: cmid,
      peer: { id: SID, kind: "dm" } } as unknown as LegacyBridgeErrorWire);
    expect(status(tools(s)[0])).toBe("cancelled");
  });

  test("user stop (interrupted final) marks a result-less tool cancelled, not done", () => {
    const { s, cmid } = begin();
    applyOutboundMessage(s, toolUse(cmid, "t2"));
    applyOutboundMessage(s, frame(cmid, { isFinal: true, meta: { interrupted: "user_cancelled" } }));
    expect(status(tools(s)[0])).toBe("cancelled");
  });

  test("a normal final keeps tools that finished as done", () => {
    const { s, cmid } = begin();
    applyOutboundMessage(s, toolUse(cmid, "t3"));
    applyOutboundMessage(s, frame(cmid, { blocks: [{ kind: "tool_result", blockId: "t3:result", toolUseBlockId: "t3", toolName: "Bash", output: "ok" }] }));
    applyOutboundMessage(s, frame(cmid, { isFinal: true }));
    expect(status(tools(s)[0])).toBe("done");
  });

  test("a tool with partial output at stop stays done (it produced something)", () => {
    const { s, cmid } = begin();
    applyOutboundMessage(s, toolUse(cmid, "t4"));
    tools(s)[0].output = "partial";
    applyOutboundMessage(s, frame(cmid, { isFinal: true, meta: { interrupted: "user_cancelled" } }));
    expect(status(tools(s)[0])).toBe("done");
  });
});
