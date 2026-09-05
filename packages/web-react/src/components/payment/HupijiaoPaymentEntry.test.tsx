import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  HupijiaoPaymentEntry,
  formatPaymentCountdown,
  paymentClientKind,
  paymentRecoveryUrl,
  remainingPaymentMs,
} from "./HupijiaoPaymentEntry";

const friction = vi.hoisted(() => ({
  reportClientFrictionOnce: vi.fn(() => "eid"),
  reportClientFriction: vi.fn(() => "eid"),
  resetClientFrictionOnceForTests: vi.fn(),
}));
vi.mock("../../lib/clientFriction", () => friction);

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
  friction.reportClientFrictionOnce.mockClear();
  setNavigator({ userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0" });
  vi.unstubAllGlobals();
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
  const futureExpiry = "2099-01-01T00:00:00.000Z";

  test("桌面只挂载二维码，不暴露手机链接", () => {
    setNavigator({ userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0" });
    render(
      <HupijiaoPaymentEntry
        qrcodeUrl="https://pay.test/qr.png"
        mobileUrl={mobileUrl}
        pendingPayment={pendingPayment}
        amountCents="3800"
        expiresAt={futureExpiry}
      />,
    );

    expect(screen.getByRole("img", { name: "微信支付二维码" })).toHaveAttribute(
      "src",
      "https://pay.test/qr.png",
    );
    expect(screen.queryByTestId("mobile-payment-link")).not.toBeInTheDocument();
    expect(screen.getByTestId("payment-order-amount")).toHaveTextContent("¥38.00");
    expect(screen.getByTestId("payment-countdown")).toHaveTextContent("过期后请重新下单");
    expect(friction.reportClientFrictionOnce).toHaveBeenCalledTimes(1);
    expect(friction.reportClientFrictionOnce).toHaveBeenCalledWith(
      "payment:qr_shown:order-1",
      {
        surface: "payment",
        stage: "qr_shown",
        code: "QR_SHOWN",
        outcome: "succeeded",
        sessionId: "order-1",
      },
      undefined,
    );
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

  test("微信 WebView 渲染复制链接按钮并写入恢复 URL", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setNavigator({ userAgent: "Mozilla/5.0 (iPhone) Mobile MicroMessenger/8.0.60", mobile: true });
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <HupijiaoPaymentEntry
        qrcodeUrl="https://pay.test/qr.png"
        mobileUrl={mobileUrl}
        pendingPayment={pendingPayment}
        amountCents="3800"
        expiresAt={futureExpiry}
      />,
    );

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mobile-payment-link")).not.toBeInTheDocument();
    expect(screen.getByTestId("wechat-payment-browser-hint")).toHaveTextContent("系统浏览器");
    expect(screen.getByTestId("wechat-copy-payment-link")).toHaveTextContent("复制链接");
    expect(screen.getByText("在系统浏览器打开后自动恢复本次订单")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("wechat-copy-payment-link"));
    expect(writeText).toHaveBeenCalledWith(paymentRecoveryUrl("order-1"));
    expect(JSON.parse(sessionStorage.getItem("openclaude_pending_order") ?? "null")).toEqual({
      order_no: "order-1",
      label: "订阅专业版",
    });
    expect(friction.reportClientFrictionOnce).not.toHaveBeenCalled();
  });

  test("倒计时到 0 后按钮变为重新下单", () => {
    setNavigator({ userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0" });
    const onReorder = vi.fn();
    render(
      <HupijiaoPaymentEntry
        qrcodeUrl="https://pay.test/qr.png"
        mobileUrl={mobileUrl}
        pendingPayment={pendingPayment}
        amountCents="3800"
        expiresAt={new Date(Date.now() - 1000).toISOString()}
        onReorder={onReorder}
      />,
    );

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByTestId("payment-countdown")).toHaveTextContent("订单已过期，请重新下单");
    fireEvent.click(screen.getByRole("button", { name: "重新下单" }));
    expect(onReorder).toHaveBeenCalledOnce();
  });

  test("微信过期后复制按钮变为重新下单", () => {
    setNavigator({ userAgent: "Mozilla/5.0 (iPhone) Mobile MicroMessenger/8.0.60", mobile: true });
    render(
      <HupijiaoPaymentEntry
        qrcodeUrl="https://pay.test/qr.png"
        mobileUrl={mobileUrl}
        pendingPayment={pendingPayment}
        expiresAt={new Date(0).toISOString()}
        onReorder={() => {}}
      />,
    );
    expect(screen.queryByTestId("wechat-copy-payment-link")).not.toBeInTheDocument();
    expect(screen.getByTestId("payment-reorder")).toHaveTextContent("重新下单");
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

describe("payment recovery helpers", () => {
  test("recovery URL 含 order_no", () => {
    expect(paymentRecoveryUrl("abc-1", "https://app.example/chat?x=1")).toBe(
      "https://app.example/chat?x=1&order_no=abc-1",
    );
  });

  test("countdown 格式与剩余毫秒", () => {
    expect(formatPaymentCountdown(90_000)).toBe("1:30");
    expect(formatPaymentCountdown(0)).toBe("0:00");
    expect(remainingPaymentMs(new Date(0).toISOString(), Date.now())).toBe(0);
  });
});
