import { afterEach, describe, expect, test } from "vitest";
import {
  readCollapsed,
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  writeCollapsed,
} from "./sidebarCollapsed";

afterEach(() => {
  localStorage.clear();
});

describe("sidebarCollapsed", () => {
  test("缺省与非 1 都读成未折叠", () => {
    expect(readCollapsed()).toBe(false);
    localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, "0");
    expect(readCollapsed()).toBe(false);
    localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, "yes");
    expect(readCollapsed()).toBe(false);
  });

  test("写入 1 / 0 并可读回", () => {
    writeCollapsed(true);
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe("1");
    expect(readCollapsed()).toBe(true);
    writeCollapsed(false);
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe("0");
    expect(readCollapsed()).toBe(false);
  });
});
