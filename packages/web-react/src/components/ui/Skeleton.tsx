import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

/**
 * 加载占位骨架。形状(高/宽/圆角)由调用方用 className 控制。
 *
 * 2026-07-26 两处修复：
 * 1) 底色 bg-hover → bg-skeleton。--hover 是 4% 墨,合成到白底后对比度 ≈1.05:1 ——
 *    浅色主题下骨架屏其实是**隐形**的,用户看到的就是一片白屏。
 * 2) animate-pulse → 扫光 shimmer,复用 styles.css 里 `.oc-img-skeleton` 的
 *    `oc-shimmer` keyframe。**刻意不直接套 .oc-img-skeleton 这个类**:那条规则在
 *    styles.css 里是未分层的裸类,而 Tailwind 工具类都在 utilities 层,层叠规则里
 *    未分层胜过分层 —— 套上去它自带的 `background: var(--hover)` 会反过来顶掉
 *    bg-skeleton,骨架又变回隐形。所以只复用 keyframe,底色权威留在 token。
 *
 * 扫光颜色直接取 --active 这个"半透明墨"token:它本身随主题翻转(浅色=8% 黑、
 * 深色=10% 白),所以浅色下是深色波、深色下是浅色波,一个写法两个主题都读得出
 * —— 本仓没有配 Tailwind 的 `dark:` 变体,不能按主题分支写样式。
 * 刻意**不用 color-mix()**:Tailwind 会为不支持它的浏览器额外emit 一条降级规则,
 * 把混色整个丢掉只留原色,扫光会退化成一条**不透明墨色带**横扫过去(实测构建产物确认)。
 * prefers-reduced-motion 由 styles.css 的全局规则统一压到 0.01ms,此处无需再判。
 */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md bg-skeleton",
        "after:absolute after:inset-0 after:content-[''] after:[transform:translateX(-100%)]",
        "after:bg-[linear-gradient(90deg,transparent,var(--active),transparent)]",
        "after:animate-[oc-shimmer_1.4s_ease-in-out_infinite]",
        className,
      )}
      aria-hidden="true"
      {...props}
    />
  );
}
