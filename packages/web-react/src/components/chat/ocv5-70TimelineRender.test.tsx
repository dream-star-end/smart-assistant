import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../lib/chat/model";
import { childSignature } from "../../lib/chat/render";
import { extractLatestTodos } from "./PinnedTaskTracker";
import { SessionTimelineBoundary } from "../SessionTimelineBoundary";
import { MessageList } from "../MessageRenderer";
import fixture from "./__fixtures__/ocv5-70-timeline-repro.json";

afterEach(cleanup);

beforeAll(async () => {
  await import("../MarkdownImpl");
});

const messages = fixture as ChatMessage[];

function renderTimeline(rows: ChatMessage[]) {
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const view = render(
    <SessionTimelineBoundary resetKey="webmtjc2282iys2od">
      <MessageList
        messages={rows}
        sending={false}
        cb={{}}
        onRespondPermission={() => {}}
      />
    </SessionTimelineBoundary>,
  );
  return { view, err };
}

describe("OCV5-70 时间线 hydration 容错", () => {
  test("真实会话精简 fixture 不打穿 SessionTimelineBoundary", () => {
    const { err } = renderTimeline(messages);
    expect(screen.queryByTestId("timeline-fatal-error")).not.toBeInTheDocument();
    expect(screen.queryByText("会话内容渲染失败")).not.toBeInTheDocument();
    expect(screen.getByText("继续")).toBeInTheDocument();
    expect(screen.getByText("已处理完毕。")).toBeInTheDocument();
    err.mockRestore();
  });

  test("单条畸形 agent-group 只落到 MessageBoundary，邻居仍在", () => {
    const { err } = renderTimeline(messages);
    expect(screen.queryByTestId("timeline-fatal-error")).not.toBeInTheDocument();
    expect(screen.getByText("继续")).toBeInTheDocument();
    expect(screen.getByText("已处理完毕。")).toBeInTheDocument();
    // 畸形 steps 的签名与卡渲染不得抛到整棵时间线。
    expect(() => childSignature({ kind: "plan", steps: { not: "array" } as never })).not.toThrow();
    err.mockRestore();
  });

  test("fixture 里当前轮未完成 TodoWrite 可被 HUD 提取", () => {
    const todos = extractLatestTodos(messages);
    expect(todos.some((t) => t.status !== "completed")).toBe(true);
    expect(todos.map((t) => t.content)).toContain("容器重建后真机验证");
  });
});
