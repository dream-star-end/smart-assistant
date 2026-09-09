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
});
