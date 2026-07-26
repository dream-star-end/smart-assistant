import { cva } from "class-variance-authority";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ProductFeatureId } from "../../lib/productCapabilities";
import { cn } from "../../lib/utils";

export interface TabItem {
  value: string;
  label: ReactNode;
  /** 顶层用户能力入口；教程契约 checker 会验证它与 catalog/action/target 的对应关系。 */
  featureId?: ProductFeatureId;
}

/** 分段容器的排布方式。scroll = 单行横滚(默认,旧行为);grid = 窄屏三列换行。 */
export type TabsLayout = "scroll" | "grid";

/**
 * 容器排布轴。
 * - scroll:单行药丸 + 横向滚动(存量行为,类名集合与改造前完全一致)。
 * - grid  :<768px 渲染成 `grid-cols-3` 自动换行的三列宫格,md 起回落单行 inline-flex。
 *   为什么必须有它:管理中心 6 个中文 tab 单行需 ~467px,而 375px 屏上容器只有 311px;
 *   容器又是 `no-scrollbar`(无滚动条)、改造前既无渐隐也无箭头 —— 末尾的「插件账号」
 *   「文献库」在手机上完全不可见,也没有任何"可以滑"的提示。这类**主导航**必须整屏可见,
 *   横滚只适用于次级/短标签场景。
 *
 * md 起用 `md:inline-flex` 覆盖基础段的 `grid` 是确定性的:Tailwind v4 把带断点变体的
 * 工具类整体排在全部无变体工具类之后(已核对 dist 产物,首个 `.md\:` 规则位于基础段尾部之后),
 * 因此断点变体恒胜出,不依赖两个 display 工具类在基础段内的相对顺序。
 */
const tabListVariants = cva("no-scrollbar gap-1 overscroll-x-contain bg-hover p-1", {
  variants: {
    layout: {
      scroll: "inline-flex max-w-full overflow-x-auto rounded-full",
      grid: "grid w-full grid-cols-3 rounded-2xl md:inline-flex md:w-auto md:max-w-full md:overflow-x-auto md:rounded-full",
    },
  },
  defaultVariants: { layout: "scroll" },
});

/**
 * 单个 tab。字号走语义档 `text-body`(13px,与改造前 `text-[13px]` 同像素,只是把任意值收进 token)。
 * 触控靶下沉进原语:改造前 `py-1.5` 只有 ~30px 高,而这是**主导航** —— 触屏下补到 ≥44px,
 * 调用方不必再逐处手写 `[@media(hover:none)]:min-h-11`(桌面端 hover 可用,渲染零变化)。
 */
const tabVariants = cva(
  "inline-flex items-center justify-center rounded-full text-body font-medium outline-none transition-colors duration-150 ease-standard focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg [@media(hover:none)]:min-h-11",
  {
    variants: {
      layout: {
        scroll: "shrink-0 whitespace-nowrap px-4 py-1.5",
        // 宫格里宽度由列决定:标签过长走省略号截断,而不是撑破列宽;md 起回到横滚形态。
        grid: "min-w-0 px-2 py-1.5 md:shrink-0 md:px-4",
      },
      active: {
        true: "bg-surface text-fg shadow-soft",
        false: "text-muted hover:text-fg",
      },
    },
    defaultVariants: { layout: "scroll", active: false },
  },
);

/** 可滚动方向 → 边缘渐隐遮罩:在没有滚动条的容器上,让"还有内容"这件事可见。 */
const EDGE_MASK: Record<string, string | undefined> = {
  none: undefined,
  right: "linear-gradient(to right, #000 calc(100% - 28px), transparent)",
  left: "linear-gradient(to left, #000 calc(100% - 28px), transparent)",
  both: "linear-gradient(to right, transparent, #000 28px, #000 calc(100% - 28px), transparent)",
};

