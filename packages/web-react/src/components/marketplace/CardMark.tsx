import type { CSSProperties } from "react";
import { cn } from "../../lib/utils";

/**
 * 市场条目的识别标：按分类着色的首字方块（UI-SPEC §5 UI-5，体验官 M4「所有插件同一个米色插头图标」）。
 *
 * 底色和字色都从 iUI 的数据色（`--iui-c1..c6`，明暗主题各一档）混出来：它们是给「区分类别」用的，
 * 不是状态色，不会和 success / warning / danger 撞义。没有分类时退回中性灰。纯装饰，名字就在旁边，
 * 所以 aria-hidden。
 */
const CATEGORY_HUE: Record<string, string> = {
  "office-docs": "var(--iui-c5)",
  "data-analysis": "var(--iui-c2)",
  "coding-dev": "var(--iui-c6)",
  "research-academic": "var(--iui-c1)",
  "design-creative": "var(--iui-c4)",
  "finance-business": "var(--iui-c3)",
  "skill-pack": "var(--iui-c2)",
};

/**
 * 平台预装插件（飞书 / GitHub / Notion / WebDAV）不是市场条目，没有 listing 分类；
 * 市场「插件」类目和管理中心插件列表都按这张表给它们分类，两处颜色一致。
 */
export const BUILTIN_PLUGIN_CATEGORY: Record<string, string> = {
  github: "coding-dev",
  notion: "office-docs",
  feishu: "office-docs",
  webdav: "office-docs",
};

/** 方块里的字：名字的第一个字（拉丁字母转大写）。 */
export function markGlyph(name: string): string {
  return (Array.from(name.trim())[0] ?? "?").toUpperCase();
}

export function CardMark({
  name,
  category,
  size = "md",
  className,
}: {
  name: string;
  category?: string | null;
  /** md = 40px（卡片、列表行）；lg = 44px（详情页标题）。 */
  size?: "md" | "lg";
  className?: string;
}) {
  const hue = category ? CATEGORY_HUE[category] : undefined;
  return (
    <span
      aria-hidden="true"
      data-category={category ?? undefined}
      style={hue ? ({ "--mark-hue": hue } as CSSProperties) : undefined}
      className={cn(
        "flex shrink-0 select-none items-center justify-center rounded-md font-semibold",
        size === "lg" ? "size-11 text-title" : "size-10 text-section",
        hue
          ? "bg-[color:color-mix(in_srgb,var(--mark-hue)_14%,var(--surface))] text-[color:color-mix(in_srgb,var(--mark-hue)_70%,var(--fg))]"
          : "bg-hover text-muted",
        className,
      )}
    >
      {markGlyph(name)}
    </span>
  );
}
