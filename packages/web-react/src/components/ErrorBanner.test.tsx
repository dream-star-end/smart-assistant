import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ErrorBanner } from "./ErrorBanner";

afterEach(cleanup);

test("聊天错误条在窄屏把操作区换到下一行，且重试/关闭仍可用", () => {
  const onRetry = vi.fn();
  const onDismiss = vi.fn();
  render(
    <ErrorBanner
      error={{ message: "网络连接不可用，请检查网络后重试", requestId: "req-mobile", retryText: "原问题" }}
      onRetry={onRetry}
      onDismiss={onDismiss}
    />,
  );

  expect(screen.getByRole("alert")).toHaveClass("flex-wrap", "sm:flex-nowrap");
  expect(screen.getByText("追踪号 req-mobile")).toBeInTheDocument();
  const retry = screen.getByRole("button", { name: "重试发送" });
  expect(retry.parentElement).toHaveClass("w-full", "sm:w-auto");
  expect(retry).toHaveClass("[@media(hover:none)]:h-11");
  fireEvent.click(retry);
  fireEvent.click(screen.getByRole("button", { name: "关闭错误提示" }));
  expect(onRetry).toHaveBeenCalledTimes(1);
  expect(onDismiss).toHaveBeenCalledTimes(1);
});
