import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Alert } from "./Alert";
import { Avatar } from "./Avatar";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { IconButton } from "./IconButton";
import { Progress } from "./Progress";
import { Skeleton } from "./Skeleton";
import { Tabs } from "./Tabs";

// 本仓 vitest 未开 globals 自动 cleanup,显式隔离每个用例的 DOM。
afterEach(cleanup);

describe("ui primitives", () => {
  it("Button renders children, defaults to type=button, fires click", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>提交</Button>);
    const btn = screen.getByRole("button", { name: "提交" });
    expect(btn.getAttribute("type")).toBe("button");
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("Button maps variant + shape to token classes via cva", () => {
    render(
      <Button variant="accent" shape="pill">
        CTA
      </Button>,
    );
    const btn = screen.getByRole("button", { name: "CTA" });
    expect(btn.className).toContain("bg-accent");
    expect(btn.className).toContain("rounded-full");
  });

  it("Button disabled does not fire click", () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        x
      </Button>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("IconButton forwards aria-label and is round by default", () => {
    render(
      <IconButton aria-label="关闭">
        <span>x</span>
      </IconButton>,
    );
    const btn = screen.getByRole("button", { name: "关闭" });
    expect(btn.className).toContain("rounded-full");
  });

  it("IconButton square shape switches radius (Copy/regenerate pattern)", () => {
    render(
      <IconButton aria-label="复制" shape="square" size="sm">
        <span>c</span>
      </IconButton>,
    );
    expect(screen.getByRole("button", { name: "复制" }).className).toContain("rounded-md");
  });

  it("Badge tone maps to semantic status token", () => {
    render(<Badge tone="success">ok</Badge>);
    expect(screen.getByText("ok").className).toContain("text-success");
  });

  it("Avatar falls back to initials with brand gradient by default", () => {
    render(<Avatar fallback="乾" />);
    expect(screen.getByText("乾").className).toContain("bg-grad-cta");
  });

  it("Avatar renders an img when src is provided", () => {
    render(<Avatar src="/x.png" alt="头像" />);
    expect(screen.getByRole("img", { name: "头像" })).toBeTruthy();
  });

  it("Tabs (accessible tablist) marks active tab, fires on click, supports arrow-key nav", () => {
    const onChange = vi.fn();
    render(
      <Tabs
        value="a"
        onValueChange={onChange}
        aria-label="视图切换"
        items={[
          { value: "a", label: "概览" },
          { value: "b", label: "账单" },
        ]}
      />,
    );
    const overview = screen.getByRole("tab", { name: "概览" });
    expect(screen.getByRole("tablist").className).toContain("overflow-x-auto");
    expect(overview.className).toContain("shrink-0");
    expect(overview.getAttribute("aria-selected")).toBe("true");
    expect(overview.getAttribute("tabindex")).toBe("0");
    const ledger = screen.getByRole("tab", { name: "账单" });
    expect(ledger.getAttribute("aria-selected")).toBe("false");
    expect(ledger.getAttribute("tabindex")).toBe("-1");
    fireEvent.click(ledger);
    expect(onChange).toHaveBeenCalledWith("b");
    fireEvent.keyDown(overview, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("b");
  });

  it("Alert maps tone to a semantic soft background and exposes role=alert", () => {
    render(
      <Alert tone="danger" title="余额不足">
        请充值后继续
      </Alert>,
    );
    expect(screen.getByRole("alert").className).toContain("bg-danger-soft");
    expect(screen.getByText("余额不足")).toBeTruthy();
  });

  it("Progress clamps out-of-range value and exposes aria-valuenow", () => {
    render(<Progress value={150} />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
  });

  it("Skeleton renders a pulse placeholder", () => {
    const { container } = render(<Skeleton className="h-4 w-20" />);
    expect((container.firstChild as HTMLElement).className).toContain("animate-pulse");
  });
});
