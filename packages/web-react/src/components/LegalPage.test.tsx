import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { BRAND } from "../lib/brand";
import { TERMS_VERSION } from "../lib/legal";
import { LegalPage } from "./LegalPage";

const brandSnapshot = { ...BRAND };

afterEach(() => {
  cleanup();
  Object.assign(BRAND, brandSnapshot);
  localStorage.removeItem("oc_theme");
  document.documentElement.classList.remove("dark");
});

describe("LegalPage", () => {
  // L-04 / L-14:更新日期与生效日期恒为同一个版本号,只标一次;冒号全角。
  test("版本日期只标一次「生效日期」,不再重复「更新日期」", () => {
    render(<LegalPage kind="terms" />);
    expect(screen.getByText(`生效日期：${TERMS_VERSION}`)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("更新日期");
    expect(document.body.textContent).not.toContain(`生效日期:${TERMS_VERSION}`);
  });

  // L-15:静态页在 main.tsx 入口短路、不进 <App>,主题必须自己接 —— 与 useTheme 共用 oc_theme。
  test("按已保存的主题偏好挂 dark 类,并提供主题切换", () => {
    localStorage.setItem("oc_theme", "dark");
    render(<LegalPage kind="privacy" />);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    const toggle = screen.getByRole("button", { name: /切换主题/ });
    expect(toggle).toHaveAccessibleName(/当前深色/);
    fireEvent.click(toggle); // dark → system(测试桩 matchMedia 不匹配 dark → 亮色)
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("oc_theme")).toBe("system");
  });

  // L-02:页脚备案位与落地页同一规则 —— 占位不渲染,真实备案号外链工信部。
  test("备案占位不进页脚;真实备案号渲染为外链", () => {
    BRAND.icp = "备案信息更新中";
    render(<LegalPage kind="terms" />);
    expect(document.body.textContent).not.toContain("备案信息更新中");
    cleanup();

    BRAND.icp = "赣ICP备2026123456号";
    render(<LegalPage kind="terms" />);
    expect(screen.getByRole("link", { name: "赣ICP备2026123456号" })).toHaveAttribute(
      "href",
      "https://beian.miit.gov.cn/",
    );
  });

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
