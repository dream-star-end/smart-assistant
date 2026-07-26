import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Package } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Badge } from "./Badge";
import { Card, CardRow } from "./Card";
import { ListSkeleton } from "./ListSkeleton";
import { EmptyState, Panel, PanelHeader } from "./Panel";
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
