import { type ReactNode, useEffect, useLayoutEffect, useRef } from "react";
import { cn } from "../lib/utils";

/**
 * 输入预测(OCV5-375)的浅色字浮层,由 Composer 按需加载(不进首屏包)。
 * 与 textarea 同字号、同行高、同内边距地叠在它上面:已输入部分透明占位,预测接在后面。
 * 只管显示:不带「填入」/「Tab」标记。空输入框时直接点发送就发出这句(Composer 的 submit),
 * 键盘 Tab / → 填入后再改、Esc 收起都在 Composer 的 onKeyDown 里处理。
 */
export default function ComposerPrediction({
  value,
  rest,
  large,
  hintId,
  onShown,
}: {
  value: string;
  /** 接在正文后面显示的部分。 */
  rest: string;
  large: boolean;
  /** textarea 和发送按钮的 aria-describedby 指向这里的读屏提示。 */
  hintId: string;
  /**
   * 报告正在显示的预测和浮层高度:Composer 按高度撑开输入框(整句预测比空输入框长时会折行),
   * 并且只有真的显示出来的整句预测才允许被发送 —— 浮层加载失败时用户看不到的字不会被发出去。
   */
  onShown: (rest: string, px: number) => void;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  // 只在内容变化时同步量一次;宽度、字体等变化交给 ResizeObserver(异步回调)。不能每次渲染都报:
  // 回答结束后页面空闲时也会被计时器反复重渲,每次都在 commit 里给 Composer 排同步更新,
  // React 把它们算作嵌套更新,累计 50 次就抛 #185 整页白屏(round 2 线上事故)。
  // biome-ignore lint/correctness/useExhaustiveDependencies: value / large 是重新量高的触发器(改变浮层里的字和字号);ResizeObserver 只看盒子尺寸,看不到内容溢出。
  useLayoutEffect(() => {
    onShown(rest, ref.current?.scrollHeight ?? 0);
  }, [rest, value, large, onShown]);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => onShown(rest, el.scrollHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [rest, onShown]);
  return (
    <div
      ref={ref}
      data-testid="composer-prediction"
      className={cn(
        "pointer-events-none absolute inset-y-0 left-1 right-1 overflow-hidden whitespace-pre-wrap break-words py-1.5 leading-relaxed",
        large ? "text-[17.5px]" : "text-[16px]",
      )}
    >
      <span aria-hidden="true" className="invisible">
        {value}
      </span>
      <span aria-hidden="true" className="text-faint">
        {rest}
      </span>
      <span id={hintId} className="sr-only">
        {value === ""
          ? `输入预测：${rest}。直接发送就发出这句；按 Tab 填入后可以修改。`
          : `输入预测：${value}${rest}。按 Tab 补全。`}
      </span>
    </div>
  );
}
