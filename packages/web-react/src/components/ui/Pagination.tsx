import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "../../lib/utils";
import { IconButton } from "./IconButton";

/**
 * offset/limit 分页条(与后端 `?offset=&limit=` 约定一致)。
 *  - 传 total → 精确页码 + 末页禁用;
 *  - 不传 total → 用本页 count 判末页(count < limit 即末页,keyset 分页常用)。
 *
 * 存在的理由:原本绑在 admin 的 DataTable 文件里,只有表格能用;用户侧的卡片列表
 * (市场技能、我的发布、账单)分页各写各的箭头。分页是"翻页语义"而不是"表格语义",
 * 提升到原语层后卡片列表可以直接复用。
 *
 * 触控靶不在这里补:两个箭头用的是 <IconButton/>,44px 命中面已经由该原语的 size 轴
 * 下沉(每档都带 `[@media(hover:none)]:size-11`)。本文件刻意不再手写同一条 ——
 * 这批改造的目的就是让补丁只存在于原语内部一处。
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
  /** 当前页返回的行数(用于无 total 时判末页)。 */
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
      <p className="text-meta text-faint tabular-nums">
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
