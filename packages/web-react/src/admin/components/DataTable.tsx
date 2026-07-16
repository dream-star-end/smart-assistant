import { ChevronLeft, ChevronRight, Inbox } from "lucide-react";
import type { ReactNode } from "react";
import { EmptyState, IconButton, Skeleton } from "../../components/ui";
import { cn } from "../../lib/utils";

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
                  "whitespace-nowrap px-3 py-2.5 text-[12px] font-medium text-faint",
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
                  onRowClick &&
                    "cursor-pointer outline-none transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                )}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={cn(
                      "px-3 py-2.5 text-[13px] text-fg",
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

/**
 * offset/limit 分页条（与后端 `?offset=&limit=` 约定一致）。
 *  - 传 total → 精确页码 + 末页禁用；
 *  - 不传 total → 用本页 count 判末页（count < limit 即末页，keyset 分页常用）。
 */
export function Pagination({
  offset,
  limit,
  count,
  total,
  onChange,
  className,
}: {
  offset: number;
  limit: number;
  /** 当前页返回的行数（用于无 total 时判末页）。 */
  count: number;
  total?: number;
  onChange: (nextOffset: number) => void;
  className?: string;
}) {
  const atStart = offset <= 0;
  const atEnd = total !== undefined ? offset + limit >= total : count < limit;
  const from = count === 0 ? 0 : offset + 1;
  const to = offset + count;

  return (
    <div className={cn("flex items-center justify-between gap-3 px-1 py-2", className)}>
      <p className="text-[12px] text-faint tabular-nums">
        {total !== undefined ? `${from}–${to} / 共 ${total}` : `${from}–${to}`}
      </p>
      <div className="flex items-center gap-1">
        <IconButton
          size="sm"
          shape="square"
          disabled={atStart}
          onClick={() => onChange(Math.max(0, offset - limit))}
          title="上一页"
          aria-label="上一页"
        >
          <ChevronLeft size={16} />
        </IconButton>
        <IconButton
          size="sm"
          shape="square"
          disabled={atEnd}
          onClick={() => onChange(offset + limit)}
          title="下一页"
          aria-label="下一页"
        >
          <ChevronRight size={16} />
        </IconButton>
      </div>
    </div>
  );
}
