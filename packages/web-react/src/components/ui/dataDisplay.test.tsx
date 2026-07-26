import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cn } from "../../lib/utils";
import { CopyChip } from "./CopyChip";
import { DescriptionList, DescriptionRow } from "./DescriptionList";
import { Pagination } from "./Pagination";
import { StatCard } from "./StatCard";
import { TimeAgo, formatDate } from "./TimeAgo";
import { TooltipProvider } from "./Tooltip";

// 本仓 vitest 未开 globals 自动 cleanup,显式隔离每个用例的 DOM。
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Tooltip 原语要求 Provider 祖先(TimeAgo / CopyChip 都用了)。 */
function withTooltip(ui: React.ReactNode) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe("TimeAgo(全站日期唯一权威)", () => {
  it("relative 档按中文口径分级", () => {
    withTooltip(<TimeAgo value={Date.now() - 3 * 86_400_000} />);
    expect(screen.getByText("3 天前")).toBeTruthy();
  });

  it("绝对档是 canonical 的 YYYY-MM-DD HH:mm(不随 locale 抖动)", () => {
    const d = new Date(2026, 6, 26, 14, 30, 12);
    expect(formatDate(d, "datetime")).toBe("2026-07-26 14:30");
    expect(formatDate(d, "full")).toBe("2026-07-26 14:30:12");
    expect(formatDate(d, "date")).toBe("2026-07-26");
    expect(formatDate(d, "short")).toBe("07-26 14:30");
    expect(formatDate(d, "time")).toBe("14:30");
  });

  it("非法/缺失值回落占位,不抛也不渲染 Invalid Date", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate("not-a-date")).toBe("—");
    withTooltip(<TimeAgo value={undefined} />);
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("relative 档随墙钟自刷新(否则「刚刚」会一直挂着骗人)", () => {
    vi.useFakeTimers();
    const now = Date.now();
    withTooltip(<TimeAgo value={now - 59_000} />);
    expect(screen.getByText("刚刚")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText("1 分钟前")).toBeTruthy();
  });
});

describe("DescriptionList / DescriptionRow", () => {
  it("包在列表里按 dl/dt/dd 渲染(读屏成对播报)", () => {
    render(
      <DescriptionList>
        <DescriptionRow label="用户 ID" value="1024" />
      </DescriptionList>,
    );
    expect(screen.getByText("用户 ID").tagName).toBe("DT");
    expect(screen.getByText("1024").tagName).toBe("DD");
  });

  it("单独一行(admin 存量用法)回落 span —— 游离的 dt/dd 是非法结构", () => {
    render(<DescriptionRow label="套餐" value="Pro" />);
    expect(screen.getByText("套餐").tagName).toBe("SPAN");
    expect(screen.getByText("Pro").tagName).toBe("SPAN");
  });
});

describe("CopyChip", () => {
  it("点击写入剪贴板,并在触屏下满足 44px 靶面", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    withTooltip(<CopyChip value="u_123" label="#123" />);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("[@media(hover:none)]:min-h-11");
    fireEvent.click(btn);
    expect(writeText).toHaveBeenCalledWith("u_123");
  });
});

describe("StatCard", () => {
  it("默认是纯展示卡(无 button 语义)", () => {
    render(<StatCard label="今日收入" value="¥1,234" />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("传 onClick 才变可点卡,且键盘可达", () => {
    const onClick = vi.fn();
    render(<StatCard label="今日收入" value="¥1,234" onClick={onClick} />);
    const card = screen.getByRole("button");
    expect(card.getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(card, { key: "Enter" });
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("Pagination", () => {
  it("首页禁上一页;本页不满 limit 判末页禁下一页", () => {
    render(<Pagination offset={0} limit={20} count={7} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "上一页" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "下一页" })).toHaveProperty("disabled", true);
    expect(screen.getByText("1–7")).toBeTruthy();
  });

  it("翻页按偏移量步进,翻页按钮在触屏下 44px", () => {
    const onChange = vi.fn();
    render(<Pagination offset={20} limit={20} count={20} total={100} onChange={onChange} />);
    const next = screen.getByRole("button", { name: "下一页" });
    expect(next.className).toContain("[@media(hover:none)]:size-11");
    fireEvent.click(next);
    expect(onChange).toHaveBeenCalledWith(40);
    expect(screen.getByText("21–40 / 共 100")).toBeTruthy();
  });
});

describe("语义字号 × cn 合并契约", () => {
  it("语义字号不会被 tailwind-merge 当成颜色吃掉", () => {
    // tailwind-merge 不认得自定义 text-* 就会把它归进 text-color 组,与颜色类互斥后
    // 静默丢弃(cn("text-meta text-faint") → "text-faint")。这条断言守住 cn 的登记表。
    expect(cn("text-meta text-faint")).toBe("text-meta text-faint");
    expect(cn("text-body text-fg")).toBe("text-body text-fg");
    // 同组内仍应互斥:后写的字号胜出。
    expect(cn("text-meta text-caption")).toBe("text-caption");
  });
});
