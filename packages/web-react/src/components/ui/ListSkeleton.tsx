import { cn } from "../../lib/utils";
import { Card } from "./Card";
import { useQuiet } from "./Quiet";
import { Skeleton } from "./Skeleton";

/**
 * 列表 / 卡片网格的加载骨架。
 *
 * 存在的理由:10 个面板的加载态是"一个居中的 Spinner" —— 切 Tab 时用户看到的是
 * 700px 高的空白加中间一个圈,既读不出"这里将出现什么",也让首屏高度在数据到达时
 * 猛跳一下。骨架屏两个问题一起解决:占住真实布局 + 预告内容形状。
 *
 * 结构照搬 marketplace/BrowsePanel 已经跑在线上的那套(图标槽 + 两行文字条 + 徽章条),
 * 容器直接用 Card 原语,不再手抄 `rounded-xl border border-border bg-surface`。
 */

/** 各行宽度轮换 —— 等长色块看着像表格,长短交替才像真实文案。 */
const ROW_WIDTHS = [
  ["w-2/5", "w-4/5"],
  ["w-1/3", "w-3/5"],
  ["w-1/2", "w-5/6"],
] as const;

/** 图标槽 + 主名条 + 说明条,row / card 两种形态共用的头部。 */
function SkeletonHead({ titleW, descW }: { titleW: string; descW: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <Skeleton className="size-8 shrink-0 rounded-lg" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Skeleton className={cn("h-3.5", titleW)} />
        <Skeleton className={cn("h-3", descW)} />
      </div>
    </div>
  );
}

export function ListSkeleton({
  rows = 5,
  variant = "row",
  className,
}: {
  /** 骨架条数。取面板首屏大致可见的行数即可,不必等于真实数据量。 */
  rows?: number;
  /** row = 单列列表行;card = 双列卡片网格(市场那种)。 */
  variant?: "row" | "card";
  className?: string;
}) {
  const items = Array.from({ length: Math.max(0, rows) }, (_, i) => i);
  const quiet = useQuiet();
  if (quiet && variant === "row") {
    // 安静表面:骨架与真实列表同一几何 —— 一个分组容器 + 发丝线,行内只有标题条与元信息条,
    // 没有图标方块(真实行也没有),数据到达时不跳版。
    return (
      <output
        aria-busy="true"
        className={cn("oc-list block overflow-hidden rounded-[10px] border border-border", className)}
      >
        <span className="sr-only">加载中…</span>
        {items.map((i) => {
          const [titleW, descW] = ROW_WIDTHS[i % ROW_WIDTHS.length];
          return (
            <div key={i} className="oc-list-row flex min-h-12 flex-col justify-center gap-2 px-4 py-3.5">
              <Skeleton className={cn("h-3", titleW)} />
              <Skeleton className={cn("h-2.5 opacity-70", descW)} />
            </div>
          );
        })}
      </output>
    );
  }
  return (
    // <output>(隐含 role=status)+ sr-only 文案:骨架本身对读屏是噪音(每个 Skeleton
    // 都 aria-hidden),但"正在加载"这件事必须播报,否则读屏用户只听到一片沉默。
    // 用 <output> 而非 div[role=status] 是跟随仓内既有写法(AuthGate / ContainerWebPreview)。
    <output
      aria-busy="true"
      className={cn(
        variant === "card" ? "grid grid-cols-1 gap-2.5 sm:grid-cols-2" : "flex flex-col gap-1.5",
        className,
      )}
    >
      <span className="sr-only">加载中…</span>
      {items.map((i) => {
        const [titleW, descW] = ROW_WIDTHS[i % ROW_WIDTHS.length];
        return variant === "card" ? (
          <Card key={i} padding="md" className="flex flex-col gap-2.5">
            <SkeletonHead titleW={titleW} descW={descW} />
            <div className="flex gap-1.5">
              <Skeleton className="h-4 w-12 rounded-full" />
              <Skeleton className="h-4 w-16 rounded-full" />
            </div>
          </Card>
        ) : (
          <Card key={i} padding="sm">
            <SkeletonHead titleW={titleW} descW={descW} />
          </Card>
        );
      })}
    </output>
  );
}
