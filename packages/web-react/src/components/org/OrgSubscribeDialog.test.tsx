import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createMemoryAuthSession } from "../../lib/authSession";
import type { OrgSubscriptionInfo } from "../../lib/types";
import { OrgSubscribeDialog } from "./OrgSubscribeDialog";

const apiMocks = vi.hoisted(() => ({
  subscribeOrg: vi.fn(),
  addOrgSeats: vi.fn(),
  getOrder: vi.fn(),
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
});

const auth = createMemoryAuthSession(() => {}, "tok");

const subInfo: OrgSubscriptionInfo = {
  subscription: {
    planCode: "team",
    planName: "团队版",
    status: "active",
    seats: 5,
    periodStart: "2026-09-01T00:00:00.000Z",
    periodEnd: "2026-10-01T00:00:00.000Z",
    periodCredits: "1000000",
  },
  plans: [
    { code: "team", name: "团队版", seatPriceCents: "9900", perSeatCredits: "1000000", minSeats: 2, periodDays: 30 },
    { code: "biz", name: "企业版", seatPriceCents: "19900", perSeatCredits: "3000000", minSeats: 5, periodDays: 30 },
  ],
};

describe("OrgSubscribeDialog · 套餐卡「当前」徽章", () => {
  test("前景走 text-accent-fg 而不是写死白字:深色 --accent #9a8aff 是浅色底,白字只有 2.82:1(a11y-C,同 shell#1)", () => {
    render(
      <OrgSubscribeDialog open auth={auth} mode="subscribe" subInfo={subInfo} onClose={() => {}} onPaid={() => {}} />,
    );
    // 当前档(team)那张卡带「当前」徽章,另一档没有。
    expect(screen.getByRole("button", { name: /团队版/ })).toHaveTextContent("当前");
    expect(screen.getByRole("button", { name: /企业版/ })).not.toHaveTextContent("当前");
    const badge = screen.getByText("当前");
    expect(badge).toHaveClass("bg-accent", "text-accent-fg");
    expect(badge).not.toHaveClass("text-white");
  });
});
