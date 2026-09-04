import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createMemoryAuthSession } from "../../lib/authSession";
import type { AuthSession, HupiCreateResult, MySubscription } from "../../lib/types";
import { resetSubscribeUiState, SubscriptionDialog } from "./SubscriptionDialog";
import { TopupDialog } from "./TopupDialog";

const apiMocks = vi.hoisted(() => ({
  listPlans: vi.fn(),
  createHupiOrder: vi.fn(),
  getOrder: vi.fn(),
  listSubscriptionPlans: vi.fn(),
  getMySubscription: vi.fn(),
  subscribe: vi.fn(),
  upgradeSubscription: vi.fn(),
  buyPack: vi.fn(),
}));

vi.mock("../../lib/api", () => {
  class ApiError extends Error {
    status = 500;
    code: string | undefined;
  }
  return {
    ApiError,
    api: apiMocks,
    apiErrorMessage: (_e: unknown, fallback: string) => fallback,
  };
});

const auth: AuthSession = createMemoryAuthSession(() => {}, "t");

const order: HupiCreateResult = {
  orderNo: "order-1",
  qrcodeUrl: "https://pay.test/qr.png",
  mobileUrl: "https://pay.xunhupay.com/wechat/order-1",
  amountCents: "3800",
  credits: "4000",
  expiresAt: "2099-01-01T00:00:00.000Z",
};

const freeSub: MySubscription = {
  planCode: "free",
  planName: "免费版",
  status: "active",
  periodStart: "2026-07-01T00:00:00.000Z",
  periodEnd: "2026-08-01T00:00:00.000Z",
  periodCredits: "300",
  monthlyCredits: "300",
  priceCents: "0",
  tier: 0,
  paid: false,
  balance: { wallet: "0", period: "300", total: "300" },
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperties(window.navigator, {
    userAgent: {
      configurable: true,
      value: "Mozilla/5.0 (Linux; Android 16) Chrome/140.0 Mobile",
    },
    userAgentData: { configurable: true, value: { mobile: true } },
  });
  apiMocks.getOrder.mockResolvedValue({ status: "pending" });
});

afterEach(() => {
  cleanup();
  resetSubscribeUiState();
  Object.defineProperties(window.navigator, {
    userAgent: { configurable: true, value: "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0" },
    userAgentData: { configurable: true, value: undefined },
  });
});

describe("个人支付弹窗的手机路径", () => {
  test("积分充值下单后只展示手机支付跳转，不加载二维码", async () => {
    apiMocks.listPlans.mockResolvedValue([
      { code: "test", label: "测试充值", amountCents: "3800", credits: "4000" },
    ]);
    apiMocks.createHupiOrder.mockResolvedValue(order);

    render(<TopupDialog open auth={auth} onClose={() => {}} onPaid={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /测试充值/ }));

    expect(await screen.findByTestId("mobile-payment-link")).toHaveAttribute(
      "href",
      order.mobileUrl,
    );
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  test("订阅下单后只展示手机支付跳转，不加载二维码", async () => {
    apiMocks.listSubscriptionPlans.mockResolvedValue([
      { code: "free", name: "免费版", priceCents: "0", monthlyCredits: "300", periodDays: 30, tier: 0 },
      { code: "pro", name: "专业版", priceCents: "3800", monthlyCredits: "4000", periodDays: 30, tier: 1 },
    ]);
    apiMocks.getMySubscription.mockResolvedValue(freeSub);
    apiMocks.subscribe.mockResolvedValue(order);

    render(<SubscriptionDialog open auth={auth} onClose={() => {}} onPaid={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "订阅" }));

    expect(await screen.findByTestId("mobile-payment-link")).toHaveAttribute(
      "href",
      order.mobileUrl,
    );
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});

describe("订阅弹窗预选与二维码倒计时", () => {
  const litePlan = {
    code: "lite",
    name: "Lite",
    priceCents: "3800",
    monthlyCredits: "4000",
    periodDays: 30,
    tier: 1,
  };

  test("initialIntent=lite 预选 Lite 套餐卡", async () => {
    apiMocks.listSubscriptionPlans.mockResolvedValue([
      { code: "free", name: "免费版", priceCents: "0", monthlyCredits: "300", periodDays: 30, tier: 0 },
      litePlan,
    ]);
    apiMocks.getMySubscription.mockResolvedValue(freeSub);
    render(
      <SubscriptionDialog open auth={auth} onClose={() => {}} onPaid={() => {}} initialIntent="lite" />,
    );
    expect(await screen.findByText("Lite")).toBeInTheDocument();
    expect(document.querySelector('[data-preselected="lite"]')).not.toBeNull();
  });

  test("initialIntent=pack 预选加量包", async () => {
    apiMocks.listSubscriptionPlans.mockResolvedValue([
      { code: "free", name: "免费版", priceCents: "0", monthlyCredits: "300", periodDays: 30, tier: 0 },
      litePlan,
    ]);
    apiMocks.getMySubscription.mockResolvedValue(freeSub);
    render(
      <SubscriptionDialog open auth={auth} onClose={() => {}} onPaid={() => {}} initialIntent="pack" />,
    );
    expect(await screen.findByText("积分加量包")).toBeInTheDocument();
    expect(document.querySelector('[data-preselected="pack"]')).not.toBeNull();
  });

  test("二维码页展示金额与倒计时，过期后重新下单", async () => {
    Object.defineProperties(window.navigator, {
      userAgent: { configurable: true, value: "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0" },
      userAgentData: { configurable: true, value: undefined },
    });
    apiMocks.listSubscriptionPlans.mockResolvedValue([
      { code: "free", name: "免费版", priceCents: "0", monthlyCredits: "300", periodDays: 30, tier: 0 },
      litePlan,
    ]);
    apiMocks.getMySubscription.mockResolvedValue(freeSub);
    apiMocks.subscribe.mockResolvedValue({
      ...order,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    render(<SubscriptionDialog open auth={auth} onClose={() => {}} onPaid={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "订阅" }));
    expect(await screen.findByTestId("payment-order-amount")).toHaveTextContent("¥38.00");
    expect(screen.getByRole("button", { name: "重新下单" })).toBeInTheDocument();
  });
});
