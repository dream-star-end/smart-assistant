import { Check, Loader2, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import { ArtifactPreview } from "./ArtifactPreview";
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

const TYPE_MS = 14; // 每字打字间隔
const STEP_MS = 640; // 执行动作逐条完成间隔
const HOLD_MS = 4200; // 答案打完后停留再切下一幕（留足时间看成果）

/**
 * 落地页动态演示 —— 「工作台」双栏布局：左栏还原 agent 干活过程（提问 → 执行动作
 * 时间线 → 逐字作答），右栏同步呈现**可视化成果预览**（图表 / PPT / 表格 / diff /
 * 账本 / 报告），把「交回能直接用的成果」变成看得见的证据。顶部能力 Tab 可手动跳转。
 * 纯前端动画（无任何网络请求），尊重 prefers-reduced-motion。
 */
export function DemoShowcase({ onTry }: { onTry: () => void }) {
  const reduced = usePrefersReducedMotion();
  const [idx, setIdx] = useState(0);
  const [stepCount, setStepCount] = useState(0); // 已完成的执行动作数
  const [typed, setTyped] = useState(0); // 已打出的答案字数
  const [done, setDone] = useState(false); // 本幕答案是否打完
  // stepCount/typed/done 归属的场景。切场景时 idx 先变、这些进度态下一拍才在 effect 里重置，
  // 中间那一帧若直接用旧进度态配新场景，会让新场景的答案/成果面板错误闪现。以此守卫。
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
      const t = window.setTimeout(next, 5200);
      return () => window.clearTimeout(t);
    }

    setStepCount(0);
    setTyped(0);
    setDone(false);
    let cancelled = false;
    const timers: number[] = [];

    // 1) 执行动作时间线逐条完成
    steps.forEach((_, i) => {
      timers.push(
        window.setTimeout(() => {
          if (!cancelled) setStepCount(i + 1);
        }, 420 + i * STEP_MS),
      );
    });

    // 2) 逐字打字
    const startAt = 520 + steps.length * STEP_MS;
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
  const stepsDone = steps.length > 0 && shownStep >= steps.length;
  const typing = stepsDone && !shownDone && shownTyped < sc.answer.length;

  return (
    <div className="mx-auto w-full max-w-4xl">
      {/* 能力 Tab 条 */}
      <div className="no-scrollbar -mx-1 mb-3 flex gap-1.5 overflow-x-auto px-1 pb-1 sm:justify-center">
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

      {/* 工作台卡（仿应用窗口）：左对话 / 右成果 */}
      <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-float">
        {/* 窗口顶栏 */}
        <div className="flex items-center gap-2 border-b border-border bg-sidebar/60 px-4 py-2.5">
          <span className="flex size-6 items-center justify-center rounded-lg bg-grad-cta text-white">
            <Sparkles size={13} />
          </span>
          <span className="text-[13px] font-medium text-fg">全能助手</span>
          <span className="ml-auto rounded-full border border-border bg-bg px-2 py-0.5 text-[11px] text-faint">
            动态演示 · 取材真实会话
          </span>
        </div>

        <div className="grid min-h-[360px] grid-cols-1 md:grid-cols-[1.08fr_1fr]">
          {/* 左栏：对话 + 执行过程 */}
          <div className="flex flex-col gap-3.5 px-4 py-4 sm:px-5">
            {/* 用户气泡 */}
            <div className="flex justify-end">
              <div className="max-w-[92%] rounded-2xl rounded-br-md bg-bubble px-3.5 py-2.5 text-[13.5px] leading-relaxed text-fg">
                {sc.prompt}
              </div>
            </div>

            {/* 执行动作时间线：像同事一样把过程摊给你看 */}
            {steps.length > 0 && (
              <div className="flex flex-col gap-1">
                {steps.map((st, i) => {
                  const isDone = i < shownStep;
                  const isActive = i === shownStep && !stepsDone;
                  return (
                    <div
                      key={st.label}
                      className={cn(
                        "flex items-center gap-2 text-[12.5px] transition-all duration-300",
                        isDone ? "text-muted" : isActive ? "text-fg" : "translate-y-0.5 text-faint/0",
                      )}
                    >
                      {isDone ? (
                        <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
                          <Check size={10} strokeWidth={3} />
                        </span>
                      ) : (
                        <span
                          className={cn(
                            "flex size-4 shrink-0 items-center justify-center text-accent",
                            !isActive && "opacity-0",
                          )}
                        >
                          <Loader2 size={13} className="animate-spin" />
                        </span>
                      )}
                      {st.label}
                    </div>
                  );
                })}
              </div>
            )}

            {/* 助手气泡（逐字打字） */}
            {(shownTyped > 0 || stepsDone) && (
              <div className="flex justify-start">
                <div className="max-w-[95%] rounded-2xl rounded-bl-md border border-border bg-bg px-3.5 py-2.5">
                  <p
                    className={cn(
                      "whitespace-pre-wrap text-[13.5px] leading-relaxed text-fg",
                      sc.mono && "font-mono text-[12px] leading-[1.6]",
                    )}
                  >
                    {shownAnswer}
                    {typing && (
                      <span className="caret-blink ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[2px] bg-accent align-middle" />
                    )}
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* 右栏：成果预览（把交付物画出来） */}
          <div className="border-t border-border bg-sidebar/25 md:border-l md:border-t-0">
            <ArtifactPreview artifact={sc.artifact} deliverable={sc.deliverable} done={stepsDone} />
          </div>
        </div>

        {/* 底部行动条 */}
        <div className="flex items-center justify-between gap-3 border-t border-border bg-sidebar/40 px-4 py-3 sm:px-6">
          <span className="text-[12.5px] text-faint">想让它帮你干同样的活？</span>
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
