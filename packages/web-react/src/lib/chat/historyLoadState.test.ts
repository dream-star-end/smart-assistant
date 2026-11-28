import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  countSubstantiveHistoryMessages,
  isSubstantiveHistoryMessage,
  sessionHistorySurface,
} from "./historyLoadState";

function collectSourceFiles(dir: string): Array<{ path: string; contents: string }> {
  if (!existsSync(dir)) return [];
  const results: Array<{ path: string; contents: string }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__" && entry.name !== "__fixtures__") {
        results.push(...collectSourceFiles(full));
      }
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.(?:ts|tsx)$/.test(entry.name)) continue;
    if (/\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name) || entry.name.endsWith(".d.ts")) continue;
    results.push({ path: full, contents: readFileSync(full, "utf8") });
  }
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

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

test("App routes GET failure + messageCount through sessionHistorySurface, not EmptyState", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const srcRoot = join(here, "../..");
  const appPath = join(srcRoot, "App.tsx");
  const appFiles = [
    { path: appPath, contents: readFileSync(appPath, "utf8") },
    ...collectSourceFiles(join(srcRoot, "hooks")),
    ...collectSourceFiles(join(srcRoot, "components")),
  ];
  const aggregated = appFiles.map((file) => file.contents).join("\n");
  const hookSources = collectSourceFiles(join(srcRoot, "hooks"))
    .map((file) => file.contents)
    .join("\n");

  expect(aggregated).toContain("useHistorySkeleton({");
  expect(hookSources).toContain("sessionHistorySurface({");
  expect(hookSources).toContain("historyError: !demo && input.historyError !== null");
  expect(aggregated).toMatch(/\bretryHistory\s*\(/);

  // Locate whichever component/facade renders the history surface branches after App splits.
  const surfaceFiles = appFiles.filter((file) => file.contents.includes('historySurface === "error"'));
  expect(surfaceFiles.length).toBeGreaterThan(0);
  for (const surface of surfaceFiles) {
    const errorIdx = surface.contents.indexOf('historySurface === "error"');
    const emptyComponentIdx = surface.contents.indexOf("<EmptyState");
    const emptySurfaceIdx = surface.contents.indexOf('historySurface === "empty"');
    expect(errorIdx).toBeGreaterThan(-1);
    expect(emptyComponentIdx > errorIdx || emptySurfaceIdx > errorIdx).toBe(true);
    if (emptyComponentIdx !== -1) {
      expect(emptyComponentIdx).toBeGreaterThan(errorIdx);
    }
  }
});
