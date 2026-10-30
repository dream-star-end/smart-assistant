import { ChevronRight } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { cn } from "../lib/utils";

/**
 * 「技术详情」的正文:错误码、请求 ID、消息 ID 这些排障信息,一行一项,带「复制」。
 * 放在 Notice 的 details 里时由 Notice 负责折叠;不在 Notice 里的地方(发送失败横幅、
 * 智能体出错面板)用 `collapsible` 自己折叠。默认视图里不出现这些号码。
 */
export function ErrorTechDetails({ text, collapsible = false }: { text: string; collapsible?: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const body = (
    <span className="flex items-start gap-2">
      <span data-testid="error-tech-details" className="min-w-0 flex-1 select-text whitespace-pre-wrap break-all">
        {text}
      </span>
      <CopyDetailsButton text={text} />
    </span>
  );
  if (!collapsible) return body;
  return (
    <div className="mt-1.5">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-0.5 rounded-sm px-1 text-meta text-faint outline-none transition-colors hover:text-muted focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11"
      >
        技术详情
        <ChevronRight aria-hidden="true" size={12} className={cn("transition-transform", open && "rotate-90")} />
      </button>
      <div
        id={id}
        hidden={!open}
        className="mt-1.5 rounded-sm bg-hover px-2.5 py-2 font-mono text-meta text-muted"
      >
        {body}
      </div>
    </div>
  );
}

/** 剪贴板不可用(非安全上下文、权限被拒)时提示手动选中,正文本身可选中。 */
function CopyDetailsButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setState("copied");
        } catch {
          setState("failed");
        }
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setState("idle"), 1600);
      }}
      className="shrink-0 rounded-sm px-1.5 font-sans text-meta text-faint outline-none transition-colors hover:text-fg focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11"
    >
      {state === "copied" ? "已复制" : state === "failed" ? "请手动选中复制" : "复制"}
    </button>
  );
}
