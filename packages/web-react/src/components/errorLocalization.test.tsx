import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError, api } from "../lib/api";
import type { AuthSession } from "../lib/types";
import { CronPanel } from "./manage/CronPanel";
import { UsageTab } from "./settings/UsageTab";
import { InstalledPanel } from "./marketplace/InstalledPanel";

const auth = { getToken: () => "tok", setToken: () => {}, onExpired: () => {} } as AuthSession;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * 各业务面板 catch 分支历史上直接把后端英文/技术 message 怼给用户（`(e as Error).message`）。
 * 收口后统一走 apiErrorMessage：英文/技术串 → 该操作语义化中文 fallback（+ 追踪号），
 * 后端中文文案 → 直显。此处对 settings / manage / marketplace 各抽一个面板做端到端断言。
 * 模拟后端错误信封：message 已由 throwApi→withReqId 烙入「（追踪号 …）」后缀（生产实况）。
 */
function englishApiError() {
  return new ApiError({
    status: 500,
    message: "sync failed（追踪号 req-behav）",
    requestId: "req-behav",
  });
}

describe("展示层错误收口：后端英文 message 不外露，渲染中文 fallback", () => {
  test("manage/CronPanel · 渲染「加载定时任务失败」而非英文原文", async () => {
    vi.spyOn(api, "listCron").mockRejectedValue(englishApiError());
    render(<CronPanel auth={auth} />);
    expect(
      await screen.findByText("加载定时任务失败（追踪号 req-behav）"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/sync failed/)).not.toBeInTheDocument();
  });

  test("settings/UsageTab · 渲染「加载用量统计失败」而非英文原文", async () => {
    vi.spyOn(api, "getUsage").mockRejectedValue(englishApiError());
    render(<UsageTab auth={auth} />);
    expect(
      await screen.findByText("加载用量统计失败（追踪号 req-behav）"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/sync failed/)).not.toBeInTheDocument();
  });

  test("marketplace/InstalledPanel · 渲染「加载已安装失败」而非英文原文", async () => {
    vi.spyOn(api, "listMarketplaceInstalled").mockRejectedValue(englishApiError());
    vi.spyOn(api, "listMyAgents").mockResolvedValue([]);
    render(<InstalledPanel auth={auth} onGoBrowse={() => {}} />);
    expect(
      await screen.findByText("加载已安装失败（追踪号 req-behav）"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/sync failed/)).not.toBeInTheDocument();
  });

  test("后端中文 message 直显（不被 fallback 覆盖、剥掉追踪号后缀）", async () => {
    vi.spyOn(api, "listCron").mockRejectedValue(
      new ApiError({
        status: 400,
        message: "未上架或不存在（追踪号 req-zh）",
        requestId: "req-zh",
      }),
    );
    render(<CronPanel auth={auth} />);
    expect(await screen.findByText("未上架或不存在")).toBeInTheDocument();
  });
});
