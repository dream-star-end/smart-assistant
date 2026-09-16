import { describe, expect, test } from "vitest";
import type { InflightDelegateItem } from "../lib/chat/inflightDelegates";
import {
  filterVisibleInflightItems,
  readDismissedDelegates,
  TERMINAL_RECENCY_MS,
  writeDismissedDelegates,
} from "./useInflightDelegates";

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
