import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createMemoryAuthSession } from "../lib/authSession";
import { ApiError, api } from "../lib/api";
import { BRAND } from "../lib/brand";
import {
  DesktopEnrollPage,
  enrollNavigation,
  parseEnrollmentId,
  parsePublicName,
} from "./DesktopEnrollPage";

const UUID = "550e8400-e29b-41d4-a716-446655440000";
const CODE = "c".repeat(64);
const DEEP_LINK = `openclaude://enroll/callback?enrollment_id=${UUID}&code=${CODE}`;

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      confirmDesktopEnroll: vi.fn(),
    },
  };
});

const confirmMock = api.confirmDesktopEnroll as unknown as ReturnType<typeof vi.fn>;
const auth = createMemoryAuthSession(() => {}, "tok-enroll");

function go(search: string) {
  window.history.replaceState({}, "", `/desktop/enroll${search}`);
}

beforeEach(() => {
  confirmMock.mockReset();
  go(`?enrollment_id=${UUID}`);
});

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
});

describe("parseEnrollmentId", () => {
  test("合法 uuid 通过，非法值返回 null（不发请求）", () => {
    expect(parseEnrollmentId(`?enrollment_id=${UUID}`)).toBe(UUID);
    expect(parseEnrollmentId("?enrollment_id=not-a-uuid")).toBeNull();
    expect(parseEnrollmentId("?enrollment_id=")).toBeNull();
    expect(parseEnrollmentId("")).toBeNull();
    expect(parseEnrollmentId("?foo=1")).toBeNull();
  });

  test("计算机名缺省为 null", () => {
    expect(parsePublicName(`?enrollment_id=${UUID}`)).toBeNull();
    expect(parsePublicName(`?enrollment_id=${UUID}&public_name=DESKTOP-A`)).toBe("DESKTOP-A");
  });
});

describe("DesktopEnrollPage", () => {
  test("uuid 非法：显示链接无效且不发请求", () => {
    go("?enrollment_id=not-a-uuid");
    render(<DesktopEnrollPage auth={auth} />);
    expect(screen.getByRole("alert")).toHaveTextContent("链接无效");
    expect(screen.queryByRole("button", { name: "确认这台电脑" })).not.toBeInTheDocument();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(document.body.textContent).toMatch(/链接无效/);
  });

  test("已登录可确认：展示品牌文案，不自动确认，计算机名缺省不显示", () => {
    render(<DesktopEnrollPage auth={auth} />);
    expect(
      screen.getByText(`${BRAND.nameEn} 想把这台电脑注册为你的本地运行环境`),
    ).toBeInTheDocument();
    expect(screen.queryByText(/计算机名/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认这台电脑" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消" })).toBeInTheDocument();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(`${BRAND.nameEn} 想把这台电脑注册为你的本地运行环境`);
  });

  test("确认成功 → assign 深链；code 不出现在 DOM 文本", async () => {
    confirmMock.mockResolvedValue({ enrollmentId: UUID, deepLink: DEEP_LINK });
    const assign = vi.spyOn(enrollNavigation, "assign").mockImplementation(() => {});
    render(<DesktopEnrollPage auth={auth} />);
    fireEvent.click(screen.getByRole("button", { name: "确认这台电脑" }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalledWith(auth, UUID));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(DEEP_LINK));
    expect(screen.getByRole("status")).toHaveTextContent(`正在返回 ${BRAND.nameEn}`);
    expect(document.body.textContent).not.toContain(CODE);
    expect(screen.getByRole("button", { name: `打开 ${BRAND.nameEn}` })).toBeInTheDocument();
  });

  test("深链被拦时手动打开再次 assign，code 仍不进文本", async () => {
    confirmMock.mockResolvedValue({ enrollmentId: UUID, deepLink: DEEP_LINK });
    const assign = vi.spyOn(enrollNavigation, "assign").mockImplementation(() => {});
    render(<DesktopEnrollPage auth={auth} />);
    fireEvent.click(screen.getByRole("button", { name: "确认这台电脑" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(DEEP_LINK));
    assign.mockClear();
    fireEvent.click(screen.getByRole("button", { name: `打开 ${BRAND.nameEn}` }));
    expect(assign).toHaveBeenCalledWith(DEEP_LINK);
    expect(document.body.textContent).not.toContain(CODE);
  });

  test("409 DEVICE_LIMIT DOM 摘要", async () => {
    confirmMock.mockRejectedValue(
      new ApiError({ status: 409, code: "DEVICE_LIMIT", message: "user already has a live desktop device" }),
    );
    render(<DesktopEnrollPage auth={auth} />);
    fireEvent.click(screen.getByRole("button", { name: "确认这台电脑" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("你已有一台电脑处于本地模式，请先在设置中解绑");
    expect(alert).toHaveAttribute("data-device-limit", "true");
    expect(document.body.textContent).toContain("你已有一台电脑处于本地模式，请先在设置中解绑");
    expect(document.body.textContent).not.toContain("user already has a live desktop device");
  });

  test.each([
    [403, "DESKTOP_NOT_ENTITLED", "本地模式尚未对你的账号开放"],
    [409, "DEVICE_LIMIT", "你已有一台电脑处于本地模式，请先在设置中解绑"],
    [409, "ENROLL_INVALID", `链接已过期，请在 ${BRAND.nameEn} 里重新发起`],
    [404, "NOT_FOUND", "本地模式未启用"],
    [429, "RATE_LIMITED", "操作过于频繁"],
  ] as const)("错误码 %s %s 展示指定文案", async (status, code, copy) => {
    confirmMock.mockRejectedValue(
      new ApiError({ status, code, message: "internal english leak" }),
    );
    render(<DesktopEnrollPage auth={auth} />);
    fireEvent.click(screen.getByRole("button", { name: "确认这台电脑" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(copy);
    expect(alert).not.toHaveTextContent("internal english leak");
    expect(document.body.textContent).not.toContain(CODE);
  });
});
