import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SessionTimelineBoundary } from "./SessionTimelineBoundary";

afterEach(cleanup);

function Boom(): never {
  throw new Error("timeline boom");
}

describe("SessionTimelineBoundary", () => {
  test("React #185 只自动重挂一次，瞬时渲染循环不留下失败卡", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    let allowRecovery = false;
    const onRetry = vi.fn(() => {
      allowRecovery = true;
    });
    function UpdateDepthUntilRetry() {
      if (!allowRecovery) throw new Error("Minified React error #185");
      return <div>恢复后的会话内容</div>;
    }
    render(
      <SessionTimelineBoundary resetKey="sess-depth" onRetry={onRetry}>
        <UpdateDepthUntilRetry />
      </SessionTimelineBoundary>,
    );
    await waitFor(() => expect(screen.getByText("恢复后的会话内容")).toBeInTheDocument());
    expect(screen.queryByTestId("timeline-fatal-error")).toBeNull();
    expect(onRetry).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  test("resetKey/activeId 变化后清除失败态,不把异常泄漏到下一会话", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(
      <SessionTimelineBoundary resetKey="sess-a">
        <Boom />
      </SessionTimelineBoundary>,
    );
    expect(screen.getByTestId("timeline-fatal-error")).toBeInTheDocument();
    rerender(
      <SessionTimelineBoundary resetKey="sess-b">
        <div>下一会话内容</div>
      </SessionTimelineBoundary>,
    );
    expect(screen.queryByTestId("timeline-fatal-error")).toBeNull();
    expect(screen.getByText("下一会话内容")).toBeInTheDocument();
    err.mockRestore();
  });
});