/**
 * 无障碍分段 Tabs(WAI-ARIA tablist)。受控:value 由调用方持有。
 * 容器 role=tablist + aria-orientation=horizontal,每项 role=tab + aria-selected;
 * roving tabindex(选中项可 Tab 聚焦,其余 -1)+ 左右 / Home / End 键盘导航。
 * 面板由调用方按 value 条件渲染,本组件只管 tablist。视觉为分段药丸(segmented)。
 *
 * ── 本次下沉进原语的四个真实缺陷 ─────────────────────────────────────
 * 1. 窄屏溢出不可见:见 tabListVariants 注释(新增 layout="grid")。
 * 2. 外部改 value 时选中项可能在视口外(OAuth 回跳直接切 tab),用户看到"所有 tab 都没选中"
 *    的迷惑态 —— 现在选中项会自动 scrollIntoView 居中,并给横滚容器加边缘渐隐。
 * 3. ArrowUp/ArrowDown 被劫持:横向 tablist 上按 ↓ 的用户意图是滚页而不是切 tab
 *    (WAI-ARIA 也只为 horizontal tablist 规定左右键)。已移除上下键分支。
 * 4. 悬空 aria-controls:`idBase` 一度给**每个** tab 都落 `aria-controls`,而调用方普遍
 *    只渲染当前面板(`{tab === 'x' && <Panel/>}`),于是未选中的 tab 全部指向不存在的节点。
 *    面板挂没挂只有调用方知道、原语无从验证 —— 故把它变成**由调用方声明**的输入
 *    (`mountedPanels`),默认取"只有选中项的面板挂载"这个仓内实况。与 SkillsPanel /
 *    DetailModal 的既有约定同构:「面板没挂就不落 aria-controls,指向不存在的节点
 *    在读屏上是静默失败」。机器验收见 test/ariaControls.ts 的通用不变量。
 */
