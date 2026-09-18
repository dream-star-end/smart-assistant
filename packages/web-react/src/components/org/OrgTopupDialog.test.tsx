import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createMemoryAuthSession } from "../../lib/authSession";
import { creditedDelta, OrgTopupDialog, yuanToCents } from "./OrgTopupDialog";

const apiMocks = vi.hoisted(() => ({
  orgTopup: vi.fn(),
  getOrgBalance: vi.fn(),
}));

vi.mock("../../lib/api", () => ({ api: apiMocks }));
vi.mock("../../lib/clientFriction", () => ({
  reportClientFrictionOnce: vi.fn(() => "eid"),
  reportClientFriction: vi.fn(() => "eid"),
  resetClientFrictionOnceForTests: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  Object.defineProperties(window.navigator, {
    userAgent: { configurable: true, value: "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0" },
    userAgentData: { configurable: true, value: undefined },
  });
});

describe("yuanToCents（元 → 分，纯字符串/BigInt，禁浮点）", () => {
  test("整数元换算", () => {
    expect(yuanToCents("100")).toBe("10000");
    expect(yuanToCents("1")).toBe("100");
    expect(yuanToCents("5000")).toBe("500000");
  });

  test("两位小数换算精确", () => {
    expect(yuanToCents("123.45")).toBe("12345");
    expect(yuanToCents("0.01")).toBe("1");
    expect(yuanToCents("99.9")).toBe("9990"); // 一位小数补零
  });

  test("首尾空白容忍", () => {
    expect(yuanToCents("  88  ")).toBe("8800");
  });

  test("超大金额不丢精度（越过 2^53）", () => {
    // 90071992547409.92 元 → 9007199254740992 分（> Number.MAX_SAFE_INTEGER）
    expect(yuanToCents("90071992547409.92")).toBe("9007199254740992");
  });

  test("非法 / 非正 → null", () => {
    expect(yuanToCents("")).toBeNull();
    expect(yuanToCents("0")).toBeNull();
    expect(yuanToCents("0.00")).toBeNull();
    expect(yuanToCents("-5")).toBeNull();
    expect(yuanToCents("1.234")).toBeNull(); // 超过两位小数
    expect(yuanToCents("abc")).toBeNull();
    expect(yuanToCents("1,000")).toBeNull();
    expect(yuanToCents("1e3")).toBeNull();
  });
});

describe("creditedDelta（到账积分 = 到账后余额 − 基线，字符串大数）", () => {
  test("正常增长返回差值", () => {
    expect(creditedDelta("1500", "1000")).toBe("500");
    expect(creditedDelta("9007199254740993", "1")).toBe("9007199254740992");
  });
  test("未增长 / 非法 → null", () => {
    expect(creditedDelta("1000", "1000")).toBeNull();
    expect(creditedDelta("900", "1000")).toBeNull();
    expect(creditedDelta("abc", "1000")).toBeNull();
  });
});

test("填额段说明到账规则与核对入口（后端未下发汇率，审计 SET-09）", () => {
  render(
    <OrgTopupDialog
      open
      auth={createMemoryAuthSession(() => {}, "t")}
      baselineCredits="1000"
      onClose={() => {}}
      onPaid={() => {}}
    />,
  );
  expect(screen.getByTestId("org-topup-rate-note")).toHaveTextContent("到账积分 = 支付金额 × 平台汇率");
  expect(screen.getByTestId("org-topup-rate-note")).toHaveTextContent("概览 → 组织钱包余额");
});

test("到账后显示实际入账积分数", async () => {
  apiMocks.orgTopup.mockResolvedValue({
    orderNo: "org-topup-2",
    qr: "https://pay.test/qr.png",
    mobileUrl: null,
  });
  // 下单时基线 1000，首个轮询 tick 即读到 6000 → 入账 5000。
  apiMocks.getOrgBalance.mockResolvedValueOnce("1000").mockResolvedValue("6000");
  const onPaid = vi.fn();
  render(
    <OrgTopupDialog
      open
      auth={createMemoryAuthSession(() => {}, "t")}
      baselineCredits="1000"
      onClose={() => {}}
      onPaid={onPaid}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "¥500" }));
  fireEvent.click(screen.getByRole("button", { name: "发起充值" }));
  expect(await screen.findByText("已到账 ¥500.00")).toBeInTheDocument();
  expect(screen.getByTestId("org-topup-credited")).toHaveTextContent("入账 5,000 积分");
  expect(onPaid).toHaveBeenCalledTimes(1);
});

test("组织充值下单后把 mobileUrl 透传到手机支付入口", async () => {
  Object.defineProperties(window.navigator, {
    userAgent: { configurable: true, value: "Mozilla/5.0 (iPhone) Mobile Safari/604.1" },
    userAgentData: { configurable: true, value: { mobile: true } },
  });
  apiMocks.orgTopup.mockResolvedValue({
    orderNo: "org-topup-1",
    qr: "https://pay.test/qr.png",
    mobileUrl: "https://pay.xunhupay.com/wechat/org-topup-1",
  });
  apiMocks.getOrgBalance.mockResolvedValue("1000");

  render(
    <OrgTopupDialog
      open
      auth={createMemoryAuthSession(() => {}, "t")}
      baselineCredits="1000"
      onClose={() => {}}
      onPaid={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "¥100" }));
  fireEvent.click(screen.getByRole("button", { name: "发起充值" }));

  expect(await screen.findByTestId("mobile-payment-link")).toHaveAttribute(
    "href",
    "https://pay.xunhupay.com/wechat/org-topup-1",
  );
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
});
