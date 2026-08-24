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
import { InspectorPanelContent } from "./InspectorPanel";
import { ToolCard } from "./ToolCard";
import { ArtifactInspectContext, type ArtifactInspectTarget } from "./tool/context";

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
    // 运行中默认展开 → 截断行出现且可点
    const row = screen.getByText(/diff 过长，在详情面板查看全文/);
    fireEvent.click(row);
    expect(open).toHaveBeenCalledTimes(1);
    // 卡内仍是截断渲染:第 61 行之后不出现
    expect(screen.queryByText(/^\+?\s*line-120$/)).not.toBeInTheDocument();
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
});
