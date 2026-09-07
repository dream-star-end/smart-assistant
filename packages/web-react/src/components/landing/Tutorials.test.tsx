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
});
