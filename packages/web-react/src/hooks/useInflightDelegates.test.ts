import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createMemoryAuthSession } from "../lib/authSession";
import { activeBackgroundDelegateJobIds } from "../lib/chat/backgroundDelegates";
import type { ChatMessage } from "../lib/chat/model";
import { fetchInflightDelegatesResult, type InflightDelegateItem } from "../lib/chat/inflightDelegates";
import {
  filterVisibleInflightItems,
  readDismissedDelegates,
  TERMINAL_RECENCY_MS,
  useInflightDelegates,
  writeDismissedDelegates,
} from "./useInflightDelegates";

vi.mock("../lib/chat/inflightDelegates", async (original) => ({
  ...await original<typeof import("../lib/chat/inflightDelegates")>(),
  fetchInflightDelegatesResult: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(fetchInflightDelegatesResult).mockReset();
});

function item(over: Partial<InflightDelegateItem> = {}): InflightDelegateItem {
  return {
    jobId: "dlgjob-1",
    runId: "dlg-1",
    agentId: "coding-assistant",
    goal: "goal",
    state: "running",
    liveHint: "",
    updatedAt: 1_000_000,
    parentSessionKey: "agent:main:webchat:dm:web-1",
    ...over,
  };
}

const none = new Set<string>();

describe("inflight read failures", () => {
  const auth = createMemoryAuthSession(() => {}, "tok");

  test("keeps confirmed jobs after a failed read and polls again after backoff", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const running = item({ updatedAt: Date.now() });
    const completed = { ...running, state: "completed" as const };
    vi.mocked(fetchInflightDelegatesResult)
      .mockResolvedValueOnce({ ok: true, items: [running] })
      .mockResolvedValueOnce({ ok: false, notFound: false })
      .mockResolvedValueOnce({ ok: true, items: [completed] });
    const { result } = renderHook(() => useInflightDelegates({ sessionId: "s1", messages: [], enabled: true, auth }));
    await act(async () => {});
    expect(result.current.items).toEqual([running]);
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(result.current.items).toEqual([running]);
    expect(result.current.degraded).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(29_999));
    expect(fetchInflightDelegatesResult).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(result.current.items).toEqual([completed]);
    expect(result.current.degraded).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(fetchInflightDelegatesResult).toHaveBeenCalledTimes(3);
  });

  test("an initial failure also retries, with backoff capped at 60 seconds", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.mocked(fetchInflightDelegatesResult).mockResolvedValue({ ok: false, notFound: false });
    const { result } = renderHook(() => useInflightDelegates({ sessionId: "s1", messages: [], enabled: true, auth }));
    await act(async () => {});
    expect(result.current.degraded).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(fetchInflightDelegatesResult).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(fetchInflightDelegatesResult).toHaveBeenCalledTimes(4);
  });

  test("a missing route retains confirmed jobs but keeps the existing no-retry contract", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const running = item();
    vi.mocked(fetchInflightDelegatesResult)
      .mockResolvedValueOnce({ ok: true, items: [running] })
      .mockResolvedValueOnce({ ok: false, notFound: true });
    const { result } = renderHook(() => useInflightDelegates({ sessionId: "s1", messages: [], enabled: true, auth }));
    await act(async () => {});
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(result.current.items).toEqual([running]);
    expect(result.current.degraded).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(fetchInflightDelegatesResult).toHaveBeenCalledTimes(2);
  });
});

