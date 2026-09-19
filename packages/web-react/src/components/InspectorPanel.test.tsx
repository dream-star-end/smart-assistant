/**
 * 产物详情列(Codex 式第三列)行为锁:
 *   1. ToolCard 仅在 ArtifactInspectContext 提供 open 时渲染「在详情面板查看」入口,
 *      点击回传 {kind:'tool', message} 且不连带触发表头折叠切换;
 *   2. 卡内 diff 截断行在有 inspect 回调时可点、去详情列;
 *   3. InspectorPanelContent 全文模式渲染:超过卡内 60 行上限的 diff 不再截断。
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { InspectorPanel, InspectorPanelContent } from "./InspectorPanel";
import { ToolCard } from "./ToolCard";
import {
  ArtifactInspectActiveContext,
  ArtifactInspectContext,
  type ArtifactInspectTarget,
} from "./tool/context";
import { ToastProvider } from "./ui";

afterEach(cleanup);

/** 120 行新增内容:超过卡内 MAX_DIFF_LINES=60,必然触发截断行。 */
const LONG_NEW_STRING = Array.from({ length: 120 }, (_, i) => `line-${i + 1}`).join("\n");

const longEditMessage = {
  toolName: "Edit",
  inputJson: {
    file_path: "/tmp/demo.ts",
    old_string: "",
    new_string: LONG_NEW_STRING,
  },
  _completed: true,
};

