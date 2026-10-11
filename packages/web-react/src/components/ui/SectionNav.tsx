import { type KeyboardEvent, type ReactNode, useRef } from "react";
import type { ProductFeatureId } from "../../lib/productCapabilities";
import { cn } from "../../lib/utils";

export type SectionNavItem<T extends string> = {
  id: T;
  label: string;
  featureId?: ProductFeatureId;
};

/**
 * 大弹窗(设置中心 / 管理中心)桌面左侧的分区导航:168px 纯文字列表,选中 = 中性填充。
 *
 * 为什么抽出来(OCV5-362):管理中心第 3/4 轮另做了一套导航(220px 染色侧栏 + 图标 + 强调短条),
 * 与设置中心并排打开时像两个产品 —— 运营原话「和 v5 个人版的整体样式很割裂」。两处共用这一份,
 * 以后改一处两处同变,不会再漂开。
 *
 * a11y:role=tablist(竖排)+ roving tabindex,↑/↓/Home/End;tab id = `${idBase}-${id}`,
 * 只有选中项落 aria-controls = `${panelIdBase}-${id}`(其余面板未挂载,不留悬空引用)。
 */
export function SectionNav<T extends string>({
  value,
  onChange,
  groups,
  idBase,
  panelIdBase,
  "aria-label": ariaLabel,
  footer,
  className,
}: {
  value: T;
  onChange: (id: T) => void;
  groups: { label: string; items: SectionNavItem<T>[] }[];
  /** tab 的 id 前缀,如 `settings-nav` → `settings-nav-account`。 */
  idBase: string;
  /** 面板 id 前缀,如 `settings-panel`。 */
  panelIdBase: string;
  "aria-label": string;
  /** 导航底部的附加入口(如管理中心「去市场添加」),在 tablist 之外。 */
  footer?: ReactNode;
  className?: string;
}) {
  const ids = groups.flatMap((g) => g.items.map((s) => s.id));
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = ids.indexOf(value);
    if (index < 0) return;
    let next = -1;
    if (event.key === "ArrowDown") next = (index + 1) % ids.length;
    else if (event.key === "ArrowUp") next = (index - 1 + ids.length) % ids.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = ids.length - 1;
    if (next < 0) return;
    event.preventDefault();
    onChange(ids[next]!);
    refs.current[next]?.focus();
  };

  return (
    <div className={cn("flex w-[168px] shrink-0 flex-col border-r border-border", className)}>
      <div
        role="tablist"
        aria-label={ariaLabel}
        aria-orientation="vertical"
        onKeyDown={onKeyDown}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2"
      >
        {groups.map((group) => (
          <div key={group.label}>
            {/* 只有一个分组时分组标题是多余层级(审计 SET-41);多组才需要区分。 */}
            {groups.length > 1 ? (
              <div className="px-2.5 pb-1 pt-3 text-meta font-medium uppercase tracking-wide text-faint">
                {group.label}
              </div>
            ) : (
              <div className="pt-1" aria-hidden />
            )}
            {group.items.map((it) => {
              const selected = it.id === value;
              const index = ids.indexOf(it.id);
              return (
                <button
                  key={it.id}
                  ref={(el) => {
                    refs.current[index] = el;
                  }}
                  type="button"
                  role="tab"
                  id={`${idBase}-${it.id}`}
                  aria-controls={selected ? `${panelIdBase}-${it.id}` : undefined}
                  aria-selected={selected}
                  tabIndex={selected ? 0 : -1}
                  data-product-feature={it.featureId}
                  onClick={() => onChange(it.id)}
                  className={cn(
                    "flex w-full rounded-md px-2.5 py-1.5 text-left text-body outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    selected ? "bg-active text-fg" : "text-muted hover:bg-hover hover:text-fg",
                  )}
                >
                  {it.label}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {footer && <div className="shrink-0 border-t border-border p-2">{footer}</div>}
    </div>
  );
}
