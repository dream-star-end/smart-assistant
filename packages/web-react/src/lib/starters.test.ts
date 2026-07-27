import { describe, expect, test } from "vitest";
import {
  FIRST_TASK_STARTERS,
  LANDING_STARTERS,
  PRESET_AGENT_STARTERS,
  STARTERS,
  isClickToRun,
  isDifferentiated,
  type Starter,
} from "./starters";

const clickToRunLists: readonly (readonly Starter[])[] = [
  FIRST_TASK_STARTERS,
  ...Object.values(PRESET_AGENT_STARTERS),
];

describe("starter catalog", () => {
  test("every prompt is complete and catalog keys remain stable ids", () => {
    for (const [key, starter] of Object.entries(STARTERS)) {
      expect(starter.id).toBe(key);
      expect(starter.prompt.length).toBeGreaterThan(12);
      expect(starter.prompt).not.toMatch(/[<＜].*[>＞]/);
      expect(starter.prompt).not.toMatch(/\.{3}$|…$/);
    }
  });

  test("the first screen leads with at least two differentiated deliverables", () => {
    expect(isDifferentiated(FIRST_TASK_STARTERS[0])).toBe(true);
    expect(isDifferentiated(FIRST_TASK_STARTERS[1])).toBe(true);
    expect(FIRST_TASK_STARTERS.filter(isDifferentiated).length).toBeGreaterThanOrEqual(2);
  });

  test("click-to-run surfaces never require missing attachments, repos, or context", () => {
    for (const list of clickToRunLists) {
      expect(list.length).toBeGreaterThan(0);
      for (const starter of list) expect(isClickToRun(starter)).toBe(true);
    }
  });

  test("all consumer lists reuse catalog objects instead of copying prompts", () => {
    const catalog = new Set<Starter>(Object.values(STARTERS));
    for (const list of [...clickToRunLists, LANDING_STARTERS]) {
      for (const starter of list) expect(catalog.has(starter)).toBe(true);
    }
  });

  test("all three platform presets have task cards", () => {
    expect(Object.keys(PRESET_AGENT_STARTERS).sort()).toEqual([
      "coding-assistant",
      "office-assistant",
      "research-assistant",
    ]);
  });
});
