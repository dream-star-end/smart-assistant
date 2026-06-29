import { describe, expect, test } from "vitest";
import {
  estimateCloningProgress,
  formatRepoLabel,
  githubErrorText,
  repoStatusText,
  shouldDropFrame,
  VERSION_SENTINEL_CLEARED,
} from "./github";
import type { RepoSelection } from "./types";

describe("estimateCloningProgress", () => {
  test("单调上升、封顶 90%", () => {
    expect(estimateCloningProgress(0, 0)).toBe(0);
    expect(estimateCloningProgress(0, 15_000)).toBeGreaterThan(50);
    expect(estimateCloningProgress(0, 30_000)).toBeGreaterThan(estimateCloningProgress(0, 15_000));
    expect(estimateCloningProgress(0, 600_000)).toBe(90);
  });
  test("非有限输入返回 0（含 Infinity，被 isFinite 守卫挡下）", () => {
    expect(estimateCloningProgress(Number.NaN, 1000)).toBe(0);
    expect(estimateCloningProgress(0, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("formatRepoLabel", () => {
  test("未绑定显示「仓库」+ none", () => {
    expect(formatRepoLabel(null)).toEqual({ label: "仓库", dot: "none" });
    expect(formatRepoLabel({ selected: false })).toEqual({ label: "仓库", dot: "none" });
  });
  test("已绑定显示 owner/repo@branch + status dot", () => {
    const sel: RepoSelection = {
      selected: true,
      owner: "octocat",
      repo: "hello",
      branch: "main",
      status: "cloning",
      selection_version: 3,
    };
    expect(formatRepoLabel(sel)).toEqual({ label: "octocat/hello @ main", dot: "cloning" });
  });
});

describe("shouldDropFrame（版本门控）", () => {
  test("已知版本更大 → 丢弃", () => {
    expect(shouldDropFrame(5, 3)).toBe(true);
  });
  test("同版本接受（pending→cloning→ready 多次同版本）", () => {
    expect(shouldDropFrame(3, 3)).toBe(false);
  });
  test("更新版本接受", () => {
    expect(shouldDropFrame(3, 4)).toBe(false);
  });
  test("哨兵封顶后丢弃任何普通版本帧", () => {
    expect(shouldDropFrame(VERSION_SENTINEL_CLEARED, 99)).toBe(true);
  });
  test("非有限来帧版本按 -1 处理（任何 ≥0 已知都丢弃）", () => {
    expect(shouldDropFrame(0, Number.NaN)).toBe(true);
  });
});

describe("githubErrorText", () => {
  test("已知码映射文案", () => {
    expect(githubErrorText("GITHUB_REPO_NO_WRITE")).toContain("写权限");
    expect(githubErrorText("STALE_OR_MISSING")).toContain("重新选择");
  });
  test("未知 / 空码回退通用文案，不暴露裸码", () => {
    expect(githubErrorText("WHATEVER_X")).toBe("操作失败，请重试");
    expect(githubErrorText(null)).toBe("操作失败，请重试");
  });
});

describe("repoStatusText", () => {
  test("四态文案", () => {
    expect(repoStatusText("pending")).toContain("准备");
    expect(repoStatusText("cloning")).toContain("克隆");
    expect(repoStatusText("ready")).toContain("就绪");
    expect(repoStatusText("failed")).toContain("失败");
  });
});
