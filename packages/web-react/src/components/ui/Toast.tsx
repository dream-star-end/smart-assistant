import { CheckCircle2, Info, TriangleAlert, X } from "lucide-react";
import {
  createContext,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "../../lib/utils";

/**
 * 极简 toast 原语（web-react 唯一 toast 权威源）。
 *
 * 为什么自滚而非引第三方：只需"短暂提示 + 自隐"，无需队列优先级等重特性；
 * 自滚零依赖、与 Aurora token 对齐。用于 GitHub OAuth 返回提示、仓库绑定错误等
 * 一次性反馈（持久态仍用 Alert/Banner）。
 *
 * 用法：在树顶挂 <ToastProvider>，子树用 const toast = useToast() → toast("已连接", "success")。
 */
export type ToastTone = "success" | "error" | "info";

/**
 * 可选动作。存在的理由:错误 toast 是全仓最常见的失败出口(仅 App.tsx 就有十余处
 * `toast(…, "error")`),而它此前**没有任何出口** —— 用户读完"原始消息加载失败，请重试"
 * 只能自己去找哪里能重试。带 action 的 toast 让失败即可原地重试。
 */
export type ToastOptions = {
  actionLabel?: string;
  onAction?: () => void;
  /** 追踪号。不进正文,收进「复制追踪号」按钮;message 尾部的「（追踪号 …）」会自动剥出来放这里。 */
  traceId?: string;
};

export type ToastFn = (message: string, tone?: ToastTone, options?: ToastOptions) => void;

type ToastItem = {
  id: number;
  message: string;
  traceId?: string;
  tone: ToastTone;
  actionLabel?: string;
  onAction?: () => void;
  /** 被上限挤掉的 error 条数；有值表示「还有 N 条错误」汇总条。 */
  overflowCount?: number;
  /** 会自隐的提示(success / info 且无动作)。悬停 / 聚焦时暂停计时,离开后重新计满。 */
  autoDismiss: boolean;
};

const MAX_ERROR_TOASTS = 3;

/**
 * apiErrorMessage / withReqId 给未知错误烙在尾部的「（追踪号 …）」(lib/api.ts REQ_ID_SUFFIX_RE)。
 * 跟踪号是给反馈和排障用的,不是给用户读的:正文只留人话,号码收进复制按钮(UI-SPEC §1.1 C6)。
 * 全仓几十处 `toast(apiErrorMessage(e, …), "error")` 不必逐个改。
 */
const TRACE_SUFFIX_RE = /\s*[（(]\s*[追跟]踪号[\s:：]*([^）)\s]+)\s*[）)]\s*$/;

export function splitTraceId(message: string): { text: string; traceId?: string } {
  const m = TRACE_SUFFIX_RE.exec(message);
  if (!m || m.index === 0) return { text: message };
  return { text: message.slice(0, m.index), traceId: m[1] };
}

/** 轨道与顶栏下沿之间的间距(px)。 */
const TOAST_GAP_PX = 8;

/**
 * 顶栏把自己的实测下沿登记成 toast 轨道的顶距(--oc-toast-top),toast 就落在顶栏下面、不压住它。
 * 手机顶栏会折成两行(模型行 basis-full),固定的 4rem 正好压住第二行;高度变化(换行、横竖屏)
 * 由 ResizeObserver 跟上。卸载时撤掉,回落到 styles.css 的默认值。
 */
export function useToastAnchor(ref: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const publish = () => {
      const bottom = Math.ceil(el.getBoundingClientRect().bottom);
      root.style.setProperty("--oc-toast-top", `${bottom + TOAST_GAP_PX}px`);
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--oc-toast-top");
    };
  }, [ref]);
}

