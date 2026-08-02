import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { ToolCard } from "./ToolCard";

afterEach(cleanup);

describe("ToolCard 按需加载详情", () => {
  test("同步显示卡片外壳，并在详情 chunk 到达后完整展示内容", async () => {
    render(
      <ToolCard
        message={{
          toolName: "Bash",
          inputJson: { command: "printf LAZY_BODY_MARKER" },
          _completed: false,
        }}
      />,
    );

    expect(screen.getByText("终端")).toBeInTheDocument();
    expect(screen.getByText("正在加载完整工具内容…")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText("正在加载完整工具内容…")).not.toBeInTheDocument();
    });
    expect(document.querySelector("pre")).toHaveTextContent("$ printf LAZY_BODY_MARKER");
  });
});
