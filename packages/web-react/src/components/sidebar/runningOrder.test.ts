import { describe, expect, it } from "vitest";
import {
  compareByUpdatedDesc,
  compareSessionsRunningThenUpdated,
  partitionProjectsRunningFirst,
  sortSessionsRunningThenUpdated,
} from "./runningOrder";

function s(id: string, updatedAt: string) {
  return { id, updatedAt };
}

describe("compareByUpdatedDesc", () => {
  it("更新时间倒序；同时间按 id 升序，结果确定", () => {
    expect(compareByUpdatedDesc(s("a", "2026-01-02"), s("b", "2026-01-01"))).toBeLessThan(0);
    expect(compareByUpdatedDesc(s("a", "2026-01-01"), s("b", "2026-01-02"))).toBeGreaterThan(0);
    expect(compareByUpdatedDesc(s("a", "same"), s("b", "same"))).toBeLessThan(0);
    expect(compareByUpdatedDesc(s("b", "same"), s("a", "same"))).toBeGreaterThan(0);
    expect(compareByUpdatedDesc(s("a", "same"), s("a", "same"))).toBe(0);
  });
});

describe("sortSessionsRunningThenUpdated", () => {
  it("组内运行中置顶；多个运行中仍按更新时间倒序；空闲保持时间倒序", () => {
    const running = new Set(["run-old", "run-new"]);
    const ordered = sortSessionsRunningThenUpdated(
      [
        s("idle-new", "2026-08-20T12:00:00.000Z"),
        s("run-old", "2026-08-20T10:00:00.000Z"),
        s("idle-old", "2026-08-20T09:00:00.000Z"),
        s("run-new", "2026-08-20T11:00:00.000Z"),
      ],
      running,
    ).map((x) => x.id);
    expect(ordered).toEqual(["run-new", "run-old", "idle-new", "idle-old"]);
  });

  it("会话结束后回落到按时间该在的位置（不再因曾运行而粘在顶部）", () => {
    const list = [
      s("was-running", "2026-08-20T10:00:00.000Z"),
      s("newer-idle", "2026-08-20T12:00:00.000Z"),
    ];
    expect(sortSessionsRunningThenUpdated(list, new Set(["was-running"])).map((x) => x.id)).toEqual([
      "was-running",
      "newer-idle",
    ]);
    expect(sortSessionsRunningThenUpdated(list, new Set()).map((x) => x.id)).toEqual([
      "newer-idle",
      "was-running",
    ]);
  });

  it("同时间戳多次排序结果一致（稳定，不因输入顺序抖动）", () => {
    const running = new Set(["r"]);
    const a = [s("r", "t"), s("z", "t"), s("m", "t")];
    const b = [s("m", "t"), s("r", "t"), s("z", "t")];
    expect(sortSessionsRunningThenUpdated(a, running).map((x) => x.id)).toEqual(["r", "m", "z"]);
    expect(sortSessionsRunningThenUpdated(b, running).map((x) => x.id)).toEqual(["r", "m", "z"]);
  });

  it("比较函数与 sort 一致：运行中永远小于空闲", () => {
    const running = new Set(["r"]);
    expect(compareSessionsRunningThenUpdated(s("r", "old"), s("i", "new"), running)).toBeLessThan(0);
    expect(compareSessionsRunningThenUpdated(s("i", "new"), s("r", "old"), running)).toBeGreaterThan(0);
  });
});

describe("partitionProjectsRunningFirst", () => {
  it("含运行会话的真实项目上浮，其余保持既有相对序；无运行时不改序", () => {
    const projects = [{ id: "p-a" }, { id: "p-b" }, { id: "p-c" }];
    expect(partitionProjectsRunningFirst(projects, (id) => id === "p-c" || id === "p-b").map((p) => p.id)).toEqual([
      "p-b",
      "p-c",
      "p-a",
    ]);
    expect(partitionProjectsRunningFirst(projects, () => false).map((p) => p.id)).toEqual(["p-a", "p-b", "p-c"]);
  });

  it("多个运行项目之间保持传入的相对序（即既有 sortOrder / 拖拽覆盖）", () => {
    const projects = [{ id: "first" }, { id: "second" }, { id: "third" }];
    expect(partitionProjectsRunningFirst(projects, (id) => id === "first" || id === "third").map((p) => p.id)).toEqual([
      "first",
      "third",
      "second",
    ]);
  });
});
