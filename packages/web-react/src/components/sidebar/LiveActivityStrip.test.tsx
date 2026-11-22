import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { ChatProject, Session, User } from "../../lib/types";
import { Sidebar } from "../Sidebar";
import { ToastProvider } from "../ui";
import { LiveActivityStrip, SidebarLiveActivityStrip } from "./LiveActivityStrip";
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

  it("活动条不再内嵌桌面通知开关（由设置中心统一承接）", () => {
    const summary = collectLiveActivity({
      sessions: [makeSession({ id: "s-run", title: "跑单测", runState: "running" })],
    });
    render(<LiveActivityStrip summary={summary} onSelect={vi.fn()} />);
    expect(screen.queryByTestId("live-strip-notify-toggle")).toBeNull();
  });

  it("仅有 1 条运行中且就是当前选中会话时直接隐藏空壳标题栏，切走后自动展开直达", () => {
    const summary = collectLiveActivity({
      sessions: [
        makeSession({ id: "s-run", title: "正在重构侧栏", runState: "running" }),
        makeSession({ id: "s-other", title: "普通历史会话", lastOutcome: "completed" }),
      ],
    });
    const onSelect = vi.fn();
    const { rerender } = render(
      <LiveActivityStrip summary={summary} activeId="s-run" onSelect={onSelect} />,
    );

    // 仅当前正在看的 1 条在运行时完全隐藏，不留空壳标题栏
    expect(screen.queryByTestId("sidebar-live-strip")).toBeNull();

    // 切到其他会话后，后台运行项自动出现并展开，便于一键跳回
    rerender(<LiveActivityStrip summary={summary} activeId="s-other" onSelect={onSelect} />);
    expect(screen.getByTestId("sidebar-live-strip")).toBeInTheDocument();
    expect(screen.getByTestId("live-strip-list")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "运行中 · 正在重构侧栏" }));
    expect(onSelect).toHaveBeenCalledWith("s-run");

    // 回到当前运行会话后再次隐藏
    rerender(<LiveActivityStrip summary={summary} activeId="s-run" onSelect={onSelect} />);
    expect(screen.queryByTestId("sidebar-live-strip")).toBeNull();
  });

  it("SidebarLiveActivityStrip 将待拍板统一收敛到 PendingDecisionsDock 唯一入口，不再与活动条双显「待拍板」", () => {
    const onSelect = vi.fn();
    const sessions = [
      makeSession({ id: "s-app", title: "审批生产迁移" }),
      makeSession({ id: "s-run", title: "后台编译任务", runState: "running" }),
    ];
    render(
      <ToastProvider>
        <SidebarLiveActivityStrip
          sessions={sessions}
          activeId="s-other"
          sessionNeedsYou={(id) => (id === "s-app" ? "approval" : null)}
          onSelect={onSelect}
        />
      </ToastProvider>,
    );

    // 侧栏唯一「待拍板」入口由 PendingDecisionsDock 承接，且不丢审批项
    expect(screen.getByTestId("pending-decisions-dock")).toBeInTheDocument();
    expect(screen.getByTestId("pending-decisions-count")).toHaveTextContent("1");
    // 活动条仅承接运行中会话，不再重复渲染「待拍板」筛选胶囊
    expect(screen.getByTestId("sidebar-live-strip")).toBeInTheDocument();
    expect(screen.queryByTestId("live-strip-filter-needs_you")).toBeNull();
    expect(screen.getByTestId("live-strip-filter-running")).toBeInTheDocument();

    // 展开唯一「待拍板」可直达对应会话
    fireEvent.click(screen.getByTestId("pending-decisions-toggle"));
    fireEvent.click(screen.getByTestId("pending-decision-goto"));
    expect(onSelect).toHaveBeenCalledWith("s-app");
  });
});
