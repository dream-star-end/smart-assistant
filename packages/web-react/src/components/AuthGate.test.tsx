import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../lib/api";
import { LEGAL_DOCS, TERMS_VERSION } from "../lib/legal";
import { AuthGate } from "./AuthGate";

// ---------------------------------------------------------------------------
// P6 Turnstile 门控（AuthGate，三态 fail-closed）：
//  - bypass=true（canary）→ 不渲染 widget，登录发占位 'bypass'。
//  - bypass=undefined（config 未就绪/失败）→ 可登记一次登录意图，但绝不提前提交/发占位 token。
//  - bypass=false（生产）→ 渲染真实 widget，token 拿到前禁用登录（硬 cutover blocker）。
//    注：headless 无法完成真实 CF 挑战，这里只验证「渲染 + 禁用 gating」，token 流转
//    待 canary 关闭 bypass 后浏览器侧验证。
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup();
  window.turnstile = undefined;
});

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

  test("config 未就绪：按钮不永久灰锁，点一次后等待配置并恰好登录一次", async () => {
    const onLogin = vi.fn();
    const retry = vi.fn();
    const { rerender } = render(
      <StrictMode>
        <AuthGate {...base} onLogin={onLogin} onRetryPublicConfig={retry} />
      </StrictMode>,
    );
    expect(screen.queryByTestId("turnstile-widget")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("正在准备登录");
    fill();
    const btn = screen.getByRole("button", { name: /登录/ });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(onLogin).not.toHaveBeenCalled();
    rerender(
      <StrictMode>
        <AuthGate
          {...base}
          onLogin={onLogin}
          onRetryPublicConfig={retry}
          turnstileBypass={true}
        />
      </StrictMode>,
    );
    await waitFor(() =>
      expect(onLogin).toHaveBeenCalledWith("a@b.com", "password123", "bypass"),
    );
    rerender(
      <StrictMode>
        <AuthGate
          {...base}
          onLogin={onLogin}
          onRetryPublicConfig={retry}
          turnstileBypass={true}
        />
      </StrictMode>,
    );
    expect(onLogin).toHaveBeenCalledTimes(1);
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

  test("config 未知时点登录，随后真实 widget token 到达后恰好提交一次", async () => {
    const onLogin = vi.fn();
    const retry = vi.fn();
    const renderWidget = vi.fn(
      (
        _el: HTMLElement,
        opts: {
          callback: (token: string) => void;
        },
      ) => {
        opts.callback("real-token");
        return "widget-1";
      },
    );
    window.turnstile = {
      render: renderWidget,
      remove: vi.fn(),
      reset: vi.fn(),
    };
    const { rerender } = render(
      <AuthGate {...base} onLogin={onLogin} onRetryPublicConfig={retry} />,
    );
    fill();
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    expect(onLogin).not.toHaveBeenCalled();

    rerender(
      <AuthGate
        {...base}
        onLogin={onLogin}
        onRetryPublicConfig={retry}
        turnstileBypass={false}
        turnstileSiteKey="0xSITEKEY"
      />,
    );
    await waitFor(() =>
      expect(onLogin).toHaveBeenCalledWith("a@b.com", "password123", "real-token"),
    );
    expect(onLogin).toHaveBeenCalledTimes(1);
  });

  test("离开登录模式后，迟到的 config 不会消费旧登录意图", async () => {
    const onLogin = vi.fn();
    const { rerender } = render(
      <AuthGate
        {...base}
        onLogin={onLogin}
        onRegister={vi.fn()}
        onRetryPublicConfig={vi.fn()}
      />,
    );
    fill();
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    fireEvent.click(screen.getByRole("button", { name: "立即注册" }));
    rerender(
      <AuthGate
        {...base}
        onLogin={onLogin}
        onRegister={vi.fn()}
        onRetryPublicConfig={vi.fn()}
        turnstileBypass={true}
      />,
    );
    await act(async () => {});
    expect(onLogin).not.toHaveBeenCalled();
  });
});

describe("AuthGate — Turnstile 失败态与登录中文案", () => {
  test("空 siteKey：显示验证加载失败，重试走 onRetryPublicConfig，不放行无 token 登录", () => {
    const onLogin = vi.fn();
    const retry = vi.fn();
    render(
      <AuthGate
        {...base}
        onLogin={onLogin}
        onRetryPublicConfig={retry}
        turnstileBypass={false}
        turnstileSiteKey=""
      />,
    );
    fill();
    expect(screen.getByText("验证加载失败")).toBeInTheDocument();
    const login = screen.getByRole("button", { name: "登录" });
    expect(login).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(onLogin).not.toHaveBeenCalled();
  });

  test("widget onError：显示验证加载失败，重试 remount widget", async () => {
    const renderWidget = vi.fn(
      (
        _el: HTMLElement,
        opts: {
          "error-callback"?: () => void;
        },
      ) => {
        opts["error-callback"]?.();
        return "widget-err";
      },
    );
    window.turnstile = {
      render: renderWidget,
      remove: vi.fn(),
      reset: vi.fn(),
    };
    render(
      <AuthGate {...base} onLogin={vi.fn()} turnstileBypass={false} turnstileSiteKey="0xSITEKEY" />,
    );
    expect(await screen.findByText("验证加载失败")).toBeInTheDocument();
    const before = renderWidget.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(renderWidget.mock.calls.length).toBeGreaterThan(before));
    expect(screen.getByRole("button", { name: "登录" })).toBeDisabled();
  });

  test("timeout-callback 同时当失败：显示验证加载失败", async () => {
    window.turnstile = {
      render: (
        _el: HTMLElement,
        opts: {
          "timeout-callback"?: () => void;
        },
      ) => {
        opts["timeout-callback"]?.();
        return "widget-timeout";
      },
      remove: vi.fn(),
      reset: vi.fn(),
    };
    render(
      <AuthGate {...base} onLogin={vi.fn()} turnstileBypass={false} turnstileSiteKey="0xSITEKEY" />,
    );
    expect(await screen.findByText("验证加载失败")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "登录" })).toBeDisabled();
  });

  test("busyNow 登录按钮文案为正在登录…", () => {
    render(<AuthGate {...base} onLogin={vi.fn()} turnstileBypass={true} loading />);
    fill();
    expect(screen.getByRole("button", { name: /正在登录/ })).toBeInTheDocument();
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
    render(
      <AuthGate
        {...base}
        onLogin={vi.fn()}
        onRegister={onRegister}
        onRequestReset={vi.fn().mockResolvedValue(undefined)}
        turnstileBypass={true}
      />,
    );
    fillRegister();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /创建账号/ }));
    });
    await waitFor(() =>
      expect(screen.getByText(/该邮箱已注册，可直接登录/)).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "忘记密码？" })).toBeInTheDocument();
    expect(screen.queryByText(/email already registered/)).toBeNull();
    expect(screen.queryByText(/追踪号/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "忘记密码？" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /发送重置链接/ })).toBeInTheDocument(),
    );
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


