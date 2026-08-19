import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SessionTimelineBoundary } from "./SessionTimelineBoundary";

afterEach(cleanup);

function Boom() {
  throw new Error("timeline boom");
}

describe("SessionTimelineBoundary", () => {
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
