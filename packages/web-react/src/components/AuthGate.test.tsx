import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../lib/api";
import { LEGAL_DOCS, TERMS_VERSION } from "../lib/legal";
import { AuthGate } from "./AuthGate";

// ---------------------------------------------------------------------------
// P6 Turnstile 门控（AuthGate，三态 fail-closed）：
//  - bypass=true（canary）→ 不渲染 widget，登录发占位 'bypass'。
//  - bypass=undefined（config 未就绪/失败）→ 不渲染 widget，但禁用登录、绝不发占位 token。
//  - bypass=false（生产）→ 渲染真实 widget，token 拿到前禁用登录（硬 cutover blocker）。
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
  test("transient bootstrap failure exposes an explicit session recovery action", () => {
    const retry = vi.fn();
    render(
      <AuthGate {...base} onLogin={vi.fn()} turnstileBypass={true}
        error="登录状态恢复失败，请检查网络后重试" onRetrySession={retry} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "重试恢复登录状态" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test("bypass=true：无 widget，登录发占位 'bypass'（canary 行为不变）", () => {
    const onLogin = vi.fn();
    render(<AuthGate {...base} onLogin={onLogin} turnstileBypass={true} />);
    expect(screen.queryByTestId("turnstile-widget")).not.toBeInTheDocument();
    fill();
    const btn = screen.getByRole("button", { name: /登录/ });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(onLogin).toHaveBeenCalledWith("a@b.com", "password123", "bypass");
    // 登录页文案式同意：协议以 <a> 链接呈现（不得做成 button——登录按钮可及名唯一性红线）
    expect(screen.getByRole("link", { name: "《用户协议》" })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("link", { name: "《隐私政策》" })).toHaveAttribute("href", "/privacy");
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

// ---------------------------------------------------------------------------
// 多模式：注册 / 邮箱验证 / 忘记密码 / 重置密码。
// ---------------------------------------------------------------------------

describe("AuthGate — 注册", () => {
  test("login 模式提供注册入口；切换后填表勾选协议提交带 bypass token，verifyEmailSent → 进入验证步", async () => {
    const onRegister = vi.fn().mockResolvedValue({ verifyEmailSent: true });
    render(<AuthGate {...base} onLogin={vi.fn()} onRegister={onRegister} turnstileBypass={true} />);

    fireEvent.click(screen.getByRole("button", { name: "立即注册" }));
    fireEvent.change(screen.getByPlaceholderText("邮箱"), { target: { value: "a@b.com" } });
    fireEvent.change(screen.getByPlaceholderText("至少 8 位"), { target: { value: "password123" } });
    fireEvent.change(screen.getByPlaceholderText("再输一次密码"), {
      target: { value: "password123" },
    });
    fireEvent.click(screen.getByRole("checkbox"));

    const btn = screen.getByRole("button", { name: /创建账号/ });
    expect(btn).not.toBeDisabled();
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(onRegister).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "a@b.com",
        password: "password123",
        turnstileToken: "bypass",
        termsVersion: TERMS_VERSION,
      }),
    );
    await waitFor(() =>
      expect(screen.getByPlaceholderText(/6 位验证码/)).toBeInTheDocument(),
    );
  });

  test("未勾选协议 → 提交给出明确提示且不调用 onRegister", () => {
    const onRegister = vi.fn();
    render(<AuthGate {...base} onLogin={vi.fn()} onRegister={onRegister} turnstileBypass={true} />);
    fireEvent.click(screen.getByRole("button", { name: "立即注册" }));
    fireEvent.change(screen.getByPlaceholderText("邮箱"), { target: { value: "a@b.com" } });
    fireEvent.change(screen.getByPlaceholderText("至少 8 位"), { target: { value: "password123" } });
    fireEvent.change(screen.getByPlaceholderText("再输一次密码"), {
      target: { value: "password123" },
    });
    // 协议勾选默认关（监管要求不得默认同意）
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: /创建账号/ }));
    expect(screen.getByText(/勾选同意《用户协议》与《隐私政策》/)).toBeInTheDocument();
    expect(onRegister).not.toHaveBeenCalled();
  });

  test("注册页提供《用户协议》《隐私政策》链接（<a> 非 button，不与登录按钮可及名冲突）", () => {
    render(<AuthGate {...base} onLogin={vi.fn()} onRegister={vi.fn()} turnstileBypass={true} />);
    fireEvent.click(screen.getByRole("button", { name: "立即注册" }));
    expect(screen.getByRole("link", { name: "《用户协议》" })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("link", { name: "《隐私政策》" })).toHaveAttribute("href", "/privacy");
  });

  test("两次密码不一致 → 报错且不调用 onRegister", () => {
    const onRegister = vi.fn();
    render(<AuthGate {...base} onLogin={vi.fn()} onRegister={onRegister} turnstileBypass={true} />);
    fireEvent.click(screen.getByRole("button", { name: "立即注册" }));
    fireEvent.change(screen.getByPlaceholderText("邮箱"), { target: { value: "a@b.com" } });
    fireEvent.change(screen.getByPlaceholderText("至少 8 位"), { target: { value: "password123" } });
    fireEvent.change(screen.getByPlaceholderText("再输一次密码"), { target: { value: "different9" } });
    fireEvent.click(screen.getByRole("button", { name: /创建账号/ }));
    expect(screen.getByText("两次输入的密码不一致")).toBeInTheDocument();
    expect(onRegister).not.toHaveBeenCalled();
  });

  test("allowRegistration=false 时不显示注册入口", () => {
    render(
      <AuthGate
        {...base}
        onLogin={vi.fn()}
        onRegister={vi.fn()}
        allowRegistration={false}
        turnstileBypass={true}
      />,
    );
    expect(screen.queryByRole("button", { name: "立即注册" })).not.toBeInTheDocument();
  });

  test("initialMode=register 但 allowRegistration=false → 硬兜底回登录并提示", async () => {
    render(
      <AuthGate
        {...base}
        onLogin={vi.fn()}
        onRegister={vi.fn()}
        initialMode="register"
        allowRegistration={false}
        turnstileBypass={true}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /登录/ })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: /创建账号/ })).not.toBeInTheDocument();
    expect(screen.getByText(/暂未开放注册/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 协议弹窗：普通点击就地弹窗展示正文（正文区 overflow-y-auto 滚动），
// 修饰键点击保留 <a href> 原生"新标签打开"。链接语义(role=link + href)是既有红线,不得回退。
// ---------------------------------------------------------------------------

describe("AuthGate — 协议弹窗", () => {
  test("登录页普通点击《用户协议》→ 弹窗展示正文(标题+引言+分节),正文区带滚动样式,可关闭", () => {
    render(<AuthGate {...base} onLogin={vi.fn()} turnstileBypass={true} />);
    fireEvent.click(screen.getByRole("link", { name: "《用户协议》" }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(LEGAL_DOCS.terms.title)).toBeInTheDocument();
    expect(within(dialog).getByText(LEGAL_DOCS.terms.intro)).toBeInTheDocument();
    expect(within(dialog).getByText(LEGAL_DOCS.terms.sections[0].h)).toBeInTheDocument();
    // 正文区必须可滚动(长协议在 88vh 弹窗内出滚动条)
    const scrollArea = within(dialog).getByText(LEGAL_DOCS.terms.intro).closest(".overflow-y-auto");
    expect(scrollArea).not.toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("修饰键点击(ctrl/cmd)不拦截 → 不开弹窗,保留原生新标签行为", () => {
    render(<AuthGate {...base} onLogin={vi.fn()} turnstileBypass={true} />);
    fireEvent.click(screen.getByRole("link", { name: "《隐私政策》" }), { ctrlKey: true });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("注册页 label 内点击《隐私政策》→ 开弹窗且不误触协议勾选", () => {
    render(<AuthGate {...base} onLogin={vi.fn()} onRegister={vi.fn()} turnstileBypass={true} />);
    fireEvent.click(screen.getByRole("button", { name: "立即注册" }));
    expect(screen.getByRole("checkbox")).not.toBeChecked();

    fireEvent.click(screen.getByRole("link", { name: "《隐私政策》" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(LEGAL_DOCS.privacy.title)).toBeInTheDocument();
    // 弹窗打开期间背景被 Radix 标记 aria-hidden,关闭后再断言勾选未被误触
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });
});

// ---------------------------------------------------------------------------
// Bug1：auth 错误族 code→友好中文（单一权威表，AuthGate 是各表单展示的统一入口）。
// register 路径的 ApiError.code 会完整传到 AuthGate 自己的 catch（useAuth 只 .then 透传），
// 故用它验证「红条渲染友好中文、不裸露后端英文 message / 追踪号」；未知 code 仍原样。
// ---------------------------------------------------------------------------
describe("AuthGate — 错误文案本地化", () => {
  function fillRegister() {
    fireEvent.click(screen.getByRole("button", { name: "立即注册" }));
    fireEvent.change(screen.getByPlaceholderText("邮箱"), { target: { value: "a@b.com" } });
    fireEvent.change(screen.getByPlaceholderText("至少 8 位"), { target: { value: "password123" } });
    fireEvent.change(screen.getByPlaceholderText("再输一次密码"), { target: { value: "password123" } });
    fireEvent.click(screen.getByRole("checkbox"));
  }

  test("已知 code（CONFLICT）→ 红条渲染友好中文，不裸露后端英文 message / 追踪号", async () => {
    const onRegister = vi
      .fn()
      .mockRejectedValue(
        new ApiError({ status: 409, code: "CONFLICT", message: "email already registered（追踪号 z9x）" }),
      );
    render(<AuthGate {...base} onLogin={vi.fn()} onRegister={onRegister} turnstileBypass={true} />);
    fillRegister();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /创建账号/ }));
    });
    await waitFor(() =>
      expect(screen.getByText("该邮箱已注册，可直接登录")).toBeInTheDocument(),
    );
    expect(screen.queryByText(/email already registered/)).toBeNull();
    expect(screen.queryByText(/追踪号/)).toBeNull();
  });

  test("未知 code → 保持原样（原 message + 追踪号），供排障", async () => {
    const onRegister = vi
      .fn()
      .mockRejectedValue(
        new ApiError({ status: 500, code: "SOME_UNKNOWN", message: "weird failure（追踪号 q7）" }),
      );
    render(<AuthGate {...base} onLogin={vi.fn()} onRegister={onRegister} turnstileBypass={true} />);
    fillRegister();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /创建账号/ }));
    });
    await waitFor(() => expect(screen.getByText("weird failure（追踪号 q7）")).toBeInTheDocument());
  });
});