describe("filterVisibleInflightItems", () => {
  test("running items always visible", () => {
    const out = filterVisibleInflightItems([item()], { dismissed: none, seenLive: none, now: 0 });
    expect(out).toHaveLength(1);
  });

  test("dismissed terminal item hidden", () => {
    const out = filterVisibleInflightItems([item({ state: "completed" })], {
      dismissed: new Set(["dlgjob-1"]),
      seenLive: none,
      now: 1_000_000,
    });
    expect(out).toHaveLength(0);
  });

  test("stale terminal item from an old session is not pinned on open", () => {
    const now = 1_000_000 + TERMINAL_RECENCY_MS + 1;
    const out = filterVisibleInflightItems([item({ state: "completed" })], {
      dismissed: none,
      seenLive: none,
      now,
    });
    expect(out).toHaveLength(0);
  });

  test("recent terminal item is visible", () => {
    const now = 1_000_000 + TERMINAL_RECENCY_MS - 1;
    const out = filterVisibleInflightItems([item({ state: "failed" })], {
      dismissed: none,
      seenLive: none,
      now,
    });
    expect(out).toHaveLength(1);
  });

  test("terminal item this tab watched running stays visible past the window", () => {
    const now = 1_000_000 + TERMINAL_RECENCY_MS * 10;
    const out = filterVisibleInflightItems([item({ state: "completed" })], {
      dismissed: none,
      seenLive: new Set(["dlgjob-1"]),
      now,
    });
    expect(out).toHaveLength(1);
  });
});

function memoryStorage(): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => {
      data.delete(k);
    },
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
}

describe("dismissed 持久化(H-14)", () => {
  test("按会话读写;空集合删键;换会话互不串", () => {
    const storage = memoryStorage();
    writeDismissedDelegates("s1", new Set(["a", "b"]), storage);
    expect(readDismissedDelegates("s1", storage)).toEqual(new Set(["a", "b"]));
    expect(readDismissedDelegates("s2", storage)).toEqual(new Set());
    writeDismissedDelegates("s1", new Set(), storage);
    expect(storage.data.size).toBe(0);
  });

  test("无 sessionId / 存储不可用 / 脏数据 → 退化成空集合,不抛", () => {
    expect(readDismissedDelegates(null, memoryStorage())).toEqual(new Set());
    expect(readDismissedDelegates("s1", null)).toEqual(new Set());
    const storage = memoryStorage();
    storage.setItem("oc_inflight_dismissed:s1", "{not json");
    expect(readDismissedDelegates("s1", storage)).toEqual(new Set());
    storage.setItem("oc_inflight_dismissed:s1", JSON.stringify([1, "", "ok", null]));
    expect(readDismissedDelegates("s1", storage)).toEqual(new Set(["ok"]));
    const throwing = {
      ...memoryStorage(),
      setItem: () => {
        throw new Error("quota");
      },
    } as unknown as Storage;
    expect(() => writeDismissedDelegates("s1", new Set(["a"]), throwing)).not.toThrow();
  });

  test("超过 64 条只保留最近的 64 条", () => {
    const storage = memoryStorage();
    const many = new Set(Array.from({ length: 70 }, (_, i) => `job-${i}`));
    writeDismissedDelegates("s1", many, storage);
    const back = readDismissedDelegates("s1", storage);
    expect(back.size).toBe(64);
    expect(back.has("job-69")).toBe(true);
    expect(back.has("job-0")).toBe(false);
  });
});

describe("background control authority is independent of HUD presentation", () => {
  const auth = createMemoryAuthSession(() => {}, "tok");
  test("dismissed and old terminal jobs remain control evidence after remount", async () => {
    const sessionId = "s-background-control";
    writeDismissedDelegates(sessionId, new Set());
    const fresh = item({ background: true, state: "completed", updatedAt: Date.now() });
    const old = item({ background: true, jobId: "dlgjob-old", runId: "dlg-old", state: "completed", updatedAt: Date.now() - TERMINAL_RECENCY_MS - 1 });
    vi.mocked(fetchInflightDelegatesResult).mockResolvedValue({ ok: true, items: [fresh, old] });
    const first = renderHook(() => useInflightDelegates({ sessionId, messages: [], enabled: true, auth }));
    await act(async () => {});
    expect(first.result.current.items).toEqual([fresh]);
    expect(first.result.current.controlItems).toEqual([fresh, old]);
    act(() => first.result.current.dismiss(fresh.jobId));
    expect(first.result.current.items).toEqual([]);
    expect(first.result.current.controlItems).toEqual([fresh, old]);
    first.unmount();
    const second = renderHook(() => useInflightDelegates({ sessionId, messages: [], enabled: true, auth }));
    await act(async () => {});
    expect(second.result.current.items).toEqual([]);
    expect(second.result.current.controlItems).toEqual([fresh, old]);
    writeDismissedDelegates(sessionId, new Set());
  });
  test("a finished card can hide HUD progress while the real running job remains stoppable during cleanup", async () => {
    const running = item({ background: true, updatedAt: Date.now() });
    vi.mocked(fetchInflightDelegatesResult).mockResolvedValue({ ok: true, items: [running] });
    const messages = [{ id: "srv-finished", role: "agent-group" as const, text: "校验", ts: Date.now(), _backgroundDelegate: true,
      _delegateRunId: running.runId, _delegateJobId: running.jobId, _completed: true }];
    const { result } = renderHook(() => useInflightDelegates({ sessionId: "s-bg-cleanup", messages, enabled: true, auth }));
    await act(async () => {});
    expect(result.current.items[0]?.state).toBe("completed");
    expect(result.current.controlItems[0]?.state).toBe("running");
  });
});