describe("AuthGate — 邮箱验证", () => {
  async function goVerify(extra?: Partial<Parameters<typeof AuthGate>[0]>) {
    const onRegister = vi.fn().mockResolvedValue({ verifyEmailSent: true });
    render(
      <AuthGate
        {...base}
        onLogin={vi.fn()}
        onRegister={onRegister}
        onRequestReset={vi.fn().mockResolvedValue(undefined)}
        turnstileBypass={true}
        {...extra}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "立即注册" }));
    fireEvent.change(screen.getByPlaceholderText("邮箱"), { target: { value: "a@b.com" } });
    fireEvent.change(screen.getByPlaceholderText("至少 8 位"), { target: { value: "password123" } });
    fireEvent.change(screen.getByPlaceholderText("再输一次密码"), { target: { value: "password123" } });
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /创建账号/ }));
    });
    await waitFor(() => expect(screen.getByPlaceholderText(/6 位验证码/)).toBeInTheDocument());
  }

  test("submitVerify 成功后不再跳登录", async () => {
    const onVerifyEmail = vi.fn().mockResolvedValue(undefined);
    await goVerify({ onVerifyEmail });
    fireEvent.change(screen.getByPlaceholderText(/6 位验证码/), { target: { value: "123456" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /验证并继续/ }));
    });
    expect(onVerifyEmail).toHaveBeenCalledWith("a@b.com", "123456");
    expect(screen.getByPlaceholderText(/6 位验证码/)).toBeInTheDocument();
    expect(screen.queryByText("邮箱验证成功，请登录。")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^登录$/ })).not.toBeInTheDocument();
  });

  test("ACCOUNT_UNAVAILABLE 显示账号不可用，不提示检查验证码", async () => {
    const onVerifyEmail = vi.fn().mockRejectedValue(
      new ApiError({ status: 403, code: "ACCOUNT_UNAVAILABLE", message: "account unavailable" }),
    );
    await goVerify({ onVerifyEmail });
    fireEvent.change(screen.getByPlaceholderText(/6 位验证码/), { target: { value: "123456" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /验证并继续/ }));
    });
    await waitFor(() =>
      expect(screen.getByText("账号当前不可用，请联系客服")).toBeInTheDocument(),
    );
    expect(screen.queryByText(/检查验证码/)).not.toBeInTheDocument();
  });

  test("resend emailSent=false 显示发送失败且不开 60s 冷却", async () => {
    const onResendVerification = vi.fn().mockResolvedValue({ emailSent: false });
    render(
      <AuthGate
        {...base}
        onLogin={vi.fn()}
        onResendVerification={onResendVerification}
        initialMode="verify"
        turnstileBypass={true}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(/6 位验证码/), { target: { value: "000000" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /没收到？重新发送验证码/ }));
    });
    await waitFor(() =>
      expect(screen.getByText("发送失败，请稍后重试或更换邮箱")).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /没收到？重新发送验证码/ })).not.toBeDisabled();
    expect(screen.queryByText(/重新发送（/)).not.toBeInTheDocument();
  });

  test("resend 成功才开 60s 冷却", async () => {
    const onResendVerification = vi.fn().mockResolvedValue({ emailSent: true });
    render(
      <AuthGate
        {...base}
        onLogin={vi.fn()}
        onResendVerification={onResendVerification}
        initialMode="verify"
        turnstileBypass={true}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /没收到？重新发送验证码/ }));
    });
    await waitFor(() => expect(screen.getByText(/验证码已重新发送/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /重新发送（/ })).toBeDisabled();
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

