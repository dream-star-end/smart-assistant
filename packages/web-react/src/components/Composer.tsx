import { ArrowUp, Mic, Plus, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { IconButton } from "./ui";

export function Composer({
  onSend,
  busy,
  onStop,
  model,
  disabled,
  placeholder = "给 OpenClaude 发消息…",
}: {
  onSend: (text: string) => void;
  busy?: boolean;
  onStop?: () => void;
  model?: string;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(el.scrollHeight, 240) + "px";
  }, [value]);

  const submit = () => {
    const t = value.trim();
    if (!t || busy || disabled) return;
    onSend(t);
    setValue("");
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4">
      <div
        className={cn(
          "rounded-[26px] border border-border bg-surface shadow-[var(--shadow-float)] transition-all",
          "focus-within:border-border-strong",
        )}
      >
        <div className="flex items-end gap-1.5 px-2.5 py-2">
          <IconButton
            aria-label="添加附件（即将支持）"
            title="附件上传即将支持"
            disabled
            className="mb-0.5"
          >
            <Plus size={20} />
          </IconButton>
          <textarea
            ref={ref}
            rows={1}
            value={value}
            disabled={disabled}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                busy ? onStop?.() : submit();
              }
            }}
            placeholder={placeholder}
            className="max-h-[240px] min-h-[24px] flex-1 resize-none bg-transparent py-2 text-[16px] leading-relaxed text-fg outline-none placeholder:text-faint disabled:opacity-50"
          />
          <IconButton
            aria-label="语音输入（即将支持）"
            title="语音输入即将支持"
            disabled
            className="mb-0.5"
          >
            <Mic size={19} />
          </IconButton>
          <button
            aria-label={busy ? "停止" : "发送"}
            onClick={() => (busy ? onStop?.() : submit())}
            disabled={(!value.trim() && !busy) || disabled}
            className={cn(
              "mb-0.5 flex size-9 shrink-0 items-center justify-center rounded-full transition-all",
              busy
                ? "bg-fg text-bg"
                : value.trim()
                  ? "bg-primary text-primary-fg hover:opacity-90"
                  : "bg-hover text-faint",
            )}
          >
            {busy ? <Square size={15} className="fill-current" /> : <ArrowUp size={19} />}
          </button>
        </div>
      </div>
      <p className="py-2 text-center text-xs text-faint">
        {model ? `${model} · ` : ""}内容由 AI 生成，请注意甄别
      </p>
    </div>
  );
}
