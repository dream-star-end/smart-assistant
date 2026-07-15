import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { AuthSession } from "../../lib/types";
import { createMemoryAuthSession } from "../../lib/authSession";
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

test("组织支付在手机只展示截图相册扫码，不显示手机跳转", () => {
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
        mobileUrl: "https://pay.test/mobile",
      }}
      amountCents="3800"
      note="企业订阅"
      onPaid={() => {}}
    />,
  );

  expect(screen.getByRole("img", { name: "微信支付二维码" })).toHaveAttribute(
    "src",
    "https://pay.test/qr.png",
  );
  expect(screen.getByTestId("mobile-screenshot-payment-hint")).toHaveTextContent("从相册选择");
  expect(screen.queryByTestId("mobile-payment-link")).not.toBeInTheDocument();
});
