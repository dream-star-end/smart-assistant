import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountSwitchNotice, IdentityRecoveryNotice } from "./AccountSwitchNotice";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("AccountSwitchNotice", () => {
  it("防串号切换确认页保留本体：未核验时按钮正名为「重新验证」，核验后为「切换到已验证账号」", () => {
    const onAccept = vi.fn();
    const onRetry = vi.fn();
    const { rerender } = render(
      <AccountSwitchNotice name="Alice" ready={false} onAccept={onAccept} onRetry={onRetry} />,
    );

    expect(screen.getByText("登录账号已变化")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新验证" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onAccept).not.toHaveBeenCalled();

    rerender(<AccountSwitchNotice name="Alice" ready={true} onAccept={onAccept} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: "切换到已验证账号" }));
    expect(onAccept).toHaveBeenCalledTimes(1);
  });
});

describe("IdentityRecoveryNotice", () => {
  it("先后台静默退避重试，连续失败后才展示温和提示与「重新验证」按钮", () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    render(<IdentityRecoveryNotice onRetry={onRetry} retryDelaysMs={[2000, 5000]} />);

    // 初始静默，不闪烁警告条
    expect(screen.queryByTestId("identity-recovery-notice")).toBeNull();
    expect(onRetry).toHaveBeenCalledTimes(0);

    // 第一次退避重试（2s）
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("identity-recovery-notice")).toBeNull();

    // 第二次退避重试（再过 5s）后仍未卸载 → 展示温和提示
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onRetry).toHaveBeenCalledTimes(2);
    const notice = screen.getByTestId("identity-recovery-notice");
    expect(notice).toHaveTextContent("账号状态同步受阻，请重新验证。");
    fireEvent.click(screen.getByRole("button", { name: "重新验证" }));
    expect(onRetry).toHaveBeenCalledTimes(3);
  });

  it("在静默重试期间恢复卸载时清理定时器，不再触发额外重试", () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    const { unmount } = render(<IdentityRecoveryNotice onRetry={onRetry} retryDelaysMs={[2000, 5000]} />);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    unmount();
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(onRetry).toHaveBeenCalledTimes(0);
  });
});
