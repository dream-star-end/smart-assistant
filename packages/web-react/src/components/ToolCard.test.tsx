import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { ToolCard } from "./ToolCard";

afterEach(cleanup);

describe("ToolCard 二级分派 + 状态 (P5)", () => {
  test("Bash 运行中：spinner + 默认展开终端命令", () => {
    const { container } = render(
      <ToolCard message={{ toolName: "Bash", inputJson: { command: "ls -la" }, _completed: false }} />,
    );
    expect(screen.getByText("终端")).toBeInTheDocument();
    // 运行中 → spinner（animate-spin）
    expect(container.querySelector(".animate-spin")).toBeInTheDocument();
    // 运行中默认展开 → 命令出现两处：header 摘要 + 展开体终端行
    expect(screen.getAllByText("ls -la")).toHaveLength(2);
  });

  test("完成态：✓ 无 spinner，默认折叠，点击展开 Edit diff", () => {
    const { container } = render(
      <ToolCard
        message={{
          toolName: "Edit",
          inputJson: { file_path: "/x/y.ts", old_string: "foo", new_string: "bar" },
          _completed: true,
        }}
      />,
    );
    expect(screen.getByText("编辑文件")).toBeInTheDocument();
    expect(container.querySelector(".animate-spin")).not.toBeInTheDocument();
    // 默认折叠 → diff 不可见
    expect(screen.queryByText("- foo")).not.toBeInTheDocument();
    // 展开
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("- foo")).toBeInTheDocument();
    expect(screen.getByText("+ bar")).toBeInTheDocument();
  });

  test("流式 partialJson 驱动 Edit diff 边流边渲（new_string 半截）", () => {
    // 运行中 + 仅 partialJson：file_path/old_string 完整，new_string 正在键入
    render(
      <ToolCard
        message={{
          toolName: "Edit",
          partialJson: '{"file_path":"/a.ts","old_string":"foo","new_string":"ba',
          _partial: true,
          _completed: false,
        }}
      />,
    );
    // 运行中默认展开
    expect(screen.getByText("- foo")).toBeInTheDocument();
    expect(screen.getByText("+ ba")).toBeInTheDocument();
  });

  test("错误态：失败 Badge", () => {
    render(
      <ToolCard
        message={{ toolName: "Write", inputJson: { file_path: "/a" }, error: true, _completed: true, output: "denied" }}
      />,
    );
    expect(screen.getByText("失败")).toBeInTheDocument();
  });

  test("TodoWrite 勾选列表 + done/total 摘要", () => {
    render(
      <ToolCard
        message={{
          toolName: "TodoWrite",
          inputJson: {
            todos: [
              { content: "任务A", status: "completed" },
              { content: "任务B", status: "pending" },
            ],
          },
          _completed: true,
        }}
      />,
    );
    expect(screen.getByText("1/2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("任务A")).toBeInTheDocument();
    expect(screen.getByText("任务B")).toBeInTheDocument();
  });

  test("MCP browser_navigate：标签 + URL 链接", () => {
    render(
      <ToolCard
        message={{
          toolName: "mcp__browser__browser_navigate",
          inputJson: { url: "https://example.com" },
          _completed: true,
        }}
      />,
    );
    expect(screen.getByText("打开网页")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    const link = screen.getByRole("link", { name: "https://example.com" });
    expect(link).toHaveAttribute("href", "https://example.com");
  });

  test("未知 MCP server → generic kv-list 兜底", () => {
    render(
      <ToolCard
        message={{ toolName: "mcp__unknown__do_thing", inputJson: { foo: "bar" }, _completed: true }}
      />,
    );
    // humanize(op) 标签
    expect(screen.getByText("do thing")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("foo")).toBeInTheDocument();
    expect(screen.getByText("bar")).toBeInTheDocument();
  });

  test("无 body（无 input/output）→ 不可展开（无 aria-expanded）", () => {
    render(<ToolCard message={{ toolName: "Read", _completed: true }} />);
    const btn = screen.getByRole("button");
    expect(btn).not.toHaveAttribute("aria-expanded");
  });

  test("agent-group 子块（ChildBlock 形态）复用本组件渲染", () => {
    // ChildBlock 结构兼容 ToolLike：toolName/inputJson/_completed/output
    render(
      <ToolCard
        message={{ toolName: "Bash", inputJson: { command: "pwd" }, _completed: true, output: "/home" }}
      />,
    );
    expect(screen.getByText("终端")).toBeInTheDocument();
    // 命令在表头摘要（唯一精确匹配的元素）
    expect(screen.getByText("pwd")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    // 展开体为**单一终端块**（$ 命令 + 输出合一，不再命令一框/输出一框的嵌套方框）
    const pre = document.querySelector("pre");
    expect(pre?.textContent).toContain("$ pwd");
    expect(pre?.textContent).toContain("/home");
  });
});
