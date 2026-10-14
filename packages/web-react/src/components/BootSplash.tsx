import { useEffect, useState } from "react";
import { Spinner } from "./ui";

/** 慢网提示出现的时机:正常网络下启动续期 / 懒块远小于这个值,看不到任何变化。 */
export const BOOT_SLOW_HINT_MS = 4000;
export const BOOT_STALL_HINT_MS = 20_000;

/**
 * 全屏启动 / 懒块加载态(OCV5-421)。以前只有一个居中 spinner:弱网(实测 40KB/s + 1.5s 延迟)下
 * 半分钟以上一片空白,用户分不清是卡死还是在加载。超过 4s 补一行「网络较慢,正在加载…」,
 * 超过 20s 再给「刷新重试」。
 */
export function BootSplash() {
  const [stage, setStage] = useState<0 | 1 | 2>(0);
  useEffect(() => {
    const slow = setTimeout(() => setStage(1), BOOT_SLOW_HINT_MS);
    const stall = setTimeout(() => setStage(2), BOOT_STALL_HINT_MS);
    return () => {
      clearTimeout(slow);
      clearTimeout(stall);
    };
  }, []);
  return (
    <output className="flex h-full flex-col items-center justify-center gap-3 bg-bg text-muted" aria-live="polite">
      <Spinner size={22} />
      {stage >= 1 && (
        <p className="text-meta text-faint" data-testid="boot-slow-hint">
          网络较慢，正在加载…
        </p>
      )}
      {stage >= 2 && (
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-full px-3 py-1 text-meta text-muted underline-offset-2 hover:text-fg hover:underline [@media(hover:none)]:min-h-11"
        >
          仍在加载？刷新重试
        </button>
      )}
    </output>
  );
}