describe("产物详情列(inspector)", () => {
  test("无 provider 时 ToolCard 不渲染详情入口(向后兼容)", () => {
    render(<ToolCard message={{ toolName: "Bash", inputJson: { command: "ls" }, _completed: true }} />);
    expect(screen.queryByLabelText("在详情面板查看")).not.toBeInTheDocument();
  });

  test("有 provider 时点击入口回传本条消息,且不切换展开态", () => {
    const open = vi.fn();
    const message = { toolName: "Bash", inputJson: { command: "ls" }, _completed: true };
    render(
      <ArtifactInspectContext.Provider value={{ open }}>
        <ToolCard message={message} />
      </ArtifactInspectContext.Provider>,
    );
    // 历史完成态默认折叠:展开体中的终端块不存在
    expect(screen.getAllByText("ls")).toHaveLength(1);
    fireEvent.click(screen.getByLabelText("在详情面板查看"));
    expect(open).toHaveBeenCalledWith({ kind: "tool", message });
    // stopPropagation:仍保持折叠(命令只出现在 header 摘要一处)
    expect(screen.getAllByText("ls")).toHaveLength(1);
  });

  test("卡内超长 diff 的截断行可点击进入详情列", () => {
    const open = vi.fn();
    render(
      <ArtifactInspectContext.Provider value={{ open }}>
        <ToolCard message={{ ...longEditMessage, _completed: false }} />
      </ArtifactInspectContext.Provider>,
    );
    // 运行中默认展开 → 截断行出现且可点(T-12:与「展开全部」并排一行,不再是两行重复提示)
    const row = screen.getByRole("button", { name: /在详情面板查看全文/ });
    fireEvent.click(row);
    expect(open).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /展开全部（共 120 行）/ })).toBeInTheDocument();
    expect(screen.queryByText(/diff 过长，已截断/)).not.toBeInTheDocument();
    // 卡内仍是截断渲染:第 61 行之后不出现
    expect(screen.queryByText(/^\+?\s*line-120$/)).not.toBeInTheDocument();
  });

  test("无 provider 时截断行只有「展开全部」,不再附一行纯文字截断提示(T-12)", () => {
    render(<ToolCard message={{ ...longEditMessage, _completed: false }} />);
    expect(screen.getByRole("button", { name: /展开全部（共 120 行）/ })).toBeInTheDocument();
    expect(screen.queryByText(/在详情面板查看全文/)).not.toBeInTheDocument();
    expect(screen.queryByText(/diff 过长/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /展开全部（共 120 行）/ }));
    expect(screen.getByText(/line-120/)).toBeInTheDocument();
  });

  test("面板正在查看的那张卡带选中态描边,其它卡没有(T-18)", () => {
    const open = vi.fn();
    const a = { toolName: "Bash", inputJson: { command: "ls" }, _completed: true };
    const b = { toolName: "Bash", inputJson: { command: "pwd" }, _completed: true };
    const { container } = render(
      <ArtifactInspectContext.Provider value={{ open }}>
        <ArtifactInspectActiveContext.Provider value={a}>
          <div data-card="a">
            <ToolCard message={a} />
          </div>
          <div data-card="b">
            <ToolCard message={b} />
          </div>
        </ArtifactInspectActiveContext.Provider>
      </ArtifactInspectContext.Provider>,
    );
    expect(container.querySelector('[data-card="a"] > div')?.className).toContain("ring-1");
    expect(container.querySelector('[data-card="b"] > div')?.className).not.toContain("ring-1");
    expect(container.querySelector('[data-card="a"] [aria-label="在详情面板查看"]')).toHaveAttribute("aria-pressed", "true");
  });

  test("详情面板全文模式渲染完整 diff,并可关闭", () => {
    const onClose = vi.fn();
    const target: ArtifactInspectTarget = { kind: "tool", message: longEditMessage };
    render(<InspectorPanelContent target={target} onClose={onClose} />);
    // 全文:超过卡内 60 行上限的行也在
    expect(screen.getByText(/line-120/)).toBeInTheDocument();
    expect(screen.queryByText(/已截断|查看全文/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("关闭详情面板"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("头部提供复制全文入口:Edit 复制的是面板展示的 diff,不是 output 状态串(T-04)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const target: ArtifactInspectTarget = {
      kind: "tool",
      message: { ...longEditMessage, output: "The file has been updated." },
    };
    render(
      <ToastProvider>
        <InspectorPanelContent target={target} onClose={() => {}} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByLabelText("复制全文"));
    expect(writeText).toHaveBeenCalled();
    const copied = String(writeText.mock.calls[0]?.[0] ?? "");
    expect(copied).toContain("+line-120");
    expect(copied).not.toContain("The file has been updated.");
    // 成功有 toast 反馈(T-19)
    expect(await screen.findByText("已复制全文")).toBeInTheDocument();
  });

  test("复制失败不再静默:toast 提示(T-19)", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.assign(navigator, { clipboard: { writeText } });
    const target: ArtifactInspectTarget = { kind: "tool", message: longEditMessage };
    render(
      <ToastProvider>
        <InspectorPanelContent target={target} onClose={() => {}} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByLabelText("复制全文"));
    expect(await screen.findByText(/复制失败/)).toBeInTheDocument();
  });

  test("Bash 复制:Cursor 信封解成 `$ 命令` + stdout/stderr,不复制 JSON 外壳(T-04)", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const target: ArtifactInspectTarget = {
      kind: "tool",
      message: {
        toolName: "Bash",
        inputJson: { command: "npm test" },
        output: JSON.stringify({
          success: { command: "npm test", exitCode: 1, stdout: "1 passed\n", stderr: "1 failed: x" },
          isBackground: false,
        }),
        _completed: true,
      },
    };
    render(<InspectorPanelContent target={target} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText("复制全文"));
    const copied = String(writeText.mock.calls[0]?.[0] ?? "");
    expect(copied).toBe("$ npm test\n1 passed\n1 failed: x");
  });

  test("面板状态与卡片同源:Cursor 信封 exitCode 非 0 → 面板也标「未成功」,受阻 → 「受阻」(T-05)", () => {
    const failed: ArtifactInspectTarget = {
      kind: "tool",
      message: {
        toolName: "Bash",
        inputJson: { command: "npm test" },
        output: JSON.stringify({ success: { command: "npm test", exitCode: 1, stdout: "", stderr: "boom" } }),
        _completed: true,
      },
    };
    render(<InspectorPanelContent target={failed} onClose={() => {}} />);
    expect(screen.getByText("未成功")).toBeInTheDocument();
    expect(screen.queryByText("已结束")).not.toBeInTheDocument();
    expect(screen.queryByText("完成")).not.toBeInTheDocument();
    cleanup();
    const blocked: ArtifactInspectTarget = {
      kind: "tool",
      message: {
        toolName: "Bash",
        inputJson: { command: "oc-web extract https://blocked.example" },
        output: "oc-web: blocked: Cloudflare challenge",
        _completed: true,
      },
    };
    render(<InspectorPanelContent target={blocked} onClose={() => {}} />);
    expect(screen.getByText("受阻")).toBeInTheDocument();
    cleanup();
    const errored: ArtifactInspectTarget = {
      kind: "tool",
      message: { toolName: "Write", inputJson: { file_path: "/a" }, error: true, output: "denied", _completed: true },
    };
    render(<InspectorPanelContent target={errored} onClose={() => {}} />);
    expect(screen.getByText("未成功")).toBeInTheDocument();
    expect(screen.queryByText("已结束")).not.toBeInTheDocument();
  });

  test("桌面 aside:有标题元素、打开时焦点进面板、关闭卸载后焦点归还入口(T-24)", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "入口";
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    const onClose = vi.fn();
    const target: ArtifactInspectTarget = { kind: "tool", message: longEditMessage };
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 1;
    });
    const { unmount } = render(<InspectorPanel target={target} onClose={onClose} />);
    const aside = screen.getByRole("complementary");
    const heading = screen.getByRole("heading", { level: 2, name: "编辑文件" });
    expect(aside).toHaveAttribute("aria-labelledby", heading.id);
    expect(document.activeElement).toBe(screen.getByLabelText("关闭详情面板"));
    // Escape:焦点在输入框里时不关面板;在面板/其它地方关
    const input = document.createElement("textarea");
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    expect(document.activeElement).toBe(trigger);
    rafSpy.mockRestore();
    input.remove();
    trigger.remove();
  });
});
