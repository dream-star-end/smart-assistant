import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { createMemoryAuthSession } from "../../lib/authSession";
import type { AuthSession } from "../../lib/types";
import { OrgPayQr } from "./OrgPayQr";

vi.mock("../../lib/api", () => ({
  api: { getOrder: vi.fn(() => new Promise(() => {})) },
}));

const auth: AuthSession = createMemoryAuthSession(() => {}, "t");

afterEach(() => {
  cleanup();
  Object.defineProperties(window.navigator, {
    userAgent: { configurable: true, value: "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0" },
    userAgentData: { configurable: true, value: undefined },
  });
});

test("组织支付在手机只展示手机支付跳转，不加载二维码", () => {
  Object.defineProperties(window.navigator, {
    userAgent: {
      configurable: true,
      value: "Mozilla/5.0 (Linux; Android 16) Chrome/140.0 Mobile",
    },
    userAgentData: { configurable: true, value: { mobile: true } },
  });

  render(
    <OrgPayQr
      auth={auth}
      order={{
        orderNo: "org-order-1",
        qr: "https://pay.test/qr.png",
        mobileUrl: "https://pay.xunhupay.com/wechat/org-order-1",
      }}
      amountCents="3800"
      note="企业订阅"
      onPaid={() => {}}
    />,
  );

  expect(screen.getByTestId("mobile-payment-link")).toHaveAttribute(
    "href",
    "https://pay.xunhupay.com/wechat/org-order-1",
  );
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
});
