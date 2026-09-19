import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Package } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Alert } from "./Alert";
import { Badge } from "./Badge";
import { Card, CardRow } from "./Card";
import { ListSkeleton } from "./ListSkeleton";
import { EmptyState, Panel, PanelHeader } from "./Panel";
import { Sheet } from "./Sheet";
import { Toolbar } from "./Toolbar";

// 本仓 vitest 未开 globals 自动 cleanup,显式隔离每个用例的 DOM。
afterEach(cleanup);

/**
 * 表面层原语(Card / CardRow / Badge / Panel / ListSkeleton / Toolbar)的契约。
 * 第一条用例锁的是**向后兼容硬门**:Card 的默认渲染必须与变体化之前逐字节一致 ——
 * 全仓 38 处存量调用外加即将并回来的 39 处手抄都压在这个字符串上,它一变就是全站视觉漂移。
 */
describe("ui surfaces", () => {
  it("Card default renders byte-identical to the pre-change primitive", () => {
    const { container } = render(<Card />);
    expect((container.firstChild as HTMLElement).className).toBe(
      "rounded-xl border border-border bg-surface shadow-soft",
    );
  });

  it("Card variants compose without token collisions", () => {
    const { container } = render(<Card padding="md" tone="accent" interactive />);
    const cls = (container.firstChild as HTMLElement).className;
    expect(cls).toContain("p-4");
    expect(cls).toContain("bg-accent-soft");
    expect(cls).not.toContain("bg-surface");
    expect(cls).toContain("[@media(hover:none)]:min-h-11");
    expect(cls).toContain("focus-visible:ring-2");
  });

  it("Badge keeps size AND tone through cn/twMerge", () => {
    render(<Badge tone="danger">x</Badge>);
    const cls = screen.getByText("x").className;
    expect(cls).toContain("text-danger");
    expect(cls).toContain("text-meta");
    expect(cls).toContain("shrink-0");
    render(<Badge size="sm">y</Badge>);
    expect(screen.getByText("y").className).toContain("text-caption");
  });

  it("CardRow lays out icon / body / actions", () => {
    render(
      <CardRow
        icon={<span>i</span>}
        title="标题"
        description="说明"
        meta={<Badge>tag</Badge>}
        actions={<button type="button">操作</button>}
      />,
    );
    expect(screen.getByText("标题").className).toContain("text-section");
    expect(screen.getByText("说明").className).toContain("text-muted");
    expect(screen.getByRole("button", { name: "操作" })).toBeTruthy();
  });

  it("PanelHeader / EmptyState use the semantic scale and muted hints", () => {
    render(<PanelHeader title="分区" hint="下一步" />);
    expect(screen.getByRole("heading", { name: "分区" }).className).toContain("text-title");
    expect(screen.getByText("下一步").className).toContain("text-muted");
    render(<EmptyState icon={Package} title="空" hint="去添加" />);
    expect(screen.getByText("空").className).toContain("text-section");
    expect(screen.getByText("去添加").className).toContain("text-muted");
  });

  it("Panel = Card + header + divided body + footer", () => {
    const { container } = render(
      <Panel title="面板" hint="h" footer={<span>页脚</span>}>
        <span>内容</span>
      </Panel>,
    );
    expect((container.firstChild as HTMLElement).className).toContain("bg-surface");
    expect(screen.getByText("内容").parentElement?.className).toContain("border-t");
    expect(screen.getByText("页脚")).toBeTruthy();
  });

  it("Panel bodyClassName overrides default padding", () => {
    render(
      <Panel title="p" bodyClassName="p-0">
        <span>c</span>
      </Panel>,
    );
    const body = screen.getByText("c").parentElement as HTMLElement;
    expect(body.className).toContain("p-0");
    expect(body.className).not.toContain("px-4");
  });

  it("ListSkeleton announces loading and renders N rows", () => {
    const { container } = render(<ListSkeleton rows={3} />);
    expect(screen.getByText("加载中…").className).toContain("sr-only");
    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(3);
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("ListSkeleton card variant is a grid", () => {
    render(<ListSkeleton rows={2} variant="card" />);
    expect(screen.getByRole("status").className).toContain("grid");
  });

  it("Toolbar debounces search and syncs external resets", () => {
    vi.useFakeTimers();
    const onSearchChange = vi.fn();
    const { rerender } = render(
      <Toolbar title="技能" count={1234} search="" onSearchChange={onSearchChange} />,
    );
    expect(screen.getByText("1,234")).toBeTruthy();
    const input = screen.getByRole("searchbox");
    fireEvent.change(input, { target: { value: "ab" } });
    expect(onSearchChange).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onSearchChange).toHaveBeenCalledWith("ab");
    // 外部权威值先吸收草稿,再被重置 → 草稿跟随,且不产生回声回调
    onSearchChange.mockClear();
    rerender(<Toolbar title="技能" count={0} search="ab" onSearchChange={onSearchChange} />);
    rerender(<Toolbar title="技能" count={0} search="" onSearchChange={onSearchChange} />);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect((input as HTMLInputElement).value).toBe("");
    expect(onSearchChange).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("Toolbar without onSearchChange renders no search box", () => {
    render(<Toolbar title="只读" actions={<button type="button">刷新</button>} />);
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.getByRole("button", { name: "刷新" })).toBeTruthy();
  });
});

/**
 * Alert 的读屏播报级别(shell 审计 S-07):原实现无条件 role="alert"(隐含 assertive),
 * 挂载即存在的静态说明会被当成打断式播报。现在按 tone 推导,调用方可显式覆盖。
 */
describe("Alert live region", () => {
  it("danger / warning 默认 role=alert(assertive),info / success 默认 role=status(polite)", () => {
    render(
      <>
        <Alert tone="danger">d</Alert>
        <Alert tone="warning">w</Alert>
        <Alert tone="info">i</Alert>
        <Alert tone="success">s</Alert>
      </>,
    );
    expect(screen.getByText("d").closest('[role="alert"]')).not.toBeNull();
    expect(screen.getByText("w").closest('[role="alert"]')).not.toBeNull();
    expect(screen.getByText("i").closest('[role="status"]')).not.toBeNull();
    expect(screen.getByText("s").closest('[role="status"]')).not.toBeNull();
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    expect(screen.getAllByRole("status")).toHaveLength(2);
  });

  it("未传 tone 时等于 info → status", () => {
    render(<Alert>默认</Alert>);
    expect(screen.getByRole("status").textContent).toContain("默认");
  });

  it("显式 live 覆盖默认:info 可升为 assertive,danger 可降为 polite,off 不进 live region", () => {
    const { container } = render(
      <>
        <Alert tone="info" live="assertive">
          urgent
        </Alert>
        <Alert tone="danger" live="polite">
          calm
        </Alert>
        <Alert tone="info" live="off">
          静态说明
        </Alert>
      </>,
    );
    expect(screen.getByText("urgent").closest('[role="alert"]')).not.toBeNull();
    expect(screen.getByText("calm").closest('[role="status"]')).not.toBeNull();
    const still = screen.getByText("静态说明").closest("div.rounded-lg");
    expect(still).not.toBeNull();
    expect(still?.getAttribute("role")).toBeNull();
    expect(container.querySelectorAll("[role]")).toHaveLength(2);
  });

  it("视觉类名不因 live 而变(role 变化零视觉差)", () => {
    render(<Alert tone="info">x</Alert>);
    const cls = screen.getByRole("status").className;
    expect(cls).toContain("bg-info-soft");
    expect(cls).toContain("px-4 py-3 text-sm");
  });
});

/** Sheet 贴底变体自带滚动容器(shell 审计 S-17):内容超过 85dvh 不再被裁掉且滚不到。 */
describe("Sheet bottom variant", () => {
  it("side=bottom 的内容容器带 max-h + overflow-y-auto", () => {
    render(
      <Sheet open onOpenChange={() => {}} side="bottom" srTitle="贴底">
        <p>内容</p>
      </Sheet>,
    );
    const cls = screen.getByRole("dialog").className;
    expect(cls).toContain("max-h-[85dvh]");
    expect(cls).toContain("overflow-y-auto");
    expect(cls).toContain("overscroll-contain");
  });

  it("side=right 不受影响(侧栏抽屉沿用调用方自己的滚动容器)", () => {
    render(
      <Sheet open onOpenChange={() => {}} side="right" srTitle="右侧">
        <p>内容</p>
      </Sheet>,
    );
    expect(screen.getByRole("dialog").className).not.toContain("overflow-y-auto");
  });
});
