import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { RepoSelection } from "../../lib/types";
import { BoundRepoCard } from "./BoundRepoCard";

afterEach(cleanup);

const SELECTION: Extract<RepoSelection, { selected: true }> = {
  selected: true,
  owner: "acme",
  repo: "aurora",
  branch: "feat/rail",
  status: "ready",
  head_sha: "abcdef1234567890",
  selection_version: 1,
};

describe("BoundRepoCard 文案", () => {
  test("三行是绑定仓库 / 绑定分支 / 绑定时 HEAD，短 SHA，禁止「当前分支」", () => {
    const { container } = render(<BoundRepoCard selection={SELECTION} onOpenRepo={() => {}} />);
    expect(screen.getByText("绑定仓库")).toBeInTheDocument();
    expect(screen.getByText("绑定分支")).toBeInTheDocument();
    expect(screen.getByText("绑定时 HEAD")).toBeInTheDocument();
    expect(screen.getByText("acme/aurora")).toBeInTheDocument();
    expect(screen.getByText("feat/rail")).toBeInTheDocument();
    expect(screen.getByText("abcdef1")).toBeInTheDocument();
    expect(container.textContent).not.toContain("当前分支");
  });

  test("没有 head_sha 时 HEAD 显示 —", () => {
    const { head_sha: _omit, ...rest } = SELECTION;
    render(<BoundRepoCard selection={rest} onOpenRepo={() => {}} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