/** 「复制追踪号」。剪贴板不可用(非安全上下文)时把号码直接亮出来,反馈时仍然拿得到。 */
function TraceIdButton({ traceId }: { traceId: string }) {
  const [state, setState] = useState<"idle" | "copied" | "shown">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  if (state === "shown") {
    return <span className="shrink-0 select-all font-mono text-caption opacity-80">{traceId}</span>;
  }
  return (
    <button
      type="button"
      title={`追踪号 ${traceId}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(traceId);
          setState("copied");
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setState("idle"), 1400);
        } catch {
          setState("shown");
        }
      }}
      className="shrink-0 rounded-md px-2 py-1 text-meta font-medium opacity-80 outline-none transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg [@media(hover:none)]:min-h-11"
    >
      {state === "copied" ? "已复制" : "复制追踪号"}
    </button>
  );
}

const ToastContext = createContext<ToastFn | null>(null);

const TONE_STYLE: Record<ToastTone, { icon: ReactNode; cls: string }> = {
  success: { icon: <CheckCircle2 size={16} />, cls: "border-success/40 bg-success-soft text-success" },
  error: { icon: <TriangleAlert size={16} />, cls: "border-danger/40 bg-danger-soft text-danger" },
  info: { icon: <Info size={16} />, cls: "border-info/40 bg-info-soft text-info" },
};

const AUTO_DISMISS_MS = 3500;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const dismissTimers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    const timer = dismissTimers.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    dismissTimers.current.delete(id);
    setItems((cur) => cur.filter((t) => t.id !== id));
  }, []);

  // 自隐计时的两个开关(a11y 走查 shell#10 / WCAG 2.2.1):鼠标停在提示上、或键盘把焦点移进
  // 提示里(动作按钮 / 关闭键)时暂停;离开再从头计 3.5s,读得慢的人不会在读到一半时被收走。
  const schedule = useCallback(
    (id: number) => {
      const prev = dismissTimers.current.get(id);
      if (prev !== undefined) window.clearTimeout(prev);
      dismissTimers.current.set(id, window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS));
    },
    [dismiss],
  );
  const pause = useCallback((id: number) => {
    const timer = dismissTimers.current.get(id);
    if (timer === undefined) return;
    window.clearTimeout(timer);
    dismissTimers.current.delete(id);
  }, []);

  useEffect(() => () => {
    for (const timer of dismissTimers.current.values()) window.clearTimeout(timer);
    dismissTimers.current.clear();
  }, []);

  const toast = useCallback<ToastFn>(
    // tone 的默认值在体内取(而非默认参数):options 排在它后面,默认参数不能在必填/可选参数之前。
    (message, toneArg, options) => {
      if (!message) return;
      const split = splitTraceId(message);
      const traceId = options?.traceId ?? split.traceId;
      const tone = toneArg ?? "info";
      const id = ++seq.current;
      const actionable = Boolean(options?.actionLabel && options?.onAction);
      const autoDismiss = tone !== "error" && !actionable;
      setItems((cur) => {
        const item: ToastItem = {
          id,
          message: split.text,
          traceId,
          tone,
          actionLabel: actionable ? options?.actionLabel : undefined,
          onAction: actionable ? options?.onAction : undefined,
          autoDismiss,
        };
        if (tone !== "error") return [...cur, item];
        const overflow = cur.find((t) => t.overflowCount != null);
        const errors = cur.filter((t) => t.tone === "error" && t.overflowCount == null);
        const rest = cur.filter((t) => t.tone !== "error");
        let nextErrors = [...errors, item];
        let dropped = overflow?.overflowCount ?? 0;
        if (nextErrors.length > MAX_ERROR_TOASTS) {
          const extra = nextErrors.length - MAX_ERROR_TOASTS;
          nextErrors = nextErrors.slice(extra);
          dropped += extra;
        }
        const next: ToastItem[] = [...rest, ...nextErrors];
        if (dropped > 0) {
          next.push({
            id: overflow?.id ?? ++seq.current,
            message: `还有 ${dropped} 条错误`,
            tone: "error",
            overflowCount: dropped,
            autoDismiss: false,
          });
        }
        return next;
      });
      // 错误提示不自动消失(可达性:屏幕阅读器/慢读用户不会因 3.5s 自隐而错过失败原因;
      // 用户可点 X 关闭)。带动作的提示同理 —— 等着用户做决定的东西不能自己溜走。
      // 其余成功/信息类保持短暂自隐。
      if (autoDismiss) schedule(id);
    },
    [schedule],
  );

  return (
    <ToastContext.Provider value={toast}>
      {children}
      {/* 顶部居中堆叠，pointer-events 仅落在卡片上，不挡下层交互。
          顶距走 --oc-toast-top:有顶栏时是顶栏实测下沿(useToastAnchor),否则取 styles.css 的默认值。
          不再写死 top-16(shell 审计 S-20),也不再自带安全区内边距(实测下沿已经包含)。 */}
      <div
        data-toast-rail
        className="pointer-events-none fixed inset-x-0 top-[var(--oc-toast-top)] z-[100] flex flex-col items-center gap-2 px-3"
      >
        {items.map((t) => {
          const s = TONE_STYLE[t.tone];
          return (
            <div
              key={t.id}
              // 错误提示用 alert/assertive 立即打断朗读;成功/信息用 status/polite 不打断。
              role={t.tone === "error" ? "alert" : "status"}
              aria-live={t.tone === "error" ? "assertive" : "polite"}
              data-auto-dismiss={t.autoDismiss ? "true" : undefined}
              onMouseEnter={t.autoDismiss ? () => pause(t.id) : undefined}
              onMouseLeave={t.autoDismiss ? () => schedule(t.id) : undefined}
              onFocusCapture={t.autoDismiss ? () => pause(t.id) : undefined}
              onBlurCapture={
                t.autoDismiss
                  ? (e) => {
                      // 焦点仍在提示内部(关闭键 ↔ 动作按钮之间移动)不算离开。
                      if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
                      schedule(t.id);
                    }
                  : undefined
              }
              className={cn(
                "pointer-events-auto flex max-w-[92vw] items-center gap-2 rounded-xl border px-3.5 py-2.5 text-body font-medium shadow-float backdrop-blur data-[state=open]:animate-in sm:max-w-md",
                s.cls,
              )}
            >
              <span className="shrink-0">{s.icon}</span>
              <span className="min-w-0 flex-1 break-words">{t.message}</span>
              {t.traceId && <TraceIdButton traceId={t.traceId} />}
              {t.actionLabel && (
                <button
                  type="button"
                  onClick={() => {
                    t.onAction?.();
                    // 动作触发即收起:提示已经完成使命,留着只会挡住动作的结果。
                    dismiss(t.id);
                  }}
                  className="shrink-0 rounded-md px-2 py-1 font-semibold underline underline-offset-2 outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg [@media(hover:none)]:min-h-11"
                >
                  {t.actionLabel}
                </button>
              )}
              <button
                type="button"
                aria-label="关闭提示"
                onClick={() => dismiss(t.id)}
                // 触控靶:原来 p-0.5 的关闭键只有 ~22px,在触屏上属于"看得见点不中"。
                className="-mr-1 flex shrink-0 items-center justify-center rounded-md p-0.5 opacity-70 outline-none transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg [@media(hover:none)]:size-11"
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * 取 toast 函数。在 ToastProvider 之外调用返回 no-op（不抛），让无 Provider 的
 * 单元测试 / demo 子树也能安全调用。
 */
export function useToast(): ToastFn {
  const ctx = useContext(ToastContext);
  return useMemo(() => ctx ?? (() => {}), [ctx]);
}
