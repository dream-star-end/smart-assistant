import { Check, Copy, WrapText } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { cn } from "../lib/utils";

const WRAP_KEY = "oc_v5_code_wrap";

function readCodeWrap(): boolean {
  try {
    return localStorage.getItem(WRAP_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCodeWrap(on: boolean): void {
  try {
    localStorage.setItem(WRAP_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export function CodeBlock({ language, children }: { language?: string; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(readCodeWrap);

  const copy = async () => {
    const text = ref.current?.textContent ?? "";
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  const toggleWrap = () => {
    setWrap((prev) => {
      const next = !prev;
      writeCodeWrap(next);
      return next;
    });
  };

  return (
    <div className="my-4 overflow-hidden rounded-lg border border-border bg-code">
      <div className="flex items-center justify-between border-b border-border px-3.5 py-1.5">
        <span className="font-mono text-xs text-faint">{language || "code"}</span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={toggleWrap}
            aria-label="换行"
            aria-pressed={wrap}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted transition-colors hover:bg-hover hover:text-fg [@media(hover:none)]:min-h-11 [@media(hover:none)]:px-3"
          >
            <WrapText size={13} />
            换行
          </button>
          <button
            type="button"
            onClick={copy}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted transition-colors hover:bg-hover hover:text-fg [@media(hover:none)]:min-h-11 [@media(hover:none)]:px-3"
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? "已复制" : "复制"}
          </button>
        </div>
      </div>
      <pre
        className={cn(
          "overflow-x-auto px-4 py-3.5 text-[13.5px] leading-relaxed",
          wrap && "whitespace-pre-wrap break-words",
        )}
      >
        <code ref={ref} className="font-mono">
          {children}
        </code>
      </pre>
    </div>
  );
}
