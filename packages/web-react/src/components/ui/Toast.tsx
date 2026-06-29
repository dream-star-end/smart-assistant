import { CheckCircle2, Info, TriangleAlert, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "../../lib/utils";

/**
 * 极简 toast 原语（web-react 唯一 toast 权威源）。
 *
 * 为什么自滚而非引第三方：只需"短暂提示 + 自隐"，无需队列优先级/动作按钮等重特性；
 * 自滚零依赖、与 Aurora token 对齐。用于 GitHub OAuth 返回提示、仓库绑定错误等
 * 一次性反馈（持久态仍用 Alert/Banner）。
 *
 * 用法：在树顶挂 <ToastProvider>，子树用 const toast = useToast() → toast("已连接", "success")。
 */
export type ToastTone = "success" | "error" | "info";

type ToastItem = { id: number; message: string; tone: ToastTone };

const ToastContext = createContext<((message: string, tone?: ToastTone) => void) | null>(null);

const TONE_STYLE: Record<ToastTone, { icon: ReactNode; cls: string }> = {
  success: { icon: <CheckCircle2 size={16} />, cls: "border-success/40 bg-success-soft text-success" },
  error: { icon: <TriangleAlert size={16} />, cls: "border-danger/40 bg-danger-soft text-danger" },
  info: { icon: <Info size={16} />, cls: "border-info/40 bg-info-soft text-info" },
};

const AUTO_DISMISS_MS = 3500;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => {
    setItems((cur) => cur.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, tone: ToastTone = "info") => {
      if (!message) return;
      const id = ++seq.current;
      setItems((cur) => [...cur, { id, message, tone }]);
      window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={toast}>
      {children}
      {/* 顶部居中堆叠，pointer-events 仅落在卡片上，不挡下层交互。 */}
      <div className="pointer-events-none fixed inset-x-0 top-3 z-[100] flex flex-col items-center gap-2 px-3 header-safe-t">
        {items.map((t) => {
          const s = TONE_STYLE[t.tone];
          return (
            <div
              key={t.id}
              role="status"
              aria-live="polite"
              className={cn(
                "pointer-events-auto flex max-w-[92vw] items-center gap-2 rounded-xl border px-3.5 py-2.5 text-[13px] font-medium shadow-float backdrop-blur data-[state=open]:animate-in sm:max-w-md",
                s.cls,
              )}
            >
              <span className="shrink-0">{s.icon}</span>
              <span className="min-w-0 flex-1 break-words">{t.message}</span>
              <button
                type="button"
                aria-label="关闭提示"
                onClick={() => dismiss(t.id)}
                className="-mr-1 shrink-0 rounded-md p-0.5 opacity-70 outline-none transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
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
export function useToast(): (message: string, tone?: ToastTone) => void {
  const ctx = useContext(ToastContext);
  return useMemo(() => ctx ?? (() => {}), [ctx]);
}