describe("new background evidence restarts an idle control snapshot (OCV5-676 R1-3)", () => {
  const auth = createMemoryAuthSession(() => {}, "tok");
  const receipt = (): ChatMessage => ({ id: "bg-start-tool", role: "tool", text: "delegate_task", ts: 1, _completed: true,
    output: JSON.stringify({ status: "running", resultDelivery: "background", jobId: "dlgjob-new" }) });
  const pending = () => item({ jobId: "dlgjob-new", runId: "dlg-new", background: true, updatedAt: Date.now() });

  test("empty entry → new receipt triggers a read, empty discovery keeps polling, cancelled without progress converges and survives remount", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    let releaseDiscovery!: (value: { ok: true; items: InflightDelegateItem[] }) => void;
    const discovery = new Promise<{ ok: true; items: InflightDelegateItem[] }>((resolve) => { releaseDiscovery = resolve; });
    const cancelled = { ...pending(), state: "cancelled" as const };
    vi.mocked(fetchInflightDelegatesResult)
      .mockResolvedValueOnce({ ok: true, items: [] })
      .mockImplementationOnce(() => discovery)
      .mockResolvedValueOnce({ ok: true, items: [pending()] })
      .mockResolvedValue({ ok: true, items: [cancelled] });
    const sessionId = "s-bg-after-empty";
    const first = renderHook(({ messages }: { messages: ChatMessage[] }) =>
      useInflightDelegates({ sessionId, messages, enabled: true, auth }), { initialProps: { messages: [] as ChatMessage[] } });
    await act(async () => {});
    expect(fetchInflightDelegatesResult).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(fetchInflightDelegatesResult).toHaveBeenCalledTimes(1);
    const messages = [receipt()];
    first.rerender({ messages });
    await act(async () => {});
    expect(fetchInflightDelegatesResult).toHaveBeenCalledTimes(2);
    expect(activeBackgroundDelegateJobIds(first.result.current.controlItems, messages)).toEqual(["dlgjob-new"]);
    await act(async () => { releaseDiscovery({ ok: true, items: [] }); });
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(first.result.current.controlItems[0]?.state).toBe("running");
    // Stop cancelled the preparing job. There is intentionally no progress/final row.
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(first.result.current.controlItems).toEqual([cancelled]);
    expect(activeBackgroundDelegateJobIds(first.result.current.controlItems, messages)).toEqual([]);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(fetchInflightDelegatesResult).toHaveBeenCalledTimes(4);
    first.unmount();
    const second = renderHook(() => useInflightDelegates({ sessionId, messages, enabled: true, auth }));
    await act(async () => {});
    expect(second.result.current.controlItems).toEqual([cancelled]);
    expect(activeBackgroundDelegateJobIds(second.result.current.controlItems, messages)).toEqual([]);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(fetchInflightDelegatesResult).toHaveBeenCalledTimes(5);
  });

  test("a new live background row also triggers discovery after the entry read was empty", async () => {
    vi.useFakeTimers();
    vi.mocked(fetchInflightDelegatesResult).mockResolvedValue({ ok: true, items: [] });
    const { result, rerender } = renderHook(({ messages }: { messages: ChatMessage[] }) =>
      useInflightDelegates({ sessionId: "s-bg-live-row", messages, enabled: true, auth }), { initialProps: { messages: [] as ChatMessage[] } });
    await act(async () => {});
    vi.mocked(fetchInflightDelegatesResult).mockResolvedValue({ ok: true, items: [pending()] });
    const messages: ChatMessage[] = [{ id: "new-live", role: "agent-group", text: "后台校验", ts: 1,
      _backgroundDelegate: true, _delegateJobId: "dlgjob-new", _completed: false }];
    rerender({ messages }); await act(async () => {});
    expect(fetchInflightDelegatesResult).toHaveBeenCalledTimes(2);
    expect(result.current.controlItems[0]?.state).toBe("running");
    rerender({ messages: [...messages] }); await act(async () => {});
    expect(fetchInflightDelegatesResult).toHaveBeenCalledTimes(2);
  });

  test("known terminal receipts and legacy running tools never start an idle polling loop", async () => {
    vi.useFakeTimers();
    vi.mocked(fetchInflightDelegatesResult).mockResolvedValue({ ok: true, items: [] });
    const { rerender } = renderHook(({ messages }: { messages: ChatMessage[] }) =>
      useInflightDelegates({ sessionId: "s-bg-terminal-history", messages, enabled: true, auth }), { initialProps: { messages: [] as ChatMessage[] } });
    await act(async () => {});
    const messages: ChatMessage[] = [receipt(), { id: "durable-done", role: "agent-group", text: "旧结果", ts: 2,
      _source: "server", _backgroundDelegate: true, _delegateJobId: "dlgjob-new", _completed: true }];
    rerender({ messages }); await act(async () => {});
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(fetchInflightDelegatesResult).toHaveBeenCalledTimes(1);
    rerender({ messages: [{ id: "legacy-tool", role: "tool", text: "delegate_task", ts: 3,
      output: JSON.stringify({ status: "running", jobId: "legacy" }) }] });
    await act(async () => {}); await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(fetchInflightDelegatesResult).toHaveBeenCalledTimes(1);
  });
});

