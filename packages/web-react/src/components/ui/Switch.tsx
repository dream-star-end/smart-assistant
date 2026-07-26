import * as RS from "@radix-ui/react-switch";
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "../../lib/utils";

/**
 * 开关。视觉轨道固定 24×44px(h-6 w-11)。
 *
 * 触控靶:宽度本就 44px,**高度只有 24px**,在触屏上低于 44px 命中标准。
 * 这里刻意不用 padding 撑 —— Root 自带 `data-[state]:bg-*`,padding 会被背景一起画出来,
 * 轨道视觉直接变粗;`bg-clip-content` 又会让 rounded-full 的药丸形状塌成方块。
 * 因此用**透明伪元素**把命中区上下各外扩 10px(24+20=44):伪元素随宿主参与
 * 命中测试,点击/触摸落在它身上等同点在 Root 上,而它本身不绘制任何像素。
 * 整条规则包在 `[@media(hover:none)]` 里,桌面端(含 relative)渲染零变化。
 */
export function Switch({ className, ...props }: ComponentPropsWithoutRef<typeof RS.Root>) {
  return (
    <RS.Root
      className={cn(
        "peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent outline-none transition-colors duration-150 ease-standard focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-accent data-[state=unchecked]:bg-border-strong",
        "[@media(hover:none)]:relative [@media(hover:none)]:before:absolute [@media(hover:none)]:before:inset-x-0 [@media(hover:none)]:before:-inset-y-2.5 [@media(hover:none)]:before:content-['']",
        className,
      )}
      {...props}
    >
      <RS.Thumb className="pointer-events-none block size-5 rounded-full bg-white shadow-sm ring-0 transition-transform duration-150 ease-standard data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0" />
    </RS.Root>
  );
}
