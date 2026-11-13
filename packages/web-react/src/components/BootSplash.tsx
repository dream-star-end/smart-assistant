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
// 启动期会先后经过几个懒加载边界,每个边界挂自己的 BootSplash;若按「本实例挂载」计时,每次换边界
// 都从 0 重数,慢网下提示永远出不来。改为按「连续处于加载态」计时:上一个 splash 卸载后 1 秒内又挂上
// 视为同一段加载。首段从页面导航开始算(之前是 index.html 的静态占位在转圈)。
let splashSince: number | null = null;
let splashLeftAt = 0;
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

function stageAt(elapsed: number): 0 | 1 | 2 {
  return elapsed >= BOOT_STALL_HINT_MS ? 2 : elapsed >= BOOT_SLOW_HINT_MS ? 1 : 0;
}

export function BootSplash({ slowHint = "网络较慢，正在加载…" }: { slowHint?: string } = {}) {
  const [since] = useState(() => {
    // First splash of the page: count from navigation start, unless it only shows up much later
    // (a lazy chunk long after boot) — then count from now.
    if (splashSince === null) splashSince = now() < 30_000 ? 0 : now();
    else if (now() - splashLeftAt > 1000) splashSince = now();
    return splashSince;
  });
  const [stage, setStage] = useState<0 | 1 | 2>(() => stageAt(now() - since));
  useEffect(() => {
    const tick = () => setStage(stageAt(now() - since));
    const timers = [BOOT_SLOW_HINT_MS, BOOT_STALL_HINT_MS]
      .map((at) => at - (now() - since))
      .filter((ms) => ms > 0)
      .map((ms) => setTimeout(tick, ms + 20));
    tick();
    return () => {
      for (const t of timers) clearTimeout(t);
      splashLeftAt = now();
    };
  }, [since]);
  return (
    <output className="flex h-full flex-col items-center justify-center gap-3 bg-bg text-muted" aria-live="polite">
      <Spinner size={22} />
      {stage >= 1 && (
        <p className="text-meta text-faint" data-testid="boot-slow-hint">
          {slowHint}
        </p>
      )}
      {stage >= 2 && (
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-full px-3 py-1 text-meta text-muted underline-offset-2 hover:text-fg hover:underline [@media(hover:none)]:min-h-11"
        >
          继续
        </button>
      )}
    </output>
  );
}

/** Test hook: forget the shared splash period. */
export function resetBootSplashForTest(): void {
  splashSince = null;
  splashLeftAt = 0;
}
