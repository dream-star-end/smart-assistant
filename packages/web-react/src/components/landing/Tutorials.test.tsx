import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Tutorials } from "./Tutorials";

afterEach(() => {
  cleanup();
});

describe("落地页教程区", () => {
  it("引导打开快速上手主线，不把未采集案例包装成全流程", () => {
    render(<Tutorials />);

    expect(
      screen.getByRole("heading", { name: "打开后，按 10 分钟主线走一遍" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /打开快速上手/ })).toBeInTheDocument();
    expect(screen.getByText(/这是功能用法，不是案例回放/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("先看一件难事");
    expect(document.body.textContent).not.toContain("打开任务全流程");
    expect(document.body.textContent).not.toContain("research-bike-demand");
  });
});
