import { Check, Loader2, RotateCcw, Sparkles, Timer } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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
 * 时间线 → 逐字作答），右栏同步呈现**可视化成果预览**，把「交回能直接用的成果」
 * 变成看得见的证据。顶部能力 Tab 可手动跳转。
 *
 * 动效纪律（避免「页面一直在动」）：
 * - 卡片 md 起定高、答案区按完整文案预留高度 —— 打字过程零布局位移；
 * - 全部场景播完一轮即停在完成态（不无限循环），提供「重播」；
 * - 滚出视口自动暂停，回来再继续；尊重 prefers-reduced-motion。
 * 纯前端动画（无任何网络请求）。
 */
export function DemoShowcase({ onTry }: { onTry: () => void }) {
  const reduced = usePrefersReducedMotion();
  const [idx, setIdx] = useState(0);
  const [stepCount, setStepCount] = useState(0); // 已完成的执行动作数
  const [typed, setTyped] = useState(0); // 已打出的答案字数
  const [done, setDone] = useState(false); // 本幕答案是否打完
  const [ended, setEnded] = useState(false); // 全部场景播完一轮，停住
  const [runSeq, setRunSeq] = useState(0); // 手动跳转/重播时自增，强制重跑当前幕
  // stepCount/typed/done 归属的场景。切场景时 idx 先变、这些进度态下一拍才在 effect 里重置，
  // 中间那一帧若直接用旧进度态配新场景，会让新场景的答案/成果面板错误闪现。以此守卫。
  const [stateIdx, setStateIdx] = useState(0);
  // 视口可见性：滚出视口暂停动画（回来从当前幕头部继续）。
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true); // 测试环境 / 老浏览器：不暂停
      return;
    }
    const el = cardRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.15 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const play = useCallback((i: number) => {
    setIdx(i);
    setEnded(false);
    setRunSeq((s) => s + 1);
  }, []);

  const isLast = idx === DEMO_SCENARIOS.length - 1;

  useEffect(() => {
    const sc = DEMO_SCENARIOS[idx];
    const steps = sc.steps ?? [];
    const answer = sc.answer;
    setStateIdx(idx); // 进度态从这一拍起归属当前场景

    if (ended) {
      // 停播态：呈现当前幕完成态，不再排任何定时器。
      setStepCount(steps.length);
      setTyped(answer.length);
      setDone(true);
      return;
    }
    if (!visible) return; // 不在视口：本幕保持初始态，回到视口再播

    if (reduced) {
      // 无障碍：直接呈现完整内容，仅做定时轮播；到最后一幕停住。
      setStepCount(steps.length);
      setTyped(answer.length);
      setDone(true);
      if (idx >= DEMO_SCENARIOS.length - 1) {
        setEnded(true);
        return;
      }
      const t = window.setTimeout(() => setIdx(idx + 1), 5200);
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
        // 3) 停留后切下一幕；最后一幕播完整轮即停。
        if (idx >= DEMO_SCENARIOS.length - 1) {
          timers.push(window.setTimeout(() => setEnded(true), HOLD_MS));
        } else {
          timers.push(window.setTimeout(() => setIdx(idx + 1), HOLD_MS));
        }
      }
    };
    timers.push(window.setTimeout(tick, startAt));

    return () => {
      cancelled = true;
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [idx, reduced, ended, visible, runSeq]);

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
              onClick={() => play(i)}
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

      {/* 工作台卡（仿应用窗口）：左对话 / 右成果。md 起定高，打字过程页面零位移。 */}
      <div ref={cardRef} className="overflow-hidden rounded-2xl border border-border bg-surface shadow-float">
        {/* 窗口顶栏 */}
        <div className="flex items-center gap-2 border-b border-border bg-sidebar/60 px-4 py-2.5">
          <span className="flex size-6 items-center justify-center rounded-lg bg-grad-cta text-white">
            <Sparkles size={13} />
          </span>
          <span className="text-[13px] font-medium text-fg">全能助手</span>
          <span className="ml-auto rounded-full border border-border bg-bg px-2 py-0.5 text-[11px] text-faint">
            {sc.sourceLabel ?? "动态演示 · 示意数据"}
          </span>
        </div>

        <div className="grid grid-cols-1 md:h-[440px] md:grid-cols-[1.08fr_1fr]">
          {/* 左栏：对话 + 执行过程 */}
          <div className="flex flex-col gap-3.5 px-4 py-4 sm:px-5">
            {/* 用户气泡 */}
            <div className="flex justify-end">
              <div className="max-w-[92%] rounded-2xl rounded-br-md bg-bubble px-3.5 py-2.5 text-[13.5px] leading-relaxed text-fg">
                {sc.prompt}
              </div>
            </div>

            {/* 执行动作时间线：像同事一样把过程摊给你看（行数固定，逐条点亮不位移） */}
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
                        isDone ? "text-muted" : isActive ? "text-fg" : "text-faint/0",
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

            {/* 助手气泡：按完整答案预留高度（invisible 撑位 + 绝对定位覆打），打字零位移 */}
            <div
              className={cn(
                "flex justify-start transition-opacity duration-300",
                stepsDone ? "opacity-100" : "opacity-0",
              )}
            >
              <div className="relative max-w-[95%] rounded-2xl rounded-bl-md border border-border bg-bg px-3.5 py-2.5">
                <p
                  aria-hidden
                  className={cn(
                    "invisible whitespace-pre-wrap text-[13.5px] leading-relaxed",
                    sc.mono && "font-mono text-[12px] leading-[1.6]",
                  )}
                >
                  {sc.answer}
                </p>
                <p
                  className={cn(
                    "absolute inset-x-3.5 top-2.5 whitespace-pre-wrap text-[13.5px] leading-relaxed text-fg",
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

            {/* 长程任务元信息：跑了多少步、多久 —— 「交出去就不用管」的证据（占位常驻，完成后点亮） */}
            {sc.runMeta && (
              <div
                className={cn(
                  "flex items-center gap-1.5 pl-1 text-[12px] text-faint transition-opacity duration-300",
                  shownDone ? "opacity-100" : "opacity-0",
                )}
              >
                <Timer size={13} className="shrink-0 text-accent" />
                {sc.runMeta}
              </div>
            )}
          </div>

          {/* 右栏：成果预览（把交付物画出来） */}
          <div className="border-t border-border bg-sidebar/25 md:border-l md:border-t-0">
            <ArtifactPreview
              artifact={sc.artifact}
              deliverable={sc.deliverable}
              done={stepsDone}
              publicLink={sc.publicLink}
            />
          </div>
        </div>

        {/* 底部行动条 */}
        <div className="flex items-center justify-between gap-3 border-t border-border bg-sidebar/40 px-4 py-3 sm:px-6">
          <span className="flex items-center gap-3 text-[12.5px] text-faint">
            {ended ? "演示播完了" : "想让它帮你干同样的活？"}
            {ended && (
              <button
                onClick={() => play(0)}
                className="inline-flex items-center gap-1 font-medium text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                <RotateCcw size={12} /> 重播
              </button>
            )}
          </span>
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
