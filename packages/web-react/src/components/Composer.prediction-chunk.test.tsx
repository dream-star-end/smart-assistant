import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Composer } from "./Composer";

// 浮层 chunk 取不到(发版后的旧标签页):输入框照常可用,只是没有浅色预测,不白屏也不弹整页「刷新」。
vi.mock("./ComposerPrediction", () => {
  throw new Error("Failed to fetch dynamically imported module: /assets/ComposerPrediction-old.js");
});

afterEach(cleanup);

test("输入预测浮层加载失败 → 不显示预测,输入框照常可用;看不见的预测不能被发送", async () => {
  const onSend = vi.fn();
  render(
    <Composer
      onSend={onSend}
      prediction={{ next: { text: "把木星的卫星也加上", source: "agent" }, candidates: [] }}
    />,
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(screen.queryByTestId("composer-prediction")).toBeNull();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.getByLabelText("消息输入框")).toBeEnabled();
  const send = screen.getByRole("button", { name: "发送" });
  expect(send).toBeDisabled();
  fireEvent.click(send);
  expect(onSend).not.toHaveBeenCalled();
});
