import { Search } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn, groupDigits } from "../../lib/utils";
import { Badge } from "./Badge";
import { Input } from "./Input";

export interface ToolbarProps {
  /** 分区标题。 */
  title?: ReactNode;
  /** 条目总数;传 null/undefined 则不显示计数徽章。 */
  count?: number | null;
  /** 受控搜索词(权威在调用方)。传了 onSearchChange 才渲染搜索框。 */
  search?: string;
  /** 防抖后的搜索回调。 */
  onSearchChange?: (v: string) => void;
  searchPlaceholder?: string;
  /** 防抖窗口。列表本地过滤可调小,走网络请求的保持默认。 */
  debounceMs?: number;
  /** 过滤器插槽(SelectFilter / 状态药丸 / 排序等)。 */
  filters?: ReactNode;
  /** 右侧主操作插槽(新建 / 刷新 / 批量)。 */
  actions?: ReactNode;
  /** 默认吸顶。放进非滚动容器时传 false。 */
  sticky?: boolean;
  className?: string;
}

/**
 * 长列表面板的统一工具条:标题 + 计数 + 搜索 + 过滤 + 操作,内建吸顶与搜索防抖。
 *
 * 存在的理由:管理中心与市场有 7 个长列表面板**完全没有检索/计数/排序** ——
 * 用户翻到第 60 条只能靠滚,也不知道总共有多少条。而已经做了检索的几处,防抖逻辑
 * (草稿态 + 外部值同步 + 定时器清理)是各写一遍的,admin/FilterBar 里那份最完整。
 * 这里把那份逻辑收进原语:调用方只给受控值和回调,不再自己管 setTimeout。
 *
 * 搜索框刻意不覆盖 Input 的 `text-base md:text-sm` —— 那是防 iOS Safari 在输入框
 * 字号 <16px 时放大整页且不回弹的专门设计,任何"看着太大"的顺手改小都会击穿它。
 */
export function Toolbar({
  title,
  count,
  search,
  onSearchChange,
  searchPlaceholder = "搜索…",
  debounceMs = 250,
  filters,
  actions,
  sticky = true,
  className,
}: ToolbarProps) {
  const value = search ?? "";
  const [draft, setDraft] = useState(value);
  // 外部权威值变化(重置/深链)→ 同步草稿,避免草稿盖过外部。
  useEffect(() => {
    setDraft(value);
  }, [value]);
  // 草稿防抖回传;draft === value 时不回调(含外部同步那一拍)。
  const onChangeRef = useRef(onSearchChange);
  onChangeRef.current = onSearchChange;
  useEffect(() => {
    if (draft === value) return;
    const t = setTimeout(() => onChangeRef.current?.(draft), debounceMs);
    return () => clearTimeout(t);
  }, [draft, value, debounceMs]);

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 border-b border-border bg-surface px-4 py-2.5",
        sticky && "sticky top-0 z-10",
        className,
      )}
    >
      {(title || count != null) && (
        <div className="flex min-w-0 shrink-0 items-center gap-1.5">
          {title && <h3 className="truncate text-section font-semibold text-fg">{title}</h3>}
          {count != null && <Badge size="sm">{groupDigits(String(count))}</Badge>}
        </div>
      )}

      {onSearchChange && (
        <div className="relative min-w-0 flex-1 sm:max-w-64">
          <Search
            size={15}
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
          />
          <Input
            // type=search 让浏览器给出原生清除按钮 —— 自绘一个 ✕ 在触屏上要占满
            // 44px 靶区,会把 40px 高的输入框整个撑破,原生控件是更省的解。
            type="search"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label={typeof title === "string" ? `搜索${title}` : searchPlaceholder}
            // 触控靶不在这里补:Input 的 controlSurfaceClass 自带
            // `[@media(hover:none)]:min-h-11`,调用方再补一遍就是本批要消灭的那种补丁。
            className="w-full pl-9"
          />
        </div>
      )}

      {filters && <div className="flex flex-wrap items-center gap-1.5">{filters}</div>}
      {actions && <div className="ms-auto flex shrink-0 items-center gap-1.5">{actions}</div>}
    </div>
  );
}
