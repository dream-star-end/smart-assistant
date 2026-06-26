import { Check, Copy } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

export function CodeBlock({ language, children }: { language?: string; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);

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

  return (
    <div className="my-4 overflow-hidden rounded-lg border border-border bg-code">
      <div className="flex items-center justify-between border-b border-border px-3.5 py-1.5">
        <span className="font-mono text-xs text-faint">{language || "code"}</span>
        <button
          onClick={copy}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted transition-colors hover:bg-hover hover:text-fg"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre className="overflow-x-auto px-4 py-3.5 text-[13.5px] leading-relaxed">
        <code ref={ref} className="font-mono">
          {children}
        </code>
      </pre>
    </div>
  );
}
