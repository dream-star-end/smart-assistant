import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ChunkErrorBoundary, isChunkLoadError } from "./ChunkErrorBoundary";

/** 在 render 阶段抛出指定错误,驱动上层 error boundary。 */
function Boom({ error }: { error: unknown }): never {
  throw error;
}

describe("isChunkLoadError", () => {
  test("识别常见动态 import 失败文案", () => {
    expect(
      isChunkLoadError(new Error("Failed to fetch dynamically imported module: /assets/Settings-abc.js")),
    ).toBe(true);
    const e = new Error("Loading chunk 42 failed");
    e.name = "ChunkLoadError";
    expect(isChunkLoadError(e)).toBe(true);
    expect(isChunkLoadError(new Error("Importing a module script failed."))).toBe(true);
  });

  test("普通运行时错误不误判为 chunk 失败", () => {
    expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
});

describe("ChunkErrorBoundary", () => {
  afterEach(cleanup);

  test("正常渲染子树", () => {
    render(
      <ChunkErrorBoundary>
        <div>正文</div>
      </ChunkErrorBoundary>,
    );
    expect(screen.getByText("正文")).toBeTruthy();
  });

  test("stale-chunk 加载失败 → 提示已发布新版本 + 刷新按钮(不白屏)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ChunkErrorBoundary>
        <Boom error={new Error("Failed to fetch dynamically imported module: /assets/Settings-abc.js")} />
      </ChunkErrorBoundary>,
    );
    expect(screen.getByText("已发布新版本")).toBeTruthy();
    expect(screen.getByRole("button", { name: "刷新" })).toBeTruthy();
    spy.mockRestore();
  });

  test("非 chunk 渲染错误 → 通用「加载出错」(仍给刷新出口,不白屏)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ChunkErrorBoundary>
        <Boom error={new Error("some unexpected render bug")} />
      </ChunkErrorBoundary>,
    );
    expect(screen.getByText("此页面加载出错")).toBeTruthy();
    expect(screen.getByRole("button", { name: "刷新" })).toBeTruthy();
    spy.mockRestore();
  });
});
