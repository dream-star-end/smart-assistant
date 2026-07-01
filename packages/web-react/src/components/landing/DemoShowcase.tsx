import { Check, FileDown, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import { DEMO_SCENARIOS } from "./demoScripts";

/** 读「减少动态效果」系统偏好（无障碍）：true 时跳过打字动画，直接整段呈现。 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const on = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return reduced;
}

const TYPE_MS = 18; // 每字打字间隔
const STEP_MS = 720; // 执行动作芯片逐条亮起间隔
const HOLD_MS = 2600; // 答案打完后停留再切下一幕

/**
 * 落地页动态演示：自动轮播一组「提问 → 助手执行动作 → 逐字作答」的真实使用场景，
 * 展示 agent 的写作/编程/联网/分析/记忆/自动化能力。顶部能力 Tab 可手动跳转。
 * 纯前端动画（无任何网络请求），尊重 prefers-reduced-motion。
 */
export function DemoShowcase({ onTry }: { onTry: () => void }) {
  const reduced = usePrefersReducedMotion();
  const [idx, setIdx] = useState(0);
  const [stepCount, setStepCount] = useState(0); // 已亮起的执行动作数
  const [typed, setTyped] = useState(0); // 已打出的答案字数
  const [done, setDone] = useState(false); // 本幕答案是否打完
  // stepCount/typed/done 归属的场景。切场景时 idx 先变、这些进度态下一拍才在 effect 里重置，
  // 中间那一帧若直接用旧进度态配新场景，会让新场景的答案/交付物芯片错误闪现。以此守卫。
  const [stateIdx, setStateIdx] = useState(0);

  const next = useCallback(() => setIdx((i) => (i + 1) % DEMO_SCENARIOS.length), []);

  useEffect(() => {
    const sc = DEMO_SCENARIOS[idx];
    const steps = sc.steps ?? [];
    const answer = sc.answer;
    setStateIdx(idx); // 进度态从这一拍起归属当前场景

    if (reduced) {
      // 无障碍：直接呈现完整内容，仅做定时轮播。
      setStepCount(steps.length);
      setTyped(answer.length);
      setDone(true);
      const t = window.setTimeout(next, 4200);
      return () => window.clearTimeout(t);
    }

    setStepCount(0);
    setTyped(0);
    setDone(false);
    let cancelled = false;
    const timers: number[] = [];

    // 1) 执行动作芯片逐条亮起
    steps.forEach((_, i) => {
      timers.push(
        window.setTimeout(() => {
          if (!cancelled) setStepCount(i + 1);
        }, 500 + i * STEP_MS),
      );
    });

    // 2) 逐字打字
    const startAt = 600 + steps.length * STEP_MS;
    let n = 0;
    const tick = () => {
      if (cancelled) return;
      n += 1;
      setTyped(n);
      if (n < answer.length) {
        timers.push(window.setTimeout(tick, TYPE_MS));
      } else {
        setDone(true);
        timers.push(window.setTimeout(next, HOLD_MS)); // 3) 停留后切下一幕
      }
    };
    timers.push(window.setTimeout(tick, startAt));

    return () => {
      cancelled = true;
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [idx, reduced, next]);

  const sc = DEMO_SCENARIOS[idx];
  const steps = sc.steps ?? [];
  // 未同步（切场景后的第一帧）时一律按重置态渲染，避免用上一幕的完成态配新场景。
  const synced = stateIdx === idx;
  const shownStep = synced ? stepCount : 0;
  const shownTyped = synced ? typed : 0;
  const shownDone = synced ? done : false;
  const shownAnswer = sc.answer.slice(0, shownTyped);
  const typing = !shownDone && shownTyped < sc.answer.length;

  return (
    <div className="mx-auto w-full max-w-2xl">
      {/* 能力 Tab 条 */}
      <div className="no-scrollbar -mx-1 mb-3 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {DEMO_SCENARIOS.map((s, i) => {
          const active = i === idx;
          return (
            <button
              key={s.id}
              onClick={() => setIdx(i)}
              aria-pressed={active}
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium transition-colors",
                active
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-border bg-surface text-muted hover:border-border-strong hover:text-fg",
              )}
            >
              <s.icon size={14} />
              {s.tab}
            </button>
          );
        })}
      </div>

      {/* 演示卡（仿应用窗口） */}
      <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-float">
        {/* 窗口顶栏 */}
        <div className="flex items-center gap-2 border-b border-border bg-sidebar/60 px-4 py-2.5">
          <span className="flex size-6 items-center justify-center rounded-lg bg-grad-cta text-white">
            <Sparkles size={13} />
          </span>
          <span className="text-[13px] font-medium text-fg">全能助手</span>
          <span className="ml-auto rounded-full border border-border bg-bg px-2 py-0.5 text-[11px] text-faint">
            动态演示
          </span>
        </div>

        {/* 对话体 */}
        <div className="flex min-h-[260px] flex-col gap-3 px-4 py-5 sm:px-6">
          {/* 用户气泡 */}
          <div className="flex justify-end">
            <div className="max-w-[85%] rounded-2xl rounded-br-md bg-bubble px-3.5 py-2.5 text-[14px] leading-relaxed text-fg">
              {sc.prompt}
            </div>
          </div>

          {/* 执行动作芯片 */}
          {steps.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {steps.map((st, i) => {
                const shown = i < shownStep;
                return (
                  <span
                    key={st.label}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-all duration-300",
                      shown
                        ? "border-accent/30 bg-accent-soft text-accent opacity-100"
                        : "translate-y-1 border-border bg-surface text-faint opacity-0",
                    )}
                  >
                    <Check size={12} className="shrink-0" />
                    {st.label}
                  </span>
                );
              })}
            </div>
          )}

          {/* 助手气泡（逐字打字） */}
          {(shownTyped > 0 || (steps.length > 0 && shownStep >= steps.length)) && (
            <div className="flex justify-start">
              <div className="max-w-[92%] rounded-2xl rounded-bl-md border border-border bg-bg px-3.5 py-2.5">
                <p
                  className={cn(
                    "whitespace-pre-wrap text-[14px] leading-relaxed text-fg",
                    sc.mono && "font-mono text-[12.5px] leading-[1.6]",
                  )}
                >
                  {shownAnswer}
                  {typing && (
                    <span className="caret-blink ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[2px] bg-accent align-middle" />
                  )}
                </p>
                {/* 交付物附件芯片：答案打完后出现，让「交出真实成果」可视化。 */}
                {sc.deliverable && shownDone && (
                  <span className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg border border-accent/30 bg-accent-soft px-2.5 py-1.5 text-[12.5px] font-medium text-accent animate-in">
                    <FileDown size={14} className="shrink-0" />
                    {sc.deliverable}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 底部行动条 */}
        <div className="flex items-center justify-between gap-3 border-t border-border bg-sidebar/40 px-4 py-3 sm:px-6">
          <span className="text-[12.5px] text-faint">想试试同样的问题？</span>
          <button
            onClick={onTry}
            className="rounded-full bg-primary px-3.5 py-1.5 text-[13px] font-medium text-primary-fg transition-opacity hover:opacity-90"
          >
            免费试一句
          </button>
        </div>
      </div>
    </div>
  );
}
