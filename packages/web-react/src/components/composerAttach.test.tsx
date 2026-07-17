import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { GoalStateSnapshot } from "@openclaude/protocol/goalState";
import { AttachChip, Composer } from "./Composer";
import type { MediaRef } from "../lib/chat/frames";

afterEach(cleanup);

// onUpload 存在即 canAttach（不实际调用）。
const uploadStub = vi.fn(async () => ({}) as MediaRef);

function goalFixture(over: Partial<GoalStateSnapshot> = {}): GoalStateSnapshot {
  return {
    sessionId: "s1",
    goalId: "11111111-1111-4111-8111-111111111111",
    objective: "迁移并验证",
    status: "active",
    tokenBudget: null,
    creditBudget: null,
    tokensUsed: 0,
    creditsUsed: "0",
    timeUsedSeconds: 0,
    stateRevision: 1,
    snapshotRevision: 1,
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    statusChangedAt: "2026-07-16T00:00:00.000Z",
    ...over,
  };
}

/** Radix DropdownMenu 在 jsdom 需 pointerdown 序列开菜单（对齐 App.test）。 */
function openPlusMenu(): void {
  const trigger = screen.getByRole("button", { name: "更多选项" });
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
  fireEvent.click(trigger);
}

describe("F1 附件选择器可靠性（+ 菜单附件项 = 原生 <label htmlFor> 激活）", () => {
  test("附件项是 label[for]，绑定 file input：input 非 display:none、type=file、无 accept", () => {
    render(<Composer onSend={() => {}} onUpload={uploadStub} />);
    openPlusMenu();
    const label = screen.getByText("添加附件").closest("label");
    expect(label).not.toBeNull();
    const forId = label!.getAttribute("for");
    expect(forId).toBeTruthy();
    const input = document.getElementById(forId as string) as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(input!.type).toBe("file");
    // 国产内核红线：不得 display:none（用 sr-only 视觉隐藏），且不得挂 accept 白名单。
    expect(input!.className).not.toContain("hidden");
    expect(input!.className).toContain("sr-only");
    expect(input!.hasAttribute("accept")).toBe(false);
    expect(input!.getAttribute("tabindex")).toBe("-1");
  });

  test("点击附件 label 原生转发一次 click 到 file input（Radix 未吞掉默认激活）", () => {
    render(<Composer onSend={() => {}} onUpload={uploadStub} />);
    openPlusMenu();
    const label = screen.getByText("添加附件").closest("label") as HTMLLabelElement;
    const input = document.getElementById(label.getAttribute("for") as string) as HTMLInputElement;
    const clickSpy = vi.fn();
    input.addEventListener("click", clickSpy);
    fireEvent.click(label);
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });
});

describe("F2 「+」按钮闭合态目标角标", () => {
  test("有活跃目标（未近预算）→ 触发按钮显 accent 圆点", () => {
    render(<Composer onSend={() => {}} onUpload={uploadStub} goal={goalFixture()} />);
    const dot = screen.getByTestId("composer-goal-dot");
    expect(dot).toHaveClass("bg-accent");
    expect(dot).not.toHaveClass("bg-warning");
  });

  test("近预算 → 圆点转 warning 色", () => {
    render(
      <Composer
        onSend={() => {}}
        onUpload={uploadStub}
        goal={goalFixture({ tokenBudget: 100, tokensUsed: 80 })}
      />,
    );
    expect(screen.getByTestId("composer-goal-dot")).toHaveClass("bg-warning");
  });

  test("无目标 / 已清除 → 不显示角标", () => {
    const { rerender } = render(<Composer onSend={() => {}} onUpload={uploadStub} />);
    expect(screen.queryByTestId("composer-goal-dot")).toBeNull();
    rerender(
      <Composer onSend={() => {}} onUpload={uploadStub} goal={goalFixture({ status: "cleared" })} />,
    );
    expect(screen.queryByTestId("composer-goal-dot")).toBeNull();
  });
});

describe("AttachChip（附件 chip 上传失败重试）", () => {
  test("error 态且持有 File + onRetry → 显示「重试」，点击回调复用重传入口", () => {
    const onRetry = vi.fn();
    render(
      <AttachChip
        a={{
          id: "att-0",
          name: "report.pdf",
          size: 1234,
          kind: "file",
          status: "error",
          error: "网络错误",
          file: new File(["x"], "report.pdf"),
        }}
        onRemove={() => {}}
        onRetry={onRetry}
      />,
    );
    const btn = screen.getByLabelText("重试上传 report.pdf");
    fireEvent.click(btn);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test("上传中(uploading)态不显示「重试」（仅失败态可重试）", () => {
    render(
      <AttachChip
        a={{ id: "att-1", name: "a.txt", size: 10, kind: "file", status: "uploading" }}
        onRemove={() => {}}
      />,
    );
    expect(screen.queryByLabelText("重试上传 a.txt")).toBeNull();
  });

  test("done 态不显示「重试」", () => {
    render(
      <AttachChip
        a={{ id: "att-2", name: "b.txt", size: 20, kind: "file", status: "done" }}
        onRemove={() => {}}
      />,
    );
    expect(screen.queryByLabelText("重试上传 b.txt")).toBeNull();
  });

  test("error 态但未传 onRetry（如无持有 File）→ 不渲染重试按钮", () => {
    render(
      <AttachChip
        a={{ id: "att-3", name: "c.txt", size: 30, kind: "file", status: "error" }}
        onRemove={() => {}}
      />,
    );
    expect(screen.queryByLabelText("重试上传 c.txt")).toBeNull();
  });
});

describe("AttachChip（对话框上传图的「编辑」入口 —— 需求 §5 可点回归）", () => {
  const imageAttach = {
    id: "img-0",
    name: "photo.png",
    size: 2048,
    kind: "image" as const,
    status: "done" as const,
    previewUrl: "blob:preview-photo",
  };

  test("已传成功的图 + onAnnotate → 渲染可点「编辑」按钮,点击回调触发", () => {
    const onAnnotate = vi.fn();
    render(<AttachChip a={imageAttach} onRemove={() => {}} onAnnotate={onAnnotate} />);
    const btn = screen.getByRole("button", { name: "编辑图片 photo.png" });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    expect(onAnnotate).toHaveBeenCalledTimes(1);
  });

  test("不可编辑(仅 annotateDisabledReason)→ 按钮渲染但禁用,原因入 title", () => {
    render(
      <AttachChip
        a={imageAttach}
        onRemove={() => {}}
        annotateDisabledReason="当前模型不支持 Image 2 圈选修改，请切换到 GPT 模型"
      />,
    );
    const btn = screen.getByRole("button", { name: "编辑图片 photo.png" });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("title", "当前模型不支持 Image 2 圈选修改，请切换到 GPT 模型");
  });
});
