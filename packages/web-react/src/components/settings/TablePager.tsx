import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "../../lib/utils";
import { IconButton } from "../ui";

/**
 * 表格 / 列表的**客户端**分页条(整份数据已在内存里,只切片展示)。
 *
 * 为什么不用 `ui/Pagination`:那个原语是 offset/limit 的**服务端**分页语义
 * (`onChange(nextOffset)` + 用本页 count 判末页),给的是「1–10 / 共 N」条目区间;
 * 这里要的是「第 x/y 页」的纯本地翻页,而且同一个面板里会同时出现三四个分页条
 * (按密钥 / 按模型 / 密钥列表),必须能靠 `label` 把 aria-label 区分开,否则
 * getByRole("button", { name: "上一页" }) 会一次命中多个、可访问性上也读不出翻的是哪张表。
 *
 * 只有一页(或空)时**整条不渲染** —— 十行以内的表下面挂一条永远禁用的翻页控件是噪音。
 * 不引入任何新依赖,箭头沿用 lucide + `ui/IconButton`(触控靶 44px 已在原语内下沉)。
 */
export const TABLE_PAGE_SIZE = 10;

/** 总行数 → 页数(0 行算 1 页,避免出现「第 1/0 页」)。 */
export function pageCountOf(total: number, pageSize: number = TABLE_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
}

/** 取第 page 页(0-based)的切片;page 越界时按边界夹紧,不返回空数组。 */
export function pageSlice<T>(rows: T[], page: number, pageSize: number = TABLE_PAGE_SIZE): T[] {
  const size = Math.max(1, pageSize);
  const clamped = Math.min(Math.max(0, page), pageCountOf(rows.length, size) - 1);
  return rows.slice(clamped * size, clamped * size + size);
}

/**
 * 本地分页 state。行数组换掉(切窗口 / 换 key 过滤 / 撤销一把 key)后当前页可能越界,
 * 这里统一夹回最后一页 —— 否则用户停在第 3 页时数据缩到 5 行,表会渲染成空白。
 */
export function useTablePage<T>(
  rows: T[],
  pageSize: number = TABLE_PAGE_SIZE,
): { page: number; pageCount: number; pageRows: T[]; setPage: (p: number) => void } {
  const [page, setPage] = useState(0);
  const pageCount = pageCountOf(rows.length, pageSize);
  useEffect(() => {
    if (page > pageCount - 1) setPage(pageCount - 1);
  }, [page, pageCount]);
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = useMemo(() => pageSlice(rows, safePage, pageSize), [rows, safePage, pageSize]);
  return { page: safePage, pageCount, pageRows, setPage };
}

/** 「上一页 / 第 x/y 页 / 下一页」。pageCount ≤ 1 时不渲染。 */
export function TablePager({
  page,
  pageCount,
  onPageChange,
  label,
  className,
}: {
  /** 0-based。 */
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  /** 用于区分同页多个分页条的可读名称(如「按模型」)。 */
  label: string;
  className?: string;
}) {
  if (pageCount <= 1) return null;
  return (
    <div
      className={cn("flex items-center justify-end gap-1 pt-2", className)}
      data-testid={`pager-${label}`}
    >
      <span className="mr-1 text-caption text-faint tabular-nums">
        第 {page + 1}/{pageCount} 页
      </span>
      <IconButton
        size="sm"
        shape="square"
        disabled={page <= 0}
        onClick={() => onPageChange(page - 1)}
        title={`${label}·上一页`}
        aria-label={`${label}·上一页`}
      >
        <ChevronLeft size={16} />
      </IconButton>
      <IconButton
        size="sm"
        shape="square"
        disabled={page >= pageCount - 1}
        onClick={() => onPageChange(page + 1)}
        title={`${label}·下一页`}
        aria-label={`${label}·下一页`}
      >
        <ChevronRight size={16} />
      </IconButton>
    </div>
  );
}
