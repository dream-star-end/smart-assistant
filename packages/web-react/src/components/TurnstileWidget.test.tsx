import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { TurnstileWidget } from "./TurnstileWidget";

/**
 * L-20:真 widget(300×65)加载完成才撑开高度,登录卡在那一刻向下跳一次(CLS)。
 * jsdom 不会真的去拉 challenges.cloudflare.com 的脚本,这里手动给 <script> 派发事件模拟结果。
 */
afterEach(() => {
  cleanup();
  for (const s of Array.from(document.querySelectorAll('script[src*="challenges.cloudflare.com"]'))) {
    s.remove();
  }
});

function hostBox(): HTMLElement {
  const host = screen.getByTestId("turnstile-widget").parentElement;
  if (!host) throw new Error("widget host missing");
  return host;
}

describe("TurnstileWidget 宿主占位", () => {
  test("脚本加载期间按官方尺寸占位并显示骨架;加载失败后撤下骨架、不再占位,并回调 onError", async () => {
    const onError = vi.fn();
    render(<TurnstileWidget siteKey="site-key" onToken={() => {}} onError={onError} />);

    expect(screen.getByTestId("turnstile-skeleton")).toBeInTheDocument();
    expect(hostBox().style.minHeight).toBe("65px");
    expect(hostBox().style.minWidth).toBe("300px");

    const script = document.querySelector('script[src*="challenges.cloudflare.com"]');
    expect(script).not.toBeNull();
    script?.dispatchEvent(new Event("error"));

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("turnstile-skeleton")).toBeNull();
    expect(hostBox().style.minHeight).toBe("");
  });

  test("没有 site key 时不加载脚本、不画骨架、不占位(上层负责「验证加载失败」提示)", () => {
    render(<TurnstileWidget siteKey="" onToken={() => {}} />);
    expect(screen.queryByTestId("turnstile-skeleton")).toBeNull();
    expect(hostBox().style.minHeight).toBe("");
    expect(document.querySelector('script[src*="challenges.cloudflare.com"]')).toBeNull();
  });
});
