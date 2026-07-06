import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AttachChip } from "./Composer";

afterEach(cleanup);

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
