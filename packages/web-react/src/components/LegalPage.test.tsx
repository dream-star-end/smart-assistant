import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { TERMS_VERSION } from "../lib/legal";
import { LegalPage } from "./LegalPage";

afterEach(cleanup);

describe("LegalPage", () => {
  test("terms:渲染《用户协议》标题、版本日期与互跳隐私政策链接", () => {
    render(<LegalPage kind="terms" />);
    expect(screen.getByRole("heading", { level: 1, name: "用户协议" })).toBeInTheDocument();
    expect(screen.getByText(new RegExp(TERMS_VERSION))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "隐私政策" })).toHaveAttribute("href", "/privacy");
  });

  test("privacy:渲染《隐私政策》与关键披露条款(第三方模型服务商传输)", () => {
    render(<LegalPage kind="privacy" />);
    expect(screen.getByRole("heading", { level: 1, name: "隐私政策" })).toBeInTheDocument();
    // 核心合规披露必须在文:输入内容会传输给第三方模型服务商
    expect(screen.getByText(/第三方模型服务商/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "用户协议" })).toHaveAttribute("href", "/terms");
  });
});
