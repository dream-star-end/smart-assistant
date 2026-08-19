import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { sessionHistorySurface } from "./historyLoadState";

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
  expect(source).toContain("sessionHistorySurface");
  expect(source).toContain('historySurface === "error"');
  expect(source).toContain("retryHistory(activeId)");
  const errorIdx = source.indexOf('historySurface === "error"');
  const emptyIdx = source.indexOf("<EmptyState");
  expect(errorIdx).toBeGreaterThan(0);
  expect(emptyIdx).toBeGreaterThan(errorIdx);
});
