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
