import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ToolCard } from "./ToolCard";

vi.mock("./tool/bodies", () => {
  throw new Error("synthetic tool body failure");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ToolCard 详情加载失败", () => {
  test("错误留在当前卡片，外壳与恢复入口仍可用", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <ToolCard
        message={{
          toolName: "Bash",
          inputJson: { command: "pwd" },
          _completed: false,
        }}
      />,
    );

    expect(screen.getByText("终端")).toBeInTheDocument();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("工具详情加载失败");
    expect(screen.getByRole("button", { name: "刷新重试" })).toBeInTheDocument();
  });
});