// ---------------------------------------------------------------------------
// 2026-09 landing-B 表层打磨(docs/audit/landing.md L-05 / L-09 / L-10 / L-12 / L-13 / L-14)。
// 上面的状态机 / Turnstile 门控契约一字未动;这里只覆盖新增的交互与文案。
// ---------------------------------------------------------------------------

describe("AuthGate — 密码框显示 / 隐藏(L-09)", () => {
  test("登录页:切换显示不清空已输入内容,可及名随状态切换", () => {
    render(<AuthGate {...base} onLogin={vi.fn()} turnstileBypass={true} />);
    const pw = screen.getByPlaceholderText("密码");
    fireEvent.change(pw, { target: { value: "s3cret-pass" } });
    expect(pw).toHaveAttribute("type", "password");

    fireEvent.click(screen.getByRole("button", { name: "显示密码" }));
    expect(pw).toHaveAttribute("type", "text");
    expect(pw).toHaveValue("s3cret-pass");
    expect(screen.getByRole("button", { name: "隐藏密码" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "隐藏密码" }));
    expect(pw).toHaveAttribute("type", "password");
    expect(pw).toHaveValue("s3cret-pass");
    // 登录按钮可及名唯一性红线不受新按钮影响
    expect(screen.getByRole("button", { name: "登录" })).toBeInTheDocument();
  });

  test("注册页:两枚密码框各有一枚切换按钮,且可及名不同名;标签经 htmlFor 关联", () => {
    render(
      <AuthGate {...base} onLogin={vi.fn()} onRegister={vi.fn()} initialMode="register" turnstileBypass={true} />,
    );
    expect(screen.getByRole("button", { name: "显示密码" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "显示确认密码" })).toBeInTheDocument();
    expect(screen.getByLabelText("密码")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("确认密码")).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: /创建账号/ })).toBeInTheDocument();
  });

  test("重置页:新密码 / 确认新密码同样可切换", () => {
    render(
      <AuthGate {...base} onLogin={vi.fn()} onConfirmReset={vi.fn()} initialMode="reset" resetToken="tok_1" />,
    );
    expect(screen.getByRole("button", { name: "显示新密码" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "显示确认新密码" })).toBeInTheDocument();
    expect(screen.getByLabelText("新密码")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("确认新密码")).toHaveAttribute("type", "password");
  });
});

