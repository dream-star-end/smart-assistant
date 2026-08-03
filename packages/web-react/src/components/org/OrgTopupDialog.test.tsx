import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createMemoryAuthSession } from "../../lib/authSession";
import { OrgTopupDialog, yuanToCents } from "./OrgTopupDialog";

const apiMocks = vi.hoisted(() => ({
  orgTopup: vi.fn(),
  getOrgBalance: vi.fn(),
}));

vi.mock("../../lib/api", () => ({ api: apiMocks }));

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
