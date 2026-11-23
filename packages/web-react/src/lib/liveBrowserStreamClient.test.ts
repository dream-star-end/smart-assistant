import {
  LIVE_BROWSER_PUBLIC_WS_PATH,
  LIVE_BROWSER_TICKET_PROTOCOL,
  type LiveBrowserStreamTicketResponse,
  encodeLiveBrowserFrame,
} from "@openclaude/protocol/browser";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { sendLiveBrowserAction } from "./liveBrowserApi";
import { LiveBrowserStreamClient } from "./liveBrowserStreamClient";
import type { AuthSession } from "./types";

const MOCK_AUTH = {
  snapshot: () => ({ token: "tok", username: "u", role: "user" as const }),
  refresh: async () => "tok",
  logout: () => {},
} as unknown as AuthSession;

class FakeWebSocket {
  public binaryType = "blob";
  public readyState = 0; // CONNECTING
  public sent: string[] = [];
  public onopen: ((ev: Event) => void) | null = null;
  public onmessage: ((ev: MessageEvent) => void) | null = null;
  public onerror: ((ev: Event) => void) | null = null;
  public onclose: ((ev: CloseEvent) => void) | null = null;

  constructor(
    public readonly url: string,
    public readonly protocols: string[],
  ) {}

  send(data: string) {
    this.sent.push(data);
  }

  close(code = 1000, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }

  emitOpen() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  emitMessage(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }

  emitAbnormalClose(code = 1006, reason = "network drop") {
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("LiveBrowserStreamClient", () => {
  test("decodes OCLB binary frames, enforces monotonic seq, and computes RTT/FPS stats", async () => {
    const sockets: FakeWebSocket[] = [];
    const frames: number[] = [];
    const states: string[] = [];
    const statsLog: Array<{ fps: number; rttMs: number | null; mode: string }> = [];

    const client = new LiveBrowserStreamClient({
      agentId: "main",
      getAuth: () => MOCK_AUTH,
      locationOrigin: "https://app.clarvy.ai",
      requestTicket: vi.fn(
        async (): Promise<LiveBrowserStreamTicketResponse> => ({
          ticket: "tkt-123",
          expiresAt: Date.now() + 60_000,
          agentId: "main",
          wsPath: LIVE_BROWSER_PUBLIC_WS_PATH,
          protocol: LIVE_BROWSER_TICKET_PROTOCOL,
        }),
      ),
      createWebSocket: (url, protocols) => {
        const ws = new FakeWebSocket(url, protocols);
        sockets.push(ws);
        return ws as unknown as WebSocket;
      },
      callbacks: {
        onState: (s) => states.push(s.title),
        onFrame: (f) => frames.push(f.seq),
        onStats: (st) => statsLog.push({ fps: st.fps, rttMs: st.rttMs, mode: st.mode }),
      },
    });

    client.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(sockets).toHaveLength(1);
    const ws = sockets[0]!;
    expect(ws.url).toBe("wss://app.clarvy.ai/ws/live-browser");
    expect(ws.protocols).toEqual(["live-browser-v1", "ticket.tkt-123"]);
    expect(ws.binaryType).toBe("arraybuffer");

    ws.emitOpen();
    // Must NOT declare connected on transport open alone; wait for end-to-end `ready`.
    expect(client.isConnected()).toBe(false);

    // Heartbeat ping sent on open
    expect(ws.sent.length).toBeGreaterThanOrEqual(1);
    const ping = JSON.parse(ws.sent[0]!) as { type: string; ts: number };
    expect(ping.type).toBe("ping");

    // Server ready + state
    ws.emitMessage(
      JSON.stringify({
        type: "ready",
        protocolVersion: 1,
        agentId: "main",
        state: {
          active: true,
          agentBusy: false,
          humanTakeover: false,
          url: "https://arxiv.org",
          title: "arXiv Live",
          loading: false,
          tabs: [],
          dialog: null,
        },
      }),
    );
    expect(client.isConnected()).toBe(true);
    expect(states).toEqual(["arXiv Live"]);

    // Binary frames: seq 2 -> accepted, seq 1 (stale) -> dropped, seq 3 -> accepted
    const f2 = encodeLiveBrowserFrame({
      seq: 2,
      width: 1280,
      height: 720,
      format: "jpeg",
      settled: false,
      payload: new Uint8Array([0xff, 0xd8, 0xff]),
    });
    const f1 = encodeLiveBrowserFrame({
      seq: 1,
      width: 1280,
      height: 720,
      format: "jpeg",
      settled: false,
      payload: new Uint8Array([0xff, 0xd8, 0x01]),
    });
    const f3 = encodeLiveBrowserFrame({
      seq: 3,
      width: 1280,
      height: 720,
      format: "png",
      settled: true,
      payload: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    });

    ws.emitMessage(f2.buffer);
    ws.emitMessage(f1.buffer);
    ws.emitMessage(f3.buffer);
    expect(frames).toEqual([2, 3]);

    // Pong computes RTT
    vi.advanceTimersByTime(42);
    ws.emitMessage(JSON.stringify({ type: "pong", ts: ping.ts, serverTs: Date.now() }));
    const latestStat = statsLog.at(-1);
    expect(latestStat?.mode).toBe("ws");
    expect(latestStat?.rttMs).toBe(42);
    expect(latestStat?.fps).toBe(2);

    client.dispose();
  });

  test("falls back gracefully to HTTP polling after consecutive ticket/connect failures", async () => {
    const statuses: string[] = [];
    const fallbacks: string[] = [];
    const requestTicket = vi.fn().mockRejectedValue(new Error("501 Not Implemented"));

    const client = new LiveBrowserStreamClient({
      agentId: "main",
      getAuth: () => MOCK_AUTH,
      maxConnectFailuresBeforeFallback: 2,
      requestTicket,
      createWebSocket: () => {
        throw new Error("should not construct ws");
      },
      callbacks: {
        onStatus: (s) => statuses.push(s),
        onFallback: (r) => fallbacks.push(r),
      },
    });

    client.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(statuses).toContain("reconnecting");
    expect(fallbacks).toHaveLength(0);

    // Trigger backoff retry -> 2nd failure enters fallback
    await vi.advanceTimersByTimeAsync(1_100);
    expect(client.getStatus()).toBe("fallback");
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]).toContain("501");

    client.dispose();
  });

  test("ignores stale generation events after retryNow/dispose (connGen fence)", async () => {
    const sockets: FakeWebSocket[] = [];
    const states: string[] = [];

    const client = new LiveBrowserStreamClient({
      agentId: "main",
      getAuth: () => MOCK_AUTH,
      requestTicket: vi.fn(
        async (): Promise<LiveBrowserStreamTicketResponse> => ({
          ticket: "tkt",
          expiresAt: Date.now() + 60_000,
          agentId: "main",
          wsPath: LIVE_BROWSER_PUBLIC_WS_PATH,
          protocol: LIVE_BROWSER_TICKET_PROTOCOL,
        }),
      ),
      createWebSocket: (url, protocols) => {
        const ws = new FakeWebSocket(url, protocols);
        sockets.push(ws);
        return ws as unknown as WebSocket;
      },
      callbacks: {
        onState: (s) => states.push(s.title),
      },
    });

    client.start();
    await Promise.resolve();
    await Promise.resolve();
    const oldWs = sockets[0]!;

    // Trigger reconnect before oldWs delivers a late message
    client.retryNow();
    await Promise.resolve();
    await Promise.resolve();
    const newWs = sockets[1]!;
    newWs.emitOpen();

    // Late message on oldWs must be ignored
    oldWs.emitMessage(
      JSON.stringify({
        type: "state",
        active: true,
        agentBusy: false,
        humanTakeover: false,
        url: "https://old.example",
        title: "Stale Gen",
        loading: false,
        tabs: [],
        dialog: null,
      }),
    );
    expect(states).toEqual([]);

    client.dispose();
  });

  test("does NOT reset failure counter on ws.onopen before ready, and treats replaced close (1000 replaced) as terminal", async () => {
    const sockets: FakeWebSocket[] = [];
    const fallbacks: string[] = [];
    const requestTicket = vi.fn(
      async (): Promise<LiveBrowserStreamTicketResponse> => ({
        ticket: "tkt",
        expiresAt: Date.now() + 60_000,
        agentId: "main",
        wsPath: LIVE_BROWSER_PUBLIC_WS_PATH,
        protocol: LIVE_BROWSER_TICKET_PROTOCOL,
      }),
    );

    const client = new LiveBrowserStreamClient({
      agentId: "main",
      getAuth: () => MOCK_AUTH,
      maxConnectFailuresBeforeFallback: 2,
      requestTicket,
      createWebSocket: (url, protocols) => {
        const ws = new FakeWebSocket(url, protocols);
        sockets.push(ws);
        return ws as unknown as WebSocket;
      },
      callbacks: {
        onFallback: (r) => fallbacks.push(r),
      },
    });

    client.start();
    await Promise.resolve();
    await Promise.resolve();
    // 1st attempt: open then close BEFORE ready arrives -> counts as failure #1
    sockets[0]!.emitOpen();
    sockets[0]!.emitAbnormalClose(1006, "upstream bridge failed");
    expect(client.getStatus()).toBe("reconnecting");

    // 2nd attempt after backoff: open then close BEFORE ready -> failure #2 -> enters fallback!
    await vi.advanceTimersByTimeAsync(1_100);
    sockets[1]!.emitOpen();
    sockets[1]!.emitAbnormalClose(1006, "upstream bridge failed");
    expect(client.getStatus()).toBe("fallback");
    expect(fallbacks).toHaveLength(1);

    // Manual retry reaches ready, then gets replaced by another tab (1000 + "replaced") -> terminal, NO auto-reconnect!
    client.retryNow();
    await Promise.resolve();
    await Promise.resolve();
    sockets[2]!.emitOpen();
    sockets[2]!.emitMessage(
      JSON.stringify({
        type: "ready",
        protocolVersion: 1,
        agentId: "main",
        state: {
          active: true,
          agentBusy: false,
          humanTakeover: false,
          url: "https://arxiv.org",
          title: "arXiv",
          loading: false,
          tabs: [],
          dialog: null,
        },
      }),
    );
    expect(client.isConnected()).toBe(true);

    const countBeforeReplace = sockets.length;
    sockets[2]!.close(1000, "replaced by newer tab");
    expect(client.getStatus()).toBe("replaced");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(countBeforeReplace);

    client.dispose();
  });

  test("degrades immediately to fallback when ready reports cdpAvailable=false or error CDP_UNAVAILABLE", async () => {
    const sockets: FakeWebSocket[] = [];
    const fallbacks: string[] = [];

    const client = new LiveBrowserStreamClient({
      agentId: "main",
      getAuth: () => MOCK_AUTH,
      requestTicket: vi.fn(
        async (): Promise<LiveBrowserStreamTicketResponse> => ({
          ticket: "tkt",
          expiresAt: Date.now() + 60_000,
          agentId: "main",
          wsPath: LIVE_BROWSER_PUBLIC_WS_PATH,
          protocol: LIVE_BROWSER_TICKET_PROTOCOL,
        }),
      ),
      createWebSocket: (url, protocols) => {
        const ws = new FakeWebSocket(url, protocols);
        sockets.push(ws);
        return ws as unknown as WebSocket;
      },
      callbacks: {
        onFallback: (r) => fallbacks.push(r),
      },
    });

    client.start();
    await Promise.resolve();
    await Promise.resolve();
    sockets[0]!.emitOpen();
    sockets[0]!.emitMessage(
      JSON.stringify({
        type: "ready",
        protocolVersion: 1,
        agentId: "main",
        state: {
          active: true,
          agentBusy: false,
          humanTakeover: false,
          cdpAvailable: false,
          url: "https://arxiv.org",
          title: "Legacy Container",
          loading: false,
          tabs: [],
          dialog: null,
        },
      }),
    );

    expect(client.isConnected()).toBe(false);
    expect(client.getStatus()).toBe("fallback");
    expect(fallbacks).toHaveLength(1);
    client.dispose();
  });

  test("dispatches handoff_ready & handoff_vetoed events and drops stale-generation messages", async () => {
    const sockets: FakeWebSocket[] = [];
    const readyEvents: Array<{ signal: string; url: string; filename?: string }> = [];
    const vetoEvents: Array<{ reason: string; url?: string }> = [];

    const client = new LiveBrowserStreamClient({
      agentId: "main",
      getAuth: () => MOCK_AUTH,
      requestTicket: vi.fn(
        async (): Promise<LiveBrowserStreamTicketResponse> => ({
          ticket: "tkt-hr",
          expiresAt: Date.now() + 60_000,
          agentId: "main",
          wsPath: LIVE_BROWSER_PUBLIC_WS_PATH,
          protocol: LIVE_BROWSER_TICKET_PROTOCOL,
        }),
      ),
      createWebSocket: (url, protocols) => {
        const ws = new FakeWebSocket(url, protocols);
        sockets.push(ws);
        return ws as unknown as WebSocket;
      },
      callbacks: {
        onHandoffReady: (evt) =>
          readyEvents.push({ signal: evt.signal, url: evt.url, filename: evt.filename }),
        onHandoffVetoed: (evt) => vetoEvents.push({ reason: evt.reason, url: evt.url }),
      },
    });

    client.start();
    await Promise.resolve();
    await Promise.resolve();
    const ws1 = sockets[0]!;
    ws1.emitOpen();
    ws1.emitMessage(
      JSON.stringify({
        type: "handoff_ready",
        signal: "download_completed",
        url: "https://arxiv.org/abs/2501.00001",
        filename: "2501.00001.pdf",
        detectedAt: Date.now(),
      }),
    );
    ws1.emitMessage(
      JSON.stringify({
        type: "handoff_vetoed",
        reason: "visible_otp_or_captcha_input",
        url: "https://arxiv.org/abs/2501.00001",
        detectedAt: Date.now(),
      }),
    );
    expect(readyEvents).toEqual([
      {
        signal: "download_completed",
        url: "https://arxiv.org/abs/2501.00001",
        filename: "2501.00001.pdf",
      },
    ]);
    expect(vetoEvents).toEqual([
      {
        reason: "visible_otp_or_captcha_input",
        url: "https://arxiv.org/abs/2501.00001",
      },
    ]);

    // Reconnect -> late handoff_ready & handoff_vetoed from ws1 MUST be ignored by connGen fence!
    client.retryNow();
    await Promise.resolve();
    await Promise.resolve();
    ws1.emitMessage(
      JSON.stringify({
        type: "handoff_ready",
        signal: "login_completed",
        url: "https://stale.example.com",
        detectedAt: Date.now(),
      }),
    );
    ws1.emitMessage(
      JSON.stringify({
        type: "handoff_vetoed",
        reason: "page_loading",
        url: "https://stale.example.com",
        detectedAt: Date.now(),
      }),
    );
    expect(readyEvents).toHaveLength(1);
    expect(vetoEvents).toHaveLength(1);
    client.dispose();
  });
});

describe("sendLiveBrowserAction timeout guard", () => {
  test("aborts hung action request after timeoutMs and rejects with clear error instead of deadlocking", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        const sig = init?.signal;
        if (sig) {
          sig.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }
      });
    });

    const promise = sendLiveBrowserAction(
      MOCK_AUTH,
      "main",
      { action: "reload" },
      { timeoutMs: 250 },
    );
    // Attach rejection handler before advancing timers so Vitest never flags unhandled rejection.
    const assertion = expect(promise).rejects.toThrow("云端浏览器操作超时，请重试");
    await vi.advanceTimersByTimeAsync(300);
    await assertion;
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
