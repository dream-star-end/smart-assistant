import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import {
  publishDesktopNotifyState,
  registerDesktopNotifyToggle,
} from "../../lib/desktopNotifyPref";
import type { ChatProject, Session, User } from "../../lib/types";
import { Sidebar } from "../Sidebar";
import { LiveActivityStrip } from "./LiveActivityStrip";
import { collectLiveActivity } from "./liveActivity";

afterEach(cleanup);

function makeSession(over: Partial<Session> & { id: string }): Session {
  return {
    title: `会话 ${over.id}`,
    ownerUserId: "u1",
    updatedAt: "2026-11-20T04:00:00.000Z",
    messageCount: 2,
    ...over,
  };
}

const USER: User = { id: "u1", displayName: "测试用户", roles: ["user"] };
const PROJECTS: ChatProject[] = [
  { id: "p1", name: "量化回测", sortOrder: 0, createdAt: 1, updatedAt: 1, sessionCount: 2 },
];

describe("LiveActivityStrip", () => {
  it("无活态项时静默折叠零占位（不渲染任何 DOM）", () => {
    const summary = collectLiveActivity({
      sessions: [makeSession({ id: "s1", lastOutcome: "completed" })],
    });
    const { container } = render(
      <LiveActivityStrip summary={summary} onSelect={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("按 待拍板 > 运行中 > 刚完成未读 展示胶囊筛选并支持一键直达与已读清理", () => {
    const onSelect = vi.fn();
    const onMarkRead = vi.fn();
    const summary = collectLiveActivity({
      sessions: [
        makeSession({ id: "s-done", title: "PPT 导出完成", lastOutcome: "completed", projectId: "p1" }),
        makeSession({ id: "s-run", title: "跑回归测试", runState: "running" }),
        makeSession({ id: "s-app", title: "审批生产迁移", projectId: "p1" }),
      ],
      projects: PROJECTS,
      sessionNeedsYou: (id) => (id === "s-app" ? "approval" : null),
      unreadIds: new Set(["s-done"]),
    });

    render(
      <LiveActivityStrip
        summary={summary}
        activeId="s-run"
        onSelect={onSelect}
        onMarkRead={onMarkRead}
      />,
    );

    const list = screen.getByTestId("live-strip-list");
    const items = Array.from(list.querySelectorAll<HTMLButtonElement>("[data-live-session-id]"));
    expect(items.map((el) => el.dataset.liveSessionId)).toEqual(["s-app", "s-run", "s-done"]);
    expect(items[1]).toHaveAttribute("data-active", "true");

    // 筛选「待拍板」
    fireEvent.click(screen.getByTestId("live-strip-filter-needs_you"));
    expect(screen.getByTestId("live-strip-filter-needs_you")).toHaveAttribute("aria-pressed", "true");
    expect(
      Array.from(list.querySelectorAll<HTMLButtonElement>("[data-live-session-id]")).map(
        (el) => el.dataset.liveSessionId,
      ),
    ).toEqual(["s-app"]);

    // 再次点击取消筛选，回到全部
    fireEvent.click(screen.getByTestId("live-strip-filter-needs_you"));
    expect(screen.getByTestId("live-strip-filter-needs_you")).toHaveAttribute("aria-pressed", "false");

    // 点击待拍板会话直达（不触发 markRead）
    fireEvent.click(screen.getByRole("button", { name: "待拍板 · 审批生产迁移" }));
    expect(onSelect).toHaveBeenLastCalledWith("s-app");
    expect(onMarkRead).not.toHaveBeenCalled();

    // 点击刚完成未读会话：直达并标记已读
    fireEvent.click(screen.getByRole("button", { name: "已完成 · PPT 导出完成" }));
    expect(onMarkRead).toHaveBeenCalledWith("s-done");
    expect(onSelect).toHaveBeenLastCalledWith("s-done");
  });

  it("支持收起/展开列表，且超出 3 条时提供展开全部开关", () => {
    const sessions = Array.from({ length: 6 }, (_, i) =>
      makeSession({
        id: `run-${i}`,
        title: `后台任务 ${i}`,
        runState: "running",
        updatedAt: new Date(Date.UTC(2026, 10, 20, 4, i)).toISOString(),
      }),
    );
    const summary = collectLiveActivity({ sessions });
    render(<LiveActivityStrip summary={summary} onSelect={vi.fn()} />);

    expect(screen.getByTestId("live-strip-list").querySelectorAll("[data-live-session-id]")).toHaveLength(3);
    fireEvent.click(screen.getByTestId("live-strip-show-more"));
    expect(screen.getByTestId("live-strip-list").querySelectorAll("[data-live-session-id]")).toHaveLength(6);

    // 收起后保留胶囊栏、隐藏明细列表
    fireEvent.click(screen.getByTestId("live-strip-collapse-toggle"));
    expect(screen.queryByTestId("live-strip-list")).toBeNull();
    expect(screen.getByTestId("live-strip-filter-running")).toBeInTheDocument();
  });

  it("接入 Sidebar 后：仅历史未读不触发活态区；有运行/待拍板可直达；搜索时自动让位隐藏", async () => {
    const onSelect = vi.fn();
    const idleSessions = [
      makeSession({ id: "s-idle", title: "普通历史会话", lastOutcome: "completed", unread: true }),
    ];
    const { rerender } = render(
      <Sidebar
        sessions={idleSessions}
        unreadIds={new Set(["s-idle"])}
        user={USER}
        onSelect={onSelect}
        onNew={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("sidebar-live-strip")).toBeNull();

    const liveSessions = [
      makeSession({ id: "s-live", title: "正在编译内核", runState: "running" }),
      ...idleSessions,
    ];
    rerender(
      <Sidebar
        sessions={liveSessions}
        user={USER}
        onSelect={onSelect}
        onNew={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(await screen.findByTestId("sidebar-live-strip")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "运行中 · 正在编译内核" }));
    expect(onSelect).toHaveBeenCalledWith("s-live");

    // 搜索态下活态条让位，避免挤占搜索结果
    fireEvent.change(screen.getByPlaceholderText("搜索标题或消息"), { target: { value: "内核" } });
    expect(screen.queryByTestId("sidebar-live-strip")).toBeNull();
  });

  it("提供桌面通知轻量开关并联动 desktopNotifyPref（OCV5-817）", () => {
    const toggle = vi.fn();
    const unregister = registerDesktopNotifyToggle(toggle);
    publishDesktopNotifyState({ enabled: false, permission: "default" });
    try {
      const summary = collectLiveActivity({
        sessions: [makeSession({ id: "s-run", title: "跑单测", runState: "running" })],
      });
      render(<LiveActivityStrip summary={summary} onSelect={vi.fn()} />);
      const btn = screen.getByTestId("live-strip-notify-toggle");
      expect(btn).toHaveAttribute("aria-pressed", "false");
      fireEvent.click(btn);
      expect(toggle).toHaveBeenCalledWith(true);

      act(() => {
        publishDesktopNotifyState({ enabled: true, permission: "granted" });
      });
      expect(screen.getByTestId("live-strip-notify-toggle")).toHaveAttribute("aria-pressed", "true");
    } finally {
      unregister();
      act(() => {
        publishDesktopNotifyState({ enabled: false, permission: "unsupported" });
      });
    }
  });
});
