import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError, api } from "../lib/api";
import { createMemoryAuthSession } from "../lib/authSession";
import { taskboardApi } from "../lib/taskboard";
import type { ChatProject } from "../lib/types";
import { ToastProvider, TooltipProvider } from "./ui";
import { PROJECT_COLORS, ProjectSettingsDialog } from "./ProjectSettingsDialog";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const project: ChatProject = {
  id: "p1",
  name: "调研",
  instructions: "用中文回答",
  color: "accent",
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
  sessionCount: 2,
};

function renderDialog(
  overrides: Partial<ComponentProps<typeof ProjectSettingsDialog>> = {},
) {
  const onClose = overrides.onClose ?? vi.fn();
  const onSave = overrides.onSave ?? vi.fn().mockResolvedValue(undefined);
  const auth = overrides.authSession ?? createMemoryAuthSession(() => {}, "tok");
  render(
    <ToastProvider>
      <TooltipProvider>
        <ProjectSettingsDialog
          open
          project={project}
          onClose={onClose}
          onSave={onSave}
          auth={auth}
          authSession={auth}
          {...overrides}
        />
      </TooltipProvider>
    </ToastProvider>,
  );
  return { onClose, onSave, auth };
}

describe("ProjectSettingsDialog", () => {
  beforeEach(() => {
    vi.spyOn(taskboardApi, "listProjects").mockResolvedValue([]);
  });

  test("PROJECT_COLORS 恰好 8 项", () => {
    expect(PROJECT_COLORS).toHaveLength(8);
  });

  test("字数超限禁用保存", () => {
    renderDialog();
    const textarea = screen.getByLabelText("自定义指令");
    fireEvent.change(textarea, { target: { value: "x".repeat(4001) } });
    expect(screen.getByText("4001 / 4000")).toBeTruthy();
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  });

  test("颜色选择回传 key", async () => {
    const { onSave } = renderDialog({
      project: { ...project, color: null },
    });
    fireEvent.click(screen.getByRole("radio", { name: "绿" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ color: "success", name: "调研" }),
      ),
    );
  });

  test("清空颜色回传 null", async () => {
    const { onSave } = renderDialog();
    fireEvent.click(screen.getByRole("radio", { name: "无颜色" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ color: null })),
    );
  });

  test("保存失败留在弹窗", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("后端拒绝保存"));
    const onClose = vi.fn();
    renderDialog({ onSave, onClose });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
    // setError lands one microtask after onSave rejects; wait for the alert instead of reading it synchronously.
    expect((await screen.findByRole("alert")).textContent).toMatch(/后端拒绝保存|保存项目设置失败/);
  });

  test("ESC 关闭", async () => {
    const { onClose } = renderDialog();
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  test("绑定态保存不把 instructions 写入 PG patch", async () => {
    vi.spyOn(taskboardApi, "listProjects").mockResolvedValue([
      { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", key: "B", name: "Board" } as never,
    ]);
    vi.spyOn(taskboardApi, "getProjectContext").mockResolvedValue({
      version: 2,
      instructions: "from-project-md",
    });
    const put = vi.spyOn(taskboardApi, "putProjectContext").mockResolvedValue({
      ok: true,
      context: { version: 3, instructions: "from-project-md" },
    });
    const { onSave } = renderDialog({
      project: {
        ...project,
        boardProjectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      },
    });
    await waitFor(() => expect(taskboardApi.getProjectContext).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByLabelText("自定义指令")).toHaveValue("from-project-md"));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put).toHaveBeenCalledWith(
      expect.anything(),
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      expect.objectContaining({ expectedVersion: 2, instructions: "from-project-md" }),
    );
    expect(onSave).toHaveBeenCalledWith(
      expect.not.objectContaining({ instructions: expect.anything() }),
    );
  });

  test("设置 / 资产 tab 切换，保存行为不回归", async () => {
    vi.spyOn(api, "listProjectAssets").mockResolvedValue([]);
    const { onSave, auth } = renderDialog();
    expect(screen.getByRole("tab", { name: "设置" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("自定义指令")).toBeTruthy();
    expect(screen.getByRole("button", { name: "保存" })).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "资产" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "资产" })).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByRole("button", { name: "上传参考资料" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
    expect(api.listProjectAssets).toHaveBeenCalledWith(auth, "p1");

    fireEvent.click(screen.getByRole("tab", { name: "设置" }));
    await waitFor(() => expect(screen.getByLabelText("自定义指令")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ name: "调研", color: "accent", instructions: "用中文回答" }),
      ),
    );
  });

  // PS-01：切换看板项目此前直接 setInstructions 覆盖用户已输入的指令（数据丢失）。
  describe("切换看板项目时的指令回填", () => {
    const boardId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    function mockBoard(instructions: string) {
      vi.spyOn(taskboardApi, "listProjects").mockResolvedValue([
        { id: boardId, key: "B", name: "Board" } as never,
      ]);
      vi.spyOn(taskboardApi, "getProjectContext").mockResolvedValue({ version: 2, instructions });
    }

    test("已有不同内容 → 不覆盖，先问；「保留当前内容」原文不动", async () => {
      mockBoard("from-project-md");
      renderDialog();
      await waitFor(() => expect(screen.getByRole("option", { name: "B · Board" })).toBeTruthy());
      fireEvent.change(screen.getByLabelText("绑定任务面板项目"), { target: { value: boardId } });
      const ask = await screen.findByText(/所选看板项目自带的指令与当前内容不同/);
      expect(ask).toBeTruthy();
      expect(screen.getByLabelText("自定义指令")).toHaveValue("用中文回答");
      fireEvent.click(screen.getByRole("button", { name: "保留当前内容" }));
      expect(screen.queryByText(/所选看板项目自带的指令与当前内容不同/)).toBeNull();
      expect(screen.getByLabelText("自定义指令")).toHaveValue("用中文回答");
    });

    test("「用看板指令覆盖」才替换文本域", async () => {
      mockBoard("from-project-md");
      renderDialog();
      await waitFor(() => expect(screen.getByRole("option", { name: "B · Board" })).toBeTruthy());
      fireEvent.change(screen.getByLabelText("绑定任务面板项目"), { target: { value: boardId } });
      fireEvent.click(await screen.findByRole("button", { name: "用看板指令覆盖" }));
      expect(screen.getByLabelText("自定义指令")).toHaveValue("from-project-md");
      expect(screen.queryByRole("button", { name: "用看板指令覆盖" })).toBeNull();
    });

    test("文本域为空时直接回填，不打扰", async () => {
      mockBoard("from-project-md");
      renderDialog({ project: { ...project, instructions: "" } });
      await waitFor(() => expect(screen.getByRole("option", { name: "B · Board" })).toBeTruthy());
      fireEvent.change(screen.getByLabelText("绑定任务面板项目"), { target: { value: boardId } });
      await waitFor(() => expect(screen.getByLabelText("自定义指令")).toHaveValue("from-project-md"));
      expect(screen.queryByRole("button", { name: "用看板指令覆盖" })).toBeNull();
    });
  });

  // PS-07：看板指令版本冲突与普通失败此前同报「保存项目设置失败」。
  test("绑定态保存遇 409 版本冲突 → 提示重新打开再保存，而不是通用失败文案", async () => {
    const boardId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    vi.spyOn(taskboardApi, "listProjects").mockResolvedValue([
      { id: boardId, key: "B", name: "Board" } as never,
    ]);
    vi.spyOn(taskboardApi, "getProjectContext").mockResolvedValue({ version: 2, instructions: "x" });
    vi.spyOn(taskboardApi, "putProjectContext").mockRejectedValue(
      new ApiError({ status: 409, message: "version conflict", code: "version_conflict" }),
    );
    const { onSave, onClose } = renderDialog({ project: { ...project, boardProjectId: boardId } });
    await waitFor(() => expect(screen.getByLabelText("自定义指令")).toHaveValue("x"));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect((await screen.findByRole("alert")).textContent).toContain("重新打开");
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  test("字数计数与标签同行，不再被 footer 遮住（PS-06）", () => {
    renderDialog();
    const counter = screen.getByText("5 / 4000");
    expect(counter.closest("label")).not.toBeNull();
  });

  test("看板列表加载失败：提示+重试，下拉禁用，保存仍可用", async () => {
    vi.spyOn(taskboardApi, "listProjects").mockRejectedValue(new Error("board down"));
    const { onSave } = renderDialog();
    expect(await screen.findByText("看板列表加载失败")).toBeTruthy();
    expect(screen.getByLabelText("绑定任务面板项目")).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ name: "调研", color: "accent" }),
      ),
    );
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
  });

  // PS-02：看板绑定此前是裸 <select> + 手写类名，与设计系统其它下拉不一致。
  test("看板绑定下拉走 ui/Select：选项含「不绑定」与 key · name，仍可按 aria-label 取到", async () => {
    vi.spyOn(taskboardApi, "listProjects").mockResolvedValue([
      { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", key: "B", name: "Board" } as never,
    ]);
    renderDialog();
    const select = screen.getByLabelText("绑定任务面板项目");
    await waitFor(() => expect(select.querySelectorAll("option")).toHaveLength(2));
    expect(Array.from(select.querySelectorAll("option")).map((o) => o.textContent)).toEqual([
      "不绑定",
      "B · Board",
    ]);
    // 与 Input 同构的控件表面（appearance-none + 自绘箭头），不再是手写的 rounded-md/px-2。
    expect(select.className).toContain("appearance-none");
    expect(select.className).not.toContain("px-2");
  });

  // PS-03：关闭（Esc / 遮罩 / 取消）此前无脏检查，编辑中的名称 / 指令误触即丢。
  describe("关闭前脏检查（PS-03）", () => {
    test("有未保存改动时按 Esc：先弹确认，「继续编辑」留在弹窗，「放弃修改」才关闭", async () => {
      const { onClose } = renderDialog();
      fireEvent.change(screen.getByLabelText("自定义指令"), { target: { value: "改了一段" } });
      fireEvent.keyDown(document, { key: "Escape" });
      expect(await screen.findByText("放弃未保存的修改？")).toBeTruthy();
      expect(onClose).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
      await waitFor(() => expect(screen.queryByText("放弃未保存的修改？")).toBeNull());
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByLabelText("自定义指令")).toHaveValue("改了一段");

      fireEvent.click(screen.getByRole("button", { name: "取消" }));
      fireEvent.click(await screen.findByRole("button", { name: "放弃修改" }));
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    });

    test("没有改动：取消直接关闭，不弹确认", async () => {
      const { onClose } = renderDialog();
      fireEvent.click(screen.getByRole("button", { name: "取消" }));
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(screen.queryByText("放弃未保存的修改？")).toBeNull();
    });

    test("首次打开由看板指令自动回填不算改动：Esc 直接关闭", async () => {
      const boardId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      vi.spyOn(taskboardApi, "listProjects").mockResolvedValue([
        { id: boardId, key: "B", name: "Board" } as never,
      ]);
      vi.spyOn(taskboardApi, "getProjectContext").mockResolvedValue({
        version: 2,
        instructions: "from-board",
      });
      const { onClose } = renderDialog({ project: { ...project, boardProjectId: boardId } });
      await waitFor(() => expect(screen.getByLabelText("自定义指令")).toHaveValue("from-board"));
      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(screen.queryByText("放弃未保存的修改？")).toBeNull();
    });
  });
});
