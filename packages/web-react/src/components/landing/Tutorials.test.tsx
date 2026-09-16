import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Tutorials } from "./Tutorials";

afterEach(() => {
  cleanup();
});

describe("落地页教程区", () => {
  it("引导打开成果案例展厅，不把未采集案例包装成全流程", () => {
    render(<Tutorials />);

    expect(
      screen.getByRole("heading", { name: "先看看，它能把事情做到哪一步" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /打开案例展厅/ })).toBeInTheDocument();
    expect(screen.getByText(/真实样例成果/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("先看一件难事");
    expect(document.body.textContent).not.toContain("打开任务全流程");
    expect(document.body.textContent).not.toContain("research-bike-demand");
  });

  it("注册步骤写登录后到账，不写即刻到账", () => {
    render(<Tutorials />);
    expect(document.body.textContent).toContain("登录后到账");
    expect(document.body.textContent).not.toContain("即刻到账");
  });

  // L-01:落地页作用域的 --grad-cta 是柠檬绿,写死 text-white 会压成 1.3:1;前景一律走 token。
  it("渐变底(bg-grad-cta)上的前景色走 text-primary-fg，不写死 text-white", () => {
    render(<Tutorials />);
    const gradientSurfaces = Array.from(document.querySelectorAll(".bg-grad-cta"));
    // 三枚步骤圆点 + 「打开案例展厅」
    expect(gradientSurfaces).toHaveLength(4);
    for (const el of gradientSurfaces) {
      expect(el.className).toContain("text-primary-fg");
      expect(el.className).not.toMatch(/\btext-white\b/);
    }
    expect(screen.getByRole("link", { name: /打开案例展厅/ }).className).toContain("text-primary-fg");
  });

  // L-19:触屏没有 hover、也看不到原生 title,「可复制」必须常驻可见。
  it("「开口第一句」芯片常驻显示「复制」暗示，不依赖 hover 或 title", () => {
    render(<Tutorials />);
    const chips = screen.getAllByRole("button", { name: /复制/ });
    expect(chips.length).toBeGreaterThanOrEqual(8);
    for (const chip of chips) {
      expect(chip).not.toHaveAttribute("title");
      expect(chip.querySelector(".opacity-0")).toBeNull();
    }
  });
});