describe("AuthGate — 文案与占位(L-05 / L-12 / L-13)", () => {
  test("验证码占位符不再被 0.4em 字距拉开", () => {
    render(
      <AuthGate {...base} onLogin={vi.fn()} onVerifyEmail={vi.fn()} initialMode="verify" turnstileBypass={true} />,
    );
    const code = screen.getByPlaceholderText("输入 6 位验证码");
    expect(code.className).toContain("tracking-[0.4em]");
    expect(code.className).toContain("placeholder:tracking-normal");
    expect(screen.queryByPlaceholderText(/请输入邮箱里的/)).toBeNull();
  });

  test("重置链接缺失时的提示不泄漏开发者词 token", () => {
    render(<AuthGate {...base} onLogin={vi.fn()} onConfirmReset={vi.fn()} initialMode="reset" />);
    expect(screen.getByText("重置链接无效或已过期，请从邮件重新打开。")).toBeInTheDocument();
    expect(document.body.textContent?.toLowerCase()).not.toContain("token");
  });

  test("登录页页脚卖点用面向用户的话,不用「流式对话 / 持久会话」", () => {
    render(<AuthGate {...base} onLogin={vi.fn()} turnstileBypass={true} />);
    expect(screen.getByText("多模型协作 · 长任务不中断 · 成果直接可用")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("流式对话");
    expect(document.body.textContent).not.toContain("持久会话");
  });
});

describe("AuthGate — 配置未就绪时的登录按钮(L-10)", () => {
  test("点过登录后按钮显示「正在准备登录…」而不是只剩一枚 spinner", () => {
    const retry = vi.fn();
    render(<AuthGate {...base} onLogin={vi.fn()} onRetryPublicConfig={retry} />);
    fill();
    const submit = screen.getByRole("button", { name: "登录" });
    fireEvent.click(submit);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(submit).toBeDisabled();
    expect(submit).toHaveTextContent("正在准备登录…");
    expect(submit).toHaveAccessibleName(/正在准备登录/);
  });
});

describe("AuthGate — 协议弹窗副标题(L-04 / L-14)", () => {
  test("只标一次生效日期(全角冒号),不再重复更新日期", () => {
    render(<AuthGate {...base} onLogin={vi.fn()} turnstileBypass={true} />);
    fireEvent.click(screen.getByRole("link", { name: "《用户协议》" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(`生效日期：${TERMS_VERSION}`)).toBeInTheDocument();
    expect(dialog.textContent).not.toContain("更新日期");
    expect(dialog.textContent).not.toContain(`生效日期:${TERMS_VERSION}`);
  });
});
