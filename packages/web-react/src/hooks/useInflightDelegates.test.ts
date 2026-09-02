import { describe, expect, test } from "vitest";
import type { InflightDelegateItem } from "../lib/chat/inflightDelegates";
import { filterVisibleInflightItems, TERMINAL_RECENCY_MS } from "./useInflightDelegates";

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
