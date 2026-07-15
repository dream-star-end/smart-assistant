import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError, api } from "../../lib/api";
import { createMemoryAuthSession } from "../../lib/authSession";
import type {
  AuthSession,
  SkillDraftDetail,
  SkillEvalCase,
  SkillEvalGenJob,
  SkillTrainRun,
} from "../../lib/types";
import { SkillEvalSection, SkillTrainSection } from "./SkillOptPanel";

const auth: AuthSession = createMemoryAuthSession(() => {}, "tok");

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

// ── AI 生成评测用例(SkillEvalSection) ───────────────────────────────────────

/** getSkillEvals 响应桩(带精确类型,保证 version:1 字面量校验)。 */
function evalsResp(cases: SkillEvalCase[]): Awaited<ReturnType<typeof api.getSkillEvals>> {
  return {
    writable: true,
    evals: cases.length ? { version: 1, cases } : null,
    lastRun: null,
  };
}

describe("SkillEvalSection AI 生成用例", () => {
  test("空用例态:主按钮 → 确认 → 轮询 done → 草稿灌入编辑器(dirty)+ 提示条", async () => {
    vi.spyOn(api, "getSkillEvals").mockResolvedValue(evalsResp([]));
    const gen = vi.spyOn(api, "generateSkillEvals").mockResolvedValue({ ok: true, runId: "g1" });
    vi.spyOn(api, "getSkillEvalGen").mockResolvedValue({
      status: "done",
      cases: [{ id: "gen-1", prompt: "把中文摘要翻译成英文", assertions: ["输出为英文"] }],
    } satisfies SkillEvalGenJob);

    render(<SkillEvalSection auth={auth} skillName="academic-translate" rates={null} />);

    // 空态显眼主按钮存在,点击弹成本确认,确认后调 POST。
    fireEvent.click(await screen.findByRole("button", { name: /AI 生成用例/ }));
    fireEvent.click(await screen.findByRole("button", { name: /接受消耗/ }));
    await waitFor(() => expect(gen).toHaveBeenCalledWith(auth, "academic-translate"));

    // 草稿灌进现有编辑器 → prompt 出现在文本域;提示条出现;保存用例可用(dirty)。
    expect(await screen.findByDisplayValue("把中文摘要翻译成英文")).toBeInTheDocument();
    expect(screen.getByText("AI 草稿已生成,请审阅修改后保存")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /保存用例/ })).toBeEnabled();
  });

  test("已有用例态:次级「补充生成」→ 追加到现有用例;不显示空态主按钮", async () => {
    vi.spyOn(api, "getSkillEvals").mockResolvedValue(
      evalsResp([{ id: "case-1", prompt: "已有任务", assertions: ["断言"] }]),
    );
    const gen = vi.spyOn(api, "generateSkillEvals").mockResolvedValue({ ok: true, runId: "g2" });
    vi.spyOn(api, "getSkillEvalGen").mockResolvedValue({
      status: "done",
      cases: [{ id: "gen-1", prompt: "补充任务", assertions: ["新断言"] }],
    } satisfies SkillEvalGenJob);

    render(<SkillEvalSection auth={auth} skillName="s" rates={null} />);

    // 有用例态:出现「补充生成」次级按钮,且没有空态主按钮(精确名不命中)。
    fireEvent.click(await screen.findByRole("button", { name: /补充生成/ }));
    expect(screen.queryByRole("button", { name: "AI 生成用例" })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /接受消耗/ }));
    await waitFor(() => expect(gen).toHaveBeenCalled());

    // 追加:原有 + 新草稿都在编辑器里。
    expect(await screen.findByDisplayValue("补充任务")).toBeInTheDocument();
    expect(screen.getByDisplayValue("已有任务")).toBeInTheDocument();
    expect(screen.getByText("AI 草稿已生成,请审阅修改后保存")).toBeInTheDocument();
  });

  test("生成失败:显示带 note 的错误提示", async () => {
    vi.spyOn(api, "getSkillEvals").mockResolvedValue(evalsResp([]));
    vi.spyOn(api, "generateSkillEvals").mockResolvedValue({ ok: true, runId: "g3" });
    vi.spyOn(api, "getSkillEvalGen").mockResolvedValue({
      status: "failed",
      note: "模型输出不是合法 JSON",
    } satisfies SkillEvalGenJob);

    render(<SkillEvalSection auth={auth} skillName="s" rates={null} />);
    fireEvent.click(await screen.findByRole("button", { name: /AI 生成用例/ }));
    fireEvent.click(await screen.findByRole("button", { name: /接受消耗/ }));

    expect(await screen.findByText(/AI 生成用例失败:模型输出不是合法 JSON/)).toBeInTheDocument();
  });

  test("POST 409 → 友好中文提示(有任务在进行中)", async () => {
    vi.spyOn(api, "getSkillEvals").mockResolvedValue(evalsResp([]));
    vi.spyOn(api, "generateSkillEvals").mockRejectedValue(
      new ApiError({ status: 409, message: "conflict" }),
    );

    render(<SkillEvalSection auth={auth} skillName="s" rates={null} />);
    fireEvent.click(await screen.findByRole("button", { name: /AI 生成用例/ }));
    fireEvent.click(await screen.findByRole("button", { name: /接受消耗/ }));

    expect(
      await screen.findByText("该技能有评测或生成任务在进行中,请稍后再试"),
    ).toBeInTheDocument();
  });

  test("生成中:禁用「运行评测」与「补充生成」,显示进度", async () => {
    vi.spyOn(api, "getSkillEvals").mockResolvedValue(
      evalsResp([{ id: "case-1", prompt: "t", assertions: ["a"] }]),
    );
    vi.spyOn(api, "generateSkillEvals").mockResolvedValue({ ok: true, runId: "g4" });
    // 一直 running → generating 持续为真。
    vi.spyOn(api, "getSkillEvalGen").mockResolvedValue({ status: "running" } satisfies SkillEvalGenJob);

    render(<SkillEvalSection auth={auth} skillName="s" rates={null} />);
    fireEvent.click(await screen.findByRole("button", { name: /补充生成/ }));
    fireEvent.click(await screen.findByRole("button", { name: /接受消耗/ }));

    expect(await screen.findByText(/AI 正在起草评测用例/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /运行评测/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /补充生成/ })).toBeDisabled();
  });
});

