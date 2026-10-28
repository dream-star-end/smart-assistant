import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StatusDot } from "./Quiet";
import { StatusPill } from "./StatusPill";

afterEach(cleanup);

describe("StatusPill 点形态", () => {
  it("文案查状态表,悬停和读屏都能拿到(所有点都要有说明)", () => {
    render(<StatusPill status="failed" />);
    const dot = screen.getByRole("img", { name: "没完成" });
    expect(dot).toHaveAttribute("title", "没完成");
    expect(dot).toHaveAttribute("data-status", "failed");
    expect(dot).toHaveClass("bg-status-failed", "size-1.5");
  });

  it("label 覆盖默认文案;颜色只走 --status-* 别名", () => {
    render(<StatusPill status="running" label="正在写 Q4 汇报.pptx" />);
    const dot = screen.getByRole("img", { name: "正在写 Q4 汇报.pptx" });
    expect(dot).toHaveClass("bg-status-running", "oc-status-breathe");
  });

  it("未读和运行中同色调,但未读不呼吸", () => {
    render(<StatusPill status="unread" />);
    const dot = screen.getByRole("img", { name: "未读" });
    expect(dot).toHaveClass("bg-status-running");
    expect(dot).not.toHaveClass("oc-status-breathe");
  });

  it("md:失败 / 需要处理带柔光晕,ring 形态是细线旋转环", () => {
    render(
      <>
        <StatusPill status="needs_you" size="md" />
        <StatusPill status="running" size="md" mark="ring" />
      </>,
    );
    expect(screen.getByRole("img", { name: "等你回答" })).toHaveClass(
      "size-[7px]",
      "bg-status-attention",
      "ring-status-attention/20",
    );
    const ring = screen.getByRole("img", { name: "运行中" });
    // 缺口(透明右边框)是「在转」的唯一视觉线索,不能被颜色类合并掉。
    expect(ring).toHaveClass("border-status-running", "border-r-transparent", "oc-session-running");
    expect(ring).not.toHaveClass("bg-status-running");
  });

  it("decorative:旁边已有文字,点只做装饰", () => {
    const { container } = render(<StatusPill tone="done" decorative />);
    const dot = container.firstElementChild as HTMLElement;
    expect(dot).toHaveAttribute("aria-hidden", "true");
    expect(dot).not.toHaveAttribute("role");
    expect(dot).not.toHaveAttribute("title");
    expect(dot).toHaveClass("bg-status-done");
  });
});

describe("StatusPill 点加文字形态", () => {
  it("已完成:文字中性,勾用 done 色", () => {
    const { container } = render(<StatusPill status="done" variant="pill" label="完成 · 3 分 04 秒" />);
    expect(screen.getByText("完成 · 3 分 04 秒")).toBeInTheDocument();
    const icon = container.querySelector("svg");
    expect(icon).toHaveClass("text-status-done");
    expect(icon).toHaveAttribute("aria-hidden", "true");
  });

  it("已停止是实心方块,不是像未勾复选框的空心框", () => {
    const { container } = render(<StatusPill status="stopped" variant="pill" />);
    expect(screen.getByText("已停止")).toBeInTheDocument();
    expect(container.querySelector("svg")).toHaveAttribute("fill", "currentColor");
  });

  it("运行中没有图标,用呼吸点", () => {
    const { container } = render(<StatusPill status="background" variant="pill" />);
    expect(screen.getByText("后台运行中")).toBeInTheDocument();
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector(".oc-status-breathe")).not.toBeNull();
  });
});

describe("Quiet.StatusDot 薄封装", () => {
  it("色板 tone 映射到语义色调,仍是 6px 装饰点", () => {
    const { container } = render(
      <>
        <StatusDot tone="success" />
        <StatusDot tone="warning" />
        <StatusDot tone="danger" />
        <StatusDot tone="accent" />
        <StatusDot />
        <StatusDot tone="info" />
      </>,
    );
    const dots = [...container.children] as HTMLElement[];
    expect(dots.map((d) => d.getAttribute("data-tone"))).toEqual([
      "done",
      "attention",
      "failed",
      "running",
      "idle",
      "idle",
    ]);
    for (const d of dots) {
      expect(d).toHaveAttribute("aria-hidden", "true");
      expect(d).toHaveClass("size-1.5", "rounded-full");
    }
  });
});
