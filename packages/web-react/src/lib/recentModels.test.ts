import { afterEach, describe, expect, test } from "vitest";
import { readRecentModels, writeRecentModel } from "./recentModels";

afterEach(() => {
  localStorage.clear();
});

describe("recentModels", () => {
  test("最新在前且去重", () => {
    writeRecentModel("a");
    writeRecentModel("b");
    writeRecentModel("a");
    expect(readRecentModels()).toEqual(["a", "b"]);
  });

  test("最多保留 3 个", () => {
    writeRecentModel("a");
    writeRecentModel("b");
    writeRecentModel("c");
    writeRecentModel("d");
    expect(readRecentModels()).toEqual(["d", "c", "b"]);
  });

  test("空 id 不写", () => {
    writeRecentModel("a");
    writeRecentModel("");
    expect(readRecentModels()).toEqual(["a"]);
  });
});