test("a bounded discovery snapshot cannot erase a previously confirmed background terminal or revive its old receipt", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const auth = createMemoryAuthSession(() => {}, "tok");
  const old = item({ background: true, state: "cancelled", updatedAt: Date.now() });
  const next = item({ background: true, jobId: "dlgjob-next", runId: "dlg-next", state: "cancelled", updatedAt: Date.now() });
  const oldReceipt: ChatMessage = { id: "old-receipt", role: "tool", text: "delegate_task", ts: 1,
    output: JSON.stringify({ status: "running", resultDelivery: "background", jobId: old.jobId }) };
  const nextReceipt: ChatMessage = { ...oldReceipt, id: "next-receipt",
    output: JSON.stringify({ status: "running", resultDelivery: "background", jobId: next.jobId }) };
  vi.mocked(fetchInflightDelegatesResult).mockResolvedValueOnce({ ok: true, items: [old] })
    .mockResolvedValueOnce({ ok: true, items: [] }).mockResolvedValue({ ok: true, items: [next] });
  const { result, rerender } = renderHook(({ messages }: { messages: ChatMessage[] }) =>
    useInflightDelegates({ sessionId: "s-bg-retained-terminal", messages, enabled: true, auth }), { initialProps: { messages: [oldReceipt] } });
  await act(async () => {});
  expect(activeBackgroundDelegateJobIds(result.current.controlItems, [oldReceipt])).toEqual([]);
  rerender({ messages: [oldReceipt, nextReceipt] }); await act(async () => {});
  expect(fetchInflightDelegatesResult).toHaveBeenCalledTimes(2);
  expect(result.current.controlItems).toContainEqual(old);
  expect(activeBackgroundDelegateJobIds(result.current.controlItems, [oldReceipt, nextReceipt])).toEqual([next.jobId]);
  await act(() => vi.advanceTimersByTimeAsync(15_000));
  expect(activeBackgroundDelegateJobIds(result.current.controlItems, [oldReceipt, nextReceipt])).toEqual([]);
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(fetchInflightDelegatesResult).toHaveBeenCalledTimes(3);
});
