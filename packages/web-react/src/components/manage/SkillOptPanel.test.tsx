import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../../lib/api";
import type { AuthSession, SkillDraftDetail, SkillTrainRun } from "../../lib/types";
import { SkillTrainSection } from "./SkillOptPanel";

const auth = {
  getToken: () => "tok",
  setToken: () => {},
  onExpired: () => {},
} as AuthSession;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const DIFF_RUN: SkillTrainRun = {
  runId: "r1",
  skillName: "coding-suite",
  status: "diff_ready",
  phase: "diff_ready",
  proposalCount: 1,
  toolCalls: 5,
  error: null,
  summary: "已恢复暂存草稿",
  startedAt: 1000,
  finishedAt: null,
  evalRunId: null,
};

const DRAFT_DETAIL: SkillDraftDetail = {
  draft: {
    meta: { name: "coding-suite", description: "d" },
    body: "新版正文",
    rawContent: "raw",
    record: {
      name: "coding-suite",
      op: "update",
      baseVersion: "1",
      rationale: "改进理由",
      authoredBy: "ai",
      updatedAt: "t",
      runId: "r1",
      createdAt: "t",
    },
  },
  current: { body: "旧版正文", description: "d" },
};

describe("SkillTrainSection 训练 run 重入", () => {
  test("挂载时从列表找回 diff_ready run → 恢复提示条与草稿入口", async () => {
    vi.spyOn(api, "listSkillTrainRuns").mockResolvedValue([DIFF_RUN]);
    vi.spyOn(api, "getSkillTrainRun").mockResolvedValue(DIFF_RUN);
    vi.spyOn(api, "listSkillDrafts").mockResolvedValue([
      {
        name: "coding-suite",
        op: "update",
        baseVersion: "1",
        rationale: "改进理由",
        authoredBy: "ai",
        updatedAt: "t",
      },
    ]);
    vi.spyOn(api, "getSkillDraft").mockResolvedValue(DRAFT_DETAIL);

    render(<SkillTrainSection auth={auth} skillName="coding-suite" rates={null} />);

    // 恢复提示条出现。
    expect(await screen.findByText(/发现一个未处理的训练草稿/)).toBeInTheDocument();
    // diff 入口恢复：草稿视图的合并按钮可见。
    expect(await screen.findByText(/合并到技能库/)).toBeInTheDocument();
    expect(screen.getByText("草稿:coding-suite")).toBeInTheDocument();
  });

  test("无可恢复 run 时保持现状（不显示恢复提示）", async () => {
    vi.spyOn(api, "listSkillTrainRuns").mockResolvedValue([]);
    const getRun = vi.spyOn(api, "getSkillTrainRun").mockResolvedValue(DIFF_RUN);

    render(<SkillTrainSection auth={auth} skillName="coding-suite" rates={null} />);

    // 初始说明文案在，训练按钮在。
    expect(await screen.findByText(/训练优化/)).toBeInTheDocument();
    await waitFor(() => expect(api.listSkillTrainRuns).toHaveBeenCalled());
    expect(screen.queryByText(/发现一个未处理的训练草稿/)).not.toBeInTheDocument();
    // 未选中 run → 不应触发单 run 轮询。
    expect(getRun).not.toHaveBeenCalled();
  });
});
