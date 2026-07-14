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

describe("HupijiaoPaymentEntry 当前微信支付能力", () => {
  test("桌面挂载二维码，不暴露已停用的手机链接", () => {
    setNavigator({ userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0" });
    render(<HupijiaoPaymentEntry qrcodeUrl="https://pay.test/qr.png" />);

    expect(screen.getByRole("img", { name: "微信支付二维码" })).toHaveAttribute(
      "src",
      "https://pay.test/qr.png",
    );
    expect(screen.queryByTestId("mobile-payment-link")).not.toBeInTheDocument();
  });

  test("普通手机挂载二维码并引导截图后从微信相册扫码", () => {
    setNavigator({ userAgent: "Mozilla/5.0 (Linux; Android 16) Chrome/140.0 Mobile" });
    render(<HupijiaoPaymentEntry qrcodeUrl="https://pay.test/qr.png" />);

    expect(screen.getByRole("img", { name: "微信支付二维码" })).toHaveAttribute(
      "src",
      "https://pay.test/qr.png",
    );
    expect(screen.queryByTestId("mobile-payment-link")).not.toBeInTheDocument();
    expect(screen.getByTestId("mobile-screenshot-payment-hint")).toHaveTextContent("从相册选择");
  });

  test("微信 WebView 挂载二维码并提示截图后关闭当前页", () => {
    setNavigator({ userAgent: "Mozilla/5.0 (iPhone) Mobile MicroMessenger/8.0.60", mobile: true });
    render(<HupijiaoPaymentEntry qrcodeUrl="https://pay.test/qr.png" />);

    expect(screen.getByRole("img", { name: "微信支付二维码" })).toBeInTheDocument();
    expect(screen.queryByTestId("mobile-payment-link")).not.toBeInTheDocument();
    expect(screen.getByTestId("wechat-screenshot-payment-hint")).toHaveTextContent("关闭当前页");
  });
});