export function Tabs({
  value,
  onValueChange,
  items,
  layout = "scroll",
  idBase,
  mountedPanels,
  className,
  "aria-label": ariaLabel,
}: {
  value: string;
  onValueChange: (v: string) => void;
  items: TabItem[];
  /** 排布方式。默认 scroll = 改造前行为;主导航(≥4 个中文 tab)应改用 grid。 */
  layout?: TabsLayout;
  /**
   * 给每个 tab 派生稳定的 `id` 与 `aria-controls`(`${idBase}-tab-<value>` /
   * `${idBase}-panel-<value>`)。调用方把 `${idBase}-panel-<value>` 挂到自己的面板节点上,
   * 辅助技术才能在 tab ↔ 面板之间建立关联。不传则两个属性都不落(向后兼容)。
   */
  idBase?: string;
  /**
   * 此刻**真的在 DOM 里**的面板 value 集合(只在 idBase 存在时有意义):
   * 只有列进来的 tab 才会落 `aria-controls`,其余的不落 —— 悬空 IDREF 比没有更糟。
   *
   * 不传 = `[value]`,即"只渲染当前面板"这一仓内最普遍的形态(ManageCenter /
   * MarketplaceCenter / MemoryPanel / PublishPanel 都是它)。
   * - 常挂全部面板(非当前项 `hidden`)→ 传全部 value;
   * - 惰性挂载并保活(SkillEditor 的评测/训练)→ 传 `已访问 ∪ 常挂` 的实际集合;
   * - 加载态/错误态下一个面板都没渲染 → 传 `[]`。
   */
  mountedPanels?: readonly string[];
  className?: string;
  "aria-label"?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [edge, setEdge] = useState<"none" | "left" | "right" | "both">("none");
  // items 每次渲染都是新数组(调用方普遍写 TABS.map(...)),故用值序列做依赖键;
  // 直接依赖 items 会让下面两个 effect 每帧重跑。选中下标同理在渲染期算好,
  // effect 里就不必再引用 items 本身。
  const itemsKey = items.map((it) => it.value).join(" ");
  const activeIndex = items.findIndex((it) => it.value === value);

  const syncEdge = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const next =
      max <= 1 ? "none" : el.scrollLeft <= 1 ? "right" : el.scrollLeft >= max - 1 ? "left" : "both";
    setEdge((cur) => (cur === next ? cur : next));
  }, []);

  // "能不能滚"同时取决于容器宽度和 tab 集合,所以用 ResizeObserver,而不是只监听 scroll。
  // ResizeObserver 只报被观测元素**自身**的尺寸变化 —— tab 增删导致的内容宽度变化不会触发,
  // 故 itemsKey / layout 必须进依赖重新测量(Biome 眼里是"多余依赖",实际是本 effect 的触发源)。
  // biome-ignore lint/correctness/useExhaustiveDependencies: itemsKey/layout 是重新测量的触发器,ResizeObserver 覆盖不到内容宽度变化
  useEffect(() => {
    syncEdge();
    const el = listRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(syncEdge);
    ro.observe(el);
    return () => ro.disconnect();
  }, [syncEdge, itemsKey, layout]);

  // 受控 value 变化 → 把选中项滚进视口中央。容器不可滚时直接跳过:既省事,也避免
  // scrollIntoView 顺带滚动祖先滚动容器(整页跳动的经典来源)。
  // biome-ignore lint/correctness/useExhaustiveDependencies: itemsKey 同上,tab 集合换了也要把选中项摆回视口
  useEffect(() => {
    const list = listRef.current;
    if (!list || list.scrollWidth - list.clientWidth <= 1) return;
    const el = activeIndex >= 0 ? refs.current[activeIndex] : null;
    if (!el || typeof el.scrollIntoView !== "function") return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    el.scrollIntoView({ inline: "center", block: "nearest", behavior: reduced ? "auto" : "smooth" });
  }, [activeIndex, itemsKey]);

  const onKeyDown = (e: KeyboardEvent, idx: number) => {
    const last = items.length - 1;
    let next = -1;
    // 横向 tablist 只接管左右 / Home / End;上下键留给页面滚动。
    if (e.key === "ArrowRight") next = idx === last ? 0 : idx + 1;
    else if (e.key === "ArrowLeft") next = idx === 0 ? last : idx - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    if (next === -1) return;
    e.preventDefault();
    onValueChange(items[next].value);
    refs.current[next]?.focus();
  };

  const mask = EDGE_MASK[edge];
  // 遮罩是随滚动位置变化的动态值,走行内 style(而非动态拼类名 —— Tailwind 扫不到拼接出来的
  // 类);同时带 -webkit- 前缀:unprefixed mask-image 到 Chrome 120 才支持,现役鸿蒙/Quark
  // 内核(Chromium 108 一线)只认前缀版。
  const maskStyle: CSSProperties | undefined = mask
    ? { maskImage: mask, WebkitMaskImage: mask }
    : undefined;

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      onScroll={syncEdge}
      style={maskStyle}
      className={cn(tabListVariants({ layout }), className)}
    >
      {items.map((it, i) => {
        const active = it.value === value;
        // 面板真的挂载了才落 aria-controls(默认只有选中项挂载)。见组件头注释第 4 条。
        const panelMounted = mountedPanels ? mountedPanels.includes(it.value) : active;
        return (
          <button
            key={it.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={idBase ? `${idBase}-tab-${it.value}` : undefined}
            aria-controls={idBase && panelMounted ? `${idBase}-panel-${it.value}` : undefined}
            data-product-feature={it.featureId}
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onValueChange(it.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(tabVariants({ layout, active }))}
          >
            {/* 宫格模式下列宽固定,需要一个可截断的块级容器承载省略号;
                scroll 模式保持原样直接渲染 label,DOM 与改造前一致。 */}
            {layout === "grid" ? <span className="min-w-0 truncate">{it.label}</span> : it.label}
          </button>
        );
      })}
    </div>
  );
}
