import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  countSubstantiveHistoryMessages,
  isSubstantiveHistoryMessage,
  sessionHistorySurface,
} from "./historyLoadState";

describe("countSubstantiveHistoryMessages", () => {
  test("settled permission cards and system/runtime-event orphans do not count as substantive history", () => {
    expect(
      countSubstantiveHistoryMessages([
        { role: "permission", _resolved: true },
        { role: "system" },
        { role: "runtime-event" },
      ]),
    ).toBe(0);
    expect(isSubstantiveHistoryMessage(null)).toBe(false);
    expect(isSubstantiveHistoryMessage({})).toBe(false);
  });

  test("unresolved non-expired or controlPending permission cards still count as substantive", () => {
    const now = 10_000;
    expect(
      isSubstantiveHistoryMessage({ role: "permission", _resolved: false, _askUserExpiresAt: now + 5_000 }, now),
    ).toBe(true);
    expect(
      isSubstantiveHistoryMessage({ role: "permission", _resolved: true, _controlPending: true }, now),
    ).toBe(true);
    expect(
      isSubstantiveHistoryMessage({ role: "permission", _resolved: false, _askUserExpiresAt: now - 1 }, now),
    ).toBe(false);
  });

  test("real transcript rows mixed with settled permission cards count properly", () => {
    expect(
      countSubstantiveHistoryMessages([
        { role: "user" },
        { role: "permission", _resolved: true },
        { role: "assistant" },
      ]),
    ).toBe(2);
  });
});

describe("sessionHistorySurface", () => {
  test("GET 5xx + known non-empty session is error, never empty welcome", () => {
    expect(sessionHistorySurface({
      loadingHistory: false,
      hasMessages: false,
      knownNonEmpty: true,
      historyError: true,
    })).toBe("error");
  });

  test("404-equivalent empty new session still shows empty", () => {
    expect(sessionHistorySurface({
      loadingHistory: false,
      hasMessages: false,
      knownNonEmpty: false,
      historyError: false,
    })).toBe("empty");
  });

  test("cached messages stay on the message surface even if GET later fails", () => {
    expect(sessionHistorySurface({
      loadingHistory: false,
      hasMessages: true,
      knownNonEmpty: true,
      historyError: true,
    })).toBe("messages");
  });
});

test("App.tsx routes GET failure + messageCount through sessionHistorySurface, not EmptyState", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "../../App.tsx"), "utf8");
  // OCV5-466: the derivation lives in hooks/useHistorySkeleton; App consumes its historySurface.
  const hookSource = readFileSync(join(here, "../../hooks/useHistorySkeleton.ts"), "utf8");
  expect(source).toContain("useHistorySkeleton({");
  expect(hookSource).toContain("sessionHistorySurface({");
  expect(hookSource).toContain("historyError: !demo && input.historyError !== null");
  expect(source).toContain('historySurface === "error"');
  expect(source).toContain("retryHistory(activeId)");
  const errorIdx = source.indexOf('historySurface === "error"');
  const emptyIdx = source.indexOf("<EmptyState");
  expect(errorIdx).toBeGreaterThan(0);
  expect(emptyIdx).toBeGreaterThan(errorIdx);
});