describe("AuthGate — 忘记密码", () => {
  test("提交后调用 onRequestReset 并展示已发送确认", async () => {
    const onRequestReset = vi.fn().mockResolvedValue(undefined);
    render(
      <AuthGate {...base} onLogin={vi.fn()} onRequestReset={onRequestReset} turnstileBypass={true} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "忘记密码？" }));
    fireEvent.change(screen.getByPlaceholderText("注册邮箱"), { target: { value: "a@b.com" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /发送重置链接/ }));
    });
    expect(onRequestReset).toHaveBeenCalledWith("a@b.com", "bypass");
    await waitFor(() => expect(screen.getByText(/重置链接已发出/)).toBeInTheDocument());
  });
});

describe("AuthGate — 重置密码", () => {
  test("initialMode=reset + token：提交调用 onConfirmReset(token, 新密码)", async () => {
    const onConfirmReset = vi.fn().mockResolvedValue(undefined);
    render(
      <AuthGate
        {...base}
        onLogin={vi.fn()}
        onConfirmReset={onConfirmReset}
        initialMode="reset"
        resetToken="tok-123"
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("至少 8 位"), { target: { value: "newpass123" } });
    fireEvent.change(screen.getByPlaceholderText("再输一次新密码"), {
      target: { value: "newpass123" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /重置密码/ }));
    });
    expect(onConfirmReset).toHaveBeenCalledWith("tok-123", "newpass123");
  });

  test("无 token 时提示无效并给出重新申请入口", () => {
    render(<AuthGate {...base} onLogin={vi.fn()} onConfirmReset={vi.fn()} initialMode="reset" />);
    expect(screen.getByText(/重置链接无效/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /重新申请重置/ })).toBeInTheDocument();
  });
});
