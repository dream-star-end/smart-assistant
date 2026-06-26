import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AuthGate } from "./AuthGate";

// ---------------------------------------------------------------------------
// P6 Turnstile 门控（AuthGate）：
//  - bypass=true / undefined(config 加载中) → 不渲染 widget，发占位 'bypass'（canary 不变）。
//  - bypass=false → 渲染真实 widget，token 拿到前禁用登录（生产硬 cutover blocker）。
//    注：headless 无法完成真实 CF 挑战，这里只验证「渲染 + 禁用 gating」，token 流转
//    待 canary 关闭 bypass 后浏览器侧验证。
// ---------------------------------------------------------------------------

afterEach(cleanup);

const base = { theme: "light" as const, onCycleTheme: () => {} };

function fill() {
  fireEvent.change(screen.getByPlaceholderText("邮箱"), { target: { value: "a@b.com" } });
  fireEvent.change(screen.getByPlaceholderText("密码"), { target: { value: "password123" } });
}

describe("AuthGate — Turnstile gating", () => {
  test("bypass=true：无 widget，登录发占位 'bypass'（canary 行为不变）", () => {
    const onLogin = vi.fn();
    render(<AuthGate {...base} onLogin={onLogin} turnstileBypass={true} />);
    expect(screen.queryByTestId("turnstile-widget")).not.toBeInTheDocument();
    fill();
    const btn = screen.getByRole("button", { name: /登录/ });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(onLogin).toHaveBeenCalledWith("a@b.com", "password123", "bypass");
  });

  test("config 未就绪（bypass=undefined）：fail-closed，禁用登录，绝不发占位 token", () => {
    const onLogin = vi.fn();
    render(<AuthGate {...base} onLogin={onLogin} />); // 不传 turnstileBypass（config 未加载/失败）
    expect(screen.queryByTestId("turnstile-widget")).not.toBeInTheDocument();
    fill();
    const btn = screen.getByRole("button", { name: /登录/ });
    expect(btn).toBeDisabled(); // config 未知不放行（生产不会用假 token 登录）
    fireEvent.click(btn);
    expect(onLogin).not.toHaveBeenCalled();
  });

  test("bypass=false：渲染真实 widget，token 拿到前禁用登录", () => {
    const onLogin = vi.fn();
    render(
      <AuthGate {...base} onLogin={onLogin} turnstileBypass={false} turnstileSiteKey="0xSITEKEY" />,
    );
    expect(screen.getByTestId("turnstile-widget")).toBeInTheDocument();
    fill();
    const btn = screen.getByRole("button", { name: /登录/ });
    expect(btn).toBeDisabled(); // 无 token，绝不放行
    fireEvent.click(btn);
    expect(onLogin).not.toHaveBeenCalled();
  });
});
