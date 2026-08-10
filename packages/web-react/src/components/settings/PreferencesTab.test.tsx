import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../../lib/api";
import { createMemoryAuthSession } from "../../lib/authSession";
import type { AuthSession } from "../../lib/types";
import { PreferencesTab } from "./PreferencesTab";

const apiKeysSection = vi.hoisted(() => vi.fn(() => null));
vi.mock("./ApiKeysSection", () => ({ ApiKeysSection: apiKeysSection }));
vi.mock("./QqBindingCard", () => ({ QqBindingCard: () => null }));

const auth: AuthSession = createMemoryAuthSession(() => {}, "tok");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  apiKeysSection.mockClear();
});

describe("PreferencesTab · 对话行为", () => {
  test("不再提供自动继续执行设置", () => {
    vi.spyOn(api, "getPublicModels").mockResolvedValue([]);
    render(
      <PreferencesTab
        auth={auth}
        prefs={{}}
        autoDream={null}
        theme="system"
        onSetTheme={() => {}}
        onPatch={async () => {}}
        onUpgrade={() => {}}
        onOpenMemory={() => {}}
      />,
    );

    expect(screen.queryByRole("switch", { name: "自动继续执行" })).not.toBeInTheDocument();
    expect(screen.queryByText("自动继续执行")).not.toBeInTheDocument();
  });
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

  test("滚动兼容阶段不承诺具体模型，并提供优化建议入口", async () => {
    vi.spyOn(api, "getPublicModels").mockResolvedValue([]);
    const openMemory = vi.fn();

    render(
      <PreferencesTab
        auth={auth}
        prefs={{ auto_optimizer_enabled: true }}
        autoDream={
          {
            eligible: true,
            available: true,
            enabled: true,
            optimizer_enabled: true,
            legacy_enabled: false,
            effective: true,
            minimum_plan_code: "max",
            min_interval_hours: 168,
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

    expect(screen.getByText(/平台统一的 Auto-Dream 模型结合平台功能与技能/)).toBeInTheDocument();
    expect(screen.queryByText(/DeepSeek V4 Flash/)).not.toBeInTheDocument();
    expect(screen.queryByText(/MiniMax M3/)).not.toBeInTheDocument();
    expect(screen.queryByText(/deepseek-v4-flash/)).not.toBeInTheDocument();
    expect(screen.getByText(/所有用户内容和功能设置修改都先展示差异/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "查看优化建议" }));
    expect(openMemory).toHaveBeenCalledTimes(1);
  });

  test("开启全面优化前必须确认审计、计费和匿名上报", async () => {
    vi.spyOn(api, "getPublicModels").mockResolvedValue([]);
    const onPatch = vi.fn(async () => {});
    render(
      <PreferencesTab
        auth={auth}
        prefs={{}}
        autoDream={{
          eligible: true,
          available: true,
          enabled: false,
          optimizer_enabled: false,
          legacy_enabled: false,
          effective: false,
          minimum_plan_code: "max",
          min_interval_hours: 168,
          min_new_sessions: 5,
        }}
        theme="system"
        onSetTheme={() => {}}
        onPatch={onPatch}
        onUpgrade={() => {}}
        onOpenMemory={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("switch", { name: "Auto-Dream" }));
    expect(screen.getByText("开启 Auto‑Dream 全面优化？")).toBeInTheDocument();
    expect(screen.getByText(/匿名平台优化发现/)).toBeInTheDocument();
    expect(onPatch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "同意并开启" }));
    await vi.waitFor(() =>
      expect(onPatch).toHaveBeenCalledWith({ auto_optimizer_enabled: true }),
    );
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
