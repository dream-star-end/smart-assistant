import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  sessionStorage.clear();
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
  const mobileUrl = "https://pay.xunhupay.com/wechat/order-1";
  const pendingPayment = { orderNo: "order-1", label: "订阅专业版" };

  test("桌面只挂载二维码，不暴露手机链接", () => {
    setNavigator({ userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0" });
    render(
      <HupijiaoPaymentEntry
        qrcodeUrl="https://pay.test/qr.png"
        mobileUrl={mobileUrl}
        pendingPayment={pendingPayment}
      />,
    );

    expect(screen.getByRole("img", { name: "微信支付二维码" })).toHaveAttribute(
      "src",
      "https://pay.test/qr.png",
    );
    expect(screen.queryByTestId("mobile-payment-link")).not.toBeInTheDocument();
  });

  test("普通手机只挂载安全的手机支付链接，不请求二维码", () => {
    setNavigator({ userAgent: "Mozilla/5.0 (Linux; Android 16) Chrome/140.0 Mobile" });
    render(
      <HupijiaoPaymentEntry
        qrcodeUrl="https://pay.test/qr.png"
        mobileUrl={mobileUrl}
        pendingPayment={pendingPayment}
      />,
    );

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByTestId("mobile-payment-link")).toHaveAttribute("href", mobileUrl);
    expect(screen.getByTestId("mobile-payment-link")).toHaveTextContent("前往微信支付");
    fireEvent.click(screen.getByTestId("mobile-payment-link"));
    expect(JSON.parse(sessionStorage.getItem("openclaude_pending_order") ?? "null")).toEqual({
      order_no: "order-1",
      label: "订阅专业版",
    });
  });

  test("微信 WebView 不挂二维码也不跳手机链接，提示改用系统浏览器", () => {
    setNavigator({ userAgent: "Mozilla/5.0 (iPhone) Mobile MicroMessenger/8.0.60", mobile: true });
    render(
      <HupijiaoPaymentEntry
        qrcodeUrl="https://pay.test/qr.png"
        mobileUrl={mobileUrl}
        pendingPayment={pendingPayment}
      />,
    );

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mobile-payment-link")).not.toBeInTheDocument();
    expect(screen.getByTestId("wechat-payment-browser-hint")).toHaveTextContent("在系统浏览器打开");
  });

  test.each([
    ["缺少链接", null],
    ["非 http(s) 协议", "javascript:alert(1)"],
    ["非虎皮椒域名", "https://pay.example.com/wechat/order-1"],
  ])("普通手机遇到%s时明确提示不可用，不回退截图", (_label, unsafeUrl) => {
    setNavigator({ userAgent: "Mozilla/5.0 (iPhone) Mobile Safari/604.1", mobile: true });
    render(
      <HupijiaoPaymentEntry
        qrcodeUrl="https://pay.test/qr.png"
        mobileUrl={unsafeUrl}
        pendingPayment={pendingPayment}
      />,
    );

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mobile-payment-link")).not.toBeInTheDocument();
    expect(screen.getByTestId("mobile-payment-unavailable")).toHaveTextContent("电脑或另一台设备");
  });
});
