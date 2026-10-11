import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Composer } from "./Composer";

// 浮层 chunk 取不到(发版后的旧标签页):输入框照常可用,只是没有浅色预测,不白屏也不弹整页「刷新」。
vi.mock("./ComposerPrediction", () => {
  throw new Error("Failed to fetch dynamically imported module: /assets/ComposerPrediction-old.js");
});

afterEach(cleanup);

test("输入预测浮层加载失败 → 不显示预测,输入框照常可用", async () => {
  render(
    <Composer
      onSend={() => {}}
      prediction={{ next: { text: "把木星的卫星也加上", source: "agent" }, candidates: [] }}
    />,
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(screen.queryByTestId("composer-prediction")).toBeNull();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.getByLabelText("消息输入框")).toBeEnabled();
});
