import { Check, ChevronDown, Search } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
} from "../../components/ui";
import { cn } from "../../lib/utils";

/** 过滤区容器：把 SearchInput / SelectFilter / RangePreset 横向组合，窄屏自动换行。 */
export function FilterBar({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>{children}</div>
  );
}

/**
 * 防抖搜索框。受控 value，用户停止输入 debounceMs 后才回调 onChange（省去每键一次请求）。
 * 外部 value 变化（如重置）即时同步进内部草稿。
 */
export function SearchInput({
  value,
  onChange,
  placeholder = "搜索…",
  debounceMs = 300,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  debounceMs?: number;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  // 外部权威值变化（重置/深链）→ 同步草稿，避免草稿盖过外部。
  useEffect(() => {
    setDraft(value);
  }, [value]);
  // 草稿防抖回传；draft===value 时不回调（含外部同步那一拍）。
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    if (draft === value) return;
    const t = setTimeout(() => onChangeRef.current(draft), debounceMs);
    return () => clearTimeout(t);
  }, [draft, debounceMs, value]);

  return (
    <div className={cn("relative", className)}>
      <Search
        size={15}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
      />
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={placeholder}
        // 两处刻意不写:
        // 1. 字号 —— Input 自带 `text-base md:text-sm`(移动端 ≥16px 防 iOS 聚焦缩放),
        //    这里原先硬写 text-sm 会把这道防线击穿;
        // 2. 触控靶 —— Input 的 controlSurfaceClass 已带 `[@media(hover:none)]:min-h-11`,
        //    min-height 会盖过这里的 h-9,调用方不必再补。
        className="h-9 w-full pl-9 sm:w-56"
      />
    </div>
  );
}

export type SelectOption<V extends string = string> = { label: ReactNode; value: V };

/** 单选下拉过滤（DropdownMenu 风格，与全仓菜单一致）。 */
export function SelectFilter<V extends string = string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  /** 前缀标签（如「状态」），显示为「状态：<当前项>」。 */
  label?: string;
  value: V;
  options: SelectOption<V>[];
  onChange: (v: V) => void;
  className?: string;
}) {
  const current = options.find((o) => o.value === value);
  return (
    <DropdownMenu>
      {/* 触发器触控靶不在这里补:Button 的 sm 档已带 `[@media(hover:none)]:min-h-11`。
          注意 asChild 走 Children.only,槽位里只能有这一个元素。 */}
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="sm" className={cn("gap-1.5", className)}>
          {label && <span className="text-faint">{label}</span>}
          <span className="max-w-[10rem] truncate text-fg">{current?.label ?? "全部"}</span>
          <ChevronDown size={14} className="text-faint" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {options.map((o) => (
          <DropdownMenuItem
            key={o.value}
            onSelect={() => onChange(o.value)}
            className="justify-between"
          >
            <span className="truncate">{o.label}</span>
            {o.value === value && <Check size={15} className="shrink-0 text-accent" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export type RangeOption = { label: string; value: number };
const DEFAULT_RANGES: RangeOption[] = [
  { label: "7 天", value: 7 },
  { label: "30 天", value: 30 },
];

/** 时间档位分段控件（默认 7d / 30d）。value=天数。 */
export function RangePreset({
  value,
  onChange,
  options = DEFAULT_RANGES,
  className,
}: {
  value: number;
  onChange: (days: number) => void;
  options?: RangeOption[];
  className?: string;
}) {
  return (
    <div
      className={cn("inline-flex items-center gap-0.5 rounded-lg border border-border bg-surface p-0.5", className)}
      role="group"
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            className={cn(
              "rounded-md px-2.5 py-1 text-meta font-medium transition-colors",
              "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
              "[@media(hover:none)]:min-h-11 [@media(hover:none)]:px-3",
              active ? "bg-accent-soft text-accent" : "text-muted hover:bg-hover hover:text-fg",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
