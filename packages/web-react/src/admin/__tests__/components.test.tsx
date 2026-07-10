import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DataTable, type Column } from "../components/DataTable";
import { PageHeader } from "../components/PageHeader";
import { StatCard } from "../components/StatCard";

afterEach(cleanup);

describe("PageHeader", () => {
  test("渲染标题 / 描述 / actions", () => {
    render(<PageHeader title="总览" desc="收入与用量" actions={<button type="button">导出</button>} />);
    expect(screen.getByText("总览")).toBeTruthy();
    expect(screen.getByText("收入与用量")).toBeTruthy();
    expect(screen.getByRole("button", { name: "导出" })).toBeTruthy();
  });
});

describe("StatCard", () => {
  test("渲染标签 / 数值 / delta", () => {
    render(<StatCard label="今日收入" value="¥1,234" delta={{ value: "+12%", trend: "up" }} />);
    expect(screen.getByText("今日收入")).toBeTruthy();
    expect(screen.getByText("¥1,234")).toBeTruthy();
    expect(screen.getByText("+12%")).toBeTruthy();
  });

  test("loading 态：只渲染骨架，不渲染数值", () => {
    const { container } = render(<StatCard label="今日收入" value="¥1,234" loading />);
    expect(screen.queryByText("¥1,234")).toBeNull();
    expect(screen.queryByText("今日收入")).toBeNull();
    expect(container.querySelector(".animate-pulse")).toBeTruthy();
  });
});

describe("DataTable", () => {
  type Row = { id: string; name: string; n: number };
  const columns: Column<Row>[] = [
    { key: "name", title: "名称" },
    { key: "n", title: "数量", align: "right", render: (r) => `#${r.n}` },
  ];

  test("渲染表头与行（自定义 render）", () => {
    const rows: Row[] = [
      { id: "a", name: "Alpha", n: 3 },
      { id: "b", name: "Beta", n: 7 },
    ];
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />);
    expect(screen.getByText("名称")).toBeTruthy();
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.getByText("#7")).toBeTruthy();
  });

  test("空态", () => {
    render(<DataTable columns={columns} rows={[]} rowKey={(r) => r.id} emptyTitle="没有记录" />);
    expect(screen.getByText("没有记录")).toBeTruthy();
  });

  test("loading 态渲染骨架行", () => {
    const { container } = render(
      <DataTable columns={columns} rows={[]} rowKey={(r) => r.id} loading skeletonRows={3} />,
    );
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
    // loading 时不显示空态
    expect(screen.queryByText("暂无数据")).toBeNull();
  });

  test("行点击回调", () => {
    const onRowClick = vi.fn();
    const rows: Row[] = [{ id: "a", name: "Alpha", n: 3 }];
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} onRowClick={onRowClick} />);
    fireEvent.click(screen.getByText("Alpha"));
    expect(onRowClick).toHaveBeenCalledWith(rows[0], 0);
  });
});
