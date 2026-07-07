/**
 * ZoomableImage(共享图片灯箱)行为测试 —— 2026-07-07 boss 反馈"agent 响应的
 * 图表不支持放大预览"。契约:缩略图是可聚焦按钮,点击开 Radix Dialog 全尺寸预览
 * (含"新标签打开原图"逃生口),关闭按钮收起。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import "@testing-library/jest-dom/vitest";
import { ZoomableImage } from "./media";

afterEach(cleanup);

describe("ZoomableImage 灯箱", () => {
  const src = "https://example.test/chart.png";

  test("缩略态渲染 img + 可访问的放大按钮", () => {
    render(<ZoomableImage src={src} alt="拟合曲线" imgClassName="max-h-72" />);
    const btn = screen.getByRole("button", { name: /放大查看 拟合曲线/ });
    expect(btn).toBeInTheDocument();
    const img = screen.getByAltText("拟合曲线");
    expect(img).toHaveAttribute("src", src);
    expect(img.className).toContain("max-h-72");
  });

  test("点击缩略图 → 打开全尺寸预览 + 新标签原图链接;关闭按钮收起", () => {
    render(<ZoomableImage src={src} alt="拟合曲线" />);
    fireEvent.click(screen.getByRole("button", { name: /放大查看/ }));
    const imgs = screen.getAllByAltText("拟合曲线");
    expect(imgs.length).toBeGreaterThanOrEqual(2);
    const link = screen.getByRole("link", { name: /新标签打开原图/ });
    expect(link).toHaveAttribute("href", src);
    fireEvent.click(screen.getByRole("button", { name: "关闭预览" }));
    expect(screen.queryByRole("link", { name: /新标签打开原图/ })).not.toBeInTheDocument();
  });

  test("无 alt → 按钮名回退'放大查看图片'", () => {
    render(<ZoomableImage src={src} alt="" />);
    expect(screen.getByRole("button", { name: "放大查看图片" })).toBeInTheDocument();
  });
});