// ── 训练启动:差评真实使用记录提示条(SkillTrainSection) ─────────────────────

describe("SkillTrainSection 差评引用提示条", () => {
  const QUEUED_RUN: SkillTrainRun = {
    runId: "r1",
    skillName: "coding-suite",
    status: "queued",
    phase: "queued",
    proposalCount: 0,
    toolCalls: 0,
    error: null,
    summary: null,
    startedAt: 1000,
    finishedAt: null,
    evalRunId: null,
  };

  /** 渲染 → 点「训练优化」→ 过成本确认,进入训练启动。 */
  async function launchTraining() {
    render(<SkillTrainSection auth={auth} skillName="coding-suite" rates={null} />);
    fireEvent.click(await screen.findByRole("button", { name: /训练优化/ }));
    fireEvent.click(await screen.findByRole("button", { name: /接受消耗/ }));
  }

  test("启动响应 feedbackRefs>0 → 渲染差评引用提示条(含条数)", async () => {
    vi.spyOn(api, "listSkillTrainRuns").mockResolvedValue([]);
    vi.spyOn(api, "getSkillTrainRun").mockResolvedValue(QUEUED_RUN);
    const start = vi
      .spyOn(api, "startSkillTrain")
      .mockResolvedValue({ ok: true, runId: "r1", feedbackRefs: 3 });

    await launchTraining();

    await waitFor(() => expect(start).toHaveBeenCalledWith(auth, "coding-suite", { autoEval: true }));
    expect(
      await screen.findByText(/已找到 3 条你差评过的真实使用记录/),
    ).toBeInTheDocument();
  });

  test("启动响应不含 feedbackRefs(旧后端) → 不渲染提示条(容错)", async () => {
    vi.spyOn(api, "listSkillTrainRuns").mockResolvedValue([]);
    vi.spyOn(api, "getSkillTrainRun").mockResolvedValue(QUEUED_RUN);
    vi.spyOn(api, "startSkillTrain").mockResolvedValue({ ok: true, runId: "r1" });

    await launchTraining();

    // 训练已启动(进入 run 面板,出现阶段标签),但差评提示条不存在。
    expect(await screen.findByText(/排队中/)).toBeInTheDocument();
    expect(screen.queryByText(/差评过的真实使用记录/)).not.toBeInTheDocument();
  });

  test("启动响应 feedbackRefs=0 → 不渲染提示条", async () => {
    vi.spyOn(api, "listSkillTrainRuns").mockResolvedValue([]);
    vi.spyOn(api, "getSkillTrainRun").mockResolvedValue(QUEUED_RUN);
    vi.spyOn(api, "startSkillTrain").mockResolvedValue({ ok: true, runId: "r1", feedbackRefs: 0 });

    await launchTraining();

    expect(await screen.findByText(/排队中/)).toBeInTheDocument();
    expect(screen.queryByText(/差评过的真实使用记录/)).not.toBeInTheDocument();
  });
});
