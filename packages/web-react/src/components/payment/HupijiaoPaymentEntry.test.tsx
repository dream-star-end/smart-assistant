import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { HupijiaoPaymentEntry, paymentClientKind } from "./HupijiaoPaymentEntry";

function setNavigator({
  userAgent,
  mobile,
  platform = "Linux x86_64",
  maxTouchPoints = 0,
}: {
  userAgent: string;
  mobile?: boolean;
  platform?: string;
  maxTouchPoints?: number;
}) {
  Object.defineProperties(window.navigator, {
    userAgent: { configurable: true, value: userAgent },
    userAgentData: { configurable: true, value: mobile == null ? undefined : { mobile } },
    platform: { configurable: true, value: platform },
    maxTouchPoints: { configurable: true, value: maxTouchPoints },
  });
}

afterEach(() => {
  cleanup();
  setNavigator({ userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0" });
});

describe("paymentClientKind", () => {
  test("微信判断优先于 userAgentData.mobile", () => {
    expect(
      paymentClientKind({
        userAgent: "Mozilla/5.0 (iPhone) MicroMessenger/8.0.60",
        userAgentData: { mobile: true },
        platform: "iPhone",
        maxTouchPoints: 5,
      }),
    ).toBe("wechat");
  });

  test("优先使用 mobile hint，并兼容伪装成 Macintosh 的 iPadOS", () => {
    expect(
      paymentClientKind({
        userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0",
        userAgentData: { mobile: true },
        platform: "Linux x86_64",
        maxTouchPoints: 0,
      }),
    ).toBe("mobile");
    expect(
      paymentClientKind({
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)",
        platform: "MacIntel",
        maxTouchPoints: 5,
      }),
    ).toBe("mobile");
  });
});

describe("HupijiaoPaymentEntry 首次渲染互斥", () => {
  test("桌面只挂载二维码，不暴露手机链接", () => {
    setNavigator({ userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0" });
    render(<HupijiaoPaymentEntry qrcodeUrl="https://pay.test/qr.png" mobileUrl="https://pay.test/mobile" />);

    expect(screen.getByRole("img", { name: "微信支付二维码" })).toHaveAttribute(
      "src",
      "https://pay.test/qr.png",
    );
    expect(screen.queryByTestId("mobile-payment-link")).not.toBeInTheDocument();
  });

  test("普通手机只挂载手机链接，绝不挂载二维码", () => {
    setNavigator({ userAgent: "Mozilla/5.0 (Linux; Android 16) Chrome/140.0 Mobile" });
    render(<HupijiaoPaymentEntry qrcodeUrl="https://pay.test/qr.png" mobileUrl="https://pay.test/mobile" />);

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByTestId("mobile-payment-link")).toHaveAttribute("href", "https://pay.test/mobile");
  });

  test("微信 WebView 安全失败，不加载二维码也不跳手机链接", () => {
    setNavigator({ userAgent: "Mozilla/5.0 (iPhone) Mobile MicroMessenger/8.0.60", mobile: true });
    render(<HupijiaoPaymentEntry qrcodeUrl="https://pay.test/qr.png" mobileUrl="https://pay.test/mobile" />);

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mobile-payment-link")).not.toBeInTheDocument();
    expect(screen.getByTestId("wechat-payment-browser-hint")).toHaveTextContent("在浏览器打开");
  });

  test("手机订单缺 mobileUrl 时不回退加载二维码", () => {
    setNavigator({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) Mobile" });
    render(<HupijiaoPaymentEntry qrcodeUrl="https://pay.test/qr.png" mobileUrl={null} />);

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByTestId("mobile-payment-unavailable")).toHaveTextContent("电脑端");
  });
});
