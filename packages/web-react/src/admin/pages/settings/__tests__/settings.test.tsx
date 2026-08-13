import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ToastProvider, TooltipProvider } from "../../../../components/ui";
import SettingsPage from "../index";

// adminApi 用 vi.hoisted 提前建 spy，供 vi.mock 工厂引用（工厂被提升到文件顶）。
const { adminGet, adminSend } = vi.hoisted(() => ({
  adminGet: vi.fn(),
  adminSend: vi.fn(),
}));

vi.mock("../../../lib/adminApi", () => ({
  adminGet,
  adminSend,
  ApiError: class ApiError extends Error {},
}));

// 混合 kind 的设置项，含一个 is_default 项。
const ROWS = [
  {
    key: "allow_registration",
    value: true,
    is_default: false,
    updated_at: "2026-07-01T00:00:00Z",
    updated_by: "7",
    meta: { kind: "boolean" },
  },
  {
    key: "signup_free_credits",
    value: 300,
    is_default: true, // 继承默认值 → 应出现「默认」徽标
    meta: { kind: "number", min: 0, max: 10000, description: "免费额度上限" },
  },
  {
    key: "risk_level",
    value: "medium",
    is_default: false,
    updated_at: "2026-07-05T00:00:00Z",
    meta: { kind: "enum", enumValues: ["low", "medium", "high"] },
  },
  {
    key: "billing_blocklist",
    value: ["FOO.com", "Bar.COM"],
    is_default: false,
    updated_at: "2026-07-06T00:00:00Z",
    meta: { kind: "string_array", max: 100 },
  },
];

function renderPage() {
  adminGet.mockResolvedValue({ rows: ROWS });
  adminSend.mockResolvedValue({});
  return render(
    <ToastProvider>
      <TooltipProvider>
        <SettingsPage />
      </TooltipProvider>
    </ToastProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SettingsPage", () => {
  test("按前缀分组渲染 key，且 is_default 项显示「默认」徽标", async () => {
    renderPage();

    // 首载完成：所有 key 渲染出来
    expect(await screen.findByText("allow_registration")).toBeTruthy();
    expect(screen.getByText("signup_free_credits")).toBeTruthy();
    expect(screen.getByText("risk_level")).toBeTruthy();
    expect(screen.getByText("billing_blocklist")).toBeTruthy();

    // 前缀分组标题（signup→注册 / risk→风控 / billing→计费）
    expect(screen.getByText("注册")).toBeTruthy();
    expect(screen.getByText("风控")).toBeTruthy();
    expect(screen.getByText("计费")).toBeTruthy();

    // 「默认」徽标：顶部说明 1 个 + is_default 行 1 个 ⇒ ≥2
    expect(screen.getAllByText("默认").length).toBeGreaterThanOrEqual(2);

    // GET /settings 只拉一次（配置页无轮询）
    expect(adminGet).toHaveBeenCalledTimes(1);
    expect(adminGet).toHaveBeenCalledWith("/settings");
  });

  test("boolean 项改开关后保存 → PUT 携带布尔 false", async () => {
    renderPage();
    const row = await screen.findByTestId("setting-allow_registration");

    // 初值 true → 点开关切到 false
    const sw = within(row).getByRole("switch");
    fireEvent.click(sw);

    fireEvent.click(within(row).getByRole("button", { name: "保存" }));

    const dialog = await screen.findByRole("dialog", { name: "确认关键设置变更？" });
    expect(within(dialog).getByText("true")).toBeTruthy();
    expect(within(dialog).getByText("false")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "确认保存" }));

    await waitFor(() =>
      expect(adminSend).toHaveBeenCalledWith("PUT", "/settings/allow_registration", {
        value: false,
        description: "",
      }),
    );
    // value 必须是布尔类型，不是字符串 "false"
    const [, , body] = adminSend.mock.calls[0];
    expect(body.value).toBe(false);
    expect(typeof body.value).toBe("boolean");
  });

  test("string_array 项保存 → split+trim+lowercase 成数组", async () => {
    renderPage();
    const row = await screen.findByTestId("setting-billing_blocklist");

    const ta = within(row).getByLabelText("billing_blocklist 取值");
    fireEvent.change(ta, { target: { value: "Alpha.com, Beta.COM\nGamma.com\n" } });

    fireEvent.click(within(row).getByRole("button", { name: "保存" }));

    const dialog = await screen.findByRole("dialog", { name: "确认保存设置？" });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认保存" }));

    await waitFor(() => expect(adminSend).toHaveBeenCalledTimes(1));
    const [method, path, body] = adminSend.mock.calls[0];
    expect(method).toBe("PUT");
    expect(path).toBe("/settings/billing_blocklist");
    expect(body.value).toEqual(["alpha.com", "beta.com", "gamma.com"]);
  });

  test("显示风险等级、更新人和审计深链", async () => {
    renderPage();
    const row = await screen.findByTestId("setting-allow_registration");
    expect(within(row).getByText("关键风险")).toBeTruthy();
    expect(within(row).getByText((_, el) => el?.textContent === "by #7")).toBeTruthy();
    expect(within(row).getByText("查看审计").getAttribute("href")).toBe("#tab=audit");
  });

  test("number 项空串被拦截，不发请求", async () => {
    renderPage();
    const row = await screen.findByTestId("setting-signup_free_credits");

    const input = within(row).getByLabelText("signup_free_credits 取值");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(within(row).getByRole("button", { name: "保存" }));

    // 空串被客户端拦截，adminSend 不应被调用
    await waitFor(() => expect(adminSend).not.toHaveBeenCalled());
  });
});
