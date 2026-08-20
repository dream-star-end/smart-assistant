import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ChatProject } from "../lib/types";
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
  render(
    <ProjectSettingsDialog
      open
      project={project}
      onClose={onClose}
      onSave={onSave}
      {...overrides}
    />,
  );
  return { onClose, onSave };
}

describe("ProjectSettingsDialog", () => {
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
    expect(screen.getByRole("alert").textContent).toMatch(/后端拒绝保存|保存项目设置失败/);
  });

  test("ESC 关闭", async () => {
    const { onClose } = renderDialog();
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
