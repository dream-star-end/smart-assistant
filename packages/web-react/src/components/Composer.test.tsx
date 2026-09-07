import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Composer } from "./Composer";

afterEach(cleanup);

describe("Composer 控件边框 token", () => {
  test("外壳非聚焦用 border-border-control，聚焦用 border-border-strong，不用分隔线 border-border", () => {
    const { container } = render(<Composer onSend={() => {}} />);
    const shell = container.querySelector(".rounded-\\[26px\\]");
    expect(shell).toBeTruthy();
    expect(shell?.className).toContain("border-border-control");
    expect(shell?.className).toContain("focus-within:border-border-strong");
    expect(shell?.className).not.toMatch(/(?:^|\s)border-border(?:\s|$)/);
  });
});

describe("Composer environment preparing", () => {
  test("shows a 20s prep progress in the input area", () => {
    render(<Composer onSend={() => {}} environmentPreparing />);
    expect(screen.getByRole("status")).toHaveTextContent("环境准备中，约 20 秒");
  });

  test("hides the prep progress by default", () => {
    render(<Composer onSend={() => {}} />);
    expect(screen.queryByText(/环境准备中/)).toBeNull();
  });
});

describe("Composer Stop ownership", () => {
  test("the composer is the sole active Stop control", () => {
    const onStop = vi.fn();
    render(<Composer busy onSend={() => {}} onStop={onStop} />);

    const stop = screen.getByRole("button", { name: "停止" });
    expect(screen.getAllByRole("button", { name: "停止" })).toHaveLength(1);
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  test("an in-flight Stop stays on the same control and cannot be submitted twice", () => {
    const onStop = vi.fn();
    render(<Composer busy stopping onSend={() => {}} onStop={onStop} />);

    const stopping = screen.getByRole("button", { name: "正在停止" });
    expect(stopping).toBeDisabled();
    expect(screen.queryByRole("button", { name: "停止" })).not.toBeInTheDocument();
    fireEvent.click(stopping);
    expect(onStop).not.toHaveBeenCalled();
  });

  test("stopping 态渲染可见「正在停止…」文案", () => {
    render(<Composer busy stopping onSend={() => {}} onStop={() => {}} />);
    expect(screen.getByText("正在停止…")).toBeInTheDocument();
  });
});

describe("Composer 输入无障碍", () => {
  test("textarea 可用消息输入框标签取到", () => {
    render(<Composer onSend={() => {}} />);
    expect(screen.getByLabelText("消息输入框")).toBeInTheDocument();
  });
});

describe("Composer ↑ 拉上一条用户消息", () => {
  test("空输入框按 ArrowUp 填入 lastUserText", () => {
    render(<Composer onSend={() => {}} lastUserText="上一句用户消息" />);
    const ta = screen.getByLabelText("消息输入框");
    fireEvent.keyDown(ta, { key: "ArrowUp" });
    expect(ta).toHaveValue("上一句用户消息");
  });

  test("非空输入框按 ArrowUp 不改动", () => {
    render(<Composer onSend={() => {}} lastUserText="上一句用户消息" />);
    const ta = screen.getByLabelText("消息输入框");
    fireEvent.change(ta, { target: { value: "正在写" } });
    fireEvent.keyDown(ta, { key: "ArrowUp" });
    expect(ta).toHaveValue("正在写");
  });
});

describe("Composer 拖拽上传", () => {
  function fileDt(file?: File, types: string[] = ["Files"]) {
    const files = file ? [file] : [];
    return {
      types,
      files,
      dropEffect: "none",
      items: [],
    };
  }

  test("drop 含 File 的 dataTransfer 后附件列表出现文件名", async () => {
    const onUpload = vi.fn(async () => ({ kind: "file" as const, url: "/api/media/note.txt" }));
    const { container } = render(<Composer onSend={() => {}} onUpload={onUpload} />);
    const shell = container.querySelector(".rounded-\\[26px\\]");
    expect(shell).toBeTruthy();
    const file = new File(["hello"], "drop-note.txt", { type: "text/plain" });
    fireEvent.drop(shell as Element, { dataTransfer: fileDt(file) });
    expect(await screen.findByText("drop-note.txt")).toBeInTheDocument();
  });

  test("dragover 含 Files 时根容器出现高亮 class；拖纯文本不高亮", () => {
    const onUpload = vi.fn(async () => ({ kind: "file" as const, url: "/x" }));
    const { container } = render(<Composer onSend={() => {}} onUpload={onUpload} />);
    const shell = container.querySelector(".rounded-\\[26px\\]") as HTMLElement;
    fireEvent.dragOver(shell, { dataTransfer: fileDt(undefined, ["Files"]) });
    expect(shell.className).toContain("ring-2");
    expect(shell.className).toContain("ring-ring");
    fireEvent.dragLeave(shell, { dataTransfer: fileDt(undefined, ["Files"]) });
    expect(shell.className).not.toContain("ring-2");
    fireEvent.dragOver(shell, { dataTransfer: fileDt(undefined, ["text/plain"]) });
    expect(shell.className).not.toContain("ring-2");
  });
});
