import { afterEach, describe, expect, test, vi } from "vitest";
import type { ChatSocketDeps } from "./socket";
import { ChatSocket } from "./socket";
import type { ChatMessage } from "./model";

// ── minimal WS fake (same shape as chat.test.ts FakeWS) ──
class FakeWS {
  static instances: FakeWS[] = [];
  static OPEN = 1;
  url = "ws://test";
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeWS.instances.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {}
  open() {
    this.readyState = 1;
    this.onopen?.();
    this.onmessage?.({ data: JSON.stringify({ type: "sys.relay_ready" }) });
  }
}

function makeSocket(overrides: Partial<ChatSocketDeps> = {}) {
  return new ChatSocket({
    getToken: () => "tok",
    getAuthEpoch: () => 0,
    silentRefresh: async (epoch) => ({ kind: "transient", epoch, retryAfterMs: 500 }),
    onAuthExpired: () => {},
    defaultAgentId: "main",
    ...overrides,
  });
}

const SESS = "s-perm-incident";
const SESSION_KEY = `agent:main:webchat:dm:${SESS}`;
const CMID = "u-incident-turn";
const REQUEST_ID = "76e884d6";

function catchupFrame(over: Record<string, unknown> = {}) {
  // gateway _pendingPermissionCatchupFrames: sessionKey present, NO frameSeq.
  return {
    type: "outbound.permission_request",
    sessionKey: SESSION_KEY,
    channel: "webchat",
    peer: { id: SESS, kind: "dm" },
    requestId: REQUEST_ID,
    toolName: "ExitPlanMode",
    clientMessageId: CMID,
    inputPreview: "{}",
    inputJson: { plan: "# plan" },
    expiresAt: Date.now() + 30 * 60_000,
    ts: Date.now(),
    ...over,
  };
}

function stampedPermissionFrame(frameSeq: number) {
  return catchupFrame({ frameSeq });
}

function replayStartFrame() {
  return {
    type: "outbound.active_turn_replay_start",
    sessionKey: SESSION_KEY,
    channel: "webchat",
    peer: { id: SESS, kind: "dm" },
    clientMessageId: CMID,
    baseSeq: 0,
    ts: Date.now(),
  };
}

function stampedMessageFrame(frameSeq: number) {
  return {
    type: "outbound.message",
    sessionKey: SESSION_KEY,
    channel: "webchat",
    peer: { id: SESS, kind: "dm" },
    clientMessageId: CMID,
    frameSeq,
    ts: frameSeq + 1000,
    isFinal: false,
    blocks: [{ kind: "thinking", text: `replayed thought ${frameSeq}` }],
  };
}

function serverHistoryRows(): ChatMessage[] {
  // Unified timeline snapshot for the still-open turn: the user row plus
  // rolling-persisted server process rows for the active cmid.
  return [
    {
      id: CMID,
      role: "user",
      text: "plan please",
      ts: 1,
      status: "sent",
      _source: "server",
      _seq: 1,
      _orderSeq: 1,
      _timelineRecord: true,
      _clientMessageId: CMID,
    },
    {
      id: "srv-thought-1",
      role: "thinking",
      text: "server persisted thought",
      ts: 2,
      _source: "server",
      _seq: 2,
      _orderSeq: 2,
      _clientMessageId: CMID,
    },
    // Mid-turn narration (the incident turn had three of these before
    // ExitPlanMode). Not a terminal answer: the turn is still open.
    {
      id: "srv-narration-1",
      role: "assistant",
      text: "我先查一下相关 skill 和代码现状。",
      ts: 3,
      _source: "server",
      _seq: 3,
      _orderSeq: 3,
      _clientMessageId: CMID,
    },
    {
      id: "srv-tool-1",
      role: "tool",
      toolName: "Read",
      text: "",
      output: "…",
      ts: 4,
      _source: "server",
      _seq: 4,
      _orderSeq: 4,
      _clientMessageId: CMID,
      _completed: true,
    },
  ] as unknown as ChatMessage[];
}

describe("INC-20260904-EXITPLAN-PROMPT-BURIED: open prompt survives reconnect catch-up + durable hydration at the turn tail", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeWS.instances = [];
    vi.useRealTimers();
  });

  test("hello catch-up (no frameSeq) + ring replay + live-frames hydration + full sync keeps the unresolved card", async () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket({ syncSession: async () => {} });
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();

    const sess = sock.ensureSession(SESS, "main");
    sess.messages.push({
      id: CMID,
      role: "user",
      text: "plan please",
      ts: 1,
      status: "sent",
    } as ChatMessage);
    sess._activeClientMessageId = CMID;
    sess._sendingInFlight = true;

    // 08:30:44 — original ring-stamped permission_request over live WS.
    ws.onmessage?.({ data: JSON.stringify(stampedPermissionFrame(240)) });
    const permCount = () =>
      sess.messages.filter((m) => m.role === "permission" && m.requestId === REQUEST_ID).length;
    expect(permCount()).toBe(1);

    // 08:35:49 master restart → 7 reconnect cycles.
    for (let cycle = 0; cycle < 7; cycle++) {
      await sock.runDurableLiveFrameHydration(SESS, async () => {
        // (a) hello catch-up frame WITHOUT frameSeq: dispatched immediately
        // even though durable hydration is in progress.
        ws.onmessage?.({ data: JSON.stringify(catchupFrame()) });
        // (b) active-turn ring replay boundary + stamped frames (incl. the
        // original stamped permission_request); stamped frames are buffered by
        // bufferStampedFrameDuringDurableHydration and drained after REST.
        ws.onmessage?.({ data: JSON.stringify(replayStartFrame()) });
        ws.onmessage?.({ data: JSON.stringify(stampedMessageFrame(238)) });
        ws.onmessage?.({ data: JSON.stringify(stampedMessageFrame(239)) });
        ws.onmessage?.({ data: JSON.stringify(stampedPermissionFrame(240)) });
        // (c) REST /live-frames hydration: units + owner-local reset.
        sock.applyLiveUnits(
          SESS,
          [
            {
              id: "live-thought-1",
              kind: "thinking",
              open: true,
              text: "hydrated thought",
              clientMessageId: CMID,
              seqLast: 682,
            },
          ] as never,
          [CMID],
          { sessionKey: SESSION_KEY, frameSeq: 682, recordId: "r-682" },
        );
        // REST GET /api/sessions/:id full sync.
        sock.applyServerMessages(SESS, "main", serverHistoryRows(), true, 682, {
          serverUpdatedAt: Date.now() + cycle + 1,
        });
      });
    }

    const card = sess.messages.find(
      (m) => m.role === "permission" && m.requestId === REQUEST_ID,
    );
    expect(card).toBeTruthy();
    expect(card?._resolved).not.toBe(true);
    // The runtime is blocked on this prompt: it must sit at the tail of its
    // turn (where the tail-following paint window and auto-open see it), not
    // above the replayed process rows right under the user message — that is
    // exactly where the 2026-09-04 ExitPlanMode card was buried until the TTL
    // auto-denied it.
    expect(sess.messages.indexOf(card!)).toBe(sess.messages.length - 1);
    expect(sess.messages.filter((m) => m.role === "permission")).toHaveLength(1);
    sock.stop();
  });
});
