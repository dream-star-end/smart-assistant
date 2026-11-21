import { Check, ChevronDown, ChevronUp, Code2, Copy, Terminal, WrapText } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { useToast } from "./ui";

/** 剪贴板不可用(http 非安全上下文 / 权限被拒)时的提示,与 chat/cards 的复制按钮同文案。 */
const COPY_FAILED_TOAST = "复制失败，请手动选中文本复制";

const WRAP_KEY = "oc_v5_code_wrap";

function readCodeWrap(): boolean {
  try {
    return localStorage.getItem(WRAP_KEY) === "1";
  } catch {
    return false;
  }
}

const WRAP_EVENT = "oc:code-wrap";

function writeCodeWrap(on: boolean): void {
  try {
    localStorage.setItem(WRAP_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
  // 同页其它代码块跟着切(偏好本来就是全局的,只是之前只在下次挂载时生效)。
  window.dispatchEvent(new CustomEvent(WRAP_EVENT, { detail: on }));
}

/** 超过这么多行的历史代码块默认折叠;流式中看着生成的块保持展开,结束时不跳动(OCV5-421)。 */
export const CODE_COLLAPSE_LINES = 40;
const COLLAPSED_LINES = 24;

export function CodeBlock({
  language,
  children,
  live = false,
  lineCount = 0,
}: {
  language?: string;
  children: ReactNode;
  /** 挂载时正文仍在流式生成:不折叠(用户正看着它长出来)。 */
  live?: boolean;
  lineCount?: number;
}) {
  const ref = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(readCodeWrap);
  const canCollapse = !live && lineCount > CODE_COLLAPSE_LINES;
  // 只在挂载时决定一次;之后行数增长 / live 翻转都不再收起。
  const [collapsed, setCollapsed] = useState(() => canCollapse);
  const toast = useToast();

  useEffect(() => {
    const onWrap = (e: Event) => setWrap(!!(e as CustomEvent<boolean>).detail);
    window.addEventListener(WRAP_EVENT, onWrap);
    return () => window.removeEventListener(WRAP_EVENT, onWrap);
  }, []);

  const copy = async () => {
    const text = ref.current?.textContent ?? "";
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 不再静默吞掉:用户得知道复制没成功(无 Provider 的子树里 useToast 是 no-op,不会抛)。
      toast(COPY_FAILED_TOAST, "error");
    }
  };

  const toggleWrap = () => {
    writeCodeWrap(!wrap);
  };

  const isShell = /^(?:sh|bash|zsh|shell|console|terminal|powershell|cmd)$/i.test(language || "");
  const LangIcon = isShell ? Terminal : Code2;

  return (
    // overflow-clip(而非 hidden)不建立滚动容器,表头才能 sticky 在聊天滚动区顶部:长代码块
    // 展开后滚到中段,「复制 / 换行」仍在手边。
    <div className="oc-code-shell my-4 overflow-clip rounded-xl">
      {/* IDE 级精致顶栏:微凹底槽 + 语言微胶囊 + 触感动作按钮。 */}
      <div className="oc-code-shell-header sticky top-0 z-[1] flex items-center justify-between gap-2 px-3 py-1.5 backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-border/70 bg-surface/80 px-2 py-0.5 font-mono text-caption font-medium tracking-wide text-muted">
            <LangIcon size={12} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-faint" />
            <span className="truncate">{language || "code"}</span>
          </span>
          {lineCount > 0 && (
            <span className="hidden shrink-0 font-mono text-micro tabular-nums text-faint sm:inline">
              {lineCount} 行
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {canCollapse && !collapsed && (
            <button
              type="button"
              onClick={() => setCollapsed(true)}
              aria-label="收起代码块"
              className="oc-btn-tactile flex items-center gap-1 rounded-md px-2 py-1 text-caption font-medium text-faint transition-colors hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11 [@media(hover:none)]:px-3"
            >
              <ChevronUp size={13} strokeWidth={1.75} />
              收起
            </button>
          )}
          <button
            type="button"
            onClick={toggleWrap}
            aria-label="换行"
            aria-pressed={wrap}
            className={cn(
              "oc-btn-tactile flex items-center gap-1.5 rounded-md border px-2 py-1 text-caption font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11 [@media(hover:none)]:px-3",
              wrap
                ? "border-accent/30 bg-accent-soft text-accent"
                : "border-transparent text-faint hover:bg-hover hover:text-fg",
            )}
          >
            <WrapText size={13} strokeWidth={1.75} />
            换行
          </button>
          <button
            type="button"
            onClick={copy}
            className={cn(
              "oc-btn-tactile flex items-center gap-1.5 rounded-md border px-2 py-1 text-caption font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11 [@media(hover:none)]:px-3",
              copied
                ? "border-success/30 bg-success-soft text-success"
                : "border-transparent text-faint hover:bg-hover hover:text-fg",
            )}
          >
            {copied ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={1.75} />}
            {copied ? "已复制" : "复制"}
          </button>
        </div>
      </div>
      <div className="relative">
        <pre
          data-code-collapsed={collapsed || undefined}
          style={collapsed ? { maxHeight: `calc(${COLLAPSED_LINES} * 1.7 * 13px + 1.5rem)` } : undefined}
          className={cn(
            "overflow-x-auto px-4 py-3.5 text-body leading-[1.7] [scrollbar-width:thin]",
            collapsed && "overflow-y-hidden",
            wrap && "whitespace-pre-wrap break-words",
          )}
        >
          <code ref={ref} className="font-mono">
            {children}
          </code>
        </pre>
        {collapsed && (
          <div className="absolute inset-x-0 bottom-0 flex h-24 items-end justify-center bg-gradient-to-b from-transparent via-code/80 to-code pb-3">
            <button
              type="button"
              onClick={() => setCollapsed(false)}
              className="oc-btn-tactile oc-btn-secondary-craft flex items-center gap-1.5 rounded-full border border-border bg-surface px-3.5 py-1.5 text-caption font-medium text-fg shadow-soft transition-colors hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11 [@media(hover:none)]:px-4"
            >
              <ChevronDown size={13} strokeWidth={1.75} />
              展开全部（{lineCount} 行）
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
