// @vitest-environment node
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { buildSync } from "esbuild";
import { describe, expect, it } from "vitest";
import { taskboardEnabledFromBuildEnv } from "./taskboardFeature";

describe("taskboard commercial build flag", () => {
  it("keeps selfhost/default builds enabled", () => {
    expect(taskboardEnabledFromBuildEnv(undefined)).toBe(true);
    expect(taskboardEnabledFromBuildEnv("1")).toBe(true);
  });

  it("hides only an explicitly disabled commercial build", () => {
    expect(taskboardEnabledFromBuildEnv("0")).toBe(false);
    expect(taskboardEnabledFromBuildEnv("false")).toBe(true);
  });
});

function bundledTaskboardFlag(define?: Record<string, string>): unknown {
  const result = buildSync({
    entryPoints: [fileURLToPath(new URL("./taskboardFeature.ts", import.meta.url))],
    bundle: true,
    format: "iife",
    globalName: "Taskboard",
    write: false,
    logLevel: "silent",
    define,
  });
  const context: { Taskboard?: { TASKBOARD_ENABLED: boolean } } = {};
  runInNewContext(result.outputFiles[0].text, context);
  return context.Taskboard?.TASKBOARD_ENABLED;
}

describe("taskboard module initialization outside Vite", () => {
  it("initializes the real IIFE module without an import.meta.env object", () => {
    expect(bundledTaskboardFlag()).toBe(true);
  });

  it("preserves an explicitly disabled build after optional env access", () => {
    expect(bundledTaskboardFlag({ "import.meta.env.VITE_TASKBOARD_ENABLED": '"0"' })).toBe(false);
  });

  it("preserves an explicitly enabled build", () => {
    expect(bundledTaskboardFlag({ "import.meta.env.VITE_TASKBOARD_ENABLED": '"1"' })).toBe(true);
  });
});
