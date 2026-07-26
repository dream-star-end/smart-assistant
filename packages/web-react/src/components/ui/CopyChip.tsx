import { Check, Copy } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { Tooltip } from "./Tooltip";

/**
 * 点击复制芯片:复制成功短暂显 ✓,悬停提示当前动作。
 * 用于 UUID / token / 订单号 / 短码这类"给用户看一眼、真正用途是粘贴出去"的长标识,
 * 替代全仓手写的 `<span className="font-mono text-[12px]">{id}</span>` + 旁边一个复制按钮。
 *
 * 触控靶下沉在这里:芯片在无 hover 的设备上撑到 44px 高,调用方不必再补
 * `[@media(hover:none)]:min-h-11`。
 */
export function CopyChip({
  value,
  label,
  mono = true,
  className,
}: {
  value: string;
  /** 展示文本(缺省用 value)。 */
  label?: ReactNode;
  /** 等宽字形。标识符默认开;展示邮箱/名称这类自然文本时传 false。 */
  mono?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  // 卸载后 setState 会告警;定时器必须随组件走。
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1400);
    } catch {
      /* 剪贴板不可用(非安全上下文):静默 */
    }
  };

  return (
    <Tooltip content={copied ? "已复制" : "点击复制"}>
      <button
        type="button"
        onClick={copy}
        className={cn(
          "inline-flex max-w-full items-center gap-1.5 rounded-md bg-hover px-2 py-1 text-meta text-muted transition-colors hover:bg-active hover:text-fg",
          mono && "font-mono",
          "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
          "[@media(hover:none)]:min-h-11 [@media(hover:none)]:px-3",
          className,
        )}
      >
        <span className="truncate">{label ?? value}</span>
        {copied ? (
          <Check size={13} className="shrink-0 text-success" />
        ) : (
          <Copy size={13} className="shrink-0 opacity-70" />
        )}
      </button>
    </Tooltip>
  );
}
