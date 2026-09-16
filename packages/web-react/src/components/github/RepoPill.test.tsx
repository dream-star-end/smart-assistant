import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { RepoSelection } from "../../lib/types";
import { RepoPill } from "./RepoPill";

afterEach(cleanup);

describe("RepoPill", () => {
  it("未绑定：文案可截断（min-w-0 truncate），完整文案在 title，点击触发 onClick", () => {
    const onClick = vi.fn();
    render(<RepoPill selection={null} onClick={onClick} />);
    const btn = screen.getByRole("button", { name: "关联 GitHub 仓库" });
    expect(btn).toHaveAttribute("title", "关联 GitHub 仓库");
    // 放进紧凑容器（如 Composer 工具行）时要能收缩：nowrap 之外必须带 min-w-0 + overflow 省略。
    const label = screen.getByText("关联 GitHub 仓库");
    expect(label).toHaveClass("min-w-0", "truncate");
    expect(label).not.toHaveClass("whitespace-nowrap");
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("已绑定：显示 owner/repo，aria-label 与 title 带仓库与分支", () => {
    const selection: RepoSelection = {
      selected: true,
      owner: "dream-star-end",
      repo: "smart-assistant",
      branch: "main",
      status: "ready",
      selection_version: 1,
    };
    render(<RepoPill selection={selection} onClick={() => {}} />);
    const btn = screen.getByRole("button", { name: "代码仓库 dream-star-end/smart-assistant，点击管理" });
    expect(btn).toHaveAttribute("title", "dream-star-end/smart-assistant @ main");
    expect(btn).toHaveTextContent("smart-assistant");
    expect(screen.queryByText("关联 GitHub 仓库")).toBeNull();
  });
});
