import { useLayoutEffect, useRef } from "react";
import { cn } from "../lib/utils";

/**
 * 输入预测(OCV5-375)的浅色字浮层,由 Composer 按需加载(不进首屏包)。
 * 与 textarea 同字号、同行高、同内边距地叠在它上面:已输入部分透明占位,预测接在后面。
 * 键盘(Tab / → / Esc)在 Composer 的 onKeyDown 里处理,这里只管显示和触屏的「填入」按钮。
 */
export default function ComposerPrediction({
  value,
  rest,
  large,
  coarsePointer,
  hintId,
  onAccept,
  onHeight,
}: {
  value: string;
  /** 接在正文后面显示的部分。 */
  rest: string;
  large: boolean;
  coarsePointer: boolean;
  /** textarea 的 aria-describedby 指向这里的读屏提示。 */
  hintId: string;
  onAccept: () => void;
  /** 浮层高度:整句预测比空输入框长时会折行,Composer 按它撑开输入框。 */
  onHeight: (px: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    onHeight(ref.current?.scrollHeight ?? 0);
  });
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
      {/* 触屏没有 Tab 键:同一个位置给一个「填入」按钮。不进 Tab 序列,不抢输入框焦点。 */}
      <button
        type="button"
        tabIndex={-1}
        aria-label="采用输入预测"
        data-testid="composer-prediction-accept"
        onPointerDown={(e) => e.preventDefault()}
        onClick={onAccept}
        className="pointer-events-auto ml-2 inline-flex h-5 -translate-y-px items-center rounded-md border border-border px-1.5 align-middle text-[11px] font-medium leading-none text-faint transition-colors hover:bg-hover hover:text-fg"
      >
        {coarsePointer ? "填入" : "Tab"}
      </button>
      <span id={hintId} className="sr-only">
        {`输入预测：${value}${rest}。按 Tab 采用。`}
      </span>
    </div>
  );
}
