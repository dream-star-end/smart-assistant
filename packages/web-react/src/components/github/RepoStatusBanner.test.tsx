import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { RepoSelection } from "../../lib/types";
import { RepoStatusBanner } from "./RepoStatusBanner";

afterEach(cleanup);

const failed: RepoSelection = {
  selected: true,
  owner: "acme",
  repo: "app",
  branch: "main",
  status: "failed",
  selection_version: 1,
  error_message: "clone timeout",
};

describe("RepoStatusBanner", () => {
  test("failed 状态提供重试且走 bind 回调", () => {
    const onRetry = vi.fn();
    render(
      <RepoStatusBanner selection={failed} progressPct={0} onDismiss={() => {}} onRetry={onRetry} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  // RB-01 / RB-02 / RB-03
  test("容器为 live region；失败信息带 title 全文；关闭按钮可点且有可访问名称", () => {
    const onDismiss = vi.fn();
    render(<RepoStatusBanner selection={failed} progressPct={0} onDismiss={onDismiss} />);
    const banner = screen.getByTestId("repo-status-banner");
    expect(banner).toHaveAttribute("aria-live", "assertive");
    expect(banner).toHaveTextContent("acme/app @ main");
    expect(screen.getByText("clone timeout")).toHaveAttribute("title", "clone timeout");
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("cloning 态显示进度条且 aria-live=polite，不显示关闭", () => {
    render(
      <RepoStatusBanner
        selection={{ ...failed, status: "cloning", error_message: undefined }}
        progressPct={42}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByTestId("repo-status-banner")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByLabelText("仓库克隆进度")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "关闭" })).toBeNull();
  });
});
