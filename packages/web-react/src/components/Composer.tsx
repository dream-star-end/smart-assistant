import { ArrowUp, FileText, Image as ImageIcon, Loader2, Mic, Plus, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MediaRef } from "../lib/chat/frames";
import { cn } from "../lib/utils";
import { IconButton } from "./ui";

type Attach = {
  id: string;
  name: string;
  size: number;
  kind: MediaRef["kind"];
  status: "uploading" | "done" | "error";
  media?: MediaRef;
  error?: string;
};

const MAX_ATTACH = 8;

function mediaKindOf(mime: string): MediaRef["kind"] {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

export function Composer({
  onSend,
  busy,
  onStop,
  model,
  disabled,
  placeholder = "给 OpenClaude 发消息…",
  onUpload,
}: {
  /** 发送：text + 可选已上传媒体（图片/文件等）。 */
  onSend: (text: string, media?: MediaRef[]) => void;
  busy?: boolean;
  onStop?: () => void;
  model?: string;
  disabled?: boolean;
  placeholder?: string;
  /** 上传单文件 → MediaRef（demo / 未登录省略 → 附件按钮禁用）。 */
  onUpload?: (file: File) => Promise<MediaRef>;
}) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<Attach[]>([]);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const idRef = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(el.scrollHeight, 240) + "px";
  }, [value]);

  const uploading = attachments.some((a) => a.status === "uploading");
  const doneMedia = attachments
    .filter((a) => a.status === "done" && a.media)
    .map((a) => a.media as MediaRef);
  const canSend = (value.trim().length > 0 || doneMedia.length > 0) && !uploading;

  const submit = () => {
    if (busy || disabled || !canSend) return;
    onSend(value.trim(), doneMedia.length ? doneMedia : undefined);
    setValue("");
    setAttachments([]);
  };

  const onFiles = async (files: FileList | null) => {
    if (!files || !onUpload) return;
    const arr = Array.from(files).slice(0, MAX_ATTACH);
    if (fileRef.current) fileRef.current.value = ""; // 允许同名文件再次选择
    for (const file of arr) {
      const id = `att-${idRef.current++}`;
      setAttachments((prev) =>
        prev.length >= MAX_ATTACH
          ? prev
          : [...prev, { id, name: file.name, size: file.size, kind: mediaKindOf(file.type), status: "uploading" }],
      );
      try {
        const media = await onUpload(file);
        setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, status: "done", media } : a)));
      } catch (e) {
        setAttachments((prev) =>
          prev.map((a) => (a.id === id ? { ...a, status: "error", error: (e as Error).message } : a)),
        );
      }
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4">
      <div
        className={cn(
          "rounded-[26px] border border-border bg-surface shadow-[var(--shadow-float)] transition-all",
          "focus-within:border-border-strong",
        )}
      >
        {/* 附件 chips */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3.5 pt-3">
            {attachments.map((a) => (
              <AttachChip key={a.id} a={a} onRemove={() => setAttachments((p) => p.filter((x) => x.id !== a.id))} />
            ))}
          </div>
        )}
        <div className="flex items-end gap-1.5 px-2.5 py-2">
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => onFiles(e.target.files)}
          />
          <IconButton
            aria-label="添加附件"
            title={onUpload ? "添加附件" : "附件暂不可用"}
            disabled={!onUpload || disabled}
            onClick={() => fileRef.current?.click()}
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
            disabled={(!canSend && !busy) || disabled}
            className={cn(
              "mb-0.5 flex size-9 shrink-0 items-center justify-center rounded-full transition-all",
              busy
                ? "bg-fg text-bg"
                : canSend
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

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function AttachChip({ a, onRemove }: { a: Attach; onRemove: () => void }) {
  const Icon = a.kind === "image" ? ImageIcon : FileText;
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border bg-bg px-2.5 py-1.5 text-[12.5px]",
        a.status === "error" ? "border-danger/40" : "border-border",
      )}
      title={a.status === "error" ? a.error || "上传失败" : `${a.name} · ${fmtSize(a.size)}`}
    >
      {a.status === "uploading" ? (
        <Loader2 size={14} className="shrink-0 animate-spin text-accent" />
      ) : (
        <Icon size={14} className={cn("shrink-0", a.status === "error" ? "text-danger" : "text-muted")} />
      )}
      <span className={cn("max-w-[140px] truncate", a.status === "error" ? "text-danger" : "text-fg")}>
        {a.name}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`移除 ${a.name}`}
        className="flex size-4 shrink-0 items-center justify-center rounded text-faint hover:text-danger"
      >
        <X size={13} />
      </button>
    </div>
  );
}
