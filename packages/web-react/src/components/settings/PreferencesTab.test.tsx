import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../../lib/api";
import type { AuthSession } from "../../lib/types";
import { PreferencesTab } from "./PreferencesTab";

const apiKeysSection = vi.hoisted(() => vi.fn(() => null));
vi.mock("./ApiKeysSection", () => ({ ApiKeysSection: apiKeysSection }));

const auth = {
  getToken: () => "tok",
  setToken: () => {},
  onExpired: () => {},
} as AuthSession;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  apiKeysSection.mockClear();
});

describe("PreferencesTab · Auto-Dream", () => {
  test("API Key 管理只为管理员挂载", () => {
    vi.spyOn(api, "getPublicModels").mockResolvedValue([]);
    const common = {
      auth, prefs: {}, autoDream: null, theme: "system" as const,
      onSetTheme: () => {}, onPatch: async () => {}, onUpgrade: () => {}, onOpenMemory: () => {},
    };
    const first = render(<PreferencesTab {...common} canManageApiKeys={false} />);
    expect(apiKeysSection).not.toHaveBeenCalled();
    first.unmount();

    render(<PreferencesTab {...common} canManageApiKeys />);
    expect(apiKeysSection).toHaveBeenCalledTimes(1);
  });

  test("不显示整理模型身份，并提供可感知结果入口", async () => {
    vi.spyOn(api, "getPublicModels").mockResolvedValue([]);
    const openMemory = vi.fn();

    render(
      <PreferencesTab
        auth={auth}
        prefs={{ auto_dream_enabled: true }}
        autoDream={
          {
            eligible: true,
            available: true,
            enabled: true,
            effective: true,
            minimum_plan_code: "max",
            min_interval_hours: 24,
            min_new_sessions: 5,
            // 模拟滚动发布期间旧响应仍带字段；UI 也不能显示。
            model_id: "deepseek-v4-flash",
            model_name: "DeepSeek V4 Flash",
          } as never
        }
        theme="system"
        onSetTheme={() => {}}
        onPatch={async () => {}}
        onUpgrade={() => {}}
        onOpenMemory={openMemory}
      />,
    );

    expect(screen.queryByText("整理模型")).not.toBeInTheDocument();
    expect(screen.queryByText(/DeepSeek V4 Flash|deepseek-v4-flash/)).not.toBeInTheDocument();
    expect(screen.getByText(/每次正常结束都会生成可见的梦境报告/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "查看整理记录" }));
    expect(openMemory).toHaveBeenCalledTimes(1);
  });

  test("不可用提示也不解释后台模型身份", () => {
    vi.spyOn(api, "getPublicModels").mockResolvedValue([]);
    render(
      <PreferencesTab
        auth={auth}
        prefs={{}}
        autoDream={{
          eligible: true,
          available: false,
          enabled: false,
          effective: false,
          minimum_plan_code: "max",
          min_interval_hours: 24,
          min_new_sessions: 5,
        }}
        theme="system"
        onSetTheme={() => {}}
        onPatch={async () => {}}
        onUpgrade={() => {}}
        onOpenMemory={() => {}}
      />,
    );

    expect(screen.getByText("Auto‑Dream 当前暂不可用，功能已安全暂停。")).toBeInTheDocument();
    expect(screen.queryByText(/模型当前不可用/)).not.toBeInTheDocument();
  });
});
