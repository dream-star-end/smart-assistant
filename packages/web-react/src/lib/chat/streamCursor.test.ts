import { afterEach, describe, expect, test, vi } from "vitest";
import { addMessage, type ChatMessage } from "./model";
import { ChatSocket } from "./socket";

const id = "cursor-fixture";
const key = `agent:main:webchat:dm:${id}`;
const history: ChatMessage[] = [
  { id: "old-user", role: "user", text: "previous", ts: 1, _seq: 1 },
  { id: "old-answer", role: "assistant", text: "finished", ts: 2, _seq: 2,
    _source: "server", _clientMessageId: "old-user", _turnTapeComplete: true },
];
function setup(cursor = 401) {
  vi.useFakeTimers();
  const socket = new ChatSocket({
    getToken: () => "fixture", getAuthEpoch: () => 0,
    silentRefresh: async epoch => ({ kind: "transient", epoch, retryAfterMs: 500 }),
    onAuthExpired: () => {}, defaultAgentId: "main", syncSession: async () => {},
  });
  socket.loadStored({ id, agentId: "main", messages: [], createdAt: 1, lastAt: 2,
    _lastFrameSeqByKey: { [key]: cursor }, _lastFrameSeq: cursor });
  const send = vi.fn();
  // A session selected AFTER the socket opened: no reconnect hello for it.
  (socket as any).ws = { readyState: 1, send };
  const hydrate = () => socket.applyServerMessages(id, "main", structuredClone(history), true, 2);
  const dispatch = (f: unknown) => (socket as any).dispatch(f);
  return { socket, send, hydrate, dispatch, session: socket.sessions.get(id)! };
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
describe("OCV5-178 idle cursor registration", () => {
  test("warm socket arbitrates a restored idle cursor before the next turn", () => {
    const { hydrate, send, dispatch, session } = setup();
    hydrate();
    expect(JSON.parse(send.mock.calls[0][0]).peers).toEqual([
      { peerId: id, agentId: "main", inFlight: false, lastFrameSeq: 401 },
    ]);
    dispatch({ type: "outbound.resume_failed", channel: "webchat", peer: { id, kind: "dm" },
      sessionKey: key, from: 401, to: 0, reason: "no_buffer" });
    expect(session._lastFrameSeqByKey?.[key]).toBe(0);
    const user = addMessage(session, "user", "continue");
    session._activeClientMessageId = user.id;
    session._sendingInFlight = true;
    dispatch({ type: "outbound.message", channel: "webchat", peer: { id, kind: "dm" },
      sessionKey: key, clientMessageId: user.id, frameSeq: 1, ts: Date.now(), isFinal: false,
      blocks: [{ kind: "text", blockId: "new-text", text: "NEW OUTPUT" }] });
    dispatch({ type: "outbound.message", channel: "webchat", peer: { id, kind: "dm" },
      sessionKey: key, clientMessageId: user.id, frameSeq: 2, ts: Date.now(), isFinal: false,
      blocks: [{ kind: "tool_use", blockId: "tool-1", name: "Bash", input: { command: "pwd" } }] });
    expect(session.messages.some(m => m.text === "NEW OUTPUT")).toBe(true);
    expect(session.messages.some(m => m.role === "tool")).toBe(true);
    expect(session._sendingInFlight).toBe(true);
  });
  test("repeated idle hydration and no-buffer reconciliation cannot loop hello", () => {
    const { hydrate, send, dispatch } = setup();
    hydrate(); hydrate(); hydrate();
    expect(send).toHaveBeenCalledTimes(1);
    dispatch({ type: "outbound.resume_failed", channel: "webchat", peer: { id, kind: "dm" },
      sessionKey: key, from: 401, to: 0, reason: "no_buffer" });
    hydrate(); hydrate(); hydrate();
    expect(send).toHaveBeenCalledTimes(2);
  });
  test("failed registration remains retryable and idle does not consume active candidates", () => {
    const { socket, hydrate, send } = setup();
    send.mockImplementationOnce(() => { throw new Error("socket unavailable"); });
    hydrate(); hydrate();
    expect(send).toHaveBeenCalledTimes(2);
    socket.applyServerMessages(id, "main", [...structuredClone(history),
      { id: "m-new-candidate", role: "user", text: "next", ts: 3, _seq: 3 }], true, 3);
    expect(JSON.parse(send.mock.calls[2][0]).peers[0].resumeActiveTurnCandidateMessageIds)
      .toEqual(["m-new-candidate"]);
  });
  test("idle ring-hit replay of a completed exact answer stays frozen", () => {
    const { hydrate, dispatch, session } = setup(1);
    hydrate();
    for (const frameSeq of [2, 3]) dispatch({
      type: "outbound.message", channel: "webchat", peer: { id, kind: "dm" },
      sessionKey: key, clientMessageId: "old-user", frameSeq, ts: 2, isFinal: frameSeq === 3,
      blocks: [{ kind: "text", blockId: "old-block", messageId: "old-answer", text: "finished", delta: true }],
    });
    expect(session.messages.filter(m => m.role === "assistant").map(m => m.text)).toEqual(["finished"]);
    expect(session._sendingInFlight).toBeFalsy();
    expect(session._lastFrameSeqByKey?.[key]).toBe(3);
  });
  test("agent-scoped idle cursors are registered independently", () => {
    const { hydrate, send, session } = setup();
    session._lastFrameSeqByKey![`agent:explorer:webchat:dm:${id}`] = 9;
    hydrate(); hydrate();
    expect(JSON.parse(send.mock.calls[0][0]).peers.map((p: {agentId: string}) => p.agentId))
      .toEqual(["main", "explorer"]);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
