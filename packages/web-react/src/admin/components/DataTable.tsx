import { Inbox } from "lucide-react";
import type { ReactNode } from "react";
import { EmptyState, Skeleton } from "../../components/ui";
import { cn } from "../../lib/utils";

// 配套的 <Pagination/> 已提升为全站原语(components/ui/Pagination.tsx)——
// 翻页是"分页语义"不是"表格语义",用户侧的卡片列表同样要用。
// DataTable 本身留在 admin:用户侧是卡片列表,不需要表格。

export type Column<T> = {
  /** 列 key；无 render 时用作 `row[key]` 取值，也用作表头 React key。 */
  key: string;
  title: ReactNode;
  /** 固定列宽（数字=px 或 CSS 宽度串）。 */
  width?: string | number;
  align?: "left" | "right" | "center";
  /** 自定义单元渲染；缺省取 `String(row[key])`。 */
  render?: (row: T, index: number) => ReactNode;
  /** 表头附加类。 */
  headClassName?: string;
  /** 单元附加类（如数字列 tabular-nums）。 */
  cellClassName?: string;
};

const alignClass = { left: "text-left", right: "text-right", center: "text-center" } as const;

/**
 * 紧凑密度数据表。sticky 表头、loading 骨架行、空态、可选行点击；**横向溢出容器内滚动**
 * （表体不撑破页面）。分页用配套 <Pagination/>。
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading,
  skeletonRows = 6,
  empty,
  emptyTitle = "暂无数据",
  emptyHint,
  onRowClick,
  className,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  loading?: boolean;
  skeletonRows?: number;
  /** 完整自定义空态节点；给了它则忽略 emptyTitle/emptyHint。 */
  empty?: ReactNode;
  emptyTitle?: string;
  emptyHint?: string;
  onRowClick?: (row: T, index: number) => void;
  className?: string;
}) {
  const showEmpty = !loading && rows.length === 0;

  return (
    <div className={cn("overflow-x-auto rounded-xl border border-border bg-surface", className)}>
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-surface">
          <tr className="border-b border-border">
            {columns.map((c) => (
              <th
                key={c.key}
                style={c.width ? { width: c.width } : undefined}
                className={cn(
                  "whitespace-nowrap px-3 py-2.5 text-meta font-medium text-faint",
                  alignClass[c.align ?? "left"],
                  c.headClassName,
                )}
              >
                {c.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading &&
            Array.from({ length: skeletonRows }).map((_, r) => (
              <tr key={`sk-${r}`} className="border-b border-border/60 last:border-0">
                {columns.map((c) => (
                  <td key={c.key} className="px-3 py-2.5">
                    <Skeleton className="h-4 w-full max-w-[8rem]" />
                  </td>
                ))}
              </tr>
            ))}

          {!loading &&
            rows.map((row, i) => (
              <tr
                key={rowKey(row, i)}
                onClick={onRowClick ? () => onRowClick(row, i) : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                onKeyDown={
                  onRowClick
                    ? (event) => {
                        if (event.currentTarget !== event.target) return;
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        onRowClick(row, i);
                      }
                    : undefined
                }
                className={cn(
                  "border-b border-border/60 last:border-0",
                  // 可点行:触屏下整行撑到 44px 靶面;焦点环走 inset(行贴着表格边,外扩环会被裁)。
                  onRowClick &&
                    "cursor-pointer outline-none transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [@media(hover:none)]:h-11",
                )}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={cn(
                      "px-3 py-2.5 text-body text-fg",
                      alignClass[c.align ?? "left"],
                      c.cellClassName,
                    )}
                  >
                    {c.render
                      ? c.render(row, i)
                      : ((row as Record<string, unknown>)[c.key] as ReactNode)}
                  </td>
                ))}
              </tr>
            ))}
        </tbody>
      </table>

      {showEmpty &&
        (empty ?? <EmptyState icon={Inbox} title={emptyTitle} hint={emptyHint} />)}
    </div>
  );
}
