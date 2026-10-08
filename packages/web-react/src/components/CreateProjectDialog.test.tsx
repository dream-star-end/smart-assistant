import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { CreateProjectDialog } from "./CreateProjectDialog";

afterEach(cleanup);

describe("CreateProjectDialog", () => {
  it("collects name, instructions, colour and files in one step", async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    const onOpenChange = vi.fn();
    render(<CreateProjectDialog open onOpenChange={onOpenChange} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText(/名称/), { target: { value: " 博士论文第三章 " } });
    fireEvent.change(screen.getByLabelText("项目指令"), { target: { value: "用学术中文写作" } });
    fireEvent.click(screen.getByRole("radio", { name: "绿" }));
    const file = new File(["# draft"], "第三章草稿.md", { type: "text/markdown" });
    fireEvent.change(screen.getByLabelText("选择项目文件"), { target: { files: [file] } });
    expect(screen.getByText("第三章草稿.md")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "创建并开始" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      name: "博士论文第三章",
      instructions: "用学术中文写作",
      color: "success",
    });
    expect(onSubmit.mock.calls[0][0].files.map((f: File) => f.name)).toEqual(["第三章草稿.md"]);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("an empty name cannot be submitted", () => {
    const onSubmit = vi.fn();
    render(<CreateProjectDialog open onOpenChange={() => {}} onSubmit={onSubmit} />);
    expect(screen.getByRole("button", { name: "创建并开始" })).toBeDisabled();
  });

  it("from a chat: the name is prefilled and the action says the chat moves in", () => {
    render(<CreateProjectDialog open onOpenChange={() => {}} fromSessionTitle="锂金属负极枝晶抑制机制" onSubmit={vi.fn()} />);
    expect(screen.getByLabelText(/名称/)).toHaveValue("锂金属负极枝晶抑制机制");
    expect(screen.getByRole("button", { name: "创建并移入" })).toBeEnabled();
    expect(screen.getByText("创建后，这条会话会移进新项目。")).toBeInTheDocument();
  });

  it("a failed create keeps the dialog open with the input", async () => {
    const onOpenChange = vi.fn();
    render(<CreateProjectDialog open onOpenChange={onOpenChange} onSubmit={vi.fn().mockResolvedValue(false)} />);
    fireEvent.change(screen.getByLabelText(/名称/), { target: { value: "坏项目" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并开始" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "创建并开始" })).toBeEnabled());
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/名称/)).toHaveValue("坏项目");
  });
});
